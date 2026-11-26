// SPDX-License-Identifier: MIT
#include "ir_nec.h"
#include <cassert>
#include <cstdio>
using namespace sion::agent;
int main() {
    for (uint16_t address : {uint16_t(0x04), uint16_t(0x00ff), uint16_t(0x1234)}) {
        auto frame = NecFrame(address, 0x08);
        assert(frame.size() == 67 && frame[0].us == 9000 && frame[1].us == 4500 && frame.back().mark);
        IrCode code;
        assert(NecDecode(frame, code) && code.address == address && code.command == 0x08 && !code.repeat);
        // Real receivers stretch and shrink pulses; 20% still decodes.
        for (auto& pulse : frame) pulse.us = static_cast<uint16_t>(pulse.us * (pulse.mark ? 1.15 : 0.85));
        assert(NecDecode(frame, code) && code.address == address && code.command == 0x08);
    }
    // Classic NEC on the wire: address 0x04 then 0xfb, command 0x08 then 0xf7.
    auto frame = NecFrame(0x04, 0x08);
    assert(frame[3].us == 560 && frame[2 + 2 * 2 + 1].us == 1690);              // Bit 2 of 0x04 is set.
    IrCode code;
    assert(NecDecode(NecRepeat(), code) && code.repeat);
    frame[2 + 16 * 2 + 1].us = frame[2 + 16 * 2 + 1].us == 560 ? 1690 : 560;  // Corrupt the command.
    assert(!NecDecode(frame, code));
    assert(!NecDecode({{true, 9000}, {false, 4500}}, code));
    std::puts("NEC infrared: classic and extended addresses, repeat, timing tolerance and checksum passed");
}
