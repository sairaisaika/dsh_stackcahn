#pragma once
#include <cassert>
#include <cstring>
#include <map>
#include <string>
#include <cstdint>
using esp_err_t=int;
using nvs_handle_t=int;
constexpr int ESP_OK=0,ESP_FAIL=-1,ESP_ERR_NVS_NOT_FOUND=1,NVS_READONLY=0,NVS_READWRITE=1;
namespace fake_nvs {
inline std::map<std::string,std::string> data;
inline int writes=0,fail_at=0;
inline size_t free_entries=400;
inline bool fail(){return ++writes==fail_at;}
inline void reset(){data.clear();writes=0;fail_at=0;free_entries=400;}
}
inline int nvs_open(const char* name,int,nvs_handle_t* h){assert(std::string(name)=="sion_pair");*h=1;return ESP_OK;}
inline void nvs_close(nvs_handle_t){}
inline int nvs_get_blob(nvs_handle_t,const char* key,void* out,size_t* n){auto i=fake_nvs::data.find(key);if(i==fake_nvs::data.end())return ESP_ERR_NVS_NOT_FOUND;if(out){if(*n<i->second.size())return ESP_FAIL;memcpy(out,i->second.data(),i->second.size());}*n=i->second.size();return ESP_OK;}
inline int nvs_set_blob(nvs_handle_t,const char* key,const void* in,size_t n){if(fake_nvs::fail())return ESP_FAIL;fake_nvs::data[key]=std::string(static_cast<const char*>(in),n);return ESP_OK;}
inline int nvs_get_u8(nvs_handle_t,const char* key,uint8_t* v){auto i=fake_nvs::data.find(key);if(i==fake_nvs::data.end())return ESP_ERR_NVS_NOT_FOUND;*v=static_cast<uint8_t>(i->second[0]);return ESP_OK;}
inline int nvs_set_u8(nvs_handle_t,const char* key,uint8_t v){if(fake_nvs::fail())return ESP_FAIL;fake_nvs::data[key]=std::string(1,static_cast<char>(v));return ESP_OK;}
inline int nvs_commit(nvs_handle_t){return fake_nvs::fail()?ESP_FAIL:ESP_OK;}
inline int nvs_erase_key(nvs_handle_t,const char* key){if(fake_nvs::fail())return ESP_FAIL;fake_nvs::data.erase(key);return ESP_OK;}
