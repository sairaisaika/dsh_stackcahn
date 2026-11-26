// SPDX-License-Identifier: MIT
#include "whale_assets.h"
#include <lvgl.h>
#include <iterator>
#include <limits>

extern "C" {
extern const uint8_t sion_whale_assets_start[];
extern const uint8_t sion_whale_assets_end[];
}

namespace sion::agent::whale {
namespace {
// Compiled image descriptors, as the upstream avatar decorators use them
// (m5stack/StackChan firmware/main/stackchan/avatar/decorators/assets).
struct Images {
    lv_image_dsc_t face[std::size(kFaceSprites)]{};
    lv_image_dsc_t talk[std::size(kTalkSprites)]{};
    lv_image_dsc_t talk_half[std::size(kTalkHalfSprites)]{};
    lv_image_dsc_t blink[std::size(kBlinkSprites)]{};
    lv_image_dsc_t blink_half[std::size(kBlinkHalfSprites)]{};
    lv_image_dsc_t hand[std::size(kHandSprites)]{};
    bool valid = false;

    Images() {
        // Linker symbols delimit one blob; do not subtract unrelated C++ arrays.
        const auto start = reinterpret_cast<uintptr_t>(sion_whale_assets_start);
        const auto end = reinterpret_cast<uintptr_t>(sion_whale_assets_end);
        if (end < start || end - start != kBlobBytes) return;
        for (size_t i = 0; i < std::size(kFaceSprites); ++i) face[i] = Describe(kFaceSprites[i]);
        for (size_t i = 0; i < std::size(kTalkSprites); ++i) talk[i] = Describe(kTalkSprites[i]);
        for (size_t i = 0; i < std::size(kTalkHalfSprites); ++i) talk_half[i] = Describe(kTalkHalfSprites[i]);
        for (size_t i = 0; i < std::size(kBlinkSprites); ++i) blink[i] = Describe(kBlinkSprites[i]);
        for (size_t i = 0; i < std::size(kBlinkHalfSprites); ++i) blink_half[i] = Describe(kBlinkHalfSprites[i]);
        for (size_t i = 0; i < std::size(kHandSprites); ++i) hand[i] = Describe(kHandSprites[i]);
        valid = true;
    }

    static lv_image_dsc_t Describe(const Sprite& sprite) {
        lv_image_dsc_t image{};
        // Empty sprites are absent overlays. Check before multiplication or pointer arithmetic.
        if (!sprite.width || !sprite.height || sprite.offset > kBlobBytes) return image;
        const size_t stride = static_cast<size_t>(sprite.width) * 2;
        if (stride > std::numeric_limits<uint16_t>::max() ||
            sprite.height > (kBlobBytes - sprite.offset) / stride) return image;
        const size_t bytes = stride * sprite.height;
        if (bytes > std::numeric_limits<uint32_t>::max()) return image;
        image.header.magic = LV_IMAGE_HEADER_MAGIC;
        image.header.cf = LV_COLOR_FORMAT_RGB565;
        image.header.w = sprite.width;
        image.header.h = sprite.height;
        image.header.stride = stride;
        image.data_size = static_cast<uint32_t>(bytes);
        image.data = sion_whale_assets_start + sprite.offset;
        return image;
    }
};
const Images& All() { static const Images images; return images; }
template<class Value, size_t Count>
const void* Pick(const lv_image_dsc_t (&images)[Count], Value value) {
    const auto index = static_cast<size_t>(value);
    return All().valid && index < Count && images[index].data ? &images[index] : nullptr;
}
}

const void* FaceImage(Face value) { return Pick(All().face, value); }
const void* TalkImage(Face value) { return Pick(All().talk, value); }
const void* TalkHalfImage(Face value) { return Pick(All().talk_half, value); }
const void* BlinkImage(Face value) { return Pick(All().blink, value); }
const void* BlinkHalfImage(Face value) { return Pick(All().blink_half, value); }
const void* HandImage(unsigned index) { return Pick(All().hand, index); }
}
