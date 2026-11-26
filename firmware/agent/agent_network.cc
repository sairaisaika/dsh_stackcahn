// SPDX-License-Identifier: MIT
#include "agent_network.h"
#include "device_trace.h"
#include "agent_psk_tls.h"
#include "agent_relay_config.h"
#include "agent_relay_stream.h"
#include "agent_usb_frames.h"
#include "pairing_usb.h"
#include "sion/pairing_config.h"
#include <esp_event.h>
#include <esp_netif.h>
#include <esp_netif_sntp.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <esp_websocket_client.h>
#include <esp_wifi.h>
#include <esp_wifi_default.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/platform_util.h>
#include <nvs.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <new>
namespace sion::agent {
namespace {
enum class StationState { Stopped, Associating, Associated, Ready, Disconnected, Stopping };
constexpr uint64_t WifiBudgetMs=30000, WifiAttemptMs=15000, WifiStopWaitMs=1000;
constexpr uint64_t RelayRendezvousMs=40000, RelayHandshakeMs=6000, RelaySilenceMs=15000;
constexpr int32_t WifiEvents[]{WIFI_EVENT_STA_CONNECTED,WIFI_EVENT_STA_DISCONNECTED,WIFI_EVENT_STA_STOP};
constexpr int32_t IpEvents[]{IP_EVENT_STA_GOT_IP,IP_EVENT_STA_LOST_IP};
uint64_t Now(){return static_cast<uint64_t>(esp_timer_get_time()/1000);}
// Same saved-network keys as pinned 78/esp-wifi-connect. Never instantiate its
// station manager: its GOT_IP path persists the channel to the factory NVS.
bool ReadWifi(unsigned index,wifi_config_t& config) {
    nvs_handle_t handle;
    if(nvs_open("wifi",NVS_READONLY,&handle)!=ESP_OK)return false;
    char ssid_key[12],password_key[16],ssid[33]{},password[65]{};
    if(index){std::snprintf(ssid_key,sizeof(ssid_key),"ssid%u",index);std::snprintf(password_key,sizeof(password_key),"password%u",index);}
    else {std::strcpy(ssid_key,"ssid");std::strcpy(password_key,"password");}
    size_t length=sizeof(ssid);
    const bool got_ssid=nvs_get_str(handle,ssid_key,ssid,&length)==ESP_OK;
    length=sizeof(password);
    const bool got_password=nvs_get_str(handle,password_key,password,&length)==ESP_OK;
    nvs_close(handle);
    if(!got_ssid||!got_password||!ssid[0])return false;
    config={};std::memcpy(config.sta.ssid,ssid,std::strlen(ssid));
    std::memcpy(config.sta.password,password,std::strlen(password));
    return true;
}
}
struct AgentNetwork::RunContext {
    RunContext(AgentNetwork* parent,uint64_t id):owner(parent),generation(id){}
    AgentNetwork* owner;
    uint64_t generation;
    esp_netif_t* station_netif=nullptr;
    std::atomic<StationState> station{StationState::Stopped};
    std::unique_ptr<AgentRelayStream> relay;
    esp_websocket_client_handle_t client=nullptr;
    bool HasIp() const {return station==StationState::Ready;}
    void RetireIp() {
        auto ready=StationState::Ready;
        if(station.compare_exchange_strong(ready,StationState::Disconnected))
            owner->Fail(generation,NetworkError::Wifi);
    }
};
AgentNetwork& DeviceNetwork(){static AgentNetwork network;return network;}
void AgentNetwork::Fail(uint64_t generation,NetworkError error) {
    if(queue_.Closing(generation))return;
    NetworkError expected=NetworkError::None;error_.compare_exchange_strong(expected,error);
    queue_.Close(generation);
}
bool AgentNetwork::Start(uint64_t now) {return Start(now,NetworkMode::Lan);}
bool AgentNetwork::Start(uint64_t now,NetworkMode mode) {
    if(!queue_.Finished())return false;
    mode_=mode;
    ticket_=DevicePairing().ReserveTransport(now);
    if(!ticket_){error_=NetworkError::Pairing;stage_=NetworkStage::Failed;return false;}
    generation_=queue_.Begin();
    if(!generation_){DevicePairing().ReleaseTransport(ticket_);error_=NetworkError::Busy;stage_=NetworkStage::Failed;return false;}
    const auto status=DevicePairing().Snapshot(now);
    device_=status.device_id;pair_=status.pairing.id;boot_.clear();
    error_=NetworkError::None;stage_=NetworkStage::Preparing;
    if(xTaskCreate(Worker,"dsh_network",12288,this,1,nullptr)!=pdPASS) {
        error_=NetworkError::Task;stage_=NetworkStage::Failed;
        DevicePairing().ReleaseTransport(ticket_);queue_.Finish(generation_);return false;
    }
    return true;
}
bool AgentNetwork::Poll(NetworkEvent& event){queue_.Expire(generation_,Now());return queue_.Poll(generation_,event);}
bool AgentNetwork::Text(const std::string& text){return queue_.Send(generation_,NetworkEventKind::Text,reinterpret_cast<const uint8_t*>(text.data()),text.size());}
bool AgentNetwork::CameraText(const std::string& text){return queue_.CameraText(generation_,text);}
bool AgentNetwork::Binary(const uint8_t* bytes,size_t size){return queue_.Send(generation_,NetworkEventKind::Binary,bytes,size);}
void AgentNetwork::Close(){if(!queue_.Finished())stage_=NetworkStage::Closing;queue_.Close(generation_);}
void AgentNetwork::Worker(void* arg){static_cast<AgentNetwork*>(arg)->Run();vTaskDelete(nullptr);}
void AgentNetwork::WifiEvent(void* arg,const char* base,int32_t id,void* raw) {
    auto& context=*static_cast<RunContext*>(arg);
    if(base==IP_EVENT) {
        const auto* event=static_cast<const ip_event_got_ip_t*>(raw);
        if(!event||event->esp_netif!=context.station_netif)return;
        if(id==IP_EVENT_STA_LOST_IP)context.RetireIp();
        else if(id==IP_EVENT_STA_GOT_IP&&event->ip_info.ip.addr) {
            auto associated=StationState::Associated;
            // Initial DHCP enables the carrier. A later address or route change
            // retires it instead of keeping sockets tied to the old network.
            if(!context.station.compare_exchange_strong(associated,StationState::Ready)&&event->ip_changed)
                context.RetireIp();
        }
    } else if(base==WIFI_EVENT) {
        if(id==WIFI_EVENT_STA_CONNECTED) {
            auto associating=StationState::Associating;
            context.station.compare_exchange_strong(associating,StationState::Associated);
        } else if(id==WIFI_EVENT_STA_DISCONNECTED) {
            auto previous=context.station.load();
            while(previous==StationState::Associating||previous==StationState::Associated||previous==StationState::Ready) {
                if(context.station.compare_exchange_weak(previous,StationState::Disconnected)){
                    if(previous==StationState::Ready)context.owner->Fail(context.generation,NetworkError::Wifi);
                    break;
                }
            }
        } else if(id==WIFI_EVENT_STA_STOP) {
            context.station=StationState::Stopped;
        }
    }
}
void AgentNetwork::SocketEvent(void* arg,const char*,int32_t id,void* raw) {
    auto& context=*static_cast<RunContext*>(arg);auto& owner=*context.owner;
    if(owner.queue_.Closing(context.generation))return;
    if(id==WEBSOCKET_EVENT_CONNECTED) {
        if(!context.relay)owner.PublishConnected(context.generation);
    } else if(id==WEBSOCKET_EVENT_DATA) {
        const auto* event=static_cast<esp_websocket_event_data_t*>(raw);
        if(!event){owner.Fail(context.generation,NetworkError::Protocol);return;}
        if(event->op_code==8){owner.Fail(context.generation,NetworkError::Transport);return;}
        if(event->op_code==9||event->op_code==10) {
            if(!event->fin||event->payload_len>125)owner.Fail(context.generation,NetworkError::Protocol);
            return; // SDK performs ping/pong, never publishes these as audio.
        }
        const auto* bytes=reinterpret_cast<const uint8_t*>(event->data_ptr);
        if(context.relay) {
            if(!context.relay->Feed(event->op_code,event->fin,event->payload_len,event->payload_offset,bytes,event->data_len))
                owner.Fail(context.generation,NetworkError::Protocol);
        } else if(!owner.queue_.Receive(context.generation,event->op_code,event->fin,event->payload_len,
            event->payload_offset,bytes,event->data_len,Now())) {
            NetworkError expected=NetworkError::None;owner.error_.compare_exchange_strong(expected,NetworkError::Protocol);
        }
    } else if(id==WEBSOCKET_EVENT_ERROR||id==WEBSOCKET_EVENT_DISCONNECTED||id==WEBSOCKET_EVENT_CLOSED||id==WEBSOCKET_EVENT_FINISH) {
        owner.Fail(context.generation,NetworkError::Transport);
    }
}
bool AgentNetwork::PublishConnected(uint64_t generation) {
    if(!queue_.Connected(generation))return false;
    auto expected=NetworkStage::Connecting;
    return stage_.compare_exchange_strong(expected,NetworkStage::Connected);
}

void AgentNetwork::RunRelay(RunContext& context,const std::string& local_token) {
    const auto generation=context.generation;
    const auto available=[&] {
        if(!context.HasIp()){Fail(generation,NetworkError::Wifi);return false;}
        return !queue_.Closing(generation);
    };
    auto deadline=Now()+RelayRendezvousMs;
    while(available()&&!context.relay->CanHandshake()&&Now()<deadline)vTaskDelay(1);
    if(!available())return;
    if(!context.relay->CanHandshake()){Fail(generation,NetworkError::Transport);return;}

    AgentPskTls tls;
    const auto send=+[](void* opaque,const unsigned char* bytes,size_t length) {
        auto& ctx=*static_cast<RunContext*>(opaque);
        if(ctx.owner->queue_.Closing(ctx.generation)||length>AgentRelayStream::MaxFrame)
            return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
        const int sent=esp_websocket_client_send_bin(ctx.client,reinterpret_cast<const char*>(bytes),length,pdMS_TO_TICKS(250));
        return sent==static_cast<int>(length)?sent:MBEDTLS_ERR_SSL_INTERNAL_ERROR;
    };
    const auto receive=+[](void* opaque,unsigned char* bytes,size_t length) {
        auto& ctx=*static_cast<RunContext*>(opaque);
        if(ctx.owner->queue_.Closing(ctx.generation))return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
        const int received=ctx.relay->Read(bytes,length);
        return received>0?received:received==0?MBEDTLS_ERR_SSL_WANT_READ:MBEDTLS_ERR_SSL_INTERNAL_ERROR;
    };
    if(!tls.Configure(PskDomain::Relay,device_,pair_,local_token,&context,send,receive)) {
        Fail(generation,NetworkError::RelayAuthentication);return;
    }
    deadline=Now()+RelayHandshakeMs;
    int result=MBEDTLS_ERR_SSL_WANT_READ;
    while(available()&&Now()<deadline) {
        result=tls.Handshake();
        if(result!=MBEDTLS_ERR_SSL_WANT_READ&&result!=MBEDTLS_ERR_SSL_WANT_WRITE)break;
        vTaskDelay(1);
    }
    if(!available())return;
    if(result){Fail(generation,NetworkError::RelayAuthentication);return;}
    if(!PublishConnected(generation))return;

    UsbFrameReader reader;
    std::array<uint8_t,AgentNetworkQueue::MaxMessage+UsbHeaderSize> output;
    uint8_t input[512];
    auto heard=Now();
    while(available()) {
        const auto now=Now();
        if(now-heard>=RelaySilenceMs||reader.Expired(now)){Fail(generation,NetworkError::Protocol);break;}
        const int count=tls.Read(input,sizeof(input));
        if(count>0) {
            if(!reader.Feed(input,count,now,[&](uint8_t kind,const uint8_t* bytes,size_t size) {
                heard=now;
                return kind==UsbKeepalive?bytes[0]==0:queue_.Receive(generation,kind,true,size,0,bytes,size,now);
            })){Fail(generation,NetworkError::Protocol);break;}
        } else if(count!=MBEDTLS_ERR_SSL_WANT_READ){Fail(generation,NetworkError::Transport);break;}

        NetworkEvent event;
        bool sent=false;
        if(queue_.TakeOutput(generation,event)) {
            const size_t size=event.bytes.size();
            output[0]=event.kind==NetworkEventKind::Text?1:2;
            output[1]=size>>8;output[2]=size&255;
            std::memcpy(output.data()+UsbHeaderSize,event.bytes.data(),size);
            if(tls.Write(output.data(),size+UsbHeaderSize)!=static_cast<int>(size+UsbHeaderSize)) {
                Fail(generation,NetworkError::Send);break;
            }
            sent=true;
        }
        if(count<=0&&!sent)vTaskDelay(1);
    }
}

void AgentNetwork::Run() {
    namespace trace=diagnostics;
    using trace::Lane;
    using trace::Event;
    trace::Checkpoint(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Preparing));
    const auto generation=generation_,ticket=ticket_;
    auto* owned_context=new(std::nothrow) RunContext{this,generation};
    if(!owned_context) {
        Fail(generation,NetworkError::Task);DevicePairing().ReleaseTransport(ticket);
        stage_=NetworkStage::Failed;queue_.Finish(generation);return;
    }
    auto& context=*owned_context;
    esp_netif_t* netif=nullptr;
    esp_event_handler_instance_t wifi_handlers[sizeof(WifiEvents)/sizeof(*WifiEvents)]{};
    esp_event_handler_instance_t ip_handlers[sizeof(IpEvents)/sizeof(*IpEvents)]{};
    bool loop_owned=false,wifi_owned=false,wifi_started=false,sntp_owned=false;
    std::string record,headers,uri;PairingConfig pairing;AgentRelayConfig relay_config;
    const bool relay=mode_==NetworkMode::Relay;
    // A single scope funnels all failures/cancellation through the same cleanup.
    do {
        if(!DevicePairing().ReadTransport(ticket,record)||!ParseAgentPairing(record,pairing)||pairing.id!=pair_) {
            Fail(generation,NetworkError::Pairing);break;
        }
        mbedtls_platform_zeroize(record.data(),record.size());record.clear();
        if(queue_.Closing(generation))break;
        if(!relay&&pairing.local_url.empty()){Fail(generation,NetworkError::LanConfiguration);break;}
        if(relay&&!ReadAgentRelayConfig(pair_,relay_config)){Fail(generation,NetworkError::RelayConfiguration);break;}
        stage_=NetworkStage::Wifi;
        trace::Record(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Wifi));
        trace::Checkpoint(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Wifi));
        wifi_mode_t existing;
        if(esp_wifi_get_mode(&existing)!=ESP_ERR_WIFI_NOT_INIT||esp_netif_get_handle_from_ifkey("WIFI_STA_DEF")) {
            Fail(generation,NetworkError::Busy);break;
        }
        if(esp_netif_init()!=ESP_OK){Fail(generation,NetworkError::Wifi);break;}
        const auto loop=esp_event_loop_create_default();loop_owned=loop==ESP_OK;
        if(loop!=ESP_OK&&loop!=ESP_ERR_INVALID_STATE){Fail(generation,NetworkError::Wifi);break;}
        netif=esp_netif_create_default_wifi_sta();
        if(!netif){Fail(generation,NetworkError::Wifi);break;}
        context.station_netif=netif;
        wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();init.nvs_enable=false;
        if(esp_wifi_init(&init)!=ESP_OK){Fail(generation,NetworkError::Wifi);break;}
        wifi_owned=true;
        if(esp_wifi_set_storage(WIFI_STORAGE_RAM)!=ESP_OK||esp_wifi_set_mode(WIFI_MODE_STA)!=ESP_OK) {
            Fail(generation,NetworkError::Wifi);break;
        }
        bool handlers_ready=true;
        for(size_t i=0;i<sizeof(WifiEvents)/sizeof(*WifiEvents);++i) {
            if(esp_event_handler_instance_register(WIFI_EVENT,WifiEvents[i],WifiEvent,&context,&wifi_handlers[i])!=ESP_OK) {
                handlers_ready=false;break;
            }
        }
        for(size_t i=0;handlers_ready&&i<sizeof(IpEvents)/sizeof(*IpEvents);++i)
            handlers_ready=esp_event_handler_instance_register(IP_EVENT,IpEvents[i],WifiEvent,&context,&ip_handlers[i])==ESP_OK;
        if(!handlers_ready) {
            Fail(generation,NetworkError::Wifi);break;
        }
        const auto wifi_deadline=Now()+WifiBudgetMs;
        bool has_saved_network=false;
        const bool explicit_wifi=relay&&!relay_config.ssid.empty();
        for(unsigned index=0;index<(explicit_wifi?1U:10U)&&!queue_.Closing(generation)&&Now()<wifi_deadline;++index) {
            wifi_config_t config{};
            if(explicit_wifi) {
                std::memcpy(config.sta.ssid,relay_config.ssid.data(),relay_config.ssid.size());
                std::memcpy(config.sta.password,relay_config.password.data(),relay_config.password.size());
            } else if(!ReadWifi(index,config))continue;
            has_saved_network=true;
            const auto configured=esp_wifi_set_config(WIFI_IF_STA,&config);
            mbedtls_platform_zeroize(config.sta.password,sizeof(config.sta.password));
            if(configured!=ESP_OK)continue;
            context.station=StationState::Associating;
            if(esp_wifi_start()!=ESP_OK)break;
            wifi_started=true;
            if(esp_wifi_connect()==ESP_OK) {
                const auto deadline=std::min(wifi_deadline,Now()+WifiAttemptMs);
                while(!context.HasIp()&&context.station!=StationState::Disconnected&&
                      context.station!=StationState::Stopped&&!queue_.Closing(generation)&&Now()<deadline) {
                    vTaskDelay(pdMS_TO_TICKS(50));
                }
            }
            if(context.HasIp()||queue_.Closing(generation))break;
            // Wait for this attempt's stop event. The same-ID SDK handler,
            // registered first, stops the STA netif and clears old DHCP state.
            context.station=StationState::Stopping;
            if(esp_wifi_stop()!=ESP_OK)break;
            wifi_started=false;
            const auto stop_deadline=std::min(wifi_deadline,Now()+WifiStopWaitMs);
            while(context.station!=StationState::Stopped&&!queue_.Closing(generation)&&Now()<stop_deadline)
                vTaskDelay(pdMS_TO_TICKS(50));
            if(context.station!=StationState::Stopped)break;
        }
        if(queue_.Closing(generation))break;
        if(!context.HasIp()){Fail(generation,has_saved_network?NetworkError::Wifi:NetworkError::NoSavedWifi);break;}
        // RF is now running, so ESP's hardware RNG has its documented entropy source.
        uint8_t bytes[16];esp_fill_random(bytes,sizeof(bytes));char nonce[33];
        for(size_t i=0;i<sizeof(bytes);++i)std::snprintf(nonce+i*2,3,"%02x",bytes[i]);
        boot_=nonce;
        stage_=NetworkStage::Clock;
        trace::Record(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Clock));
        trace::Checkpoint(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Clock));
        esp_sntp_config_t clock=ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        if(esp_netif_sntp_init(&clock)!=ESP_OK){Fail(generation,NetworkError::Clock);break;}
        sntp_owned=true;bool synced=false;const auto deadline=Now()+15000;
        while(!queue_.Closing(generation)&&context.HasIp()&&Now()<deadline) {
            if(esp_netif_sntp_sync_wait(pdMS_TO_TICKS(100))==ESP_OK){synced=true;break;}
        }
        esp_netif_sntp_deinit();sntp_owned=false;
        if(queue_.Closing(generation))break;
        if(!context.HasIp()){Fail(generation,NetworkError::Wifi);break;}
        if(!synced){Fail(generation,NetworkError::Clock);break;}
        stage_=NetworkStage::Connecting;
        trace::Record(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Connecting));
        trace::Checkpoint(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(NetworkStage::Connecting));
        esp_websocket_client_config_t config{};
        if(relay) {
            context.relay.reset(new(std::nothrow) AgentRelayStream);
            if(!context.relay){Fail(generation,NetworkError::Task);break;}
            uri=relay_config.origin+"/v1/rooms/"+relay_config.room+"/device";
            headers="Authorization: Bearer "+relay_config.token+"\r\n";
            config.uri=uri.c_str();config.cert_pem=relay_config.ca.c_str();
            config.subprotocol="sion-rendezvous-v1";
        } else {
            headers="Authorization: Bearer "+pairing.local_token+"\r\nX-Sion-Pair-Id: "+pairing.id+
                "\r\nX-Sion-Device-Id: "+device_+"\r\n";
            config.uri=pairing.local_url.c_str();config.cert_pem=pairing.ca.c_str();
            config.cert_common_name="sion-host";config.subprotocol="sion-agent-v1";
        }
        config.skip_cert_common_name_check=false;config.headers=headers.c_str();
        config.disable_auto_reconnect=true;config.enable_close_reconnect=false;
        config.buffer_size=2048;config.task_stack=8192;config.task_prio=2;
        config.network_timeout_ms=5000;config.ping_interval_sec=5;config.pingpong_timeout_sec=10;
        auto& client=context.client;
        client=esp_websocket_client_init(&config);
        if(!client||esp_websocket_register_events(client,WEBSOCKET_EVENT_ANY,SocketEvent,&context)!=ESP_OK||
           esp_websocket_client_start(client)!=ESP_OK){Fail(generation,NetworkError::Transport);break;}
        if(relay){RunRelay(context,pairing.local_token);break;}
        const auto connect_deadline=Now()+10000;
        while(!queue_.Closing(generation)) {
            queue_.Expire(generation,Now());
            if(!context.HasIp()){Fail(generation,NetworkError::Wifi);break;}
            if(stage_!=NetworkStage::Connected&&Now()>=connect_deadline){Fail(generation,NetworkError::Transport);break;}
            NetworkEvent output;
            for(unsigned count=0;count<4&&queue_.TakeOutput(generation,output);++count) {
                const char* data=reinterpret_cast<const char*>(output.bytes.data());
                const int size=static_cast<int>(output.bytes.size());
                const int sent=output.kind==NetworkEventKind::Text?
                    esp_websocket_client_send_text(client,data,size,pdMS_TO_TICKS(250)):
                    esp_websocket_client_send_bin(client,data,size,pdMS_TO_TICKS(250));
                if(sent!=size){Fail(generation,NetworkError::Send);break;}
            }
            vTaskDelay(1);
        }
    }while(false);
    queue_.Close(generation);stage_=NetworkStage::Closing;
    trace::Record(Lane::Network,Event::NetworkCleanup,static_cast<uint32_t>(error_.load()));
    trace::Checkpoint(Lane::Network,Event::NetworkCleanup,1);
    // Only this worker may block waiting for the SDK task; never the UI/callback.
    // destroy waits for task completion even when it stopped itself on an error.
    bool cleaned=true;
    if(context.client&&esp_websocket_client_destroy(context.client)!=ESP_OK)cleaned=false;
    if(sntp_owned)esp_netif_sntp_deinit();
    if(wifi_started&&esp_wifi_stop()!=ESP_OK)cleaned=false;
    for(size_t i=0;i<sizeof(WifiEvents)/sizeof(*WifiEvents);++i)
        if(wifi_handlers[i]&&esp_event_handler_instance_unregister(WIFI_EVENT,WifiEvents[i],wifi_handlers[i])!=ESP_OK)cleaned=false;
    for(size_t i=0;i<sizeof(IpEvents)/sizeof(*IpEvents);++i)
        if(ip_handlers[i]&&esp_event_handler_instance_unregister(IP_EVENT,IpEvents[i],ip_handlers[i])!=ESP_OK)cleaned=false;
    if(wifi_owned&&esp_wifi_deinit()!=ESP_OK)cleaned=false;
    if(netif)esp_netif_destroy_default_wifi(netif);
    if(loop_owned&&esp_event_loop_delete_default()!=ESP_OK)cleaned=false;
    for(auto* secret:{&record,&pairing.local_token,&pairing.control_key,&pairing.key,&headers,&relay_config.token,&relay_config.password})
        mbedtls_platform_zeroize(secret->data(),secret->size());
    // An unconfirmed teardown retains ownership; Home must not report success.
    if(!cleaned){error_=NetworkError::Cleanup;stage_=NetworkStage::Failed;return;}
    delete owned_context;
    if(!DevicePairing().ReleaseTransport(ticket)){error_=NetworkError::Cleanup;stage_=NetworkStage::Failed;return;}
    stage_=error_==NetworkError::None?NetworkStage::Idle:NetworkStage::Failed;
    trace::Record(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(stage_.load()));
    trace::Checkpoint(Lane::Network,Event::NetworkPhase,static_cast<uint32_t>(stage_.load()));
    queue_.Finish(generation);
}
const char* AgentNetwork::StatusText()const {
    if(stage_==NetworkStage::Failed) {
        switch(error_.load()) {
        case NetworkError::Pairing:return "Pair first; close USB window";
        case NetworkError::LanConfiguration:return "Set LAN address in Mac pairing";
        case NetworkError::NoSavedWifi:return "No usable saved Wi-Fi";
        case NetworkError::Wifi:return "Saved Wi-Fi unavailable - retry";
        case NetworkError::Clock:return "Clock sync failed - retry";
        case NetworkError::Busy:return "Network resource is busy";
        case NetworkError::Cleanup:return "Network cleanup failed";
        case NetworkError::Task:return "Network task unavailable";
        case NetworkError::RelayConfiguration:return "Relay setup required";
        case NetworkError::RelayAuthentication:return "Relay Mac authentication failed";
        default:return "Connection lost - retry";
        }
    }
    switch(stage_.load()) {
    case NetworkStage::Preparing:return "Reading DSH pairing...";
    case NetworkStage::Wifi:return mode_==NetworkMode::Relay?"Connecting relay Wi-Fi...":"Connecting saved Wi-Fi...";
    case NetworkStage::Clock:return "Synchronizing clock...";
    case NetworkStage::Connecting:return mode_==NetworkMode::Relay?"Relay: waiting for paired Mac...":"Verifying paired Mac...";
    case NetworkStage::Connected:return "Connected; waiting for Mac";
    case NetworkStage::Closing:return "Closing connection...";
    default:return "Disconnected";
    }
}
}
