// SPDX-License-Identifier: MIT
#include "ring_port.h"
#include "motion_power.h"
#include <motion_sdk.h>
#include <array>
#include <cassert>
#include <cstring>
#include <iostream>
#include <thread>

struct i2c_bus {} bus;
struct i2c_dev {} device;
using namespace sion::agent;

namespace {
struct Fixture {
    std::array<uint8_t, 0x48> registers{};
    std::array<uint8_t, 0x48> initial{};
    std::array<uint8_t, 24> displayed{};
    bool attached = false;
    bool apply_on_error = false;
    bool corrupt_ram_read = false;
    bool check_frame_atomicity = false;
    bool frame_in_progress = false;
    int adds = 0, removes = 0, refreshes = 0;
    int step = 0, fail = 0;

    Fixture() {
        registers.fill(0xa5);
        registers[0x02] = 3;
        initial = registers;
    }
    bool Ok() { return ++step != fail; }
} f;

void CheckProtectedBytes(bool allow_servo) {
    for (size_t reg = 0; reg < f.registers.size(); reg++) {
        if (reg >= 0x30 || reg == 0x24) continue;
        uint8_t mask = 0;
        if (reg == 0x04 || reg == 0x06 || reg == 0x0a || reg == 0x0c || reg == 0x14) mask = 1 << 5;
        if (allow_servo && (reg == 0x03 || reg == 0x05 || reg == 0x07 || reg == 0x09 ||
                            reg == 0x0b || reg == 0x13)) mask = 1;
        assert(((f.registers[reg] ^ f.initial[reg]) & ~mask) == 0);
    }
}
}

esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t b, const i2c_device_config_t* c,
                                    i2c_master_dev_handle_t* out) {
    assert(b == &bus && !f.attached && c->device_address == 0x6f && c->scl_speed_hz == 100000);
    ++f.adds;
    if (!f.Ok()) return -1;
    f.attached = true;
    *out = &device;
    return ESP_OK;
}

esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t d) {
    assert(d == &device && f.attached);
    if (!f.Ok()) return -1;
    ++f.removes;
    f.attached = false;
    return ESP_OK;
}

esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t d, const uint8_t* reg, size_t n,
                                      uint8_t* out, size_t size, int timeout) {
    assert(d == &device && f.attached && n == 1 && timeout == 20);
    assert(size == 1 || (size == 24 && *reg == 0x30));
    if (f.frame_in_progress) assert(*reg == 0x30 && size == 24);
    if (!f.Ok()) return -1;
    if (*reg == 7) f.registers[7] = (f.registers[7] & 0xfe) | (f.registers[5] & 1);
    std::memcpy(out, f.registers.data() + *reg, size);
    if (f.corrupt_ram_read && *reg == 0x30) out[0] ^= 1;
    return ESP_OK;
}

esp_err_t i2c_master_transmit(i2c_master_dev_handle_t d, const uint8_t* wire, size_t size, int timeout) {
    assert(d == &device && f.attached && timeout == 20);
    assert(size == 2 || (size == 25 && wire[0] == 0x30));
    if (f.frame_in_progress) assert(wire[0] == 0x24 && wire[1] == 0x4c);
    if (f.check_frame_atomicity && size == 25) f.frame_in_progress = true;
    if (wire[0] == 0x24 && wire[1] == 0x4c) f.frame_in_progress = false;
    const bool ok = f.Ok();
    if (ok || f.apply_on_error) {
        std::memcpy(f.registers.data() + wire[0], wire + 1, size - 1);
        if (wire[0] == 0x24 && (wire[1] & 0x40)) {
            assert(wire[1] == 0x4c);
            ++f.refreshes;
            std::memcpy(f.displayed.data(), f.registers.data() + 0x30, f.displayed.size());
            f.registers[0x24] &= 0x3f;
        }
    }
    return ok ? ESP_OK : -1;
}

void vTaskDelay(TickType_t) {}

