// SPDX-License-Identifier: MIT
#pragma once
#include "audio_engine.h"
#include "camera_engine.h"
#include "motion_engine.h"
#include "ring_engine.h"
#include <algorithm>
namespace sion::agent {
enum class Appearance : uint8_t { Default, Fish, Text, Whale };
struct Preferences {
    uint8_t volume = 40;
    bool muted = false, microphone_disabled = false;
    uint32_t revision = 0;
    bool camera_allowed = false, motion_allowed = false, ring_allowed = false;
    Appearance appearance = Appearance::Default;
    // Stay ready on the face page: the device keeps a link to the Host, and the
    // Host decides when it is being addressed. Nothing is recognised here.
    // On by default: the body stays reachable unless someone turns it off.
    bool wake_standby = true;
    int EffectiveVolume() const { return muted ? 0 : volume; }
};
using PreferenceRecord = std::array<uint8_t, 12>;
inline uint32_t PreferenceCrc(const uint8_t* bytes, size_t size) {
    uint32_t crc = 0xffffffff;
    for (size_t i = 0; i < size; ++i) {
        crc ^= bytes[i];
        for (int j = 0; j < 8; ++j) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1)));
    }
    return ~crc;
}
inline PreferenceRecord EncodePreferences(const Preferences& p) {
    const auto appearance = static_cast<uint8_t>(p.appearance);
    // Versions 5 and 6 (Fish/Text readable by earlier builds; explicit Default
    // after the whale face) are still read but no longer written.
    // Version 7 adds the standby flag and is written when it is set. Standby is
    // on unless chosen otherwise, so an explicit "off" is version 8; versions
    // 1..6 predate the choice and read as on.
    PreferenceRecord bytes{static_cast<uint8_t>(p.wake_standby ? 7 : 8), p.volume, static_cast<uint8_t>((p.muted ? 1 : 0) | (p.microphone_disabled ? 2 : 0) | (p.camera_allowed ? 4 : 0) | (p.motion_allowed ? 8 : 0) | (p.ring_allowed ? 16 : 0) | (p.wake_standby ? 32 : 0)), appearance};
    for (int i = 0; i < 4; ++i) bytes[4 + i] = static_cast<uint8_t>(p.revision >> (i * 8));
    const auto crc = PreferenceCrc(bytes.data(), 8);
    for (int i = 0; i < 4; ++i) bytes[8 + i] = static_cast<uint8_t>(crc >> (i * 8));
    return bytes;
}
inline bool DecodePreferences(const PreferenceRecord& b, Preferences& out) {
    const unsigned flags = b[0] == 8 ? 32u : b[0] == 7 ? 64u : 1u << (std::min<unsigned>(b[0], 4) + 1);
    if (b[0] < 1 || b[0] > 8 || b[1] > 100 || b[2] >= flags) return false;
    const auto newest = b[0] >= 6 ? Appearance::Whale : b[0] == 5 ? Appearance::Text : Appearance::Default;
    if (b[3] > static_cast<uint8_t>(newest)) return false;
    uint32_t crc = 0, revision = 0;
    for (int i = 0; i < 4; ++i) { crc |= uint32_t(b[8+i]) << (i*8); revision |= uint32_t(b[4+i]) << (i*8); }
    if (crc != PreferenceCrc(b.data(), 8)) return false;
    out = {b[1], bool(b[2] & 1), bool(b[2] & 2), revision, bool(b[2]&4), bool(b[2]&8), bool(b[2]&16), static_cast<Appearance>(b[3]), b[0] == 8 ? false : b[0] == 7 ? bool(b[2]&32) : true};
    return true;
}
enum class PreferenceLoad { Loaded, Missing, Unavailable, Error };
struct PreferenceStore {
    virtual ~PreferenceStore() = default;
    virtual PreferenceLoad Load(Preferences&) = 0;
    virtual bool Save(const Preferences&) = 0;
};
class NvsPreferenceStore final : public PreferenceStore {
public:
    PreferenceLoad Load(Preferences&) override;
    bool Save(const Preferences&) override;
private:
    bool ready_ = false;
};
// Application task owns preferences; hardware requests cross AudioEngine's lock.
class DevicePreferences {
public:
    DevicePreferences(PreferenceStore& store, AudioEngine& audio, CameraEngine* camera=nullptr, MotionEngine* motion=nullptr, RingEngine* ring=nullptr) : store_(store), audio_(audio), camera_(camera), motion_(motion), ring_(ring) {}
    void Load(int factory_volume) {
        value_=Preferences{};
        value_.volume = static_cast<uint8_t>(std::clamp(factory_volume, 0, 100));
        load_ = store_.Load(value_);
        if (load_ == PreferenceLoad::Error || load_ == PreferenceLoad::Unavailable)
            value_ = {0, true, true, 0};
        dirty_ = load_ != PreferenceLoad::Loaded;
        Apply();
    }
    const Preferences& value() const { return value_; }
    PreferenceLoad load() const { return load_; }
    bool dirty() const { return dirty_; }
    bool save_error() const { return save_error_; }
    void Volume(int volume) { value_.volume = static_cast<uint8_t>(std::clamp(volume, 0, 100)); Changed(); }
    void Mute(bool muted) { value_.muted = muted; Changed(); }
    void DisableMicrophone(bool disabled) { value_.microphone_disabled = disabled; Changed(); }
    void AllowCamera(bool allowed) { value_.camera_allowed = allowed; Changed(); }
    void AllowMotion(bool allowed) { value_.motion_allowed = allowed; Changed(); }
    void AllowRing(bool allowed) { value_.ring_allowed = allowed; Changed(); }
    void SetAppearance(Appearance appearance) {
        if (value_.appearance == appearance) return;
        value_.appearance = appearance;
        dirty_ = true;
        save_error_ = false;
    }
    void SetWakeStandby(bool enabled) {
        if (value_.wake_standby == enabled) return;
        value_.wake_standby = enabled;
        dirty_ = true;
        save_error_ = false;
    }
    bool Save() {
        if (load_ == PreferenceLoad::Unavailable || load_ == PreferenceLoad::Error ||
            value_.revision == std::numeric_limits<uint32_t>::max()) { save_error_ = true; return false; }
        Preferences candidate = value_; ++candidate.revision;
        if (!store_.Save(candidate)) { save_error_ = true; return false; }
        value_ = candidate; dirty_ = save_error_ = false; load_ = PreferenceLoad::Loaded;
        return true;
    }
private:
    PreferenceStore& store_; AudioEngine& audio_; CameraEngine* camera_; MotionEngine* motion_; RingEngine* ring_; Preferences value_;
    PreferenceLoad load_ = PreferenceLoad::Unavailable;
    bool dirty_ = true, save_error_ = false;
    void Changed() { dirty_ = true; save_error_ = false; Apply(); }
    void Apply() { audio_.SetVolume(value_.EffectiveVolume()); audio_.AllowCapture(!value_.microphone_disabled); if(camera_) camera_->AllowCapture(value_.camera_allowed); if(motion_) motion_->AllowMotion(value_.motion_allowed); if(ring_) ring_->Allow(value_.ring_allowed); }
};
}
