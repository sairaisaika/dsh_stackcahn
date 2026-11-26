// SPDX-License-Identifier: MIT
#pragma once
#include "audio_engine.h"
#include <stackchan/avatar/skins/default/default.h>

namespace sion::agent {
// All objects belong to the current LVGL page and are used only on its task.
class FishAvatar {
public:
    using Emotion = stackchan::avatar::Emotion;

    explicit FishAvatar(lv_obj_t* page) {
        auto* water = Shape(page, 0, 0, 320, 240, 0, 0x102B3D);
        Shape(water, 260, 80, 17, 17, 9, 0x5CAFC6);
        Shape(water, 280, 62, 9, 9, 5, 0x91D7DD);
        Shape(water, 22, 108, 66, 40, 20, 0xEF805A);
        Shape(water, 22, 145, 66, 40, 20, 0xEF805A);
        Shape(water, 119, 48, 58, 61, 29, 0xEF805A);
        Shape(water, 64, 65, 187, 145, 73, 0xFFC775);
        Shape(water, 90, 126, 146, 76, 38, 0xFFE8AD);
        Shape(water, 85, 145, 32, 19, 10, 0xFFA482);
        Shape(water, 209, 145, 32, 19, 10, 0xFFA482);
        eyes_[0] = Shape(water, 112, 105, 31, 34, 16, 0x263647);
        eyes_[1] = Shape(water, 178, 105, 31, 34, 16, 0x263647);
        mouth_ = Shape(water, 146, 151, 36, 19, 12, 0x7A3548);
        pupils_[0] = Shape(eyes_[0], 11, 6, 9, 9, 5, 0xFFF9EA);
        pupils_[1] = Shape(eyes_[1], 11, 6, 9, 9, 5, 0xFFF9EA);
    }

    void SetEmotion(Emotion value) { emotion_ = value; }
    void Reset() {
        emotion_ = Emotion::Neutral;
        speaking_until_ = 0;
    }

    bool talking() const { return drawn_ && drawn_talking_; }
    void Update(uint64_t now, const AudioStatus& audio) {
        const bool audible = audio.phase == AudioPhase::Running && audio.requested_volume > 0 && audio.applied_volume > 0;
        if (!audible || epoch_ != audio.epoch) speaking_until_ = 0;
        else if (audio.output_written > last_output_) speaking_until_ = now + 140;
        epoch_ = audio.epoch;
        last_output_ = audio.output_written;

        const bool blink = now % 3800 >= 3690;
        const bool talking = now < speaking_until_ && (now / 120) % 2 == 0;
        if (emotion_ == drawn_emotion_ && blink == drawn_blink_ && talking == drawn_talking_ && drawn_) return;
        drawn_ = true;
        drawn_emotion_ = emotion_;
        drawn_blink_ = blink;
        drawn_talking_ = talking;

        const auto face = FaceFor(emotion_);
        DrawEye(0, blink ? 4 : face.left_eye, 112);
        DrawEye(1, blink ? 4 : face.right_eye, 178);
        const int width = talking ? 35 : face.mouth_width;
        const int height = talking ? 31 : face.mouth_height;
        lv_obj_set_size(mouth_, width, height);
        lv_obj_set_pos(mouth_, 164 - width / 2, 159 - height / 2);
    }
private:
    struct Face { int left_eye, right_eye, mouth_width, mouth_height; };
    static Face FaceFor(Emotion emotion) {
        switch (emotion) {
            case Emotion::Happy: return {12, 12, 52, 24};
            case Emotion::Angry: return {18, 18, 36, 7};
            case Emotion::Sad: return {25, 25, 17, 12};
            case Emotion::Doubt: return {34, 16, 25, 8};
            case Emotion::Sleepy: return {5, 5, 18, 16};
            default: return {34, 34, 36, 19};
        }
    }
    static lv_obj_t* Shape(lv_obj_t* parent, int x, int y, int width, int height, int radius, uint32_t color) {
        auto* object = lv_obj_create(parent);
        lv_obj_remove_style_all(object);
        lv_obj_remove_flag(object, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_remove_flag(object, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_pos(object, x, y);
        lv_obj_set_size(object, width, height);
        lv_obj_set_style_radius(object, radius, 0);
        lv_obj_set_style_bg_color(object, lv_color_hex(color), 0);
        lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
        return object;
    }
    void DrawEye(size_t index, int height, int x) {
        lv_obj_set_size(eyes_[index], 31, height);
        lv_obj_set_pos(eyes_[index], x, 122 - height / 2);
        lv_obj_set_style_bg_opa(pupils_[index], height >= 20 ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    }

    lv_obj_t* eyes_[2]{};
    lv_obj_t* pupils_[2]{};
    lv_obj_t* mouth_ = nullptr;
    Emotion emotion_ = Emotion::Neutral, drawn_emotion_ = Emotion::Neutral;
    uint64_t epoch_ = 0, last_output_ = 0, speaking_until_ = 0;
    bool drawn_ = false, drawn_blink_ = false, drawn_talking_ = false;
};
}
