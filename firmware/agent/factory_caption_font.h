// SPDX-License-Identifier: MIT
#pragma once

struct _lv_font_t;

namespace sion::agent {
// Application task only. Prepare while disconnected. Release after the last
// label using this font has been deleted.
void PrepareFactoryCaptionFont();
const _lv_font_t* FactoryCaptionFont();
void ReleaseFactoryCaptionFont();
}
