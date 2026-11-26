// SPDX-License-Identifier: MIT
#pragma once
#include "motion_engine.h"
#include <hal/drivers/FTServo_Arduino/src/SCS.h>

namespace sion::agent {
// The board implementation must read existing calibration without writes, own
// the UART exclusively, and verify power availability. Open failure can leave
// partial link resources, but must not issue motion commands. Close is checked
// and retryable; it must not delete another owner's driver. No destructor I/O.
// Healthy covers transport errors that the upstream SCS API does not propagate
// (e.g. a short write). Reset it at the start of EACH SCS transaction, not between
// fragments, and latch any I/O/flush error through that transaction's result.
struct ServoLink {
    virtual ~ServoLink()=default;
    virtual bool Open(int& yaw_zero,int& pitch_zero)=0;
    virtual bool Close()=0;
    virtual bool Healthy() const=0;
    // Lets freshly powered servos finish booting between silent attempts.
    virtual void Pause(unsigned milliseconds){(void)milliseconds;}
};

// Real SCS protocol/servo-register consumer; supplied UART/power link is board
// specific. A single worker owns this object, the SCS instance, and ServoLink.
class ScsMotionPort final:public MotionPort {
public:
    ScsMotionPort(SCS& bus,ServoLink& link):bus_(bus),link_(link){}
    bool Open() override;
    bool Move(const MotionTarget& target) override;
    Result Poll(MotionFeedback& sample) override;
    Result Release() override;
    bool Torque(bool on) override;
    bool Sense(MotionSense& sense) override;
    bool Rotate(int velocity) override;
    bool Rotating() const {return rotating_;}
    // Worker-only cleanup fact, not live voltage or mechanical-pose feedback.
    bool DrivesDisabled() const {return drives_disabled_;}
    // Diagnostic only: the last Open step that failed (0 = none) and the raw
    // angle limits read for each axis. 1 state, 2 link, 3 zero, 4 torque-off,
    // 5/6 yaw/pitch limits, 7 feedback.
    uint8_t OpenFailure() const {return open_failure_;}
    int MinLimit(int axis) const {return min_[axis];}
    int MaxLimit(int axis) const {return max_[axis];}
    // Diagnostic only: what the last torque-off write/readback saw on each axis.
    // bit30 link healthy, 29-28 write count, 27-26 read count (3 = negative),
    // 25/24 write/read last error set, 23-16 write status, 15-8 read status,
    // 7-0 torque byte read back (255 = nothing read).
    uint32_t TorqueProbe(int axis) const {return torque_probe_[axis];}
    // Diagnostic only: torque-off attempts the last Open needed and the pause
    // spent waiting for a first reply (v66: both servos never answered).
    unsigned OpenAttempts() const {return open_attempts_;}
    // Diagnostic only, read once per Open after the torque-off attempts:
    // bit24 read ok, 23-16 baud code (reg 6), 15-8 return delay (reg 7),
    // 7-0 response level (reg 8). 0 when the servo did not answer.
    uint32_t Info(int axis) const {return info_[axis];}
    // Diagnostic only: whether the last write to each axis was acknowledged.
    // Success is decided by reading the register back, not by this flag.
    bool WriteAcked(int axis) const {return write_acked_[axis];}
    unsigned OpenWaitedMs() const {return open_waited_ms_;}
    static constexpr unsigned kSilentRetries=4,kSilentPauseMs=100;  // ~2.5 s worst case, inside kMotionTimeoutMs
private:
    SCS& bus_;ServoLink& link_;
    bool owns_link_=false,ready_link_=false,opened_=false,moved_=false;
    bool drives_disabled_=false;
    int zero_[2]{},min_[2]{},max_[2]{},target_[2]{},previous_[2]{},previous_load_[2]{},previous_current_[2]{};
    bool have_previous_=false;
    uint8_t open_failure_=0;
    uint32_t torque_probe_[2]{};
    unsigned open_attempts_=0,open_waited_ms_=0;
    bool silent_[2]{},axis_off_[2]{},write_acked_[2]{},rotating_=false;
    uint32_t info_[2]{};
    unsigned stalled_[2]{};
    bool Ok(int count,int expected=1) const;
    bool DisableBoth();
    void ReadInfo();
    bool EndRotation();
    bool Write(int id,int address,unsigned char* bytes,int n);
    bool EnableBoth();
    bool acks_[2]{true,true},torque_on_[2]{};
    unsigned missed_acks_[2]{};
    bool ReadAxes(MotionFeedback& sample);
    bool ReadWord(int id,int address,int& value);
};
}
