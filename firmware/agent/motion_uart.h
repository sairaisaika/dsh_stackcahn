// SPDX-License-Identifier: MIT
#pragma once
#include "motion_scs.h"
#include <cstdint>

namespace sion::agent {
// Borrowed from the board power owner, which must outlive this link and keep
// power available until ScsMotionPort releases it. Ready must check hardware
// errors, not a cached requested value. No board implementation is wired yet.
struct ServoPowerStatus {
    virtual ~ServoPowerStatus()=default;
    virtual bool Ready()=0;
};

// Single worker only. Owns UART1, never the board power domain. No destructor
// I/O: the owner must explicitly Close, including after failed Open. Do not
// replace the instance after uncertain cleanup. The upstream HAL servo owner
// must remain disabled; the process-local lease only arbitrates these links.
class EspServoUart final:public SCS,public ServoLink {
public:
    explicit EspServoUart(ServoPowerStatus& power):SCS(1),power_(power){}
    EspServoUart(const EspServoUart&)=delete;
    EspServoUart& operator=(const EspServoUart&)=delete;
    // Optional staged preparation: reads calibration and owns/configures UART,
    // but sends no bytes and does not require power. Failed preparation needs
    // Close. Open then consumes this preparation exactly once.
    bool Prepare();
    bool Open(int& yaw_zero,int& pitch_zero) override;
    bool Close() override;
    bool Healthy() const override {return healthy_;}
    void Pause(unsigned milliseconds) override;
    // Diagnostic only: 1 lease, 2 UART1 already installed, 3 calibration,
    // 4 install, 5 config, 6 pins, 7 power not ready.
    uint8_t OpenFailure() const {return open_failure_;}
private:
    ServoPowerStatus& power_;
    bool lease_=false,owned_=false,ready_=false,healthy_=false;
    bool prepared_=false,open_attempted_=false;
    uint8_t open_failure_=0;
    int yaw_zero_=0,pitch_zero_=0;
    bool reset_tx_=false,reset_rx_=false;
    int64_t deadline_=0,last_time_=0;
    bool WithinDeadline();
    int writeSCS(unsigned char*,int) override;
    int writeSCS(unsigned char) override;
    int readSCS(unsigned char*,int) override;
    int readSCS(unsigned char*,int,unsigned long) override;
    void rFlushSCS() override;
    void wFlushSCS() override;
};
}
