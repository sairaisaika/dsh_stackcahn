// SPDX-License-Identifier: MIT
#include <algorithm>
#include "direct_frames.h"
#include "session_lifecycle.h"
#include "audio_runtime.h"
#include "camera_runtime.h"
#include "motion_runtime.h"
#include "ring_runtime.h"
#include "ambient_runtime.h"
#include "ir_runtime.h"
#include "nfc_runtime.h"
#include "preferences.h"
#include "pairing_usb.h"
#include "agent_network.h"
#include "device_trace.h"
#include "device_health.h"
#include "fish_avatar.h"
#include "whale_avatar.h"
#include "factory_caption_font.h"
#include <atomic>
#include <cstdio>
#include <cstring>
#include <optional>
#include <hal/hal.h>
#include <apps/common/home_indicator/home_indicator.h>
#include <esp_timer.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <smooth_ui_toolkit.hpp>
#include <settings.h>
#include <stackchan/avatar/skins/default/default.h>
#if defined(SION_MENU_RETURN)
#include "menu/menu_device.h"
#elif defined(SION_APP_CENTER)
#include "app_center/return_to_stock.h"
#include "app_center/tail_storage.h"
#if defined(SION_APP_CENTER_HOME)
#include "app_center/home_menu_request.h"
#endif
#endif

bool ReadAgentBattery(int& percent, bool& charging, bool& discharging);

