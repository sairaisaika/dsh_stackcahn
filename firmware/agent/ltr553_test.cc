// SPDX-License-Identifier: MIT
#include "ltr553.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <functional>

using namespace sion::agent;

struct FixtureBus {
    std::array<uint8_t, 256> registers{};
    bool open = false;
    int fail_write_reg = -1, fail_write_value = -1;
    bool standby_sticks = false;
    unsigned reads = 0;
    std::function<void(uint8_t)> on_read;

    FixtureBus() {
        registers[0x80] = 0x19; // Previously active ALS at 48x.
        registers[0x81] = 0x0b; // Previously active PS at 32x.
        registers[0x86] = 0x92;
        registers[0x87] = 0x05;
    }
    bool Open() { assert(!open); open = true; return true; }
    bool Close() { open = false; return true; }
    bool Read(uint8_t reg, uint8_t* data, size_t size) {
        assert(open);
        ++reads;
        if (on_read) on_read(reg);
        if (reg == 0x88) { assert(size == 4); registers[0x8c] &= ~0x04; }
        if (reg == 0x8d) { assert(size == 2); registers[0x8c] &= ~0x01; }
        for (size_t index = 0; index < size; ++index) data[index] = registers[reg + index];
        return true;
    }
    bool Write(uint8_t reg, uint8_t value) {
        assert(open && (reg == 0x80 || reg == 0x81));
        registers[reg] = value;
        if (standby_sticks && reg == 0x81) registers[reg] |= 3;
        return reg != fail_write_reg || value != fail_write_value;
    }
};

int main() {
    FixtureBus bus;
    Ltr553 sensor(bus);
    AmbientEngine engine(sensor);

    engine.Pump(0);
    assert(!bus.open && bus.reads == 0);
    engine.Begin(1);
    engine.Pump(10);
    assert(bus.open && bus.registers[0x80] == 1 && bus.registers[0x81] == 0x23);
    const auto before = bus.reads;
    engine.Pump(759);
    assert(bus.reads == before && engine.Snapshot(1, 759).channel0 == -1);
    bus.registers[0x8c] = 5;
    bus.registers[0x88] = 0x34;
    bus.registers[0x89] = 0x12;
    bus.registers[0x8a] = 0xff;
    bus.registers[0x8b] = 0xff;
    bus.registers[0x8d] = 0xff;
    bus.registers[0x8e] = 0x07;
    engine.Pump(760);
    const auto reading = engine.Snapshot(1, 760);
    assert(reading.channel0 == 65535 && reading.channel1 == 0x1234 && reading.proximity == 2047);
    assert(engine.Snapshot(2, 760).proximity == -1 && engine.Snapshot(1, 2260).proximity == -1);

    bus.registers[0x8c] = 0x85; // Only PS can be used; ALS flagged invalid.
    bus.registers[0x8d] = 0;
    bus.registers[0x8e] = 0;
    engine.Pump(1510);
    assert(engine.Snapshot(1, 1510).channel0 == -1 && engine.Snapshot(1, 1510).proximity == 0);
    bus.registers[0x8c] = 5;
    bus.registers[0x8e] = 0x80; // Only ALS can be used; PS saturated.
    engine.Pump(2260);
    assert(engine.Snapshot(1, 2260).channel1 == 0x1234 && engine.Snapshot(1, 2260).proximity == -1);
    engine.Pump(3010);
    assert(engine.Snapshot(1, 3010).channel0 == -1); // Already consumed.
    bus.registers[0x8c] = 5;
    bus.on_read = [&](uint8_t reg) { if (reg == 0x8c) engine.Stop(2); };
    engine.Pump(3760); // Stop arrives while I2C is running, before the snapshot can be published.
    assert(engine.Snapshot(1, 3760).channel0 == -1 && engine.Stopped(2) == Result::Pending);
    bus.on_read = {};
    bus.standby_sticks = true;
    engine.Pump(3800);
    assert(engine.Stopped(2) == Result::Failed && bus.open);
    bus.standby_sticks = false;
    engine.Stop(3);
    engine.Pump(3850);
    assert(engine.Stopped(3) == Result::Done && !bus.open);
    assert(bus.registers[0x80] == 0x18 && bus.registers[0x81] == 0x08);

    bus.fail_write_reg = 0x81;
    bus.fail_write_value = 0x23;
    engine.Begin(4);
    engine.Pump(3900);
    assert(bus.open && bus.registers[0x81] == 0x23);
    engine.Stop(5);
    engine.Pump(3950);
    assert(engine.Stopped(5) == Result::Done && !bus.open && bus.registers[0x81] == 0x08);

    bus.registers[0x87] = 0xff;
    engine.Begin(6);
    engine.Pump(4000);
    engine.Pump(4050);
    assert(!bus.open && engine.Snapshot(6, 4050).proximity == -1);
    engine.Stop(7);
    assert(engine.Stopped(7) == Result::Done);
    std::puts("LTR553 state: fresh/invalid/saturated readings, in-flight Stop, partial-open cleanup, standby retry and missing identity passed");
}
