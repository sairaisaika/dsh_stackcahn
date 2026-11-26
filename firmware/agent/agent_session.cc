// SPDX-License-Identifier: MIT
#include "agent_session.h"
#include "agent_wire.h"
#include <cJSON.h>
#include <charconv>
#include <memory>
#include <set>
namespace sion::agent {
namespace {
bool Hex(const std::string& s,size_t n){if(s.size()!=n)return false;for(char c:s)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
std::string Field(const cJSON* j,const char* key){const auto* v=cJSON_GetObjectItemCaseSensitive(j,key);return cJSON_IsString(v)?v->valuestring:"";}
bool Epoch(const std::string& s,uint64_t& value){
    if(s.empty()||s.size()>20||(s.size()>1&&s[0]=='0'))return false;
    for(char c:s)if(c<'0'||c>'9')return false;
    auto result=std::from_chars(s.data(),s.data()+s.size(),value);return result.ec==std::errc{}&&result.ptr==s.data()+s.size();
}
bool Integer(const std::string& s,int& value){
    if(s.empty()||s.size()>5)return false;
    const auto result=std::from_chars(s.data(),s.data()+s.size(),value);
    return result.ec==std::errc{}&&result.ptr==s.data()+s.size()&&s==std::to_string(value);
}
// "yaw,pitch,ms;yaw,pitch,ms" with 1..8 frames: the flat wire has no arrays.
bool ParseFrames(const std::string& text,MotionRequest& request){
    request.count=0;size_t at=0;
    if(text.empty())return false;
    while(at<=text.size()){
        if(request.count==kMaxMotionFrames)return false;
        const size_t end=std::min(text.find(';',at),text.size());
        const std::string frame=text.substr(at,end-at);
        const size_t a=frame.find(','),b=a==std::string::npos?a:frame.find(',',a+1);
        if(a==std::string::npos||b==std::string::npos||frame.find(',',b+1)!=std::string::npos)return false;
        auto& t=request.frames[request.count++];
        if(!Integer(frame.substr(0,a),t.yaw)||!Integer(frame.substr(a+1,b-a-1),t.pitch)||
           !Integer(frame.substr(b+1),t.duration_ms))return false;
        if(end==text.size())break;
        at=end+1;
    }
    return true;
}
bool HoldMs(const std::string& text,uint32_t& value){
    int ms=0;if(!Integer(text,ms)||ms<0||uint32_t(ms)>kMaxHoldMs)return false;
    value=uint32_t(ms);return true;
}
const char* MotionPhaseName(MotionPhase phase){
    switch(phase){
        case MotionPhase::Idle:return "idle";
        case MotionPhase::Opening:return "opening";
        case MotionPhase::Commanding:return "commanding";
        case MotionPhase::Moving:return "moving";
        case MotionPhase::Torquing:return "torquing";
        case MotionPhase::Sensing:return "sensing";
        case MotionPhase::Rotating:return "rotating";
        case MotionPhase::Holding:return "holding";
        case MotionPhase::Releasing:return "releasing";
        case MotionPhase::Fault:return "fault";
    }
    return "fault";
}
const char* MotionErrorName(MotionError error){
    switch(error){
        case MotionError::None:return "";
        case MotionError::Open:return "open";
        case MotionError::Command:return "command";
        case MotionError::Feedback:return "feedback";
        case MotionError::Stall:return "stall";
        case MotionError::Timeout:return "timeout";
        case MotionError::Release:return "release-unconfirmed";
        case MotionError::Torque:return "torque";
        case MotionError::Sense:return "sense";
        case MotionError::Rotate:return "rotate";
    }
    return "release-unconfirmed";
}
const char* RingPhaseName(RingPhase phase){
    switch(phase) {
        case RingPhase::Idle:case RingPhase::Indicator:return "idle";
        case RingPhase::Opening:case RingPhase::Showing:return "preparing";
        case RingPhase::Lit:return "lit";
        case RingPhase::Clearing:return "clearing";
        case RingPhase::Fault:return "fault";
    }
    return "fault";
}
const char* RingResultName(RingResult result){
    switch(result) {
        case RingResult::None:return "";
        case RingResult::Completed:return "completed";
        case RingResult::Invalid:return "invalid";
        case RingResult::Disabled:return "disabled";
        case RingResult::Busy:return "busy";
        case RingResult::Cancelled:return "cancelled";
        case RingResult::Open:return "open";
        case RingResult::Write:return "write";
        case RingResult::Release:return "release-unconfirmed";
    }
    return "release-unconfirmed";
}
bool ParseRing(const std::string& color, RingColor& result){
    if(!Hex(color,6))return false;
    unsigned rgb=0;
    const auto parsed=std::from_chars(color.data(),color.data()+color.size(),rgb,16);
    if(parsed.ec!=std::errc{}||parsed.ptr!=color.data()+color.size())return false;
    result={static_cast<uint8_t>(rgb>>16),static_cast<uint8_t>(rgb>>8),static_cast<uint8_t>(rgb)};
    return true;
}
// "rrggbb x12,ms;..." : 1..8 frames of 12 LEDs each and how long each shows.
bool ParseRingFrames(const std::string& text,RingEffect& effect){
    effect.count=0;size_t at=0;
    if(text.empty())return false;
    for(;;){
        if(effect.count==kRingFrames)return false;
        const size_t end=std::min(text.find(';',at),text.size());
        const std::string frame=text.substr(at,end-at);
        if(frame.size()<74||frame[72]!=',')return false;
        for(unsigned led=0;led<12;++led)if(!ParseRing(frame.substr(led*6,6),effect.frames[effect.count][led]))return false;
        if(!Integer(frame.substr(73),effect.frame_ms[effect.count]))return false;
        ++effect.count;
        if(end==text.size())return true;
        at=end+1;
    }
}
// Even-length lowercase hex, as caption text, for image chunks.
bool DecodeHex(const std::string& hex,std::string& bytes){
    if(hex.empty()||hex.size()%2)return false;
    const auto nibble=[](char c)->int{return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:-1;};
    bytes.resize(hex.size()/2);
    for(size_t i=0;i<bytes.size();++i){
        const int hi=nibble(hex[2*i]),lo=nibble(hex[2*i+1]);
        if(hi<0||lo<0)return false;
        bytes[i]=static_cast<char>((hi<<4)|lo);
    }
    return true;
}
struct DisplayCommand{DisplayArea area=DisplayArea::Full;uint32_t ms=0;uint16_t w=0,h=0,x=0,y=0;uint32_t offset=0;std::string bytes;int slot=-1;std::string tag;};
struct Command{std::string type,boot,request,expression,caption;DisplayCommand display;uint64_t epoch=0,boundary=0;MotionTarget target;MotionRequest motion;RingEffect ring;CaptionSpeaker speaker;RingIndicator indicator;unsigned report=ReportKinds;uint32_t interval_ms=0;};
bool Parse(const std::string& text,Command& command){
    // All defined fields are ASCII correlation strings. No escaping, nested
    // containers or NUL is needed; reject before recursive cJSON allocation.
    if(text.empty()||text.size()>2048)return false;
    bool quoted=false;int depth=0;
    for(unsigned char c:text){
        if(!c||c>=128||c=='\\')return false;
        if(c=='"')quoted=!quoted;
        if(!quoted){if(c=='['||c==']')return false;if(c=='{'&&++depth>1)return false;if(c=='}'&&--depth<0)return false;}
    }
    if(quoted||depth)return false;
    const char* end=nullptr;
    std::unique_ptr<cJSON,decltype(&cJSON_Delete)> json(cJSON_ParseWithLengthOpts(text.c_str(),text.size()+1,&end,true),cJSON_Delete);
    if(!json||!cJSON_IsObject(json.get()))return false;
    std::set<std::string> fields;
    for(auto* item=json->child;item;item=item->next){if(!item->string||!cJSON_IsString(item)||!fields.insert(item->string).second)return false;}
    command.type=Field(json.get(),"type");command.boot=Field(json.get(),"boot_id");command.request=Field(json.get(),"request_id");
    if(!Hex(command.boot,32)||!Epoch(Field(json.get(),"epoch"),command.epoch))return false;
    if(command.type=="renew")return fields==std::set<std::string>{"type","boot_id","epoch"};
    if(command.type=="voice_indicator") {
        const auto state=Field(json.get(),"state");
        if(state=="listening")command.indicator=RingIndicator::Listening;
        else if(state=="waiting")command.indicator=RingIndicator::Waiting;
        else if(state=="standby")command.indicator=RingIndicator::Off; // Linked, nobody addressed.
        else return false;
        return fields==std::set<std::string>{"type","boot_id","epoch","state"};
    }
    if(command.type=="caption"){
        const auto speaker=Field(json.get(),"speaker");
        if(speaker=="user")command.speaker=CaptionSpeaker::User;
        else if(speaker=="assistant")command.speaker=CaptionSpeaker::Assistant;
        else if(speaker=="status")command.speaker=CaptionSpeaker::Status;
        else return false;
        return fields==std::set<std::string>{"type","boot_id","epoch","speaker","text_hex"}&&
            DecodeCaption(Field(json.get(),"text_hex"),command.caption);
    }
    if(command.type=="set_expression"){
        command.expression=Field(json.get(),"expression");
        return Hex(command.request,32)&&ValidExpression(command.expression)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","expression"};
    }
    if(command.type=="set_ring_frames"){
        int brightness=0;
        if(!Integer(Field(json.get(),"brightness"),brightness)||brightness<0||brightness>255)return false;
        command.ring.brightness=static_cast<uint8_t>(brightness);
        return Hex(command.request,32)&&ParseRingFrames(Field(json.get(),"frames"),command.ring)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","frames","brightness"};
    }
    if(command.type=="set_ring")return Hex(command.request,32)&&
        ParseRing(Field(json.get(),"rgb"),command.ring.color)&&Integer(Field(json.get(),"duration_ms"),command.ring.duration_ms)&&
        fields==std::set<std::string>{"type","boot_id","epoch","request_id","rgb","duration_ms"};
    if(command.type=="move_head")return Hex(command.request,32)&&
        Integer(Field(json.get(),"yaw"),command.target.yaw)&&Integer(Field(json.get(),"pitch"),command.target.pitch)&&
        Integer(Field(json.get(),"duration_ms"),command.target.duration_ms)&&
        fields==std::set<std::string>{"type","boot_id","epoch","request_id","yaw","pitch","duration_ms"};
    if(command.type=="move_frames"){
        const auto torque=Field(json.get(),"torque");
        command.motion.kind=MotionKind::Move;command.motion.torque=torque=="hold";
        return Hex(command.request,32)&&(torque=="hold"||torque=="limp")&&
            ParseFrames(Field(json.get(),"frames"),command.motion)&&HoldMs(Field(json.get(),"hold_ms"),command.motion.hold_ms)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","frames","hold_ms","torque"};
    }
    if(command.type=="set_torque"){
        // hold: keep the present pose; limp: drives off but powered and readable;
        // release: drives off and power off now.
        const auto torque=Field(json.get(),"torque");
        command.motion.kind=MotionKind::Torque;command.motion.count=0;command.motion.torque=torque=="hold";
        if(!HoldMs(Field(json.get(),"hold_ms"),command.motion.hold_ms))return false;
        if(torque=="release"&&command.motion.hold_ms!=0)return false;
        if(torque!="release"&&command.motion.hold_ms==0)return false;
        return Hex(command.request,32)&&(torque=="hold"||torque=="limp"||torque=="release")&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","torque","hold_ms"};
    }
    if(command.type=="rotate_yaw"){
        const auto torque=Field(json.get(),"torque");
        int ms=0;
        command.motion.kind=MotionKind::Rotate;command.motion.count=0;command.motion.torque=torque=="hold";
        if(!Integer(Field(json.get(),"duration_ms"),ms)||ms<0)return false;
        command.motion.rotate_ms=uint32_t(ms);
        return Hex(command.request,32)&&(torque=="hold"||torque=="limp")&&
            Integer(Field(json.get(),"velocity"),command.motion.velocity)&&
            HoldMs(Field(json.get(),"hold_ms"),command.motion.hold_ms)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","velocity","duration_ms","hold_ms","torque"};
    }
    if(command.type=="show_text"||command.type=="image_begin"){
        int ms=0;
        if(!Integer(Field(json.get(),"duration_ms"),ms)||ms<int(kDisplayMinMs)||ms>int(kDisplayMaxMs))return false;
        command.display.ms=uint32_t(ms);
        if(command.type=="show_text"){
            const auto area=Field(json.get(),"area");
            command.display.area=area=="top"?DisplayArea::Top:area=="bottom"?DisplayArea::Bottom:DisplayArea::Full;
            return Hex(command.request,32)&&(area=="full"||area=="top"||area=="bottom")&&
                DecodeCaption(Field(json.get(),"text_hex"),command.caption)&&
                fields==std::set<std::string>{"type","boot_id","epoch","request_id","text_hex","area","duration_ms"};
        }
        int w=0,h=0,x=0,y=0;
        if(!Integer(Field(json.get(),"width"),w)||!Integer(Field(json.get(),"height"),h)||
           !Integer(Field(json.get(),"x"),x)||!Integer(Field(json.get(),"y"),y)||w<1||h<1||x<0||y<0||
           !ValidDisplayImage(uint16_t(w),uint16_t(h),uint16_t(x),uint16_t(y)))return false;
        command.display.w=uint16_t(w);command.display.h=uint16_t(h);command.display.x=uint16_t(x);command.display.y=uint16_t(y);
        return Hex(command.request,32)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","width","height","x","y","duration_ms"};
    }
    if(command.type=="frame_begin"){
        int w=0,h=0,x=0,y=0,slot=-1;
        if(!Integer(Field(json.get(),"slot"),slot)||slot<0||slot>=kFrameSlots||
           !Integer(Field(json.get(),"width"),w)||!Integer(Field(json.get(),"height"),h)||
           !Integer(Field(json.get(),"x"),x)||!Integer(Field(json.get(),"y"),y)||w<1||h<1||x<0||y<0||
           !ValidDisplayImage(uint16_t(w),uint16_t(h),uint16_t(x),uint16_t(y)))return false;
        auto& d=command.display;
        d.slot=slot;d.w=uint16_t(w);d.h=uint16_t(h);d.x=uint16_t(x);d.y=uint16_t(y);d.tag=Field(json.get(),"tag");
        return Hex(command.request,32)&&Hex(d.tag,kFrameTagSize)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","slot","width","height","x","y","tag"};
    }
    if(command.type=="frame_show"){
        int ms=0,slot=-1;
        if(!Integer(Field(json.get(),"slot"),slot)||slot<0||slot>=kFrameSlots||
           !Integer(Field(json.get(),"duration_ms"),ms)||ms<int(kDisplayMinMs)||ms>int(kDisplayMaxMs))return false;
        command.display.slot=slot;command.display.ms=uint32_t(ms);
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id","slot","duration_ms"};
    }
    if(command.type=="frame_drop"){
        // A slot number, or "all".
        const auto slot_text=Field(json.get(),"slot");
        int slot=-1;
        if(slot_text=="all")slot=kFrameSlots;
        else if(!Integer(slot_text,slot)||slot<0||slot>=kFrameSlots)return false;
        command.display.slot=slot;
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id","slot"};
    }
    if(command.type=="frame_list")
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id"};
    if(command.type=="image_chunk"){
        uint64_t offset=0;
        if(!Epoch(Field(json.get(),"offset"),offset)||offset>uint64_t(kDisplayWidth)*kDisplayHeight*2)return false;
        command.display.offset=uint32_t(offset);
        return Hex(command.request,32)&&DecodeHex(Field(json.get(),"data_hex"),command.display.bytes)&&
            fields==std::set<std::string>{"type","boot_id","epoch","request_id","offset","data_hex"};
    }
    if(command.type=="image_end"||command.type=="clear_display")
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id"};
    if(command.type=="servo_setpoint"){
        // Fire and forget (no request id): only a rejection is answered.
        return Integer(Field(json.get(),"yaw"),command.target.yaw)&&Integer(Field(json.get(),"pitch"),command.target.pitch)&&
            Integer(Field(json.get(),"duration_ms"),command.target.duration_ms)&&
            fields==std::set<std::string>{"type","boot_id","epoch","yaw","pitch","duration_ms"};
    }
    if(command.type=="ir_send"){
        int address=-1,code=-1,repeats=-1;
        if(!Integer(Field(json.get(),"address"),address)||address<0||address>65535||
           !Integer(Field(json.get(),"command"),code)||code<0||code>255||
           !Integer(Field(json.get(),"repeats"),repeats)||repeats<0||repeats>5)return false;
        command.interval_ms=(uint32_t(repeats)<<24)|(uint32_t(code)<<16)|uint32_t(address);
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id","address","command","repeats"};
    }
    if(command.type=="nfc_read"){
        // Type 2 tag pages, 4 bytes each; read-only.
        int page=-1,count=0;
        if(!Integer(Field(json.get(),"page"),page)||page<0||page>255||
           !Integer(Field(json.get(),"count"),count)||count<1||count>int(NfcRead::kMaxPages)||page+count>256)return false;
        command.interval_ms=(uint32_t(page)<<8)|uint32_t(count);
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id","page","count"};
    }
    if(command.type=="set_volume"){
        int volume=-1;
        if(!Integer(Field(json.get(),"volume"),volume)||volume<0||volume>100)return false;
        command.interval_ms=uint32_t(volume);
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id","volume"};
    }
    if(command.type=="set_report_rate"){
        const auto sensor=Field(json.get(),"sensor");
        int ms=0;
        for(unsigned i=0;i<ReportKinds;++i)if(sensor==kReportNames[i])command.report=i;
        if(command.report>=ReportKinds||!Integer(Field(json.get(),"interval_ms"),ms)||
           ms<int(kReportMinMs[command.report])||ms>int(kReportMaxMs))return false;
        command.interval_ms=uint32_t(ms);
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id","sensor","interval_ms"};
    }
    if(command.type=="read_servos"){
        command.motion.kind=MotionKind::Sense;command.motion.count=0;command.motion.hold_ms=0;
        return Hex(command.request,32)&&fields==std::set<std::string>{"type","boot_id","epoch","request_id"};
    }
    if(command.type=="camera_next")return Hex(command.request,32)&&
        Epoch(Field(json.get(),"offset"),command.boundary)&&
        fields==std::set<std::string>{"type","boot_id","epoch","request_id","offset"};
    if(command.type=="drain_output"||command.type=="interrupt_output")return Hex(command.request,32)&&
        Epoch(Field(json.get(),"next_sequence"),command.boundary)&&
        fields==std::set<std::string>{"type","boot_id","epoch","request_id","next_sequence"};
    return (command.type=="start"||command.type=="stop"||command.type=="capture_camera"||command.type=="cancel_move"||command.type=="cancel_ring")&&Hex(command.request,32)&&
        fields==std::set<std::string>{"type","boot_id","epoch","request_id"};
}
}
std::string AgentSession::Identity()const{return "\"boot_id\":\""+boot_+"\",\"epoch\":\""+std::to_string(life_.epoch())+"\"";}
bool AgentSession::Send(const std::string& text,uint64_t now){if(wire_.Text(text))return true;Disconnected(now);return false;}
void AgentSession::PublishBatteryState(uint64_t now) {
    if(!battery_||(battery_reported_at_&&now-battery_reported_at_<report_ms_[ReportBattery]))return;
    battery_reported_at_=now;
    int percent=0;
    bool charging=false,discharging=false;
    const bool valid=battery_(percent,charging,discharging)&&percent>=0&&percent<=100&&!(charging&&discharging);
    const char* direction=valid?(charging?"charging":discharging?"discharging":"idle"):"unknown";
    const auto value=valid?std::to_string(percent):"null";
    wire_.CameraText("{\"type\":\"battery_state\","+Identity()+",\"percent\":"+value+
                     ",\"direction\":\""+direction+"\"}");
}
void AgentSession::PublishHealthState() {
    diagnostics::HealthSample sample{};
    if(!health_||!health_(sample)||sample.sequence==health_sequence_)return;
    const auto number=[](uint32_t value,uint32_t unknown){return value==unknown?std::string("null"):std::to_string(value);};
    std::string task;
    for(int i=0;i<4;++i){
        const char c=static_cast<char>((sample.top_name>>(8*i))&0xff);
        if(!c)break;
        task+=(c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'?c:'?';
    }
    const std::string temperature=sample.chip_decicelsius==diagnostics::HealthNoTemperature?"null":std::to_string(sample.chip_decicelsius);
    const auto flag=[&](uint8_t bit){return (sample.flags&bit)?"true":"false";};
    const bool battery=(sample.flags&diagnostics::BatteryValid)&&sample.battery<=100;
    const std::string report="{\"type\":\"health_state\","+Identity()+",\"sequence\":"+std::to_string(sample.sequence)+
        ",\"uptime_ms\":"+std::to_string(sample.ms)+",\"chip_decicelsius\":"+temperature+
        ",\"busy_permille\":["+number(sample.busy0,diagnostics::HealthUnknown)+","+number(sample.busy1,diagnostics::HealthUnknown)+"]"+
        ",\"top_task\":\""+task+"\",\"top_permille\":"+number(sample.top_permille,diagnostics::HealthUnknown)+
        ",\"gap_ms\":["+std::to_string(sample.touch_gap_ms)+","+std::to_string(sample.lvgl_gap_ms)+","+std::to_string(sample.ui_gap_ms)+"]"+
        ",\"touch_errors\":"+std::to_string(sample.touch_errors)+
        ",\"battery\":"+(battery?std::to_string(sample.battery):std::string("null"))+
        ",\"charging\":"+flag(diagnostics::Charging)+",\"discharging\":"+flag(diagnostics::Discharging)+
        ",\"brightness\":"+number(sample.brightness,0xff)+",\"mouth_ticks\":"+std::to_string(sample.mouth_ticks)+"}";
    // Low priority like the other sensor reports; a full queue retries next tick.
    if(wire_.CameraText(report))health_sequence_=sample.sequence;
}
void AgentSession::PublishAmbientState(uint64_t now) {
    if (!ambient_ || (ambient_reported_at_ && now - ambient_reported_at_ < report_ms_[ReportAmbient])) return;
    ambient_reported_at_ = now;
    const auto reading = ambient_->Snapshot(life_.epoch(), now);
    const std::string light = reading.channel0 >= 0 && reading.channel1 >= 0
        ? "{\"channel0\":" + std::to_string(reading.channel0) + ",\"channel1\":" +
            std::to_string(reading.channel1) + "}" : "null";
    const auto proximity = reading.proximity >= 0 ? std::to_string(reading.proximity) : "null";
    wire_.CameraText("{\"type\":\"ambient_state\"," + Identity() +
                     ",\"light\":" + light + ",\"proximity_raw\":" + proximity + "}");
}
void AgentSession::PublishHeadTouchState(uint64_t now) {
    if (!head_touch_ || (head_touch_reported_at_ && now - head_touch_reported_at_ < report_ms_[ReportHeadTouch])) return;
    head_touch_reported_at_ = now;
    const auto reading = head_touch_->Snapshot(life_.epoch(), now);
    const std::string levels = reading.channel1 < 0 ? "null" :
        "[" + std::to_string(reading.channel1) + "," + std::to_string(reading.channel2) +
        "," + std::to_string(reading.channel3) + "]";
    wire_.CameraText("{\"type\":\"head_touch_state\"," + Identity() + ",\"levels\":" + levels + "}");
}
void AgentSession::PublishHeadTouchGesture(uint64_t now) {
    if (!head_touch_) return;
    const auto gesture = head_touch_->Inspect(life_.epoch(), [&](const HeadTouchGestures& observations) {
        return observations.Next(head_touch_sequence_, now);
    });
    if (!gesture.sequence) return;
    constexpr const char* kinds[] = {"tap", "hold", "toward_channel_1", "toward_channel_3"};
    const std::string report = "{\"type\":\"head_touch_gesture\"," + Identity() +
        ",\"sequence\":" + std::to_string(gesture.sequence) +
        ",\"kind\":\"" + kinds[static_cast<unsigned>(gesture.kind)] +
        "\",\"duration_ms\":" + std::to_string(gesture.duration_ms) +
        ",\"peak\":" + std::to_string(gesture.peak) +
        ",\"age_ms\":" + std::to_string(now - gesture.completed_at) + "}";
    if (wire_.CameraText(report)) head_touch_sequence_ = gesture.sequence;
}
void AgentSession::DisplayResult(const std::string& request,const char* code,uint64_t now){
    Send("{\"type\":\"display_result\",\"request_id\":\""+request+"\","+Identity()+",\"code\":\""+code+"\"}",now);
}
// An unfinished frame upload leaves its slot empty; a picture upload just stops.
void AgentSession::AbandonUpload(){
    if(image_slot_>=0)frames_.Drop(image_slot_);
    image_request_.clear();image_slot_=-1;
}
void AgentSession::HandleFrame(const FrameRequest& d,uint64_t now){
    const auto& command=d;
    if(command.type=="frame_begin"){
        AbandonUpload();
        ForgetShownFrame(d.slot);
        const auto begun=frames_.Begin(d.slot,d.w,d.h,d.x,d.y,d.tag);
        if(begun==FrameBegin::Ready){
            image_request_=command.request;image_slot_=d.slot;
            image_bytes_=uint32_t(d.w)*d.h*2;image_received_=0;
        }
        DisplayResult(command.request,begun==FrameBegin::Ready?"ready":begun==FrameBegin::NoRoom?"no-room":"invalid",now);
    }else if(command.type=="frame_show"){
        const Frame* frame=d.slot==image_slot_?nullptr:frames_.Get(d.slot);
        if(!frame){DisplayResult(command.request,"no-frame",now);return;}
        const bool ok=display_->ShowFrame(frame->pixels.get(),frame->w,frame->h,frame->x,frame->y,d.ms,now);
        if(ok)shown_frame_=d.slot;
        DisplayResult(command.request,ok?"shown":"unavailable",now);
    }else if(command.type=="frame_drop"){
        if(d.slot==kFrameSlots||d.slot==image_slot_)AbandonUpload();
        ForgetShownFrame(d.slot);
        if(d.slot==kFrameSlots)frames_.DropAll();else frames_.Drop(d.slot);
        DisplayResult(command.request,"dropped",now);
    }else{
        std::string list;
        for(int slot=0;slot<kFrameSlots;++slot){
            const Frame* f=frames_.Get(slot);
            if(!f)continue;
            if(!list.empty())list+=",";
            list+="{\"slot\":"+std::to_string(slot)+",\"width\":"+std::to_string(f->w)+",\"height\":"+std::to_string(f->h)+
                ",\"x\":"+std::to_string(f->x)+",\"y\":"+std::to_string(f->y)+",\"tag\":\""+f->tag+"\"}";
        }
        Send("{\"type\":\"frame_list\",\"request_id\":\""+command.request+"\","+Identity()+",\"used\":"+std::to_string(frames_.used())+
            ",\"budget\":"+std::to_string(frames_.budget())+",\"frames\":["+list+"]}",now);
    }
}
void AgentSession::PumpInfrared(uint64_t now) {
    if(!ir_)return;
    const int sent=ir_->TakeSendResult();
    if(sent>=0&&!ir_request_.empty()){
        Send("{\"type\":\"ir_result\",\"request_id\":\""+ir_request_+"\","+Identity()+",\"code\":\""+(sent==0?"sent":"failed")+"\"}",now);
        ir_request_.clear();
    }
    IrCode code;
    for(unsigned i=0;i<4&&ir_->Take(code);++i)
        wire_.CameraText("{\"type\":\"ir_received\","+Identity()+",\"address\":"+std::to_string(code.address)+
            ",\"command\":"+std::to_string(code.command)+",\"repeat\":"+(code.repeat?"true":"false")+
            ",\"age_ms\":"+std::to_string(now>=code.at?std::min<uint64_t>(now-code.at,60000):0)+"}");
}
namespace {
std::string HexOf(const uint8_t* bytes,size_t n){
    static constexpr char digits[]="0123456789abcdef";
    std::string out;
    for(size_t i=0;i<n;++i){out+=digits[bytes[i]>>4];out+=digits[bytes[i]&15];}
    return out;
}
std::string CardFields(const NfcCard& card){
    return ",\"uid\":\""+HexOf(card.uid,std::min<size_t>(card.uid_size,sizeof card.uid))+"\",\"atqa\":"+std::to_string(card.atqa)+
        ",\"sak\":"+std::to_string(card.sak)+",\"version\":\""+(card.has_version?HexOf(card.version,8):std::string())+"\"";
}
}
// Poll stage counts since the reader was enabled for this conversation (raw facts).
static std::string NfcStatsField(const NfcPollStats& s){
    return ",\"stats\":{\"polls\":"+std::to_string(s.polls)+",\"field_failed\":"+std::to_string(s.field_failed)+
        ",\"silent\":"+std::to_string(s.silent)+",\"partial\":"+std::to_string(s.partial)+
        ",\"anticollision_failed\":"+std::to_string(s.anticollision_failed)+",\"select_failed\":"+std::to_string(s.select_failed)+
        ",\"selected\":"+std::to_string(s.selected)+",\"version_failed\":"+std::to_string(s.version_failed)+
        ",\"read_failed\":"+std::to_string(s.read_failed)+",\"collisions\":"+std::to_string(s.collisions)+
        ",\"error_irq\":"+std::to_string(s.error_irq)+"}";
}
void AgentSession::PumpNfc(uint64_t now) {
    if(!nfc_offered_)return;
    NfcRead read;NfcCard card;
    if(!nfc_request_.empty()&&nfc_->TakeRead(read,card)){
        static constexpr const char* codes[]={"failed","read","no-card","unsupported","failed"};
        const bool ok=read.code==NfcRead::Code::Read;
        Send("{\"type\":\"nfc_data\",\"request_id\":\""+nfc_request_+"\","+Identity()+",\"code\":\""+codes[static_cast<unsigned>(read.code)]+"\""+
             CardFields(card)+",\"page\":"+std::to_string(read.page)+",\"count\":"+std::to_string(read.count)+
             ",\"data_hex\":\""+(ok?HexOf(read.data,size_t(read.count)*4):std::string())+"\""+NfcStatsField(nfc_->Stats())+"}",now);
        nfc_request_.clear();
    }
    NfcEvent event;
    // A card arriving or leaving; a refused report is dropped like the other sensor facts.
    for(unsigned i=0;i<4&&nfc_->Take(event);++i)
        wire_.CameraText("{\"type\":\"nfc_card\","+Identity()+",\"phase\":\""+(event.present?"present":"removed")+"\""+
            CardFields(event.card)+",\"age_ms\":"+std::to_string(now>=event.at?std::min<uint64_t>(now-event.at,60000):0)+"}");
}
void AgentSession::PublishPowerState(uint64_t now) {
    if(!power_||(power_reported_at_&&now-power_reported_at_<report_ms_[ReportPower]))return;
    power_reported_at_=now;
    const auto sample=power_->Latest(now);
    // Raw INA226 registers: bus voltage x1.25 mV, shunt x2.5 uV (x0.25 mA over 0.01 ohm).
    wire_.CameraText("{\"type\":\"power_state\","+Identity()+(sample.valid?
        ",\"bus_raw\":"+std::to_string(sample.bus_raw)+",\"shunt_raw\":"+std::to_string(sample.shunt_raw):
        std::string(",\"bus_raw\":null,\"shunt_raw\":null"))+"}");
}
void AgentSession::PublishScreenTouch(uint64_t now) {
    if(!screen_touch_)return;
    static constexpr const char* phases[]={"down","move","up"};
    ScreenTouchEvent event;
    // A few per tick; a refused report is dropped like the other sensor facts.
    for(unsigned i=0;i<4&&screen_touch_->Take(event);++i)
        wire_.CameraText("{\"type\":\"screen_touch\","+Identity()+",\"phase\":\""+phases[event.phase]+
            "\",\"x\":"+std::to_string(event.x)+",\"y\":"+std::to_string(event.y)+
            ",\"age_ms\":"+std::to_string(now>=event.at?std::min<uint64_t>(now-event.at,60000):0)+"}");
}
void AgentSession::PublishImuState(uint64_t now) {
    if (!imu_ || (imu_reported_at_ && now - imu_reported_at_ < report_ms_[ReportImu])) return;
    imu_reported_at_ = now;
    const auto reading = imu_->Snapshot(life_.epoch(), now);
    std::string axes = "null";
    if (reading.valid) {
        axes = "[";
        for (size_t i = 0; i < reading.axes.size(); ++i) {
            if (i) axes += ',';
            axes += std::to_string(reading.axes[i]);
        }
        axes += ']';
    }
    std::string mag = "null";
    if (reading.valid && reading.mag_valid)
        mag = "[" + std::to_string(reading.mag[0]) + "," + std::to_string(reading.mag[1]) + "," + std::to_string(reading.mag[2]) + "]";
    wire_.CameraText("{\"type\":\"imu_state\"," + Identity() + ",\"axes\":" + axes + ",\"mag\":" + mag + "}");
}
void AgentSession::PublishCameraState(uint64_t now){
    if(!attached()||!camera_.supported()||(mode_!=Mode::Idle&&mode_!=Mode::Active))return;
    const auto view=camera_.View();
    const std::string report="{\"type\":\"camera_state\","+Identity()+",\"permission\":\""+
        (view.allowed?"allowed":"disabled")+"\",\"phase\":\""+view.phase+"\",\"busy\":"+
        (view.busy?"true":"false")+",\"error\":\""+view.error+"\"}";
    if(report==camera_report_&&now>=camera_reported_at_&&now-camera_reported_at_<2000)return;
    // Latest state only; low-priority queue refusal never closes audio.
    if(wire_.CameraText(report)){camera_report_=report;camera_reported_at_=now;}
}
void AgentSession::ResetRing(){
    if(ring_&&!ring_request_.empty())ring_->Cancel(life_.epoch());
    ring_request_.clear();
    last_ring_request_.clear();
    ring_report_.clear();
    voice_indicator_=RingIndicator::Off;
}
bool AgentSession::SendRingResult(const std::string& request,RingResult result,uint64_t now){
    return Send("{\"type\":\"ring_result\",\"request_id\":\""+request+"\","+Identity()+
        ",\"code\":\""+RingResultName(result)+"\"}",now);
}
void AgentSession::PumpRing(uint64_t now){
    if(!ring_||(mode_!=Mode::Idle&&mode_!=Mode::Active))return;
    if(!ring_request_.empty()){
        const auto result=ring_->Take(life_.epoch());
        if(result!=RingResult::None){
            last_ring_request_=std::move(ring_request_);
            ring_request_.clear();
            if(!SendRingResult(last_ring_request_,result,now))return;
        }
    }
    const auto state=ring_->status();
    const std::string report="{\"type\":\"ring_state\","+Identity()+",\"permission\":\""+
        (state.allowed?"allowed":"disabled")+"\",\"phase\":\""+RingPhaseName(state.phase)+
        "\",\"error\":\""+RingResultName(state.error)+"\"}";
    if(report==ring_report_&&now>=ring_reported_at_&&now-ring_reported_at_<2000)return;
    if(wire_.CameraText(report)){ring_report_=report;ring_reported_at_=now;}
}
void AgentSession::ResetMotion(){
    if(motion_&&!motion_request_.empty())motion_->Cancel(life_.epoch(),motion_ticket_);
    motion_request_.clear();last_motion_request_.clear();motion_report_.clear();
}
bool AgentSession::SendMotionResult(const std::string& request,const char* code,uint64_t now,const MotionFeedback* observed,bool holding){
    std::string report="{\"type\":\"motion_result\",\"request_id\":\""+request+"\","+Identity()+",\"code\":\""+code+"\"";
    if(observed)report+=",\"yaw\":"+std::to_string(observed->yaw)+",\"pitch\":"+std::to_string(observed->pitch);
    if(holding)report+=",\"holding\":true";
    return Send(report+"}",now);
}
namespace {
std::string AxisJson(const ServoAxisState& a){
    return "{\"angle\":"+std::to_string(a.angle)+",\"position\":"+std::to_string(a.position)+
        ",\"speed\":"+std::to_string(a.speed)+",\"load\":"+std::to_string(a.load)+
        ",\"voltage\":"+std::to_string(a.voltage)+",\"temperature\":"+std::to_string(a.temperature)+
        ",\"current\":"+std::to_string(a.current)+",\"moving\":"+(a.moving?"true":"false")+
        ",\"torque\":"+(a.torque?"true":"false")+",\"in_range\":"+(a.in_range?"true":"false")+"}";
}
}
bool AgentSession::SendServoState(const std::string& request,const MotionSense& sense,bool holding,uint64_t now){
    return Send("{\"type\":\"servo_state\",\"request_id\":\""+request+"\","+Identity()+
        ",\"holding\":"+(holding?"true":"false")+",\"yaw\":"+AxisJson(sense.yaw)+",\"pitch\":"+AxisJson(sense.pitch)+"}",now);
}
void AgentSession::FinishMotion(uint64_t now){
    if(motion_request_.empty())return;
    const auto status=motion_->status();
    if(!status.allowed)motion_cancelled_=true;
    const char* code=nullptr;
    MotionOutcome outcome;
    const MotionFeedback* observed=nullptr;
    if(status.phase==MotionPhase::Fault)code=MotionErrorName(status.error);
    else if(motion_->Take(life_.epoch(),motion_ticket_,outcome)){
        code=outcome.error==MotionError::None?"reached":MotionErrorName(outcome.error);
        if(outcome.observed)observed=&outcome.feedback;
    }else if(motion_cancelled_&&status.phase==MotionPhase::Idle)code="cancelled";
    if(!code)return;
    last_motion_request_=std::move(motion_request_);
    motion_request_.clear();
    if(outcome.sensed&&outcome.error==MotionError::None){SendServoState(last_motion_request_,outcome.sense,outcome.holding,now);return;}
    SendMotionResult(last_motion_request_,code,now,observed,outcome.holding);
}
void AgentSession::PublishMotionState(uint64_t now){
    if(!motion_||(mode_!=Mode::Idle&&mode_!=Mode::Active))return;
    const auto status=motion_->status();
    const std::string report="{\"type\":\"motion_state\","+Identity()+",\"permission\":\""+
        (status.allowed?"allowed":"disabled")+"\",\"phase\":\""+MotionPhaseName(status.phase)+
        "\",\"error\":\""+MotionErrorName(status.error)+"\"}";
    if(report==motion_report_&&now>=motion_reported_at_&&now-motion_reported_at_<2000)return;
    // Share the existing bounded optional telemetry queue with camera.
    if(wire_.CameraText(report)){motion_report_=report;motion_reported_at_=now;}
}
bool AgentSession::AttachAuthenticated(const std::string& device,const std::string& pair,const std::string& boot,uint64_t now,bool captions,bool standby){
    const auto status=maintenance_.Snapshot(now);
    if(attached()||!Hex(device,12)||!Hex(pair,32)||!Hex(boot,32)||status.device_id!=device||status.reserved()||
       status.pairing.state!=PairingState::Paired||status.pairing.id!=pair||life_.phase()!=Phase::Idle||
       audio_.status().phase!=AudioPhase::Idle)return false;
    boot_=boot;pair_=pair;request_.clear();playback_request_.clear();camera_report_.clear();mode_=Mode::Idle;
    captions_requested_=captions;captions_.Clear();
    standby_=standby;attention_at_=0;attention_pending_=0;
    nfc_offered_=nfc_&&nfc_->Ready();
    return Send(std::string("{\"type\":\"hello\",\"protocol\":1,\"playback_fence\":1,")+(camera_.supported()?"\"camera\":1,\"camera_status\":1,":"")+(motion_?"\"motion\":1,\"motion_frames\":1,\"setpoint\":1,":"")+(ring_?"\"ring\":1,\"ring_frames\":1,\"voice_indicator\":1,":"")+(expression_?"\"expression\":1,":"")+(captions?"\"caption\":2,":"")+(battery_?"\"battery\":1,":"")+(ambient_?"\"ambient\":1,":"")+(head_touch_?"\"head_touch\":2,":"")+(imu_?"\"imu\":1,":"")+(screen_touch_?"\"screen_touch\":1,\"report_rate\":1,":"\"report_rate\":1,")+(power_?"\"power\":1,":"")+(volume_?"\"volume\":1,":"")+(ir_?"\"infrared\":1,":"")+(nfc_offered_?"\"nfc\":1,":"")+(display_?"\"display\":2,\"frames\":2,":"")+(health_?"\"health\":1,":"")+(standby_?"\"standby\":2,":"")+"\"device_id\":\""+device+"\",\"pair_id\":\""+pair+
        "\",\"phase\":\"idle\","+Identity()+"}",now);
}
bool AgentSession::SendAttention(bool sleep){
    return wire_.CameraText("{\"type\":\"attention\","+Identity()+(sleep?",\"intent\":\"sleep\"}":"}"));
}
bool AgentSession::Attention(uint64_t now,bool sleep){
    // Low-priority like sensor reports; at most a few taps per second reach the Host.
    if(mode_!=Mode::Active||(!sleep&&attention_at_&&now-attention_at_<300))return false;
    attention_at_=now;
    // v66: with the microphone streaming the shared queue was often full and a
    // tap or Stop was silently lost. Hold it and retry from Tick instead.
    if(SendAttention(sleep)){attention_pending_=0;return true;}
    attention_pending_=sleep?2:attention_pending_==2?2:1;
    attention_pending_at_=now;
    return true;
}
void AgentSession::Disconnected(uint64_t now){
    if(!attached())return;
    attention_pending_=0;
    captions_.Clear();
    if(expression_){expression_->ResetExpression();}if(display_){display_->ClearDisplay();}
    ir_request_.clear();AbandonUpload();shown_frame_=-1;
    if(nfc_offered_)nfc_->Enable(false);
    nfc_offered_=false;nfc_request_.clear();
    if(display_)display_->ClearDisplay();
    ResetRing();ResetMotion();camera_.Reset();mode_=Mode::Detached;request_.clear();playback_request_.clear();life_.Disconnected(life_.epoch(),now);wire_.Close();
}
void AgentSession::LocalStop(bool home,uint64_t now){
    if(home)life_.Home(now);else life_.Stop(now);
    if(attached())Send("{\"type\":\"ended\","+Identity()+",\"reason\":\""+(home?"home":"stop")+"\"}",now);
    Disconnected(now);
}
void AgentSession::Text(const std::string& text,uint64_t now){
    if(!attached())return;
    Command command;
    if(!Parse(text,command)||command.boot!=boot_){Disconnected(now);return;}
    if(command.type=="voice_indicator") {
        if(command.epoch<life_.epoch())return;
        if(!ring_||mode_!=Mode::Active||!life_.Accept(command.epoch,now)){Disconnected(now);return;}
        voice_indicator_=command.indicator;
        if(voice_indicator_==RingIndicator::Off)ring_->Indicate(life_.epoch(),RingIndicator::Off);
        return;
    }
    if(command.type=="caption"){
        if(command.epoch<life_.epoch())return;
        if(command.epoch!=life_.epoch()||!captions_requested_||mode_!=Mode::Active||!life_.Accept(command.epoch,now)){
            Disconnected(now);return;
        }
        captions_.Add(command.speaker,std::move(command.caption));
        return;
    }
    if(command.epoch!=life_.epoch()){Disconnected(now);return;}
    if(command.type=="start"){
        const auto status=maintenance_.Snapshot(now);
        if(mode_!=Mode::Idle||status.reserved()||status.pairing.state!=PairingState::Paired||status.pairing.id!=pair_||
           life_.epoch()>std::numeric_limits<uint64_t>::max()-2||!life_.Begin(now)) {Disconnected(now);return;}
        mode_=Mode::Starting;request_=command.request;
        if(!audio_.Begin(life_.epoch()))Disconnected(now);
    }else if(command.type=="set_expression"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!expression_){Disconnected(now);return;}
        const bool applied=expression_->SetExpression(command.expression);
        Send("{\"type\":\"expression_result\",\"request_id\":\""+command.request+"\","+Identity()+
             ",\"expression\":\""+command.expression+"\",\"status\":\""+(applied?"applied":"unavailable")+"\"}",now);
    }else if(command.type=="set_ring"||command.type=="set_ring_frames"||command.type=="cancel_ring"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!ring_){Disconnected(now);return;}
        if(command.type=="cancel_ring"){
            if(command.request==ring_request_)ring_->Cancel(command.epoch);
            return;
        }
        if(command.request==ring_request_||command.request==last_ring_request_)return;
        const auto result=ring_request_.empty()?ring_->Begin(command.epoch,command.ring):RingResult::Busy;
        if(result==RingResult::None)ring_request_=command.request;
        else SendRingResult(command.request,result,now);
    }else if(command.type=="move_head"||command.type=="cancel_move"||command.type=="move_frames"||
             command.type=="set_torque"||command.type=="read_servos"||command.type=="rotate_yaw"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!motion_){Disconnected(now);return;}
        if(command.type=="cancel_move"){
            if(command.request==motion_request_){
                motion_cancelled_=true;
                motion_->Cancel(command.epoch,motion_ticket_);
            }
            return;
        }
        if(command.request==motion_request_||command.request==last_motion_request_)return;
        const auto status=motion_->status();
        const MotionRequest request=command.type=="move_head"?SingleMove(command.target):command.motion;
        const bool ready=status.phase==MotionPhase::Idle||status.phase==MotionPhase::Holding;
        const char* rejection=!ValidMotionRequest(request)?"invalid":
            !status.allowed?"disabled":status.phase==MotionPhase::Fault?"release-unconfirmed":
            !motion_request_.empty()||!ready?"busy":nullptr;
        if(!rejection){
            motion_ticket_=motion_->BeginRequest(command.epoch,request,now);
            if(motion_ticket_){motion_request_=command.request;motion_cancelled_=false;return;}
            rejection="unavailable";
        }
        SendMotionResult(command.request,rejection,now);
    }else if(command.type=="show_text"||command.type=="image_begin"||command.type=="image_chunk"||
             command.type=="image_end"||command.type=="clear_display"||command.type=="frame_begin"||
             command.type=="frame_show"||command.type=="frame_drop"||command.type=="frame_list"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!display_){Disconnected(now);return;}
        if(command.type.rfind("frame_",0)==0){
            const auto& d=command.display;
            HandleFrame({command.type,command.request,d.tag,d.slot,d.w,d.h,d.x,d.y,d.ms},now);return;
        }
        if(command.type=="show_text"){
            AbandonUpload();shown_frame_=-1;
            DisplayResult(command.request,display_->ShowText(command.caption,command.display.area,command.display.ms,now)?"shown":"unavailable",now);
        }else if(command.type=="clear_display"){
            AbandonUpload();display_->ClearDisplay();shown_frame_=-1;DisplayResult(command.request,"cleared",now);
        }else if(command.type=="image_begin"){
            const auto& d=command.display;
            AbandonUpload();
            const bool ok=display_->BeginImage(d.w,d.h,d.x,d.y,d.ms);
            if(ok)shown_frame_=-1;   // BeginImage cleared the screen.
            image_request_=ok?command.request:std::string();image_slot_=-1;
            image_bytes_=uint32_t(d.w)*d.h*2;image_received_=0;
            DisplayResult(command.request,ok?"ready":"unavailable",now);
        }else if(command.request!=image_request_){
            DisplayResult(command.request,"no-image",now);
        }else if(command.type=="image_chunk"){
            // In order and inside the image; anything else ends this image.
            const auto& d=command.display;
            const auto* bytes=reinterpret_cast<const uint8_t*>(d.bytes.data());
            if(d.offset!=image_received_||d.offset+d.bytes.size()>image_bytes_||
               !(image_slot_>=0?frames_.Write(image_slot_,d.offset,bytes,d.bytes.size()):display_->ImageData(d.offset,bytes,d.bytes.size()))){
                AbandonUpload();DisplayResult(command.request,"bad-chunk",now);return;
            }
            image_received_+=uint32_t(d.bytes.size());
            // Flow control: the Mac keeps only a few chunks unacknowledged, so a picture
            // cannot fill the 24-message receive queue (a full queue closes the link).
            Send("{\"type\":\"image_ack\",\"request_id\":\""+command.request+"\","+Identity()+",\"received\":"+std::to_string(image_received_)+"}",now);
        }else if(image_slot_>=0){
            const bool ok=frames_.Finish(image_slot_,image_received_);
            image_request_.clear();image_slot_=-1;
            DisplayResult(command.request,ok?"stored":"incomplete",now);
        }else{
            const bool ok=image_received_==image_bytes_&&display_->ShowImage(now);
            image_request_.clear();
            DisplayResult(command.request,ok?"shown":"incomplete",now);
        }
    }else if(command.type=="servo_setpoint"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!motion_){Disconnected(now);return;}
        if(!motion_->Setpoint(command.epoch,command.target)) {
            const auto status=motion_->status();
            const char* reason=!ValidSetpoint(command.target)?"invalid":!status.allowed?"disabled":
                status.phase!=MotionPhase::Holding?"not-holding":"limp";
            wire_.CameraText("{\"type\":\"setpoint_rejected\","+Identity()+",\"reason\":\""+reason+"\"}");
        }
    }else if(command.type=="ir_send"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!ir_){Disconnected(now);return;}
        const auto reply=[&](const char* code){Send("{\"type\":\"ir_result\",\"request_id\":\""+command.request+"\","+Identity()+",\"code\":\""+code+"\"}",now);};
        if(!ir_request_.empty()){reply("busy");return;}
        const uint32_t v=command.interval_ms;
        if(!ir_->Queue(uint16_t(v&0xffff),uint8_t((v>>16)&0xff),uint8_t(v>>24))){reply("busy");return;}
        ir_request_=command.request;
    }else if(command.type=="nfc_read"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!nfc_offered_){Disconnected(now);return;}
        const uint8_t page=uint8_t(command.interval_ms>>8),count=uint8_t(command.interval_ms&0xff);
        if(!nfc_request_.empty()||!nfc_->RequestRead(page,count)){
            Send("{\"type\":\"nfc_data\",\"request_id\":\""+command.request+"\","+Identity()+",\"code\":\"busy\""+CardFields(NfcCard{})+
                 ",\"page\":"+std::to_string(page)+",\"count\":"+std::to_string(count)+",\"data_hex\":\"\"}",now);
            return;
        }
        nfc_request_=command.request;
    }else if(command.type=="set_volume"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!volume_){Disconnected(now);return;}
        const bool applied=volume_(int(command.interval_ms));
        Send("{\"type\":\"volume_result\",\"request_id\":\""+command.request+"\","+Identity()+
             ",\"volume\":"+std::to_string(command.interval_ms)+",\"applied\":"+(applied?"true":"false")+"}",now);
    }else if(command.type=="set_report_rate"){
        // How often a sensor's raw state is sent, for this session only.
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)){Disconnected(now);return;}
        report_ms_[command.report]=command.interval_ms;
        Send("{\"type\":\"report_rate\",\"request_id\":\""+command.request+"\","+Identity()+
             ",\"sensor\":\""+kReportNames[command.report]+"\",\"interval_ms\":"+std::to_string(command.interval_ms)+"}",now);
    }else if(command.type=="capture_camera"||command.type=="camera_next"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!camera_.supported()||
           !(command.type=="capture_camera"?camera_.Begin(command.request,command.epoch,now):camera_.Next(command.request,command.boundary)))Disconnected(now);
    }else if(command.type=="renew"){
        if(mode_!=Mode::Active||!life_.Renew(command.epoch,now)){Disconnected(now);return;}
        Send("{\"type\":\"renewed\","+Identity()+"}",now);
    }else if(command.type=="drain_output"||command.type=="interrupt_output"){
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)||!playback_request_.empty()||
           command.boundary!=audio_.status().output_received||
           !audio_.RequestPlaybackFence(command.epoch,command.type=="interrupt_output")){Disconnected(now);return;}
        playback_request_=command.request;playback_boundary_=command.boundary;
        playback_discard_=command.type=="interrupt_output";
    }else{
        if(mode_!=Mode::Active||!life_.Accept(command.epoch,now)){Disconnected(now);return;}
        if(expression_){expression_->ResetExpression();}if(display_){display_->ClearDisplay();}
        shown_frame_=-1;
        captions_.Clear();
        if(nfc_offered_)nfc_->Enable(false);   // The RF field pulses only during a conversation.
        nfc_request_.clear();
        ResetRing();ResetMotion();camera_.Reset();playback_request_.clear();request_=command.request;mode_=Mode::Stopping;life_.Stop(now);
    }
}
void AgentSession::Binary(const uint8_t* bytes,size_t size,uint64_t now){
    if(!attached())return;
    OutputFrame frame;
    if(!wire::DecodeOutput(bytes,size,frame)){Disconnected(now);return;}
    if(mode_==Mode::Stopping&&life_.epoch()>0&&frame.epoch==life_.epoch()-1)return;
    if(mode_!=Mode::Active||!playback_request_.empty()||!life_.Accept(frame.epoch,now)||audio_.Push(frame)!=AudioPush::Accepted)Disconnected(now);
}
void AgentSession::Tick(uint64_t now){
    life_.Tick(now); // Single application owner; also drains after disconnect.
    if(!attached())return;
    const auto phase=life_.phase();const auto audio=audio_.status();
    if(mode_==Mode::Stopping){
        if(phase==Phase::Idle){
            mode_=Mode::Idle;Send("{\"type\":\"stopped\",\"request_id\":\""+request_+"\","+Identity()+",\"resources_stopped\":true}",now);
            request_.clear();PublishCameraState(now);PublishMotionState(now);
        }else if(phase!=Phase::Draining)Disconnected(now);
        return;
    }
    if(mode_==Mode::Idle){if(phase!=Phase::Idle)Disconnected(now);else {PublishCameraState(now);PublishMotionState(now);PumpRing(now);}return;}
    if((mode_==Mode::Starting&&phase!=Phase::Connecting)||(mode_==Mode::Active&&phase!=Phase::Active)){
        Disconnected(now);return;
    }
    if(audio.error!=AudioError::None||audio.epoch!=life_.epoch()||phase==Phase::Draining||phase==Phase::Fault||
       phase==Phase::Home||phase==Phase::Returning){Disconnected(now);return;}
    if(mode_==Mode::Starting){
        if(audio.phase==AudioPhase::Running){
            if(!life_.Connected(life_.epoch(),now)){Disconnected(now);return;}
            mode_=Mode::Active;acknowledged_=0;
            for(unsigned i=0;i<ReportKinds;++i)report_ms_[i]=kReportDefaultMs[i]; // Each session starts at the defaults.
            battery_reported_at_=0;
            power_reported_at_=0;
            ambient_reported_at_=0;
            if(!Send("{\"type\":\"started\",\"request_id\":\""+request_+"\","+Identity()+"}",now))return;
            if(ambient_)ambient_->Begin(life_.epoch());
            head_touch_reported_at_=0;
            head_touch_sequence_=0;
            health_sequence_=0; // A new conversation gets the latest sample at once.
            if(head_touch_)head_touch_->Begin(life_.epoch());
            imu_reported_at_=0;
            if(imu_)imu_->Begin(life_.epoch());
            if(screen_touch_)screen_touch_->Clear();   // Only touches from this session on.
            if(nfc_offered_)nfc_->Enable(true);         // A card already on the reader is reported again.
            request_.clear();
        }else return;
    }
    if(mode_!=Mode::Active||audio.phase!=AudioPhase::Running||!life_.Accept(life_.epoch(),now)){Disconnected(now);return;}
    // Return playback credit only after driver acceptance, not on queue insertion.
    // This bounds a fast producer to the device window. It is not acoustic completion.
    while((playback_request_.empty()||!playback_discard_)&&acknowledged_<audio.output_written){
        if(!Send("{\"type\":\"output\","+Identity()+",\"sequence\":\""+std::to_string(acknowledged_++)+"\"}",now))return;
    }
    if(!playback_request_.empty()){
        const auto result=audio_.PlaybackFenceStatus(life_.epoch());
        if(result==Result::Failed){Disconnected(now);return;}
        // Audio worker may finish after our earlier status snapshot. Natural
        // drain cannot overtake outstanding Write credits from that snapshot.
        if(result==Result::Done&&(playback_discard_||acknowledged_==playback_boundary_)){
            const std::string reply="{\"type\":\""+std::string(playback_discard_?"output_interrupted":"output_drained")+
                "\",\"request_id\":\""+playback_request_+"\","+Identity()+
                ",\"next_sequence\":\""+std::to_string(playback_boundary_)+"\"}";
            // Retire discarded credits without issuing false Write acknowledgments.
            acknowledged_=playback_boundary_;playback_request_.clear();
            if(!Send(reply,now))return;
        }
    }
    // A held attention request goes ahead of capture frames so it finds room.
    if(attention_pending_){
        if(now-attention_pending_at_>1500)attention_pending_=0;
        else if(SendAttention(attention_pending_==2))attention_pending_=0;
    }
    // A slow link costs capture frames, never the session: the Host resumes
    // from the sequence gap. Control, playback receipts and Stop keep flowing.
    const bool congested=wire_.Congested();
    for(unsigned budget=0;budget<4;++budget){
        InputFrame input;if(!audio_.TakeInput(life_.epoch(),input))break;
        if(congested){++capture_skipped_;continue;}
        const auto bytes=wire::EncodeInput(input);
        if(!wire_.Binary(bytes.data(),bytes.size())){Disconnected(now);return;}
    }
    camera_.Pump(now,Identity(),[this](const std::string& text){return wire_.CameraText(text);});
    PublishCameraState(now);
    FinishMotion(now);
    PublishMotionState(now);
    if(ring_&&audio.capture_allowed&&voice_indicator_!=RingIndicator::Off) {
        const bool speaking=audio.output_written&&audio.requested_volume>0&&audio.applied_volume>0&&
            now>=audio.output_at_ms&&now-audio.output_at_ms<140;
        ring_->Indicate(life_.epoch(),speaking?RingIndicator::Speaking:voice_indicator_,audio.output_level,audio.input_level);
    }
    PumpRing(now);
    if(mode_==Mode::Active){PublishHealthState();PublishBatteryState(now);PublishAmbientState(now);PublishHeadTouchState(now);PublishHeadTouchGesture(now);PublishImuState(now);PublishScreenTouch(now);PublishPowerState(now);PumpInfrared(now);PumpNfc(now);}
}
}
