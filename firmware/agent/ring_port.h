// SPDX-License-Identifier: MIT
#pragma once
#include "py32_expander.h"
#include "ring_engine.h"
#include <array>

namespace sion::agent {

// One future ring-worker owner. Init is explicit; Close publishes black before
// giving up the claim. Success confirms registers/refresh, not emitted light.
class EspRingPort {
public:
    using Frame = RingFrame;
    explicit EspRingPort(Py32Expander& expander = BoardPy32()) : expander_(expander) {}
    EspRingPort(const EspRingPort&) = delete;
    EspRingPort& operator=(const EspRingPort&) = delete;
    bool Open(i2c_master_bus_handle_t bus);
    bool Show(const Frame& frame);
    bool Close();

private:
    Py32Expander& expander_;
    bool owns_ = false;
    bool touched_ = false;
    bool ready_ = false;
    bool cleared_ = false;
    bool Prepare();
};

}
