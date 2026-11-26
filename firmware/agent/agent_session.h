// SPDX-License-Identifier: MIT
#pragma once
#include "ambient_engine.h"
#include "device_health.h"
#include "audio_engine.h"
#include "pairing_service.h"
#include "expression_port.h"
#include "camera_transfer.h"
#include "caption.h"
#include "motion_engine.h"
#include "ring_engine.h"
#include "screen_touch.h"
#include "ina226.h"
#include "ir_nec.h"
#include "nfc_st25r3916.h"
#include "display_port.h"
#include "frame_bank.h"
#include <string>
namespace sion::agent {
// Raw sensor reports the Host can speed up for one session (sensor recording).
// Minimums follow each engine's own sampling interval.
enum ReportKind : unsigned { ReportBattery, ReportAmbient, ReportHeadTouch, ReportImu, ReportPower, ReportKinds };
inline constexpr const char* kReportNames[ReportKinds] = {"battery", "ambient", "head_touch", "imu", "power"};
inline constexpr uint32_t kReportDefaultMs[ReportKinds] = {2000, 2000, 200, 250, 2000};
inline constexpr uint32_t kReportMinMs[ReportKinds] = {1000, 750, 50, 20, 100};
inline constexpr uint32_t kReportMaxMs = 10000;
using BatteryReader = bool (*)(int& percent, bool& charging, bool& discharging);
// Latest body-health sample (temperature, CPU share, input/UI progress); false when none.
using HealthReader = bool (*)(diagnostics::HealthSample&);
// Queued, nonblocking sink. False means the network queue could not accept it.
// TLS callbacks must marshal to the single application owner, never call this
// controller or NVS directly. This controller does not establish TLS trust.
struct AgentWireSink {
    virtual ~AgentWireSink()=default;
    virtual bool Text(const std::string&)=0;
    virtual bool Binary(const uint8_t*,size_t)=0;
    // False is optional low-priority backpressure, not disconnect.
    virtual bool CameraText(const std::string&){return false;}
    // True asks the session to skip capture frames instead of filling the link.
    virtual bool Congested(){return false;}
    virtual void Close()=0;
};
class AgentSession {
public:
    AgentSession(SessionLifecycle& lifecycle,AudioEngine& audio,PairingMaintenance& maintenance,AgentWireSink& wire,ExpressionPort* expression=nullptr,CameraEngine* camera=nullptr,MotionEngine* motion=nullptr,RingEngine* ring=nullptr,BatteryReader battery=nullptr,AmbientEngine* ambient=nullptr,HeadTouchEngine* head_touch=nullptr,ImuEngine* imu=nullptr)
        :life_(lifecycle),audio_(audio),maintenance_(maintenance),wire_(wire),expression_(expression),camera_(camera),motion_(motion),ring_(ring),battery_(battery),ambient_(ambient),head_touch_(head_touch),imu_(imu){}
    // Called only after TLS/endpoint/auth verification and explicit app entry.
    // IDs are public correlation values; never pass tokens or factory identity.
    // standby: the device stays linked while it waits, and the Host decides
    // when someone is addressing it (hello "standby":2; 1 was an on-device
    // wake phrase that no longer exists).
    bool AttachAuthenticated(const std::string& device,const std::string& pair,const std::string& boot,uint64_t now,bool captions=false,bool standby=false);
    bool standby()const{return attached()&&standby_;}
    // A tap on the face of a linked-standby device: ask the Host for attention
    // instead of ending the link. False when nothing could be sent.
    // sleep=true (face Stop button): stop talking but keep waiting linked.
    // A busy link holds the request and retries it for up to 1.5 s; Stop wins
    // over a tap still waiting. False only outside an active conversation.
    bool Attention(uint64_t now,bool sleep=false);
    void Text(const std::string& text,uint64_t now);
    void Binary(const uint8_t* bytes,size_t size,uint64_t now);
    void Tick(uint64_t now);
    // Before AttachAuthenticated: the hello then offers "health":1 and each new
    // sample is sent once while a conversation is active.
    void SetHealthReader(HealthReader reader){health_=reader;}
    void Disconnected(uint64_t now);
    void LocalStop(bool home,uint64_t now);
    bool attached()const{return mode_!=Mode::Detached;}
    // Conversation state last sent by the Host; Off outside an active session.
    RingIndicator voice_indicator()const{return mode_==Mode::Active?voice_indicator_:RingIndicator::Off;}
    uint64_t capture_frames_skipped()const{return capture_skipped_;}
    CameraView CameraSnapshot()const{return camera_.View();}
    const Captions& CaptionSnapshot() const { return captions_; }
private:
    enum class Mode {Detached,Idle,Starting,Active,Stopping};
    SessionLifecycle& life_;AudioEngine& audio_;PairingMaintenance& maintenance_;AgentWireSink& wire_;
    ExpressionPort* expression_;
    CameraTransfer camera_;
    MotionEngine* motion_;
    RingEngine* ring_;
    BatteryReader battery_;
    uint64_t battery_reported_at_ = 0;
    uint32_t report_ms_[ReportKinds] = {kReportDefaultMs[0], kReportDefaultMs[1], kReportDefaultMs[2], kReportDefaultMs[3], kReportDefaultMs[4]};
    uint64_t power_reported_at_ = 0;
    const PowerReader* power_ = nullptr;
    bool(*volume_)(int) = nullptr;
    IrPort* ir_ = nullptr;
    DisplayPort* display_ = nullptr;
    std::string image_request_;
    uint32_t image_bytes_ = 0, image_received_ = 0;
    // The upload in progress goes to this frame slot (-1: a picture shown at its end).
    int image_slot_ = -1;
    FrameBank frames_;
    int shown_frame_ = -1;   // Slot whose pixels the screen may be showing.
    void ForgetShownFrame(int slot){if(display_&&shown_frame_>=0&&(slot==shown_frame_||slot==kFrameSlots)){display_->ClearDisplay();}if(slot==shown_frame_||slot==kFrameSlots)shown_frame_=-1;}
    struct FrameRequest{std::string type,request,tag;int slot=-1;uint16_t w=0,h=0,x=0,y=0;uint32_t ms=0;};
    void HandleFrame(const FrameRequest& command,uint64_t now);
    void AbandonUpload();
    void DisplayResult(const std::string& request,const char* code,uint64_t now);
    std::string ir_request_;
    void PumpInfrared(uint64_t now);
    NfcPort* nfc_ = nullptr;
    bool nfc_offered_ = false;
    std::string nfc_request_;
    void PumpNfc(uint64_t now);
    HealthReader health_ = nullptr;
    uint32_t health_sequence_ = 0;
    void PublishHealthState();
    void PublishBatteryState(uint64_t now);
    AmbientEngine* ambient_;
    uint64_t ambient_reported_at_ = 0;
    void PublishAmbientState(uint64_t now);
    HeadTouchEngine* head_touch_;
    uint64_t head_touch_reported_at_ = 0;
    uint32_t head_touch_sequence_ = 0;
    void PublishHeadTouchState(uint64_t now);
    void PublishHeadTouchGesture(uint64_t now);
    ImuEngine* imu_;
    uint64_t imu_reported_at_ = 0;
    void PublishImuState(uint64_t now);
    void PublishScreenTouch(uint64_t now);
    void PublishPowerState(uint64_t now);
public:
    void SetScreenTouch(ScreenTouchLog* log){screen_touch_=log;}
    void SetPower(const PowerReader* power){power_=power;}
    // Speaker volume 0..100 for now (not saved; Settings > Save keeps it).
    using VolumeSetter=bool(*)(int);
    void SetVolumeSetter(VolumeSetter setter){volume_=setter;}
    void SetInfrared(IrPort* ir){ir_=ir;}
    // Offered in the hello only when the reader is ready at attach; polls only while active.
    void SetNfc(NfcPort* nfc){nfc_=nfc;}
    void SetDisplay(DisplayPort* display){display_=display;}
private:
    ScreenTouchLog* screen_touch_=nullptr;
    std::string ring_request_, last_ring_request_, ring_report_;
    RingIndicator voice_indicator_ = RingIndicator::Off;
    uint64_t capture_skipped_ = 0;
    uint64_t ring_reported_at_ = 0;
    void PumpRing(uint64_t now);
    bool SendRingResult(const std::string& request, RingResult result, uint64_t now);
    void ResetRing();
    std::string motion_request_,last_motion_request_,motion_report_;
    uint64_t motion_ticket_=0,motion_reported_at_=0;
    bool motion_cancelled_=false;
    void ResetMotion();
    void FinishMotion(uint64_t now);
    void PublishMotionState(uint64_t now);
    bool SendMotionResult(const std::string& request,const char* code,uint64_t now,const MotionFeedback* observed=nullptr,bool holding=false);
    bool SendServoState(const std::string& request,const MotionSense& sense,bool holding,uint64_t now);
    Mode mode_=Mode::Detached;
    std::string boot_,pair_,request_;
    Captions captions_;
    bool captions_requested_ = false;
    bool standby_ = false;
    uint64_t attention_at_ = 0;
    // 0 none, 1 tap, 2 Stop: an attention request the link had no room for yet.
    uint8_t attention_pending_ = 0;
    uint64_t attention_pending_at_ = 0;
    bool SendAttention(bool sleep);
    uint64_t acknowledged_=0;
    std::string playback_request_;
    uint64_t playback_boundary_=0;
    bool playback_discard_=false;
    std::string camera_report_;
    uint64_t camera_reported_at_=0;
    void PublishCameraState(uint64_t now);
    std::string Identity()const;
    bool Send(const std::string& text,uint64_t now);
};
}
