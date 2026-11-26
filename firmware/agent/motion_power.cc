// SPDX-License-Identifier: MIT
#include "motion_power.h"
#include <algorithm>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace sion::agent {
namespace {
constexpr auto Servo = Py32Expander::Client::Servo;
// Fixed official PY32 register map: low bank bit0 alone controls VM_EN.
constexpr uint8_t Mode=0x03,Output=0x05,Input=0x07;
constexpr uint8_t PullUp=0x09,PullDown=0x0b,Drive=0x13;
}
bool EspServoPower::Read(uint8_t reg,uint8_t& value) {
    return expander_.ReadServo(reg,value);
}
bool EspServoPower::Bit(uint8_t reg,bool value) {
    return expander_.SetServoBit(reg,value);
}
bool EspServoPower::Check(bool high) {
    uint8_t mode=0,out=0,in=0;
    const bool a=Read(Mode,mode),b=Read(Output,out),c=Read(Input,in);
    // On Sion the PY32 input bit of VM_EN reads low even while the pin is
    // driven high (v64 trace: enable-readback on every attempt), matching the
    // official HAL which never reads it back. High is decided by mode + latch;
    // a high input while latched low is still treated as unsafe.
    return a&&b&&c&&(mode&1)&&bool(out&1)==high&&(high||!(in&1));
}
bool EspServoPower::Off() {
    // A failed write may have taken effect. Still attempt to drive low and read
    // the state; no unknown result is promoted to successful cleanup.
    const bool a=Bit(Output,false);
    // Never change input to output until the low latch has been confirmed:
    // if clearing it failed, forcing output could energize the old high value.
    const bool b=a&&Bit(Mode,true);
    const bool c=Check(false);
    return a&&b&&c;
}
bool EspServoPower::Open() {return Open(bus_);}
bool EspServoPower::Open(i2c_master_bus_handle_t bus) {
    open_failure_=1;
    if(lease_||!bus)return false;
    bus_=bus;
    const auto claim=expander_.Acquire(Servo,bus);
    lease_=claim!=Py32Expander::Claim::Refused;
    open_failure_=2;
    if(claim!=Py32Expander::Claim::Ready)return false;
    open_failure_=3;
    if(!expander_.Version(Servo))return false;
    touched_=true; // From here failure can leave partially changed GPIO0.
    // Set the latch low before switching to output. Preserve unrelated bits.
    open_failure_=4;
    if(!Off()||!Bit(Drive,false)||!Bit(PullDown,false)||!Bit(PullUp,true)||!Check(false))return false;
    open_failure_=0;prepared_=true;return true;
}
bool EspServoPower::Enable() {
    if(!prepared_||enabled_)return false;
    // Repeated Enable after an uncertain result is rejected until Close/Open.
    prepared_=false;
    open_failure_=5;
    if(!Bit(Output,true))return false;
    vTaskDelay(std::max<TickType_t>(1,pdMS_TO_TICKS(200)));
    open_failure_=6;
    if(!Check(true))return false;
    open_failure_=0;enabled_=true;return true;
}
bool EspServoPower::Ready() {return enabled_&&Check(true);}
bool EspServoPower::Close() {
    prepared_=false;enabled_=false;
    if(!lease_)return true;
    if(touched_&&!Off())return false;
    if(!expander_.Release(Servo))return false;
    touched_=false;lease_=false;return true;
}
}
