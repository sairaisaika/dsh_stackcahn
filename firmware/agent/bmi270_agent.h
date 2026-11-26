// SPDX-License-Identifier: MIT
#pragma once
#include "ambient_engine.h"
#include <cstddef>

namespace sion::agent {

// Register layout from the BMI270 data sheet. The Bus supplies Bosch's
// initialization routine for a sensor whose configuration has not been loaded.
template<class Bus>
class Bmi270Agent final : public ImuPort {
public:
    explicit Bmi270Agent(Bus& bus) : bus_(bus) {}

    // Diagnostic only. Open: 0 ok, 1 bus, 2 chip id read, 3 wrong chip id,
    // 4 status read, 5 config load, 6 saved settings read, 7 configure.
    uint8_t OpenFailure() const { return open_failure_; }
    // Consecutive failed reads since the last good one: not ready / bus error.
    uint32_t NotReady() const { return not_ready_; }
    uint32_t ReadErrors() const { return read_errors_; }

    bool Open() override {
        uint8_t id = 0, status = 0;
        not_ready_ = read_errors_ = 0;
        const auto fail = [&](uint8_t step) { open_failure_ = step; return false; };
        if (!bus_.Open()) return fail(1);
        if (!bus_.Read(0x00, &id, 1)) return fail(2);
        if (id != 0x24) return fail(3);
        if (!bus_.Read(0x21, &status, 1)) return fail(4);
        if ((status & 0x0f) != 1 && !bus_.Initialize()) return fail(5);
        if (!bus_.Read(PowerConfig, saved_power_.data(), saved_power_.size()) ||
            !bus_.Read(AccelConfig, saved_config_.data(), saved_config_.size())) return fail(6);
        restore_ = true;
        // Match the factory ranges and sample rates: ±2 g, ±2000 degrees/s, 100 Hz.
        const std::array<uint8_t, 4> active_config{0xa8, 0x00, 0xe8, 0x00};
        if (!Configure(active_config, saved_power_[0] & ~AdvancedPowerSave, saved_power_[1] | AccelAndGyro)) return fail(7);
        open_failure_ = 0;
        // Optional: the BMM150 behind the auxiliary interface. Any failure puts
        // the auxiliary registers back and leaves accelerometer and gyro as they are.
        mag_on_ = OpenMagnetometer();
        mag_tick_ = 0;
        return true;
    }
    bool MagnetometerOn() const { return mag_on_; }

    ImuSample Read() override {
        uint8_t ready = 0, data[12]{};
        if (!bus_.Read(0x03, &ready, 1)) { ++read_errors_; return {}; }
        if ((ready & 0xc0) != 0xc0) { ++not_ready_; return {}; }
        if (!bus_.Read(0x0c, data, sizeof data)) { ++read_errors_; return {}; }
        not_ready_ = read_errors_ = 0;
        if (mag_on_ && mag_tick_++ % 5 == 0) {
            // About every 100 ms (the BMM150 runs at 10 Hz): X, Y, Z and RHALL.
            uint8_t raw[8]{};
            mag_valid_ = AuxRead(0x42, raw);
            if (mag_valid_) {
                const auto field = [&](int lsb, int shift, int bits) {
                    int value = ((raw[lsb + 1] << 8) | raw[lsb]) >> shift;
                    return value >= (1 << (bits - 1)) ? value - (1 << bits) : value;
                };
                mag_ = {field(0, 3, 13), field(2, 3, 13), field(4, 1, 15)};
            }
        }
        ImuSample sample;
        for (size_t i = 0; i < sample.axes.size(); ++i) {
            const int word = data[i*2] | (data[i*2+1] << 8);
            sample.axes[i] = word >= 0x8000 ? word - 0x10000 : word;
        }
        sample.valid = true;
        sample.mag = mag_;
        sample.mag_valid = mag_on_ && mag_valid_;
        return sample;
    }

