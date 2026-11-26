// SPDX-License-Identifier: MIT
#pragma once
#include "motion_uart.h"
#include "py32_expander.h"

namespace sion::agent {
// Owns only PY32 GPIO0 (VM_EN) through the shared board expander. The legacy
// owner remains disabled. Used by the one motion worker.
class EspServoPower final:public ServoPowerStatus {
public:
    explicit EspServoPower(i2c_master_bus_handle_t bus, Py32Expander& expander=BoardPy32())
        :bus_(bus),expander_(expander){}
    EspServoPower(const EspServoPower&)=delete;
    EspServoPower& operator=(const EspServoPower&)=delete;
    // Attach, identify and prepare with VM_EN low. Open does not enable motors.
    // Any failure needs Close; no destructor I/O and no automatic reopen.
    bool Open();
    // Supplies the board-owned bus after board initialization, before any IO.
    bool Open(i2c_master_bus_handle_t bus);
    bool Enable();
    bool Ready() override;
    // Caller must finish servo/UART cleanup before closing their power owner.
    // After GPIO ownership was established, confirms latch/direction/input low,
    // not measured motor supply voltage. Failed identification only detaches;
    // no registers are written and the preexisting power state remains unknown.
    bool Close();
    // Diagnostic only: 1 bus/lease, 2 expander claim, 3 version, 4 GPIO
    // preparation, 5 enable write, 6 enabled readback.
    uint8_t OpenFailure() const {return open_failure_;}
private:
    uint8_t open_failure_=0;
    i2c_master_bus_handle_t bus_=nullptr;
    Py32Expander& expander_;
    bool lease_=false,touched_=false,prepared_=false,enabled_=false;
    bool Read(uint8_t reg,uint8_t& value);
    bool Bit(uint8_t reg,bool value);
    bool Check(bool high);
    bool Off();
};
}
