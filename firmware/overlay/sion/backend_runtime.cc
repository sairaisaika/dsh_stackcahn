// SPDX-License-Identifier: MIT
#include "backend_runtime.h"
#include <esp_netif.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <cJSON.h>
#include <net/if.h>
#include <charconv>
#include <cstring>
#include "application.h"
#include "endpoint_policy.h"
#include "paired_network.h"
#include "pairing_store.h"
#include "pairing_usb.h"
#include "firmware_trial.h"

namespace sion {
static uint64_t Now() { return static_cast<uint64_t>(esp_timer_get_time() / 1000); }
static const char* Name(Phase p) {
    switch (p) {
        case Phase::Original:
            return "original";
        case Phase::Quiescing:
            return "quiescing";
        case Phase::Connecting:
            return "connecting";
        case Phase::Local:
            return "local";
        case Phase::Recovering:
            return "recovering";
        default:
            return "fault";
    }
}
BackendRuntime& BackendRuntime::Get() {
    static BackendRuntime r;
    return r;
}
void BackendRuntime::Start() {
#if CONFIG_SION_DUAL_BACKEND
    if (enabled_)
        return;
    StartUsbPairing();
    if (FirmwareTrialRestricted())
        return;
    if (!PairingStore().Load(config_))
        return;
    control_key_ = config_.control_key;
    local_url_ = config_.local_url;
    local_token_ = config_.local_token;
    network_ = std::make_unique<PairedNetwork>(config_.ca);
    char boot[33];
    for (int i = 0; i < 4; ++i)
        snprintf(boot + i * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
    boot_id_ = boot;
    httpd_ssl_config_t tls = HTTPD_SSL_CONFIG_DEFAULT();
    auto& cfg = tls.httpd;
    // Never expose paired controls on the provisioning access point.
    auto* station = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    struct ifreq interface_name{};
    if (!station || esp_netif_get_netif_impl_name(station, interface_name.ifr_name) != ESP_OK)
        return;
    cfg.if_name = &interface_name;
    tls.port_secure = 8765;
    tls.transport_mode = HTTPD_SSL_TRANSPORT_SECURE;
    tls.servercert = reinterpret_cast<const uint8_t*>(config_.cert.c_str());
    tls.servercert_len = config_.cert.size() + 1;
    tls.prvtkey_pem = reinterpret_cast<const uint8_t*>(config_.key.c_str());
    tls.prvtkey_len = config_.key.size() + 1;
    cfg.ctrl_port = 32770;
    cfg.max_open_sockets = 3;
    cfg.stack_size = 10240;
    cfg.recv_wait_timeout = 2;
    cfg.send_wait_timeout = 2;
    if (httpd_ssl_start(&server_, &tls) != ESP_OK)
        return;
    httpd_uri_t get{};
    get.uri = "/v1/backend";
    get.method = HTTP_GET;
    get.handler = Handle;
    get.user_ctx = this;
    httpd_uri_t post = get;
    post.method = HTTP_POST;
    if (httpd_register_uri_handler(server_, &get) != ESP_OK ||
        httpd_register_uri_handler(server_, &post) != ESP_OK) {
        httpd_ssl_stop(server_);
        server_ = nullptr;
        return;
    }
    enabled_ = true;
    Publish();
#endif
}
bool BackendRuntime::ReservePairing() {
    // Called only on the application task, with no protocol transition active.
    if (controller_.Get().phase != Phase::Original || !Application::GetInstance().SionCanEnter())
        return false;
    pairing_reserved_.store(true);
    return true;
}
bool BackendRuntime::Busy() const {
    if (!enabled_)
        return false;
    auto p = controller_.Get().phase;
    return p != Phase::Original && p != Phase::Local;
}
bool BackendRuntime::Local() const { return enabled_ && controller_.Get().phase == Phase::Local; }
void BackendRuntime::PhysicalReturn() {
    if (enabled_)
        controller_.ReturnOriginal(Now());
}
void BackendRuntime::Disconnected(uint64_t epoch) {
    if (enabled_)
        controller_.Disconnected(epoch, Now());
}
void BackendRuntime::Tick() {
    if (!enabled_)
        return;
    std::deque<Command> work;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        work.swap(commands_);
    }
    const char* result = "none";
    for (auto& c : work) {
        bool ok = false;
        if (pairing_reserved_.load())
            ok = false;
        else if (c.action == "enter" && Application::GetInstance().SionCanEnter())
            ok = controller_.Enter(c.epoch, Now());
        else if (c.action == "renew")
            ok = controller_.Renew(c.epoch, Now());
        else if (c.action == "leave")
            ok = controller_.Leave(c.epoch, Now());
        result = ok ? "applied" : "rejected";
        last_result_ = result;
        last_action_ = c.action;
        last_epoch_ = std::to_string(c.epoch);
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& receipt : receipts_)
            if (receipt.command.id == c.id)
                receipt.result = result;
    }
    controller_.Tick(Now());
    Publish(result);
}
void BackendRuntime::Publish(const char* result) {
    const auto& s = controller_.Get();
    cJSON* json = cJSON_CreateObject();
    cJSON_AddBoolToObject(json, "enabled", enabled_);
    cJSON_AddBoolToObject(json, "restart_required", pairing_reserved_.load());
    cJSON_AddStringToObject(json, "pair_id", config_.id.c_str());
    cJSON_AddStringToObject(json, "boot_id", boot_id_.c_str());
    cJSON_AddStringToObject(json, "epoch", std::to_string(s.epoch).c_str());
    cJSON_AddStringToObject(json, "phase", Name(s.phase));
    cJSON_AddStringToObject(json, "selected",
                            s.selected == Backend::Original ? "original" : "local");
    cJSON_AddBoolToObject(json, "original_ready", s.original_ready);
    cJSON_AddStringToObject(json, "lease_expires_ms", std::to_string(s.expires_ms).c_str());
    (void)result;
    cJSON_AddNumberToObject(json, "protocol_version", 2);
    cJSON_AddStringToObject(json, "command_result", last_result_.c_str());
    cJSON_AddStringToObject(json, "command_action", last_action_.c_str());
    cJSON_AddStringToObject(json, "command_epoch", last_epoch_.c_str());
    auto* receipts = cJSON_AddArrayToObject(json, "receipts");
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& r : receipts_) {
            auto* item = cJSON_CreateObject();
            cJSON_AddItemToArray(receipts, item);
            cJSON_AddStringToObject(item, "request_id", r.command.id.c_str());
            cJSON_AddStringToObject(item, "result", r.result.c_str());
        }
    }
    char* text = cJSON_PrintUnformatted(json);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        status_ = text ? text : "{}";
    }
    cJSON_free(text);
    cJSON_Delete(json);
}
std::string BackendRuntime::Status() {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
}
bool BackendRuntime::Authenticate(httpd_req_t* req) {
    auto n = httpd_req_get_hdr_value_len(req, "Authorization");
    if (n != control_key_.size() + 7 || n > 136)
        return false;
    char supplied[137]{};
    if (httpd_req_get_hdr_value_str(req, "Authorization", supplied, sizeof(supplied)) != ESP_OK)
        return false;
    std::string expected = "Bearer " + control_key_;
    unsigned mismatch = 0;
    for (size_t i = 0; i < expected.size(); ++i)
        mismatch |= static_cast<unsigned char>(supplied[i] ^ expected[i]);
    return mismatch == 0;
}
esp_err_t BackendRuntime::Handle(httpd_req_t* req) {
    auto& self = *static_cast<BackendRuntime*>(req->user_ctx);
    if (!self.Authenticate(req))
        return httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "unauthorized");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    if (req->method == HTTP_POST) {
        if (req->content_len <= 0 || req->content_len > 512)
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid command size");
        std::string body(req->content_len, '\0');
        size_t read = 0;
        while (read < body.size()) {
            int n = httpd_req_recv(req, body.data() + read, body.size() - read);
            if (n <= 0)
                return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "incomplete command");
            read += n;
        }
        const char* end_of_json = nullptr;
        cJSON* json = cJSON_ParseWithLengthOpts(body.c_str(), body.size() + 1, &end_of_json, true);
        const auto* action = cJSON_GetObjectItemCaseSensitive(json, "action");
        const auto* boot = cJSON_GetObjectItemCaseSensitive(json, "boot_id");
        const auto* epoch = cJSON_GetObjectItemCaseSensitive(json, "epoch");
        const auto* id = cJSON_GetObjectItemCaseSensitive(json, "request_id");
        bool valid = cJSON_IsString(action) && cJSON_IsString(boot) && cJSON_IsString(epoch) &&
                     cJSON_IsString(id) && Hex(id->valuestring, 32);
        uint64_t value = 0;
        if (valid) {
            const char* end = epoch->valuestring + strlen(epoch->valuestring);
            auto parsed = std::from_chars(epoch->valuestring, end, value);
            valid = parsed.ec == std::errc{} && parsed.ptr == end &&
                    self.boot_id_ == boot->valuestring &&
                    (strcmp(action->valuestring, "enter") == 0 ||
                     strcmp(action->valuestring, "renew") == 0 ||
                     strcmp(action->valuestring, "leave") == 0);
        }
        if (!valid) {
            cJSON_Delete(json);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid command or boot");
        }
        bool full = false, conflict = false, duplicate = false;
        {
            std::lock_guard<std::mutex> lock(self.mutex_);
            for (const auto& r : self.receipts_)
                if (r.command.id == id->valuestring) {
                    duplicate = true;
                    conflict = r.command.epoch != value || r.command.action != action->valuestring;
                }
            full = self.commands_.size() >= 8;
            if (!duplicate && !full && !self.pairing_reserved_.load()) {
                Command command{action->valuestring, value, id->valuestring};
                if (self.receipts_.size() >= 32)
                    self.receipts_.pop_front();
                self.receipts_.push_back({command, "pending"});
                self.commands_.push_back(std::move(command));
            }
        }
        if (conflict) {
            cJSON_Delete(json);
            httpd_resp_set_status(req, "409 Conflict");
            return httpd_resp_sendstr(req, "{\"error\":\"request ID reused\"}");
        }
        if (self.pairing_reserved_.load()) {
            cJSON_Delete(json);
            httpd_resp_set_status(req, "503 Service Unavailable");
            return httpd_resp_sendstr(req, "{\"error\":\"restart required\"}");
        }
        cJSON_Delete(json);
        if (full && !duplicate) {
            httpd_resp_set_status(req, "503 Service Unavailable");
            return httpd_resp_sendstr(req, "{\"error\":\"command queue full\"}");
        }
        // Queue acceptance is not a successful mode switch. Poll the independent control plane.
        Application::GetInstance().Schedule([] {});
        httpd_resp_set_status(req, "202 Accepted");
        return httpd_resp_sendstr(req, "{\"accepted\":true,\"completed\":false}");
    }
    auto status = self.Status();
    return httpd_resp_send(req, status.data(), status.size());
}
void BackendRuntime::Quiesce(uint64_t epoch) { Application::GetInstance().SionQuiesce(epoch); }
bool BackendRuntime::IsQuiescent() { return Application::GetInstance().SionIsQuiescent(); }
void BackendRuntime::Connect(Backend backend, uint64_t epoch) {
    Application::GetInstance().SionConnect(backend == Backend::Local, epoch, local_url_,
                                           local_token_);
}
Result BackendRuntime::ConnectionResult(uint64_t epoch) {
    return Application::GetInstance().SionConnectionResult(epoch);
}
bool BackendRuntime::Activate(Backend backend, uint64_t epoch) {
    return Application::GetInstance().SionActivate(backend == Backend::Local, epoch);
}
}  // namespace sion
