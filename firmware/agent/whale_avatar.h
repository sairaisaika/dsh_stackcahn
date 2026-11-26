// SPDX-License-Identifier: MIT
#pragma once
#include "audio_engine.h"
#include "whale_assets.h"
#include <stackchan/avatar/skins/default/default.h>

namespace sion::agent {

// Standby: linked to DSH and nobody is talking to her. Offline hears nothing.
enum class WhaleActivity : uint8_t { Offline, Connecting, Listening, Thinking, Standby };

// Page-owned image layers, updated only by the UI task. No timers or callbacks
// retain this object; destroy the avatar before deleting its page.
class WhaleAvatar {
public:
    using Emotion = stackchan::avatar::Emotion;
    static bool Available() {
        // Legacy blobs can have valid bounds but incorrectly packed scanlines.
        // Only the corrected generator may stamp the supported layout version.
#if defined(SION_WHALE_ASSET_LAYOUT_VERSION) && SION_WHALE_ASSET_LAYOUT_VERSION == 3
        return whale::FaceImage(whale::Face::Neutral) != nullptr;
#else
        return false;
#endif
    }

    explicit WhaleAvatar(lv_obj_t* page) {
        if (!page) return;
        lv_obj_set_style_border_width(page, 0, 0);
        lv_obj_set_style_radius(page, 0, 0);
        Create(face_layer_, page);
        Create(talk_layer_, page);
        Create(blink_layer_, page);
        Create(hand_layer_, page);
        Render(whale::Face::Stare, 0, 0, false, 0);
    }

    void SetEmotion(Emotion value) { emotion_ = value; }
    void Reset() {
        emotion_ = Emotion::Neutral;
        petted_until_ = poked_at_ = speaking_until_ = mouth_next_at_ = chatting_until_ = 0;
        shy_until_ = greet_until_ = glance_until_ = next_glance_at_ = blink_at_ = 0;
        epoch_ = last_output_ = 0;
        poked_ = patted_ = false;
        mouth_ = 0;
        last_activity_ = WhaleActivity::Offline;
        Render(whale::Face::Stare, 0, 0, false, 0);
    }
    void Poke(uint64_t now) {
        poked_ = true;
        poked_at_ = now;
        petted_until_ = 0;
        shy_until_ = 0;
    }

    void Update(uint64_t now, const AudioStatus& audio, WhaleActivity activity, bool petting) {
        const bool audible = audio.phase == AudioPhase::Running &&
            audio.requested_volume > 0 && audio.applied_volume > 0;
        if (!audible || epoch_ != audio.epoch) speaking_until_ = 0;
        else if (audio.output_written > last_output_) { speaking_until_ = now + 160; chatting_until_ = now + 1500; }
        epoch_ = audio.epoch;
        last_output_ = audio.output_written;
        if (petting) { petted_until_ = now + 900; poked_ = false; }
        if (poked_ && now - poked_at_ >= 1300) poked_ = false;
        const bool pat = now < petted_until_;
        if (patted_ && !pat) shy_until_ = now + 1600;  // A pat ends: a shy moment.
        patted_ = pat;
        // Woken from standby: a smile first, then the attentive stare.
        if (activity == WhaleActivity::Listening && last_activity_ == WhaleActivity::Standby) greet_until_ = now + 2000;
        last_activity_ = activity;
        if (!next_glance_at_) next_glance_at_ = now + Between(18000, 36000);

        auto face = whale::Face::Stare;
        if (pat) {
            // The hand sprites are composed over this face by the generator.
            face = whale::Face::Pat;
        } else if (poked_) {
            face = now - poked_at_ < 450 ? whale::Face::Surprised : whale::Face::Happy;
        } else if (now < shy_until_) {
            face = whale::Face::Shy;
        } else if (emotion_ != Emotion::Neutral) {
            face = Express(emotion_);
        } else if (activity == WhaleActivity::Offline) {
            face = whale::Face::Sleepy;
        } else if (activity == WhaleActivity::Connecting) {
            face = whale::Face::Doubt;
        } else if (activity == WhaleActivity::Thinking) {
            face = whale::Face::Thinking;
        } else if (now < chatting_until_ || now < greet_until_) {
            face = whale::Face::Neutral;  // Talking with you: the smile.
        } else if (activity == WhaleActivity::Standby) {
            // Left alone she still has a little life: now and then a smile or a
            // puzzled tilt, then back to staring.
            if (now >= next_glance_at_) {
                glance_face_ = Between(0, 10) < 6 ? whale::Face::Neutral : whale::Face::Doubt;
                glance_until_ = now + (glance_face_ == whale::Face::Doubt ? 1600 : 1400);
                next_glance_at_ = now + Between(18000, 36000);
            }
            if (now < glance_until_) face = glance_face_;
        }

        // Mouth follows the loudness of audio actually written to the amplifier:
        // closed, half or open, re-read every 60 ms; never jumps open -> closed.
        if (now < speaking_until_) {
            if (now >= mouth_next_at_) {
                const uint8_t want = audio.output_level >= 8 ? 2 : audio.output_level >= 2 ? 1 : 0;
                mouth_ = want + 1 < mouth_ ? static_cast<uint8_t>(mouth_ - 1) : want;
                mouth_next_at_ = now + 60;
            }
        } else {
            mouth_ = mouth_ ? static_cast<uint8_t>(mouth_ - 1) : 0;
            mouth_next_at_ = 0;
        }
        Render(face, mouth_, BlinkStage(now), pat, (now / 200) % 2);
    }

