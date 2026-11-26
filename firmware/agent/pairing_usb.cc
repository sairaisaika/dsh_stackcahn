// SPDX-License-Identifier: MIT
#include "pairing_usb.h"
#include "agent_network.h"
#include "agent_psk_tls.h"
#include "agent_usb_frames.h"
#include "device_trace.h"
#include "sion/pairing_config.h"
#include <bootloader_random.h>
#include <driver/usb_serial_jtag.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/platform_util.h>
#include <cstdio>
namespace sion::agent {
namespace {
namespace trace=diagnostics;
using trace::Event;
using trace::Lane;
class Repository final:public PairingRepository {
    AgentPairingStore store_;
public:
    PairingStatus Read()override{return store_.Read();}
    PairingStatus ReadPrivate(std::string& record)override{return store_.Read(&record);}
    PairingWrite Replace(const std::string& expected,const std::string& record)override{return store_.Replace(expected,record);}
    PairingWrite Remove(const std::string& expected)override{return store_.Remove(expected);}
    RelayStatus ReadRelay(const std::string& pair)override{return ReadAgentRelayStatus(pair);}
    PairingWrite WriteRelay(const std::string& pair,const std::string* record)override{return store_.WriteRelay(pair,record);}
};
uint64_t Now(){return static_cast<uint64_t>(esp_timer_get_time()/1000);}
constexpr uint64_t OpenMs=15000, HandshakeMs=6000, SilenceMs=15000, WriteMs=3000;

int SendUsb(void*,const unsigned char* bytes,size_t size) {
    const auto sent=usb_serial_jtag_write_bytes(bytes,std::min<size_t>(size,2048),0);
    return sent>0?sent:MBEDTLS_ERR_SSL_WANT_WRITE;
}
int ReceiveUsb(void*,unsigned char* bytes,size_t size) {
    const auto read=usb_serial_jtag_read_bytes(bytes,size,0);
    return read>0?read:MBEDTLS_ERR_SSL_WANT_READ;
}
class PairingUsb final:public AgentCarrier {
public:
    bool Start(uint64_t now)override {
        if(!Finished())return false;
        const auto status=DevicePairing().Snapshot(now);
        if(!status.ready){status_text_="USB service unavailable";return false;}
        const auto ticket=DevicePairing().ReserveTransport(now);
        if(!ticket){status_text_="Pair first; close USB window";return false;}
        const auto generation=queue_.Begin();
        if(!generation){DevicePairing().ReleaseTransport(ticket);return false;}
        generation_=generation;ticket_=ticket;opened_=now;
        device_=status.device_id;pair_=status.pairing.id;boot_.clear();
        status_text_="USB: waiting for Mac";
        armed_=true;
        return true;
    }
    bool Poll(NetworkEvent& event)override{return queue_.Poll(generation_,event);}
    bool Finished()override{return queue_.Finished();}
    bool Closing()override{return queue_.Closing(generation_);}
    const char* StatusText()const override{return status_text_.load();}
    const std::string& device()const override{return device_;}
    const std::string& pair()const override{return pair_;}
    const std::string& boot()const override{return boot_;}
    bool Text(const std::string& text)override {
        return queue_.Send(generation_,NetworkEventKind::Text,reinterpret_cast<const uint8_t*>(text.data()),text.size());
    }
    bool Binary(const uint8_t* bytes,size_t size)override{return queue_.Send(generation_,NetworkEventKind::Binary,bytes,size);}
    bool CameraText(const std::string& text)override{return queue_.CameraText(generation_,text);}
    bool Congested()override{return queue_.Congested(generation_);}
    void Close()override {if(!Finished())status_text_="Closing USB...";queue_.Close(generation_);}
    void Worker() {
        // Only this task ever reads from the driver, including during TLS.
        bool ready=Install();
        PairingLineBuffer lines;
        char chunk[256];std::string line;
        while(ready) {
            if(armed_.exchange(false)) {
                lines=PairingLineBuffer();
                Run();
                ready=DevicePairing().Snapshot(Now()).ready;
                continue;
            }
            const int size=usb_serial_jtag_read_bytes(chunk,sizeof(chunk),1);
            // A short pairing read may race the arm. Examine those bytes as
            // preamble before reading further, keeping a single serial owner.
            if(armed_.exchange(false)) {
                lines=PairingLineBuffer();
                Run(chunk,size>0?size:0);
                ready=DevicePairing().Snapshot(Now()).ready;
                continue;
            }
            for(int i=0;i<size;++i) {
                const auto now=Now();
                if(!lines.Feed(chunk[i],now,line))continue;
                trace::Record(Lane::Usb,Event::UsbPairingRequest);
                trace::Checkpoint(Lane::Usb,Event::UsbPairingRequest);
                const auto reply=DevicePairing().Process(line,now);line.clear();
                trace::Record(Lane::Usb,Event::UsbPairingReply,!reply.empty());
                trace::Checkpoint(Lane::Usb,Event::UsbPairingReply,!reply.empty());
                if(reply.empty())continue;
                const int sent=usb_serial_jtag_write_bytes(reply.data(),reply.size(),pdMS_TO_TICKS(500));
                const bool queued=sent==static_cast<int>(reply.size());
                trace::Record(Lane::Usb,Event::UsbPairingQueued,queued);
                trace::Checkpoint(Lane::Usb,Event::UsbPairingQueued,queued);
                if(!queued)DevicePairing().CloseWindow();
                else trace::Record(Lane::Usb,Event::UsbPairingDrain,usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(100)));
            }
        }
    }
private:
    AgentNetworkQueue queue_;
    std::atomic<bool> armed_{false};
    std::atomic<const char*> status_text_{"USB disconnected"};
    uint64_t generation_=0,ticket_=0,opened_=0;
    std::string device_,pair_,boot_;

