// SPDX-License-Identifier: MIT
#include "agent_psk_tls.h"
#include <mbedtls/platform_util.h>
#include <psa/crypto.h>
#include <cstring>
#include <string>

namespace sion::agent {
namespace {
constexpr int Cipher = MBEDTLS_TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256;

bool LowerHex(std::string_view value, size_t size) {
    return value.size() == size && value.find_first_not_of("0123456789abcdef") == value.npos;
}

unsigned HexDigit(char digit) { return digit <= '9' ? digit - '0' : digit - 'a' + 10; }
}

AgentPskTls::AgentPskTls() {
    mbedtls_ssl_init(&session_);
    mbedtls_ssl_config_init(&config_);
}

AgentPskTls::~AgentPskTls() {
    mbedtls_ssl_free(&session_);
    mbedtls_ssl_config_free(&config_);
}

bool AgentPskTls::Configure(PskDomain domain, std::string_view device, std::string_view pair,
                            std::string_view token, void* io, mbedtls_ssl_send_t* send,
                            mbedtls_ssl_recv_t* receive) {
    static const int suites[] = {Cipher, 0};
    static const char* usb[] = {"sion-usb-v1", nullptr};
    static const char* relay[] = {"sion-relay-v1", nullptr};
    if (alpn_ || !send || !receive || !LowerHex(device, 12) || !LowerHex(pair, 32) || !LowerHex(token, 64)) return false;
    const auto protocols = domain == PskDomain::Usb ? usb : relay;
    alpn_ = protocols[0];
    if (mbedtls_ssl_config_defaults(&config_, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM,
                                    MBEDTLS_SSL_PRESET_DEFAULT)) return false;
    mbedtls_ssl_conf_min_tls_version(&config_, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_max_tls_version(&config_, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_ciphersuites(&config_, suites);
    mbedtls_ssl_conf_session_tickets(&config_, MBEDTLS_SSL_SESSION_TICKETS_DISABLED);

    std::string identity = alpn_;
    identity.append(":").append(device).append(":").append(pair);
    const auto* identity_bytes = reinterpret_cast<const uint8_t*>(identity.data());
    uint8_t key[32], derived[32];
    for (size_t i = 0; i < sizeof(key); ++i) key[i] = uint8_t(HexDigit(token[i * 2]) * 16 + HexDigit(token[i * 2 + 1]));
    constexpr auto algorithm = PSA_ALG_HMAC(PSA_ALG_SHA_256);
    auto attributes = psa_key_attributes_init();
    psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
    psa_set_key_algorithm(&attributes, algorithm);
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
    mbedtls_svc_key_id_t handle = MBEDTLS_SVC_KEY_ID_INIT;
    const auto imported = psa_import_key(&attributes, key, sizeof(key), &handle);
    mbedtls_platform_zeroize(key, sizeof(key));
    if (imported != PSA_SUCCESS) return false;
    size_t length = 0;
    const auto mac = psa_mac_compute(handle, algorithm, identity_bytes, identity.size(), derived, sizeof(derived), &length);
    const auto destroyed = psa_destroy_key(handle);
    const bool ok = mac == PSA_SUCCESS && destroyed == PSA_SUCCESS && length == sizeof(derived) &&
        !mbedtls_ssl_conf_psk(&config_, derived, length, identity_bytes, identity.size());
    mbedtls_platform_zeroize(derived, sizeof(derived));
    if (!ok || mbedtls_ssl_conf_alpn_protocols(&config_, protocols) || mbedtls_ssl_setup(&session_, &config_)) return false;
    mbedtls_ssl_set_bio(&session_, io, send, receive, nullptr);
    return true;
}

int AgentPskTls::Handshake() {
    const int result = mbedtls_ssl_handshake(&session_);
    if (result) return result;
    const auto* protocol = mbedtls_ssl_get_alpn_protocol(&session_);
    if (!protocol || std::strcmp(protocol, alpn_) || mbedtls_ssl_get_ciphersuite_id_from_ssl(&session_) != Cipher)
        return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return 0;
}
}