    whale::Face face() const { return face_shown_; }
    bool talking() const { return !talk_layer_.hidden; }
    uint8_t mouth() const { return talk_layer_.hidden ? 0 : talk_layer_.source == whale::TalkImage(face_shown_) ? 2 : 1; }
    bool blinking() const { return !blink_layer_.hidden; }
    bool patting() const { return !hand_layer_.hidden; }

private:
    struct Layer {
        lv_obj_t* object = nullptr;
        const void* source = nullptr;
        bool hidden = true;
    };

    static void Create(Layer& layer, lv_obj_t* page) {
        layer.object = lv_image_create(page);
        if (!layer.object) return;
        lv_obj_remove_flag(layer.object, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(layer.object, LV_OBJ_FLAG_HIDDEN);
    }

    static void Show(Layer& layer, const void* source, const whale::Sprite& sprite) {
        if (!layer.object) return;
        if (!source) {
            if (!layer.hidden) lv_obj_add_flag(layer.object, LV_OBJ_FLAG_HIDDEN);
            layer.hidden = true;
            return;
        }
        if (layer.source != source) {
            lv_image_set_src(layer.object, source);
            lv_obj_set_pos(layer.object, sprite.x, sprite.y);
            layer.source = source;
        }
        if (layer.hidden) lv_obj_remove_flag(layer.object, LV_OBJ_FLAG_HIDDEN);
        layer.hidden = false;
    }

    void Render(whale::Face face, uint8_t mouth, uint8_t eyes, bool pat, unsigned hand) {
        const auto index = static_cast<unsigned>(face);
        face_shown_ = face;
        Show(face_layer_, whale::FaceImage(face), whale::kFaceSprites[index]);
        Show(talk_layer_, mouth == 2 ? whale::TalkImage(face) : mouth == 1 ? whale::TalkHalfImage(face) : nullptr,
             whale::kTalkSprites[index]);
        Show(blink_layer_, eyes == 2 ? whale::BlinkImage(face) : eyes == 1 ? whale::BlinkHalfImage(face) : nullptr,
             whale::kBlinkSprites[index]);
        Show(hand_layer_, pat ? whale::HandImage(hand) : nullptr, whale::kHandSprites[hand]);
    }

    // 0 open, 2 closed. Blinks come every 2.2-5.6 s, a quarter of them double:
    // the lids shut for about 90 ms with no half-lid frame (it read as odd).
    // The half-lid sprites stay in the asset blob but are not shown.
    uint8_t BlinkStage(uint64_t now) {
        if (!blink_at_) blink_at_ = now + Between(2200, 5600);
        if (now < blink_at_) return 0;
        const uint64_t into = now - blink_at_;
        if (into >= 120) {
            const bool again = !double_ && Between(0, 4) == 0;
            double_ = again;
            blink_at_ = now + (again ? 80 : Between(2200, 5600));
            return 0;
        }
        return into < 30 ? 0 : 2;
    }
    // Deterministic small generator: varied timing without a clock source.
    uint32_t Between(uint32_t low, uint32_t high) {
        random_ ^= random_ << 13; random_ ^= random_ >> 17; random_ ^= random_ << 5;
        return low + random_ % (high - low);
    }

    static whale::Face Express(Emotion value) {
        switch (value) {
            case Emotion::Happy: return whale::Face::Happy;
            case Emotion::Angry: return whale::Face::Angry;
            case Emotion::Sad: return whale::Face::Sad;
            case Emotion::Doubt: return whale::Face::Doubt;
            case Emotion::Sleepy: return whale::Face::Sleepy;
            default: return whale::Face::Neutral;
        }
    }

    Layer face_layer_, talk_layer_, blink_layer_, hand_layer_;
    Emotion emotion_ = Emotion::Neutral;
    whale::Face face_shown_ = whale::Face::Stare, glance_face_ = whale::Face::Neutral;
    WhaleActivity last_activity_ = WhaleActivity::Offline;
    uint64_t epoch_ = 0, last_output_ = 0, speaking_until_ = 0, mouth_next_at_ = 0, chatting_until_ = 0;
    uint64_t petted_until_ = 0, poked_at_ = 0, shy_until_ = 0, greet_until_ = 0;
    uint64_t glance_until_ = 0, next_glance_at_ = 0, blink_at_ = 0;
    uint32_t random_ = 0x9e3779b9u;
    uint8_t mouth_ = 0;
    bool poked_ = false, patted_ = false, double_ = false;
};
}  // namespace sion::agent
