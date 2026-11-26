// SPDX-License-Identifier: MIT
#include "agent_session.h"
#include "agent_wire.h"
#include <algorithm>
#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
#include <vector>
using namespace sion::agent;
static int last_volume=-1;
static const std::string device="123456abcdef",boot(32,'b'),request(32,'c');
static std::string pair(32,'a');
struct Port:AudioPort {
    int fence_ticks=0;bool fence_fail=false;
    Result PlaybackFence(bool begin,bool)override{
        if(begin)fence_ticks=3;
        if(fence_fail)return Result::Failed;
        return --fence_ticks>0?Result::Pending:Result::Done;
    }
    bool open=true,write=true,close=true;int opens=0,closes=0,writes=0;
    bool scripted_audio=false;
    InputPcm input{};
    OutputPcm reference{};
    std::array<OutputPcm,4> echo{};
    size_t echo_cursor=0;
    bool Open(int)override{
        ++opens;
        reference={};echo={};echo_cursor=0;
        return open;
    }
    bool Volume(int)override{return true;}
    bool Read(InputPcm& pcm)override{
        if(scripted_audio){
            // Simulate 40 ms of echo from frames the audio engine actually wrote.
            auto& delayed=echo[echo_cursor];
            for(size_t i=0;i<reference.size();++i){
                const int mixed=3*input[i*2]/4+delayed[i]/2;
                pcm[i*2]=static_cast<int16_t>(std::clamp(mixed,-32768,32767));
                pcm[i*2+1]=reference[i];
            }
            delayed=reference;
            reference={};
            echo_cursor=(echo_cursor+1)%echo.size();
        }else for(size_t i=0;i<pcm.size();i+=2){pcm[i]=-32768;pcm[i+1]=32767;}
        return true;
    }
    bool Write(const OutputPcm& pcm)override{
        if(scripted_audio) reference=pcm;
        else assert(pcm[0]==-32768&&pcm[1]==32767);
        ++writes;return write;
    }
    bool Close()override{++closes;return close;}
};
struct Store:PairingRepository {
    PairingStatus Read()override{return {PairingState::Paired,pair};}
    PairingWrite Replace(const std::string&,const std::string&)override{assert(false);return PairingWrite::Invalid;}
    PairingWrite Remove(const std::string&)override{assert(false);return PairingWrite::Invalid;}
};
static std::string HexBytes(const uint8_t* p,size_t size){const char* h="0123456789abcdef";std::string s;for(size_t i=0;i<size;++i){s+=h[p[i]>>4];s+=h[p[i]&15];}return s;}
struct Sink:AgentWireSink {
    std::vector<std::string> text,states,motion_states,ring_states,battery_states,health_states;std::vector<std::vector<uint8_t>> binary;
    int closes=0;bool accept=true,stream=false,camera_accept=true;
    bool CameraText(const std::string& value)override{return camera_accept&&Text(value);}
    bool Text(const std::string& value)override{if(stream)std::cout<<"T "<<value<<std::endl;else if(value.find("\"camera_state\"")!=std::string::npos)states.push_back(value);else if(value.find("\"motion_state\"")!=std::string::npos)motion_states.push_back(value);else if(value.find("\"ring_state\"")!=std::string::npos)ring_states.push_back(value);else if(value.find("\"battery_state\"")!=std::string::npos)battery_states.push_back(value);else if(value.find("\"health_state\"")!=std::string::npos)health_states.push_back(value);else text.push_back(value);return accept;}
    bool Binary(const uint8_t* p,size_t n)override{if(stream)std::cout<<"B "<<HexBytes(p,n)<<std::endl;else binary.emplace_back(p,p+n);return accept;}
    void Close()override{++closes;if(stream)std::cout<<"C"<<std::endl;}
};
struct EffectsImpl:Effects {
    AudioEngine& audio;CameraEngine* camera=nullptr;MotionEngine* motion=nullptr;RingEngine* ring=nullptr;AmbientEngine* ambient=nullptr;HeadTouchEngine* head_touch=nullptr;ImuEngine* imu=nullptr;int homes=0;
    explicit EffectsImpl(AudioEngine& a):audio(a){}
    void StopResources(uint64_t epoch)override{audio.Stop(epoch);if(camera)camera->Stop(epoch);if(motion)motion->Stop(epoch);if(ring)ring->Stop(epoch);if(ambient)ambient->Stop(epoch);if(head_touch)head_touch->Stop(epoch);if(imu)imu->Stop(epoch);}
    Result ResourcesStopped(uint64_t epoch)override{
        if(ambient&&ambient->Stopped(epoch)!=Result::Done)return ambient->Stopped(epoch);
        if(head_touch&&head_touch->Stopped(epoch)!=Result::Done)return head_touch->Stopped(epoch);
        if(imu&&imu->Stopped(epoch)!=Result::Done)return imu->Stopped(epoch);
        if(ring&&ring->Stopped(epoch)!=Result::Done)return ring->Stopped(epoch);
        if(motion&&motion->Stopped(epoch)!=Result::Done)return motion->Stopped(epoch);
        return camera&&camera->Stopped(epoch)!=Result::Done?camera->Stopped(epoch):audio.Stopped(epoch);
    }
    Result ReturnHome(uint64_t)override{++homes;return Result::Done;}
};
struct PhotoPort:CameraPort {
    size_t size=2501;bool close_ok=true;int opens=0,closes=0;bool pending=false;
    std::vector<uint8_t> jpeg;
    bool Open()override{++opens;return true;}
    Result Read(uint8_t* p,size_t capacity,CameraImageInfo& info)override{
        if(pending)return Result::Pending;
        if(!jpeg.empty()){
            assert(jpeg.size()<=capacity);
            std::copy(jpeg.begin(),jpeg.end(),p);
            info={jpeg.size(),640,480};
            return Result::Done;
        }
        assert(size<=capacity);for(size_t i=0;i<size;++i)p[i]=uint8_t(i);
        p[0]=255;p[1]=216;p[size-2]=255;p[size-1]=217;info={size,640,480};return Result::Done;
    }
    bool Close()override{++closes;return close_ok;}
};
struct Fixture {
    struct Expression:ExpressionPort {
        std::string value="neutral";bool visible=true;int applied=0,resets=0;
        bool SetExpression(std::string_view next)override{if(!visible)return false;value=next;++applied;return true;}
        void ResetExpression()override{value="neutral";++resets;}
    } expression;
    struct Motors:MotionPort {
        MotionTarget target;
        int opens=0,moves=0,releases=0;
        bool release_ok=true;
        bool Open()override{++opens;return true;}
        bool Move(const MotionTarget& value)override{++moves;target=value;return true;}
        Result Poll(MotionFeedback& out)override{out={target.yaw,target.pitch,false,false};return Result::Done;}
        Result Release()override{++releases;return release_ok?Result::Done:Result::Failed;}
        bool torque=false;int turning=0;
        bool Torque(bool on)override{torque=on;return true;}
        bool Rotate(int v)override{turning=v;return true;}
        bool Sense(MotionSense& out)override{
            out.yaw.angle=target.yaw;out.pitch.angle=target.pitch;out.yaw.position=460;out.pitch.position=700;
            out.pitch.temperature=33;out.yaw.load=-120;out.yaw.torque=out.pitch.torque=torque;return true;}
    } motors;
    MotionEngine motion{motors};
    struct Lights:RingPort {
        int opens=0,shows=0,closes=0;
        bool close_ok=true;
        bool Open()override{++opens;return true;}
        RingFrame frame{};
        bool Show(const RingFrame& next)override{++shows;frame=next;return true;}
        bool Close()override{++closes;return close_ok;}
    } lights;
    RingEngine ring{lights};
    struct Ambient : AmbientPort {
        bool open=false;
        bool Open()override{assert(!open);open=true;return true;}
        AmbientSample Read()override{assert(open);return {0,1234,2047};}
        bool Close()override{open=false;return true;}
    } ambient_port;
    AmbientEngine ambient{ambient_port};
    struct HeadTouch : HeadTouchPort {
        bool open=false;
        static constexpr std::array<HeadTouchSample,20> gesture_trace{{
            {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}, {0,2,0}, {0,2,0}, {0,0,0}, {0,0,0},
            {0,2,0}, {0,2,0}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0},
            {2,0,0}, {2,0,0}, {0,0,3}, {0,0,3}, {0,0,0}, {0,0,0},
        }};
        size_t trace_next=gesture_trace.size();
        bool Open()override{assert(!open);open=true;return true;}
        HeadTouchSample Read()override{
            assert(open);
            if(trace_next<gesture_trace.size())return gesture_trace[trace_next++];
            return {0,1,3};
        }
        bool Close()override{open=false;return true;}
    } head_touch_port;
    HeadTouchEngine head_touch{head_touch_port};
    struct Imu : ImuPort {
        bool open=false;
        bool Open()override{assert(!open);open=true;return true;}
        ImuSample Read()override{assert(open);return {{16384,-16384,-1,8192,-8192,32767},true};}
        bool Close()override{open=false;return true;}
    } imu_port;
    ImuEngine imu{imu_port};
    PhotoPort photo_port;CameraEngine camera{photo_port};
    Port port;AudioEngine audio{port};Store store;PairingMaintenance maintenance{store};
    struct Power final:PowerReader{PowerSample Latest(uint64_t)const override{return {true,3200,-16};}} power;
    struct Ir final:IrPort{
        uint32_t queued=0;int result=-1;std::vector<IrCode> heard;
        bool Queue(uint16_t a,uint8_t c,uint8_t r)override{if(queued)return false;queued=(uint32_t(r)<<24)|(uint32_t(c)<<16)|a;result=0;return true;}
        int TakeSendResult()override{const int r=result;result=-1;if(r>=0)queued=0;return r;}
        bool Take(IrCode& code)override{if(heard.empty())return false;code=heard.front();heard.erase(heard.begin());return true;}
    } ir;
    struct Nfc final:NfcPort{
        bool ready=true,on=false,pending=false,present=false;int enables=0;std::vector<NfcEvent> events;
        NfcCard card;NfcRead read;
        bool Ready()const override{return ready;}
        NfcPollStats Stats()override{NfcPollStats s;s.polls=9;s.silent=3;s.partial=1;s.selected=5;s.error_irq=0x1000;return s;}
        void Enable(bool value)override{on=value;++enables;events.clear();pending=false;}
        bool Take(NfcEvent& event)override{if(events.empty())return false;event=events.front();events.erase(events.begin());return true;}
        bool RequestRead(uint8_t page,uint8_t count)override{if(!on||pending)return false;read={};read.page=page;read.count=count;pending=true;return true;}
        bool TakeRead(NfcRead& out,NfcCard& from)override{
            if(!pending)return false;
            pending=false;from=present?card:NfcCard{};
            read.code=!present?NfcRead::Code::NoCard:card.sak?NfcRead::Code::Unsupported:NfcRead::Code::Read;
            if(read.code==NfcRead::Code::Read)for(unsigned i=0;i<read.count*4u;++i)read.data[i]=uint8_t((read.page*4+i)*7);
            out=read;return true;
        }
        void Note(bool now_present,const std::string& hex,uint16_t atqa,uint8_t sak,uint64_t at,const std::string& version=""){
            NfcEvent e;e.present=now_present;e.card.atqa=atqa;e.card.sak=sak;e.at=at;e.card.uid_size=uint8_t(hex.size()/2);
            for(size_t i=0;i<e.card.uid_size;++i)e.card.uid[i]=uint8_t(std::stoul(hex.substr(i*2,2),nullptr,16));
            e.card.has_version=version.size()==16;
            for(size_t i=0;e.card.has_version&&i<8;++i)e.card.version[i]=uint8_t(std::stoul(version.substr(i*2,2),nullptr,16));
            present=now_present;card=e.card;
            if(on)events.push_back(e);
        }
    } nfc;
    struct Display final:DisplayPort{
        std::string text;std::vector<uint8_t> image;uint16_t w=0,h=0;bool shown=false;
        bool ShowText(const std::string& t,DisplayArea,uint32_t,uint64_t)override{text=t;return true;}
        bool BeginImage(uint16_t a,uint16_t b,uint16_t,uint16_t,uint32_t)override{w=a;h=b;image.assign(size_t(a)*b*2,0);shown=false;return true;}
        bool ImageData(uint32_t o,const uint8_t* d,size_t n)override{if(o+n>image.size())return false;std::copy(d,d+n,image.begin()+o);return true;}
        bool ShowImage(uint64_t)override{return shown=true;}
        void ClearDisplay()override{text.clear();shown=false;frame=nullptr;}
        const uint8_t* frame=nullptr;int frames_shown=0;
        bool ShowFrame(const uint8_t* p,uint16_t a,uint16_t b,uint16_t,uint16_t,uint32_t,uint64_t)override{
            frame=p;w=a;h=b;image.assign(p,p+size_t(a)*b*2);++frames_shown;return shown=true;}
    } display;
    EffectsImpl effects{audio};SessionLifecycle life{effects};Sink sink;ScreenTouchLog touch;AgentSession session;
    Fixture(bool expressive=false,bool photos=false,bool movement=false,bool lighting=false,BatteryReader battery=nullptr,bool environment=false)
        :session(life,audio,maintenance,sink,expressive?&expression:nullptr,photos?&camera:nullptr,
                 movement?&motion:nullptr,lighting?&ring:nullptr,battery,environment?&ambient:nullptr,environment?&head_touch:nullptr,environment?&imu:nullptr){
        effects.ring=lighting?&ring:nullptr;effects.motion=movement?&motion:nullptr;effects.camera=photos?&camera:nullptr;
        effects.ambient=environment?&ambient:nullptr;effects.head_touch=environment?&head_touch:nullptr;
        effects.imu=environment?&imu:nullptr;
        if(environment){session.SetScreenTouch(&touch);session.SetPower(&power);session.SetInfrared(&ir);session.SetNfc(&nfc);session.SetDisplay(&display);session.SetVolumeSetter([](int v){last_volume=v;return true;});}
        maintenance.Initialize(device);maintenance.DriverReady(true);
    }
    bool Attach(){return session.AttachAuthenticated(device,pair,boot,0);}
    void Pump(uint64_t now){audio.Pump(now*1000);camera.Pump(now);motion.Pump(now);ring.Pump(now);ambient.Pump(now);head_touch.Pump(now);imu.Pump(now);session.Tick(now);}
};
static std::string Command(const std::string& type,uint64_t epoch,const std::string& id=request){
    return "{\"type\":\""+type+"\",\"boot_id\":\""+boot+"\",\"epoch\":\""+std::to_string(epoch)+"\""+
        (type=="renew"?"":",\"request_id\":\""+id+"\"")+"}";
}
static std::string Move(const std::string& id=request,const std::string& pitch="450"){
    auto text=Command("move_head",1,id);text.pop_back();
    return text+",\"yaw\":\"-200\",\"pitch\":\""+pitch+"\",\"duration_ms\":\"1000\"}";
}
static std::string Light(const std::string& id=request,const std::string& duration="250"){
    auto text=Command("set_ring",1,id);text.pop_back();
    return text+",\"rgb\":\"ff2300\",\"duration_ms\":\""+duration+"\"}";
}
static std::string Fence(const std::string& type,uint64_t next){
    auto text=Command(type,1);text.pop_back();return text+",\"next_sequence\":\""+std::to_string(next)+"\"}";
}
static std::array<uint8_t,wire::kOutputBytes> Output(uint64_t epoch,uint64_t sequence){
    std::array<uint8_t,wire::kOutputBytes> bytes{};std::memcpy(bytes.data(),"SIA1",4);bytes[4]=2;
    wire::Put64(bytes.data()+8,epoch);wire::Put64(bytes.data()+16,sequence);
    bytes[32]=0;bytes[33]=128;bytes[34]=255;bytes[35]=127;return bytes;
}
static void Start(Fixture& f){assert(f.Attach());f.session.Text(Command("start",0),1);assert(f.life.phase()==Phase::Connecting);
    assert(f.sink.text.size()==1&&f.port.opens==0);f.Pump(2);assert(f.life.phase()==Phase::Active&&f.port.opens==1);
    assert(f.sink.text.back().find("started")!=std::string::npos);}
