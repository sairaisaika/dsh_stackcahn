// SPDX-License-Identifier: MIT
#pragma once

#include <esp_err.h>

bool MatchesReviewedAppCenterLayout();

// Called once, on the application task before the pairing and settings stores.
esp_err_t RegisterReviewedTailStorage();
