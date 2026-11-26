// SPDX-License-Identifier: MIT
#include "motion_scs.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <deque>
#include <vector>
using namespace sion::agent;
// Real upstream SCS packet encoder/parser, emulated serial bytes and registers.
struct Device final:SCS,ServoLink {
    enum Fault {None,Checksum,WrongId,Length,Status,Truncate,NoReply,Transport};
    std::array<std::array<unsigned char,80>,3> regs{};
    std::vector<unsigned char> tx;
    std::deque<unsigned char> rx;
    std::vector<std::vector<unsigned char>> writes;
    int opens=0,closes=0,operations=0,fail_at=-1,yaw_zero=460,pitch_zero=620,silent_until=0;
    int mute_writes_id=0;                        // v67 yaw: answers reads, never acknowledges writes
    std::vector<std::pair<int,int>> kinds;       // instruction and address of each transaction
    std::vector<unsigned> pauses;
    void Pause(unsigned ms) override{pauses.push_back(ms);}
    Fault fault=None;
    bool open_ok=true,close_ok=true,healthy=true,hold_torque=false;
    int hold_goal_id=0;
    bool wheel_ok=false,freeze_limits=false;
    Device():SCS(1) {
        for(int id=1;id<=2;++id){word(id,9,0);word(id,11,1000);}
        word(1,56,460);word(2,56,764);
    }
    void word(int id,int address,int value){regs[id][address]=value>>8;regs[id][address+1]=value;}
    bool Open(int& yaw,int& pitch) override{++opens;yaw=yaw_zero;pitch=pitch_zero;return open_ok;}
    bool Close() override{++closes;return close_ok;}
    bool Healthy() const override{return healthy;}
    void failNext(Fault f){fault=f;fail_at=operations+1;}
    void rFlushSCS() override{tx.clear();rx.clear();healthy=true;}
    int writeSCS(unsigned char* p,int n) override{tx.insert(tx.end(),p,p+n);return n;}
    int writeSCS(unsigned char b) override{tx.push_back(b);return 1;}
    int readSCS(unsigned char* p,int n) override {
        int i=0;while(i<n&&!rx.empty()){if(p)p[i]=rx.front();rx.pop_front();++i;}return i;
    }
    int readSCS(unsigned char* p,int n,unsigned long) override{return readSCS(p,n);}
    void wFlushSCS() override {
        ++operations;assert(tx.size()>=8&&tx.size()==size_t(tx[3]+4));
        assert(tx[0]==255&&tx[1]==255&&tx[2]>=1&&tx[2]<=2);
        unsigned sum=0;for(size_t i=2;i+1<tx.size();++i)sum+=tx[i];
        assert(tx.back()==static_cast<unsigned char>(~sum));
        const int id=tx[2],address=tx[5];std::vector<unsigned char> data;
        kinds.push_back({tx[4],address});
        if(tx[4]==2) {
            const int n=tx[6];assert(address+n<=80);
            data.assign(regs[id].begin()+address,regs[id].begin()+address+n);
        } else {
            assert(tx[4]==3); // No broadcast, reset, REG_ACTION or mode commands.
            const size_t n=tx.size()-7;
            // Never EEPROM, except the owner-approved yaw wheel mode (limits 9..12, duty 44).
            assert((address==40&&n==1)||(address==42&&n==6)||
                   (wheel_ok&&id==1&&((address==9&&n==4)||(address==44&&n==2))));
            writes.push_back(tx);
            for(size_t i=0;i<n;++i)if(!(hold_torque&&address==40)&&!(id==hold_goal_id&&address==42)&&!(freeze_limits&&address==9))regs[id][address+i]=tx[6+i];
        }
        const Fault f=operations==fail_at?fault:None;
        if(tx[4]==3&&id==mute_writes_id)return;
        if(f==NoReply||operations<=silent_until){if(operations<=silent_until)healthy=false;return;}
        healthy=f!=Transport;
        std::vector<unsigned char> reply{255,255,static_cast<unsigned char>(f==WrongId?3:id),
            static_cast<unsigned char>(data.size()+2+(f==Length)),static_cast<unsigned char>(f==Status?32:0)};
        reply.insert(reply.end(),data.begin(),data.end());sum=0;
        for(size_t i=2;i<reply.size();++i)sum+=reply[i];
        reply.push_back(static_cast<unsigned char>(~sum));
        if(f==Checksum)reply.back()^=1;
        if(f==Truncate)reply.pop_back();
        rx.assign(reply.begin(),reply.end());
    }
};
static void goalFeedback(Device& d) {
    for(int id=1;id<=2;++id){d.regs[id][56]=d.regs[id][42];d.regs[id][57]=d.regs[id][43];}
}
int main() {
    { // v66: freshly powered servos stay silent for a while; torque-off is retried.
        Device d;ScsMotionPort p(d,d);
        d.silent_until=6;   // Round 1 silent; round 2 only the yaw servo still silent.
        assert(p.Open()&&p.OpenAttempts()==3&&p.OpenWaitedMs()==2*ScsMotionPort::kSilentPauseMs);
        assert(d.pauses.size()==2);
        for(const auto& w:d.writes)assert(w[5]==40&&w[6]==0);      // Only torque-off was repeated.
        assert(p.Release()==Result::Done);
    }
    { // Never answering: gives up after the bounded retries, still torque-off only.
        Device d;ScsMotionPort p(d,d);d.silent_until=1000;
        assert(!p.Open()&&p.OpenFailure()==4&&p.OpenAttempts()==ScsMotionPort::kSilentRetries+1);
        assert(d.pauses.size()==ScsMotionPort::kSilentRetries);
        for(const auto& w:d.writes)assert(w[5]==40&&w[6]==0);
        assert(p.Release()==Result::Failed);    // Torque-off never confirmed.
    }
    { // v67: the yaw servo answers reads but never acknowledges writes. The
      // stock firmware ignores acknowledgements; readback decides here.
        Device d;ScsMotionPort p(d,d);d.mute_writes_id=1;
        d.regs[1][6]=0;d.regs[1][7]=0;d.regs[1][8]=0;d.regs[2][6]=0;d.regs[2][7]=0;d.regs[2][8]=1;
        assert(p.Open()&&p.OpenAttempts()==1&&d.pauses.empty());
        assert(p.Info(0)==(1u<<24)&&p.Info(1)==((1u<<24)|1));
        assert(p.Move({300,450,500})&&!p.WriteAcked(0)&&p.WriteAcked(1));
        goalFeedback(d);MotionFeedback f;assert(p.Poll(f)==Result::Done&&f.yaw==300);
        assert(p.Release()==Result::Done&&d.regs[1][40]==0&&d.regs[2][40]==0);
    }
    { // Hold present pose, go limp while powered, read every register; keyframes.
        Device d;ScsMotionPort p(d,d);d.mute_writes_id=1;assert(p.Open());
        d.word(1,56,500);d.word(2,56,700);
        assert(p.Torque(true)&&d.regs[1][40]==1&&d.regs[2][40]==1);
        assert(((d.regs[1][42]<<8)|d.regs[1][43])==500&&((d.regs[2][42]<<8)|d.regs[2][43])==700);
        d.word(1,58,0x8000|12);d.word(1,60,(1<<10)|300);d.regs[1][62]=74;d.regs[1][63]=36;
        d.regs[1][66]=1;d.word(1,69,0x8000|25);
        MotionSense s;assert(p.Sense(s));
        assert(s.yaw.position==500&&s.yaw.angle==(500-460)*50/16&&s.yaw.speed==-12&&s.yaw.load==-300);
        assert(s.yaw.voltage==74&&s.yaw.temperature==36&&s.yaw.moving&&s.yaw.current==-25&&s.yaw.torque);
        assert(s.pitch.position==700&&s.pitch.torque&&!s.pitch.moving);
        d.word(1,56,1015);assert(p.Sense(s)&&!s.yaw.in_range&&s.yaw.position==1015&&s.pitch.in_range); // v69 blind zone
        d.word(1,56,500);
        assert(p.Torque(false)&&d.regs[1][40]==0&&d.regs[2][40]==0&&p.DrivesDisabled());
        assert(p.Sense(s)&&!s.yaw.torque&&!s.pitch.torque);              // Limp but still readable.
        assert(p.Move({100,450,300})&&p.Move({-100,450,300}));             // Keyframes on one open port.
        assert(p.Release()==Result::Done&&d.regs[1][40]==0);
        assert(!p.Torque(true)&&!p.Sense(s));                              // Closed: nothing is sent.
    }
    { // Yaw wheel mode: limits to zero and verified, duty with direction bit,
      // then stop, torque off and the original limits restored and verified.
        Device d;d.wheel_ok=true;d.mute_writes_id=1;ScsMotionPort p(d,d);assert(p.Open());
        assert(p.Rotate(600)&&p.Rotating());
        assert(d.regs[1][9]==0&&d.regs[1][10]==0&&d.regs[1][11]==0&&d.regs[1][12]==0&&d.regs[1][40]==1);
        assert(((d.regs[1][44]<<8)|d.regs[1][45])==(600|(1<<10)));          // Positive = left = direction bit.
        assert(p.Rotate(-300)&&((d.regs[1][44]<<8)|d.regs[1][45])==300);
        assert(p.Rotate(0)&&!p.Rotating());
        assert(((d.regs[1][44]<<8)|d.regs[1][45])==0&&d.regs[1][40]==0);
        assert(((d.regs[1][9]<<8)|d.regs[1][10])==0&&((d.regs[1][11]<<8)|d.regs[1][12])==1000); // Fixture limits 0..1000.
        for(const auto& w:d.writes)assert(w[2]==1||w[5]==40);            // Pitch never leaves position mode.
        assert(!p.Rotate(1001));
        assert(p.Rotate(500)&&p.Move({0,450,300})&&!p.Rotating());      // A move ends wheel mode first.
        assert(((d.regs[1][11]<<8)|d.regs[1][12])==1000);
        assert(p.Rotate(500)&&p.Release()==Result::Done&&!p.Rotating());  // So does release.
        assert(((d.regs[1][11]<<8)|d.regs[1][12])==1000&&d.regs[1][40]==0);
    }
    { // A limit write that does not read back keeps trying to restore on release.
        Device d;d.wheel_ok=true;ScsMotionPort p(d,d);assert(p.Open());
        d.freeze_limits=true;assert(!p.Rotate(400));d.freeze_limits=false;
        assert(p.Rotating()&&p.Release()==Result::Done&&!p.Rotating());
    }
    { // Holding refuses a present position outside the servo's own limits.
        Device d;ScsMotionPort p(d,d);d.word(1,11,450);assert(p.Open());d.word(1,56,460);
        assert(!p.Torque(true));assert(p.Release()==Result::Done);
    }
    { // After two unacknowledged writes the yaw servo is no longer waited on;
      // readback still decides. Torque already on is not written again.
        Device d;ScsMotionPort p(d,d);d.mute_writes_id=1;assert(p.Open());
        assert(p.Move({100,450,300})&&d.pauses.empty());               // Goal + torque: two misses learned.
        const auto torque_writes=[&]{int n=0;for(const auto& w:d.writes)if(w[5]==40&&w[6]==1)++n;return n;};
        const int enabled=torque_writes();
        assert(p.Move({-100,450,300})&&d.pauses==(std::vector<unsigned>{2}));  // One fast yaw write, no wait.
        assert(torque_writes()==enabled);                                  // Still on: not re-enabled.
        d.hold_goal_id=1;assert(!p.Move({50,450,300}));                     // Readback still guards it.
        assert(p.Release()==Result::Done);
    }
    { // A goal that does not read back as written fails the move.
        Device d;ScsMotionPort p(d,d);assert(p.Open());
        d.hold_goal_id=2;assert(!p.Move({0,450,1000}));assert(p.Release()==Result::Done);
    }
    { // A servo that answers but keeps torque on is not retried.
        Device d;ScsMotionPort p(d,d);d.hold_torque=true;d.regs[1][40]=1;
        assert(!p.Open()&&p.OpenFailure()==4&&p.OpenAttempts()==1&&d.pauses.empty());
    }
    { // Independent bytes/endianness; no implicit fallback or EEPROM writes.
        Device d;ScsMotionPort p(d,d);assert(d.operations==0&&p.Open());
        assert(d.writes.size()==2&&!p.Open());assert(p.Move({-900,650,1234}));
        assert(d.writes[2]==(std::vector<unsigned char>{255,255,1,9,3,42,0,172,4,210,0,0,70}));
        const auto& pitch=d.writes[3];assert(pitch[6]==3&&pitch[7]==60&&pitch[8]==4&&pitch[9]==210);
        goalFeedback(d);MotionFeedback f;
        assert(p.Poll(f)==Result::Done&&f.yaw==-900&&f.pitch==650&&!f.moving&&!f.stalled);
        assert(p.Release()==Result::Done&&d.closes==1);
        const int count=d.operations;assert(p.Release()==Result::Done&&d.operations==count);
    }
    { // Each malformed packet kind must fail, even when parser returns data with
      // nonzero servo status or transport reports a failed write/flush separately.
        for(auto fault:{Device::Checksum,Device::WrongId,Device::Length,Device::Status,
                        Device::Truncate,Device::NoReply,Device::Transport}) {
            Device d;ScsMotionPort p(d,d);assert(p.Open()&&p.Move({}));
            d.failNext(fault);MotionFeedback f{17,18,true,true};
            assert(p.Poll(f)==Result::Failed&&f.yaw==17&&f.pitch==18);
            assert(p.Release()==Result::Done);
        }
    }
    { // Every transaction in Open and Move rejects a bad checksum; cleanup must
      // still reach both axes and the acquired link, including partial writes.
        for(int phase=0;phase<2;++phase) {
            Device baseline;ScsMotionPort sample(baseline,baseline);assert(sample.Open());
            const int open_count=baseline.operations;assert(sample.Move({}));
            const int count=phase==0?open_count:baseline.operations-open_count;
            assert(sample.Release()==Result::Done);
            for(int i=1;i<=count;++i) {
                Device d;ScsMotionPort p(d,d);if(phase)assert(p.Open());
                d.fail_at=d.operations+i;d.fault=Device::Checksum;
                const int at=d.operations+i;
                const bool ok=phase?p.Move({}):p.Open();
                // A corrupt write acknowledgement is tolerated because the
                // register is read back; a corrupt read (other than the
                // diagnostic info read) fails the step.
                const auto kind=d.kinds[at-1];
                const bool tolerated=kind.first==3||kind.second==6;
                assert(ok==tolerated);
                if(phase&&!ok){const int before=d.operations;assert(!p.Move({})&&d.operations==before);}
                assert(p.Release()==Result::Done&&d.closes==1);
                assert(d.regs[1][40]==0&&d.regs[2][40]==0);
            }
        }
    }
    { // Missing/invalid calibration, PWM limits, invalid sensor data and targets.
        for(int v=0;v<7;++v) {
            Device d;ScsMotionPort p(d,d);
            if(v==0)d.open_ok=false;
            if(v==1)d.yaw_zero=-1;
            if(v==2)d.pitch_zero=1001;
            if(v==3)d.word(1,11,0);
            if(v==4)d.word(2,11,1024);
            if(v==5)d.word(2,56,1001);
            if(v==6)d.regs[1][66]=2;
            assert(!p.Open());
            static constexpr int step[]{2,3,3,5,6,7,7};assert(p.OpenFailure()==step[v]);
            if(v==3)assert(p.MinLimit(0)>=0&&p.MaxLimit(0)==0); // PWM-mode residue is visible
            assert(p.Release()==Result::Done&&d.closes==1);
            for(const auto& w:d.writes)assert(w[5]==40&&w[6]==0);
        }
        Device d;ScsMotionPort p(d,d);assert(p.Open());int count=d.operations;
        assert(!p.Move({1281,450,1000})&&!p.Move({0,49,1000})&&!p.Move({0,450,19})&&d.operations==count); // Port floor is the setpoint step (20 ms).
        assert(p.Release()==Result::Done);
        Device limited;limited.word(1,11,500);ScsMotionPort q(limited,limited);
        assert(q.Open());count=limited.operations;assert(!q.Move({1280,450,1000})&&limited.operations==count);
        assert(q.Release()==Result::Done);
    }
    { // Cleanup never stops after first-axis failure or closes an uncertain link.
        for(int i=1;i<=4;++i) {
            Device d;ScsMotionPort p(d,d);assert(p.Open()&&p.Move({}));
            const int before=d.operations;d.fail_at=before+i;d.fault=Device::NoReply;
            if(i%2==1){ // Lost write acknowledgement: torque read back as 0 is enough.
                assert(p.Release()==Result::Done&&d.operations==before+4&&d.closes==1);continue;
            }
            assert(p.Release()==Result::Failed&&d.operations==before+4&&d.closes==0);
            assert(!p.Move({})&&!p.Open());assert(p.Release()==Result::Done&&d.closes==1);
        }
        Device d;ScsMotionPort p(d,d);assert(p.Open()&&p.Move({}));d.hold_torque=true;
        assert(p.Release()==Result::Failed&&d.closes==0);d.hold_torque=false;d.close_ok=false;
        assert(p.Release()==Result::Failed&&d.closes==1&&!p.Open());d.close_ok=true;
        const int released_operations=d.operations;
        assert(p.Release()==Result::Done&&d.closes==2&&d.operations==released_operations);
    }
    { // Zero ACK level / wrong endian rejected before opening a link.
        for(int v=0;v<2;++v){Device d;if(v)d.End=0;else d.Level=0;ScsMotionPort p(d,d);
            assert(!p.Open()&&d.opens==0&&p.Release()==Result::Done&&d.closes==0);}
    }
    { // Configured high-load protection needs successive stationary samples.
        Device d;ScsMotionPort p(d,d);assert(p.Open()&&p.Move({900,650,1000}));
        d.word(2,60,650);MotionFeedback f;
        assert(p.Poll(f)==Result::Done&&!f.stalled);
        assert(p.Poll(f)==Result::Done&&!f.stalled);
        assert(p.Poll(f)==Result::Done&&f.stalled);assert(p.Release()==Result::Done);
    }
    { // A sudden load rise while stuck counts too, below the absolute threshold (v68).
        Device d;ScsMotionPort p(d,d);assert(p.Open()&&p.Move({0,600,1000}));MotionFeedback f;
        d.word(2,60,100);assert(p.Poll(f)==Result::Done&&!f.stalled);
        d.word(2,60,300);assert(p.Poll(f)==Result::Done&&!f.stalled);       // +200: one count.
        d.word(2,60,460);assert(p.Poll(f)==Result::Done&&f.stalled);        // +160: two in a row.
        assert(p.Release()==Result::Done);
        Device g;ScsMotionPort q(g,g);assert(q.Open()&&q.Move({0,600,1000}));
        g.word(2,60,100);assert(q.Poll(f)==Result::Done);
        g.word(2,60,200);assert(q.Poll(f)==Result::Done&&!f.stalled);       // +100: below the rise rule.
        g.word(2,60,300);assert(q.Poll(f)==Result::Done&&!f.stalled);
        assert(q.Release()==Result::Done);
    }
    { // Real engine + real adapter + real SCS codec, only the electrical peer is fake.
        Device d;ScsMotionPort port(d,d);MotionEngine engine(port);MotionOutcome result;
        engine.AllowMotion(true);auto ticket=engine.Begin(1,{},0);assert(ticket);
        engine.Pump(0);engine.Pump(1);goalFeedback(d);engine.Pump(2);engine.Pump(52);
        assert(!engine.Take(1,ticket,result));engine.Pump(53);
        assert(engine.Take(1,ticket,result)&&result.error==MotionError::None&&d.closes==1);
        assert(engine.Begin(1,{},54));engine.Pump(54);engine.Pump(55);engine.Stop(2);
        assert(engine.Stopped(2)==Result::Pending);engine.Pump(56);
        assert(engine.Stopped(2)==Result::Done&&d.closes==2);
    }
    std::puts("Actual SCS codec + motion adapter/engine: endian bytes, status/transport faults, calibration/limits, feedback and two-axis release passed; emulated serial peer only.");
}
