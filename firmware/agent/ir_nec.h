// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <mutex>
#include <vector>

namespace sion::agent {
// NEC infrared frames (the manual's IR example uses IRremote's sendNEC):
// 9 ms mark, 4.5 ms space, 32 bits LSB first (address, then command and its
// inverse), each a 560 us mark and a 560 or 1690 us space, then a final mark.
// An address below 256 is sent with its inverse (classic NEC); larger ones as
// 16 bits (extended NEC), as IRremote does. A repeat is 9 ms, 2.25 ms, 560 us.
struct IrPulse { bool mark; uint16_t us; };
struct IrCode { uint16_t address=0; uint8_t command=0; bool repeat=false; uint64_t at=0; };

inline std::vector<IrPulse> NecFrame(uint16_t address, uint8_t command) {
    std::vector<IrPulse> out{{true,9000},{false,4500}};
    const uint32_t addr = address < 256 ? (address | (uint32_t(uint8_t(~address)) << 8)) : address;
    const uint32_t word = addr | (uint32_t(command) << 16) | (uint32_t(uint8_t(~command)) << 24);
    for (int bit = 0; bit < 32; ++bit) {
        out.push_back({true,560});
        out.push_back({false,static_cast<uint16_t>((word >> bit) & 1 ? 1690 : 560)});
    }
    out.push_back({true,560});
    return out;
}
inline std::vector<IrPulse> NecRepeat() { return {{true,9000},{false,2250},{true,560}}; }

// Durations as received: alternating mark/space starting with a mark.
inline bool NecDecode(const std::vector<IrPulse>& in, IrCode& code) {
    const auto near = [](uint16_t us, uint16_t want) { return us >= want * 3 / 4 && us <= want * 5 / 4; };
    if (in.size() >= 3 && in[0].mark && near(in[0].us, 9000) && !in[1].mark && near(in[1].us, 2250) && near(in[2].us, 560)) {
        code.repeat = true;
        return true;
    }
    if (in.size() < 66 || !in[0].mark || !near(in[0].us, 9000) || in[1].mark || !near(in[1].us, 4500)) return false;
    uint32_t word = 0;
    for (int bit = 0; bit < 32; ++bit) {
        const auto& mark = in[2 + bit * 2];
        const auto& space = in[3 + bit * 2];
        if (!mark.mark || !near(mark.us, 560) || space.mark) return false;
        if (near(space.us, 1690)) word |= 1u << bit;
        else if (!near(space.us, 560)) return false;
    }
    const uint8_t command = word >> 16, check = word >> 24;
    if (uint8_t(~command) != check) return false;
    const uint8_t low = word, high = word >> 8;
    code.address = uint8_t(~low) == high ? low : static_cast<uint16_t>(word & 0xffff);
    code.command = command;
    code.repeat = false;
    return true;
}

// Board side: queue a send (the IR worker transmits it) and hand over decoded codes.
struct IrPort {
    virtual ~IrPort() = default;
    virtual bool Queue(uint16_t address, uint8_t command, uint8_t repeats) = 0;
    // -1 nothing finished, 0 sent, 1 failed.
    virtual int TakeSendResult() = 0;
    virtual bool Take(IrCode& code) = 0;
};
}
