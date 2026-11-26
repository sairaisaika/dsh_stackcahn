// SPDX-License-Identifier: MIT
// Actual worker/callback implementation against an injectable SDK. This tests
// ownership and configuration; it does not implement or claim a TLS handshake.
#include "agent_network.cc"
#include "agent_relay_config.cc"
#include "pairing_service.cc"
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <fstream>
#include <iostream>
#include <thread>
using namespace sion::agent;
const char* WIFI_EVENT="wifi";const char* IP_EVENT="ip";
static std::thread worker;
static std::mutex gate;static std::condition_variable changed;
static bool destroying=false,allow_destroy=false,clock_fail=false;
static std::atomic<int> wifi_stop{0},wifi_deinit{0},loop_delete{0};
enum class WifiCase { Primary, Fallback, Timeout, MissingStop, NoProfile, CancelAttempt };
static WifiCase wifi_case=WifiCase::Primary;
static std::atomic<int64_t> advance_ms{0};
static std::atomic<bool> attempt_started{false};
static std::atomic<bool> relay_socket_started{false},tls_waiting{false},permit_tls{false},outer_output{false},short_write{false};
static bool expect_relay=false;
static bool omit_lan=false;
static std::string private_relay;
static int attempts=0;
static bool pending_ip=false,genuine_ip=false;
static std::string current_ssid;
static esp_netif_t our_netif,other_netif;
static esp_event_handler_t ip_callback=nullptr,ws_callback=nullptr,wifi_callback=nullptr;
static bool got_ip_registered=false,lost_ip_registered=false;
static void* wifi_context=nullptr;
static void *ip_context=nullptr,*ws_context=nullptr;
static const auto started=std::chrono::steady_clock::now();
static const std::string pair_id(32,'c');
static std::string Record(){return "{\"version\":1,\"role\":\"sion-device\",\"pair_id\":\""+pair_id+
 "\",\"control_key\":\""+std::string(64,'a')+"\",\"local_token\":\""+std::string(64,'b')+
 "\",\"local_url\":\""+(omit_lan?"":"wss://192.168.1.2:8766/audio")+"\",\"ca\":\"-----BEGIN CERTIFICATE-----test-ca\","
 "\"cert\":\"-----BEGIN CERTIFICATE-----test-cert\",\"key\":\"-----BEGIN PRIVATE KEY-----test-key\"}";}
static std::string RelayRecord(){return "{\"version\":1,\"pair_id\":\""+pair_id+
 "\",\"origin\":\"wss://relay.example.test:8443/\",\"room_id\":\""+std::string(32,'1')+
 "\",\"token\":\""+std::string(64,'2')+"\",\"ca\":\"-----BEGIN CERTIFICATE-----\\ntest-ca\","
 "\"ssid\":\"Sion hotspot\",\"password\":\"one test password\"}";}
