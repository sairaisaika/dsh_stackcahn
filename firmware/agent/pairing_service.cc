// SPDX-License-Identifier: MIT
#include "pairing_service.h"
#include "sion/pairing_config.h"
#include <set>
#include <limits>
namespace sion::agent {
namespace {
// Requests contain only a root object and (for install) one flat record object.
// Bound recursive cJSON parsing before allocating its tree; reject embedded NUL.
bool BoundedJson(const std::string& text) {
    if(text.empty()||text.size()>8185)return false;
    bool quoted=false;int depth=0;
    for(size_t i=0;i<text.size();++i) {
        const char c=text[i];if(c=='\0')return false;
        if(quoted&&c=='\\') {
            if(++i>=text.size())return false;
            if(text[i]=='u'&&text.compare(i+1,4,"0000")==0)return false;
            continue;
        }
        if(c=='"'){quoted=!quoted;continue;}
        if(!quoted) {
            if(c=='['||c==']')return false;
            if(c=='{'&&++depth>2)return false;
            if(c=='}'&&--depth<0)return false;
        }
    }
    return !quoted&&depth==0;
}
std::string Field(cJSON* object,const char* key) {
    auto* value=cJSON_GetObjectItemCaseSensitive(object,key);
    return cJSON_IsString(value)?value->valuestring:"";
}
const char* StateCode(PairingState state) {
    switch(state) {
    case PairingState::Empty:return "empty";case PairingState::Paired:return "paired";
    case PairingState::Revoked:return "revoked";case PairingState::Unavailable:return "unavailable";
    case PairingState::Corrupt:return "corrupt";case PairingState::StorageError:return "storage_error";
    }return "storage_error";
}
const char* WriteCode(PairingWrite value) {
    switch(value) {
    case PairingWrite::Saved:return "saved";case PairingWrite::Unchanged:return "unchanged";
    case PairingWrite::Conflict:return "identity_conflict";case PairingWrite::Invalid:return "invalid_record";
    case PairingWrite::Unavailable:return "unavailable";case PairingWrite::Corrupt:return "corrupt";
    case PairingWrite::StorageError:return "storage_error";case PairingWrite::NoSpace:return "no_space";
    case PairingWrite::Uncertain:return "write_unconfirmed";
    }return "write_unconfirmed";
}
const char* RelayCode(RelayState state) {
    switch(state) {
    case RelayState::Ready:return "ready";
    case RelayState::Empty:return "empty";
    case RelayState::Invalid:return "invalid";
    case RelayState::StorageError:return "storage_error";
    case RelayState::Unavailable:return "unavailable";
    }
    return "unavailable";
}
}
void PairingMaintenance::Initialize(const std::string& id) {
    auto current=store_.Read();
    auto relay=store_.ReadRelay(current.id);
    std::lock_guard<std::mutex> lock(mutex_);state_={};
    state_.device_id=Hex(id,12)?id:"";state_.pairing=std::move(current);state_.relay=std::move(relay);
}
void PairingMaintenance::DriverReady(bool ready) {
    std::lock_guard<std::mutex> lock(mutex_);state_.ready=ready;
    if(!ready)state_.window.clear();
}
void PairingMaintenance::Expire(uint64_t now) {
    // A completed worker reply may carry the earlier request timestamp while
    // the UI has already opened a new window. Do not expire that newer window.
    const auto elapsed=now>=opened_at_?now-opened_at_:0;
    if(!state_.window.empty()&&elapsed>=120000)state_.window.clear();
    state_.remaining_ms=state_.window.empty()?0:120000-elapsed;
}
MaintenanceStatus PairingMaintenance::Snapshot(uint64_t now) {
    std::lock_guard<std::mutex> lock(mutex_);Expire(now);return state_;
}
bool PairingMaintenance::OpenWindow(uint64_t now,const std::string& nonce) {
    std::lock_guard<std::mutex> lock(mutex_);Expire(now);
    if(!state_.ready||state_.busy||transport_reserved_||state_.device_id.empty()||!Hex(nonce,32)||
       (state_.pairing.state!=PairingState::Empty&&state_.pairing.state!=PairingState::Paired&&
        state_.pairing.state!=PairingState::Revoked))return false;
    state_.window=nonce;opened_at_=now;state_.remaining_ms=120000;state_.result.clear();return true;
}
void PairingMaintenance::CloseWindow(){std::lock_guard<std::mutex> lock(mutex_);state_.window.clear();state_.remaining_ms=0;}
uint64_t PairingMaintenance::ReserveTransport(uint64_t now) {
    std::lock_guard<std::mutex> lock(mutex_);Expire(now);
    if(transport_reserved_||state_.reserved()||state_.pairing.state!=PairingState::Paired||
       !Hex(state_.device_id,12)||!Hex(state_.pairing.id,32)||
       transport_ticket_==std::numeric_limits<uint64_t>::max())return 0;
    transport_reserved_=true;return ++transport_ticket_;
}
bool PairingMaintenance::ReadTransport(uint64_t ticket,std::string& record) {
    record.clear();std::string expected;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!ticket||!transport_reserved_||ticket!=transport_ticket_||transport_reading_)return false;
        transport_reading_=true;expected=state_.pairing.id;
    }
    // The reservation prevents USB mutation without holding the UI lock over NVS.
    const auto status=store_.ReadPrivate(record);PairingConfig config;
    const bool valid=status.state==PairingState::Paired&&status.id==expected&&
        ParseAgentPairing(record,config)&&config.id==expected;
    {std::lock_guard<std::mutex> lock(mutex_);transport_reading_=false;}
    if(!valid)record.clear();
    return valid;
}
bool PairingMaintenance::ReleaseTransport(uint64_t ticket) {
    std::lock_guard<std::mutex> lock(mutex_);
    if(!ticket||!transport_reserved_||ticket!=transport_ticket_||transport_reading_)return false;
    transport_reserved_=false;return true;
}
void PairingMaintenance::RefreshRelayStatus() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if(state_.busy||transport_reserved_)return;
        state_.busy=true;
    }
    auto pairing=store_.Read();
    auto relay=store_.ReadRelay(pairing.id);
    std::lock_guard<std::mutex> lock(mutex_);
    state_.pairing=std::move(pairing);state_.relay=std::move(relay);state_.busy=false;
}
std::string PairingMaintenance::Reply(const std::string& id,bool ok,const char* error,uint64_t now,bool relay) {
    const auto status=Snapshot(now);auto* json=cJSON_CreateObject();
    cJSON_AddStringToObject(json,"request_id",id.c_str());cJSON_AddBoolToObject(json,"ok",ok);
    cJSON_AddStringToObject(json,"error",error);cJSON_AddStringToObject(json,"device_id",status.device_id.c_str());
    cJSON_AddStringToObject(json,"pair_id",status.pairing.id.c_str());cJSON_AddStringToObject(json,"state",StateCode(status.pairing.state));
    cJSON_AddBoolToObject(json,"ready",status.ready);cJSON_AddBoolToObject(json,"busy",status.busy);
    cJSON_AddStringToObject(json,"window",status.window.c_str());cJSON_AddNumberToObject(json,"remaining_ms",status.remaining_ms);
    cJSON_AddStringToObject(json,"result",status.result.c_str());
    if(relay) {
        cJSON_AddStringToObject(json,"relay_state",RelayCode(status.relay.state));
        cJSON_AddStringToObject(json,"relay_revision",status.relay.revision.c_str());
    }
    char* encoded=cJSON_PrintUnformatted(json);std::string result;
    if(encoded){result="SIONA1 "+std::string(encoded)+"\n";cJSON_free(encoded);}cJSON_Delete(json);return result;
}
std::string PairingMaintenance::Process(const std::string& line,uint64_t now) {
    if(line.rfind("SIONA1 ",0)!=0||line.size()>8192||!BoundedJson(line.substr(7)))return {};
    cJSON* json=cJSON_ParseWithLengthOpts(line.c_str()+7,line.size()-7+1,nullptr,true);
    if(!json)return {};
    struct JsonGuard{cJSON* p;~JsonGuard(){cJSON_Delete(p);}}guard{json};
    const auto id=Field(json,"request_id"),action=Field(json,"action");
    if(!Hex(id,32))return {};
    const bool relay=action=="relay_status"||action=="relay_install"||action=="relay_remove";
    const bool install=action=="install"||action=="relay_install";
    const auto reply=[&](bool ok,const char* error){return Reply(id,ok,error,now,relay);};
    std::set<std::string> names;
    for(auto* item=json->child;item;item=item->next)
        if(!item->string||!names.insert(item->string).second)return reply(false,"invalid_request");
    if((action=="status"||action=="relay_status"||action=="optional_lan_status")&&names==std::set<std::string>{"action","request_id"}) {
        if(relay)RefreshRelayStatus();
        return reply(true,"");
    }
    auto required=std::set<std::string>{"action","request_id","expected_device","expected_pair_id","window"};
    if(install)required.insert("record");
    if((!install&&action!="remove"&&action!="relay_remove")||names!=required)return reply(false,"invalid_request");
    const auto expected_device=Field(json,"expected_device"),expected_pair=Field(json,"expected_pair_id"),window=Field(json,"window");
    auto* pair_field=cJSON_GetObjectItemCaseSensitive(json,"expected_pair_id");
    if(!cJSON_IsString(pair_field)||((relay||!expected_pair.empty())&&!Hex(expected_pair,32)))return reply(false,"invalid_request");
    std::string record,incoming_id;
    if(install) {
        const auto* payload=cJSON_GetObjectItemCaseSensitive(json,"record");
        if(!cJSON_IsObject(payload))return reply(false,"invalid_record");
        char* encoded=cJSON_PrintUnformatted(payload);
        if(encoded){record=encoded;cJSON_free(encoded);}
        if(relay) {
            const auto revision=Field(cJSON_GetObjectItemCaseSensitive(json,"record"),"revision");
            if(record.empty()||record.size()>MaxRelayRecord||!Hex(revision,32))return reply(false,"invalid_record");
            incoming_id=revision;
        } else {
            PairingConfig config;if(!ParseAgentPairing(record,config))return reply(false,"invalid_record");
            incoming_id=config.id;
        }
    }
    const char* rejection=nullptr;
    {
        std::lock_guard<std::mutex> lock(mutex_);Expire(now);
        if(!state_.ready)rejection="usb_unavailable";
        else if(expected_device!=state_.device_id||state_.device_id.empty())rejection="wrong_device";
        else if(state_.busy||transport_reserved_)rejection="maintenance_busy";
        else if(window.empty()||window!=state_.window)rejection="window_closed";
        else if(expected_pair!=state_.pairing.id)rejection="identity_conflict";
        else {state_.busy=true;state_.window.clear();state_.remaining_ms=0;}
    }
    if(rejection)return reply(false,rejection);
    // Never hold the snapshot lock during NVS work; UI Stop/Home remains live.
    auto result=relay?store_.WriteRelay(expected_pair,install?&record:nullptr):
        install?store_.Replace(expected_pair,record):store_.Remove(expected_pair);
    const auto fresh=store_.Read();
    const auto fresh_relay=store_.ReadRelay(fresh.id);
    if(result==PairingWrite::Saved||result==PairingWrite::Unchanged) {
        bool confirmed;
        if(relay) confirmed=fresh.state==PairingState::Paired&&fresh.id==expected_pair&&
            (install?(fresh_relay.state==RelayState::Ready&&fresh_relay.revision==incoming_id):fresh_relay.state==RelayState::Empty);
        else confirmed=install?(fresh.state==PairingState::Paired&&fresh.id==incoming_id):
            (fresh.state==PairingState::Empty||fresh.state==PairingState::Revoked);
        if(!confirmed)result=PairingWrite::Uncertain;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        state_.pairing=fresh;state_.relay=fresh_relay;state_.busy=false;state_.result=WriteCode(result);
    }
    const bool ok=result==PairingWrite::Saved||result==PairingWrite::Unchanged;
    return reply(ok,ok?"":WriteCode(result));
}
}