    static bool Install() {
        trace::Record(Lane::Usb,Event::UsbDriverBegin);
        trace::Checkpoint(Lane::Usb,Event::UsbDriverBegin);
        usb_serial_jtag_driver_config_t config{.tx_buffer_size=8192,.rx_buffer_size=8192};
        const bool ok=!usb_serial_jtag_is_driver_installed()&&usb_serial_jtag_driver_install(&config)==ESP_OK;
        DevicePairing().DriverReady(ok);
        trace::Record(Lane::Usb,Event::UsbDriverEnd,ok);
        trace::Checkpoint(Lane::Usb,Event::UsbDriverEnd,ok);
        return ok;
    }
    bool WaitForHost(uint64_t generation,const char* initial,int size) {
        UsbPreambleReader preamble;
        UsbPreambleReader<UsbStandbyProbe> probe;
        bool announced=false, probe_seen=false;
        const auto accept=[&](char byte) {
            if(probe.Feed(byte)&&!announced&&!queue_.Closing(generation)) {
                // This worker is in a physically armed audio window. A legacy
                // Host never probes and receives only its original TLS bytes.
                announced=usb_serial_jtag_write_bytes(UsbStandbyReady,sizeof(UsbStandbyReady)-1,0)==sizeof(UsbStandbyReady)-1;
                if(!probe_seen)trace::Record(Lane::Usb,Event::UsbStandbyProbeSeen);
                if(!probe_seen||announced)trace::Record(Lane::Usb,Event::UsbStandbyReadyQueued,announced);
                probe_seen=true;
            }
            return preamble.Feed(byte);
        };
        for(int i=0;i<size&&!queue_.Closing(generation);++i)if(accept(initial[i]))return true;
        while(!queue_.Closing(generation)&&Now()-opened_<OpenMs) {
            char byte;
            if(usb_serial_jtag_read_bytes(&byte,1,1)==1&&accept(byte))return true;
        }
        return false;
    }
    bool Handshake(AgentPskTls& tls,uint64_t generation) {
        trace::Record(Lane::Usb,Event::UsbTlsBegin);
        trace::Checkpoint(Lane::Usb,Event::UsbTlsBegin);
        // The pairing reservation excludes the Wi-Fi worker. This app has no
        // internal ADC clients. Supply SAR entropy only during the handshake.
        bootloader_random_enable();
        const auto start=Now();
        int result=MBEDTLS_ERR_SSL_WANT_READ;
        while(!queue_.Closing(generation)&&Now()-start<HandshakeMs&&usb_serial_jtag_is_connected()) {
            result=tls.Handshake();
            if(result!=MBEDTLS_ERR_SSL_WANT_READ&&result!=MBEDTLS_ERR_SSL_WANT_WRITE)break;
            vTaskDelay(1);
        }
        if(!result) {
            uint8_t random[16];esp_fill_random(random,sizeof(random));
            char boot[33];
            for(size_t i=0;i<sizeof(random);++i)std::snprintf(boot+i*2,3,"%02x",random[i]);
            boot_=boot;
        }
        bootloader_random_disable();
        trace::Record(Lane::Usb,Event::UsbTlsResult,static_cast<uint32_t>(result));
        return !result;
    }
    bool Serve(uint64_t generation,uint64_t ticket) {
        std::string record;
        PairingConfig pairing;
        if(!DevicePairing().ReadTransport(ticket,record)||!ParseAgentPairing(record,pairing)||pairing.id!=pair_)return false;
        AgentPskTls tls;
        const bool configured=tls.Configure(PskDomain::Usb,device_,pair_,pairing.local_token,nullptr,SendUsb,ReceiveUsb);
        for(auto* secret:{&record,&pairing.local_token,&pairing.control_key,&pairing.key})
            mbedtls_platform_zeroize(secret->data(),secret->size());
        status_text_="USB: verifying paired Mac...";
        if(!configured)trace::Record(Lane::Usb,Event::UsbTlsResult,1);
        if(!configured||!Handshake(tls,generation)||!queue_.Connected(generation))return false;
        status_text_="USB connected; waiting for Mac";
        Pump(tls,generation);
        return true;
    }
    void Pump(AgentPskTls& tls,uint64_t generation) {
        trace::Record(Lane::Usb,Event::UsbPumpBegin);
        trace::Checkpoint(Lane::Usb,Event::UsbPumpBegin);
        UsbFrameReader reader;
        std::array<uint8_t,AgentNetworkQueue::MaxMessage+UsbHeaderSize> tx;
        uint8_t input[512];
        size_t offset=0,length=0;
        auto heard=Now();uint64_t started_tx=0;
        auto reason=trace::UsbEnd::Closing;
        while(!queue_.Closing(generation)) {
            if(!usb_serial_jtag_is_connected()){reason=trace::UsbEnd::NoBus;break;}
            const auto now=Now();
            if(now-heard>=SilenceMs){reason=trace::UsbEnd::PeerQuiet;break;}
            if(reader.Expired(now)){reason=trace::UsbEnd::PartialFrame;break;}
            if(length&&now-started_tx>=WriteMs){reason=trace::UsbEnd::WriteTimeout;break;}
            const int count=tls.Read(input,sizeof(input));
            if(count>0) {
                if(!reader.Feed(input,count,now,[&](uint8_t kind,const uint8_t* bytes,size_t size){
                    heard=now;
                    return kind==UsbKeepalive?bytes[0]==0:queue_.Receive(generation,kind,true,size,0,bytes,size,now);
                })){reason=trace::UsbEnd::FrameRejected;break;}
            }else if(count!=MBEDTLS_ERR_SSL_WANT_READ){reason=trace::UsbEnd::ReadError;break;}

            if(!length) {
                NetworkEvent event;
                if(queue_.TakeOutput(generation,event)) {
                    const size_t size=event.bytes.size();
                    tx[0]=event.kind==NetworkEventKind::Text?1:2;tx[1]=size>>8;tx[2]=size&255;
                    std::memcpy(tx.data()+UsbHeaderSize,event.bytes.data(),size);
                    offset=0;length=UsbHeaderSize+size;started_tx=now;
                }
            }
            int written=0;
            if(length) {
                written=tls.Write(tx.data()+offset,length-offset);
                if(written>0){offset+=written;if(offset==length)length=0;}
                else if(written!=MBEDTLS_ERR_SSL_WANT_WRITE){reason=trace::UsbEnd::WriteError;break;}
            }
            if(count<=0&&written<=0)vTaskDelay(1);
        }
        trace::Record(Lane::Usb,Event::UsbPumpExit,static_cast<uint32_t>(reason));
        trace::Checkpoint(Lane::Usb,Event::UsbTlsExit);
        // Best-effort alert, then discard the session. No stop receipt is invented.
        tls.CloseNotify();
    }
    void Run(const char* initial=nullptr,int size=0) {
        const auto generation=generation_,ticket=ticket_;
        trace::Record(Lane::Usb,Event::UsbWaitHost);
        trace::Checkpoint(Lane::Usb,Event::UsbWaitHost);
        const bool opened=WaitForHost(generation,initial,size);
        trace::Record(Lane::Usb,Event::UsbHostSeen,opened);
        const bool was_online=opened&&!queue_.Closing(generation)&&Serve(generation,ticket);
        const bool cancelled=queue_.Closing(generation);
        queue_.Close(generation);
        // Drop queued CDC bytes on failed flush rather than leaking them into
        // a subsequent connection. The USB driver is installed on this core.
        trace::Checkpoint(Lane::Usb,Event::UsbDrain);
        const auto drained=usb_serial_jtag_wait_tx_done(1);
        trace::Record(Lane::Usb,Event::UsbDrain,static_cast<uint32_t>(drained));
        if(drained!=ESP_OK) {
            trace::Record(Lane::Usb,Event::UsbDriverRecover);
            trace::Checkpoint(Lane::Usb,Event::UsbDriverRecover);
            usb_serial_jtag_driver_uninstall();
            Install();
        }
        bool released=DevicePairing().ReleaseTransport(ticket);
        trace::Record(Lane::Usb,Event::UsbReleased,released);
        trace::Checkpoint(Lane::Usb,Event::UsbReleased,released);
        status_text_=!released?"USB release failed":cancelled?"USB disconnected":
            !opened?"USB port not opened - retry":was_online?"USB connection ended - retry":"USB pairing failed - retry";
        if(released)queue_.Finish(generation);
    }
};
PairingUsb& Usb(){static PairingUsb usb;return usb;}
void UsbWorker(void*){Usb().Worker();vTaskDelete(nullptr);}
}
PairingMaintenance& DevicePairing(){static Repository store;static PairingMaintenance service(store);return service;}
AgentCarrier& DeviceUsbAudio(){return Usb();}
bool DeviceUsbHostPresent(){return usb_serial_jtag_is_connected();}
bool StartPairingUsb() {
    static bool started=false;if(started)return true;
    uint8_t mac[6]{};if(esp_read_mac(mac,ESP_MAC_WIFI_STA)!=ESP_OK)return false;
    char id[13];std::snprintf(id,sizeof(id),"%02x%02x%02x%02x%02x%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    DevicePairing().Initialize(id);
    started=xTaskCreatePinnedToCore(UsbWorker,"dsh_pairing",16384,nullptr,1,nullptr,0)==pdPASS;
    return started;
}
bool OpenDevicePairingWindow(uint64_t now) {
    uint8_t bytes[16];esp_fill_random(bytes,sizeof(bytes));char nonce[33];
    for(size_t i=0;i<sizeof(bytes);++i)std::snprintf(nonce+i*2,3,"%02x",bytes[i]);
    return DevicePairing().OpenWindow(now,nonce);
}
}
