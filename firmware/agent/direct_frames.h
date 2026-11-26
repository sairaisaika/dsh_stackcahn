// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>

namespace sion::agent {
// Frame-bank pictures sent straight to the LCD (wiki/head-coupled-view.md, v76).
//
// Through LVGL a full-screen frame took about 70 ms to redraw while holding the display
// lock, which the session loop also needs; at 20 frames a second the microphone queue
// overflowed and the link closed (v75). Here a worker copies the frame in bands into
// internal DMA buffers (swapping to the panel's byte order) and queues them to the panel
// without the lock. While frames are up, LVGL is paused so the two never write the panel
// at once; ending the mode resumes LVGL and redraws the face.
//
// Begin and End are called from the UI loop holding the LVGL lock. Show only hands the
// worker the newest request (latest wins); the pixels must stay valid until End returns.
#ifdef ESP_PLATFORM
bool DirectFramesBegin();
void DirectFramesShow(const uint8_t* pixels, uint16_t w, uint16_t h, uint16_t x, uint16_t y);
void DirectFramesEnd();
#else
inline bool DirectFramesBegin() { return true; }
inline void DirectFramesShow(const uint8_t*, uint16_t, uint16_t, uint16_t, uint16_t) {}
inline void DirectFramesEnd() {}
#endif
}
