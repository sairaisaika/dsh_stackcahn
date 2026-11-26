// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>

namespace sion::agent::diagnostics {
enum class Lane : uint32_t { Boot, Ui, Usb, Audio, Network, Touch, Lvgl, Actions, Lcd, Count };
// Values are part of the debugger dump format. Append new values or bump Schema.
enum class Event : uint32_t {
    Boot = 1, StockCheck, StorageReady, HalEntry, HalReady, Workers, FirstScreen,
    UiWaitingLock, UiHandlingIntents, UiPollingCarrier, UiSessionTick, UiRendering, UiYield,
    UiIntent, CarrierSelected, CarrierConnected, CarrierClosed, SessionPhase,
    ReleasePending, HomeVerify, DeviceRestart,
    UsbDriverBegin, UsbDriverEnd, UsbWaitHost, UsbHostSeen, UsbTlsBegin, UsbTlsResult,
    UsbPumpBegin, UsbPumpExit, UsbDrain, UsbDriverRecover, UsbReleased,
    AudioOpening, AudioOpened, AudioReading, AudioWriting, AudioClosing, AudioClosed,
    AudioError, NetworkPhase, NetworkCleanup, UiFirstRender, ResourceCheck,
    ResourceStates, UsbTlsExit, AudioVolume, AudioPlaybackFence, UsbPairingRequest, UsbPairingReply,
    ResourceSample, ReleaseRequested, UiHeartbeat, UiInternalFree, UiInternalLargest,
    UiInternalLowWater, UiStackLowWater, UiExternalFree, UsbPairingQueued, UsbPairingDrain,
    UsbStandbyProbeSeen, UsbStandbyReadyQueued, UiHealthSample,
    TouchDown, TouchUp, TouchPosition, TouchReadError, TouchReadRecovered, TouchDriverAlive,
    TouchLvglDown, TouchLvglUp, TouchLvglAlive, UiActionQueued, UiActionStarted, UiActionFinished,
    PageBuildStart, PageBuilt, PageFlushStarted, PageFlushCompleted, PageContentChanged,
    MotionOpenFailed, MotionLimits, MotionTorqueProbe, MotionOpenAttempts,
    MotionServoInfo, SensorOpenFailed,
};
enum class UsbEnd : uint32_t { Closing, NoBus, PeerQuiet, PartialFrame, WriteTimeout, ReadError, FrameRejected, WriteError };
constexpr uint32_t Magic = 0x53494f4e;
constexpr uint32_t Schema = 2;
constexpr uint32_t Capacity = 32;

struct Entry {
    uint32_t sequence, boot, ms, event, detail;
};
struct LaneData {
    uint32_t latest;
    Entry checkpoint;
    Entry entries[Capacity];
};
struct Book {
    uint32_t magic, schema, bytes, boot;
    LaneData lanes[static_cast<uint32_t>(Lane::Count)];
};
static_assert(sizeof(Book) == 5992);

void Begin(volatile Book& book, uint32_t reset_reason, bool cold);
void Put(volatile Book& book, Lane lane, Event event, uint32_t ms, uint32_t detail, bool checkpoint);

constexpr uint32_t TracePair(uint16_t high, uint16_t low) {
    return (static_cast<uint32_t>(high) << 16) | low;
}
constexpr uint16_t NextTraceId(uint16_t current) {
    return current == UINT16_MAX ? 1 : static_cast<uint16_t>(current + 1);
}

// Called only by the board's FT6336 poll task. Consumer sees the ID carried with the HAL sample.
class TouchInputTrace {
public:
    uint16_t Sample(volatile Book& book, uint32_t ms, bool valid, bool pressed, int x, int y);
private:
    uint16_t gesture_ = 0;
    bool pressed_ = false;
    bool failing_ = false;
    uint32_t last_checkpoint_ms_ = 0;
};

// Called by the LVGL pointer reader under the LVGL lock.
class LvglInputTrace {
public:
    void Sample(volatile Book& book, uint32_t ms, bool pressed, uint16_t gesture);
    uint16_t gesture() const { return gesture_; }
private:
    uint16_t gesture_ = 0;
    bool pressed_ = false;
    uint32_t last_checkpoint_ms_ = 0;
};

#ifdef ESP_PLATFORM
void StartDeviceTrace();
void Record(Lane lane, Event event, uint32_t detail = 0);
void Checkpoint(Lane lane, Event event, uint32_t detail = 0);
void RecordUiHealth(uint32_t longest_gap_ms);
uint16_t TrackDriverTouch(bool valid, bool pressed = false, int x = 0, int y = 0);
void TrackLvglTouch(bool pressed, uint16_t gesture);
uint16_t LvglTouchId();
#else
inline void StartDeviceTrace() {}
inline void Record(Lane, Event, uint32_t = 0) {}
inline void Checkpoint(Lane, Event, uint32_t = 0) {}
inline void RecordUiHealth(uint32_t) {}
inline uint16_t LvglTouchId() { return 0; }
#endif

// Both accesses use the display lock. Newer pages can replace earlier pending pages.
void SetPageForFlush(uint16_t revision);
uint16_t TakePageForFlush();
}
