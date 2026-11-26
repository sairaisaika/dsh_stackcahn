// SPDX-License-Identifier: MIT
#pragma once
#include <mbedtls/ssl.h>
#include <string_view>

namespace sion::agent {
enum class PskDomain { Usb, Relay };

class AgentPskTls {
public:
    AgentPskTls();
    ~AgentPskTls();
    AgentPskTls(const AgentPskTls&) = delete;
    AgentPskTls& operator=(const AgentPskTls&) = delete;

    bool Configure(PskDomain domain, std::string_view device, std::string_view pair,
                   std::string_view token, void* io, mbedtls_ssl_send_t* send,
                   mbedtls_ssl_recv_t* receive);
    int Handshake();
    int Read(uint8_t* bytes, size_t size) { return mbedtls_ssl_read(&session_, bytes, size); }
    int Write(const uint8_t* bytes, size_t size) { return mbedtls_ssl_write(&session_, bytes, size); }
    void CloseNotify() { mbedtls_ssl_close_notify(&session_); }

private:
    mbedtls_ssl_context session_;
    mbedtls_ssl_config config_;
    const char* alpn_ = nullptr;
};
}