namespace {
namespace trace = sion::agent::diagnostics;
using trace::Event;
using trace::Lane;
enum Intent : unsigned { Open=1, Stop=2, Home=4, SettingsPage=8, Back=16,
                         VolumeUp=32, VolumeDown=64, Mute=128, Microphone=256, Save=512, PairingPage=1024, AllowPairing=2048, Connect=4096, AvatarPage=8192, CameraSettings=16384, ToggleCamera=32768, MotionSettings=65536, ToggleMotion=131072,
                         AskFactoryReturn=262144, ConfirmFactoryReturn=524288, RingSettings=1048576, ToggleRing=2097152,
                         ConnectUsb=4194304, DisplaySettings=8388608, ChooseDefault=16777216, ChooseFish=33554432, ChooseText=67108864,
                         ConnectRelay=134217728, TapFace=268435456, StartText=536870912, ChooseWhale=1073741824,
                         ToggleWake=2147483648u };
enum class Page { Entry, Agent, Settings, Pairing, Avatar, CameraSettings, MotionSettings, RingSettings, DisplaySettings, FactoryConfirm };
using sion::agent::Appearance;
std::unique_ptr<stackchan::avatar::DefaultAvatar> avatar;
std::optional<sion::agent::FishAvatar> fish;
std::optional<sion::agent::WhaleAvatar> whale;
class DeviceExpression final : public sion::agent::ExpressionPort {
public:
    bool SetExpression(std::string_view value) override {
        if(!avatar&&!fish&&!whale)return false;
        using E=stackchan::avatar::Emotion;
        E emotion;
        if(value=="neutral")emotion=E::Neutral;
        else if(value=="happy")emotion=E::Happy;
        else if(value=="angry")emotion=E::Angry;
        else if(value=="sad")emotion=E::Sad;
        else if(value=="doubt")emotion=E::Doubt;
        else if(value=="sleepy")emotion=E::Sleepy;
        else return false;
        if(whale)whale->SetEmotion(emotion);
        else if(fish)fish->SetEmotion(emotion);
        else avatar->setEmotion(emotion);
        return true;
    }
    void ResetExpression() override {
        if(whale)whale->Reset();
        if(fish)fish->Reset();
        if(avatar)avatar->setEmotion(stackchan::avatar::Emotion::Neutral);
    }
};
std::atomic<unsigned> intents{0};
// The callback and loop share the LVGL lock. Multiple queued clicks may share one batch.
uint16_t queued_action_batch=1, processing_action_batch=0, page_revision=0;
bool status_labels_changed=false;
lv_obj_t *panel=nullptr, *volume_text=nullptr, *save_text=nullptr, *audio_text=nullptr, *pair_text=nullptr, *pair_hint=nullptr, *network_text=nullptr, *camera_text=nullptr, *camera_hint=nullptr, *motion_text=nullptr, *motion_hint=nullptr, *ring_text=nullptr, *ring_hint=nullptr, *factory_status_text=nullptr;
lv_obj_t* relay_text=nullptr;
lv_obj_t *text_scroll=nullptr, *text_user=nullptr, *text_reply_heading=nullptr, *text_reply=nullptr, *text_sound=nullptr;
lv_obj_t* text_start=nullptr;
lv_obj_t* wake_text=nullptr;
// Standby belongs to the face page. An explicit Stop there keeps the
// microphone off until the face is tapped or the page is opened again.
bool standby_hold=false, connection_chosen=false;
// Linked standby reconnects by itself; those attempts stay quiet on the face.
bool automatic_link=false;
unsigned queued_start=0;
uint64_t queued_start_until=0, touch_watch_at=0, link_retry_at=0;
std::optional<uint64_t> caption_revision;
// Speech bubble over the whale face: what was heard, what DSH is doing, the reply.
lv_obj_t *whale_bubble=nullptr, *whale_bubble_text=nullptr;
std::optional<uint64_t> bubble_revision;
uint64_t bubble_changed_at=0;
bool bubble_status=false;
// While DSH works the status line breathes and counts the wait (v66: a 55 s
// tool call looked frozen). Device clock only; nothing extra on the link.
uint64_t bubble_waiting_since=0;
bool bubble_animated=false;
std::string bubble_line;
bool wants_captions(Appearance value) {return value==Appearance::Text||value==Appearance::Whale;}
void prepare_caption_font() {if(!sion::agent::FactoryCaptionFont())sion::agent::PrepareFactoryCaptionFont();}
bool display_requires_idle=false;
Page page = Page::Entry;
sion::agent::Phase session_phase=sion::agent::Phase::Idle;
sion::agent::CameraView camera_view;
bool audio_worker_ready=false, camera_worker_ready=false, motion_worker_ready=false, ring_worker_ready=false, save_requires_idle=false;
sion::agent::NvsPreferenceStore preference_store;
bool pairing_denied=false, factory_return_configured=false;
#if defined(SION_MENU_RETURN)
bool menu_return_available=false, return_to_menu=false;
#elif defined(SION_APP_CENTER)
enum class StockReturn { Idle, Verify, Rejected };
StockReturn stock_return=StockReturn::Idle;
bool stock_return_failed=false;
#endif
sion::agent::AgentCarrier* carrier=nullptr;
Intent last_connection=Connect;
class SelectedWire final:public sion::agent::AgentWireSink {
public:
    bool Text(const std::string& text)override{return carrier->Text(text);}
    bool Binary(const uint8_t* bytes,size_t size)override{return carrier->Binary(bytes,size);}
    bool CameraText(const std::string& text)override{return carrier->CameraText(text);}
    bool Congested()override{return carrier->Congested();}
    void Close()override{carrier->Close();}
};
bool FactoryReturnConfigured() {
    const auto* part=esp_ota_get_running_partition();
    return part&&part->type==ESP_PARTITION_TYPE_APP&&part->subtype==ESP_PARTITION_SUBTYPE_APP_TEST&&
        part->address==0xe10000&&part->size==0x1ec000&&std::strcmp(part->label,"dsh_agent")==0;
}
bool agent_page(Page current) {
    return current!=Page::Entry&&current!=Page::FactoryConfirm;
}
// The face is the main screen; the menu sits behind it (owner, 2026-11-24).
// Standby reaches for DSH from both. Settings pages keep a link that is already
// up but do not start one, because Save needs the device idle; the pairing page
// may need the USB port for itself.
bool link_page(Page current) {
    return current==Page::Avatar||current==Page::Agent;
}
bool settings_page(Page current) {
    return current==Page::Settings||current==Page::CameraSettings||current==Page::MotionSettings||
        current==Page::RingSettings||current==Page::DisplaySettings;
}
sion::agent::DevicePreferences preferences(preference_store, sion::agent::DeviceAudio(), &sion::agent::DeviceCamera(), &sion::agent::DeviceMotion(), &sion::agent::DeviceRing());
bool motion_idle() {
    // A latched motion Fault keeps motion disabled until reboot (Begin refuses
    // any phase but Idle); it must not also lock out voice and USB connects.
    const auto status=sion::agent::DeviceMotion().status();
    return (status.phase==sion::agent::MotionPhase::Idle||status.phase==sion::agent::MotionPhase::Fault)&&!status.result_ready;
}
bool ring_idle() {
    return sion::agent::DeviceRing().status().phase==sion::agent::RingPhase::Idle;
}
bool camera_idle() {
    const auto status=sion::agent::DeviceCamera().status();
    return status.phase==sion::agent::CameraPhase::Idle&&!status.result_ready;
}
bool ready_to_connect(sion::agent::Phase phase, bool attached) {
    return phase==sion::agent::Phase::Idle&&!attached&&audio_worker_ready&&carrier->Finished()&&
        sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle&&camera_idle()&&motion_idle()&&ring_idle();
}
void start_connection(unsigned connection, uint64_t now) {
    last_connection=connection&ConnectUsb?ConnectUsb:connection&ConnectRelay?ConnectRelay:Connect;
    trace::Record(Lane::Ui,Event::CarrierSelected,last_connection);
    carrier=last_connection==ConnectUsb?&sion::agent::DeviceUsbAudio():&sion::agent::DeviceNetwork();
    if(last_connection==ConnectUsb)carrier->Start(now);
    else sion::agent::DeviceNetwork().Start(now,last_connection==ConnectRelay?sion::agent::NetworkMode::Relay:sion::agent::NetworkMode::Lan);
}
// A start from the face or from standby itself. Until a carrier is chosen on the
// DSH.AGENT page, a USB host that is actually enumerating the device wins.
void request_start(uint64_t now, bool automatic=false) {
    queued_start=connection_chosen?last_connection:sion::agent::DeviceUsbHostPresent()?ConnectUsb:Connect;
    queued_start_until=now+3000;
    automatic_link=automatic;
    if(whale&&!automatic)whale->Poke(now);
}
const char* wake_caption() {
    return preferences.value().wake_standby?"Wake on":"Wake off";
}
void queue_action(unsigned intent,uint16_t touch_id) {
    trace::Record(Lane::Actions,Event::UiActionQueued,trace::TracePair(queued_action_batch,touch_id));
    intents.fetch_or(intent);
}
void post(lv_event_t* event) {
    const auto intent=static_cast<unsigned>(reinterpret_cast<uintptr_t>(lv_event_get_user_data(event)));
    queue_action(intent,lv_indev_active()?trace::LvglTouchId():0);
}
lv_obj_t* label(const char* text, int y) {
    auto object=lv_label_create(panel); lv_label_set_text(object,text); lv_obj_set_width(object,288);
    lv_obj_set_style_text_align(object,LV_TEXT_ALIGN_CENTER,0); lv_obj_align(object,LV_ALIGN_TOP_MID,0,y);
    return object;
}
lv_obj_t* button(const char* text,int x,int y,int width,Intent intent) {
    auto object=lv_button_create(panel); lv_obj_set_size(object,width,34); lv_obj_set_pos(object,x,y);
    lv_obj_add_event_cb(object,post,LV_EVENT_CLICKED,reinterpret_cast<void*>(static_cast<uintptr_t>(intent)));
    auto caption=lv_label_create(object); lv_label_set_text(caption,text); lv_obj_center(caption);
    return caption;
}
void face_touch_target() {
    // Keep the edge and the explicit Back and Stop buttons outside this target.
    auto* target=lv_obj_create(panel);
    lv_obj_remove_style_all(target);
    lv_obj_remove_flag(target,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(target,LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_size(target,264,152);
    lv_obj_set_pos(target,28,48);
    lv_obj_add_event_cb(target,post,LV_EVENT_SHORT_CLICKED,reinterpret_cast<void*>(static_cast<uintptr_t>(TapFace)));
}
void show_text() {
    button("Back",4,4,54,Back);
    text_sound=button("",67,4,96,Mute);
    text_start=lv_obj_get_parent(button("Start",172,4,64,StartText));
    button("Stop",252,4,64,Stop);
    network_text=label("",44);
    text_scroll=lv_obj_create(panel);
    lv_obj_set_pos(text_scroll,7,67);
    lv_obj_set_size(text_scroll,306,151);
    lv_obj_set_flex_flow(text_scroll,LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scroll_dir(text_scroll,LV_DIR_VER);
    lv_obj_set_style_pad_all(text_scroll,8,0);
    const auto line=[](const char* initial) {
        auto* result=lv_label_create(text_scroll);
        lv_label_set_long_mode(result,LV_LABEL_LONG_MODE_WRAP);
        lv_obj_set_width(result,lv_pct(100));
        lv_label_set_text(result,initial);
        return result;
    };
    line("You");
    text_user=line("");
    text_reply_heading=line("DSH");
    text_reply=line("");
    if(const auto* font=sion::agent::FactoryCaptionFont()) {
        lv_obj_set_style_text_font(text_user,font,0);
        lv_obj_set_style_text_font(text_reply,font,0);
    }
}
void update_status_label(lv_obj_t* label,const char* text) {
    // LVGL reallocates and invalidates the label even if the copied text is unchanged.
    const char* current=lv_label_get_text(label);
    if(current&&std::strcmp(current,text)==0)return;
    lv_label_set_text(label,text);
    status_labels_changed=true;
}
// The newest part of a long line: whole UTF-8 characters, at most limit bytes.
std::string bubble_tail(const std::string& text,size_t limit) {
    if(text.size()<=limit)return text;
    size_t start=text.size()-limit;
    while(start<text.size()&&(static_cast<uint8_t>(text[start])&0xc0)==0x80)++start;
    return "..."+text.substr(start);
}
void create_whale_bubble() {
    whale_bubble=lv_obj_create(panel);
    lv_obj_set_pos(whale_bubble,8,168);
    lv_obj_set_size(whale_bubble,304,66);
    lv_obj_set_style_radius(whale_bubble,14,0);
    lv_obj_set_style_bg_color(whale_bubble,lv_color_hex(0xffffff),0);
    lv_obj_set_style_bg_opa(whale_bubble,225,0);
    lv_obj_set_style_border_width(whale_bubble,0,0);
    lv_obj_set_style_pad_all(whale_bubble,6,0);
    lv_obj_remove_flag(whale_bubble,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(whale_bubble,LV_OBJ_FLAG_CLICKABLE);  // Taps still reach the face.
    whale_bubble_text=lv_label_create(whale_bubble);
    lv_obj_set_width(whale_bubble_text,292);
    lv_label_set_long_mode(whale_bubble_text,LV_LABEL_LONG_MODE_WRAP);
    lv_label_set_text(whale_bubble_text,"");
    if(const auto* font=sion::agent::FactoryCaptionFont()) lv_obj_set_style_text_font(whale_bubble_text,font,0);
    lv_obj_add_flag(whale_bubble,LV_OBJ_FLAG_HIDDEN);
    bubble_revision.reset();bubble_status=false;bubble_animated=false;bubble_line.clear();
}
void refresh_whale_bubble(const sion::agent::Captions& captions,uint64_t now,bool busy,bool waiting) {
    if(!whale_bubble)return;
    const bool changed=bubble_revision!=captions.Revision();
    if(changed) {
        bubble_revision=captions.Revision();
        bubble_changed_at=now;
        const bool was_status=bubble_status;
        bubble_status=!captions.Status().empty();
        if(bubble_status&&!was_status)bubble_waiting_since=now;
        bubble_line=bubble_status?captions.Status():
            !captions.Assistant().empty()?captions.Assistant():captions.User();
        if(bubble_line.empty())lv_obj_add_flag(whale_bubble,LV_OBJ_FLAG_HIDDEN);
        else lv_obj_remove_flag(whale_bubble,LV_OBJ_FLAG_HIDDEN);
    }
    const bool animate=bubble_status&&waiting&&!bubble_line.empty();
    if(animate) {
        static constexpr const char* dots[]={".","..","..."};
        const uint64_t seconds=(now-bubble_waiting_since)/1000;
        std::string text=bubble_tail(bubble_line,72)+"\n"+dots[(now/400)%3];
        if(seconds>=3)text+="  "+std::to_string(seconds)+"s";
        update_status_label(whale_bubble_text,text.c_str());
    } else if(changed||bubble_animated) update_status_label(whale_bubble_text,bubble_tail(bubble_line,108).c_str());
    bubble_animated=animate;
    if(changed)return;
    // While the face is thinking or speaking the line stays; it fades only after
    // the reply has finished (v65: a 12 s fade hid replies before TTS began).
    if(busy){bubble_changed_at=now;return;}
    const uint64_t keep=bubble_status?30000:12000;
    if(now-bubble_changed_at>keep)lv_obj_add_flag(whale_bubble,LV_OBJ_FLAG_HIDDEN);
}
void refresh_text(const sion::agent::Captions& captions, bool ready) {
    const auto& value=preferences.value();
    const char* sound=value.muted?"Sound off":"Sound on";
    const char* status=session_phase==sion::agent::Phase::Active?"Listening":
        session_phase==sion::agent::Phase::Draining?"Stopping...":
        session_phase==sion::agent::Phase::Fault?"Release failed - Stop to retry":
        !audio_worker_ready?"Audio service unavailable":
        value.microphone_disabled?"Microphone disabled":
        carrier->StatusText();
    if(ready&&!value.microphone_disabled) lv_obj_remove_state(text_start,LV_STATE_DISABLED);
    else lv_obj_add_state(text_start,LV_STATE_DISABLED);
    update_status_label(text_sound,sound);
    update_status_label(network_text,status);
    if(caption_revision==captions.Revision())return;
    caption_revision=captions.Revision();
    update_status_label(text_user,captions.User().c_str());
    update_status_label(text_reply,captions.Assistant().c_str());
    if(captions.Assistant().empty()) lv_obj_scroll_to_y(text_scroll,0,LV_ANIM_OFF);
    else lv_obj_scroll_to_view(text_reply_heading,LV_ANIM_OFF);
}
void refresh_settings() {
    if (!settings_page(page)) return;
    const auto& value=preferences.value(); const auto audio=sion::agent::DeviceAudio().status();
    char text[64]; std::snprintf(text,sizeof(text),"Volume %u%s",unsigned(value.volume),value.muted?" (muted)":"");
    if(volume_text) update_status_label(volume_text,text);
    const char* saved=save_requires_idle?"Stop devices before saving":preferences.load()==sion::agent::PreferenceLoad::Unavailable?"Storage not installed":
        preferences.load()==sion::agent::PreferenceLoad::Error?"Storage error - not overwritten":
        preferences.save_error()?"Save failed - value uncertain":preferences.dirty()?"Not saved for next boot":"Saved for next boot";
    update_status_label(save_text,saved);
    if(page==Page::DisplaySettings) {
        update_status_label(audio_text,display_requires_idle?"Stop the connection to change display":
            value.appearance==Appearance::Whale?"Selected: Whale":
            value.appearance==Appearance::Fish?"Selected: Chubby fish":
            value.appearance==Appearance::Text?"Selected: Text":"Selected: Default face");
        return;
    }
    if(page==Page::CameraSettings) {
        update_status_label(camera_hint,value.camera_allowed?"Allowed; no automatic photos":"Disabled; blocks new photos");
        const auto camera=sion::agent::DeviceCamera().status();
        using P=sion::agent::CameraPhase;
        const char* state=!camera_worker_ready?"Camera service unavailable":
            camera.phase==P::Fault?"Camera release failed":
            camera.phase==P::Closing?"Releasing camera...":
            camera.phase==P::Opening?"Opening camera...":
            camera.phase==P::Capturing?"Taking photo...":
            camera_view.phase=="transferring"?"Sending photo to DSH...":
            !camera_view.error.empty()?"Last photo failed / cancelled":
            !value.camera_allowed?"Camera disabled":
            camera.result_ready?"Photo result waiting":"Allowed; camera is off";
        update_status_label(camera_text,state);return;
    }
    if(page==Page::RingSettings) {
        update_status_label(ring_hint,value.ring_allowed?"DSH effects and status lights allowed":"DSH lights disabled");
        const auto ring=sion::agent::DeviceRing().status();
        using Phase=sion::agent::RingPhase;
        const char* state=!ring_worker_ready?"Light ring unavailable":
            ring.phase==Phase::Fault?"Ring off not confirmed":
            ring.phase==Phase::Clearing?"Turning ring off...":
            ring.phase==Phase::Lit?"Light effect active":
            ring.phase!=Phase::Idle?"Preparing light ring...":
            ring.indicator?"Conversation status mode":
            ring.error!=sion::agent::RingResult::None?"Last effect failed":"Light ring idle";
        update_status_label(ring_text,state);return;
    }
    if(page==Page::MotionSettings) {
        update_status_label(motion_hint,value.motion_allowed?"Allowed; DSH may move the head":"Disabled; blocks new moves");
        const auto motion=sion::agent::DeviceMotion().status();
        using P=sion::agent::MotionPhase;
        const char* state=!motion_worker_ready?"Motion service unavailable":
            motion.phase==P::Fault?"Motion release unconfirmed":
            motion.phase==P::Releasing?"Releasing drives...":
            motion.phase!=P::Idle?"Motion in progress...":
            motion.error!=sion::agent::MotionError::None?"Last move failed":
            !value.motion_allowed?"Motion disabled":"Allowed; no active move";
        update_status_label(motion_text,state);return;
    }
    if(wake_text) update_status_label(wake_text,wake_caption());
    const char* state=audio.phase==sion::agent::AudioPhase::Fault?"Audio close failed":
        audio.phase==sion::agent::AudioPhase::Closing?"Stopping audio...":
        value.microphone_disabled?"Microphone disabled":
        value.wake_standby&&audio.phase==sion::agent::AudioPhase::Idle?"Wake: stays linked to DSH":
        audio.phase==sion::agent::AudioPhase::Idle?"Mic allowed; not recording":
        audio.applied_volume==audio.requested_volume?"Audio settings applied":"Applying volume...";
    update_status_label(audio_text,state);
}
void refresh_pairing(uint64_t now) {
    if(page!=Page::Pairing)return;
    const auto status=sion::agent::DevicePairing().Snapshot(now);
    update_status_label(pair_text,sion::agent::PairingStateText(status.pairing.state));
    switch(status.relay.state) {
    case sion::agent::RelayState::Ready:update_status_label(relay_text,"Relay settings saved");break;
    case sion::agent::RelayState::Empty:update_status_label(relay_text,"Relay needs setup");break;
    case sion::agent::RelayState::Invalid:update_status_label(relay_text,"Relay needs new settings");break;
    case sion::agent::RelayState::StorageError:update_status_label(relay_text,"Relay storage error");break;
    default:update_status_label(relay_text,"Pair to set up Relay");break;
    }
    char text[80];
    if(status.busy)std::snprintf(text,sizeof(text),"USB maintenance - please wait");
    else if(!status.ready)std::snprintf(text,sizeof(text),"USB service unavailable");
    else if(status.remaining_ms)std::snprintf(text,sizeof(text),"Allow one USB change: %u s",unsigned((status.remaining_ms+999)/1000));
    else if(!status.result.empty())std::snprintf(text,sizeof(text),"USB result: %s",status.result.c_str());
    else if(pairing_denied)std::snprintf(text,sizeof(text),"Need idle audio and valid storage");
    else std::snprintf(text,sizeof(text),"USB changes require Allow");
    update_status_label(pair_hint,text);
}
void refresh_agent() {
    if(page!=Page::Agent)return;
    const auto audio=sion::agent::DeviceAudio().status();
    update_status_label(network_text,carrier->StatusText());
#if defined(SION_APP_CENTER)
    if (stock_return_failed) {
        update_status_label(audio_text,"Factory return unavailable. Retry Home.");
        return;
    }
#endif
    update_status_label(audio_text,session_phase==sion::agent::Phase::Fault?"Release failed - Stop to retry":
        !audio_worker_ready?"Audio service unavailable":
        audio.phase==sion::agent::AudioPhase::Running?"Audio session active":
        audio.phase==sion::agent::AudioPhase::Opening?"Opening audio...":
        audio.phase==sion::agent::AudioPhase::Closing?"Stopping audio...":
        audio.phase==sion::agent::AudioPhase::Fault?"Audio cleanup failed":
        preferences.value().microphone_disabled?"Microphone disabled":"Microphone is off");
}
void publish_page_revision() {
    trace::Record(Lane::Actions,Event::PageBuilt,trace::TracePair(page_revision,static_cast<uint16_t>(page)));
    trace::SetPageForFlush(page_revision);
    status_labels_changed=false;
}
// DSH's text or image over the face (display_port.h). Only on the face page;
// a page change, Stop, disconnect or the deadline clears it.
class DeviceDisplay final : public sion::agent::DisplayPort {
public:
    bool ShowText(const std::string& text,sion::agent::DisplayArea area,uint32_t ms,uint64_t now) override {
        if(page!=Page::Avatar||!panel)return false;
        ClearDisplay();
        box_=lv_obj_create(panel);
        const int y=area==sion::agent::DisplayArea::Bottom?142:8,h=area==sion::agent::DisplayArea::Full?224:90;
        lv_obj_set_pos(box_,8,y);lv_obj_set_size(box_,304,h);
        lv_obj_set_style_radius(box_,12,0);lv_obj_set_style_bg_color(box_,lv_color_hex(0xffffff),0);
        lv_obj_set_style_bg_opa(box_,235,0);lv_obj_set_style_border_width(box_,0,0);lv_obj_set_style_pad_all(box_,8,0);
        lv_obj_remove_flag(box_,LV_OBJ_FLAG_SCROLLABLE);lv_obj_remove_flag(box_,LV_OBJ_FLAG_CLICKABLE); // Taps reach the face.
        auto* label=lv_label_create(box_);
        lv_obj_set_width(label,288);lv_label_set_long_mode(label,LV_LABEL_LONG_MODE_WRAP);
        if(const auto* font=sion::agent::FactoryCaptionFont())lv_obj_set_style_text_font(label,font,0);
        lv_label_set_text(label,text.c_str());
        until_=now+ms;return true;
    }
    bool BeginImage(uint16_t w,uint16_t h,uint16_t x,uint16_t y,uint32_t ms) override {
        if(page!=Page::Avatar||!panel)return false;
        ClearDisplay();
        bytes_=uint32_t(w)*h*2;
        buffer_=sion::agent::AllocateCameraBuffer(bytes_);
        if(!buffer_)return false;
        w_=w;h_=h;x_=x;y_=y;ms_=ms;return true;
    }
    bool ImageData(uint32_t offset,const uint8_t* bytes,size_t size) override {
        if(!buffer_||offset>bytes_||size>bytes_-offset)return false;
        std::memcpy(buffer_.get()+offset,bytes,size);return true;
    }
    bool ShowImage(uint64_t now) override {
        if(!buffer_||page!=Page::Avatar||!panel)return false;
        dsc_={};
        dsc_.header.magic=LV_IMAGE_HEADER_MAGIC;dsc_.header.cf=LV_COLOR_FORMAT_RGB565;
        dsc_.header.w=w_;dsc_.header.h=h_;dsc_.header.stride=uint32_t(w_)*2;
        dsc_.data_size=bytes_;dsc_.data=buffer_.get();
        image_=lv_image_create(panel);lv_obj_set_pos(image_,x_,y_);lv_image_set_src(image_,&dsc_);
        lv_obj_remove_flag(image_,LV_OBJ_FLAG_CLICKABLE);
        until_=now+ms_;return true;
    }
    // A frame-bank picture, sent straight to the LCD (direct_frames.h): LVGL pauses while
    // frames are up so a switch never holds the display lock the session loop needs. The
    // bank owns the pixels; the session clears the screen before it drops or rewrites them.
    bool ShowFrame(const uint8_t* pixels,uint16_t w,uint16_t h,uint16_t x,uint16_t y,uint32_t ms,uint64_t now) override {
        if(page!=Page::Avatar||!panel||!pixels)return false;
        if(box_)lv_obj_delete(box_);
        if(image_)lv_obj_delete(image_);
        box_=image_=nullptr;buffer_.reset();
        if(!direct_){
            if(!sion::agent::DirectFramesBegin())return false;
            direct_=true;
        }
        sion::agent::DirectFramesShow(pixels,w,h,x,y);
        until_=now+ms;return true;
    }
    void ClearDisplay() override {
        if(box_)lv_obj_delete(box_);
        if(image_)lv_obj_delete(image_);
        Forget();
    }
    // The page (and every object on it) is being deleted.
    void Forget(){
        if(direct_){sion::agent::DirectFramesEnd();direct_=false;}   // LVGL draws again.
        box_=image_=nullptr;buffer_.reset();until_=0;
    }
    void Tick(uint64_t now){if(until_&&now>=until_)ClearDisplay();}
private:
    lv_obj_t *box_=nullptr,*image_=nullptr;
    sion::agent::CameraBuffer buffer_;
    lv_image_dsc_t dsc_{};
    uint32_t bytes_=0,ms_=0;uint16_t w_=0,h_=0,x_=0,y_=0;
    uint64_t until_=0;
    bool direct_=false;
} display;
void show(Page next) {
    display.Forget();
    page_revision=trace::NextTraceId(page_revision);
    trace::Record(Lane::Actions,Event::PageBuildStart,trace::TracePair(processing_action_batch,page_revision));
    view::destroy_home_indicator(); avatar.reset(); fish.reset(); whale.reset(); if(panel) lv_obj_delete(panel);
    if(next==Page::Entry)sion::agent::ReleaseFactoryCaptionFont();
    panel=lv_obj_create(lv_screen_active()); lv_obj_set_size(panel,320,240); lv_obj_center(panel);
    lv_obj_set_style_pad_all(panel,0,0); lv_obj_remove_flag(panel,LV_OBJ_FLAG_SCROLLABLE);
    // Arriving on the face or the menu reaches for DSH at once, not after the
    // retry delay a previous standby page left behind.
    if(link_page(next)&&!link_page(page))link_retry_at=0;
    page=next; volume_text=save_text=audio_text=pair_text=pair_hint=relay_text=network_text=camera_text=camera_hint=motion_text=motion_hint=ring_text=ring_hint=factory_status_text=nullptr;
    text_scroll=text_user=text_reply_heading=text_reply=text_sound=text_start=wake_text=nullptr;
    whale_bubble=whale_bubble_text=nullptr;
    caption_revision.reset();
    if(next==Page::Avatar) {
        standby_hold=false;
        if(preferences.value().appearance==Appearance::Text) show_text();
        else {
            if(preferences.value().appearance==Appearance::Whale&&sion::agent::WhaleAvatar::Available()) {whale.emplace(panel);create_whale_bubble();}
            else if(preferences.value().appearance==Appearance::Fish) fish.emplace(panel);
            else {
                avatar=std::make_unique<stackchan::avatar::DefaultAvatar>();avatar->init(panel);
                avatar->setEmotion(stackchan::avatar::Emotion::Neutral);
            }
            face_touch_target();
            button("Back",4,4,54,Back);button("Stop",252,4,64,Stop);
        }
    } else if(next==Page::Settings) {
        button("Back",4,4,54,Back);button("Camera",224,4,88,CameraSettings);button("Motion",64,4,65,MotionSettings);
        wake_text=button(wake_caption(),135,4,83,static_cast<Intent>(ToggleWake));
        button("-",12,42,52,VolumeDown); volume_text=label("",47); lv_obj_set_width(volume_text,180);
        button("+",256,42,52,VolumeUp);
        button("Mute / unmute",12,83,142,Mute); button("Mic on / off",166,83,142,Microphone);
        audio_text=label("",126); save_text=label("",151);
        button("Save",12,190,66,Save);button("Display",84,190,84,DisplaySettings);
        button("Ring",174,190,62,RingSettings);button("Stop",242,190,66,Stop);
        refresh_settings();
    } else if(next==Page::DisplaySettings) {
        display_requires_idle=false;
        label("Display",10);button("Back",4,4,54,Back);
        audio_text=label("",57);
        button("Default",12,88,82,ChooseDefault);button("Chubby fish",100,88,120,ChooseFish);
        button("Text",228,88,80,ChooseText);
        button("Whale",12,128,142,ChooseWhale);
        save_text=label("",167);
        button("Save",12,192,142,Save);button("Stop",166,192,142,Stop);
        refresh_settings();
    } else if(next==Page::CameraSettings) {
        label("Camera",6);button("Back",4,4,54,Back);
        camera_text=label("",54);camera_hint=label("",87);
        button("Allow / disable",70,117,180,ToggleCamera);
        save_text=label("",159);
        button("Save",12,190,142,Save);button("Stop",166,190,142,Stop);
        refresh_settings();
    } else if(next==Page::MotionSettings) {
        label("Motion",6);button("Back",4,4,54,Back);
        motion_text=label("",54);motion_hint=label("",87);
        button("Allow / disable",70,117,180,ToggleMotion);
        save_text=label("",159);
        button("Save",12,190,142,Save);button("Stop",166,190,142,Stop);
        refresh_settings();
    } else if(next==Page::RingSettings) {
        label("Light ring",6);button("Back",4,4,54,Back);
        ring_text=label("",54);ring_hint=label("",87);
        button("Allow / disable",70,117,180,ToggleRing);
        save_text=label("",159);
        button("Save",12,190,142,Save);button("Stop",166,190,142,Stop);
        refresh_settings();
    } else if(next==Page::Pairing) {
        label("DSH Pairing",6); button("Back",4,4,54,Back);
        pair_text=label("",48);pair_hint=label("",83);
        relay_text=label("",118);label("Factory binding is separate",151);
        button("Allow USB",12,190,142,AllowPairing);button("Stop",166,190,142,Stop);
        refresh_pairing(static_cast<uint64_t>(esp_timer_get_time()/1000));
    } else if(next==Page::Agent) {
        // The menu behind the face: Back returns to the face.
        label("Menu",8);button("Back",4,4,54,Back);
        network_text=label("",42);audio_text=label("",67);
        button("Connect / retry",12,96,122,Connect);button("USB",142,96,66,ConnectUsb);button("Relay",214,96,94,ConnectRelay);
        // No face button: Back (top left) is the way back to the face.
        button("Settings",12,140,142,SettingsPage);button("Pairing",166,140,142,PairingPage);
        button("Stop",70,190,180,Stop);refresh_agent();
    } else if(next==Page::FactoryConfirm) {
        label("Return to factory assistant?",36);
        label("Sion will restart in factory mode.",72);
        factory_status_text=label("",121);
        button("Cancel",12,167,142,Back);button("Return",166,167,142,ConfirmFactoryReturn);
    } else {
        label("DSH.AGENT",8); button("Open DSH.AGENT",55,55,210,Open);
        if(factory_return_configured)button("Factory assistant",55,108,210,AskFactoryReturn);
        else label("Factory return not configured",112);
        label("Development build",166);
    }
    if(agent_page(next)) view::create_home_indicator([]{queue_action(Home,0);});
    publish_page_revision();
}
class DeviceEffects final : public sion::agent::Effects {
    uint32_t last_release_=UINT32_MAX;
public:
    void StopResources(uint64_t epoch) override {
        last_release_=UINT32_MAX;
        trace::Record(Lane::Ui,Event::ReleaseRequested);
        sion::agent::DeviceAmbient().Stop(epoch);
        sion::agent::DeviceHeadTouch().Stop(epoch);
        sion::agent::DeviceImu().Stop(epoch);
        sion::agent::DeviceAudio().Stop(epoch);sion::agent::DeviceCamera().Stop(epoch);sion::agent::DeviceMotion().Stop(epoch);sion::agent::DeviceRing().Stop(epoch);
    }
    sion::agent::Result ResourcesStopped(uint64_t epoch) override {
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 1);
        const auto audio=sion::agent::DeviceAudio().Stopped(epoch);
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 2);
        const auto camera=sion::agent::DeviceCamera().Stopped(epoch);
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 3);
        // Motion Fault is latched and fenced inside the engine; report it in the
        // trace bits but do not turn every session stop into a release fault.
        const auto motion_raw=sion::agent::DeviceMotion().Stopped(epoch);
        const auto motion=motion_raw==sion::agent::Result::Failed?sion::agent::Result::Done:motion_raw;
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 4);
        const auto ring=sion::agent::DeviceRing().Stopped(epoch);
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 5);
        const auto ambient=sion::agent::DeviceAmbient().Stopped(epoch);
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 6);
        const auto head_touch=sion::agent::DeviceHeadTouch().Stopped(epoch);
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 7);
        const auto imu=sion::agent::DeviceImu().Stopped(epoch);
        const uint32_t resources=uint32_t(audio)|(uint32_t(camera)<<2)|(uint32_t(motion_raw)<<4)|
            (uint32_t(ring)<<6)|(uint32_t(ambient)<<8)|(uint32_t(head_touch)<<10)|(uint32_t(imu)<<12);
        if(resources!=last_release_) {
            trace::Record(Lane::Ui,Event::ReleasePending,resources);
            last_release_=resources;
        }
        if(imu==sion::agent::Result::Failed)return imu;
        if(head_touch==sion::agent::Result::Failed)return head_touch;
        if(ring==sion::agent::Result::Failed)return ring;
        if(motion==sion::agent::Result::Failed)return motion;
        if(camera==sion::agent::Result::Failed)return camera;
        if(audio!=sion::agent::Result::Done)return audio;
        if(camera!=sion::agent::Result::Done)return camera;
        if(motion!=sion::agent::Result::Done)return motion;
        if(ring!=sion::agent::Result::Done)return ring;
        if(ambient!=sion::agent::Result::Done)return ambient;
        if(head_touch!=sion::agent::Result::Done)return head_touch;
        if(imu!=sion::agent::Result::Done)return imu;
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 8);
        if(carrier->Closing()&&!carrier->Finished())return sion::agent::Result::Pending;
        trace::Checkpoint(Lane::Ui, Event::ResourceCheck, 9);
        return sion::agent::DevicePairing().Snapshot(static_cast<uint64_t>(esp_timer_get_time()/1000)).busy?
            sion::agent::Result::Pending:sion::agent::Result::Done;
    }
    sion::agent::Result ReturnHome(uint64_t) override {
#if defined(SION_APP_CENTER)
        if (stock_return==StockReturn::Rejected) {
            stock_return=StockReturn::Idle;
            stock_return_failed=true;
            show(Page::Agent);
            return sion::agent::Result::Failed;
        }
        stock_return=StockReturn::Verify;
        return sion::agent::Result::Pending;
#else
#if defined(SION_MENU_RETURN)
        if (menu_return_available) {
            return_to_menu = true;
            return sion::agent::Result::Done;
        }
#endif
        show(Page::Entry);
        return sion::agent::Result::Done;
#endif
    }
};
}
extern "C" void app_main() {
    trace::StartDeviceTrace();
#if defined(SION_APP_CENTER)
#if defined(SION_APP_CENTER_HOME)
    sion::app_center::ClearHomeMenuRequest();
#endif
    if (!ReviewedStockCanResume()) {
        trace::Record(Lane::Boot,Event::StockCheck,0);
        std::puts("DSH.AGENT requires a verified factory return slot");
        return;
    }
    trace::Record(Lane::Boot,Event::StockCheck,1);
    const bool storage_ready=RegisterReviewedTailStorage()==ESP_OK;
    trace::Record(Lane::Boot,Event::StorageReady,storage_ready);
    if (!storage_ready) {
        std::puts("DSH.AGENT independent settings storage unavailable");
    }
#endif
    trace::Record(Lane::Boot,Event::HalEntry);
    GetHAL().init();
    trace::Record(Lane::Boot,Event::HalReady);
    factory_return_configured=FactoryReturnConfigured();
#if defined(SION_MENU_RETURN)
    menu_return_available=factory_return_configured&&sion_menu_selector_installed();
#endif
    Settings factory_audio("audio",false);
    preferences.Load(factory_audio.GetInt("output_volume",40)); // Read-only seed, never written back.
    const bool usb_worker_started=sion::agent::StartPairingUsb(); // Status only until an explicit physical window.
    audio_worker_ready=sion::agent::StartAudioWorker(); // No acquisition or recording.
    camera_worker_ready=sion::agent::StartCameraWorker(); // Idle task, no camera acquisition.
    motion_worker_ready=sion::agent::StartMotionWorker(); // Idle, permission disabled; no motor IO.
    ring_worker_ready=sion::agent::StartRingWorker();
    const bool sensor_worker_ready=sion::agent::StartSensorWorker();
    // Infrared is optional: a failed RMT setup only leaves it unavailable.
    sion::agent::StartInfraredWorker();
    // NFC is optional too: a missing chip or failed setup only leaves it unavailable.
    sion::agent::StartNfcWorker();
    // Observation only: temperature, CPU share and input/UI progress every 30 s.
    trace::StartDeviceHealth();
    trace::Record(Lane::Boot,Event::Workers,uint32_t(usb_worker_started)|(uint32_t(audio_worker_ready)<<1)|
        (uint32_t(camera_worker_ready)<<2)|(uint32_t(motion_worker_ready)<<3)|
        (uint32_t(ring_worker_ready)<<4)|(uint32_t(sensor_worker_ready)<<5));
    smooth_ui_toolkit::ui_hal::on_delay([](uint32_t ms){GetHAL().delay(ms);});
    smooth_ui_toolkit::ui_hal::on_get_tick([]{return GetHAL().millis();});
    DeviceEffects effects; DeviceExpression expression; sion::agent::SessionLifecycle lifecycle(effects);
    carrier=&sion::agent::DeviceNetwork();
    SelectedWire wire;
    sion::agent::AgentSession session(lifecycle,sion::agent::DeviceAudio(),sion::agent::DevicePairing(),wire,&expression,camera_worker_ready?&sion::agent::DeviceCamera():nullptr,
        motion_worker_ready?&sion::agent::DeviceMotion():nullptr,ring_worker_ready?&sion::agent::DeviceRing():nullptr,ReadAgentBattery,
        sensor_worker_ready?&sion::agent::DeviceAmbient():nullptr,
        sensor_worker_ready?&sion::agent::DeviceHeadTouch():nullptr,
        sensor_worker_ready?&sion::agent::DeviceImu():nullptr);
    session.SetHealthReader(trace::LatestHealth);
    session.SetScreenTouch(&sion::agent::DeviceScreenTouch());
    if(sensor_worker_ready)session.SetPower(&sion::agent::DevicePower());
    session.SetVolumeSetter([](int volume){preferences.Volume(volume);return true;});
    session.SetInfrared(sion::agent::DeviceIr());
    session.SetNfc(sion::agent::DeviceNfc());
    session.SetDisplay(&display);
    {
        trace::Checkpoint(Lane::Ui,Event::UiFirstRender);
        LvglLockGuard lock;
#if defined(SION_MENU_RETURN) || defined(SION_APP_CENTER)
#if defined(SION_MENU_RETURN)
        const bool open_directly=menu_return_available;
#else
        const bool open_directly=true;
#endif
        if (open_directly) {
            if (wants_captions(preferences.value().appearance)) prepare_caption_font();
            // Once paired, start on the face; an unpaired device still needs the setup page.
            const auto paired=sion::agent::DevicePairing().Snapshot(0).pairing.state==sion::agent::PairingState::Paired;
            show(paired?Page::Avatar:Page::Agent);
        } else
#endif
        show(Page::Entry);
    }
    trace::Record(Lane::Boot,Event::FirstScreen,static_cast<uint32_t>(page));
    uint64_t next_resource_sample=0;
    uint32_t last_resource_state=UINT32_MAX;
    uint64_t last_ui_progress=esp_timer_get_time()/1000;
    uint64_t next_ui_health=last_ui_progress;
    uint32_t longest_ui_gap=0;
    while(true) {
        trace::Checkpoint(Lane::Ui,Event::UiYield,static_cast<uint32_t>(page));
        GetHAL().delay(20);
        bool restart=false;
        {
            trace::Checkpoint(Lane::Ui,Event::UiWaitingLock,static_cast<uint32_t>(page));
            LvglLockGuard lock;
            const auto now=static_cast<uint64_t>(esp_timer_get_time()/1000);
            unsigned pending=intents.exchange(0);
            trace::Checkpoint(Lane::Ui,Event::UiHandlingIntents,static_cast<uint32_t>(page));
            if(pending) {
                processing_action_batch=queued_action_batch;
                queued_action_batch=trace::NextTraceId(queued_action_batch);
                trace::Record(Lane::Ui,Event::UiIntent,pending);
                trace::Record(Lane::Actions,Event::UiActionStarted,
                    trace::TracePair(processing_action_batch,static_cast<uint16_t>(page)));
            }
            using sion::agent::Phase;
            const auto phase=lifecycle.phase();
            const bool face_tapped=page==Page::Avatar&&!text_scroll&&(pending&TapFace);
            const bool text_start_pressed=page==Page::Avatar&&text_scroll&&(pending&StartText);
            // On a linked standby face, Stop means "stop talking": the reply ends
            // and the link stays, so DSH can still reach this body. Otherwise the
            // Stop button holds standby until the face is tapped again.
            if((pending&Stop)&&page==Page::Avatar&&phase==Phase::Active&&session.standby()) {
                session.Attention(now,true);
                pending&=~Stop;
            }
            if((pending&Stop)&&page==Page::Avatar) standby_hold=true;
            // Back from the menu goes to the face, which keeps reaching for DSH.
            if((pending&(Home|Stop))||((pending&Back)&&page!=Page::Agent)) queued_start=0;
            if(face_tapped&&phase==Phase::Active&&session.standby()) {
                // Linked standby: a tap asks DSH for attention, as a tap wakes the
                // factory assistant. The link itself stays up.
                session.Attention(now);
                if(whale)whale->Poke(now);
            } else if(face_tapped&&(phase==Phase::Connecting||phase==Phase::Active||phase==Phase::Fault||
               (phase==Phase::Idle&&!carrier->Finished()))) {
                pending|=Stop;
                queued_start=0;
            } else if((face_tapped||text_start_pressed)&&!preferences.value().microphone_disabled&&
                      ready_to_connect(phase,session.attached())) {
                standby_hold=false;
                request_start(now);
            }
            if((pending&Home)&&agent_page(page)) {sion::agent::DevicePairing().CloseWindow();carrier->Close();session.LocalStop(true,now);}
            else if((pending&Stop)&&agent_page(page)) {sion::agent::DevicePairing().CloseWindow();carrier->Close();session.LocalStop(false,now);}
            else if((pending&Open)&&page==Page::Entry) {
                if(lifecycle.phase()==sion::agent::Phase::Home) lifecycle.Reopen();
                if(wants_captions(preferences.value().appearance))prepare_caption_font();
                show(Page::Agent);
            }
            else if((pending&AskFactoryReturn)&&page==Page::Entry&&factory_return_configured) show(Page::FactoryConfirm);
            else if((pending&Back)&&page==Page::FactoryConfirm) show(Page::Entry);
            else if((pending&ConfirmFactoryReturn)&&page==Page::FactoryConfirm&&factory_return_configured) {
                const auto phase=lifecycle.phase();
                restart=(phase==sion::agent::Phase::Idle||phase==sion::agent::Phase::Home)&&
                    !session.attached()&&carrier->Finished()&&
                    sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle&&
                    camera_idle()&&motion_idle()&&ring_idle()&&!sion::agent::DevicePairing().Snapshot(now).reserved();
                if(!restart)update_status_label(factory_status_text,"Wait for resources to close");
            }
            else if((pending&(Connect|ConnectUsb|ConnectRelay))&&page==Page::Agent&&
                    ready_to_connect(phase,session.attached())) {
                connection_chosen=true;
                start_connection(pending,now);
            }
            else if((pending&SettingsPage)&&page==Page::Agent) show(Page::Settings);
            else if((pending&CameraSettings)&&page==Page::Settings) show(Page::CameraSettings);
            else if((pending&MotionSettings)&&page==Page::Settings) show(Page::MotionSettings);
            else if((pending&RingSettings)&&page==Page::Settings) show(Page::RingSettings);
            else if((pending&DisplaySettings)&&page==Page::Settings) show(Page::DisplaySettings);
            else if((pending&PairingPage)&&page==Page::Agent) show(Page::Pairing);
            else if((pending&AvatarPage)&&page==Page::Agent) show(Page::Avatar);
            else if((pending&Mute)&&text_scroll) preferences.Mute(!preferences.value().muted);
            else if((pending&Back)&&(page==Page::Settings||page==Page::Pairing||page==Page::Avatar)) {sion::agent::DevicePairing().CloseWindow();show(Page::Agent);}
            else if((pending&Back)&&page==Page::Agent) show(Page::Avatar);
            else if((pending&Back)&&settings_page(page)) show(Page::Settings);
            else if((pending&AllowPairing)&&page==Page::Pairing) {
                const bool idle=lifecycle.phase()==sion::agent::Phase::Idle &&
                    sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle&&camera_idle()&&motion_idle()&&ring_idle()&&carrier->Finished();
                pairing_denied=!(idle&&sion::agent::OpenDevicePairingWindow(now));
            }
            else if(settings_page(page)) {
                if(pending) save_requires_idle=false;
                if((pending&ToggleCamera)&&page==Page::CameraSettings&&camera_worker_ready) preferences.AllowCamera(!preferences.value().camera_allowed);
                if((pending&ToggleMotion)&&page==Page::MotionSettings&&motion_worker_ready) preferences.AllowMotion(!preferences.value().motion_allowed);
                if((pending&ToggleRing)&&page==Page::RingSettings&&ring_worker_ready) preferences.AllowRing(!preferences.value().ring_allowed);
                if((pending&(ChooseDefault|ChooseFish|ChooseText|ChooseWhale))&&page==Page::DisplaySettings) {
                    const auto appearance=pending&ChooseText?Appearance::Text:pending&ChooseWhale?Appearance::Whale:pending&ChooseFish?Appearance::Fish:Appearance::Default;
                    // A live connection freezes its caption opt-in until the user disconnects.
                    display_requires_idle=(wants_captions(appearance)!=wants_captions(preferences.value().appearance))&&
                        (lifecycle.phase()!=sion::agent::Phase::Idle||!carrier->Finished()||session.attached());
                    if(!display_requires_idle) {
                        preferences.SetAppearance(appearance);
                        if(wants_captions(appearance))prepare_caption_font();
                        else sion::agent::ReleaseFactoryCaptionFont();
                    }
                }
                if((pending&VolumeUp)&&page==Page::Settings) preferences.Volume(preferences.value().volume+5);
                if((pending&VolumeDown)&&page==Page::Settings) preferences.Volume(preferences.value().volume-5);
                if((pending&Mute)&&page==Page::Settings) preferences.Mute(!preferences.value().muted);
                if((pending&Microphone)&&page==Page::Settings) {
                    preferences.DisableMicrophone(!preferences.value().microphone_disabled);
                    if(preferences.value().microphone_disabled){carrier->Close();session.LocalStop(false,now);}
                }
                if((pending&ToggleWake)&&page==Page::Settings&&audio_worker_ready) {
                    preferences.SetWakeStandby(!preferences.value().wake_standby);
                }
                // NVS writes may block. Never begin one while resources are active.
                if(pending&Save) {
                    if(lifecycle.phase()==sion::agent::Phase::Idle &&
                       sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle &&
                       camera_idle()&&motion_idle()&&ring_idle()&&
                       carrier->Finished()&&!sion::agent::DevicePairing().Snapshot(now).reserved()) preferences.Save();
                    else save_requires_idle=true;
                }
            }
            if(queued_start) {
                // A tap, or standby reaching for DSH, as soon as everything is idle.
                if(!link_page(page)||preferences.value().microphone_disabled||now>=queued_start_until) queued_start=0;
                else if(ready_to_connect(lifecycle.phase(),session.attached())) {start_connection(queued_start,now);queued_start=0;}
            }
            trace::Checkpoint(Lane::Ui,Event::UiPollingCarrier,static_cast<uint32_t>(page));
            sion::agent::NetworkEvent event;
            for(unsigned count=0;count<8&&carrier->Poll(event);++count) {
                if(event.kind==sion::agent::NetworkEventKind::Connected) {
                    trace::Record(Lane::Ui,Event::CarrierConnected);
                    // With Wake on, this link stays up while nobody is talking and the
                    // Host decides when the device is addressed. v66: a link started
                    // from the connection page landed without standby, so a later
                    // face tap ended it. Any DSH.AGENT page now honours Wake.
                    const bool returns_to_standby=agent_page(page)&&preferences.value().wake_standby;
                    if(!agent_page(page)||!session.AttachAuthenticated(carrier->device(),carrier->pair(),carrier->boot(),now,
                        wants_captions(preferences.value().appearance),returns_to_standby))carrier->Close();
                } else if(event.kind==sion::agent::NetworkEventKind::Closed) {
                    trace::Record(Lane::Ui,Event::CarrierClosed);
                    session.Disconnected(now);
                }
                else if(event.kind==sion::agent::NetworkEventKind::Text)session.Text(std::string(event.bytes.begin(),event.bytes.end()),now);
                else session.Binary(event.bytes.data(),event.bytes.size(),now);
            }
            trace::Checkpoint(Lane::Ui,Event::UiSessionTick,static_cast<uint32_t>(lifecycle.phase()));
            session.Tick(now);
            if(session_phase!=lifecycle.phase()) {
                session_phase=lifecycle.phase();
                trace::Record(Lane::Ui,Event::SessionPhase,static_cast<uint32_t>(session_phase));
            }
            {
                const auto& value=preferences.value();
                // Linked standby keeps reaching for DSH; a refused or lost link is
                // simply tried again a little later.
                // Only a paired device has a DSH to reach; a fresh one waits on the menu.
                if(link_page(page)&&(page==Page::Avatar||sion::agent::DevicePairing().Snapshot(now).pairing.state==
                   sion::agent::PairingState::Paired)&&value.wake_standby&&!value.microphone_disabled&&
                   !standby_hold&&!queued_start&&now>=link_retry_at&&ready_to_connect(session_phase,session.attached())) {
                    request_start(now,true);
                    link_retry_at=now+8000;
                }
                // Petting works between conversations as well: sample the head
                // strip locally while the whale face is up. Nothing is sent.
                if(sensor_worker_ready&&whale&&session_phase==Phase::Idle&&now>=touch_watch_at) {
                    sion::agent::DeviceHeadTouch().Watch(lifecycle.epoch());
                    touch_watch_at=now+2000;
                } else if(sensor_worker_ready&&!whale) sion::agent::DeviceHeadTouch().Unwatch();
            }
            trace::Checkpoint(Lane::Ui,Event::UiRendering,static_cast<uint32_t>(page));
            camera_view=session.CameraSnapshot();
            refresh_settings();refresh_pairing(now);refresh_agent();
            if(avatar)avatar->update();
            display.Tick(now);
            if(fish){fish->Update(now,sion::agent::DeviceAudio().status());if(fish->talking())trace::NoteMouthOpen();}
            if(whale) {
                using sion::agent::WhaleActivity;
                auto activity=WhaleActivity::Offline;
                if(!automatic_link&&(session_phase==Phase::Connecting||(session_phase==Phase::Idle&&(queued_start||!carrier->Finished()))))
                    activity=WhaleActivity::Connecting;
                else if(session_phase==Phase::Active) {
                    const auto indicator=session.voice_indicator();
                    // Linked and not addressed: awake and waiting, like the factory standby face.
                    activity=indicator==sion::agent::RingIndicator::Waiting?WhaleActivity::Thinking:
                        indicator==sion::agent::RingIndicator::Off&&session.standby()?WhaleActivity::Standby:WhaleActivity::Listening;
                }
                const auto audio=sion::agent::DeviceAudio().status();
                // Read the existing epoch/age-fenced cache; never start a sensor here.
                const auto touch=sion::agent::DeviceHeadTouch().Snapshot(lifecycle.epoch(),now);
                const bool valid=touch.channel1>=0&&touch.channel2>=0&&touch.channel3>=0;
                const int level=valid?std::max({touch.channel1,touch.channel2,touch.channel3}):0;
                // Measured on a real device (2026-11-23): stray blips are level 1 and
                // last up to 250 ms; a real pat reads level 3. Only a firm reading counts.
                const bool petting=level>=2;
                whale->Update(now,audio,activity,petting);
                if(whale->talking())trace::NoteMouthOpen();
            }
            if(text_scroll) refresh_text(session.CaptionSnapshot(),ready_to_connect(session_phase,session.attached()));
            if(whale_bubble) {
                const bool waiting=session_phase==sion::agent::Phase::Active&&
                    session.voice_indicator()==sion::agent::RingIndicator::Waiting;
                refresh_whale_bubble(session.CaptionSnapshot(),now,
                    whale&&(whale->talking()||waiting||(session_phase==sion::agent::Phase::Active&&
                        session.voice_indicator()==sion::agent::RingIndicator::Speaking)),waiting);
            }
            if(agent_page(page)) view::update_home_indicator();
            if(status_labels_changed) {
                page_revision=trace::NextTraceId(page_revision);
                trace::Record(Lane::Actions,Event::PageContentChanged,trace::TracePair(processing_action_batch,page_revision));
                publish_page_revision();
            }
            if(processing_action_batch) {
                trace::Record(Lane::Actions,Event::UiActionFinished,
                    trace::TracePair(processing_action_batch,static_cast<uint16_t>(page)));
                processing_action_batch=0;
            }
        }
        const auto sample_now=static_cast<uint64_t>(esp_timer_get_time()/1000);
        longest_ui_gap=std::max(longest_ui_gap,static_cast<uint32_t>(sample_now-last_ui_progress));
        last_ui_progress=sample_now;
        trace::NoteUiProgress();
        if(sample_now>=next_ui_health) {
            trace::RecordUiHealth(longest_ui_gap);
            longest_ui_gap=0;
            next_ui_health=sample_now+10000;
        }
        if(sample_now>=next_resource_sample) {
            next_resource_sample=sample_now+1000;
            trace::Checkpoint(Lane::Ui,Event::ResourceSample,1);
            const auto audio=sion::agent::DeviceAudio().status();
            trace::Checkpoint(Lane::Ui,Event::ResourceSample,2);
            const auto camera=sion::agent::DeviceCamera().status();
            trace::Checkpoint(Lane::Ui,Event::ResourceSample,3);
            const auto motion=sion::agent::DeviceMotion().status();
            trace::Checkpoint(Lane::Ui,Event::ResourceSample,4);
            const auto ring=sion::agent::DeviceRing().status();
            const uint32_t state=uint32_t(audio.phase)|(uint32_t(camera.phase)<<4)|
                (uint32_t(motion.phase)<<8)|(uint32_t(ring.phase)<<12)|
                (uint32_t(audio.error)<<16)|(uint32_t(camera.error)<<20)|
                (uint32_t(motion.error)<<24)|(uint32_t(ring.error)<<28);
            if(state!=last_resource_state) {
                trace::Record(Lane::Ui,Event::ResourceStates,state);
                last_resource_state=state;
            }
        }
#if defined(SION_MENU_RETURN)
        if(return_to_menu) {
            sion_menu_arm(sion_menu_memory(), SION_MENU_RETURN_STOCK);
            esp_restart();
        }
#elif defined(SION_APP_CENTER)
        if (stock_return==StockReturn::Verify) {
            trace::Record(Lane::Ui,Event::HomeVerify);
            // The SDK bootloader owns rollback metadata. Only restart an
            // unconfirmed OTA app with a verified, confirmed factory fallback.
#if defined(SION_APP_CENTER_HOME)
            if (const auto stock_address = ReviewedStockReturnAddress()) {
                sion::app_center::RequestHomeMenu(stock_address);
                esp_restart();
            }
#else
            if (ReviewedStockCanResume()) esp_restart();
#endif
            stock_return=StockReturn::Rejected;
        }
#endif
        if(restart) {
            trace::Record(Lane::Ui,Event::DeviceRestart);
            esp_restart(); // Ordinary resets use the original startup mode.
        }
    }
}
