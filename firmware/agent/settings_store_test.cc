// SPDX-License-Identifier: MIT
#include "settings_store.cc"
#include "storage_guard.cc"
#include <cassert>
#include <cstring>
#include <iostream>
using namespace sion::agent;
static esp_partition_t partition{0xe10000,0x4000};
static bool exists=true,has_record=false,corrupt_readback=false;
static int fail=0,opens=0,closes=0,sets=0,commits=0;
static PreferenceRecord record{};
extern "C" const esp_partition_t* esp_partition_find_first(int,int,const char* name){assert(!std::strcmp(name,"sion_cfg"));return exists?&partition:nullptr;}
extern "C" esp_err_t __real_esp_partition_write(const esp_partition_t*,size_t,const void*,size_t){return 0;}
extern "C" esp_err_t __real_esp_partition_write_raw(const esp_partition_t* p,size_t o,const void* d,size_t s){return __real_esp_partition_write(p,o,d,s);}
extern "C" esp_err_t __real_esp_partition_erase_range(const esp_partition_t*,size_t,size_t){return 0;}
extern "C" esp_err_t __real_nvs_open(const char*,nvs_open_mode_t,nvs_handle_t*){assert(false);return -1;}
extern "C" esp_err_t __real_nvs_open_from_partition(const char* p,const char* name,nvs_open_mode_t,nvs_handle_t* h){
    assert(!std::strcmp(p,"sion_cfg")&&!std::strcmp(name,"settings"));if(fail==2)return -1;++opens;*h=1;return 0;
}
extern "C" int nvs_open_from_partition(const char* p,const char* name,nvs_open_mode_t mode,nvs_handle_t* h){return __wrap_nvs_open_from_partition(p,name,mode,h);}
extern "C" int nvs_flash_init_partition(const char* p){assert(!std::strcmp(p,"sion_cfg"));return fail==1?-1:0;}
extern "C" int nvs_get_blob(nvs_handle_t,const char* key,void* out,size_t* size){
    assert(!std::strcmp(key,"preferences")&&*size==12);if(fail==5)return -1;if(!has_record)return ESP_ERR_NVS_NOT_FOUND;
    std::memcpy(out,record.data(),record.size());if(corrupt_readback)static_cast<uint8_t*>(out)[4]^=1;return 0;
}
extern "C" int nvs_set_blob(nvs_handle_t,const char* key,const void* in,size_t size){
    assert(!std::strcmp(key,"preferences")&&size==12);++sets;if(fail==3)return -1;std::memcpy(record.data(),in,12);has_record=true;return 0;
}
extern "C" int nvs_commit(nvs_handle_t){++commits;return fail==4?-1:0;}
extern "C" void nvs_close(nvs_handle_t){++closes;}
int main(){
    Preferences p{55,false,true,9,true,true,true},out;NvsPreferenceStore store;
    exists=false;assert(store.Load(out)==PreferenceLoad::Unavailable && !store.Save(p) && opens==0);
    exists=true;assert(store.Load(out)==PreferenceLoad::Missing && sets==0);
    assert(store.Save(p));NvsPreferenceStore reboot;assert(reboot.Load(out)==PreferenceLoad::Loaded && out.volume==55 && out.microphone_disabled && out.revision==9&&out.camera_allowed&&out.motion_allowed&&out.ring_allowed);
    record[0]=1;record[2]&=3;
    auto crc=PreferenceCrc(record.data(),8);for(int i=0;i<4;++i)record[8+i]=static_cast<uint8_t>(crc>>(8*i));
    auto before_sets=sets;assert(reboot.Load(out)==PreferenceLoad::Loaded&&!out.camera_allowed&&!out.motion_allowed&&!out.ring_allowed&&sets==before_sets);
    assert(store.Save(p)&&record[0]==7); // Explicit save migrates only the DSH record, to the current version.
    for(int error:{2,3,4,5}){fail=error;assert(!store.Save(p));}
    fail=0;corrupt_readback=true;assert(!store.Save(p));assert(reboot.Load(out)==PreferenceLoad::Error && !reboot.Save(p));
    corrupt_readback=false;fail=1;assert(reboot.Load(out)==PreferenceLoad::Error && !reboot.Save(p));
    fail=0;record[0]=9;assert(reboot.Load(out)==PreferenceLoad::Error);
    assert(opens==closes);
    std::cout<<"Actual NVS adapter: dedicated partition only, missing/commit/readback/error/reload cases passed\n";
}
