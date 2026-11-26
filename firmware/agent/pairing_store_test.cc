// SPDX-License-Identifier: MIT
// Actual store and parser with an eager-persistence NVS failure model. Real
// hardware power loss, wear levelling and cryptographic PEM validity are separate.
#include "pairing_store.cc"
#include <cassert>
#include <cstring>
#include <map>
#include <iostream>
#include <fstream>
#include <iterator>
using namespace sion::agent;
static std::map<std::string,std::string> data;
static std::map<int,nvs_open_mode_t> handles;
static esp_partition_t partition{0xe10000,0x4000};
static bool present=true, exists=false, fail_after_write=false;
static int calls=0, fail_at=0, next_handle=0, mutations=0;
static size_t free_entries=400;
static bool fault(){return ++calls==fail_at;}
namespace sion::agent {const esp_partition_t* AgentConfigPartition(){return present?&partition:nullptr;}}
extern "C" int nvs_flash_init_partition(const char* p){assert(!std::strcmp(p,"sion_cfg"));return fault()?99:ESP_OK;}
extern "C" int nvs_open_from_partition(const char* p,const char* ns,nvs_open_mode_t mode,int* out){
 assert(!std::strcmp(p,"sion_cfg")&&!std::strcmp(ns,"pairing"));
 if(fault())return 99;
 if(!exists&&mode==NVS_READONLY)return ESP_ERR_NVS_NOT_FOUND;
 exists=true;*out=++next_handle;handles[*out]=mode;return ESP_OK;
}
extern "C" void nvs_close(int h){assert(handles.erase(h)==1);}
extern "C" int nvs_get_blob(int h,const char* key,void* out,size_t* size){
 assert(handles.count(h));if(fault())return 99;
 auto it=data.find(key);if(it==data.end())return ESP_ERR_NVS_NOT_FOUND;
 if(out){if(*size<it->second.size())return 98;std::memcpy(out,it->second.data(),it->second.size());}
 *size=it->second.size();return ESP_OK;
}
extern "C" int nvs_get_u8(int h,const char* key,uint8_t* value){
 assert(handles.count(h));if(fault())return 99;
 auto it=data.find(key);if(it==data.end())return ESP_ERR_NVS_NOT_FOUND;
 if(it->second.size()!=1)return 98;*value=static_cast<uint8_t>(it->second[0]);return ESP_OK;
}
static int put(int h,const char* key,std::string value){
 assert(handles.at(h)==NVS_READWRITE);const bool failed=fault();
 if(!failed||fail_after_write){data[key]=std::move(value);++mutations;}
 return failed?99:ESP_OK;
}
extern "C" int nvs_set_blob(int h,const char* key,const void* value,size_t size){
 if(std::string_view(key)==RelayBlobKey&&!free_entries)return ESP_ERR_NVS_NOT_ENOUGH_SPACE;
 return put(h,key,std::string(static_cast<const char*>(value),size));
}
extern "C" int nvs_set_u8(int h,const char* key,uint8_t value){return put(h,key,std::string(1,static_cast<char>(value)));}
extern "C" int nvs_erase_key(int h,const char* key){
 assert(handles.at(h)==NVS_READWRITE);const bool failed=fault();
 if(failed&&!fail_after_write)return 99;
 const auto count=data.erase(key);++mutations;
 return failed?99:count?ESP_OK:ESP_ERR_NVS_NOT_FOUND;
}
extern "C" int nvs_commit(int h){assert(handles.at(h)==NVS_READWRITE);return fault()?99:ESP_OK;}
extern "C" int nvs_get_stats(const char* p,nvs_stats_t* stats){assert(!std::strcmp(p,"sion_cfg"));if(fault())return 99;stats->free_entries=free_entries;return ESP_OK;}
static std::string Record(char id){
 auto* j=cJSON_CreateObject();cJSON_AddNumberToObject(j,"version",1);
 cJSON_AddStringToObject(j,"role","sion-device");
 cJSON_AddStringToObject(j,"pair_id",std::string(32,id).c_str());
 cJSON_AddStringToObject(j,"control_key",std::string(64,'a').c_str());
 cJSON_AddStringToObject(j,"local_token",std::string(64,'b').c_str());
 cJSON_AddStringToObject(j,"local_url","wss://192.168.1.2:8766/audio");
 cJSON_AddStringToObject(j,"ca","-----BEGIN CERTIFICATE-----\ntest");
 cJSON_AddStringToObject(j,"cert","-----BEGIN CERTIFICATE-----\ntest");
 cJSON_AddStringToObject(j,"key","-----BEGIN PRIVATE KEY-----\ntest");
 char* text=cJSON_PrintUnformatted(j);std::string result=text;cJSON_free(text);cJSON_Delete(j);return result;
}
static std::string RelayRecord(const std::string& pair,char revision,char token){
 return "{\"version\":1,\"pair_id\":\""+pair+"\",\"revision\":\""+std::string(32,revision)+
  "\",\"origin\":\"wss://relay.example.test\",\"room_id\":\""+std::string(32,'a')+
  "\",\"token\":\""+std::string(64,token)+"\",\"ca\":\"-----BEGIN CERTIFICATE-----\\nfixture-cert-body\","
  "\"ssid\":\"hotspot\",\"password\":\"fixture-password\"}";
}
static void reset(){assert(handles.empty());data.clear();present=true;exists=false;calls=fail_at=mutations=0;free_entries=400;fail_after_write=false;}
int main(int argc,char** argv){
 if(argc==2){
  std::ifstream input(argv[1]);assert(input.good());
  std::string record((std::istreambuf_iterator<char>(input)),std::istreambuf_iterator<char>());
  reset();AgentPairingStore real_bundle;sion::PairingConfig config;
  assert(sion::ParsePairing(record,config));assert(real_bundle.Replace("",record)==PairingWrite::Saved);
  std::string loaded;assert(AgentPairingStore().Read(&loaded).id==config.id&&loaded==record);
  assert(real_bundle.Remove(config.id)==PairingWrite::Saved);
  assert(real_bundle.Read(&loaded).state==PairingState::Revoked&&loaded.empty());
  std::cout<<"Mac-generated temporary X.509 bundle accepted/stored/reloaded/revoked by actual device parser; no handshake claimed\n";
  return 0;
 }
 AgentPairingStore store;const auto a=Record('c'),b=Record('d'),c=Record('e');const std::string aid(32,'c'),bid(32,'d');
 reset();std::string raw="old secret";present=false;
 assert(store.Read(&raw).state==PairingState::Unavailable&&raw.empty());
 assert(store.Replace("",a)==PairingWrite::Unavailable&&mutations==0);
 present=true;assert(store.Read().state==PairingState::Empty);
 assert(store.Replace("",a)==PairingWrite::Saved);assert(store.Read(&raw).id==aid&&raw==a);
 const int written=mutations;
 assert(store.Replace(aid,a)==PairingWrite::Unchanged&&mutations==written);
 assert(store.Replace("",b)==PairingWrite::Conflict&&mutations==written);
 auto changed=a;changed.replace(changed.find("8766"),4,"8767");
 assert(store.Replace(aid,changed)==PairingWrite::Invalid&&mutations==written);
 assert(store.Replace(aid,b)==PairingWrite::Saved);
 assert(store.Replace(bid,c)==PairingWrite::Saved); // Reuses non-active slot.
 assert(AgentPairingStore().Read().id==std::string(32,'e'));
 assert(store.Remove(std::string(32,'e'))==PairingWrite::Saved);
 assert(store.Read(&raw).state==PairingState::Revoked&&raw.empty());
 assert(store.Remove("")==PairingWrite::Unchanged);
 assert(store.Replace("",a)==PairingWrite::Saved);
 const auto saved=data;
 // Every NVS-call failure before or after a persistent mutation leaves a
 // readable old/new identity; the caller must not assume failed means unchanged.
 calls=0;assert(store.Replace(aid,b)==PairingWrite::Saved);const int rotation_calls=calls;
 int injections=0;
 for(bool after:{false,true})for(int point=1;point<=rotation_calls;++point){
  data=saved;exists=true;calls=0;fail_at=point;fail_after_write=after;
  const auto result=store.Replace(aid,b);assert(result!=PairingWrite::Saved);
  fail_at=0;assert(handles.empty());auto state=AgentPairingStore().Read(&raw);
  assert(state.state==PairingState::Paired&&(raw==a||raw==b));++injections;
 }
 // Revocation failure never falls back to an inactive old identity.
 data=saved;calls=0;assert(store.Remove(aid)==PairingWrite::Saved);const int revoke_calls=calls;
 for(bool after:{false,true})for(int point=1;point<=revoke_calls;++point){
  data=saved;calls=0;fail_at=point;fail_after_write=after;
  assert(store.Remove(aid)!=PairingWrite::Saved);fail_at=0;
  auto state=store.Read(&raw);assert(state.state==PairingState::Paired||state.state==PairingState::Revoked);
  if(state.state==PairingState::Revoked)assert(raw.empty());else assert(raw==a);
  ++injections;
 }
 // First-install interruptions may leave an orphan inactive slot, but must
 // never publish a partial identity. Re-reading tells the owner whether to retry.
 reset();calls=0;assert(store.Replace("",a)==PairingWrite::Saved);const int install_calls=calls;
 for(bool after:{false,true})for(int point=1;point<=install_calls;++point){
  reset();fail_at=point;fail_after_write=after;
  assert(store.Replace("",a)!=PairingWrite::Saved);fail_at=0;
  auto state=AgentPairingStore().Read(&raw);
  assert(state.state==PairingState::Empty||state.state==PairingState::Paired);
  if(state.state==PairingState::Empty){assert(raw.empty());assert(store.Replace("",a)==PairingWrite::Saved);}
  else assert(raw==a);
  ++injections;
 }
 data=saved;exists=true;fail_at=0;assert(store.Remove(aid)==PairingWrite::Saved);
 // Even with a valid former identity in the inactive slot, tombstone wins.
 const auto active=static_cast<unsigned char>(data.at("active")[0]);
 data[active?"slot0":"slot1"]=b;
 assert(store.Read(&raw).state==PairingState::Revoked&&raw.empty());
 data=saved;free_entries=0;assert(store.Replace(aid,b)==PairingWrite::NoSpace);assert(store.Read().id==aid);free_entries=400;
 // Corrupt active marker/blob is not 'empty' and cannot be overwritten.
 for(auto corruption:{0,1,2,3}){
  data=saved;const auto slot=static_cast<unsigned char>(data.at("active")[0]);const char* key=slot?"slot1":"slot0";
  if(corruption==0)data["active"]=std::string(1,3);
  if(corruption==1)data.erase(key);
  if(corruption==2)data[key]="invalid";
  if(corruption==3)data[key]=std::string(4097,'x');
  const auto before=data;const int count=mutations;
  assert(store.Read(&raw).state==PairingState::Corrupt&&raw.empty());
  assert(store.Replace("",b)==PairingWrite::Corrupt&&data==before&&mutations==count);
 }
 // Read errors must never authorize initial installation.
 data=saved;calls=0;assert(store.Read().state==PairingState::Paired);const int read_calls=calls;
 for(int point=1;point<=read_calls;++point){calls=0;fail_at=point;const int before=mutations;
  assert(store.Replace("",b)==PairingWrite::StorageError&&mutations==before);fail_at=0;
 }
 data=saved;
 const auto ra=RelayRecord(aid,'1','a'),rb=RelayRecord(aid,'2','b'),altered=RelayRecord(aid,'1','c');
 assert(ReadAgentRelayStatus(aid).state==RelayState::Empty);
 assert(store.WriteRelay(bid,&ra)==PairingWrite::Invalid&&store.WriteRelay(bid,nullptr)==PairingWrite::Conflict);
 auto bad_ca=ra;bad_ca.replace(bad_ca.find("fixture-cert-body"),17,"bad-cert");
 assert(store.WriteRelay(aid,&bad_ca)==PairingWrite::Invalid);
 assert(store.WriteRelay(aid,&ra)==PairingWrite::Saved);
 assert(ReadAgentRelayStatus(aid).revision==std::string(32,'1'));
 const auto paired_with_relay=data;
 assert(store.WriteRelay(aid,&ra)==PairingWrite::Unchanged&&store.WriteRelay(aid,&altered)==PairingWrite::Invalid);
 free_entries=0;assert(store.WriteRelay(aid,&rb)==PairingWrite::NoSpace);free_entries=400;
 assert(data==paired_with_relay);
 calls=0;assert(store.WriteRelay(aid,&rb)==PairingWrite::Saved);const int relay_rotation_calls=calls;
 assert(ReadAgentRelayStatus(aid).revision==std::string(32,'2')&&store.Read().id==aid);
 int relay_injections=0;
 for(bool after:{false,true})for(int point=1;point<=relay_rotation_calls;++point){
  data=paired_with_relay;calls=0;fail_at=point;fail_after_write=after;
  assert(store.WriteRelay(aid,&rb)!=PairingWrite::Saved);fail_at=0;
  assert(handles.empty()&&data.at("active")==paired_with_relay.at("active"));
  assert(data.at(RelayBlobKey)==ra||data.at(RelayBlobKey)==rb);++relay_injections;
 }
 data=paired_with_relay;calls=0;assert(store.WriteRelay(aid,nullptr)==PairingWrite::Saved);const int removal_calls=calls;
 for(bool after:{false,true})for(int point=1;point<=removal_calls;++point){
  data=paired_with_relay;calls=0;fail_at=point;fail_after_write=after;
  assert(store.WriteRelay(aid,nullptr)!=PairingWrite::Saved);fail_at=0;
  assert(data.at("active")==paired_with_relay.at("active"));
  assert(!data.count(RelayBlobKey)||data.at(RelayBlobKey)==ra);++relay_injections;
 }
 data=paired_with_relay;calls=0;assert(store.Replace(aid,b)==PairingWrite::Saved);
 const int paired_rotation_calls=calls;
 for(bool after:{false,true})for(int point=1;point<=paired_rotation_calls;++point){
  data=paired_with_relay;calls=0;fail_at=point;fail_after_write=after;
  assert(store.Replace(aid,b)!=PairingWrite::Saved);fail_at=0;
  const auto current=store.Read().id;
  assert(current==aid||current==bid);
  if(current==bid)assert(!data.count(RelayBlobKey));
  else if(data.count(RelayBlobKey))assert(data.at(RelayBlobKey)==ra);
  ++relay_injections;
 }
 data=paired_with_relay;assert(store.Replace(aid,b)==PairingWrite::Saved);
 assert(ReadAgentRelayStatus(bid).state==RelayState::Empty);
 assert(store.Replace(bid,a)==PairingWrite::Saved&&ReadAgentRelayStatus(aid).state==RelayState::Empty);
 data=paired_with_relay;assert(store.Remove(aid)==PairingWrite::Saved&&!data.count(RelayBlobKey));
 std::cout<<"Relay blob install/rotation/revocation and "<<relay_injections<<" failure injections passed\n";
 auto invalid=a;invalid.replace(invalid.find("wss://"),6,"ws://");
 assert(store.Replace("",invalid)==PairingWrite::Invalid);
 assert(store.Replace("",a+"garbage")==PairingWrite::Invalid);
 assert(store.Replace("",std::string(4097,'x'))==PairingWrite::Invalid);
 assert(handles.empty());
 for(auto state:{PairingState::Empty,PairingState::Paired,PairingState::Revoked,PairingState::Unavailable,PairingState::Corrupt,PairingState::StorageError})
  assert(std::string(PairingStateText(state)).find(aid)==std::string::npos);
 std::cout<<"Actual isolated pairing store: CAS/rotation/revocation/restart/corruption/capacity, "<<injections<<" NVS failure injections, no factory access passed\n";
}
