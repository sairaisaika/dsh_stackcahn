// SPDX-License-Identifier: MIT
#pragma once
#include <esp_network.h>
#include <web_socket.h>
#include "paired_tls.h"
class PairedNetwork : public EspNetwork {
public:
    explicit PairedNetwork(std::string ca) : ca_(std::move(ca)) {}
    std::unique_ptr<Tcp> CreateSsl(int = -1) override { return std::make_unique<PairedTls>(ca_); }
    // Plain TCP is never an allowed paired audio transport.
    std::unique_ptr<Tcp> CreateTcp(int = -1) override { return nullptr; }

private:
    std::string ca_;
};
