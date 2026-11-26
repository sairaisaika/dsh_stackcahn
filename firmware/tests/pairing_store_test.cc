#include "sion/pairing_store.h"
#include <nvs.h>
#include <cassert>
#include <iostream>
using namespace sion;
static std::string Record(char id) {
    cJSON* json = cJSON_CreateObject();
    cJSON_AddNumberToObject(json, "version", 1);
    cJSON_AddStringToObject(json, "role", "sion-device");
    cJSON_AddStringToObject(json, "pair_id", std::string(32, id).c_str());
    cJSON_AddStringToObject(json, "control_key", std::string(64, 'a').c_str());
    cJSON_AddStringToObject(json, "local_token", std::string(64, 'b').c_str());
    cJSON_AddStringToObject(json, "local_url", "wss://192.168.1.2:8766/audio");
    cJSON_AddStringToObject(json, "ca", "-----BEGIN CERTIFICATE-----\ntest");
    cJSON_AddStringToObject(json, "cert", "-----BEGIN CERTIFICATE-----\ntest");
    cJSON_AddStringToObject(json, "key", "-----BEGIN PRIVATE KEY-----\ntest");
    char* raw = cJSON_PrintUnformatted(json);
    std::string text = raw;
    cJSON_free(raw);
    cJSON_Delete(json);
    return text;
}
int main() {
    auto a = Record('c'), b = Record('d');
    PairingStore store;
    PairingConfig config;
    fake_nvs::reset();
    fake_nvs::data["factory_sentinel"] = "untouched";
    assert(store.Replace("", a));
    assert(store.Load(config));
    assert(config.id == std::string(32, 'c'));
    auto saved = fake_nvs::data;
    assert(!store.Replace("", b));
    assert(fake_nvs::data == saved);
    for (int point = 1; point <= 4; ++point) {
        fake_nvs::data = saved;
        fake_nvs::writes = 0;
        fake_nvs::fail_at = point;
        assert(!store.Replace(std::string(32, 'c'), b));
        assert(store.Load(config));
        assert(config.id == std::string(32, 'c') || config.id == std::string(32, 'd'));
        assert(fake_nvs::data["factory_sentinel"] == "untouched");
    }
    fake_nvs::data = saved;
    fake_nvs::fail_at = 0;
    fake_nvs::free_entries = 0;
    assert(!store.Replace(std::string(32, 'c'), b));
    assert(fake_nvs::data == saved);
    fake_nvs::free_entries = 400;
    assert(store.Replace(std::string(32, 'c'), b));
    assert(store.Load(config));
    assert(config.id == std::string(32, 'd'));
    assert(store.Remove(config.id));
    assert(!store.Load(config));
    assert(fake_nvs::data["factory_sentinel"] == "untouched");
    assert(store.Replace("", a));
    assert(!ParsePairing(a + "garbage", config));
    assert(!ParsePairing("{}", config));
    auto insecure = a;
    insecure.replace(insecure.find("wss://"), 6, "ws://");
    assert(!ParsePairing(insecure, config));
    std::cout << "Pairing store: install/CAS/rotation/revocation/capacity, four interrupted-write "
                 "points, strict parsing passed\n";
}
