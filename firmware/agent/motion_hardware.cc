// SPDX-License-Identifier: MIT
#include "motion_hardware.h"
#include "device_trace.h"
namespace sion::agent {
namespace {
void TraceMotion(diagnostics::Event event,uint32_t detail) {
#ifdef ESP_PLATFORM
    diagnostics::Record(diagnostics::Lane::Boot,event,detail);
#else
    (void)event;(void)detail; // Host tests have no RAM trace book.
#endif
}
}
bool EspMotionPort::Open() {
    using diagnostics::Event;using diagnostics::TracePair;
    // Boot lane: few entries after start-up, so a failure survives until dumped.
    // Step: 1 held, 2 UART/calibration, 3 bus, 4 power open, 5 power enable, 6 SCS.
    const auto fail=[](uint16_t step,uint16_t detail){
        TraceMotion(Event::MotionOpenFailed,TracePair(step,detail));return false;};
    if(held_||stop_unknown_)return fail(1,stop_unknown_);
    held_=true;
    // Validate original calibration and reserve UART before touching VM_EN.
    // Prepare emits no servo bytes. Power can still move physical hardware on
    // startup; startup behavior remains part of real-device acceptance.
    if(!uart_.Prepare())return fail(2,uart_.OpenFailure());
    if(!bus_)return fail(3,0);
    if(!power_.Open(bus_()))return fail(4,power_.OpenFailure());
    if(!power_.Enable())return fail(5,power_.OpenFailure());
    scs_attempted_=true;
    opened_=scs_.Open();
    // Servo settings and angle limits: once per boot, again only if they change,
    // so the idle retries cannot push everything else out of the boot lane.
    static uint32_t traced_info[2]{},traced_limits[2]{};
    for(int axis=0;axis<2;++axis) {
        const uint32_t info=(uint32_t(axis)<<31)|(uint32_t(scs_.WriteAcked(axis))<<25)|scs_.Info(axis);
        if(scs_.Info(axis)&&info!=traced_info[axis]){traced_info[axis]=info;TraceMotion(Event::MotionServoInfo,info);}
        const int low=scs_.MinLimit(axis),high=scs_.MaxLimit(axis);
        const uint32_t limits=(uint32_t(axis)<<20)|(uint32_t(low&0x3ff)<<10)|uint32_t(high&0x3ff);
        if((low>=0||high>=0)&&(limits|(1u<<31))!=traced_limits[axis]){
            traced_limits[axis]=limits|(1u<<31);TraceMotion(Event::MotionLimits,limits);}
    }
    if(!opened_) {
        if(scs_.OpenFailure()==4)TraceMotion(Event::MotionOpenAttempts,TracePair(static_cast<uint16_t>(scs_.OpenAttempts()),
            static_cast<uint16_t>(scs_.OpenWaitedMs())));
        if(scs_.OpenFailure()==4)for(int axis=0;axis<2;++axis)
            TraceMotion(Event::MotionTorqueProbe,(uint32_t(axis)<<31)|scs_.TorqueProbe(axis));
        return fail(6,scs_.OpenFailure()|(scs_.OpenFailure()==2?uart_.OpenFailure()<<8:0));
    }
    // Successful opens happen every few seconds while idle motion runs; keep
    // the first one per boot and any that needed retries.
    static bool traced_success=false;
    if(!traced_success||scs_.OpenAttempts()>1) {
        traced_success=true;
        TraceMotion(Event::MotionOpenAttempts,TracePair(static_cast<uint16_t>(scs_.OpenAttempts()),
            static_cast<uint16_t>(scs_.OpenWaitedMs())));
    }
    return true;
}
bool EspMotionPort::Move(const MotionTarget& target) {
    if(!opened_||stop_unknown_)return false;
    if(scs_.Move(target))return true;
    opened_=false;return false;
}
bool EspMotionPort::Torque(bool on) {
    if(!opened_||stop_unknown_)return false;
    if(scs_.Torque(on))return true;
    opened_=false;return false;
}
bool EspMotionPort::Rotate(int velocity) {
    if(!opened_||stop_unknown_)return false;
    return scs_.Rotate(velocity);
}
bool EspMotionPort::Sense(MotionSense& sense) {
    if(!opened_||stop_unknown_)return false;
    return scs_.Sense(sense);
}
Result EspMotionPort::Poll(MotionFeedback& sample) {
    return opened_&&!stop_unknown_?scs_.Poll(sample):Result::Failed;
}
Result EspMotionPort::Release() {
    opened_=false;
    if(!held_)return Result::Done;
    if(stop_unknown_) {
        // Keep trying actual cleanup on explicit retry, without ever enabling
        // power or sending more servo commands through an uncertain transport.
        power_.Close();uart_.Close();return Result::Failed;
    }
    if(scs_attempted_) {
        const auto result=scs_.Release();
        if(result==Result::Pending)return result;
        if(result==Result::Failed) {
            if(!scs_.DrivesDisabled()) {
                stop_unknown_=true;
                power_.Close();uart_.Close();
            } else {
                // Torque-off is already confirmed; UART/pin close can be
                // retried without a powered bus. Still attempt power cleanup.
                power_.Close();
            }
            return Result::Failed;
        }
        scs_attempted_=false;
    }
    // No Scs Open or already released. Do not short-circuit one cleanup because
    // the other failed. Power close always gets a chance, including startup.
    const bool serial=uart_.Close();
    const bool power=power_.Close();
    if(!serial||!power)return Result::Failed;
    held_=false;return Result::Done;
}
}
