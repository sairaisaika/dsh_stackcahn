// SPDX-License-Identifier: MIT
#pragma once
#include "ambient_engine.h"
#include <cstddef>

namespace sion::agent {

// Bus has Open(), Read(register, bytes, size), Write(register, byte), Close().
template<class Bus>
class Ltr553 final : public AmbientPort {
public:
    explicit Ltr553(Bus& bus) : bus_(bus) {}

    bool Open() override {
        if (!bus_.Open()) return false;
        uint8_t id[2]{}, modes[2]{};
        if (!bus_.Read(0x86, id, sizeof id) || (id[0] >> 4) != 9 || id[1] != 5 ||
            !bus_.Read(0x80, modes, sizeof modes)) return false;
        // Retain the previously configured gains and saturation mode for standby.
        als_standby_ = modes[0] & 0x1c;
        ps_standby_ = modes[1] & 0x2c;
        restore_ = true; // An I2C error can be reported after a write has reached the part.
        uint8_t light[4]{}, proximity[2]{};
        return Standby() && bus_.Read(0x88, light, sizeof light) &&
            bus_.Read(0x8d, proximity, sizeof proximity) &&
            bus_.Write(0x80, 0x01) && // ALS active at 1x gain.
            bus_.Write(0x81, 0x23);   // PS active at 16x gain, saturation flag enabled.
    }

    AmbientSample Read() override {
        AmbientSample sample;
        uint8_t status = 0;
        if (!bus_.Read(0x8c, &status, 1)) return sample;
        // Read CH1 before CH0 to consume a single ALS conversion.
        uint8_t light[4]{}, proximity[2]{};
        if ((status & 0x04) && bus_.Read(0x88, light, sizeof light) && !(status & 0xf0)) {
            sample.channel0 = light[2] | (light[3] << 8);
            sample.channel1 = light[0] | (light[1] << 8);
        }
        if ((status & 0x01) && bus_.Read(0x8d, proximity, sizeof proximity) && !(proximity[1] & 0x80))
            sample.proximity = proximity[0] | ((proximity[1] & 0x07) << 8);
        return sample;
    }

    bool Close() override {
        if (restore_ && !Standby()) return false;
        restore_ = false;
        return bus_.Close();
    }

private:
    Bus& bus_;
    uint8_t als_standby_ = 0, ps_standby_ = 0;
    bool restore_ = false;

    bool Standby() {
        // Attempt both writes even if one channel fails.
        const bool ps = bus_.Write(0x81, ps_standby_);
        const bool als = bus_.Write(0x80, als_standby_);
        uint8_t modes[2]{};
        return ps && als && bus_.Read(0x80, modes, sizeof modes) &&
            (modes[0] & 0x1d) == als_standby_ && (modes[1] & 0x2f) == ps_standby_;
    }
};

}
