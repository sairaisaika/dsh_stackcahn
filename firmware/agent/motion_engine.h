// SPDX-License-Identifier: MIT
#pragma once
#include "session_lifecycle.h"
#include <array>
#include <cstdint>
#include <limits>
#include <mutex>

namespace sion::agent {
// Product settings, not measured mechanical guarantees. Angles are tenths of a
// degree in the calibrated position frame; duration is requested time, not a measured guarantee.
constexpr uint64_t kMotionFeedbackMs=50;
// Opening/commanding/torque/read get this long; a move frame gets its own
// duration plus this much (v68: a single 5 s budget covered everything).
constexpr uint64_t kMotionTimeoutMs=5000,kMotionFrameGraceMs=3000;
constexpr int kMotionTolerance=20;
// v68 on Sion: servo pitch about 65 degrees already reaches the body behind the
// head (owner saw it pressed at roughly 87 degrees from the ground). Protection,
// not a behaviour rule; the manual's 5-85 degrees is in a different frame.
constexpr int kPitchMin=50,kPitchMax=650;
// Stall when a frame has had its requested time plus this grace, is still off
// target, and has not moved more than kStallDrift over kStallWindowMs.
// v68: pressing against the body for 5 s never reached the load thresholds.
constexpr uint64_t kStallGraceMs=400,kStallWindowMs=300;
constexpr int kStallDrift=10;
constexpr unsigned kMaxMotionFrames=8;
// Yaw continuous rotation (the yaw servo has no end stop). Velocity is the
// servo's PWM duty, -1000..1000; the owner approved the angle-limit writes this needs.
constexpr int kMaxRotateVelocity=1000;
constexpr uint32_t kMinRotateMs=100,kMaxRotateMs=20000;
constexpr int kRotateStallLoad=800;
constexpr uint32_t kMaxHoldMs=60000;

struct MotionTarget { int yaw=0, pitch=450, duration_ms=1000; };
inline bool ValidMotionTarget(const MotionTarget& t) {
    return t.yaw>=-1280&&t.yaw<=1280&&t.pitch>=kPitchMin&&t.pitch<=kPitchMax&&t.duration_ms>=100&&t.duration_ms<=3000;
}
// Setpoints are short steps of a continuous path: 20 ms is the shortest.
inline bool ValidSetpoint(const MotionTarget& t) {
    return t.yaw>=-1280&&t.yaw<=1280&&t.pitch>=kPitchMin&&t.pitch<=kPitchMax&&t.duration_ms>=20&&t.duration_ms<=3000;
}
struct MotionFeedback { int yaw=0, pitch=0; bool moving=true, stalled=false; };
// Raw servo registers for one axis, plus the calibrated angle (0.1 degree).
// Units are the servo's own: position 0..1000 steps, speed/load/current signed
// raw counts, voltage in 0.1 V, temperature in degrees C.
// in_range false: the yaw servo turns all the way round, but its sensor only
// covers raw 0..1000 (about 312 degrees); in the rest the reading is not a
// position (v69: a hand turned it past both ends).
struct ServoAxisState {
    int angle=0,position=0,speed=0,load=0,voltage=0,temperature=0,current=0;
    bool moving=false,torque=false,in_range=true;
};
struct MotionSense { ServoAxisState yaw, pitch; };

// Kind of request. Move: keyframes, then optionally hold. Torque: hold the
// present pose (on) or go limp (off) while powered; hold_ms 0 releases power.
// Sense: read all servo registers once, without commanding anything.
enum class MotionKind { Move, Torque, Sense, Rotate };
struct MotionRequest {
    MotionKind kind=MotionKind::Move;
    std::array<MotionTarget,kMaxMotionFrames> frames{};
    unsigned count=1;
    uint32_t hold_ms=0;   // Stay powered this long after finishing (0 = release).
    bool torque=true;     // While holding: keep torque on (hold) or off (limp).
    int velocity=0;       // Rotate: -1000..1000, not 0.
    uint32_t rotate_ms=0; // Rotate: how long to turn.
};
inline bool ValidMotionRequest(const MotionRequest& r) {
    if(r.hold_ms>kMaxHoldMs)return false;
    if(r.kind==MotionKind::Rotate)return r.count==0&&r.velocity!=0&&r.velocity>=-kMaxRotateVelocity&&
        r.velocity<=kMaxRotateVelocity&&r.rotate_ms>=kMinRotateMs&&r.rotate_ms<=kMaxRotateMs;
    if(r.kind!=MotionKind::Move)return r.count==0;
    if(r.count<1||r.count>kMaxMotionFrames)return false;
    for(unsigned i=0;i<r.count;++i)if(!ValidMotionTarget(r.frames[i]))return false;
    return true;
}
inline MotionRequest SingleMove(const MotionTarget& t){MotionRequest r;r.frames[0]=t;r.count=1;return r;}

enum class MotionPhase { Idle, Opening, Commanding, Moving, Torquing, Sensing, Rotating, Holding, Releasing, Fault };
enum class MotionError { None, Open, Command, Feedback, Stall, Timeout, Release, Torque, Sense, Rotate };
struct MotionOutcome {
    uint64_t epoch=0,ticket=0;
    MotionError error=MotionError::None;
    // Last valid sample, not a claim about the pose after release.
    bool observed=false;
    MotionFeedback feedback{};
    bool sensed=false;
    MotionSense sense{};
    bool holding=false;   // The drives stay powered after this result.
};
struct MotionStatus {
    MotionPhase phase;
    MotionError error;
    uint64_t epoch,ticket;
    bool allowed,result_ready;
};

// Only one worker invokes the port. Open must not command a pose or write factory
// calibration. Failed Open/Move can leave partial resources and require Release.
// Move true means checked acceptance, not arrival, and may be called again on an
// open port. Poll Done must be a fresh, validated read of BOTH axes. Torque(true)
// holds the present pose; Torque(false) disables both drives but keeps the port.
// Release Done means no further commands are queued, both drives verified disabled,
// and owned transport resources released. It does not guarantee mechanical hold.
struct MotionPort {
    virtual ~MotionPort()=default;
    virtual bool Open()=0;
    virtual bool Move(const MotionTarget& target)=0;
    virtual Result Poll(MotionFeedback& feedback)=0;
    virtual Result Release()=0;
    virtual bool Torque(bool on){(void)on;return false;}
    // Yaw only. Non-zero: switch to (or stay in) wheel mode and turn at this duty.
    // Zero: stop, turn yaw torque off and restore position mode, verified.
    virtual bool Rotate(int velocity){(void)velocity;return false;}
    virtual bool Sense(MotionSense& sense){(void)sense;return false;}
};

class MotionEngine {
public:
    explicit MotionEngine(MotionPort& port):port_(port){}
    void AllowMotion(bool allowed) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(allowed_==allowed)return;
        allowed_=allowed;
        if(!allowed)CancelLocked();
    }
    uint64_t Begin(uint64_t epoch,const MotionTarget& target,uint64_t now) {
        return BeginRequest(epoch,SingleMove(target),now);
    }
    // Caller independently authenticates the active lease. Zero means rejected;
    // this local ticket is not a wire request_id. A request may follow a held
    // one of the same epoch without powering down; one result slot.
    uint64_t BeginRequest(uint64_t epoch,const MotionRequest& request,uint64_t now) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!allowed_||!epoch||epoch<=fence_||epoch<epoch_||!ValidMotionRequest(request)||
           (phase_!=MotionPhase::Idle&&phase_!=MotionPhase::Holding)||ready_||
           (phase_==MotionPhase::Holding&&epoch!=epoch_)||
           ticket_==std::numeric_limits<uint64_t>::max())return 0;
        const bool held=phase_==MotionPhase::Holding;
        // Reading while held keeps the hold that is already running.
        resume_hold_=held&&request.kind==MotionKind::Sense&&request.hold_ms==0;
        epoch_=epoch;++ticket_;request_=request;frame_=0;has_setpoint_=false;
        error_=MotionError::None;observed_=false;feedback_={};sensed_=false;sense_={};
        holding_result_=false;stable_=0;polled_=false;history_count_=0;rotate_loaded_=0;
        stage_started_=frame_started_=last_clock_=now;
        phase_=held?FirstPhase():MotionPhase::Opening;
        return ticket_;
    }
    // Real-time target while holding with torque on: applied by the worker as soon
    // as it can (the newest one wins), without waiting for arrival or a result.
    // The hold's own deadline still ends it. False: not holding, other epoch or out of range.
    bool Setpoint(uint64_t epoch,const MotionTarget& target) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!allowed_||phase_!=MotionPhase::Holding||!request_.torque||epoch!=epoch_||epoch<=fence_||
           !ValidSetpoint(target))return false;
        setpoint_=target;has_setpoint_=true;++setpoints_;
        return true;
    }
    unsigned SetpointsApplied() const {std::lock_guard<std::mutex> lock(mutex_);return setpoints_applied_;}
    void Stop(uint64_t fence) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(fence<epoch_||fence<fence_)return;
        fence_=fence;CancelLocked();
    }
    Result Stopped(uint64_t fence) const {
        std::lock_guard<std::mutex> lock(mutex_);
        if(fence!=fence_||epoch_>fence)return Result::Pending;
        if(phase_==MotionPhase::Fault)return Result::Failed;
        return phase_==MotionPhase::Idle?Result::Done:Result::Pending;
    }
    void Cancel(uint64_t epoch,uint64_t ticket) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(epoch==epoch_&&ticket==ticket_)CancelLocked();
    }
    MotionStatus status() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return {phase_,error_,epoch_,ticket_,allowed_,ready_};
    }
    bool Take(uint64_t epoch,uint64_t ticket,MotionOutcome& result) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!ready_||epoch!=epoch_||ticket!=ticket_||epoch<=fence_)return false;
        result={epoch_,ticket_,error_,observed_,feedback_,sensed_,sense_,phase_==MotionPhase::Holding};
        ready_=false;return true;
    }
    // Exactly one worker; control calls remain usable during a blocked I/O call.
    void Pump(uint64_t now) {
        MotionPhase phase=MotionPhase::Idle;MotionRequest request;unsigned frame=0;uint64_t ticket=0;
        MotionTarget setpoint;bool apply_setpoint=false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if(phase_==MotionPhase::Idle||phase_==MotionPhase::Fault)return;
            if(phase_==MotionPhase::Holding) {
                if(now>=last_clock_&&now<hold_until_) {
                    last_clock_=now;
                    if(!has_setpoint_)return;
                    has_setpoint_=false;setpoint=setpoint_;apply_setpoint=true;ticket=ticket_;
                } else phase_=MotionPhase::Releasing;   // Hold expired (or clock went back).
            }
            if(!apply_setpoint) {
                if(phase_!=MotionPhase::Releasing&&(now<last_clock_||now-stage_started_>=StageBudget())) {
                    error_=MotionError::Timeout;phase_=MotionPhase::Releasing;
                }
                last_clock_=now;phase=phase_;ticket=ticket_;request=request_;frame=frame_;
                if(phase==MotionPhase::Moving) {
                    if(polled_&&now-last_poll_<kMotionFeedbackMs)return;
                    last_poll_=now;polled_=true;
                }
            }
        }
        if(apply_setpoint) {
            const bool ok=port_.Move(setpoint);
            std::lock_guard<std::mutex> lock(mutex_);
            if(phase_!=MotionPhase::Holding||ticket!=ticket_)return;
            if(!ok){error_=MotionError::Command;phase_=MotionPhase::Releasing;return;}
            ++setpoints_applied_;
            return;
        }
        if(phase==MotionPhase::Releasing) {
            // A cancelled or failed rotation is stopped first; Release restores the
            // position mode as well if this attempt fails.
            if(rotating_&&port_.Rotate(0))rotating_=false;
            const Result r=owns_port_?port_.Release():Result::Done;
            if(r==Result::Done)rotating_=false;
            if(r==Result::Pending)return;
            if(r==Result::Done)owns_port_=false;
            std::lock_guard<std::mutex> lock(mutex_);
            if(r==Result::Failed){error_=MotionError::Release;phase_=MotionPhase::Fault;return;}
            phase_=MotionPhase::Idle;
            // A result already handed out while holding is not repeated.
            if(!holding_result_)ready_=allowed_&&epoch_>fence_&&ticket_>cancelled_ticket_;
            holding_result_=false;
            return;
        }
        if(phase==MotionPhase::Opening) {
            owns_port_=true;
            const bool ok=port_.Open();
            std::lock_guard<std::mutex> lock(mutex_);
            if(!Current(ticket,phase))return;
            if(!ok){error_=MotionError::Open;phase_=MotionPhase::Releasing;return;}
            phase_=FirstPhase();stage_started_=frame_started_=now;
            return;
        }
        if(phase==MotionPhase::Commanding) {
            const bool ok=port_.Move(request.frames[frame]);
            std::lock_guard<std::mutex> lock(mutex_);
            if(!Current(ticket,phase))return;
            if(!ok){error_=MotionError::Command;phase_=MotionPhase::Releasing;return;}
            phase_=MotionPhase::Moving;stage_started_=frame_started_=now;
            stable_=0;polled_=false;history_count_=0;
            return;
        }
        if(phase==MotionPhase::Rotating) {
            bool done=false,stalled=false,ok=true;
            if(!rotating_){ok=port_.Rotate(request.velocity);rotating_=ok;last_poll_=now;}
            else if(now-stage_started_>=request.rotate_ms)done=true;
            else if(now-last_poll_>=100) {
                // Turning has no position to reach; watch the load instead.
                last_poll_=now;MotionSense sense;
                if(port_.Sense(sense)){const int load=sense.yaw.load<0?-sense.yaw.load:sense.yaw.load;
                    rotate_loaded_=load>=kRotateStallLoad?rotate_loaded_+1:0;stalled=rotate_loaded_>=3;}
            }
            if(done||stalled){ok=port_.Rotate(0);rotating_=!ok;}
            std::lock_guard<std::mutex> lock(mutex_);
            if(!Current(ticket,phase))return;
            if(!ok){error_=MotionError::Rotate;phase_=MotionPhase::Releasing;return;}
            if(stalled){error_=MotionError::Stall;phase_=MotionPhase::Releasing;return;}
            if(!done)return;
            // Back in position mode with yaw torque off: hold (re-reading the pose) or release.
            if(request_.hold_ms>0){phase_=MotionPhase::Torquing;stage_started_=now;}
            else phase_=MotionPhase::Releasing;
            return;
        }
        if(phase==MotionPhase::Torquing) {
            const bool ok=port_.Torque(request.torque);
            MotionFeedback sample;
            const bool read=ok&&port_.Poll(sample)==Result::Done;
            std::lock_guard<std::mutex> lock(mutex_);
            if(!Current(ticket,phase))return;
            if(!ok){error_=MotionError::Torque;phase_=MotionPhase::Releasing;return;}
            if(read&&ValidFeedback(sample)){feedback_=sample;observed_=true;}
            FinishLocked(now);
            return;
        }
        if(phase==MotionPhase::Sensing) {
            MotionSense sense;
            const bool ok=port_.Sense(sense);
            std::lock_guard<std::mutex> lock(mutex_);
            if(!Current(ticket,phase))return;
            if(!ok) {
                error_=MotionError::Sense;
                // A failed read while held must not drop the hold (v69).
                if(resume_hold_){resume_hold_=false;phase_=MotionPhase::Holding;holding_result_=true;
                    ready_=allowed_&&epoch_>fence_&&ticket_>cancelled_ticket_;}
                else phase_=MotionPhase::Releasing;
                return;
            }
            sense_=sense;sensed_=true;
            feedback_={sense.yaw.angle,sense.pitch.angle,sense.yaw.moving||sense.pitch.moving,false};observed_=true;
            FinishLocked(now);
            return;
        }
        MotionFeedback sample;
        const Result r=port_.Poll(sample);
        std::lock_guard<std::mutex> lock(mutex_);
        if(!Current(ticket,phase))return;
        if(r==Result::Pending){stable_=0;return;}
        if(r==Result::Failed||!ValidFeedback(sample)) {
            error_=MotionError::Feedback;phase_=MotionPhase::Releasing;return;
        }
        feedback_=sample;observed_=true;
        if(sample.stalled){error_=MotionError::Stall;phase_=MotionPhase::Releasing;return;}
        const auto& target=request_.frames[frame_];
        const auto near=[](int a,int b){const int64_t d=int64_t(a)-b;return d>=-kMotionTolerance&&d<=kMotionTolerance;};
        const bool on_target=near(sample.yaw,target.yaw)&&near(sample.pitch,target.pitch);
        if(!sample.moving&&on_target)++stable_;
        else stable_=0;
        if(!on_target&&Stuck(sample,now)){error_=MotionError::Stall;phase_=MotionPhase::Releasing;return;}
        Remember(sample,now);
        if(stable_<2)return;
        if(frame_+1<request_.count) {
            ++frame_;phase_=MotionPhase::Commanding;stage_started_=now;return;
        }
        FinishLocked(now);
    }
