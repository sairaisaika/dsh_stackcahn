// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <mutex>

namespace sion::agent {
// Battery monitor INA226 (I2C 0x41, 0.01 ohm shunt per the official BSP).
// Read-only: the power-on configuration already measures continuously, so no
// register is written. Bus voltage LSB 1.25 mV; shunt voltage LSB 2.5 uV, which
// over 0.01 ohm is 0.25 mA. Which sign means charging is a calibration item.
struct PowerSample { bool valid=false; uint16_t bus_raw=0; int16_t shunt_raw=0; };

template<class Bus>
class Ina226Monitor {
public:
    static constexpr uint64_t kReadEveryMs=100,kReopenEveryMs=5000,kMaxAgeMs=1000;
    explicit Ina226Monitor(Bus& bus):bus_(bus){}
    // Sensor worker only.
    void Pump(uint64_t now) {
        if(!open_) {
            if(now<retry_at_)return;
            retry_at_=now+kReopenEveryMs;
            uint8_t id[2]{},die[2]{};
            if(!bus_.Open())return;
            if(!bus_.Read(0xfe,id,2)||Word(id)!=0x5449||!bus_.Read(0xff,die,2)||(Word(die)>>4)!=0x226){
                ++open_failures_;bus_.Close();return;
            }
            open_=true;
        }
        if(now<next_read_)return;
        next_read_=now+kReadEveryMs;
        uint8_t bus[2]{},shunt[2]{};
        if(!bus_.Read(0x02,bus,2)||!bus_.Read(0x01,shunt,2)) {
            ++read_errors_;
            if(read_errors_>=10){bus_.Close();open_=false;read_errors_=0;}
            return;
        }
        read_errors_=0;
        std::lock_guard<std::mutex> lock(mutex_);
        sample_={true,Word(bus),static_cast<int16_t>(Word(shunt))};sampled_at_=now;
    }
    PowerSample Latest(uint64_t now) const {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!sample_.valid||now<sampled_at_||now-sampled_at_>=kMaxAgeMs)return {};
        return sample_;
    }
    unsigned OpenFailures() const {return open_failures_;}
private:
    static uint16_t Word(const uint8_t* b){return static_cast<uint16_t>((b[0]<<8)|b[1]);}
    Bus& bus_;
    mutable std::mutex mutex_;
    PowerSample sample_{};
    uint64_t sampled_at_=0,next_read_=0,retry_at_=0;
    bool open_=false;
    unsigned read_errors_=0,open_failures_=0;
};
// Implemented by the board runtime; nullptr in builds without it.
struct PowerReader { virtual ~PowerReader()=default; virtual PowerSample Latest(uint64_t now) const=0; };
}
