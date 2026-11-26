// SPDX-License-Identifier: MIT
#pragma once

#include <cstdint>

// Evaluated on the app task. Verification reads the original image; it can
// take time and must run outside the display lock.
bool ReviewedStockCanResume();
uint32_t ReviewedStockReturnAddress(); // Zero if no confirmed fallback is safe.
