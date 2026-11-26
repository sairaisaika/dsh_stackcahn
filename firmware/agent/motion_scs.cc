// SPDX-License-Identifier: MIT
#include "motion_scs.h"
#include <algorithm>
#include <cstdlib>

namespace sion::agent {
namespace {
// Pinned FTServo SCSCL register addresses. No EEPROM writes or mode switching.
// 6..8 (baud, return delay, response level) are only read, for diagnosis.
// Yaw wheel mode (owner-approved, same method as the stock SCSCL::SwitchMode):
// angle limits 9..12 set to 0 and the duty written to 44; the limits read at
// Open are written back and verified when turning stops.
constexpr int kInfo=6,kMin=9,kMax=11,kTorque=40,kGoal=42,kPwm=44,kFeedback=56,kFeedbackBytes=15;
int Word(const unsigned char* p){return (int(p[0])<<8)|p[1];}
int SignedMagnitude(int value,int bit){return (value&(1<<bit))?-(value&~(1<<bit)):value;}
void Put(unsigned char* p,int v){p[0]=static_cast<unsigned char>(v>>8);p[1]=static_cast<unsigned char>(v);}
}
bool ScsMotionPort::Ok(int count,int expected) const {
    return count==expected&&bus_.getState()==0&&bus_.getLastError()==0&&link_.Healthy();
}
bool ScsMotionPort::ReadWord(int id,int address,int& value) {
    unsigned char bytes[2]{};
    if(!Ok(bus_.Read(id,address,bytes,2),2))return false;
    value=Word(bytes);return true;
}
bool ScsMotionPort::DisableBoth() {
    bool disabled=true;
    for(int id=1;id<=2;++id) {
        // Do not short circuit the second axis or skip its readback on ACK loss.
        const int write_count=bus_.writeByte(id,kTorque,0);
        const uint32_t write_status=bus_.getState(),write_error=bus_.getLastError()!=0;
        const bool written=Ok(write_count);
        unsigned char torque=255;
        const int read_count=bus_.Read(id,kTorque,&torque,1);
        const uint32_t read_status=bus_.getState(),read_error=bus_.getLastError()!=0;
        const bool read=Ok(read_count,1);
        const auto clamp=[](int count){return uint32_t(count<0?3:count>2?2:count);};
        silent_[id-1]=write_count<=0&&read_count<=0;
        torque_probe_[id-1]=(uint32_t(link_.Healthy())<<30)|(clamp(write_count)<<28)|(clamp(read_count)<<26)|
            (write_error<<25)|(read_error<<24)|((write_status&0xff)<<16)|((read_status&0xff)<<8)|torque;
        // v67: the yaw servo answered reads but never acknowledged writes, while
        // the stock firmware ignores write acknowledgements. The register read
        // back is the authority; the acknowledgement is only recorded.
        write_acked_[id-1]=written;
        axis_off_[id-1]=read&&torque==0;
        if(read&&torque==0)torque_on_[id-1]=false;
        disabled=axis_off_[id-1]&&disabled;
    }
    return disabled;
}
bool ScsMotionPort::Open() {
    const auto fail=[&](uint8_t step){open_failure_=step;return false;};
    // A rejected repeat Open must not disturb an already open port.
    if(owns_link_||bus_.End!=1||bus_.Level!=1)return fail(1);
    open_failure_=0;min_[0]=min_[1]=max_[0]=max_[1]=-1;
    drives_disabled_=false;
    owns_link_=true;
    if(!link_.Open(zero_[0],zero_[1]))return fail(2);
    ready_link_=true;
    for(int z:zero_)if(z<0||z>1000)return fail(3);
    // Power was switched on just before this. A servo that is still booting
    // stays silent; one that answers with anything else is never retried.
    // Torque-off is the only packet repeated, and it is safe to repeat.
    open_attempts_=0;open_waited_ms_=0;
    for(;;) {
        ++open_attempts_;
        if(DisableBoth())break;
        // Retry only while some axis is wholly silent and every axis that did
        // answer confirmed torque off (the two servos may boot at different times).
        const bool waiting=(silent_[0]||silent_[1])&&(silent_[0]||axis_off_[0])&&(silent_[1]||axis_off_[1]);
        if(!waiting||open_attempts_>kSilentRetries)break;
        link_.Pause(kSilentPauseMs);open_waited_ms_+=kSilentPauseMs;
    }
    ReadInfo();
    if(!(axis_off_[0]&&axis_off_[1]))return fail(4);
    drives_disabled_=true;
    for(int i=0;i<2;++i) {
        if(!ReadWord(i+1,kMin,min_[i])||!ReadWord(i+1,kMax,max_[i])||
           min_[i]<0||min_[i]>=max_[i]||max_[i]>1023)return fail(static_cast<uint8_t>(5+i));
    }
    MotionFeedback sample;
    if(!ReadAxes(sample))return fail(7);
    opened_=true;have_previous_=false;stalled_[0]=stalled_[1]=0;
    return true;
}
bool ScsMotionPort::Move(const MotionTarget& t) {
    // Repeated moves on an open port are keyframes; each one is checked.
    if(!opened_||!ValidSetpoint(t))return false;   // Requests were checked more strictly upstream.
    if(rotating_&&!EndRotation())return false;
    const int angles[2]{t.yaw,t.pitch};int raw[2];
    for(int i=0;i<2;++i) {
        raw[i]=zero_[i]+angles[i]*16/50;
        if(raw[i]<0||raw[i]>1000||raw[i]<min_[i]||raw[i]>max_[i])return false;
    }
    // Two individual writes are not atomic: failure can follow partial motion.
    // The caller must Release on every failure. Never stage an EEPROM change.
    const auto fail=[&]{opened_=false;return false;};
    // Each write is confirmed by reading the register back (see DisableBoth);
    // a missing acknowledgement alone does not fail the move.
    for(int i=0;i<2;++i) {
        unsigned char bytes[6]{};Put(bytes,raw[i]);Put(bytes+2,t.duration_ms);
        Write(i+1,kGoal,bytes,6);
        int goal=-1;
        if(!ReadWord(i+1,kGoal,goal)||goal!=raw[i])return fail();
    }
    drives_disabled_=false; // A following enable write can take effect on ACK loss.
    if(!EnableBoth())return fail();
    target_[0]=raw[0];target_[1]=raw[1];moved_=true;have_previous_=false;
    return true;
}
bool ScsMotionPort::Write(int id,int address,unsigned char* bytes,int n) {
    const int i=id-1;
    if(acks_[i]) {
        const bool ok=Ok(bus_.genWrite(id,address,bytes,n));
        write_acked_[i]=ok;
        // v67-v70: the yaw servo almost never acknowledges a write. After two in
        // a row, stop waiting the full reply timeout for each one; the register
        // read back after every write still decides.
        missed_acks_[i]=ok?0:missed_acks_[i]+1;
        if(missed_acks_[i]>=2)acks_[i]=false;
        return ok;
    }
    const auto level=bus_.Level;
    bus_.Level=0;(void)bus_.genWrite(id,address,bytes,n);bus_.Level=level;
    link_.Pause(2);   // Let a late reply, if any, land before the flush of the readback.
    write_acked_[i]=false;
    return true;
}
bool ScsMotionPort::EnableBoth() {
    // Already on from an earlier frame or hold: nothing to write (setpoints).
    if(torque_on_[0]&&torque_on_[1])return true;
    for(int id=1;id<=2;++id) {
        unsigned char on=1;Write(id,kTorque,&on,1);
        unsigned char torque=255;
        if(!Ok(bus_.Read(id,kTorque,&torque,1),1)||torque!=1)return false;
        torque_on_[id-1]=true;
    }
    return true;
}
void ScsMotionPort::ReadInfo() {
    for(int id=1;id<=2;++id) {
        unsigned char bytes[3]{};
        const bool read=Ok(bus_.Read(id,kInfo,bytes,3),3);
        info_[id-1]=read?(1u<<24)|(uint32_t(bytes[0])<<16)|(uint32_t(bytes[1])<<8)|bytes[2]:0;
    }
}
bool ScsMotionPort::ReadAxes(MotionFeedback& sample) {
    int raw[2],angle[2],load[2],current[2];bool moving=false,stalled=false;
    for(int i=0;i<2;++i) {
        unsigned char data[kFeedbackBytes]{};
        if(!Ok(bus_.Read(i+1,kFeedback,data,sizeof(data)),sizeof(data)))return false;
        raw[i]=Word(data);const int mv=data[10];
        load[i]=SignedMagnitude(Word(data+4),10);
        current[i]=SignedMagnitude(Word(data+13),15);
        if(raw[i]>1000||mv>1||std::abs(load[i])>1000)return false;
        angle[i]=(raw[i]-zero_[i])*50/16;
        moving=moving||mv;
    }
    if(angle[0]<-3600||angle[0]>3600||angle[1]<0||angle[1]>900)return false;
    for(int i=0;i<2;++i) {
        // Configured protection borrowed from upstream absolute thresholds,
        // not a calibrated force/current measurement or a stall guarantee.
        // Same rules as the stock pitch protection (hal_servo.cpp): off target,
        // not moving, and current or load high or suddenly rising. v68 pressed
        // the body without reaching the absolute thresholds.
        const int abs_load=std::abs(load[i]),abs_current=std::abs(current[i]);
        const bool spike=abs_current>=350||abs_load>=650||
            (have_previous_&&(abs_current-previous_current_[i]>=80||abs_load-previous_load_[i]>=150));
        const bool stuck=moved_&&have_previous_&&std::abs(target_[i]-raw[i])>=8&&
            std::abs(raw[i]-previous_[i])<=1&&spike;
        stalled_[i]=stuck?stalled_[i]+1:0;
        stalled=stalled||stalled_[i]>=2;previous_[i]=raw[i];
        previous_load_[i]=abs_load;previous_current_[i]=abs_current;
    }
    have_previous_=true;sample={angle[0],angle[1],moving,stalled};return true;
}
bool ScsMotionPort::Torque(bool on) {
    if(!opened_)return false;
    if(rotating_&&!EndRotation())return false;
    if(!on) {
        // Limp but powered: both drives verified off, the link stays open.
        moved_=false;have_previous_=false;
        if(!DisableBoth())return false;
        drives_disabled_=true;return true;
    }
    // Hold the present pose: target where each axis is now, then enable.
    unsigned char data[2]{};int raw[2];
    for(int i=0;i<2;++i) {
        if(!Ok(bus_.Read(i+1,kFeedback,data,2),2))return false;
        raw[i]=Word(data);
        if(raw[i]>1000||raw[i]<min_[i]||raw[i]>max_[i])return false;
    }
    for(int i=0;i<2;++i) {
        unsigned char bytes[6]{};Put(bytes,raw[i]);
        Write(i+1,kGoal,bytes,6);
        int goal=-1;
        if(!ReadWord(i+1,kGoal,goal)||goal!=raw[i])return false;
    }
    drives_disabled_=false;
    if(!EnableBoth())return false;
    target_[0]=raw[0];target_[1]=raw[1];moved_=true;have_previous_=false;
    return true;
}
bool ScsMotionPort::Rotate(int velocity) {
    if(!opened_||velocity<-1000||velocity>1000)return false;
    if(velocity==0)return rotating_?EndRotation():true;
    if(!rotating_) {
        // Only from a verified position-mode Open with real limits to restore.
        if(min_[0]<0||max_[0]<=min_[0])return false;
        unsigned char zero[4]{};
        write_acked_[0]=Ok(bus_.genWrite(1,kMin,zero,4));
        rotating_=true;   // From here on, the limits may be zero: always try to restore.
        unsigned char back[4]{1,1,1,1};
        if(!Ok(bus_.Read(1,kMin,back,4),4)||back[0]||back[1]||back[2]||back[3])return false;
        write_acked_[0]=Ok(bus_.writeByte(1,kTorque,1))&&write_acked_[0];
        unsigned char torque=255;
        if(!Ok(bus_.Read(1,kTorque,&torque,1),1)||torque!=1)return false;
        torque_on_[0]=true;
        drives_disabled_=false;moved_=false;have_previous_=false;
    }
    // v70 on Sion: a duty without the direction bit made yaw decrease. Positive
    // velocity now turns the same way as positive yaw (the robot's own right, v71 video).
    const int duty=velocity>0?velocity|(1<<10):-velocity;
    unsigned char bytes[2]{};Put(bytes,duty);
    write_acked_[0]=Ok(bus_.genWrite(1,kPwm,bytes,2));
    int back=-1;
    return ReadWord(1,kPwm,back)&&back==duty;
}
bool ScsMotionPort::EndRotation() {
    // Stop, drop yaw torque (so position mode cannot jump to an old goal),
    // then write the original limits back and read them.
    unsigned char stop[2]{};
    write_acked_[0]=Ok(bus_.genWrite(1,kPwm,stop,2));
    (void)bus_.writeByte(1,kTorque,0);   // The readback below decides.
    unsigned char torque=255;
    const bool ok=Ok(bus_.Read(1,kTorque,&torque,1),1)&&torque==0;
    if(ok)torque_on_[0]=false;
    unsigned char limits[4]{};Put(limits,min_[0]);Put(limits+2,max_[0]);
    write_acked_[0]=Ok(bus_.genWrite(1,kMin,limits,4));
    int low=-1,high=-1;
    if(!ReadWord(1,kMin,low)||!ReadWord(1,kMax,high)||low!=min_[0]||high!=max_[0])return false;
    rotating_=false;
    return ok;
}
bool ScsMotionPort::Sense(MotionSense& sense) {
    if(!opened_)return false;
    MotionSense value;
    ServoAxisState* axes[2]{&value.yaw,&value.pitch};
    for(int i=0;i<2;++i) {
        unsigned char data[kFeedbackBytes]{};unsigned char torque=255;
        if(!Ok(bus_.Read(i+1,kFeedback,data,sizeof(data)),sizeof(data)))return false;
        if(!Ok(bus_.Read(i+1,kTorque,&torque,1),1)||torque>1)return false;
        auto& a=*axes[i];
        a.position=Word(data);
        if(a.position>1023||data[10]>1)return false;
        a.in_range=a.position<=1000;
        a.angle=(std::min(a.position,1000)-zero_[i])*50/16;
        a.speed=SignedMagnitude(Word(data+2),15);
        a.load=SignedMagnitude(Word(data+4),10);
        a.voltage=data[6];a.temperature=data[7];a.moving=data[10]==1;
        a.current=SignedMagnitude(Word(data+13),15);
        a.torque=torque==1;
    }
    sense=value;return true;
}
Result ScsMotionPort::Poll(MotionFeedback& sample) {
    if(!opened_)return Result::Failed;
    MotionFeedback value;
    if(!ReadAxes(value))return Result::Failed;
    sample=value;return Result::Done;
}
Result ScsMotionPort::Release() {
    opened_=false;moved_=false;have_previous_=false;
    if(!owns_link_)return Result::Done;
    if(ready_link_) {
        drives_disabled_=false;
        // Never leave the yaw servo in wheel mode; DisableBoth still runs if this fails.
        const bool restored=!rotating_||EndRotation();
        if(!DisableBoth()||!restored)return Result::Failed;
        drives_disabled_=true;
        // Close can partially tear down the UART before reporting failure.
        // Retry Close directly; never send new packets through that link.
        ready_link_=false;
    }
    if(!link_.Close())return Result::Failed;
    owns_link_=false;ready_link_=false;return Result::Done;
}
}
