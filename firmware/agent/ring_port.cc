// SPDX-License-Identifier: MIT
#include "ring_port.h"

namespace sion::agent {
namespace {
constexpr auto Ring = Py32Expander::Client::Ring;
// The manual names PY32 IO14. The official register driver uses pin index 13.
constexpr uint8_t Mode = 0x04, Output = 0x06, PullUp = 0x0a, PullDown = 0x0c, Drive = 0x14;
constexpr uint8_t Black[24]{};
}

bool EspRingPort::Open(i2c_master_bus_handle_t bus) {
    if (owns_) return false;
    const auto claim = expander_.Acquire(Ring, bus);
    owns_ = claim != Py32Expander::Claim::Refused;
    if (claim != Py32Expander::Claim::Ready || !expander_.Version(Ring)) return false;

    touched_ = true;
    ready_ = Prepare() && expander_.WriteRingFrame(Black);
    cleared_ = ready_;
    return ready_;
}

bool EspRingPort::Prepare() {
    return expander_.SetRingPinBit(Output, false) && expander_.SetRingPinBit(Drive, false) &&
        expander_.SetRingPinBit(PullDown, false) && expander_.SetRingPinBit(PullUp, true) &&
        expander_.SetRingPinBit(Mode, true) && expander_.ConfigureRing();
}

bool EspRingPort::Show(const Frame& frame) {
    if (!ready_) return false;
    uint8_t data[24]{};
    size_t offset = 0;
    for (const auto& color : frame) {
        const uint16_t rgb565 = ((color.red & 0xf8) << 8) | ((color.green & 0xfc) << 3) | (color.blue >> 3);
        data[offset++] = static_cast<uint8_t>(rgb565);
        data[offset++] = static_cast<uint8_t>(rgb565 >> 8);
    }
    cleared_ = false; // A failing refresh may already have reached the controller.
    ready_ = expander_.WriteRingFrame(data);
    return ready_;
}

bool EspRingPort::Close() {
    ready_ = false;
    if (!owns_) return true;
    if (touched_ && !cleared_) {
        if (!Prepare() || !expander_.WriteRingFrame(Black)) return false;
        cleared_ = true;
    }
    if (!expander_.Release(Ring)) return false;
    owns_ = touched_ = cleared_ = false;
    return true;
}

}