namespace sion::agent {
struct Store:PairingRepository {
 PairingStatus Read()override{return {PairingState::Paired,pair_id};}
 PairingStatus ReadPrivate(std::string& value)override{value=Record();return Read();}
 PairingWrite Replace(const std::string&,const std::string&)override{assert(false);return PairingWrite::Uncertain;}
 PairingWrite Remove(const std::string&)override{assert(false);return PairingWrite::Uncertain;}
};
PairingMaintenance& DevicePairing(){static Store store;static PairingMaintenance maintenance(store);return maintenance;}
const esp_partition_t* AgentConfigPartition(){static esp_partition_t fixture;return &fixture;}
AgentPskTls::AgentPskTls()=default;
AgentPskTls::~AgentPskTls()=default;
bool AgentPskTls::Configure(PskDomain domain,std::string_view device,std::string_view pair,
                            std::string_view token,void* io,mbedtls_ssl_send_t* send,mbedtls_ssl_recv_t* receive) {
 assert(domain==PskDomain::Relay&&device=="001122334455"&&pair==pair_id&&token==std::string(64,'b'));
 assert(!alpn_);alpn_="fixture";config_={};
 session_={io,send,receive};tls_waiting=true;return true;
}
int AgentPskTls::Handshake(){return permit_tls?0:MBEDTLS_ERR_SSL_WANT_READ;}
}
int64_t esp_timer_get_time(){
 return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-started).count()+advance_ms*1000;
}
int xTaskCreate(void(*fn)(void*),const char*,unsigned,void* arg,unsigned,void*){worker=std::thread([=]{fn(arg);});return pdPASS;}
void vTaskDelete(void*){}
static void GotIp(esp_netif_t* netif,uint32_t address=0x1234,bool address_changed=false){
 assert(got_ip_registered);
 ip_event_got_ip_t event{};event.esp_netif=netif;event.ip_info.ip.addr=address;event.ip_changed=address_changed;
 ip_callback(ip_context,IP_EVENT,IP_EVENT_STA_GOT_IP,&event);
}
static void LostIp(esp_netif_t* netif){
 assert(lost_ip_registered);
 ip_event_got_ip_t event{};event.esp_netif=netif;
 ip_callback(ip_context,IP_EVENT,IP_EVENT_STA_LOST_IP,&event);
}
static void Wifi(int32_t event){wifi_callback(wifi_context,WIFI_EVENT,event,nullptr);}
void vTaskDelay(unsigned ticks){
 if(wifi_case==WifiCase::Timeout||wifi_case==WifiCase::MissingStop)advance_ms+=ticks;
 if(pending_ip){pending_ip=false;genuine_ip=true;GotIp(&our_netif);}
 std::this_thread::sleep_for(std::chrono::milliseconds(1));
}
void esp_fill_random(void* out,size_t size){std::memset(out,0xcd,size);}
extern "C" int nvs_open(const char* name,nvs_open_mode_t mode,nvs_handle_t* handle){assert(std::string(name)=="wifi"&&mode==NVS_READONLY);*handle=4;return ESP_OK;}
extern "C" int nvs_open_from_partition(const char* partition,const char* name,nvs_open_mode_t mode,nvs_handle_t* handle){
 assert(std::string(partition)=="sion_cfg"&&std::string(name)=="pairing"&&mode==NVS_READONLY);*handle=5;return ESP_OK;
}
extern "C" int nvs_get_blob(nvs_handle_t handle,const char* key,void* output,size_t* size){
 assert(handle==5&&std::string(key)=="relay");
 if(private_relay.empty())return ESP_ERR_NVS_NOT_FOUND;
 if(output){assert(*size==private_relay.size());std::memcpy(output,private_relay.data(),*size);}
 else *size=private_relay.size();
 return ESP_OK;
}
extern "C" int nvs_get_str(nvs_handle_t handle,const char* key,char* out,size_t* size){
 assert(handle==4);
 if(wifi_case==WifiCase::NoProfile)return ESP_ERR_NVS_NOT_FOUND;
 const std::string name(key);
 if(name=="ssid2")return ESP_ERR_NVS_NOT_FOUND; // Empty slot between saved entries.
 std::string value;
 if(name=="ssid")value="primary";
 else if(name=="ssid1")value="secondary";
 else if(name=="ssid3")value="third";
 else if(name=="password"||name=="password1"||name=="password3")value="test-password";
 else return ESP_ERR_NVS_NOT_FOUND;
 assert(*size>value.size());std::strcpy(out,value.c_str());return ESP_OK;
}
extern "C" void nvs_close(nvs_handle_t handle){assert(handle==4||handle==5);}
int esp_wifi_get_mode(wifi_mode_t*){return ESP_ERR_WIFI_NOT_INIT;}
esp_netif_t* esp_netif_get_handle_from_ifkey(const char*){return nullptr;}
int esp_netif_init(){return ESP_OK;}
int esp_event_loop_create_default(){return ESP_OK;}
int esp_event_loop_delete_default(){++loop_delete;return ESP_OK;}
esp_netif_t* esp_netif_create_default_wifi_sta(){return &our_netif;}
void esp_netif_destroy_default_wifi(void*){}
int esp_wifi_init(const wifi_init_config_t* config){assert(!config->nvs_enable);return ESP_OK;}
int esp_wifi_set_storage(int storage){assert(storage==WIFI_STORAGE_RAM);return ESP_OK;}
int esp_wifi_set_mode(wifi_mode_t mode){assert(mode==WIFI_MODE_STA);return ESP_OK;}
int esp_event_handler_instance_register(const char* base,int id,esp_event_handler_t fn,void* arg,void** handle){
 *handle=arg;
 if(base==IP_EVENT){
  assert(id==IP_EVENT_STA_GOT_IP||id==IP_EVENT_STA_LOST_IP);
  bool& registered=id==IP_EVENT_STA_GOT_IP?got_ip_registered:lost_ip_registered;
  assert(!registered);registered=true;ip_callback=fn;ip_context=arg;
 }
 if(base==WIFI_EVENT){wifi_callback=fn;wifi_context=arg;}
 return ESP_OK;
}
int esp_event_handler_instance_unregister(const char* base,int id,void*){
 if(base==IP_EVENT){
  bool& registered=id==IP_EVENT_STA_GOT_IP?got_ip_registered:lost_ip_registered;
  assert(registered);registered=false;
 }
 return ESP_OK;
}
int esp_wifi_set_config(int mode,const wifi_config_t* config){
 assert(mode==WIFI_IF_STA);
 current_ssid=reinterpret_cast<const char*>(config->sta.ssid);
 return ESP_OK;
}
int esp_wifi_start(){return ESP_OK;}
int esp_wifi_connect(){
 ++attempts;attempt_started=true;genuine_ip=false;
 if(wifi_case==WifiCase::Timeout||wifi_case==WifiCase::CancelAttempt)return ESP_OK;
 if((wifi_case==WifiCase::Fallback||wifi_case==WifiCase::MissingStop)&&attempts==1){
  assert(current_ssid=="primary");Wifi(WIFI_EVENT_STA_DISCONNECTED);return ESP_OK;
 }
 if(wifi_case==WifiCase::Fallback){
  assert(attempts==2&&current_ssid=="secondary");
  GotIp(&our_netif); // Late notification from the previous attempt, before association.
  Wifi(WIFI_EVENT_STA_CONNECTED);
  GotIp(&other_netif);
  GotIp(&our_netif,0);
  pending_ip=true;
 }else{
  Wifi(WIFI_EVENT_STA_CONNECTED);genuine_ip=true;GotIp(&our_netif,0x1234,true);
 }
 return ESP_OK;
}
int esp_wifi_stop(){
 ++wifi_stop;
 if(wifi_case!=WifiCase::MissingStop)Wifi(WIFI_EVENT_STA_STOP);
 return ESP_OK;
}
int esp_wifi_deinit(){++wifi_deinit;return ESP_OK;}
int esp_netif_sntp_init(const esp_sntp_config_t* config){assert(genuine_ip&&std::string(config->servers[0])=="pool.ntp.org");return clock_fail?-1:ESP_OK;}
int esp_netif_sntp_sync_wait(unsigned){return ESP_OK;}
void esp_netif_sntp_deinit(){}
esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t* config){
 if(expect_relay){
  assert(std::string(config->uri)=="wss://relay.example.test:8443/v1/rooms/"+std::string(32,'1')+"/device");
  assert(std::string(config->cert_pem)=="-----BEGIN CERTIFICATE-----\ntest-ca"&&config->cert_common_name==nullptr);
  assert(std::string(config->subprotocol)=="sion-rendezvous-v1"&&current_ssid=="Sion hotspot");
  assert(std::string(config->headers)=="Authorization: Bearer "+std::string(64,'2')+"\r\n");
 }else{
  assert(std::string(config->uri)=="wss://192.168.1.2:8766/audio");
  assert(std::string(config->cert_pem)=="-----BEGIN CERTIFICATE-----test-ca");
  assert(std::string(config->cert_common_name)=="sion-host"&&std::string(config->subprotocol)=="sion-agent-v1");
  assert(std::string(config->headers).find("Authorization: Bearer "+std::string(64,'b')+"\r\n")!=std::string::npos);
 }
 assert(!config->skip_cert_common_name_check&&config->disable_auto_reconnect&&!config->enable_close_reconnect&&config->buffer_size==2048);
 return reinterpret_cast<void*>(1);
}
int esp_websocket_register_events(void*,int,esp_event_handler_t fn,void* arg){ws_callback=fn;ws_context=arg;return ESP_OK;}
int esp_websocket_client_start(void*){ws_callback(ws_context,nullptr,WEBSOCKET_EVENT_CONNECTED,nullptr);if(expect_relay)relay_socket_started=true;return ESP_OK;}
int esp_websocket_client_send_text(void*,const char*,int size,unsigned){return size;}
int esp_websocket_client_send_bin(void*,const char* bytes,int size,unsigned){
 if(expect_relay){assert(size==6&&std::memcmp(bytes,"\1\0\3bye",6)==0);outer_output=true;}
 return short_write?size-1:size;
}
int esp_websocket_client_destroy(void*){
 std::unique_lock<std::mutex> lock(gate);destroying=true;changed.notify_all();changed.wait(lock,[]{return allow_destroy;});return ESP_OK;
}
void RelayFrame(int kind,std::string_view data){
 esp_websocket_event_data_t event{};
 event.data_ptr=data.data();event.data_len=data.size();event.payload_len=data.size();event.op_code=kind;event.fin=true;
 ws_callback(ws_context,nullptr,WEBSOCKET_EVENT_DATA,&event);
}
template<class Predicate> void Until(Predicate ready){
 const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
 while(!ready()&&std::chrono::steady_clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(1));
 assert(ready());
}
int main(int argc,char** argv){
 if(argc==3){
  std::ifstream input(argv[1]);assert(input.good());
  const std::string record((std::istreambuf_iterator<char>(input)),std::istreambuf_iterator<char>());
  AgentRelayConfig config;
  assert(ParseAgentRelayConfig(record,argv[2],config));
  assert(config.origin=="wss://localhost:8443"&&config.revision.size()==32&&config.ssid=="Sion fixture");
  std::cout<<"Generated device record accepted by actual ESP relay descriptor parser\n";
  return 0;
 }
 assert(argc==1);
 DevicePairing().Initialize("001122334455");DevicePairing().DriverReady(true);
 AgentNetwork network;assert(network.Finished());assert(network.Start(1));
 NetworkEvent event;bool connected=false;const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
 while(std::chrono::steady_clock::now()<deadline){
  if(network.Poll(event)&&event.kind==NetworkEventKind::Connected){connected=true;break;}
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
 }
 assert(connected&&network.device()=="001122334455"&&network.pair()==pair_id&&network.boot().size()==32);
 assert(!DevicePairing().OpenWindow(2,std::string(32,'a'))&&!network.Start(2));
 assert(network.Text("hello"));
 // Actual SDK callback delivers fragmented data to the application mailbox.
 esp_websocket_event_data_t data{};data.op_code=1;data.fin=true;data.payload_len=3;
 data.data_ptr="ab";data.data_len=2;ws_callback(ws_context,nullptr,WEBSOCKET_EVENT_DATA,&data);
 assert(!network.Poll(event));data.payload_offset=2;data.data_ptr="c";data.data_len=1;
 ws_callback(ws_context,nullptr,WEBSOCKET_EVENT_DATA,&data);
 assert(network.Poll(event)&&event.kind==NetworkEventKind::Text&&std::string(event.bytes.begin(),event.bytes.end())=="abc");
 GotIp(&other_netif,0x3456,true);
 GotIp(&our_netif);
 assert(network.Text("unchanged network"));
 GotIp(&our_netif,0x5678,true);
 assert(!network.Text("old socket after address change"));
 {std::unique_lock<std::mutex> lock(gate);assert(changed.wait_for(lock,std::chrono::seconds(2),[]{return destroying;}));}
 assert(!network.Finished()&&!DevicePairing().OpenWindow(3,std::string(32,'a')));
 ws_callback(ws_context,nullptr,WEBSOCKET_EVENT_CONNECTED,nullptr); // Late callback cannot reopen.
 assert(network.Poll(event)&&event.kind==NetworkEventKind::Closed);assert(!network.Poll(event));
 {std::lock_guard<std::mutex> lock(gate);allow_destroy=true;}changed.notify_all();worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Wifi&&wifi_stop==1&&wifi_deinit==1&&loop_delete==1);
 assert(DevicePairing().OpenWindow(4,std::string(32,'a')));DevicePairing().CloseWindow();
 clock_fail=true;assert(network.Start(5));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Clock&&wifi_stop==2&&wifi_deinit==2);
 assert(DevicePairing().OpenWindow(6,std::string(32,'a')));
 DevicePairing().CloseWindow();
 clock_fail=false;wifi_case=WifiCase::Fallback;attempts=0;
 assert(network.Start(7));
 bool connected_after_fallback=false;
 const auto fallback_deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
 while(std::chrono::steady_clock::now()<fallback_deadline){
  if(network.Poll(event)&&event.kind==NetworkEventKind::Connected){connected_after_fallback=true;break;}
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
 }
 assert(connected_after_fallback);network.Close();worker.join();
 assert(network.Finished()&&attempts==2&&wifi_stop==4);
 wifi_case=WifiCase::Timeout;attempts=0;
 assert(network.Start(8));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Wifi&&attempts==2);
 wifi_case=WifiCase::MissingStop;attempts=0;
 assert(network.Start(9));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Wifi&&attempts==1);
 wifi_case=WifiCase::NoProfile;attempts=0;
 assert(network.Start(10));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::NoSavedWifi&&attempts==0);
 wifi_case=WifiCase::CancelAttempt;attempts=0;attempt_started=false;
 assert(network.Start(11));
 const auto cancel_deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
 while(!attempt_started&&std::chrono::steady_clock::now()<cancel_deadline)
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
 assert(attempt_started);
 network.Close();worker.join();
 assert(network.Finished()&&network.error()==NetworkError::None&&attempts==1);

 AgentRelayConfig config;
 const auto good=RelayRecord();assert(ParseAgentRelayConfig(good,pair_id,config));
 assert(config.origin=="wss://relay.example.test:8443"&&config.password=="one test password");
 assert(!ParseAgentRelayConfig(good,std::string(32,'d'),config)&&config.token.empty());
 for(const auto* bad:{"ws://relay.test","wss://relay.test/path","wss://relay.test:99999","wss://relay.test?key","wss://bad@relay.test"}){
  auto changed=good;
  const std::string origin="wss://relay.example.test:8443/";
  changed.replace(changed.find(origin),origin.size(),bad);
  assert(!ParseAgentRelayConfig(changed,pair_id,config));
 }
 assert(!ParseAgentRelayConfig(good.substr(0,good.size()-1)+",\"ssid\":\"other\"}",pair_id,config));
 assert(!ParseAgentRelayConfig(good.substr(0,good.size()-1)+",\"extra\":\"\\u0000\"}",pair_id,config));

 wifi_case=WifiCase::Primary;expect_relay=true;attempts=0;
 omit_lan=true;
 sion::PairingConfig pairing;
 assert(!sion::ParsePairing(Record(),pairing));
 assert(sion::ParseAgentPairing(Record(),pairing)&&pairing.local_url.empty());
 assert(network.Start(12,NetworkMode::Relay));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::RelayConfiguration&&attempts==0);
 private_relay=good;
 assert(network.Start(13,NetworkMode::Relay));Until([]{return relay_socket_started.load();});
 assert(!network.Poll(event)&&!tls_waiting&&network.stage()==NetworkStage::Connecting);
 RelayFrame(1,"SION-RELAY-READY 1");RelayFrame(2,"\nSIONR1\n");
 Until([]{return tls_waiting.load();});assert(!network.Poll(event));
 permit_tls=true;
 Until([&]{return network.stage()==NetworkStage::Connected;});
 assert(network.Poll(event)&&event.kind==NetworkEventKind::Connected);
 RelayFrame(2,std::string_view("\3\0\1\0\1\0\3abc",10));
 Until([&]{return network.Poll(event)||event.kind==NetworkEventKind::Text;});
 assert(event.kind==NetworkEventKind::Text&&std::string(event.bytes.begin(),event.bytes.end())=="abc");
 assert(network.Text("bye"));Until([]{return outer_output.load();});
 short_write=true;assert(network.Text("bye"));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Send);

 short_write=false;relay_socket_started=false;tls_waiting=false;
 assert(network.Start(14,NetworkMode::Relay));Until([]{return relay_socket_started.load();});
 network.Close();worker.join();
 assert(network.Finished()&&network.error()==NetworkError::None&&!tls_waiting);
 assert(DevicePairing().OpenWindow(15,std::string(32,'a')));DevicePairing().CloseWindow();
 relay_socket_started=false;
 assert(network.Start(16,NetworkMode::Relay));Until([]{return relay_socket_started.load();});
 RelayFrame(2,"\nSIONR1\n");worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Protocol&&!tls_waiting);

 relay_socket_started=false;tls_waiting=false;
 assert(network.Start(17,NetworkMode::Relay));Until([]{return relay_socket_started.load();});
 RelayFrame(1,"SION-RELAY-READY 1");RelayFrame(2,"\nSIONR1\n");
 Until([&]{return network.stage()==NetworkStage::Connected;});
 assert(network.Poll(event)&&event.kind==NetworkEventKind::Connected);
 LostIp(&other_netif);
 assert(network.Text("bye"));
 LostIp(&our_netif);
 assert(!network.Text("bye"));
 assert(network.Poll(event)&&event.kind==NetworkEventKind::Closed);
 worker.join();
 assert(network.Finished()&&network.error()==NetworkError::Wifi&&!got_ip_registered&&!lost_ip_registered);

 relay_socket_started=false;tls_waiting=false;
 assert(network.Start(18,NetworkMode::Relay));Until([]{return relay_socket_started.load();});
 RelayFrame(1,"SION-RELAY-READY 1");RelayFrame(2,"\nSIONR1\n");
 Until([&]{return network.stage()==NetworkStage::Connected;});
 assert(network.Poll(event)&&event.kind==NetworkEventKind::Connected);
 network.Close();worker.join();
 assert(network.Finished()&&network.error()==NetworkError::None);

 const auto stopped=wifi_stop.load();
 expect_relay=false;attempts=0;
 assert(network.Start(19));worker.join();
 assert(network.Finished()&&network.error()==NetworkError::LanConfiguration&&attempts==0&&wifi_stop==stopped);
 assert(DevicePairing().OpenWindow(20,std::string(32,'a')));DevicePairing().CloseWindow();
 std::cout<<"Actual ESP worker checked LAN/clock, relay config, DHCP change/loss, explicit reconnect, byte forwarding and closure; TLS and radio replaced by SDK fixtures\n";
}
