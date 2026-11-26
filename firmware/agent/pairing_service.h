// SPDX-License-Identifier: MIT
#pragma once
#include "agent_relay_config.h"
#include "pairing_store.h"
#include <cstdint>
#include <mutex>
#include <string>
namespace sion::agent {
struct PairingRepository {
    virtual ~PairingRepository()=default;
    virtual PairingStatus Read()=0;
    // Private consumer only; never serialized into USB status or UI snapshots.
    virtual PairingStatus ReadPrivate(std::string& record) {record.clear();return {};}
    virtual PairingWrite Replace(const std::string&,const std::string&)=0;
    virtual PairingWrite Remove(const std::string&)=0;
    virtual RelayStatus ReadRelay(const std::string&) {return {};}
    virtual PairingWrite WriteRelay(const std::string&,const std::string*) {return PairingWrite::Unavailable;}
};
struct MaintenanceStatus {
    PairingStatus pairing;
    RelayStatus relay;
    bool ready=false,busy=false;
    uint64_t remaining_ms=0;
    std::string window,device_id,result;
    bool reserved()const{return busy||remaining_ms!=0;}
};
class PairingMaintenance {
public:
    explicit PairingMaintenance(PairingRepository& store):store_(store){}
    // Boot only, before the USB worker starts.
    void Initialize(const std::string& device_id);
    void DriverReady(bool ready);
    // UI owner must first verify lifecycle/audio Idle. No network caller may arm.
    bool OpenWindow(uint64_t now,const std::string& random_nonce);
    void CloseWindow();
    MaintenanceStatus Snapshot(uint64_t now);
    // One worker calls Process; status remains available while NVS is busy.
    std::string Process(const std::string& line,uint64_t now);
    // The application owner reserves before dispatching the network worker.
    // Only that worker reads credentials and releases after its client is gone.
    uint64_t ReserveTransport(uint64_t now);
    bool ReadTransport(uint64_t ticket,std::string& record);
    bool ReleaseTransport(uint64_t ticket);
private:
    PairingRepository& store_;
    std::mutex mutex_;
    MaintenanceStatus state_;
    uint64_t opened_at_=0;
    uint64_t transport_ticket_=0;
    bool transport_reserved_=false,transport_reading_=false;
    void Expire(uint64_t now);
    void RefreshRelayStatus();
    std::string Reply(const std::string& request_id,bool ok,const char* error,uint64_t now,bool relay=false);
};
// Bounded framing; overlong lines are discarded through newline, not tail-parsed.
class PairingLineBuffer {
public:
    bool Feed(char byte,uint64_t now,std::string& line) {
        if(now-last_>5000){buffer_.clear();overflow_=false;}
        last_=now;
        if(byte=='\n') {
            const bool deliver=!overflow_&&!buffer_.empty();
            if(deliver)line=std::move(buffer_);
            buffer_.clear();overflow_=false;return deliver;
        }
        if(byte!='\r'&&!overflow_) {
            if(buffer_.size()>=8192){buffer_.clear();overflow_=true;}
            else buffer_.push_back(byte);
        }
        return false;
    }
private:
    std::string buffer_;bool overflow_=false;uint64_t last_=0;
};
}
