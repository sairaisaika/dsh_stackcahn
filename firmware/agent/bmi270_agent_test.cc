// SPDX-License-Identifier: MIT
#include "bmi270_agent.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <functional>

using namespace sion::agent;

struct FixtureBus {
    std::array<uint8_t, 256> registers{};
    bool open = false, write_ok = true, power_readback_wrong = false;
    unsigned initializations = 0;
    std::function<void()> on_sample;

    bool Open() { assert(!open); return open = true; }
    bool Initialize() { ++initializations; registers[0x21] = 1; return true; }
    bool Read(uint8_t reg, uint8_t* target, size_t size) {
        assert(open && reg+size <= registers.size());
        if (reg == 0x0c && on_sample) on_sample();
        std::memcpy(target, registers.data()+reg, size);
        if (reg == 0x7c && power_readback_wrong) target[0] ^= 1;
        return true;
    }
    std::function<void(uint8_t, uint8_t)> on_write;
    bool Write(uint8_t reg, uint8_t value) { registers[reg] = value; if (on_write) on_write(reg, value); return write_ok; }
    void WaitForRegisterWrite() {}
    bool Close() { open = false; return true; }
};

int main() {
    FixtureBus bus;
    Bmi270Agent sensor(bus);
    ImuEngine engine(sensor);
    auto& r = bus.registers;
    r[0] = 0x24;
    r[0x7c] = 3;
    r[0x7d] = 9;
    r[0x40] = 0xa7; r[0x41] = 1; r[0x42] = 0xe7; r[0x43] = 1;
    engine.Begin(1);
    engine.Pump(10);
    assert(bus.initializations == 1 && r[0x7c] == 2 && r[0x7d] == 15);
    assert(r[0x40] == 0xa8 && r[0x41] == 0 && r[0x42] == 0xe8 && r[0x43] == 0);

    r[0x03] = 0x80;
    engine.Pump(110);
    assert(!engine.Snapshot(1, 110).valid);
    r[0x03] = 0xc0;
    r[0x0d] = 0x80;
    r[0x0e] = 0xff; r[0x0f] = 0xff;
    r[0x16] = 0xff; r[0x17] = 0x7f;
    engine.Pump(210);
    const auto sample = engine.Snapshot(1, 210);
    const std::array<int, 6> expected{-32768, -1, 0, 0, 0, 32767};
    assert(sample.valid && sample.axes == expected);
    assert(!engine.Snapshot(1, 610).valid);

    bus.on_sample = [&] { engine.Stop(2); };
    engine.Pump(310);
    assert(!engine.Snapshot(1, 310).valid && engine.Stopped(2) == Result::Pending);
    bus.power_readback_wrong = true;
    engine.Pump(311);
    assert(bus.open && engine.Stopped(2) == Result::Failed);
    bus.power_readback_wrong = false;
    engine.Stop(2);
    engine.Pump(312);
    assert(!bus.open && engine.Stopped(2) == Result::Done);
    assert(r[0x7c] == 3 && r[0x7d] == 9 && r[0x40] == 0xa7 && r[0x41] == 1 && r[0x42] == 0xe7 && r[0x43] == 1);

    bus.write_ok = false;
    engine.Begin(3);
    engine.Pump(400);
    assert(bus.initializations == 1 && bus.open && r[0x7c] == 2);
    bus.write_ok = true;
    engine.Pump(401);
    assert(!bus.open && r[0x7c] == 3 && r[0x7d] == 9);
    // v67: a failed open is recorded and retried for the same owner, bounded.
    assert(sensor.OpenFailure() == 7 && engine.OpenFailures() == 1);
    engine.Pump(402);
    assert(!bus.open);                                  // Waits before retrying.
    engine.Pump(401 + ImuEngine::OpenRetryMs);
    assert(bus.open && sensor.OpenFailure() == 0);      // Second attempt opened.
    r[0x03] = 0;
    for (uint64_t t = 2600; t < 2600 + 10*100; t += 100) engine.Pump(t);
    assert(sensor.NotReady() == 10 && sensor.ReadErrors() == 0);
    r[0x03] = 0xc0;
    engine.Pump(3700);
    assert(sensor.NotReady() == 0 && engine.Snapshot(3, 3700).valid);
    engine.Stop(4);
    engine.Pump(3701);
    assert(!bus.open && engine.Stopped(4) == Result::Done);

    r[0] = 0x25;                                        // Wrong chip: gives up after the retries.
    engine.Begin(5);
    uint64_t t = 5000;
    for (unsigned i = 0; i < 40; ++i, t += 1000) engine.Pump(t);
    assert(sensor.OpenFailure() == 3 && engine.OpenFailures() == ImuEngine::OpenRetries + 1);
    assert(!bus.open && engine.Stopped(4) == Result::Pending && !engine.Snapshot(5, t).valid);
    r[0] = 0x24;
    engine.Pump(t + 100000);
    assert(!bus.open);                                  // No further attempts this session.
    { // BMM150 behind the auxiliary interface: verified by chip id, read about
      // every fifth sample, and every auxiliary register put back on close.
        FixtureBus aux;Bmi270Agent mag_sensor(aux);ImuEngine mag_engine(mag_sensor);
        auto& a=aux.registers;a[0]=0x24;a[0x21]=1;a[0x7c]=3;a[0x7d]=8;a[0x6b]=0x01;a[0x4b]=0x20;a[0x4c]=0x03;
        std::array<uint8_t,256> bmm{};bmm[0x40]=0x32;
        // x = -2 (13-bit), y = 100, z = -300 (15-bit), each left-aligned in its LSB/MSB pair.
        const auto put=[&](int reg,int value,int shift){const int raw=(value&((1<<(16-shift))-1))<<shift;bmm[reg]=raw&0xff;bmm[reg+1]=raw>>8;};
        put(0x42,-2,3);put(0x44,100,3);put(0x46,-300,1);
        aux.on_write=[&](uint8_t reg,uint8_t value){
            if(reg==0x4d)for(int i=0;i<8;++i)a[0x04+i]=bmm[value+i];   // Manual read into AUX_DATA.
            if(reg==0x4e)bmm[value]=a[0x4f];                          // Manual write.
        };
        mag_engine.Begin(1);mag_engine.Pump(0);
        assert(mag_sensor.MagnetometerOn()&&bmm[0x4b]==1&&bmm[0x4c]==0&&(a[0x7d]&1)&&(a[0x6b]&0x20));
        a[0x03]=0xc0;mag_engine.Pump(100);
        const auto first=mag_engine.Snapshot(1,100);
        assert(first.valid&&first.mag_valid&&first.mag==(std::array<int,3>{-2,100,-300}));
        mag_engine.Stop(2);mag_engine.Pump(200);
        assert(!aux.open&&bmm[0x4b]==0&&a[0x6b]==0x01&&a[0x4b]==0x20&&a[0x4c]==0x03&&!(a[0x7d]&1));
        // No BMM150 answering: the IMU still opens, without a magnetometer.
        FixtureBus plain;Bmi270Agent plain_sensor(plain);ImuEngine plain_engine(plain_sensor);
        plain.registers[0]=0x24;plain.registers[0x21]=1;plain.registers[0x6b]=0x01;
        plain_engine.Begin(1);plain_engine.Pump(0);plain.registers[0x03]=0xc0;plain_engine.Pump(100);
        const auto only=plain_engine.Snapshot(1,100);
        assert(!plain_sensor.MagnetometerOn()&&only.valid&&!only.mag_valid&&plain.registers[0x6b]==0x01);
    }
    std::puts("BMI270 readiness, signed axes, optional BMM150 via the aux interface, initialization, Stop fencing and register restoration passed");
}
