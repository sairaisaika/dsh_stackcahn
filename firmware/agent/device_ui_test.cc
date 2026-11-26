// SPDX-License-Identifier: MIT
// Run the actual app entry and its callbacks with a deterministic HAL/LVGL seam.
#define ESP_PLATFORM
#include "device_trace.h"
#undef ESP_PLATFORM
#include "device_main.cc"
#include "agent_wire.h"
#include "ambient_runtime.h"
#include "pairing_service.cc"
#include <cassert>
#include <functional>
#include <iostream>
#include <vector>
#include <memory>
static std::vector<std::unique_ptr<lv_obj_t>> objects;
static lv_obj_t screen;
static std::function<void()> home_callback;
static int steps=0, saves=0, audio_opens=0;
static bool usb_host_present=false;
// A later cold start of the same process: sensors present, preferences already saved.
[[maybe_unused]] static bool sensors_available=false;
static std::optional<sion::agent::Preferences> saved_at_boot;
[[maybe_unused]] static int paired_boot_step=0,paired_boot_networks=0,paired_boot_audio=0;
[[maybe_unused]] static unsigned paired_boot_usb=0;
static int camera_opens=0,camera_closes=0;
static bool camera_hold=false,camera_close_ok=true;
static bool motion_hold=false,motion_close_ok=true;
static int motion_opens=0,motion_closes=0;
static bool ring_hold=false,ring_close_ok=true;
static int ring_opens=0,ring_closes=0;
static int network_starts=0,network_drain_ticks=0,network_last_poll_step=0;
static bool paired_for_network=false,started_reply=false;
static std::string expression_status,active_epoch;
static bool hello_captions=false,hello_standby=false;
static int hello_standby_mode=0,attentions=0;
static bool last_attention_sleep=false;
static lv_obj_t* last_scroll_target=nullptr;
static const lv_font_t factory_caption_font;
static lv_indev_t touch_pointer;
static bool pointer_active=false;
namespace sion::agent::diagnostics {
namespace {
Book fixture_book{};
TouchInputTrace fixture_driver;
LvglInputTrace fixture_lvgl;
uint32_t clock_ms(){return esp_timer_get_time()/1000;}
}
void StartDeviceTrace(){Begin(fixture_book,1,true);}
void Record(Lane lane,Event event,uint32_t detail){Put(fixture_book,lane,event,clock_ms(),detail,false);}
void Checkpoint(Lane lane,Event event,uint32_t detail){Put(fixture_book,lane,event,clock_ms(),detail,true);}
void RecordUiHealth(uint32_t){}
uint16_t TrackDriverTouch(bool valid,bool pressed,int x,int y){return fixture_driver.Sample(fixture_book,clock_ms(),valid,pressed,x,y);}
void TrackLvglTouch(bool pressed,uint16_t gesture){fixture_lvgl.Sample(fixture_book,clock_ms(),pressed,gesture);}
uint16_t LvglTouchId(){return fixture_lvgl.gesture();}
}
#if defined(SION_APP_CENTER)
static constexpr int idle_soak_ticks=30000;
static int idle_ticks=0, idle_label_writes=0;
#endif
static bool factory_font_loaded=false;
static unsigned font_loads=0,font_releases=0;
static std::string pending_start;
static std::optional<std::array<uint8_t,sion::agent::wire::kOutputBytes>> pending_audio;
static sion::agent::Preferences durable;
struct Finished {};
static esp_partition_t running_partition{0xe10000,0x1ec000,ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_APP_TEST,"dsh_agent"};
static unsigned restarts=0;
#if defined(SION_MENU_RETURN)
static uint8_t menu_memory[SION_MENU_REQUEST_BYTES]{};
bool sion_menu_selector_installed(){return true;}
volatile uint8_t* sion_menu_memory(){return menu_memory;}
#elif defined(SION_APP_CENTER)
static unsigned stock_checks=0, storage_mounts=0;
static bool valid_factory_at_startup=false;
bool ReviewedStockCanResume(){
 ++stock_checks;
 if(stock_checks==1){assert((steps==0||paired_boot_step)&&storage_mounts==0);return valid_factory_at_startup;}
 assert(sion::agent::DeviceNetwork().Finished());
 assert(sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle);
 return stock_checks==3; // Verify refusal and an explicit Home retry.
}
int RegisterReviewedTailStorage(){assert((steps==0||paired_boot_step)&&stock_checks==1);++storage_mounts;return 0;}
#if defined(SION_APP_CENTER_HOME)
static constexpr uint32_t reviewed_stock_address=0x510000;
static uint32_t requested_menu_address=reviewed_stock_address; // Stale request at cold entry.
uint32_t ReviewedStockReturnAddress(){return ReviewedStockCanResume()?reviewed_stock_address:0;}
void sion::app_center::ClearHomeMenuRequest(){requested_menu_address=0;}
void sion::app_center::RequestHomeMenu(uint32_t address){
 assert(address==reviewed_stock_address&&requested_menu_address==0&&stock_checks==3);
 requested_menu_address=address;
}
#endif
#endif
extern "C" const esp_partition_t* esp_ota_get_running_partition(){return &running_partition;}
extern "C" [[noreturn]] void esp_restart(){++restarts;throw Finished{};}
bool ReadAgentBattery(int&, bool&, bool&){return false;}
namespace sion::agent {
namespace {
struct AbsentAmbient : AmbientPort {
    bool Open() override { return false; }
    AmbientSample Read() override { assert(false); return {}; }
    bool Close() override { return true; }
} absent_ambient;
AmbientEngine ambient_fixture(absent_ambient);
struct FakeHeadTouch : HeadTouchPort {
    bool open = false;
    bool Open() override { assert(!open); open = true; return true; }
    HeadTouchSample Read() override { assert(open); return {0, 1, 3}; }
    bool Close() override { open = false; return true; }
} head_touch_port;
HeadTouchEngine head_touch_fixture(head_touch_port);
struct AbsentImu : ImuPort {
    bool Open() override { return false; }
    ImuSample Read() override { assert(false); return {}; }
    bool Close() override { return true; }
} absent_imu;
ImuEngine imu_fixture(absent_imu);
#if defined(SION_MENU_RETURN)
bool pause_head_touch_worker = false;
#endif
}
AmbientEngine& DeviceAmbient(){return ambient_fixture;}
HeadTouchEngine& DeviceHeadTouch(){return head_touch_fixture;}
ImuEngine& DeviceImu(){return imu_fixture;}
struct NoPower final:PowerReader{PowerSample Latest(uint64_t)const override{return {};}} no_power;
const PowerReader& DevicePower(){return no_power;}
IrPort* DeviceIr(){return nullptr;}
bool StartInfraredWorker(){return false;}
NfcPort* DeviceNfc(){return nullptr;}
bool StartNfcWorker(){return false;}
bool StartSensorWorker(){
#if defined(SION_MENU_RETURN)
    return true;
#else
    return sensors_available;
#endif
}
}
lv_obj_t* lv_screen_active(){return &screen;}
lv_indev_t* lv_indev_active(){return pointer_active?&touch_pointer:nullptr;}
lv_obj_t* make(lv_obj_t* parent){objects.push_back(std::make_unique<lv_obj_t>());auto* p=objects.back().get();p->parent=parent;return p;}
lv_obj_t* lv_obj_create(lv_obj_t* p){return make(p);}
lv_obj_t* lv_label_create(lv_obj_t* p){return make(p);}
lv_obj_t* lv_button_create(lv_obj_t* p){return make(p);}
lv_obj_t* lv_obj_get_parent(const lv_obj_t* p){return p->parent;}
void lv_obj_add_state(lv_obj_t* p,int state){assert(!p->deleted&&state==LV_STATE_DISABLED);p->disabled=true;}
void lv_obj_remove_state(lv_obj_t* p,int state){assert(!p->deleted&&state==LV_STATE_DISABLED);p->disabled=false;}
void lv_obj_delete(lv_obj_t* p){for(auto& o:objects)for(auto* a=o.get();a;a=a->parent)if(a==p){o->deleted=true;break;}}
void lv_obj_set_size(lv_obj_t* p,int w,int h){assert(!p->deleted);p->width=w;p->height=h;}
void lv_obj_set_width(lv_obj_t* p,int w){p->width=w;}
void lv_obj_set_pos(lv_obj_t* p,int x,int y){p->x=x;p->y=y;}
void lv_label_set_text(lv_obj_t* p,const char* text){
#if defined(SION_APP_CENTER)
 if(idle_ticks>0&&idle_ticks<=idle_soak_ticks)++idle_label_writes;
#endif
 p->text=text;
}
void lv_obj_set_style_text_font(lv_obj_t* p,const lv_font_t* font,int){assert(!p->deleted&&factory_font_loaded);p->font=font;}
const char* lv_label_get_text(lv_obj_t* p){return p->text.c_str();}
void lv_obj_set_flex_flow(lv_obj_t*,int){}
void lv_obj_set_scroll_dir(lv_obj_t*,int){}
void lv_label_set_long_mode(lv_obj_t*,int){}
void lv_obj_scroll_to_y(lv_obj_t* p,int,int){assert(!p->deleted);last_scroll_target=p;}
void lv_obj_scroll_to_view(lv_obj_t* p,int){assert(!p->deleted);last_scroll_target=p;}
void lv_obj_set_style_text_align(lv_obj_t*,int,int){}
void lv_obj_set_style_pad_all(lv_obj_t*,int,int){}
void lv_obj_align(lv_obj_t*,int,int,int){}
void lv_obj_center(lv_obj_t*){}
void lv_obj_remove_flag(lv_obj_t* p,int flag){if(flag==LV_OBJ_FLAG_HIDDEN)p->hidden=false;}
void lv_obj_add_flag(lv_obj_t* p,int flag){if(flag==LV_OBJ_FLAG_HIDDEN)p->hidden=true;}
lv_obj_t* lv_image_create(lv_obj_t* p){return make(p);}
void lv_image_set_src(lv_obj_t* p,const void* source){assert(!p->deleted&&source);p->source=source;}
void lv_obj_set_style_border_width(lv_obj_t* p,int,int){assert(!p->deleted);}
// The UI fixture links no sprite blob: one distinct address stands for each image.
namespace sion::agent::whale {
static int face_images[kFaceCount],talk_images[kFaceCount],talk_half_images[kFaceCount],blink_images[kFaceCount],blink_half_images[kFaceCount],hand_images[2];
const void* FaceImage(Face value){return &face_images[static_cast<unsigned>(value)];}
const void* TalkImage(Face value){const auto i=static_cast<unsigned>(value);return kTalkSprites[i].width?&talk_images[i]:nullptr;}
const void* BlinkImage(Face value){const auto i=static_cast<unsigned>(value);return kBlinkSprites[i].width?&blink_images[i]:nullptr;}
const void* TalkHalfImage(Face value){const auto i=static_cast<unsigned>(value);return kTalkHalfSprites[i].width?&talk_half_images[i]:nullptr;}
const void* BlinkHalfImage(Face value){const auto i=static_cast<unsigned>(value);return kBlinkHalfSprites[i].width?&blink_half_images[i]:nullptr;}
const void* HandImage(unsigned index){return index<2?&hand_images[index]:nullptr;}
}
void lv_obj_remove_style_all(lv_obj_t*){}
void lv_obj_set_style_radius(lv_obj_t*,int,int){}
void lv_obj_set_style_bg_color(lv_obj_t* p,lv_color_t c,int){assert(!p->deleted);p->color=c;}
void lv_obj_set_style_bg_opa(lv_obj_t* p,int,int){assert(!p->deleted);}
void lv_obj_add_event_cb(lv_obj_t* p,void(*cb)(lv_event_t*),int event,void* data){p->callback=cb;p->event=event;p->data=data;}
void* lv_event_get_user_data(lv_event_t* e){return e->data;}
namespace view {
void destroy_home_indicator(){home_callback={};}
void create_home_indicator(std::function<void()> fn){home_callback=fn;}
void update_home_indicator(){}
}
Settings::Settings(const char* name,bool write){assert(std::string(name)=="audio"&&!write);}
int Settings::GetInt(const char* key,int){assert(std::string(key)=="output_volume");return 0;}
namespace sion::agent {
void PrepareFactoryCaptionFont() {
 assert(!factory_font_loaded&&DeviceAudio().status().phase==AudioPhase::Idle);
 factory_font_loaded=true;++font_loads;
}
const lv_font_t* FactoryCaptionFont(){return factory_font_loaded?&factory_caption_font:nullptr;}
void ReleaseFactoryCaptionFont(){
 if(!factory_font_loaded)return;
 for(const auto& object:objects)assert(object->deleted||object->font!=&factory_caption_font);
 factory_font_loaded=false;++font_releases;
}
struct FakePort:AudioPort {
 bool Open(int)override{++audio_opens;return true;}bool Volume(int)override{return true;}
 bool Read(InputPcm&)override{return true;}bool Write(const OutputPcm&)override{return true;}bool Close()override{return true;}
};
static FakePort& fake_port(){static FakePort port;return port;}
AudioEngine& DeviceAudio(){static AudioEngine engine(fake_port());return engine;}
bool StartAudioWorker(){return true;}
bool DeviceUsbHostPresent(){return usb_host_present;}
struct FakeCamera:CameraPort {
 bool Open()override{++camera_opens;return true;}
 Result Read(uint8_t*,size_t,CameraImageInfo&)override{return Result::Pending;}
 bool Close()override{++camera_closes;return camera_close_ok;}
};
static FakeCamera camera_port;
CameraEngine& DeviceCamera(){static CameraEngine engine(camera_port);return engine;}
bool StartCameraWorker(){return true;}
struct FakeMotion:MotionPort {
 bool Open()override{++motion_opens;return true;}
 bool Move(const MotionTarget&)override{return true;}
 Result Poll(MotionFeedback&)override{return Result::Pending;}
 Result Release()override{++motion_closes;return motion_close_ok?Result::Done:Result::Failed;}
};
static FakeMotion motion_port;
MotionEngine& DeviceMotion(){static MotionEngine engine(motion_port);return engine;}
bool StartMotionWorker(){return true;}
struct FakeRing:RingPort {
 bool Open()override{++ring_opens;return true;}
 bool Show(const RingFrame&)override{return true;}
 bool Close()override{++ring_closes;return ring_close_ok;}
};
static FakeRing ring_port;
RingEngine& DeviceRing(){static RingEngine engine(ring_port);return engine;}
bool StartRingWorker(){return true;}
// A reset clears every engine's fence. The fixtures outlive the simulated
// restart, so rebuild each one in place; references to them stay valid.
template<class T,class Port> void rebuild(T& engine,Port& port){engine.~T();new(&engine) T(port);}
[[maybe_unused]] static void cold_start_engines(){
 rebuild(DeviceAudio(),fake_port());
 rebuild(DeviceCamera(),camera_port);
 rebuild(DeviceMotion(),motion_port);
 rebuild(DeviceRing(),ring_port);
 rebuild(DeviceAmbient(),absent_ambient);
 rebuild(DeviceHeadTouch(),head_touch_port);
 rebuild(DeviceImu(),absent_imu);
}
PreferenceLoad NvsPreferenceStore::Load(Preferences& p){
 ready_=true;
 if(!saved_at_boot)return PreferenceLoad::Missing;
 p=*saved_at_boot;return PreferenceLoad::Loaded;
}
bool NvsPreferenceStore::Save(const Preferences& p){assert(ready_);durable=p;++saves;return true;}
struct FakePairing:PairingRepository {
 PairingStatus Read()override{return paired_for_network?PairingStatus{PairingState::Paired,std::string(32,'c')}:PairingStatus{PairingState::Empty,{}};}
 PairingWrite Replace(const std::string&,const std::string&)override{assert(false);return PairingWrite::Uncertain;}
 PairingWrite Remove(const std::string&)override{assert(false);return PairingWrite::Uncertain;}
};
PairingMaintenance& DevicePairing(){static FakePairing store;static PairingMaintenance service(store);return service;}
bool StartPairingUsb(){DevicePairing().Initialize("001122334455");DevicePairing().DriverReady(true);return true;}
bool OpenDevicePairingWindow(uint64_t now){return DevicePairing().OpenWindow(now,std::string(32,'a'));}
const char* PairingStateText(PairingState state){assert(state==PairingState::Empty);return "No DSH pairing";}
static NetworkMode last_network_mode=NetworkMode::Lan;
AgentNetwork& DeviceNetwork(){static AgentNetwork network;return network;}
bool AgentNetwork::Start(uint64_t now){return Start(now,NetworkMode::Lan);}
bool AgentNetwork::Start(uint64_t,NetworkMode mode){
 mode_=mode;
 last_network_mode=mode;
 assert(queue_.Finished());generation_=queue_.Begin();++network_starts;network_drain_ticks=0;stage_=NetworkStage::Connecting;
 if(paired_for_network){device_="001122334455";pair_=std::string(32,'c');boot_=std::string(32,'b');queue_.Connected(generation_);}
 return true;
}
bool AgentNetwork::Poll(NetworkEvent& event){
 if(network_last_poll_step!=steps&&!queue_.Finished()&&queue_.Closing(generation_)&&++network_drain_ticks==3)queue_.Finish(generation_);
 network_last_poll_step=steps;
 if(!pending_start.empty()){
  auto value=std::move(pending_start);pending_start.clear();
  queue_.Receive(generation_,1,true,value.size(),0,reinterpret_cast<const uint8_t*>(value.data()),value.size(),steps*20);
 }
 if(pending_audio){
  const auto& value=*pending_audio;
  queue_.Receive(generation_,2,true,value.size(),0,value.data(),value.size(),steps*20);
  pending_audio.reset();
 }
 return queue_.Poll(generation_,event);
}
static void observe_control(const std::string& text,const std::string& boot){
 auto* json=cJSON_Parse(text.c_str());assert(json);auto* type=cJSON_GetObjectItemCaseSensitive(json,"type");assert(cJSON_IsString(type));
 if(std::string(type->valuestring)=="hello"){
  hello_captions=cJSON_GetObjectItemCaseSensitive(json,"caption")!=nullptr;
  const auto* standby=cJSON_GetObjectItemCaseSensitive(json,"standby");
  hello_standby=standby!=nullptr;hello_standby_mode=standby?standby->valueint:0;
  assert(cJSON_GetObjectItemCaseSensitive(json,"camera")->valueint==1); // Protocol support; no automatic capture.
  const auto* epoch=cJSON_GetObjectItemCaseSensitive(json,"epoch");assert(cJSON_IsString(epoch));
  pending_start="{\"type\":\"start\",\"request_id\":\""+std::string(32,'a')+"\",\"boot_id\":\""+boot+"\",\"epoch\":\""+epoch->valuestring+"\"}";
 }else if(std::string(type->valuestring)=="started"){started_reply=true;active_epoch=cJSON_GetObjectItemCaseSensitive(json,"epoch")->valuestring;}
 else if(std::string(type->valuestring)=="attention"){++attentions;
  const auto* intent=cJSON_GetObjectItemCaseSensitive(json,"intent");
  last_attention_sleep=cJSON_IsString(intent)&&std::string(intent->valuestring)=="sleep";}
 else if(std::string(type->valuestring)=="expression_result")expression_status=cJSON_GetObjectItemCaseSensitive(json,"status")->valuestring;
 cJSON_Delete(json);
}
bool AgentNetwork::Text(const std::string& text){
 if(queue_.Closing(generation_))return false;
 observe_control(text,boot_);return true;
}
bool AgentNetwork::CameraText(const std::string& text){return Text(text);}
bool AgentNetwork::Binary(const uint8_t*,size_t size){assert(size==992);return !queue_.Closing(generation_);}
void AgentNetwork::Close(){queue_.Close(generation_);}
const char* AgentNetwork::StatusText()const{return "Test pending network";}
struct FakeUsb final:AgentCarrier {
 AgentNetworkQueue queue;
 uint64_t generation=0;
 bool authenticate=false,hold_finish=false;
 unsigned waits=0,starts=0;
 int last_poll_step=0;
 const std::string device_id="001122334455",pair_id=std::string(32,'c'),boot_id=std::string(32,'b');
 bool Start(uint64_t)override {
  generation=queue.Begin();assert(generation);waits=0;++starts;
  if(authenticate)assert(queue.Connected(generation));
  return true;
 }
 bool Poll(NetworkEvent& event)override {
  if(last_poll_step!=steps&&Closing()&&!Finished()&&!hold_finish&&++waits==3)queue.Finish(generation);
  last_poll_step=steps;
  if(!pending_start.empty()) {
   auto command=std::move(pending_start);pending_start.clear();
   queue.Receive(generation,1,true,command.size(),0,reinterpret_cast<const uint8_t*>(command.data()),command.size(),steps*20);
  }
  return queue.Poll(generation,event);
 }
 bool Finished()override{return queue.Finished();}
 bool Closing()override{return queue.Closing(generation);}
 void Close()override{queue.Close(generation);}
 bool Text(const std::string& text)override{
  if(Closing())return false;
  assert(authenticate);observe_control(text,boot_id);return true;
 }
 bool CameraText(const std::string& text)override{return Text(text);}
 bool Binary(const uint8_t*,size_t size)override{assert(authenticate&&size==992);return !Closing();}
 const char* StatusText()const override{return "Test USB awaiting Mac";}
 const std::string& device()const override{return device_id;}
 const std::string& pair()const override{return pair_id;}
 const std::string& boot()const override{return boot_id;}
};
static FakeUsb& test_usb(){static FakeUsb usb;return usb;}
AgentCarrier& DeviceUsbAudio(){return test_usb();}
}
void fire_click(lv_obj_t* button){
 const auto gesture=trace::TrackDriverTouch(true,true,button->x,button->y);
 trace::TrackLvglTouch(true,gesture);
 trace::TrackDriverTouch(true,false);
 trace::TrackLvglTouch(false,gesture);
 pointer_active=true;
 lv_event_t event{button->data};button->callback(&event);
 pointer_active=false;
}
void click(const char* label){
 for(auto it=objects.rbegin();it!=objects.rend();++it){auto* p=it->get();if(p->deleted||p->text!=label)continue;
  auto* button=p->parent;assert(button&&button->callback);assert(button->x>=0&&button->y>=0&&button->x+button->width<=320&&button->y+button->height<=240);
  fire_click(button);return;
 }assert(false);
}
void tap_face(){
 for(const auto& object:objects) {
  auto* target=object.get();
  if(target->deleted||target->event!=LV_EVENT_SHORT_CLICKED) continue;
  assert(target->parent==panel&&target->y>=38&&target->y+target->height<220);
  fire_click(target);return;
 }
 assert(false);
}
lv_obj_t* fish_mouth(){
 for(auto& object:objects)if(!object->deleted&&object->color==0x7A3548)return object.get();
 assert(false);return nullptr;
}
std::string caption_command(const char* speaker,const char* hex,const std::string& epoch){
 return "{\"type\":\"caption\",\"boot_id\":\""+std::string(32,'b')+"\",\"epoch\":\""+epoch+
  "\",\"speaker\":\""+speaker+"\",\"text_hex\":\""+hex+"\"}";
}
void Hal::init(){}
void Hal::delay(uint32_t){
 const auto now_us=esp_timer_get_time();
 sion::agent::DeviceAudio().Pump(now_us);
 if(!camera_hold)sion::agent::DeviceCamera().Pump(now_us/1000);
 if(!motion_hold)sion::agent::DeviceMotion().Pump(now_us/1000);
 if(!ring_hold)sion::agent::DeviceRing().Pump(now_us/1000);
#if defined(SION_MENU_RETURN)
 sion::agent::DeviceAmbient().Pump(now_us/1000);
 sion::agent::DeviceImu().Pump(now_us/1000);
 if(!sion::agent::pause_head_touch_worker)sion::agent::DeviceHeadTouch().Pump(now_us/1000);
#else
 if(sensors_available){
  sion::agent::DeviceAmbient().Pump(now_us/1000);
  sion::agent::DeviceImu().Pump(now_us/1000);
  sion::agent::DeviceHeadTouch().Pump(now_us/1000);
 }
#endif
#if defined(SION_APP_CENTER)
 if(idle_ticks<idle_soak_ticks){
  assert(page==Page::Agent&&sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle);
  assert(network_starts==0&&audio_opens==0&&camera_opens==0&&motion_opens==0&&ring_opens==0);
  ++idle_ticks;
  return;
 }
 if(idle_ticks==idle_soak_ticks){
  assert(idle_label_writes==0&&"An unchanged idle screen should not write label buffers");
  ++idle_ticks;
 }
#endif
#if defined(SION_MENU_RETURN) || defined(SION_APP_CENTER)
 switch(++steps){
 case 1:
  assert(page==Page::Agent);
#if defined(SION_MENU_RETURN)
  assert(menu_return_available);
#else
  assert(stock_checks==1&&storage_mounts==1);
#endif
  paired_for_network=true;
  sion::agent::DevicePairing().Initialize("001122334455");
  sion::agent::DevicePairing().DriverReady(true);
  // Fresh devices stand by on the face; these variants exercise tap-to-talk.
  assert(preferences.value().wake_standby);preferences.SetWakeStandby(false);
  click("Back");
  break;
 case 2:
  assert(page==Page::Avatar&&network_starts==0);
  {
   const auto& entries=trace::fixture_book.lanes[static_cast<unsigned>(Lane::Actions)].entries;
   assert(entries[2].event==static_cast<unsigned>(Event::UiActionQueued)&&entries[2].detail==trace::TracePair(1,1));
   assert(entries[3].event==static_cast<unsigned>(Event::UiActionStarted)&&entries[3].detail==trace::TracePair(1,1));
   assert(entries[4].event==static_cast<unsigned>(Event::PageBuildStart)&&entries[4].detail==trace::TracePair(1,2));
   assert(entries[5].event==static_cast<unsigned>(Event::PageBuilt)&&entries[5].detail==trace::TracePair(2,4));
   assert(entries[6].event==static_cast<unsigned>(Event::UiActionFinished)&&entries[6].detail==trace::TracePair(1,4));
   assert(trace::TakePageForFlush()==2);
  }
  tap_face();break;
 case 3:break;
 case 4:assert(sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Running);tap_face();break;
 case 5:tap_face();break; // A second tap while draining must not reconnect.
 case 6:assert(restarts==0);break;
 case 7:
  assert(page==Page::Avatar&&session_phase==sion::agent::Phase::Idle&&restarts==0&&network_starts==1);
  assert(sion::agent::DeviceNetwork().Finished()&&sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle);
#if defined(SION_MENU_RETURN)
  assert(!sion::agent::head_touch_port.open);
#endif
  tap_face();
  break;
 case 8:break;
 case 9:
  assert(audio_opens==2&&started_reply);
  click("Back");break;
 case 10:
#if defined(SION_MENU_RETURN)
  assert(sion::agent::head_touch_port.open);
  sion::agent::pause_head_touch_worker=true;
#endif
  home_callback();break;
 case 11:case 12:
  assert(restarts==0&&!sion::agent::DeviceNetwork().Finished());
#if defined(SION_MENU_RETURN)
  assert(menu_memory[0]==0);
#else
  assert(stock_checks==1);
#endif
  break;
#if defined(SION_MENU_RETURN)
 case 13:
  assert(restarts==0&&sion::agent::DeviceNetwork().Finished()&&sion::agent::head_touch_port.open);
  sion::agent::pause_head_touch_worker=false;
  break;
 case 14:assert(!sion::agent::head_touch_port.open&&restarts==0);break;
#elif defined(SION_APP_CENTER)
 case 13:
  assert(stock_checks==2&&restarts==0);
  break;
 case 14:
  assert(page==Page::Agent&&session_phase==sion::agent::Phase::Fault&&stock_return_failed);
  assert(audio_text->text=="Factory return unavailable. Retry Home.");
  home_callback();
  break;
 // Paired cold start with the whale face and standby saved: straight to the
 // face, reaching for DSH by itself, and keeping the link.
 case 15:
  assert(paired_boot_step==14&&page==Page::Avatar&&whale);
  paired_boot_usb=sion::agent::test_usb().starts;paired_boot_audio=audio_opens;paired_boot_networks=network_starts;
  usb_host_present=true;sion::agent::test_usb().authenticate=true;
  break;
 case 16:break;
 case 17:
  // No carrier was chosen this boot: an enumerating USB host is preferred over Wi-Fi.
  assert(sion::agent::test_usb().starts==paired_boot_usb+1&&network_starts==paired_boot_networks);
  break;
 case 18:case 19:case 20:break;
 case 21:
  assert(session_phase==sion::agent::Phase::Active&&hello_standby_mode==2&&audio_opens==paired_boot_audio+1);
  assert(whale->face()!=sion::agent::whale::Face::Doubt&&attentions==0&&sion::agent::head_touch_port.open);
  tap_face();break; // A tap asks for attention; it does not hang up.
 case 22:break;
 case 23:
  assert(attentions==1&&session_phase==sion::agent::Phase::Active&&sion::agent::test_usb().starts==paired_boot_usb+1);
  pending_start="{\"type\":\"voice_indicator\",\"boot_id\":\""+std::string(32,'b')+"\",\"epoch\":\""+active_epoch+"\",\"state\":\"standby\"}";
  break;
 case 24:case 25:break;
 case 26:
  assert(session_phase==sion::agent::Phase::Active); // The standby indicator is a valid state.
  sion::agent::test_usb().Close(); // The Host goes away.
  break;
 case 450:
  // Reached for DSH again on its own.
  assert(sion::agent::test_usb().starts==paired_boot_usb+2&&session_phase==sion::agent::Phase::Active&&page==Page::Avatar);
  click("Stop");break; // On a linked face Stop only stops talking; the body stays reachable.
 case 930:
  assert(sion::agent::test_usb().starts==paired_boot_usb+2&&session_phase==sion::agent::Phase::Active);
  assert(attentions==2&&last_attention_sleep);
  // Petting shows on the face: sampled on the device itself.
  assert(sion::agent::head_touch_port.open&&whale->face()==sion::agent::whale::Face::Pat&&whale->patting());
  home_callback();break;
 case 940:
  assert(page==Page::Agent&&session_phase==sion::agent::Phase::Fault&&stock_return_failed);
  assert(!sion::agent::head_touch_port.open);
  home_callback();
  break;
#endif
 default:
#if defined(SION_APP_CENTER)
  if(paired_boot_step==14&&steps>26&&steps<940)break;
#endif
  assert(false);
 }
 return;
#endif
 static int before_text_connections=0;
 static std::string first_text_epoch;
 switch(++steps){
 case 1:assert(page==Page::Entry);click("Open DSH.AGENT");break;
 case 2:assert(page==Page::Agent);click("Settings");break;
 case 3:assert(page==Page::Settings);click("+");break;
 case 4:
  assert(preferences.value().volume==5);
  {
   const auto& actions=trace::fixture_book.lanes[static_cast<unsigned>(Lane::Actions)];
   const auto& update=actions.entries[(actions.latest-3)%trace::Capacity];
   assert(update.event==static_cast<unsigned>(Event::PageContentChanged)&&update.detail==trace::TracePair(3,4));
   assert(trace::TakePageForFlush()==4);
  }
  click("Mute / unmute");break;
 case 5:assert(preferences.value().muted);click("Mic on / off");break;
 case 6:assert(preferences.value().microphone_disabled);click("Save");break;
 case 7:assert(saves==1&&durable.revision==1&&durable.volume==5&&durable.microphone_disabled);click("Stop");break;
 case 8:assert(page==Page::Settings);home_callback();break;
 case 9:assert(page==Page::Entry);click("Open DSH.AGENT");break;
 case 10:assert(page==Page::Agent);click("Settings");break;
 case 11:assert(page==Page::Settings&&preferences.value().microphone_disabled);click("Back");break;
 case 12:assert(page==Page::Agent);click("Pairing");break;
 case 13:assert(page==Page::Pairing&&relay_text->text=="Pair to set up Relay");click("Allow USB");break;
 case 14:assert(sion::agent::DevicePairing().Snapshot(steps*20).reserved());click("Stop");break;
 case 15:assert(!sion::agent::DevicePairing().Snapshot(steps*20).reserved());click("Allow USB");break;
 case 16:assert(page==Page::Pairing);click("Back");break;
 case 17:assert(page==Page::Agent&&!sion::agent::DevicePairing().Snapshot(steps*20).reserved());click("Pairing");break;
 case 18:assert(page==Page::Pairing);click("Allow USB");break;
 case 19:assert(sion::agent::DevicePairing().Snapshot(steps*20).reserved());home_callback();break;
 case 20:assert(page==Page::Entry&&network_starts==0);click("Open DSH.AGENT");break;
 case 21:assert(page==Page::Agent);click("Connect / retry");break;
 case 22:assert(network_starts==1&&!sion::agent::DeviceNetwork().Finished());home_callback();break;
 case 23:assert(page==Page::Agent&&!sion::agent::DeviceNetwork().Finished());break;
 case 24:assert(page==Page::Agent);break; // Home waits for actual worker cleanup.
 case 25:assert(page==Page::Entry&&sion::agent::DeviceNetwork().Finished());click("Open DSH.AGENT");break;
 case 26:click("Connect / retry");break;
 case 27:assert(network_starts==2);click("Stop");break;
 case 28:assert(page==Page::Agent&&!sion::agent::DeviceNetwork().Finished());click("Connect / retry");break;
 case 29:assert(network_starts==2);break;
 case 30:assert(page==Page::Agent&&sion::agent::DeviceNetwork().Finished()&&audio_opens==0);
  paired_for_network=true;sion::agent::DevicePairing().Initialize("001122334455");sion::agent::DevicePairing().DriverReady(true);click("Settings");break;
 case 31:// A fresh device stands by on its face; this scenario first exercises tap-to-talk.
  assert(preferences.value().wake_standby&&wake_text->text=="Wake on");
  click("Mic on / off");click("Wake on");break;
 case 32:assert(!preferences.value().microphone_disabled);click("Back");break;
 case 33:click("Connect / retry");break;
 case 34:assert(network_starts==3&&audio_opens==1);click("Back");break;
 case 35:assert(started_reply&&avatar&&page==Page::Avatar);
  pending_start="{\"type\":\"set_expression\",\"request_id\":\""+std::string(32,'a')+"\",\"boot_id\":\""+std::string(32,'b')+"\",\"epoch\":\""+active_epoch+"\",\"expression\":\"happy\"}";break;
 case 36:assert(expression_status=="applied"&&avatar->getEmotion()==stackchan::avatar::Emotion::Happy);click("Back");break;
 case 37:assert(!avatar&&page==Page::Agent);
  pending_start="{\"type\":\"set_expression\",\"request_id\":\""+std::string(32,'a')+"\",\"boot_id\":\""+std::string(32,'b')+"\",\"epoch\":\""+active_epoch+"\",\"expression\":\"sad\"}";break;
 case 38:assert(expression_status=="unavailable");click("Back");break; // Back on the menu returns to the face.
 case 39:assert(page==Page::Avatar&&avatar&&avatar->getEmotion()==stackchan::avatar::Emotion::Neutral&&
                session_phase==sion::agent::Phase::Active);tap_face();break;      // The link stayed up throughout.
 case 40:assert(avatar->getEmotion()==stackchan::avatar::Emotion::Neutral);break;
 case 41:case 42:break;
 case 43:assert(sion::agent::DeviceNetwork().Finished()&&sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle);home_callback();break;
 case 44:assert(page==Page::Entry&&camera_opens==0);click("Open DSH.AGENT");break;
 case 45:click("Settings");break;
 case 46:click("Camera");break;
 case 47:assert(page==Page::CameraSettings&&!preferences.value().camera_allowed);click("Allow / disable");break;
 case 48:assert(preferences.value().camera_allowed&&camera_opens==0&&camera_text->text=="Allowed; camera is off");
  camera_view.phase="transferring";refresh_settings();assert(camera_text->text=="Sending photo to DSH...");
  camera_view.phase="idle";camera_view.error="cancelled";refresh_settings();assert(camera_text->text=="Last photo failed / cancelled");
  camera_view.error.clear();click("Save");break;
 case 49:
  assert(saves==2&&durable.camera_allowed&&camera_opens==0);
  // Simulates the future authenticated owner; no production capture command exists yet.
  assert(sion::agent::DeviceCamera().Begin(sion::agent::DeviceAudio().status().epoch+1,steps*20));click("Save");break;
 case 50:assert(camera_opens==1&&saves==2&&save_requires_idle);click("Allow / disable");break;
 case 51:assert(!preferences.value().camera_allowed&&camera_idle()&&camera_closes==1);click("Allow / disable");break;
 case 52:assert(camera_opens==1&&preferences.value().camera_allowed);
  assert(sion::agent::DeviceCamera().Begin(sion::agent::DeviceAudio().status().epoch+1,steps*20));click("Back");break;
 case 53:assert(page==Page::Settings&&camera_opens==2);camera_hold=true;home_callback();break;
 case 54:assert(page==Page::Settings&&session_phase==sion::agent::Phase::Draining);camera_hold=false;break;
 case 55:assert(page==Page::Settings&&camera_idle());break;
 case 56:assert(page==Page::Entry&&camera_closes==2);click("Open DSH.AGENT");break;
 case 57:click("Settings");break;
 case 58:click("Camera");break;
 case 59:assert(sion::agent::DeviceCamera().Begin(sion::agent::DeviceAudio().status().epoch+1,steps*20));break;
 case 60:assert(camera_opens==3);camera_close_ok=false;home_callback();break;
 case 61:break;
 case 62:assert(page==Page::CameraSettings&&session_phase==sion::agent::Phase::Fault&&camera_text->text=="Camera release failed");camera_close_ok=true;click("Stop");break;
 case 63:break;
 case 64:assert(page==Page::Entry&&camera_idle()&&session_phase==sion::agent::Phase::Home);click("Open DSH.AGENT");break; // A prior Home intent survives a cleanup retry.
 case 65:assert(motion_worker_ready&&motion_opens==0&&!sion::agent::DeviceMotion().status().allowed);click("Settings");break;
 case 66:click("Motion");break;
 case 67:assert(page==Page::MotionSettings&&motion_text->text=="Motion disabled");click("Allow / disable");break;
 case 68:assert(preferences.value().motion_allowed&&motion_opens==0);click("Save");break;
 case 69:
  assert(saves==3&&durable.motion_allowed);
  // Session tests verify the authenticated command. Inject here to hold
  // release across the main loop's Save and Home cycles.
  assert(sion::agent::DeviceMotion().Begin(sion::agent::DeviceAudio().status().epoch+1,{},steps*20));click("Save");break;
 case 70:assert(motion_opens==1&&saves==3&&save_requires_idle);motion_hold=true;home_callback();break;
 case 71:assert(page==Page::MotionSettings&&session_phase==sion::agent::Phase::Draining);motion_hold=false;break;
 case 72:assert(page==Page::MotionSettings&&motion_idle());break;
 case 73:assert(page==Page::Entry&&motion_closes==1);click("Open DSH.AGENT");break;
 case 74:click("Settings");break;
 case 75:click("Motion");break;
 case 76:assert(sion::agent::DeviceMotion().Begin(sion::agent::DeviceAudio().status().epoch+1,{},steps*20));break;
 case 77:assert(motion_opens==2);motion_close_ok=false;home_callback();break;
 case 78:break;
 // A failed motion release latches inside the motion engine only; the session still
 // closes and later connects are not locked out.
 case 79:assert(page==Page::Entry&&session_phase==sion::agent::Phase::Home&&sion::agent::DeviceMotion().status().phase==sion::agent::MotionPhase::Fault&&motion_idle());motion_close_ok=true;break;
 case 80:break;
 case 81:assert(page==Page::Entry&&motion_idle()&&session_phase==sion::agent::Phase::Home);click("Open DSH.AGENT");break;
 case 82:click("Settings");break;
 case 83:click("Ring");break;
 case 84:assert(page==Page::RingSettings&&ring_worker_ready&&!preferences.value().ring_allowed&&ring_opens==0);click("Allow / disable");break;
 case 85:assert(preferences.value().ring_allowed&&ring_opens==0);click("Save");break;
 case 86:assert(saves==4&&durable.ring_allowed);assert(sion::agent::DeviceRing().Begin(sion::agent::DeviceAudio().status().epoch+1,{{0,0,255},1000})==sion::agent::RingResult::None);break;
 case 87:assert(ring_opens==1);ring_hold=true;home_callback();break;
 case 88:assert(page==Page::RingSettings&&session_phase==sion::agent::Phase::Draining);ring_close_ok=false;ring_hold=false;break;
 case 89:break;
 case 90:assert(page==Page::RingSettings&&session_phase==sion::agent::Phase::Fault&&ring_text->text=="Ring off not confirmed");ring_close_ok=true;click("Stop");break;
 case 91:break;
 case 92:assert(page==Page::Entry&&ring_idle()&&session_phase==sion::agent::Phase::Home);click("Open DSH.AGENT");break;
 case 93:assert(page==Page::Agent);click("USB");break;
 case 94:assert(network_text->text=="Test USB awaiting Mac"&&!sion::agent::DeviceUsbAudio().Finished());click("Connect / retry");break;
 case 95:assert(carrier==&sion::agent::DeviceUsbAudio()&&sion::agent::DeviceNetwork().Finished());home_callback();break;
 case 96:assert(page==Page::Agent&&!sion::agent::DeviceUsbAudio().Finished());break;
 case 97:assert(page==Page::Agent);break;
 case 98:assert(page==Page::Entry&&sion::agent::DeviceUsbAudio().Finished());click("Open DSH.AGENT");break;
 case 99:click("Settings");break;
 case 100:click("Display");break;
 case 101:assert(page==Page::DisplaySettings&&audio_text->text=="Selected: Default face");click("Chubby fish");break;
 case 102:assert(audio_text->text=="Selected: Chubby fish"&&saves==4);click("Save");break;
 case 103:assert(saves==5&&durable.appearance==Appearance::Fish);click("Back");break;
 case 104:click("Mute / unmute");break;
 case 105:assert(!preferences.value().muted);click("Back");break;
 case 106:click("Relay");break;
 case 107:assert(sion::agent::last_network_mode==sion::agent::NetworkMode::Relay);click("Back");break;
 case 108:assert(fish&&!avatar&&fish_mouth()->width==36&&!hello_captions);
  pending_start="{\"type\":\"set_expression\",\"request_id\":\""+std::string(32,'a')+"\",\"boot_id\":\""+std::string(32,'b')+"\",\"epoch\":\""+active_epoch+"\",\"expression\":\"happy\"}";break;
 case 109:{
  assert(expression_status=="applied"&&fish_mouth()->width==52);
  auto& frame=pending_audio.emplace();
  std::memcpy(frame.data(),"SIA1",4);frame[4]=2;
  sion::agent::wire::Put64(frame.data()+8,std::stoull(active_epoch));
  frame[sion::agent::wire::kHeader]=123;
  break;
 }
 case 110:break; // Let the audio task accept the frame.
 case 111:assert(fish_mouth()->height==31);tap_face();break;
 case 112:assert(fish_mouth()->width==36&&fish_mouth()->height==19);tap_face();home_callback();break;
 case 113:case 114:break;
 case 115:assert(page==Page::Entry&&!fish);click("Open DSH.AGENT");break;
 case 116:click("Settings");break;
 case 117:click("Display");break;
 case 118:click("Text");break;
 case 119:assert(audio_text->text=="Selected: Text");click("Save");break;
 case 120:assert(saves==6&&durable.appearance==Appearance::Text);click("Back");break;
 case 121:click("Back");break;
 case 122:before_text_connections=network_starts;click("Back");break;
 case 123:
  assert(text_scroll&&!text_scroll->callback&&text_scroll->y+text_scroll->height<220&&
         text_start&&!text_start->disabled&&network_starts==before_text_connections);
  preferences.DisableMicrophone(true);
  click("Start");break; // Event queued just before the control could disable.
 case 124:
  assert(text_start->disabled&&network_text->text=="Microphone disabled"&&network_starts==before_text_connections);
  preferences.DisableMicrophone(false);break;
 case 125:assert(!text_start->disabled);click("Start");break;
 case 126:
  assert(text_start->disabled&&network_starts==before_text_connections+1&&
         sion::agent::last_network_mode==sion::agent::NetworkMode::Relay);
  click("Start");break; // Duplicate during connection cannot cancel or reconnect.
 case 127:assert(hello_captions&&text_scroll&&network_text->text=="Listening"&&text_user->text.empty()&&
                 text_user->font==&factory_caption_font&&text_reply->font==&factory_caption_font);
  first_text_epoch=active_epoch;
  pending_start=caption_command("user","e4bda0e5a5bd",active_epoch);break;
 case 128:assert(text_user->text=="你好"&&text_reply->text.empty()&&last_scroll_target==text_scroll);
  pending_start=caption_command("assistant","48690ae4bda0e5a5bd",active_epoch);break;
 case 129:assert(text_user->text=="你好"&&text_reply->text=="Hi\n你好"&&last_scroll_target==text_reply_heading);click("Sound on");break;
 case 130:assert(text_sound->text=="Sound off"&&preferences.value().muted);
  assert(sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Running&&
         sion::agent::DeviceAudio().status().capture_allowed);
  click("Back");break;
 case 131:click("Settings");break;
 case 132:click("Display");break;
 case 133:click("Default");break;
 case 134:assert(preferences.value().appearance==Appearance::Text&&audio_text->text=="Stop the connection to change display");click("Back");break;
 case 135:click("Back");break;
 case 136:click("Back");break;
 case 137:assert(text_reply->text=="Hi\n你好");click("Stop");break;
 case 138:assert(text_start->disabled&&text_user->text.empty()&&text_reply->text.empty());click("Start");break;
 case 139:assert(network_starts==before_text_connections+1);break;
 case 140:assert(page==Page::Avatar&&!text_start->disabled&&network_starts==before_text_connections+1);click("Start");break;
 case 141:assert(network_starts==before_text_connections+2);break;
 case 142:
  assert(hello_captions&&active_epoch!=first_text_epoch&&network_text->text=="Listening"&&text_reply->text.empty());
  assert(sion::agent::last_network_mode==sion::agent::NetworkMode::Relay);
  home_callback();break;
 case 143:case 144:break;
 case 145:assert(page==Page::Entry&&!text_scroll&&!text_start);click("Open DSH.AGENT");break;
 case 146:sion::agent::test_usb().authenticate=true;started_reply=false;click("USB");break;
 case 147:break;
 case 148:
  assert(session_phase==sion::agent::Phase::Active&&started_reply&&audio_opens==5&&!hello_standby);
  sion::agent::test_usb().hold_finish=true;
  sion::agent::test_usb().Close(); // Remote transport loss, with no user Stop.
  break;
 case 149:
  assert(session_phase==sion::agent::Phase::Draining&&!sion::agent::test_usb().Finished());
  click("Settings");break;
 case 150:assert(page==Page::Settings);click("Back");break;
 case 151:
  assert(page==Page::Agent&&audio_text->text=="Microphone is off");
  assert(session_phase==sion::agent::Phase::Draining&&!sion::agent::test_usb().Finished());
  click("USB");break;
 case 152:
  assert(sion::agent::test_usb().starts==2);
  sion::agent::test_usb().hold_finish=false;break;
 case 153:case 154:break;
 case 155:
  assert(session_phase==sion::agent::Phase::Idle&&sion::agent::test_usb().Finished());
  home_callback();break;
 case 156:assert(page==Page::Entry);click("Open DSH.AGENT");break;
 case 157:click("Settings");break;
 case 158:click("Display");break;
 case 159:assert(audio_text->text=="Selected: Text");click("Whale");break;
 case 160:
  // The whale face is chosen explicitly, and only saved when the user saves.
  assert(audio_text->text=="Selected: Whale"&&preferences.value().appearance==Appearance::Whale&&
         durable.appearance==Appearance::Text&&factory_font_loaded); // Its speech bubble keeps the caption font.
  click("Back");break;
 case 161:click("Back");break;
 case 162:assert(page==Page::Agent&&!whale);click("Back");break;
 case 163:{
  using sion::agent::whale::Face;
  assert(whale&&!fish&&!avatar&&!text_scroll);
  // Not connected: the sleepy drawing, with every overlay hidden.
  assert(whale->face()==Face::Sleepy&&!whale->patting()&&!whale->talking()&&!whale->blinking());
  unsigned shown=0,layers=0;
  for(const auto& object:objects){
   const bool image_layer=object->source||object->hidden;
   if(object->deleted||object->parent!=panel||!image_layer||object.get()==whale_bubble)continue;
   ++layers;
   if(!object->hidden){++shown;assert(object->source==sion::agent::whale::FaceImage(Face::Sleepy)&&object->x==0&&object->y==0);}
  }
  assert(layers==4&&shown==1);
  assert(whale_bubble&&whale_bubble->hidden&&whale_bubble_text->font==&factory_caption_font); // Nothing said yet.
  click("Back");break;
 }
 case 164:assert(page==Page::Agent&&!whale);click("Settings");break;
 case 165:
  // Standby was turned off earlier in this run.
  assert(page==Page::Settings&&wake_text->text=="Wake off"&&!preferences.value().wake_standby);
  click("Wake off");break;
 case 166:
  assert(preferences.value().wake_standby&&wake_text->text=="Wake on"&&audio_text->text=="Wake: stays linked to DSH");
  assert(sion::agent::test_usb().starts==2); // Nothing connects from the settings page.
  click("Back");break;
 case 167:assert(page==Page::Agent);click("Back");break; // The face and the menu stand by (owner, 2026-11-24).
 case 168:case 169:break;
 case 170:
  // No tap: the menu or the face reached for DSH by itself, on the carrier last chosen.
  assert(sion::agent::test_usb().starts==3&&network_starts==before_text_connections+2);
  assert(whale&&whale->face()!=sion::agent::whale::Face::Doubt); // Quietly, without the connecting face.
  break;
 case 171:case 172:case 173:break;
 case 174:
  assert(session_phase==sion::agent::Phase::Active&&audio_opens==6&&hello_standby&&hello_standby_mode==2&&attentions==0);
  assert(hello_captions); // The whale face shows a speech bubble.
  pending_start=caption_command("user","e4bda0e5a5bd",active_epoch);
  tap_face();break; // A tap asks DSH for attention; the link stays.
 case 175:
  assert(!whale_bubble->hidden&&whale_bubble_text->text=="你好");
  pending_start=caption_command("status","e6809de88083e4b8ad",active_epoch);break;
 case 176:
  assert(attentions==1&&session_phase==sion::agent::Phase::Active&&whale->face()==sion::agent::whale::Face::Surprised);
  assert(!whale_bubble->hidden&&whale_bubble_text->text=="思考中");
  click("Stop");break; // Stop stops talking; the link stays.
 case 177:case 178:case 179:case 180:case 181:case 182:case 183:case 184:case 185:break;
 case 186:
  assert(session_phase==sion::agent::Phase::Active&&!sion::agent::test_usb().Finished());
  assert(attentions==2&&last_attention_sleep);
  break;
 case 700:
  assert(sion::agent::test_usb().starts==3&&session_phase==sion::agent::Phase::Active); // Still the same link.
  break;
 case 701:case 702:case 703:case 704:break;
 case 705:
  assert(sion::agent::test_usb().starts==3&&audio_opens==6);
  home_callback();break;
 case 706:case 707:case 708:case 709:case 710:case 711:case 712:case 713:break;
 case 714:assert(page==Page::Entry);click("Factory assistant");break;
 case 715:assert(page==Page::FactoryConfirm&&!home_callback&&restarts==0);click("Cancel");break;
 case 716:assert(page==Page::Entry&&restarts==0);click("Factory assistant");break;
 case 717:assert(page==Page::FactoryConfirm&&sion::agent::OpenDevicePairingWindow(steps*20));
  click("Return");break;
 case 718:assert(page==Page::FactoryConfirm&&factory_status_text->text=="Wait for resources to close"&&restarts==0);
  sion::agent::DevicePairing().CloseWindow();click("Return");break;
 default:
  if(steps>186&&steps<700)break;
  assert(false);
 }
}
uint32_t Hal::millis(){return steps*20;}
Hal& GetHAL(){static Hal hal;return hal;}
int64_t esp_timer_get_time(){
#if defined(SION_APP_CENTER)
 return int64_t(steps+idle_ticks)*20000;
#else
 return steps*20000;
#endif
}
int main(){
#if defined(SION_MENU_RETURN)
 try{app_main();assert(false);}catch(Finished&){}
 assert(restarts==1&&steps==14&&saves==0&&sion::agent::DeviceNetwork().Finished());
 assert(sion::agent::DeviceAudio().status().phase==sion::agent::AudioPhase::Idle);
 assert(sion_menu_consume(menu_memory,true)==SION_MENU_RETURN_STOCK);
 assert(sion_menu_consume(menu_memory,true)==SION_MENU_NONE);
 std::cout<<"Touch-menu app: direct entry, Stop stays in DSH, Home drains real app resources then requests stock menu\n";
 return 0;
#elif defined(SION_APP_CENTER)
 app_main();
 assert(steps==0&&stock_checks==1&&storage_mounts==0&&objects.empty());
#if defined(SION_APP_CENTER_HOME)
 assert(requested_menu_address==0);
#endif
 stock_checks=0;
 valid_factory_at_startup=true;
 try{app_main();assert(false);}catch(Finished&){}
 assert(restarts==1&&steps==14&&saves==0&&stock_checks==3&&storage_mounts==1);
 assert(sion::agent::DeviceNetwork().Finished());
#if defined(SION_APP_CENTER_HOME)
 assert(requested_menu_address==reviewed_stock_address);
 std::cout<<"Paired Home: clears stale request on entry and arms only after safe return and resource drain\n";
#endif
 std::cout<<"App Center mode: isolated storage precedes UI, Stop stays in DSH, Home drains, refuses and retries\n";
 std::cout<<"App Center idle soak: 10 simulated minutes, no label writes or resource opens, then touch responds\n";
 {
  sion::agent::Preferences saved;
  saved.appearance=Appearance::Whale;saved.wake_standby=true;saved.revision=1;
  saved_at_boot=saved;sensors_available=true;paired_boot_step=steps;
  stock_checks=0;storage_mounts=0;restarts=0;
  sion::agent::cold_start_engines();
  try{app_main();assert(false);}catch(Finished&){}
  assert(restarts==1&&steps==940&&stock_checks==3&&storage_mounts==1&&saves==0);
  assert(sion::agent::test_usb().Finished()&&!sion::agent::head_touch_port.open);
  std::cout<<"Paired cold start: opens on the whale face, links by itself over USB, a tap asks for attention, a lost link is retried, Stop keeps the link and petting shows locally\n";
 }
 return 0;
#endif
 std::string caption;
 assert(sion::agent::DecodeCaption("e4bda0e5a5bd0af09f9982",caption)&&caption=="你好\n🙂");
 for(const auto* bad:{"00","ff","e4bda","e4bd","c080","eda080","f4908080","c280","xyz0"})
  assert(!sion::agent::DecodeCaption(bad,caption));
 assert(!sion::agent::DecodeCaption(std::string(2*sion::agent::kCaptionBytes+2,'6'),caption));
 const auto saved=running_partition;
 running_partition.subtype=0x10;assert(!FactoryReturnConfigured());
 running_partition=saved;running_partition.size=0x1ed000;assert(!FactoryReturnConfigured());
 running_partition=saved;assert(FactoryReturnConfigured());
 try{app_main();assert(false);}catch(Finished&){}
 assert(restarts==1&&steps==718);
 assert(motion_opens==2&&motion_closes==3&&ring_opens==1&&ring_closes==2);
 assert(audio_opens==6&&started_reply&&saves==6&&camera_opens==3&&camera_closes==4&&!sion::agent::DevicePairing().Snapshot(steps*20).reserved());
 // The third load is the last Text entry; choosing the whale face releases it.
 assert(font_loads==3&&font_releases==3&&!factory_font_loaded);
 std::cout<<"Actual device UI: USB, appearances incl. explicit whale face, linked standby, authenticated expressions/playback/captions, mute, Stop/Home and guarded factory restart passed\n";
 std::cout<<"USB loss: Settings and Back respond during held cleanup; re-entry waits for confirmed finish\n";
}
