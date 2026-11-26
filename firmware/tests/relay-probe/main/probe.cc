// SPDX-License-Identifier: MIT
// QEMU UART carries the synthetic WebSocket event boundary, never device credentials.
#include "agent_psk_tls.h"
#include "agent_relay_stream.h"
#include "agent_usb_frames.h"
#include <bootloader_random.h>
#include <driver/uart.h>
#include <cstdio>

using namespace sion::agent;
namespace {
constexpr auto Port = UART_NUM_1;
AgentRelayStream relay;
const std::string_view hello = R"({"type":"hello","protocol":1,"device_id":"123456abcdef","pair_id":"0123456789abcdef0123456789abcdef","boot_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","epoch":"0","phase":"idle","playback_fence":1})";

void ReadExact(uint8_t* bytes, size_t size) {
    while (size) {
        const int count = uart_read_bytes(Port, bytes, size, portMAX_DELAY);
        assert(count > 0);
        bytes += count;
        size -= count;
    }
}

bool ReceiveFrame() {
    uint8_t header[3], bytes[512];
    ReadExact(header, sizeof(header));
    const int length = (int(header[1]) << 8) | header[2];
    assert(length > 0 && length <= int(AgentRelayStream::MaxFrame));
    for (int offset = 0; offset < length;) {
        const int size = std::min(length - offset, int(sizeof(bytes)));
        ReadExact(bytes, size);
        if (!relay.Feed(header[0], true, length, offset, bytes, size)) return false;
        offset += size;
    }
    return true;
}

int Send(void*, const unsigned char* data, size_t size) { return uart_write_bytes(Port, data, size); }
int Receive(void* arg, unsigned char* data, size_t size) {
    if (arg) {
        while (true) {
            const int count = relay.Read(data, size);
            if (count) return count > 0 ? count : MBEDTLS_ERR_SSL_INTERNAL_ERROR;
            if (!ReceiveFrame()) return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
        }
    }
    const int count = uart_read_bytes(Port, data, size, 1);
    return count > 0 ? count : MBEDTLS_ERR_SSL_WANT_READ;
}
}

extern "C" void app_main() {
    uart_config_t config{};
    config.baud_rate = 115200;
    config.data_bits = UART_DATA_8_BITS;
    config.parity = UART_PARITY_DISABLE;
    config.stop_bits = UART_STOP_BITS_1;
    config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    config.source_clk = UART_SCLK_DEFAULT;
    ESP_ERROR_CHECK(uart_param_config(Port, &config));
    ESP_ERROR_CHECK(uart_driver_install(Port, 8192, 0, 0, nullptr, 0));
    puts("PROBE_UART_READY");
    uint8_t mode;
    ReadExact(&mode, 1);
    assert(mode == 'R' || mode == 'U');
    if (mode == 'R') {
        while (!relay.CanHandshake()) assert(ReceiveFrame());
    } else {
        UsbPreambleReader preamble;
        uint8_t byte;
        do { ReadExact(&byte, 1); } while (!preamble.Feed(static_cast<char>(byte)));
    }

    AgentPskTls tls;
    const auto domain = mode == 'R' ? PskDomain::Relay : PskDomain::Usb;
    assert(tls.Configure(domain, "123456abcdef", "0123456789abcdef0123456789abcdef",
                         "01" + std::string(62, '0'), mode == 'R' ? &relay : nullptr, Send, Receive));
    bootloader_random_enable();
    int result;
    do {
        result = tls.Handshake();
        vTaskDelay(1);
    } while (result == MBEDTLS_ERR_SSL_WANT_READ || result == MBEDTLS_ERR_SSL_WANT_WRITE);
    bootloader_random_disable();
    printf("PROBE_HANDSHAKE %c %d\n", mode, result);
    assert(result == 0);
    std::vector<uint8_t> packet{1, uint8_t(hello.size() >> 8), uint8_t(hello.size())};
    packet.insert(packet.end(), hello.begin(), hello.end());
    assert(tls.Write(packet.data(), packet.size()) == int(packet.size()));

    UsbFrameReader parser;
    uint8_t plaintext[64];
    bool received = false;
    while (!received) {
        const int count = tls.Read(plaintext, sizeof(plaintext));
        if (count == MBEDTLS_ERR_SSL_WANT_READ) continue;
        assert(count > 0);
        assert(parser.Feed(plaintext, count, 0, [&](uint8_t kind, const uint8_t* data, size_t size) {
            received = kind == UsbKeepalive && size == 1 && data[0] == 0;
            return received;
        }));
    }
    printf("PROBE_AUTHENTICATED %c\n", mode);
    for (;;) vTaskDelay(10);
}
