// SPDX-License-Identifier: MIT
#include "py32_expander.h"
#include <algorithm>

namespace sion::agent {
namespace {
constexpr uint8_t VersionRegister = 0x02;
constexpr uint8_t LedConfig = 0x24;
constexpr uint8_t LedMemory = 0x30;
constexpr uint8_t LedCount = 12;
constexpr uint8_t Refresh = 1 << 6;
constexpr int TimeoutMs = 20;

uint8_t Mask(Py32Expander::Client client) { return static_cast<uint8_t>(client); }
}

Py32Expander& BoardPy32() {
    static Py32Expander expander;
    return expander;
}

Py32Expander::Claim Py32Expander::Acquire(Client client, i2c_master_bus_handle_t bus) {
    std::lock_guard lock(mutex_);
    if (!bus || allocation_unknown_ || Owns(client) || (bus_ && bus_ != bus)) return Claim::Refused;
    owners_ |= Mask(client);
    if (device_) return Claim::Ready;

    i2c_device_config_t config{};
    config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    config.device_address = 0x6f;
    config.scl_speed_hz = 100000;
    bus_ = bus;
    if (i2c_master_bus_add_device(bus_, &config, &device_) == ESP_OK) return Claim::Ready;
    // The pinned SDK can lose its rollback status without publishing a handle.
    // Never issue a second allocation against potentially retained state.
    allocation_unknown_ = true;
    return Claim::AllocationUnknown;
}

bool Py32Expander::Release(Client client) {
    std::lock_guard lock(mutex_);
    if (!Owns(client) || allocation_unknown_) return false;
    if (owners_ == Mask(client)) {
        if (!device_ || i2c_master_bus_rm_device(device_) != ESP_OK) return false;
        device_ = nullptr;
        bus_ = nullptr;
    }
    owners_ &= ~Mask(client);
    return true;
}

bool Py32Expander::Owns(Client client) const { return (owners_ & Mask(client)) != 0; }

bool Py32Expander::Read(uint8_t reg, uint8_t* data, size_t bytes) {
    return device_ && !allocation_unknown_ &&
        i2c_master_transmit_receive(device_, &reg, 1, data, bytes, TimeoutMs) == ESP_OK;
}

bool Py32Expander::WriteByte(uint8_t reg, uint8_t value) {
    const uint8_t wire[]{reg,value};
    return device_ && !allocation_unknown_ &&
        i2c_master_transmit(device_, wire, sizeof(wire), TimeoutMs) == ESP_OK;
}

bool Py32Expander::SetBit(uint8_t reg, uint8_t mask, bool value) {
    uint8_t before = 0;
    if (!Read(reg, &before, 1)) return false;
    const uint8_t wanted = static_cast<uint8_t>((before & ~mask) | (value ? mask : 0));
    uint8_t after = 0;
    return WriteByte(reg, wanted) && Read(reg, &after, 1) && after == wanted;
}

bool Py32Expander::Version(Client client) {
    std::lock_guard lock(mutex_);
    uint8_t version = 0;
    return Owns(client) && Read(VersionRegister, &version, 1) && version != 0 && version != 255;
}

bool Py32Expander::ReadServo(uint8_t reg, uint8_t& value) {
    std::lock_guard lock(mutex_);
    uint8_t result = 0;
    if (!Owns(Client::Servo) || (reg != 0x03 && reg != 0x05 && reg != 0x07)
        || !Read(reg, &result, 1)) return false;
    value = result;
    return true;
}

bool Py32Expander::SetServoBit(uint8_t reg, bool value) {
    std::lock_guard lock(mutex_);
    return Owns(Client::Servo) &&
        (reg == 0x03 || reg == 0x05 || reg == 0x09 || reg == 0x0b || reg == 0x13) &&
        SetBit(reg, 1, value);
}

bool Py32Expander::SetRingPinBit(uint8_t reg, bool value) {
    std::lock_guard lock(mutex_);
    return Owns(Client::Ring) &&
        (reg == 0x04 || reg == 0x06 || reg == 0x0a || reg == 0x0c || reg == 0x14) &&
        SetBit(reg, 1 << 5, value);
}

bool Py32Expander::ConfigureRing() {
    std::lock_guard lock(mutex_);
    uint8_t config = 0;
    return Owns(Client::Ring) && WriteByte(LedConfig, LedCount) &&
        Read(LedConfig, &config, 1) && (config & 0x3f) == LedCount;
}

bool Py32Expander::WriteRingFrame(const uint8_t (&rgb565)[24]) {
    std::lock_guard lock(mutex_);
    uint8_t config = 0;
    if (!Owns(Client::Ring) || !Read(LedConfig, &config, 1) || (config & 0x3f) != LedCount) return false;
    uint8_t wire[1 + sizeof(rgb565)]{LedMemory};
    std::copy_n(rgb565, sizeof(rgb565), wire + 1);
    uint8_t readback[sizeof(rgb565)]{};
    return i2c_master_transmit(device_, wire, sizeof(wire), TimeoutMs) == ESP_OK &&
        Read(LedMemory, readback, sizeof(readback)) &&
        std::equal(readback, readback + sizeof(readback), rgb565) &&
        WriteByte(LedConfig, LedCount | Refresh);
}

}
