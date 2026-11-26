// SPDX-License-Identifier: MIT
#pragma once
#include "ambient_engine.h"

namespace sion::agent {

// Head touch pad. Register sequence and values follow the factory driver in
// m5stack/StackChan firmware/main/hal/drivers/Si12T/Si12T.cpp, as invoked by
// hal_head_touch.cpp: si12t_setup(SI12T_TYPE_LOW, SI12T_SENSITIVITY_LEVEL_3).
// The factory application repeats the same setup at every one of its boots,
// so nothing is restored on Close.
template<class Bus>
class Si12t final : public HeadTouchPort {
public:
    explicit Si12t(Bus& bus) : bus_(bus) {}

    bool Open() override {
        if (!bus_.Open()) return false;
        for (const auto& step : Setup)
            if (!bus_.Write(step.reg, step.value)) return false; // The engine closes the bus.
        return true;
    }

    HeadTouchSample Read() override {
        uint8_t state = 0;
        if (!bus_.Read(Output, &state, 1)) return {};
        return {state & 3, (state >> 2) & 3, (state >> 4) & 3};
    }

    bool Close() override { return bus_.Close(); }

private:
    struct Step { uint8_t reg, value; };
    static constexpr Step Setup[] = {
        // si12t_enable_channel: reference reset, channel hold and calibration hold off.
        {0x0a, 0x00}, {0x0b, 0x00}, {0x0c, 0x00}, {0x0d, 0x00}, {0x0e, 0x00}, {0x0f, 0x00},
        // si12t_set_ctrl2: software reset, then run. si12t_set_ctrl1: auto mode.
        {0x09, 0x0f}, {0x09, 0x07}, {0x08, 0x22},
        // si12t_set_sensitivity(LOW, LEVEL_3) on SENSITIVITY1..5.
        {0x02, 0x33}, {0x03, 0x33}, {0x04, 0x33}, {0x05, 0x33}, {0x06, 0x33},
    };
    static constexpr uint8_t Output = 0x10; // OUT1..OUT3, two bits each.
    Bus& bus_;
};

}
