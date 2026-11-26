// SPDX-License-Identifier: MIT
#include "agent_relay_config.h"
#include "storage_guard.h"
#include "sion/pairing_config.h"
#include <mbedtls/platform_util.h>
#include <mbedtls/x509_crt.h>
#include <nvs.h>
#include <algorithm>
#include <string_view>

namespace sion::agent {
namespace {
// The private descriptor is a single flat object. Reject encoded NULs before
// cJSON, whose string API exposes only NUL-terminated values.
bool FlatJson(std::string_view text) {
    if (text.empty() || text.size() > MaxRelayRecord || text.find('\0') != text.npos) return false;
    bool quoted = false, object = false;
    for (size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        if (quoted && c == '\\') {
            if (++i == text.size() || text.substr(i, 5) == "u0000") return false;
            continue;
        }
        if (c == '"') quoted = !quoted;
        if (quoted) continue;
        if (c == '[' || c == ']') return false;
        if (c == '{') { if (object) return false; object = true; }
        if (c == '}') { if (!object) return false; object = false; }
    }
    return !quoted && !object;
}

bool RelayOrigin(std::string_view origin) {
    const std::string_view prefix = "wss://";
    if (origin.substr(0, prefix.size()) != prefix || origin.size() > 180) return false;
    origin.remove_prefix(prefix.size());
    if (!origin.empty() && origin.back() == '/') origin.remove_suffix(1);
    const size_t colon = origin.find(':');
    if (colon != origin.npos) {
        const auto port = origin.substr(colon + 1);
        unsigned value = 0;
        const auto result = std::from_chars(port.data(), port.data() + port.size(), value);
        if (result.ec != std::errc{} || result.ptr != port.data() + port.size() || !value || value > 65535) return false;
        origin = origin.substr(0, colon);
    }
    if (origin.empty() || origin.back() == '.') return false;
    while (!origin.empty()) {
        const size_t dot = origin.find('.');
        const auto label = origin.substr(0, dot);
        if (label.empty() || label.size() > 63 || label.front() == '-' || label.back() == '-' ||
            label.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") != label.npos) return false;
        if (dot == origin.npos) break;
        origin.remove_prefix(dot + 1);
    }
    return true;
}
}

bool ParseAgentRelayConfig(const std::string& text, const std::string& pair_id, AgentRelayConfig& config) {
    config = {};
    if (!FlatJson(text) || !Hex(pair_id, 32)) return false;
    auto* json = cJSON_ParseWithLengthOpts(text.c_str(), text.size() + 1, nullptr, true);
    if (!json) return false;
    AgentRelayConfig candidate;
    std::string bound_pair;
    const auto read = [&](const char* name, std::string& value) {
        const auto* item = cJSON_GetObjectItemCaseSensitive(json, name);
        if (!cJSON_IsString(item)) return false;
        value = item->valuestring;
        return true;
    };
    const auto* version = cJSON_GetObjectItemCaseSensitive(json, "version");
    const auto count = cJSON_GetArraySize(json);
    const auto* revision = cJSON_GetObjectItemCaseSensitive(json, "revision");
    const bool has_revision = revision != nullptr;
    const bool valid = cJSON_IsObject(json) && count == (has_revision ? 9 : 8) &&
        (!has_revision || (read("revision", candidate.revision) && Hex(candidate.revision, 32))) && cJSON_IsNumber(version) &&
        version->valuedouble == 1 && read("pair_id", bound_pair) && bound_pair == pair_id &&
        read("origin", candidate.origin) && RelayOrigin(candidate.origin) && read("room_id", candidate.room) &&
        Hex(candidate.room, 32) && read("token", candidate.token) && Hex(candidate.token, 64) &&
        read("ca", candidate.ca) && candidate.ca.size() <= 3072 &&
        candidate.ca.rfind("-----BEGIN CERTIFICATE-----\n", 0) == 0 &&
        read("ssid", candidate.ssid) && candidate.ssid.size() <= 32 &&
        read("password", candidate.password) &&
        (candidate.password.empty() || (!candidate.ssid.empty() && candidate.password.size() >= 8 &&
         candidate.password.size() <= 63 &&
         std::all_of(candidate.password.begin(), candidate.password.end(), [](unsigned char c) { return c >= 32 && c <= 126; })));
    cJSON_Delete(json);
    if (!valid) return false;
    if (candidate.origin.back() == '/') candidate.origin.pop_back();
    config = std::move(candidate);
    return true;
}

namespace {
RelayState ReadRelay(const std::string& pair_id, AgentRelayConfig& config) {
    if (!Hex(pair_id, 32) || !AgentConfigPartition()) return RelayState::Unavailable;
    nvs_handle_t handle;
    // The transport lease has already performed the guarded pairing-store read
    // and initialized sion_cfg. This consumer never opens NVS for writing.
    if (nvs_open_from_partition("sion_cfg", "pairing", NVS_READONLY, &handle) != ESP_OK) return RelayState::StorageError;
    size_t size = 0;
    std::string text;
    const auto measured = nvs_get_blob(handle, RelayBlobKey, nullptr, &size);
    auto state = measured == ESP_ERR_NVS_NOT_FOUND ? RelayState::Empty : RelayState::StorageError;
    if (measured == ESP_OK && size && size <= MaxRelayRecord) {
        text.resize(size);
        if (nvs_get_blob(handle, RelayBlobKey, text.data(), &size) == ESP_OK && size == text.size())
            state = ParseAgentRelayConfig(text, pair_id, config) ? RelayState::Ready : RelayState::Invalid;
    } else if (measured == ESP_OK) state = RelayState::Invalid;
    nvs_close(handle);
    mbedtls_platform_zeroize(text.data(), text.size());
    return state;
}
}

bool ReadAgentRelayConfig(const std::string& pair_id, AgentRelayConfig& config) {
    config = {};
    return ReadRelay(pair_id, config) == RelayState::Ready;
}

RelayStatus ReadAgentRelayStatus(const std::string& pair_id) {
    AgentRelayConfig config;
    const auto state = ReadRelay(pair_id, config);
    mbedtls_platform_zeroize(config.token.data(), config.token.size());
    mbedtls_platform_zeroize(config.password.data(), config.password.size());
    return {state, std::move(config.revision)};
}

bool ValidAgentRelayCA(const std::string& pem) {
    mbedtls_x509_crt certs;
    mbedtls_x509_crt_init(&certs);
    const int result = mbedtls_x509_crt_parse(&certs, reinterpret_cast<const unsigned char*>(pem.c_str()), pem.size() + 1);
    mbedtls_x509_crt_free(&certs);
    return result == 0;
}
}
