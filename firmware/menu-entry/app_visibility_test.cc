// SPDX-License-Identifier: MIT
#include "hal_toggles.h"
#include <nvs.h>
#include <cassert>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

using namespace hal_toggles;

static std::map<std::string, uint8_t> stored;
static std::vector<std::string> writes;
static bool open, writable, fail_commit;

int nvs_open(const char* name, nvs_open_mode_t mode, int* handle) {
    assert(!open && std::string(name) == "feature_toggles");
    writable = mode == NVS_READWRITE;
    if (stored.empty() && !writable) return ESP_ERR_NVS_NOT_FOUND;
    open = true;
    *handle = 1;
    return ESP_OK;
}
int nvs_get_u8(int handle, const char* key, uint8_t* value) {
    assert(open && handle == 1);
    const auto it = stored.find(key);
    if (it == stored.end()) return ESP_ERR_NVS_NOT_FOUND;
    *value = it->second;
    return ESP_OK;
}
int nvs_set_u8(int handle, const char* key, uint8_t value) {
    assert(open && writable && handle == 1);
    writes.emplace_back(key);
    stored[key] = value;
    return ESP_OK;
}
int nvs_commit(int handle) {
    assert(open && writable && handle == 1);
    return fail_commit ? ESP_ERR_INVALID_STATE : ESP_OK;
}
void nvs_close(int handle) { assert(open && handle == 1); open = false; }

int main() {
    constexpr int setup_id = 301;
    constexpr int agent_id = 407;
    register_app_id(App::AiAgent, 10);
    register_app_id(App::Avatar, 11);
    ToggleStates current{};
    assert(load_states(current) && current == default_states() && writes.empty());
    assert(is_app_enabled(setup_id, current) && is_app_enabled(0, current));

#if CONFIG_STACKCHAN_DSH_MENU
    static_assert(TOGGLE_COUNT == 7);
    constexpr size_t dsh = static_cast<size_t>(App::DshAgent);
    assert(std::string(TOGGLE_LIST[dsh].display_name) == "DSH.AGENT");
    register_app_id(App::DshAgent, agent_id);

    stored = {{"ai_agent", 0}, {"avatar", 1}};
    assert(load_states(current) && !is_app_enabled(10, current) && is_app_enabled(agent_id, current));
    auto desired = current;
    desired[dsh] = false;
    assert(save_states(desired, current));
    assert(writes == std::vector<std::string>{"dsh_visible"});
    assert(!stored.contains("visible_mask") && stored.at("ai_agent") == 0);
    assert(load_states(current) && current == desired && !is_app_enabled(agent_id, current));
    assert(is_app_enabled(setup_id, current) && is_app_enabled(11, current));

    stored["visible_mask"] = 0x2a;
    assert(load_states(current) && !current[0] && current[1] && !current[dsh]);
    desired = current;
    desired[dsh] = true;
    writes.clear();
    assert(save_states(desired, current) && stored.at("visible_mask") == 0x2a);
    assert(writes == std::vector<std::string>{"dsh_visible"});
    assert(load_states(current) && current == desired && is_app_enabled(agent_id, current));

    // The existing worker reloads persistent state when a save fails.
    desired[dsh] = false;
    fail_commit = true;
    assert(!save_states(desired, current));
    fail_commit = false;
    assert(load_states(current) && current == desired && !is_app_enabled(agent_id, current));
    writes.clear();
    assert(save_states(default_states(), current));
    assert((writes == std::vector<std::string>{"visible_mask", "dsh_visible"}));
    assert(stored.at("visible_mask") == 0x3f && stored.at("dsh_visible") == 1);
    assert(load_states(current) && current == default_states());

    stored["visible_mask"] = 0x2a;
    stored["dsh_visible"] = 255;
    assert(load_states(current) && !current[0] && current[1] && current[dsh]);
    stored["visible_mask"] = 0x40;
    assert(!load_states(current) && current == default_states());
#else
    static_assert(TOGGLE_COUNT == 6);
    stored = {{"visible_mask", 0x2a}, {"dsh_visible", 0}};
    assert(load_states(current) && !is_app_enabled(10, current) && is_app_enabled(11, current));
    assert(is_app_enabled(agent_id, current) && is_app_enabled(setup_id, current));
    assert(save_states(default_states(), current));
    assert(stored.at("visible_mask") == 0x3f && stored.at("dsh_visible") == 0);
    assert(writes == std::vector<std::string>{"visible_mask"});
#endif
    assert(!open);
    std::printf("Menu visibility config=%d: factory mask, IDs, and DSH preference compatibility passed\n",
                CONFIG_STACKCHAN_DSH_MENU);
}