private:
    MotionPort& port_;
    mutable std::mutex mutex_;
    MotionPhase phase_=MotionPhase::Idle;
    MotionError error_=MotionError::None;
    MotionRequest request_{};
    unsigned frame_=0;
    MotionFeedback feedback_{};
    MotionSense sense_{};
    uint64_t epoch_=0,ticket_=0,fence_=0,cancelled_ticket_=0,stage_started_=0,frame_started_=0,
             last_clock_=0,last_poll_=0,hold_until_=0;
    bool allowed_=false,ready_=false,observed_=false,sensed_=false,polled_=false,holding_result_=false,resume_hold_=false;
    unsigned stable_=0;
    // Recent samples of the current frame for the no-progress stall check.
    struct Seen{uint64_t at;int yaw,pitch;};
    std::array<Seen,16> history_{};
    unsigned history_count_=0;
    bool owns_port_=false; // worker-only, including partial failed initialization
    MotionTarget setpoint_{};bool has_setpoint_=false;unsigned setpoints_=0,setpoints_applied_=0;
    bool rotating_=false;  // worker-only: the yaw servo is in wheel mode
    unsigned rotate_loaded_=0;
    MotionPhase FirstPhase() const {
        return request_.kind==MotionKind::Move?MotionPhase::Commanding:
            request_.kind==MotionKind::Torque?MotionPhase::Torquing:
            request_.kind==MotionKind::Rotate?MotionPhase::Rotating:MotionPhase::Sensing;
    }
    uint64_t StageBudget() const {
        if(phase_==MotionPhase::Moving)return uint64_t(request_.frames[frame_].duration_ms)+kMotionFrameGraceMs;
        if(phase_==MotionPhase::Rotating)return uint64_t(request_.rotate_ms)+kMotionFrameGraceMs;
        return kMotionTimeoutMs;
    }
    void FinishLocked(uint64_t now) {
        // The result is ready now; the drives stay powered only if asked to hold.
        if(request_.hold_ms>0||resume_hold_) {
            if(!resume_hold_)hold_until_=now+request_.hold_ms;
            resume_hold_=false;phase_=MotionPhase::Holding;
            holding_result_=true;
            ready_=allowed_&&epoch_>fence_&&ticket_>cancelled_ticket_;
        }else phase_=MotionPhase::Releasing;
    }
    void Remember(const MotionFeedback& s,uint64_t now) {
        history_[history_count_%history_.size()]={now,s.yaw,s.pitch};++history_count_;
    }
    bool Stuck(const MotionFeedback& s,uint64_t now) const {
        const auto& target=request_.frames[frame_];
        if(now-frame_started_<uint64_t(target.duration_ms)+kStallGraceMs)return false;
        // Compare with the newest remembered sample at least kStallWindowMs old.
        const unsigned kept=history_count_<history_.size()?history_count_:unsigned(history_.size());
        for(unsigned i=1;i<=kept;++i) {
            const auto& old=history_[(history_count_-i)%history_.size()];
            if(now-old.at<kStallWindowMs)continue;
            const auto close=[](int a,int b){return a-b<=kStallDrift&&b-a<=kStallDrift;};
            return close(s.yaw,old.yaw)&&close(s.pitch,old.pitch);
        }
        return false;
    }
    bool Current(uint64_t ticket,MotionPhase phase) const {
        return allowed_&&ticket==ticket_&&ticket>cancelled_ticket_&&phase==phase_&&epoch_>fence_;
    }
    void CancelLocked() {
        cancelled_ticket_=ticket_;ready_=false;
        if(phase_!=MotionPhase::Idle)phase_=MotionPhase::Releasing;
    }
    static bool ValidFeedback(const MotionFeedback& sample) {
        // Wider observation domain than command domain: never clamp a bad read
        // into the target tolerance. Hardware adapter also checks raw registers.
        return sample.yaw>=-3600&&sample.yaw<=3600&&sample.pitch>=0&&sample.pitch<=900;
    }
};
}
