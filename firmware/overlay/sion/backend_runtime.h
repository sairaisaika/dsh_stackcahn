// SPDX-License-Identifier: MIT
#pragma once
#include <esp_https_server.h>
#include <network_interface.h>
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include "mode_controller.h"
#include "pairing_config.h"

namespace sion {
class BackendRuntime : private Effects {
public:
    static BackendRuntime& Get();
    void Start();
    bool ReservePairing();
    bool PairingRestartRequired() const { return pairing_reserved_.load(); }
    NetworkInterface* LocalNetwork() const { return network_.get(); }
    void Tick();
    void PhysicalReturn();
    void Disconnected(uint64_t epoch);
    bool Busy() const;
    bool Local() const;
    bool Enabled() const { return enabled_; }
    const std::string& LocalUrl() const { return local_url_; }
    const std::string& LocalToken() const { return local_token_; }
    std::string Status();

private:
    BackendRuntime() : controller_(*this) {}
    struct Command {
        std::string action;
        uint64_t epoch;
        std::string id;
    };
    ModeController controller_;
    bool enabled_ = false;
    std::atomic<bool> pairing_reserved_{false};
    PairingConfig config_;
    std::unique_ptr<NetworkInterface> network_;
    httpd_handle_t server_ = nullptr;
    struct Receipt {
        Command command;
        std::string result;
    };
    std::deque<Receipt> receipts_;
    std::string last_result_ = "none", last_action_, last_epoch_;
    std::string control_key_, local_url_, local_token_, boot_id_;
    std::mutex mutex_;
    std::deque<Command> commands_;
    std::string status_ = "{\"enabled\":false}";
    void Publish(const char* result = "none");
    bool Authenticate(httpd_req_t* req);
    static esp_err_t Handle(httpd_req_t* req);
    void Quiesce(uint64_t epoch) override;
    bool IsQuiescent() override;
    void Connect(Backend backend, uint64_t epoch) override;
    Result ConnectionResult(uint64_t epoch) override;
    bool Activate(Backend backend, uint64_t epoch) override;
};
}  // namespace sion