int main(int argc,char** argv){
    const bool scripted_audio=(argc==3||argc==4)&&std::string_view(argv[1])=="--stdio-audio";
    if(scripted_audio||(argc>=2&&std::string_view(argv[1])=="--stdio")){
        if(scripted_audio){
            pair=argv[2];
            assert(pair.size()==32&&pair.find_first_not_of("0123456789abcdef")==std::string::npos);
        }
        const BatteryReader read_battery=[](int& percent,bool& charging,bool& discharging){
            percent=61;charging=false;discharging=true;return true;
        };
        const bool with_sensors=scripted_audio||(argc==3&&std::string_view(argv[2])=="--sensors");
        Fixture f(true,true,true,true,with_sensors?read_battery:nullptr,with_sensors);f.ring.Allow(true);f.motion.AllowMotion(true);f.camera.AllowCapture(true);f.sink.stream=true;assert(f.Attach());std::string line;uint64_t now=0;
        f.port.scripted_audio=scripted_audio;
        if(scripted_audio&&argc==4){
            std::ifstream file(argv[3],std::ios::binary|std::ios::ate);
            const auto length=file.tellg();
            assert(length>=4&&length<=static_cast<std::streamoff>(kCameraMaxBytes));
            f.photo_port.jpeg.resize(static_cast<size_t>(length));
            file.seekg(0);
            assert(file.read(reinterpret_cast<char*>(f.photo_port.jpeg.data()),length));
        }
        bool home_pending=false;
        while(std::getline(std::cin,line)){
            if(line.rfind("T ",0)==0)f.session.Text(line.substr(2),now);
            else if(line.rfind("B ",0)==0){std::vector<uint8_t> bytes;for(size_t i=2;i+1<line.size();i+=2)
                bytes.push_back(static_cast<uint8_t>(std::stoul(line.substr(i,2),nullptr,16)));
                f.session.Binary(bytes.data(),bytes.size(),now);}
            else if(line.rfind("P ",0)==0){
                std::istringstream command(line.substr(2));
                assert(command>>now);
                if(scripted_audio){
                    std::string hex;
                    assert(command>>hex);
                    assert(hex.size()==4*f.port.input.size());
                    for(size_t i=0;i<f.port.input.size();++i){
                        const auto lo=std::stoul(hex.substr(i*4,2),nullptr,16);
                        const auto hi=std::stoul(hex.substr(i*4+2,2),nullptr,16);
                        f.port.input[i]=static_cast<int16_t>(lo|(hi<<8));
                    }
                }
                f.Pump(now);
            }
            else if(line.rfind("E ",0)==0){now=std::stoull(line.substr(2));f.session.Tick(now);}
            else if(line=="A")f.session.AttachAuthenticated(device,pair,boot,now);
            else if(line=="Q"){
                const auto audio=f.audio.status();
                const auto phase=f.life.phase();
                const char* label=phase==Phase::Idle?"idle":phase==Phase::Active?"active":phase==Phase::Draining?"draining":"other";
                std::cout<<"Q "<<label<<' '<<f.life.epoch()<<' '<<f.session.attached()<<' '
                         <<audio.input_depth<<' '<<audio.output_depth<<' '<<f.port.opens<<' '
                         <<f.port.closes<<' '<<f.port.writes<<' '<<f.photo_port.opens<<' '<<f.photo_port.closes<<std::endl;
            }
            else if(line.rfind("L ",0)==0)f.photo_port.size=std::stoul(line.substr(2));
            else if(line=="G")f.head_touch_port.trace_next=0;
            else if(line=="V"){   // Report what the fake screen holds.
                unsigned sum=0;for(auto b:f.display.image)sum+=b;
                std::cout<<"V "<<(f.display.text.empty()?"-":f.display.text)<<' '<<f.display.w<<'x'<<f.display.h<<' '<<f.display.shown<<' '<<sum<<std::endl;
            }
            else if(line.rfind("I ",0)==0){   // Infrared heard: I address command
                std::istringstream heard(line.substr(2));unsigned a=0,c=0;assert(heard>>a>>c);
                f.ir.heard.push_back({uint16_t(a),uint8_t(c),false,now});
            }
            else if(line.rfind("N ",0)==0){   // NFC card: N present uidhex atqa sak [versionhex]
                std::istringstream heard(line.substr(2));int present=0;std::string uid,version;unsigned atqa=0,sak=0;
                assert(heard>>present>>uid>>atqa>>sak);heard>>version;
                f.nfc.Note(present!=0,uid,uint16_t(atqa),uint8_t(sak),now,version);
            }
            else if(line.rfind("S ",0)==0){   // Screen touch: S pressed x y
                std::istringstream touch(line.substr(2));int pressed=0,x=0,y=0;
                assert(touch>>pressed>>x>>y);f.touch.Note(pressed!=0,x,y,now);
            }
            else if(line=="D")f.camera.AllowCapture(false);
            else if(line=="W")f.photo_port.pending=true;
            else if(line=="H"){
                assert(f.session.attached()&&f.life.phase()==Phase::Active);
                f.session.LocalStop(true,now);home_pending=true;
                assert(!f.session.attached()&&f.effects.homes==0);
            }
            else if(line=="C")f.session.Disconnected(now);
            else assert(false);
            if(home_pending&&f.life.phase()==Phase::Home){
                assert(f.effects.homes==1&&f.port.opens==f.port.closes);
                assert(f.photo_port.opens==f.photo_port.closes);
                assert(!f.ambient_port.open);
                assert(f.effects.ResourcesStopped(f.life.epoch())==Result::Done);
                home_pending=false;std::cout<<"H"<<std::endl; // Test-only completion event.
            }
        }
        f.session.Disconnected(now);f.Pump(now+1);return 0;
    }

    {
        // v66: a tap or Stop that met a full link was lost. It is held and retried.
        Fixture f;
        assert(f.session.AttachAuthenticated(device,pair,boot,0,false,true));
        assert(f.sink.text.front().find("\"standby\":2")!=std::string::npos);
        f.session.Text(Command("start",0),1);f.Pump(2);
        assert(f.life.phase()==Phase::Active);
        const auto attention=[&f]{size_t n=0;for(const auto& t:f.sink.text)n+=t.find("\"attention\"")!=std::string::npos;return n;};
        f.sink.camera_accept=false;
        assert(f.session.Attention(10));                     // Tap: held.
        assert(f.session.Attention(20,true));                // Stop replaces it.
        f.Pump(30);assert(attention()==0);
        f.sink.camera_accept=true;f.Pump(40);
        assert(attention()==1&&f.sink.text.back().find("\"intent\":\"sleep\"")!=std::string::npos);
        f.Pump(50);assert(attention()==1);                   // Sent once.
        f.sink.camera_accept=false;
        assert(f.session.Attention(400));
        f.Pump(1950);f.sink.camera_accept=true;f.Pump(1960);
        assert(attention()==1);                              // Too late: dropped, not replayed.
        assert(f.session.Attention(2000)&&attention()==2&&f.sink.text.back().find("intent")==std::string::npos);
        assert(f.life.phase()==Phase::Active&&f.sink.closes==0);
    }
    {
        Fixture f(false,false,false,false,nullptr,true);
        f.sink.camera_accept=false;
        f.head_touch_port.trace_next=0;
        f.Pump(0);
        assert(f.life.phase()==Phase::Idle&&f.port.opens==0&&f.head_touch_port.trace_next==0);
        Start(f);
        assert(f.sink.text.front().find("\"head_touch\":2")!=std::string::npos);
        f.Pump(3);
        for(uint64_t now=203;now<553;now+=50)f.Pump(now);
        // The first tap completes at 553 ms. Its blocked telemetry must leave playback active.
        const auto playing = Output(1, 0);
        f.session.Binary(playing.data(), playing.size(), 552);
        f.Pump(553);
        assert(f.port.writes==1&&f.life.phase()==Phase::Active);
        for(uint64_t now=603;now<=1153;now+=50)f.Pump(now);
        const auto before=f.sink.text.size();
        f.sink.camera_accept=true;
        f.Pump(1154);
        assert(f.sink.text.back().find("\"kind\":\"tap\"")!=std::string::npos);
        f.Pump(1155);
        assert(f.sink.text.back().find("\"kind\":\"toward_channel_3\"")!=std::string::npos);
        assert(f.sink.text.size()==before+2);
        f.Pump(1156);
        assert(f.sink.text.size()==before+2);
        assert(f.life.phase()==Phase::Active&&f.port.opens==1&&f.port.closes==0&&f.effects.homes==0);

        // Local Stop still wins while the head sensor is reporting contact and PCM is queued.
        f.Pump(1203);
        const auto head = f.head_touch.Snapshot(1, 1203);
        assert(head.channel2==1&&head.channel3==3);
        const auto queued = Output(1, 1);
        f.session.Binary(queued.data(), queued.size(), 1204);
        assert(f.audio.status().output_depth==1);
        f.session.LocalStop(false, 1204);
        assert(f.life.phase()==Phase::Draining&&!f.session.attached());
        f.Pump(1205);
        assert(f.life.phase()==Phase::Idle&&f.effects.homes==0);
        assert(f.port.writes==1&&f.port.closes==1&&!f.head_touch_port.open);
    }
    {
        Fixture f(false,false,false,true); Start(f);
        assert(f.sink.text.front().find("\"voice_indicator\":1")!=std::string::npos);
        f.ring.Allow(true);
        const auto indicate=[&](const char* state,uint64_t now) {
            f.session.Text("{\"type\":\"voice_indicator\",\"boot_id\":\""+boot+
                "\",\"epoch\":\"1\",\"state\":\""+state+"\"}",now);
        };
        indicate("listening",3);
        f.Pump(4); f.Pump(5);
        assert(f.lights.shows==1&&f.lights.frame[0].green>0&&f.lights.frame[0].red==0&&f.lights.frame[6]==RingColor{});
        indicate("waiting",6);
        for(uint64_t t=7;t<=127;t+=20)f.Pump(t);
        assert(f.lights.shows>=2&&f.lights.frame[0].red>0);
        f.audio.SetVolume(45);
        const auto pcm=Output(1,0);
        f.session.Binary(pcm.data(),pcm.size(),160);
        for(uint64_t t=200;t<=320;t+=20)f.Pump(t);  // Within the 140 ms speaking window.
        assert(f.lights.frame[0].blue>0&&f.lights.frame[0].red==0&&f.lights.frame[11].blue>0);
        f.session.Text(Command("stop",1),206); f.Pump(207);
        assert(f.lights.closes==1&&f.life.phase()==Phase::Idle);
    }
    {
        static int percent=61;
        const auto read=[](int& result,bool& charging,bool& discharging) {
            result=percent;charging=true;discharging=false;
            return percent>=0;
        };
        Fixture f(false,false,false,false,read);Start(f);
        assert(f.sink.text.front().find("\"battery\":1")!=std::string::npos);
        assert(f.sink.battery_states.size()==1&&f.sink.battery_states.back().find("\"percent\":61")!=std::string::npos);
        percent=-1;
        f.Pump(1000);
        assert(f.sink.battery_states.size()==1);
        f.Pump(2002);
        assert(f.sink.battery_states.size()==2&&f.sink.battery_states.back().find("\"percent\":null")!=std::string::npos);
        f.sink.camera_accept=false;
        f.Pump(4002);
        assert(f.session.attached()&&f.sink.battery_states.size()==2);
        f.session.Text(Command("stop",1),4100);
        f.sink.camera_accept=true;
        f.Pump(4101);
        f.Pump(6200);
        assert(f.life.phase()==Phase::Idle&&f.sink.battery_states.size()==2);
    }
    {   // Frame bank: store by slot, show by number, list, drop; the screen never keeps a dropped frame.
        Fixture f(false,false,false,false,nullptr,true);
        assert(f.Attach()&&f.sink.text.front().find("\"frames\":2")!=std::string::npos);
        f.session.Text(Command("start",0),1);f.Pump(2);
        const auto with=[](std::string text,const std::string& extra){text.pop_back();return text+extra+"}";};
        const auto id=[](char c){return std::string(32,c);};
        const auto last=[&]{return f.sink.text.back();};
        const std::string tag="0123456789abcdef";
        // 2x2 frame into slot 3, two chunks.
        f.session.Text(with(Command("frame_begin",1,id('1')),",\"slot\":\"3\",\"width\":\"2\",\"height\":\"2\",\"x\":\"10\",\"y\":\"20\",\"tag\":\""+tag+"\""),3);
        assert(last().find("\"code\":\"ready\"")!=std::string::npos&&!f.display.shown);
        f.session.Text(with(Command("image_chunk",1,id('1')),",\"offset\":\"0\",\"data_hex\":\"01020304\""),4);
        assert(last().find("\"image_ack\"")!=std::string::npos);
        // Showing the slot while it is still arriving is refused.
        f.session.Text(with(Command("frame_show",1,id('2')),",\"slot\":\"3\",\"duration_ms\":\"1000\""),5);
        assert(last().find("\"code\":\"no-frame\"")!=std::string::npos);
        f.session.Text(with(Command("image_chunk",1,id('1')),",\"offset\":\"4\",\"data_hex\":\"05060708\""),6);
        f.session.Text(Command("image_end",1,id('1')),7);
        assert(last().find("\"code\":\"stored\"")!=std::string::npos&&!f.display.shown);
        f.session.Text(with(Command("frame_show",1,id('3')),",\"slot\":\"3\",\"duration_ms\":\"1000\""),8);
        assert(last().find("\"code\":\"shown\"")!=std::string::npos&&f.display.shown&&f.display.frame&&
               f.display.image==std::vector<uint8_t>({1,2,3,4,5,6,7,8}));
        f.session.Text(with(Command("frame_show",1,id('4')),",\"slot\":\"4\",\"duration_ms\":\"1000\""),9);
        assert(last().find("\"code\":\"no-frame\"")!=std::string::npos&&f.display.shown);
        f.session.Text(Command("frame_list",1,id('5')),10);
        assert(last()==std::string("{\"type\":\"frame_list\",\"request_id\":\"")+id('5')+"\",\"boot_id\":\""+boot+
            "\",\"epoch\":\"1\",\"used\":8,\"budget\":4194304,\"frames\":[{\"slot\":3,\"width\":2,\"height\":2,\"x\":10,\"y\":20,\"tag\":\""+tag+"\"}]}");
        // Rewriting the shown slot takes it off the screen first.
        f.session.Text(with(Command("frame_begin",1,id('6')),",\"slot\":\"3\",\"width\":\"1\",\"height\":\"1\",\"x\":\"0\",\"y\":\"0\",\"tag\":\""+tag+"\""),11);
        assert(last().find("\"code\":\"ready\"")!=std::string::npos&&!f.display.shown&&!f.display.frame);
        // An unfinished upload ends when another starts; its slot stays empty.
        f.session.Text(with(Command("frame_begin",1,id('7')),",\"slot\":\"5\",\"width\":\"1\",\"height\":\"1\",\"x\":\"0\",\"y\":\"0\",\"tag\":\""+tag+"\""),12);
        f.session.Text(with(Command("image_chunk",1,id('7')),",\"offset\":\"0\",\"data_hex\":\"aabb\""),13);
        f.session.Text(Command("image_end",1,id('7')),14);
        f.session.Text(with(Command("frame_show",1,id('8')),",\"slot\":\"5\",\"duration_ms\":\"1000\""),15);
        assert(last().find("\"code\":\"shown\"")!=std::string::npos);
        f.session.Text(with(Command("frame_drop",1,id('9')),",\"slot\":\"all\""),16);
        assert(last().find("\"code\":\"dropped\"")!=std::string::npos&&!f.display.shown);
        f.session.Text(Command("frame_list",1,id('a')),17);
        assert(last().find("\"used\":0,")!=std::string::npos&&last().find("\"frames\":[]")!=std::string::npos);
        // Wrong tag length or slot out of range is a protocol error, like any malformed command.
        f.session.Text(with(Command("frame_begin",1,id('b')),",\"slot\":\"48\",\"width\":\"1\",\"height\":\"1\",\"x\":\"0\",\"y\":\"0\",\"tag\":\""+tag+"\""),18);
        assert(!f.session.attached());
    }
    {   // The bank keeps its budget and free-memory floor, and frames survive a disconnect.
        static size_t free_memory=10000;
        FrameBank bank(AllocateCameraBuffer,[]{return free_memory;},1000,2000);
        assert(bank.Begin(0,10,10,0,0,"0123456789abcdef")==FrameBegin::Ready);           // 200 bytes
        assert(bank.Begin(1,20,20,0,0,"0123456789abcdef")==FrameBegin::Ready&&bank.used()==1000);
        assert(bank.Begin(2,1,1,0,0,"0123456789abcdef")==FrameBegin::NoRoom);            // Budget
        bank.Drop(0);assert(bank.used()==800);
        free_memory=2100;assert(bank.Begin(2,10,10,0,0,"0123456789abcdef")==FrameBegin::NoRoom);   // Floor
        free_memory=10000;assert(bank.Begin(2,10,10,0,0,"0123456789abcdef")==FrameBegin::Ready);
        assert(!bank.Get(2)&&!bank.Finish(2,199)&&bank.used()==800);                     // Short upload empties it
        assert(bank.Begin(2,10,10,320,0,"0123456789abcdef")==FrameBegin::Invalid);
        assert(bank.Begin(2,10,10,0,0,"abc")==FrameBegin::Invalid);
        Fixture f(false,false,false,false,nullptr,true);assert(f.Attach());f.session.Text(Command("start",0),1);f.Pump(2);
        auto begin=Command("frame_begin",1);begin.pop_back();
        f.session.Text(begin+",\"slot\":\"0\",\"width\":\"1\",\"height\":\"1\",\"x\":\"0\",\"y\":\"0\",\"tag\":\"0123456789abcdef\"}",3);
        auto chunk=Command("image_chunk",1);chunk.pop_back();
        f.session.Text(chunk+",\"offset\":\"0\",\"data_hex\":\"1234\"}",4);
        f.session.Text(Command("image_end",1),5);
        auto show=Command("frame_show",1);show.pop_back();
        f.session.Text(show+",\"slot\":\"0\",\"duration_ms\":\"500\"}",6);
        assert(f.display.shown);
        f.session.Disconnected(7);assert(!f.display.shown);
        f.Pump(8);f.Pump(9);assert(f.life.phase()==Phase::Idle);
        assert(f.session.AttachAuthenticated(device,pair,boot,10));
        const auto epoch=f.life.epoch();
        f.session.Text(Command("start",epoch),11);f.Pump(12);assert(f.life.phase()==Phase::Active);
        auto again=Command("frame_show",f.life.epoch());again.pop_back();
        f.session.Text(again+",\"slot\":\"0\",\"duration_ms\":\"500\"}",13);
        assert(f.display.shown&&f.display.image==std::vector<uint8_t>({0x12,0x34}));
    }
    {   // NFC: offered only when the reader is ready; polled only while a conversation is active.
        Fixture f(false,false,false,false,nullptr,true);
        f.nfc.ready=false;assert(f.Attach());
        assert(f.sink.text.front().find("\"nfc\"")==std::string::npos);
        f.session.Text(Command("start",0),1);f.Pump(2);
        assert(f.life.phase()==Phase::Active&&!f.nfc.on&&f.nfc.enables==0);
        Fixture g(false,false,false,false,nullptr,true);
        assert(g.Attach()&&g.sink.text.front().find("\"nfc\":1")!=std::string::npos);
        assert(!g.nfc.on);                                   // Not while merely linked
        g.session.Text(Command("start",0),1);g.Pump(2);
        assert(g.nfc.on&&g.nfc.enables==1);
        g.nfc.Note(true,"04112233445566",0x44,0x00,2);g.nfc.Note(false,"04112233445566",0x44,0x00,2);
        g.sink.text.clear();g.Pump(30);
        size_t reports=0;
        for(const auto& t:g.sink.text)if(t.find("\"nfc_card\"")!=std::string::npos){
            ++reports;
            assert(t==std::string("{\"type\":\"nfc_card\",\"boot_id\":\"")+boot+"\",\"epoch\":\"1\",\"phase\":\""+(reports==1?"present":"removed")+
                "\",\"uid\":\"04112233445566\",\"atqa\":68,\"sak\":0,\"version\":\"\",\"age_ms\":28}");
        }
        assert(reports==2);
        // Page read: answered once the worker has done it; a second request while one waits is busy.
        auto read=Command("nfc_read",1,std::string(32,'7'));read.pop_back();
        g.nfc.Note(true,"04112233445566",0x44,0x00,30,"0004040201001103");
        g.sink.text.clear();
        g.session.Text(read+",\"page\":\"4\",\"count\":\"2\"}",31);
        g.session.Text(Command("nfc_read",1,std::string(32,'8')).substr(0,Command("nfc_read",1,std::string(32,'8')).size()-1)+",\"page\":\"4\",\"count\":\"1\"}",31);
        assert(g.sink.text.size()==1&&g.sink.text[0].find("\"code\":\"busy\"")!=std::string::npos);
        g.Pump(32);
        bool answered=false;
        for(const auto& t:g.sink.text)if(t.find("\"nfc_data\"")!=std::string::npos&&t.find(std::string(32,'7'))!=std::string::npos){
            answered=true;
            assert(t==std::string("{\"type\":\"nfc_data\",\"request_id\":\"")+std::string(32,'7')+"\",\"boot_id\":\""+boot+
                "\",\"epoch\":\"1\",\"code\":\"read\",\"uid\":\"04112233445566\",\"atqa\":68,\"sak\":0,\"version\":\"0004040201001103\",\"page\":4,\"count\":2,\"data_hex\":\"70777e858c939aa1\","
                "\"stats\":{\"polls\":9,\"field_failed\":0,\"silent\":3,\"partial\":1,\"anticollision_failed\":0,\"select_failed\":0,"
                "\"selected\":5,\"version_failed\":0,\"read_failed\":0,\"collisions\":0,\"error_irq\":4096}}");
        }
        assert(answered);
        // Out of range is a protocol error like any malformed command.
        Fixture h(false,false,false,false,nullptr,true);assert(h.Attach());h.session.Text(Command("start",0),1);h.Pump(2);
        auto bad=Command("nfc_read",1);bad.pop_back();
        h.session.Text(bad+",\"page\":\"250\",\"count\":\"8\"}",3);
        assert(!h.session.attached());
        g.session.Text(Command("stop",1),40);
        assert(!g.nfc.on);                                   // Stop ends polling at once
        g.Pump(41);g.Pump(100);
        g.session.Text(Command("start",2),101);g.Pump(102);
        assert(g.nfc.on);
        g.session.Disconnected(200);
        assert(!g.nfc.on);
    }
    {   // Body health: offered in the hello, one report per new sample while active.
        static diagnostics::HealthSample current{};
        current={};
        const HealthReader read=[](diagnostics::HealthSample& out){if(!current.sequence)return false;out=current;return true;};
        Fixture f;f.session.SetHealthReader(read);
        assert(f.Attach());
        assert(f.sink.text.front().find("\"health\":1")!=std::string::npos);
        current.sequence=1;current.ms=40500;current.chip_decicelsius=497;current.busy0=20;current.busy1=0;
        current.top_permille=9;current.top_name=diagnostics::PackName("esp_timer");current.touch_gap_ms=21;current.lvgl_gap_ms=40;
        current.ui_gap_ms=20;current.touch_errors=0;current.battery=100;current.flags=diagnostics::BatteryValid|diagnostics::Charging;current.brightness=70;current.mouth_ticks=12;
        f.Pump(1);
        assert(f.sink.health_states.empty());  // Not before a conversation is active.
        f.session.Text(Command("start",0),1);f.Pump(2);
        assert(f.life.phase()==Phase::Active&&f.sink.health_states.size()==1);
        // Byte-for-byte the message test/agent-health-protocol.test.mjs feeds the Mac decoder.
        assert(f.sink.health_states.back()==std::string("{\"type\":\"health_state\",\"boot_id\":\""+boot+"\",\"epoch\":\"1\",\"sequence\":1,\"uptime_ms\":40500,\"chip_decicelsius\":497,\"busy_permille\":[20,0],\"top_task\":\"esp_\",\"top_permille\":9,\"gap_ms\":[21,40,20],\"touch_errors\":0,\"battery\":100,\"charging\":true,\"discharging\":false,\"brightness\":70,\"mouth_ticks\":12}"));
        f.Pump(3);f.Pump(500);
        assert(f.sink.health_states.size()==1);  // The same sample is not repeated.
        current.sequence=2;current.chip_decicelsius=diagnostics::HealthNoTemperature;current.busy1=diagnostics::HealthUnknown;
        current.top_name=diagnostics::PackName("a\"b");current.flags=0;current.battery=0xff;current.brightness=0xff;current.mouth_ticks=0;
        f.sink.camera_accept=false;f.Pump(600);
        assert(f.sink.health_states.size()==1);  // A full low-priority queue retries later.
        f.sink.camera_accept=true;f.Pump(700);
        assert(f.sink.health_states.size()==2);
        assert(f.sink.health_states.back()==std::string("{\"type\":\"health_state\",\"boot_id\":\""+boot+"\",\"epoch\":\"1\",\"sequence\":2,\"uptime_ms\":40500,\"chip_decicelsius\":null,\"busy_permille\":[20,null],\"top_task\":\"a?b\",\"top_permille\":9,\"gap_ms\":[21,40,20],\"touch_errors\":0,\"battery\":null,\"charging\":false,\"discharging\":false,\"brightness\":null,\"mouth_ticks\":0}"));
        f.session.Text(Command("stop",1),800);f.Pump(801);f.Pump(900);
        f.session.Text(Command("start",2),901);f.Pump(902);
        assert(f.sink.health_states.size()==3);  // A new conversation gets the latest sample at once.
        Fixture plain;assert(plain.Attach());
        assert(plain.sink.text.front().find("\"health\"")==std::string::npos);
    }

    {
        Fixture f(false,false,false,true);Start(f);
        assert(f.sink.text.front().find("\"ring\":1")!=std::string::npos);
        assert(f.sink.ring_states.back().find("disabled")!=std::string::npos);
        f.session.Text(Light(),3);assert(f.lights.opens==0&&f.sink.text.back().find("disabled")!=std::string::npos);
        f.ring.Allow(true);
        f.session.Text(Light(request,"249"),4);assert(f.sink.text.back().find("invalid")!=std::string::npos);
        f.session.Text(Light(),5);f.Pump(6);f.Pump(7);
        assert(f.lights.shows==1&&f.sink.ring_states.back().find("lit")!=std::string::npos);
        f.session.Text(Light(std::string(32,'d')),8);assert(f.sink.text.back().find("busy")!=std::string::npos);
        f.Pump(256);assert(f.lights.closes==0);
        f.Pump(257);assert(f.lights.closes==1&&f.sink.text.back().find("completed")!=std::string::npos);
        f.session.Text(Light(),258);f.Pump(259);assert(f.lights.opens==1);
        const std::string next(32,'e');
        f.session.Text(Light(next),260);f.Pump(261);
        f.session.Text(Command("cancel_ring",1,next),262);f.Pump(263);
        assert(f.lights.shows==1&&f.lights.closes==2&&f.sink.text.back().find("cancelled")!=std::string::npos);
        f.session.Text(Light(std::string(32,'f')),264);f.Pump(265);f.Pump(266);
        f.lights.close_ok=false;f.session.Text(Command("stop",1),267);
        f.Pump(268);assert(f.life.phase()==Phase::Fault&&f.sink.text.back().find("stopped")==std::string::npos);
        f.lights.close_ok=true;f.session.LocalStop(true,269);f.Pump(270);
        assert(f.life.phase()==Phase::Home&&f.effects.homes==1);
    }
    {
        Fixture f(false,false,true);Start(f);
        assert(f.sink.text.front().find("\"motion\":1")!=std::string::npos);
        f.session.Text(Move(),3);assert(f.sink.text.back().find("disabled")!=std::string::npos);
        assert(f.motors.opens==0);
        f.motion.AllowMotion(true);
        f.session.Text(Move(request,"49"),4);assert(f.sink.text.back().find("invalid")!=std::string::npos);
        f.session.Text(Move(),5);f.Pump(6);f.Pump(7);
        f.session.Text(Move(std::string(32,'d')),8);assert(f.sink.text.back().find("busy")!=std::string::npos);
        f.Pump(9);f.Pump(60);
        assert(f.motors.releases==0&&f.sink.text.back().find("busy")!=std::string::npos);
        f.Pump(61);
        assert(f.motors.releases==1&&f.sink.text.back().find("\"yaw\":-200")!=std::string::npos&&
               f.sink.text.back().find("reached")!=std::string::npos);
        f.session.Text(Move(),62);f.Pump(63);assert(f.motors.moves==1);
        const std::string cancel_id(32,'e');
        f.session.Text(Move(cancel_id),64);f.Pump(65);
        f.session.Text(Command("cancel_move",1,cancel_id),66);
        f.Pump(67);assert(f.motors.releases==2&&f.motors.moves==1&&f.sink.text.back().find("cancelled")!=std::string::npos);
        const std::string revoke_id(32,'f');
        f.session.Text(Move(revoke_id),68);f.Pump(69);
        f.motion.AllowMotion(false);f.Pump(70);
        assert(f.motors.releases==3&&f.sink.text.back().find("cancelled")!=std::string::npos);
        f.motion.AllowMotion(true);
        f.session.Text(Move(cancel_id),71);f.Pump(72);
        f.session.Text(Command("stop",1),73);f.Pump(74);
        assert(f.motors.releases==4&&f.sink.text.back().find("stopped")!=std::string::npos);
    }
    {
        Fixture f(false,false,true);Start(f);f.motion.AllowMotion(true);f.motors.release_ok=false;
        f.session.Text(Move(),3);f.Pump(4);f.Pump(5);f.Pump(6);f.Pump(56);f.Pump(57);
        assert(f.sink.text.back().find("release-unconfirmed")!=std::string::npos&&
               f.sink.text.back().find("yaw")==std::string::npos);
        f.session.Text(Command("stop",1),58);f.Pump(59);
        assert(!f.session.attached()&&f.life.phase()==Phase::Fault);
    }

    {
        Fixture f(false,true);assert(f.Attach());f.session.Tick(0);
        assert(f.sink.states.size()==1&&f.sink.states.back().find("disabled")!=std::string::npos&&f.photo_port.opens==0);
        f.session.Tick(1999);assert(f.sink.states.size()==1);
        f.session.Tick(2000);assert(f.sink.states.size()==2);
        f.sink.camera_accept=false;f.camera.AllowCapture(true);f.session.Tick(2001);
        assert(f.session.attached()&&f.sink.states.size()==2&&f.photo_port.opens==0);
        f.sink.camera_accept=true;f.session.Tick(2002);
        assert(f.sink.states.back().find("allowed")!=std::string::npos&&f.sink.states.size()==3);
    }
    {
        Fixture f(false,true);Start(f);
        f.session.Text(Command("capture_camera",1),3);f.Pump(4);
        assert(f.photo_port.opens==0&&f.sink.text.back().find("disabled")!=std::string::npos);
        f.camera.AllowCapture(true);
        const std::string id(32,'d');
        f.session.Text(Command("capture_camera",1,id),5);
        f.sink.camera_accept=false;f.Pump(6);f.Pump(7);f.Pump(8);
        assert(f.photo_port.closes==1&&f.session.attached());
        f.sink.camera_accept=true;f.Pump(9);
        assert(f.sink.text.back().find("camera_meta")!=std::string::npos);
        assert(f.session.CameraSnapshot().phase=="transferring"&&f.session.CameraSnapshot().busy);
        assert(f.sink.states.back().find("transferring")!=std::string::npos);
        auto next=Command("camera_next",1,id);next.pop_back();next+=",\"offset\":\"0\"}";
        f.session.Text(next,10);f.sink.camera_accept=false;f.Pump(11);
        f.camera.AllowCapture(false);f.camera.AllowCapture(true);f.sink.camera_accept=true;f.Pump(12);
        assert(f.sink.text.back().find("cancelled")!=std::string::npos&&f.session.attached());
        assert(f.session.CameraSnapshot().error=="cancelled"&&!f.session.CameraSnapshot().busy);
        // A previously sent pull can race the local cancellation receipt.
        f.session.Text(next,13);assert(f.session.attached());
        const std::string another(32,'e');f.session.Text(Command("capture_camera",1,another),14);
        f.Pump(15);assert(f.photo_port.opens==2);f.session.Text(Command("stop",1),16);f.Pump(17);
        assert(f.photo_port.closes==2&&f.life.phase()==Phase::Idle&&f.sink.text.back().find("stopped")!=std::string::npos);
    }
    {
        // Timeout revokes a request and waits for real cleanup; it does not
        // turn a failed close into a success or stop unrelated audio itself.
        PhotoPort port;port.pending=true;CameraEngine engine(port);engine.AllowCapture(true);
        CameraTransfer transfer(&engine);assert(transfer.Begin(request,1,0));engine.Pump(0);
        auto send=[](const std::string&){assert(false);return true;};
        transfer.Pump(CameraTransfer::TimeoutMs,"",send);assert(engine.status().phase==CameraPhase::Closing);
        port.close_ok=false;engine.Pump(CameraTransfer::TimeoutMs+1);
        std::string result;transfer.Pump(CameraTransfer::TimeoutMs+2,"\"epoch\":\"1\"",[&](const std::string& value){result=value;return true;});
        assert(result.find("\"code\":\"close\"")!=std::string::npos&&!transfer.busy()&&engine.status().phase==CameraPhase::Fault);
    }
    {
        Fixture f(false,true);Start(f);f.camera.AllowCapture(true);f.session.Text(Command("capture_camera",1),3);
        f.Pump(4);f.Pump(5);f.Pump(6);
        auto next=Command("camera_next",1);next.pop_back();next+=",\"offset\":\"1\"}";
        f.session.Text(next,7);assert(!f.session.attached()); // gap is not silently repaired
    }
    {
        Fixture f(true);Start(f);assert(f.sink.text.front().find("\"expression\":1")!=std::string::npos);
        for(const std::string value:{"neutral","happy","angry","sad","doubt","sleepy"}){
            auto text=Command("set_expression",1);text.pop_back();text+=",\"expression\":\""+value+"\"}";
            f.session.Text(text,3);assert(f.expression.value==value&&f.sink.text.back().find("applied")!=std::string::npos);
        }
        assert(f.expression.applied==6);f.expression.visible=false;
        auto text=Command("set_expression",1);text.pop_back();text+=",\"expression\":\"happy\"}";
        f.session.Text(text,4);assert(f.expression.applied==6&&f.sink.text.back().find("unavailable")!=std::string::npos);
        f.session.Text(Command("stop",1),5);assert(f.expression.value=="neutral");f.Pump(6);assert(f.life.phase()==Phase::Idle);
    }
    {
        Fixture f(true);Start(f);auto text=Command("set_expression",1);text.pop_back();text+=",\"expression\":\"invented\"}";
        f.session.Text(text,3);assert(!f.session.attached()&&f.expression.applied==0&&f.expression.resets==1);
    }
    {
        InputFrame frame;frame.epoch=0x0102030405060708ULL;frame.sequence=UINT64_MAX-1;frame.read_started_us=42;
        frame.pcm[0]=-32768;frame.pcm[1]=32767;const auto bytes=wire::EncodeInput(frame);
        assert(HexBytes(bytes.data(),32)=="53494131010000000102030405060708fffffffffffffffe000000000000002a");
        assert(bytes[32]==0&&bytes[33]==128&&bytes[34]==255&&bytes[35]==127);
        auto out=Output(UINT64_MAX-1,42);OutputFrame decoded;assert(wire::DecodeOutput(out.data(),out.size(),decoded));
        assert(decoded.epoch==UINT64_MAX-1&&decoded.sequence==42&&decoded.pcm[0]==-32768&&decoded.pcm[1]==32767);
        for(size_t offset:{0,4,5,6,7,24}){auto bad=out;bad[offset]^=8;assert(!wire::DecodeOutput(bad.data(),bad.size(),decoded));}
    }
    {
        Fixture f;Start(f);auto bytes=Output(1,0);f.session.Binary(bytes.data(),bytes.size(),3);
        assert(f.audio.status().output_depth==1&&f.audio.status().output_written==0&&f.sink.text.size()==2);
        f.Pump(4);assert(f.audio.status().output_written==1&&f.port.writes==1);
        assert(f.sink.text.back().find("output")!=std::string::npos&&f.sink.binary.size()==1);
        f.session.Text(Command("stop",1),5);f.session.Tick(5);assert(f.life.phase()==Phase::Draining);
        assert(f.sink.text.back().find("stopped")==std::string::npos);
        f.session.Binary(bytes.data(),bytes.size(),5);assert(f.session.attached()); // in-flight old playback
        f.Pump(6);assert(f.life.phase()==Phase::Idle&&f.port.closes==1);
        assert(f.sink.text.back().find("resources_stopped\":true")!=std::string::npos);
        f.session.Text(Command("start",2),7);f.Pump(8);assert(f.life.epoch()==3&&f.life.phase()==Phase::Active);
        f.session.Binary(bytes.data(),bytes.size(),9);assert(!f.session.attached()&&f.life.phase()==Phase::Draining);
    }
    {
        Fixture f;assert(f.maintenance.OpenWindow(0,std::string(32,'d')));assert(!f.Attach());f.maintenance.CloseWindow();
        assert(f.Attach());assert(f.maintenance.OpenWindow(0,std::string(32,'d')));
        f.session.Text(Command("start",0),1);assert(!f.session.attached()&&f.port.opens==0);
        Fixture disabled;disabled.audio.AllowCapture(false);assert(disabled.Attach());disabled.session.Text(Command("start",0),1);
        assert(!disabled.session.attached()&&disabled.port.opens==0);
    }
    for(const std::string& malformed:std::vector<std::string>{"{}","{\"type\":{}}","[1]",Command("start",0)+"x",
        "{\"type\":\"start\",\"type\":\"stop\"}","{\"type\":\"start\\u0000\"}",std::string(2049,'x')}){
        Fixture f;assert(f.Attach());f.session.Text(malformed,1);assert(!f.session.attached()&&f.port.opens==0);
    }
    {
        Fixture f;Start(f);f.session.Text(Command("renew",1),14000);f.session.Tick(15001);assert(f.life.phase()==Phase::Active);
        f.session.Tick(29000);assert(!f.session.attached()&&f.life.phase()==Phase::Draining);f.Pump(29001);assert(f.life.phase()==Phase::Idle);
    }
    for(bool carrier_closed:{false,true}){
        Fixture f(true,true,true,true);Start(f);
        f.photo_port.pending=true;
        f.camera.AllowCapture(true);
        f.motion.AllowMotion(true);
        f.ring.Allow(true);
        f.session.Text(Command("capture_camera",1),14980);
        f.session.Text(Move(),14980);
        f.session.Text(Light(),14980);
        auto expression=Command("set_expression",1);expression.pop_back();
        f.session.Text(expression+",\"expression\":\"sad\"}",14980);
        f.Pump(14981);f.Pump(14982);f.Pump(14983);
        assert(f.photo_port.opens==1&&f.motors.moves==1&&f.lights.shows==1&&f.expression.value=="sad");
        const auto old_output=Output(1,0);
        f.session.Binary(old_output.data(),old_output.size(),14990);
        assert(f.audio.status().output_depth==1);
        const auto before=f.sink.text.size();
        if(carrier_closed)f.session.Disconnected(14995);
        else f.session.Tick(15001); // last renewal was start at 1
        assert(f.life.phase()==Phase::Draining&&f.life.epoch()==2&&!f.session.attached());
        assert(f.audio.status().output_depth==0&&f.expression.value=="neutral");
        assert(!f.session.AttachAuthenticated(device,pair,boot,15001));
        f.session.Text(Command("renew",1),15001);
        f.session.Binary(old_output.data(),old_output.size(),15001);
        f.Pump(15002);f.Pump(15003);
        assert(f.life.phase()==Phase::Idle&&f.life.epoch()==2&&f.sink.closes==1);
        assert(f.sink.text.size()==before&&f.port.writes==0&&f.port.closes==1);
        assert(f.photo_port.closes==1&&f.motors.releases==1&&f.lights.closes==1);
        assert(f.session.AttachAuthenticated(device,pair,boot,15003));
        assert(f.port.opens==1); // A new authenticated hello is not Start.
    }
    std::cout<<"Carrier close and silent expiry fenced stale PCM/renewals and released audio, camera, motion, ring, and expression.\n";
    {
        Fixture f;Start(f);f.session.LocalStop(true,3);assert(!f.session.attached()&&f.life.phase()==Phase::Draining);
        assert(f.effects.homes==0);f.Pump(4);assert(f.life.phase()==Phase::Home&&f.effects.homes==1);
        assert(f.life.Reopen());assert(f.Attach());
    }
    {
        Fixture f;f.port.open=false;assert(f.Attach());f.session.Text(Command("start",0),1);f.Pump(2);
        assert(!f.session.attached()&&f.sink.text.size()==1);f.Pump(3);assert(f.port.closes==1);
        Fixture g;Start(g);g.port.close=false;g.session.Text(Command("stop",1),3);g.Pump(4);
        assert(!g.session.attached()&&g.life.phase()==Phase::Fault);
    }
    {
        Fixture f;Start(f);f.sink.accept=false;f.Pump(3);assert(!f.session.attached()&&f.life.phase()==Phase::Draining);
        Fixture g;Start(g);g.port.write=false;auto bytes=Output(1,0);g.session.Binary(bytes.data(),bytes.size(),3);g.Pump(4);
        assert(!g.session.attached()&&g.audio.status().output_written==0);
    }
    for(bool discard:{false,true}){
        Fixture f;Start(f);auto frame=Output(1,0);f.session.Binary(frame.data(),frame.size(),3);
        f.session.Text(Fence(discard?"interrupt_output":"drain_output",1),4);
        assert(f.session.attached());f.Pump(5);
        assert(f.sink.text.back().find(discard?"output_interrupted":"output_drained")==std::string::npos);
        for(uint64_t now=6;now<10;++now)f.Pump(now);
        assert(f.sink.text.back().find(discard?"output_interrupted":"output_drained")!=std::string::npos);
        assert(f.port.writes==(discard?0:1)&&f.port.closes==0&&f.sink.binary.size()>=4);
        frame=Output(1,1);f.session.Binary(frame.data(),frame.size(),11);f.Pump(12);
        assert(f.session.attached()&&f.sink.text.back().find("\"sequence\":\"1\"")!=std::string::npos);
    }
    {
        Fixture f;Start(f);f.session.Text(Fence("drain_output",1),3);assert(!f.session.attached());
        Fixture g;Start(g);g.session.Text(Fence("drain_output",0),3);g.Pump(4);
        g.session.Text(Command("stop",1),5);g.Pump(6);
        assert(g.sink.text.back().find("stopped")!=std::string::npos&&g.life.phase()==Phase::Idle);
        Fixture h;Start(h);h.port.fence_fail=true;h.session.Text(Fence("drain_output",0),3);h.Pump(4);
        assert(!h.session.attached());h.Pump(5);assert(h.port.closes==1);
    }
    std::cout<<"Agent session: wire, start/stop, playback fences/interrupt credits/capture, USB, lease, Home and faults passed\n";
}