    bool Close() override {
        if (mag_on_) { CloseMagnetometer(); mag_on_ = false; }
        if (restore_ && !Configure(saved_config_, saved_power_[0], saved_power_[1])) return false;
        restore_ = false;
        return bus_.Close();
    }

private:
    static constexpr uint8_t AccelConfig = 0x40, PowerConfig = 0x7c, PowerControl = 0x7d;
    static constexpr uint8_t AdvancedPowerSave = 0x01, AccelAndGyro = 0x06;
    Bus& bus_;
    std::array<uint8_t, 2> saved_power_{};
    std::array<uint8_t, 4> saved_config_{};
    bool restore_ = false;
    bool mag_on_ = false, mag_valid_ = false;
    unsigned mag_tick_ = 0;
    std::array<int, 3> mag_{};
    uint8_t saved_if_conf_ = 0, saved_aux_id_ = 0, saved_aux_conf_ = 0, saved_aux_power_ = 0;
    static constexpr uint8_t IfConf = 0x6b, AuxDevId = 0x4b, AuxIfConf = 0x4c, AuxRdAddr = 0x4d,
        AuxWrAddr = 0x4e, AuxWrData = 0x4f, AuxData = 0x04, Status = 0x03;
    static constexpr uint8_t AuxIfEnable = 0x20, AuxPower = 0x01, AuxBusy = 0x04, Bmm150Address = 0x10;
    uint8_t open_failure_ = 0;

    bool AuxIdle() {
        for (int i = 0; i < 20; ++i) {
            uint8_t status = 0;
            if (!bus_.Read(Status, &status, 1)) return false;
            if (!(status & AuxBusy)) return true;
            bus_.WaitForRegisterWrite();
        }
        return false;
    }
    bool AuxWrite(uint8_t reg, uint8_t value) {
        return AuxIdle() && Write(AuxWrData, value) && Write(AuxWrAddr, reg) && AuxIdle();
    }
    bool AuxRead(uint8_t reg, uint8_t* out8) {   // Always an 8-byte burst.
        return AuxIdle() && Write(AuxRdAddr, reg) && AuxIdle() && bus_.Read(AuxData, out8, 8);
    }
    bool OpenMagnetometer() {
        uint8_t control = 0;
        if (!bus_.Read(IfConf, &saved_if_conf_, 1) || !bus_.Read(AuxDevId, &saved_aux_id_, 1) ||
            !bus_.Read(AuxIfConf, &saved_aux_conf_, 1) || !bus_.Read(PowerControl, &control, 1)) return false;
        saved_aux_power_ = control & AuxPower;
        uint8_t id[8]{};
        const bool ok = Write(IfConf, saved_if_conf_ | AuxIfEnable) && Write(PowerControl, control | AuxPower) &&
            Write(AuxDevId, Bmm150Address << 1) && Write(AuxIfConf, 0x80 | (3 << 2)) &&   // Manual, 8-byte reads.
            AuxWrite(0x4b, 0x01) && AuxWrite(0x4b, 0x01) &&                               // BMM150 power on (twice: settle).
            AuxRead(0x40, id) && id[0] == 0x32 &&                                          // BMM150 chip id.
            AuxWrite(0x4c, 0x00);                                                          // Normal mode, 10 Hz.
        if (!ok) CloseMagnetometer();
        return ok;
    }
    void CloseMagnetometer() {
        AuxWrite(0x4b, 0x00);   // BMM150 back to suspend (best effort).
        uint8_t control = 0;
        Write(AuxIfConf, saved_aux_conf_);
        Write(AuxDevId, saved_aux_id_);
        if (bus_.Read(PowerControl, &control, 1)) Write(PowerControl, (control & ~AuxPower) | saved_aux_power_);
        Write(IfConf, saved_if_conf_);
    }
    uint32_t not_ready_ = 0, read_errors_ = 0;

    bool Configure(const std::array<uint8_t, 4>& config, uint8_t mode, uint8_t control) {
        // Turn off advanced power save before writing the configuration, and
        // hold only our two axes while updating their range and sample rate.
        if (!Write(PowerConfig, mode & ~AdvancedPowerSave) || !Write(PowerControl, control & ~AccelAndGyro)) return false;
        for (size_t i = 0; i < config.size(); ++i) {
            if (!Write(static_cast<uint8_t>(AccelConfig + i), config[i])) return false;
        }
        if (!Write(PowerControl, control) || !Write(PowerConfig, mode)) return false;
        std::array<uint8_t, 4> actual_config{};
        std::array<uint8_t, 2> actual_power{};
        return bus_.Read(AccelConfig, actual_config.data(), actual_config.size()) && actual_config == config &&
               bus_.Read(PowerConfig, actual_power.data(), actual_power.size()) &&
               actual_power[0] == mode && actual_power[1] == control;
    }

    bool Write(uint8_t reg, uint8_t value) {
        const bool written = bus_.Write(reg, value);
        bus_.WaitForRegisterWrite();
        return written;
    }
};

}
