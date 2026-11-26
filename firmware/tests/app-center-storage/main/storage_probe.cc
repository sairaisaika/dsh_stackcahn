// SPDX-License-Identifier: MIT
#include "tail_storage.h"
#include "pairing_store.h"
#include "preferences.h"
#include <cstdio>
#include <esp_system.h>

using namespace sion::agent;

namespace {
constexpr char PairId[] = "cccccccccccccccccccccccccccccccc";
constexpr char PairRecord[] = R"({
"version":1, "role":"sion-device", "pair_id":"cccccccccccccccccccccccccccccccc",
"control_key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
"local_token":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
"local_url":"wss://192.168.1.2:8766/audio", "ca":"-----BEGIN CERTIFICATE-----fixture",
"cert":"-----BEGIN CERTIFICATE-----fixture", "key":"-----BEGIN PRIVATE KEY-----fixture"
})";
const Preferences ExpectedPreferences{67, true, false, 12, true, false, true, Appearance::Fish};
}

extern "C" void __attribute__((noinline)) sion_storage_probe_done()
{
    asm volatile("" ::: "memory");
}

extern "C" void app_main()
{
    const auto mounted = RegisterReviewedTailStorage();
    if (mounted != ESP_OK) {
        std::printf("SION-STORE: unavailable (%s)\n", esp_err_to_name(mounted));
    } else {
        NvsPreferenceStore settings;
        AgentPairingStore pairing;
        Preferences prefs{};
        std::string record;
        const auto initial = pairing.Read(&record);
        const auto loaded = settings.Load(prefs);
        if (initial.state == PairingState::Empty && loaded == PreferenceLoad::Missing &&
            pairing.Replace("", PairRecord) == PairingWrite::Saved && settings.Save(ExpectedPreferences)) {
            std::puts("SION-STORE: saved through DSH stores");
            std::fflush(stdout);
            esp_restart();
        }
        const bool restored = initial.state == PairingState::Paired && initial.id == PairId &&
                              record == PairRecord && loaded == PreferenceLoad::Loaded &&
                              EncodePreferences(prefs) == EncodePreferences(ExpectedPreferences);
        std::puts(restored ? "SION-STORE: pairing and preferences restored" : "SION-STORE: unexpected record");
    }
    std::fflush(stdout);
    sion_storage_probe_done();
}
