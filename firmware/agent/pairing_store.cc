// SPDX-License-Identifier: MIT
#include "pairing_store.h"
#include "agent_relay_config.h"
#include "storage_guard.h"
#include "sion/pairing_config.h"
#include <mbedtls/platform_util.h>
#include <nvs.h>
#include <nvs_flash.h>
namespace sion::agent {
namespace {
struct Handle { nvs_handle_t value; ~Handle(){nvs_close(value);} };
struct PrivateText {
    std::string value;
    ~PrivateText(){mbedtls_platform_zeroize(value.data(),value.size());}
};
struct PrivateRelayConfig {
    AgentRelayConfig value;
    ~PrivateRelayConfig(){
        mbedtls_platform_zeroize(value.token.data(),value.token.size());
        mbedtls_platform_zeroize(value.password.data(),value.password.size());
    }
};
PairingWrite ClearRelay(nvs_handle_t handle) {
    const auto erased=nvs_erase_key(handle,RelayBlobKey);
    if(erased==ESP_ERR_NVS_NOT_FOUND)return PairingWrite::Unchanged;
    if(erased!=ESP_OK||nvs_commit(handle)!=ESP_OK)return PairingWrite::Uncertain;
    size_t length=0;
    return nvs_get_blob(handle,RelayBlobKey,nullptr,&length)==ESP_ERR_NVS_NOT_FOUND?
        PairingWrite::Saved:PairingWrite::Uncertain;
}
PairingState ReadBlob(nvs_handle_t h,const char* key,std::string& data) {
    size_t size=0;
    const auto result=nvs_get_blob(h,key,nullptr,&size);
    if(result==ESP_ERR_NVS_NOT_FOUND) return PairingState::Corrupt;
    if(result!=ESP_OK) return PairingState::StorageError;
    if(!size||size>4096) return PairingState::Corrupt;
    data.resize(size); const size_t expected=size;
    if(nvs_get_blob(h,key,data.data(),&size)!=ESP_OK) return PairingState::StorageError;
    return size==expected?PairingState::Paired:PairingState::Corrupt;
}
PairingStatus ReadActive(nvs_handle_t h,std::string& data,uint8_t& slot) {
    const auto result=nvs_get_u8(h,"active",&slot);
    if(result==ESP_ERR_NVS_NOT_FOUND) return {PairingState::Empty,{}};
    if(result!=ESP_OK) return {PairingState::StorageError,{}};
    if(slot>1) return {PairingState::Corrupt,{}};
    auto state=ReadBlob(h,slot?"slot1":"slot0",data);
    if(state!=PairingState::Paired) return {state,{}};
    if(data=="{}") return {PairingState::Revoked,{}};
    PairingConfig parsed;
    if(!ParseAgentPairing(data,parsed)) return {PairingState::Corrupt,{}};
    return {PairingState::Paired,parsed.id};
}
}
PairingStatus AgentPairingStore::Read(std::string* private_record) {
    // Never leave an earlier caller-owned credential usable after a failed read.
    if(private_record) private_record->clear();
    if(!AgentConfigPartition()) return {PairingState::Unavailable,{}};
    if(nvs_flash_init_partition("sion_cfg")!=ESP_OK) return {PairingState::StorageError,{}};
    nvs_handle_t handle;
    const auto opened=nvs_open_from_partition("sion_cfg","pairing",NVS_READONLY,&handle);
    if(opened==ESP_ERR_NVS_NOT_FOUND) return {PairingState::Empty,{}};
    if(opened!=ESP_OK) return {PairingState::StorageError,{}};
    Handle guard{handle}; std::string data; uint8_t slot=0;
    auto status=ReadActive(handle,data,slot);
    if(status.state==PairingState::Paired&&private_record) *private_record=std::move(data);
    return status;
}
PairingWrite AgentPairingStore::Replace(const std::string& expected,const std::string& record) {
    PairingConfig parsed;
    if(!ParseAgentPairing(record,parsed)) return PairingWrite::Invalid;
    return Save(expected,record);
}
PairingWrite AgentPairingStore::Remove(const std::string& expected) {return Save(expected,"{}");}
PairingWrite AgentPairingStore::WriteRelay(const std::string& expected,const std::string* record) {
    if(!Hex(expected,32))return PairingWrite::Conflict;
    PrivateRelayConfig incoming;
    if(record&&(!ParseAgentRelayConfig(*record,expected,incoming.value)||incoming.value.revision.empty()||
                !ValidAgentRelayCA(incoming.value.ca)))return PairingWrite::Invalid;

    const auto current=Read();
    if(current.state==PairingState::Unavailable)return PairingWrite::Unavailable;
    if(current.state==PairingState::StorageError)return PairingWrite::StorageError;
    if(current.state==PairingState::Corrupt)return PairingWrite::Corrupt;
    if(current.state!=PairingState::Paired||current.id!=expected)return PairingWrite::Conflict;
    nvs_handle_t handle;
    if(nvs_open_from_partition("sion_cfg","pairing",NVS_READWRITE,&handle)!=ESP_OK)return PairingWrite::StorageError;
    Handle guard{handle};
    uint8_t slot=0; PrivateText pairing;
    const auto actual=ReadActive(handle,pairing.value,slot);
    if(actual.state!=PairingState::Paired||actual.id!=expected)return PairingWrite::Conflict;
    if(!record)return ClearRelay(handle);

    PrivateText previous;
    const auto read=ReadBlob(handle,RelayBlobKey,previous.value);
    if(read==PairingState::StorageError)return PairingWrite::StorageError;
    if(read==PairingState::Paired) {
        PrivateRelayConfig stored;
        if(ParseAgentRelayConfig(previous.value,expected,stored.value)&&stored.value.revision==incoming.value.revision)
            return previous.value==*record?PairingWrite::Unchanged:PairingWrite::Invalid;
    }
    const auto saved=nvs_set_blob(handle,RelayBlobKey,record->data(),record->size());
    if(saved==ESP_ERR_NVS_NOT_ENOUGH_SPACE)return PairingWrite::NoSpace;
    if(saved!=ESP_OK||nvs_commit(handle)!=ESP_OK)return PairingWrite::Uncertain;
    PrivateText verified;
    return ReadBlob(handle,RelayBlobKey,verified.value)==PairingState::Paired&&verified.value==*record?
        PairingWrite::Saved:PairingWrite::Uncertain;
}
PairingWrite AgentPairingStore::Save(const std::string& expected,const std::string& record) {
    std::string old;
    const auto status=Read(&old);
    switch(status.state) {
    case PairingState::Unavailable:return PairingWrite::Unavailable;
    case PairingState::Corrupt:return PairingWrite::Corrupt;
    case PairingState::StorageError:return PairingWrite::StorageError;
    default:break;
    }
    if(status.id!=expected) return PairingWrite::Conflict;
    if(record=="{}"&&status.state!=PairingState::Paired) return PairingWrite::Unchanged;
    if(record==old) return PairingWrite::Unchanged;
    PairingConfig incoming;
    if(record!="{}"&&(!ParseAgentPairing(record,incoming)||incoming.id==status.id)) return PairingWrite::Invalid;
    nvs_handle_t handle;
    if(nvs_open_from_partition("sion_cfg","pairing",NVS_READWRITE,&handle)!=ESP_OK) return PairingWrite::StorageError;
    Handle guard{handle}; uint8_t slot=0; std::string current;
    const auto again=ReadActive(handle,current,slot);
    if(again.state!=status.state||again.id!=status.id||
       (status.state==PairingState::Paired&&current!=old)) return PairingWrite::Conflict;
    const uint8_t next=1-slot;
    const char* key=next?"slot1":"slot0";
    // Only reclaim inactive data. Active credentials/tombstone remain intact.
    const auto erased=nvs_erase_key(handle,key);
    if(erased!=ESP_OK&&erased!=ESP_ERR_NVS_NOT_FOUND) return PairingWrite::Uncertain;
    if(nvs_commit(handle)!=ESP_OK) return PairingWrite::Uncertain;
    nvs_stats_t stats{};
    if(nvs_get_stats("sion_cfg",&stats)!=ESP_OK) return PairingWrite::Uncertain;
    if(stats.free_entries<(record.size()+31)/32+12) return PairingWrite::NoSpace;
    if(nvs_set_blob(handle,key,record.data(),record.size())!=ESP_OK||nvs_commit(handle)!=ESP_OK) return PairingWrite::Uncertain;
    std::string verified;
    if(ReadBlob(handle,key,verified)!=PairingState::Paired||verified!=record) return PairingWrite::Uncertain;
    // Clear the older relay grant before publishing a different paired identity.
    // A failed pair rotation may require relay enrollment again, but can never
    // reactivate a stored grant by reinstalling a former identity.
    if(ClearRelay(handle)==PairingWrite::Uncertain)return PairingWrite::Uncertain;
    if(nvs_set_u8(handle,"active",next)!=ESP_OK||nvs_commit(handle)!=ESP_OK) return PairingWrite::Uncertain;
    uint8_t actual=0; std::string final_record;
    const auto final=ReadActive(handle,final_record,actual);
    if(actual!=next||final_record!=record||
       final.state!=(record=="{}"?PairingState::Revoked:PairingState::Paired)) return PairingWrite::Uncertain;
    return PairingWrite::Saved;
}
const char* PairingStateText(PairingState state) {
    switch(state) {
    case PairingState::Empty:return "No DSH pairing";
    case PairingState::Paired:return "DSH identity saved";
    case PairingState::Revoked:return "DSH pairing removed";
    case PairingState::Unavailable:return "Storage not installed";
    case PairingState::Corrupt:return "Pairing damaged - not replaced";
    case PairingState::StorageError:return "Pairing storage error";
    }
    return "Pairing unavailable";
}
}