int main() {
    const std::array<uint8_t, 24> black{};
    EspRingPort::Frame colors{};
    colors[0] = {255, 0, 0};
    colors[1] = {0, 255, 0};
    colors[11] = {0, 0, 255};
    constexpr auto Servo = Py32Expander::Client::Servo;
    constexpr auto Ring = Py32Expander::Client::Ring;

    int opening_steps = 0;
    {
        Py32Expander shared;
        EspRingPort ring(shared), competitor(shared);
        assert(!ring.Show(colors));
        assert(ring.Open(&bus) && !competitor.Open(&bus));
        opening_steps = f.step;
        assert(f.displayed == black);
        assert(!shared.SetRingPinBit(0x05, true));
        assert(shared.Acquire(Servo, nullptr) == Py32Expander::Claim::Refused);
        assert(ring.Show(colors));
        assert(f.displayed[0] == 0 && f.displayed[1] == 0xf8);
        assert(f.displayed[2] == 0xe0 && f.displayed[3] == 0x07);
        assert(f.displayed[22] == 0x1f && f.displayed[23] == 0);
        assert(ring.Close() && f.displayed == black && f.removes == 1);
        CheckProtectedBytes(false);
    }
    {
        f = Fixture{};
        Py32Expander shared;
        EspServoPower motors(&bus, shared);
        EspRingPort ring(shared);
        assert(motors.Open() && motors.Enable() && motors.Ready());
        assert(ring.Open(&bus) && ring.Show(colors));
        assert(f.adds == 1 && motors.Ready());
        assert(!shared.SetServoBit(0x24, true));
        assert(ring.Close() && f.displayed == black && f.removes == 0 && motors.Ready());
        assert(motors.Close() && f.removes == 1 && !(f.registers[5] & 1));
        CheckProtectedBytes(true);
    }
    {
        f = Fixture{};
        Py32Expander shared;
        EspServoPower motors(&bus, shared);
        EspRingPort ring(shared);
        assert(ring.Open(&bus) && ring.Show(colors));
        assert(motors.Open() && motors.Enable());
        assert(motors.Close() && f.removes == 0 && !(f.registers[5] & 1));
        assert(ring.Show(colors) && ring.Close() && f.removes == 1);
        CheckProtectedBytes(true);
    }
    {
        f = Fixture{};
        Py32Expander shared;
        EspServoPower motors(&bus, shared);
        EspRingPort ring(shared);
        assert(ring.Open(&bus) && motors.Open() && motors.Enable());
        f.check_frame_atomicity = true;
        std::thread led([&] {
            for (int repeat = 0; repeat < 100; repeat++) assert(ring.Show(colors));
        });
        std::thread servo([&] {
            for (int repeat = 0; repeat < 100; repeat++) assert(motors.Ready());
        });
        led.join();
        servo.join();
        assert(!f.frame_in_progress && motors.Close() && ring.Close() && f.adds == 1);
        CheckProtectedBytes(true);
    }
    {
        f = Fixture{};
        Py32Expander shared;
        EspRingPort ring(shared);
        assert(ring.Open(&bus));
        f.apply_on_error = true;
        f.fail = f.step + 4; // Refresh reaches PY32 but the transmission reports failure.
        assert(!ring.Show(colors) && f.displayed != black && !ring.Show(colors));
        f.fail = 0;
        assert(ring.Close() && f.displayed == black && f.removes == 1);
    }
    for (bool applied : {false, true}) for (int failure = 2; failure <= opening_steps; failure++) {
        f = Fixture{};
        f.fail = failure;
        f.apply_on_error = applied;
        Py32Expander shared;
        EspRingPort ring(shared);
        assert(!ring.Open(&bus) && !ring.Show(colors));
        f.fail = 0;
        assert(ring.Close() && !f.attached && f.displayed == black);
        CheckProtectedBytes(false);
    }
    {
        f = Fixture{};
        Py32Expander shared;
        EspRingPort ring(shared), competitor(shared);
        assert(ring.Open(&bus) && ring.Show(colors));
        const auto refreshes = f.refreshes;
        f.corrupt_ram_read = true;
        assert(!ring.Show(colors) && f.refreshes == refreshes);
        assert(!ring.Close() && f.attached && !competitor.Open(&bus));
        f.corrupt_ram_read = false;
        assert(ring.Close() && f.displayed == black && !f.attached);
    }
    {
        f = Fixture{};
        f.fail = 1;
        Py32Expander shared;
        EspRingPort ring(shared);
        assert(!ring.Open(&bus) && !ring.Close());
        assert(shared.Acquire(Servo, &bus) == Py32Expander::Claim::Refused);
        assert(shared.Acquire(Ring, &bus) == Py32Expander::Claim::Refused);
        assert(f.adds == 1 && f.removes == 0);
    }
    std::cout << "PY32 ring: RGB565 payload, readback before refresh, two-client ownership, "
                 "zero on release and " << opening_steps - 1 << " initialization failure boundaries passed\n";
}
