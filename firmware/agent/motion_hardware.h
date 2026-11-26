// SPDX-License-Identifier: MIT
#pragma once
#include "motion_power.h"
namespace sion::agent {
// One board-lifetime owner; used exclusively by the motion worker. Call Release
// even after failed Open. No constructor/destructor accesses the board.
class EspMotionPort final:public MotionPort {
public:
    using BusProvider=i2c_master_bus_handle_t(*)();
    explicit EspMotionPort(BusProvider bus):bus_(bus),power_(nullptr),uart_(power_),scs_(uart_,uart_){}
    bool Open() override;
    bool Move(const MotionTarget& target) override;
    Result Poll(MotionFeedback& sample) override;
    Result Release() override;
    bool Torque(bool on) override;
    bool Sense(MotionSense& sense) override;
    bool Rotate(int velocity) override;
private:
    BusProvider bus_;
    EspServoPower power_;
    EspServoUart uart_;
    ScsMotionPort scs_;
    bool held_=false,opened_=false,scs_attempted_=false;
    // If torque-off cannot be confirmed, cut power and close UART best-effort,
    // but never manufacture a successful stop. Requires board restart/review.
    bool stop_unknown_=false;
};
}
