#pragma once
#include "nvs.h"
struct nvs_stats_t {size_t free_entries;};
inline int nvs_get_stats(const char*,nvs_stats_t* stats){stats->free_entries=fake_nvs::free_entries;return ESP_OK;}
