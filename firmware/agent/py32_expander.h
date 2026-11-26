// SPDX-License-Identifier: MIT
#pragma once
#include <cstddef>
#include <cstdint>
#include <driver/i2c_master.h>
#include <mutex>

namespace sion::agent {

// One handle for the board's default-address PY32. Clients own distinct
// register ranges and release independently. No destructor touches the bus.
class Py32Expander {
public:
    enum class Client : uint8_t { Servo = 1, Ring = 2 };
    enum class Claim { Refused, Ready, AllocationUnknown };

    Claim Acquire(Client client, i2c_master_bus_handle_t bus);
    bool Release(Client client);
    bool Version(Client client);
    bool ReadServo(uint8_t reg, uint8_t& value);
    bool SetServoBit(uint8_t reg, bool value);
    bool SetRingPinBit(uint8_t reg, bool value);
    bool ConfigureRing();
    bool WriteRingFrame(const uint8_t (&rgb565)[24]);

private:
    std::mutex mutex_;
    i2c_master_bus_handle_t bus_ = nullptr;
    i2c_master_dev_handle_t device_ = nullptr;
    uint8_t owners_ = 0;
    bool allocation_unknown_ = false;

    bool Owns(Client client) const;
    bool Read(uint8_t reg, uint8_t* data, size_t bytes);
    bool WriteByte(uint8_t reg, uint8_t value);
    bool SetBit(uint8_t reg, uint8_t mask, bool value);
};

Py32Expander& BoardPy32();

}
