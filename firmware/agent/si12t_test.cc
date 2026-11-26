// SPDX-License-Identifier: MIT
#include "si12t.h"
#include <cassert>
#include <cstddef>
#include <cstdio>
#include <functional>
#include <utility>
#include <vector>

using namespace sion::agent;

struct FixtureBus {
    bool open = false, output_ok = true, write_ok = true, detach_ok = true;
    uint8_t output = 0xf9;
    unsigned output_reads = 0;
    std::vector<std::pair<uint8_t, uint8_t>> writes;
    std::function<void()> on_output;

    bool Open() { assert(!open); return open = true; }
    bool Read(uint8_t reg, uint8_t* data, size_t size) {
        assert(open && size == 1 && reg == 0x10);
        ++output_reads;
        if (on_output) on_output();
        *data = output;
        return output_ok;
    }
    bool Write(uint8_t reg, uint8_t value) {
        assert(open);
        writes.emplace_back(reg, value);
        return write_ok;
    }
    bool Close() {
        if (!detach_ok) return false;
        open = false;
        return true;
    }
};

int main() {
    FixtureBus bus;
    Si12t sensor(bus);
    HeadTouchEngine engine(sensor);
    // The factory driver's si12t_setup(TYPE_LOW, LEVEL_3), in its order.
    const std::vector<std::pair<uint8_t, uint8_t>> factory_setup = {
        {0x0a, 0x00}, {0x0b, 0x00}, {0x0c, 0x00}, {0x0d, 0x00}, {0x0e, 0x00}, {0x0f, 0x00},
        {0x09, 0x0f}, {0x09, 0x07}, {0x08, 0x22},
        {0x02, 0x33}, {0x03, 0x33}, {0x04, 0x33}, {0x05, 0x33}, {0x06, 0x33}};

    engine.Pump(0);
    assert(!bus.open && bus.writes.empty());
    engine.Begin(1);
    engine.Pump(10);
    assert(bus.open && bus.writes == factory_setup);
    engine.Pump(209);
    assert(bus.output_reads == 0);
    engine.Pump(210);
    const auto sample = engine.Snapshot(1, 210);
    assert(sample.channel1 == 1 && sample.channel2 == 2 && sample.channel3 == 3);
    assert(engine.Snapshot(1, 510).channel1 == -1 && engine.Snapshot(2, 210).channel1 == -1);
    bus.output = 0;
    engine.Pump(259);
    assert(bus.output_reads == 1);
    engine.Pump(260);
    assert(engine.Snapshot(1, 260).channel1 == 0);
    bus.output_ok = false;
    engine.Pump(310);
    assert(engine.Snapshot(1, 310).channel1 == -1);
    bus.output_ok = true;
    bus.on_output = [&] { engine.Stop(2); };
    engine.Pump(360);
    assert(engine.Snapshot(1, 360).channel1 == -1 && engine.Stopped(2) == Result::Pending);
    bus.on_output = {};
    bus.detach_ok = false;
    engine.Pump(361);
    assert(engine.Stopped(2) == Result::Failed && bus.open);
    bus.detach_ok = true;
    engine.Stop(2);
    engine.Pump(362);
    assert(engine.Stopped(2) == Result::Done && !bus.open);

    // A failed setup write never samples; the engine detaches the bus.
    bus.writes.clear();
    bus.write_ok = false;
    engine.Begin(3);
    engine.Pump(400);
    assert(bus.writes.size() == 1 && engine.Snapshot(3, 400).channel2 == -1);
    engine.Pump(401);
    assert(!bus.open);

    // Every later session repeats the whole factory setup.
    bus.write_ok = true;
    bus.writes.clear();
    engine.Begin(4);
    engine.Pump(410);
    assert(bus.open && bus.writes == factory_setup);
    engine.Stop(5);
    engine.Pump(411);
    assert(engine.Stopped(5) == Result::Done && !bus.open);
    std::puts("Si12T factory setup sequence, sampling and freshness, fenced reads, failed setup/detach and retry passed");
}
