// SPDX-License-Identifier: MIT
// Host test of the whale face state machine against a recording LVGL stub.
#include "whale_avatar.h"
#include <algorithm>
#include <iostream>
namespace sion::agent::whale {
static int faces[kFaceCount], talks[kFaceCount], talk_halves[kFaceCount], blinks[kFaceCount], blink_halves[kFaceCount], hands[2];
const void* FaceImage(Face f) { return &faces[static_cast<unsigned>(f)]; }
const void* TalkImage(Face f) { auto i=static_cast<unsigned>(f); return kTalkSprites[i].width ? &talks[i] : nullptr; }
const void* TalkHalfImage(Face f) { auto i=static_cast<unsigned>(f); return kTalkHalfSprites[i].width ? &talk_halves[i] : nullptr; }
const void* BlinkImage(Face f) { auto i=static_cast<unsigned>(f); return kBlinkSprites[i].width ? &blinks[i] : nullptr; }
const void* BlinkHalfImage(Face f) { auto i=static_cast<unsigned>(f); return kBlinkHalfSprites[i].width ? &blink_halves[i] : nullptr; }
const void* HandImage(unsigned i) { return i<2 ? &hands[i] : nullptr; }
}
using namespace sion::agent;
using Face = whale::Face;
using Emotion = WhaleAvatar::Emotion;
static bool visible(const lv_obj_t* o) { return !(o->flags & LV_OBJ_FLAG_HIDDEN); }
static void position(const lv_obj_t* o, const whale::Sprite& s) { assert(o->x==s.x && o->y==s.y); }
static unsigned index(Face f) { return static_cast<unsigned>(f); }

int main() {
    assert(WhaleAvatar::Available());
    // Generated layout: in-between frames share their full frame's rectangle.
    for (unsigned i=0;i<whale::kFaceCount;++i) {
        const auto &t=whale::kTalkSprites[i], &th=whale::kTalkHalfSprites[i], &b=whale::kBlinkSprites[i], &bh=whale::kBlinkHalfSprites[i];
        assert(t.x==th.x && t.y==th.y && t.width==th.width && t.height==th.height);
        assert(b.x==bh.x && b.y==bh.y && b.width==bh.width && b.height==bh.height);
    }
    assert(whale::kBlinkSprites[index(Face::Stare)].width && whale::kTalkSprites[index(Face::Shy)].width);
    AudioStatus audio{};
    auto* page = new lv_obj_t;
    {
        WhaleAvatar a(page);
        assert(page->children.size()==4 && allocations==4);
        const auto initial_allocations=allocations;
        auto* face=page->children[0]; auto* talk=page->children[1];
        auto* blink=page->children[2]; auto* hand=page->children[3];
        assert(visible(face) && !visible(talk) && !visible(blink) && !visible(hand));
        assert(a.face()==Face::Stare);  // 呆萌盯着 is the resting face.

        const Emotion emotions[] = {Emotion::Happy,Emotion::Angry,Emotion::Sad,Emotion::Doubt,Emotion::Sleepy};
        const Face faces[] = {Face::Happy,Face::Angry,Face::Sad,Face::Doubt,Face::Sleepy};
        for (unsigned i=0;i<5;++i) {
            a.SetEmotion(emotions[i]); a.Update(100,audio,WhaleActivity::Listening,false);
            assert(a.face()==faces[i] && face->source==whale::FaceImage(faces[i]));
            position(face,whale::kFaceSprites[index(faces[i])]);
        }
        a.SetEmotion(Emotion::Neutral);
        a.Update(101,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Stare);
        a.Update(102,audio,WhaleActivity::Offline,false); assert(a.face()==Face::Sleepy);
        a.Update(103,audio,WhaleActivity::Connecting,false); assert(a.face()==Face::Doubt);
        a.Update(104,audio,WhaleActivity::Thinking,false); assert(a.face()==Face::Thinking);
        a.SetEmotion(Emotion::Angry);
        a.Update(105,audio,WhaleActivity::Offline,false); assert(a.face()==Face::Angry);
        a.SetEmotion(Emotion::Neutral);

        // Waking from standby greets with a smile for two seconds, then stares.
        a.Update(200,audio,WhaleActivity::Standby,false); assert(a.face()==Face::Stare);
        a.Update(220,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Neutral);
        a.Update(2219,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Neutral);
        a.Update(2220,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Stare);

        // Blinks: open -> closed -> open (no half-lid frame), varied intervals, sometimes double.
        a.Reset();
        unsigned closes=0, doubles=0, half_frames=0; uint64_t last_close=0, shortest=UINT64_MAX, longest=0;
        bool closed=false;
        for (uint64_t t=30000;t<150000;t+=20) {
            a.Update(t,audio,WhaleActivity::Listening,false);
            assert(a.face()==Face::Stare);
            const bool now_closed=a.blinking()&&blink->source==whale::BlinkImage(Face::Stare);
            if (a.blinking()&&blink->source==whale::BlinkHalfImage(Face::Stare)) ++half_frames;
            if (now_closed) position(blink,whale::kBlinkSprites[index(Face::Stare)]);
            if (now_closed&&!closed) {
                if (last_close) { const auto gap=t-last_close; shortest=std::min(shortest,gap); longest=std::max(longest,gap); if (gap<400) ++doubles; }
                last_close=t; ++closes;
            }
            closed=now_closed;
        }
        assert(closes>=25 && closes<=70 && doubles>=2 && half_frames==0);
        assert(shortest>=200 && longest<=5900 && longest>=3000);  // Not a metronome.

        // Left in standby she glances now and then (smile or tilt) and returns to the stare.
        a.Reset();
        unsigned glances=0; Face previous=Face::Stare;
        for (uint64_t t=200000;t<500000;t+=40) {
            a.Update(t,audio,WhaleActivity::Standby,false);
            const auto f=a.face();
            assert(f==Face::Stare||f==Face::Neutral||f==Face::Doubt);
            if (f!=Face::Stare&&previous==Face::Stare) ++glances;
            previous=f;
        }
        assert(glances>=6 && glances<=18 && previous==Face::Stare);
        // Listening (being addressed) stays attentive: no glances.
        a.Update(500000,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Neutral);  // Wake smile.
        for (uint64_t t=502000;t<560000;t+=40) { a.Update(t,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Stare); }

        // Poke and pat; a pat ends in a shy moment.
        a.Reset();
        a.Poke(5000); a.Update(5000,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Surprised);
        a.Update(5449,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Surprised);
        a.Update(5450,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Happy);
        a.Update(6300,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Stare);
        a.Update(7000,audio,WhaleActivity::Listening,true); assert(a.patting() && a.face()==Face::Pat);
        position(hand,whale::kHandSprites[0]);
        assert(hand->source==whale::HandImage((7000/200)%2));
        a.Update(7200,audio,WhaleActivity::Listening,true);
        assert(hand->source==whale::HandImage((7200/200)%2));
        a.Update(8099,audio,WhaleActivity::Listening,false); assert(a.patting());
        a.Update(8100,audio,WhaleActivity::Listening,false); assert(!a.patting() && a.face()==Face::Shy);
        a.Update(9699,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Shy);
        a.Update(9700,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Stare);
        a.Update(9800,audio,WhaleActivity::Listening,true); a.Poke(9850);
        a.Update(9850,audio,WhaleActivity::Listening,false); assert(!a.patting() && a.face()==Face::Surprised);  // Poke wins over shy.

        // Mouth: closed, half or open by loudness of audio actually written, never open -> closed in one step.
        a.Reset(); assert(a.face()==Face::Stare && !a.patting() && !a.talking() && !a.blinking());
        audio.phase=AudioPhase::Running; audio.epoch=1; audio.requested_volume=50; audio.applied_volume=50;
        audio.output_level=12; audio.output_written=1;
        a.Update(40000,audio,WhaleActivity::Listening,false); assert(!a.talking());  // New epoch never reuses old output.
        ++audio.output_written; a.Update(40001,audio,WhaleActivity::Listening,false);
        assert(a.mouth()==2 && a.face()==Face::Neutral);  // Speaking with you: the smile, mouth open.
        assert(talk->source==whale::TalkImage(Face::Neutral)); position(talk,whale::kTalkSprites[index(Face::Neutral)]);
        audio.output_level=4; ++audio.output_written; a.Update(40061,audio,WhaleActivity::Listening,false); assert(a.mouth()==1);
        assert(talk->source==whale::TalkHalfImage(Face::Neutral)); position(talk,whale::kTalkSprites[index(Face::Neutral)]);
        audio.output_level=12; ++audio.output_written; a.Update(40121,audio,WhaleActivity::Listening,false); assert(a.mouth()==2);
        audio.output_level=0; ++audio.output_written; a.Update(40181,audio,WhaleActivity::Listening,false); assert(a.mouth()==1);
        ++audio.output_written; a.Update(40241,audio,WhaleActivity::Listening,false); assert(a.mouth()==0 && !a.talking());
        audio.output_level=12; ++audio.output_written; a.Update(40301,audio,WhaleActivity::Listening,false); assert(a.mouth()==2);
        a.Update(40461,audio,WhaleActivity::Listening,false); assert(a.mouth()==1);  // 160 ms output hold expired: closing.
        a.Update(40481,audio,WhaleActivity::Listening,false); assert(a.mouth()==0);
        a.Update(41800,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Neutral);  // Still in the conversation.
        a.Update(41802,audio,WhaleActivity::Listening,false); assert(a.face()==Face::Stare);
        ++audio.output_written; a.Update(42000,audio,WhaleActivity::Listening,false); assert(a.talking());
        audio.applied_volume=0; a.Update(42001,audio,WhaleActivity::Listening,false); a.Update(42002,audio,WhaleActivity::Listening,false); assert(!a.talking());
        audio.applied_volume=50; audio.requested_volume=0; ++audio.output_written;
        a.Update(42003,audio,WhaleActivity::Listening,false); assert(!a.talking());
        audio.requested_volume=50; ++audio.output_written;
        a.Update(42100,audio,WhaleActivity::Listening,false); assert(a.talking());
        ++audio.epoch; a.Update(42101,audio,WhaleActivity::Listening,false); a.Update(42102,audio,WhaleActivity::Listening,false); assert(!a.talking());
        audio.phase=AudioPhase::Idle; ++audio.output_written;
        a.Update(42200,audio,WhaleActivity::Listening,false); assert(!a.talking());

        // Every supplied mouth uses its own per-face coordinates; absent patches remain hidden.
        audio.phase=AudioPhase::Running; audio.output_level=12;
        for (unsigned i=0;i<5;++i) {
            a.Reset(); a.SetEmotion(emotions[i]);
            a.Update(50000+i*1000,audio,WhaleActivity::Listening,false);
            ++audio.output_written; a.Update(50001+i*1000,audio,WhaleActivity::Listening,false);
            assert(a.talking()==(whale::TalkImage(faces[i])!=nullptr));
            if (a.talking()) { assert(talk->source==whale::TalkImage(faces[i])); position(talk,whale::kTalkSprites[index(faces[i])]); }
        }

        // A steady face between blinks writes nothing to LVGL.
        a.Reset(); audio.phase=AudioPhase::Idle;
        a.Update(60000,audio,WhaleActivity::Listening,false);
        const auto idle_writes=writes;
        for(unsigned i=0;i<100;++i) a.Update(60001+i,audio,WhaleActivity::Listening,false);
        assert(writes==idle_writes && allocations==initial_allocations);
    } // Destroy the controller before its page, matching device_main ownership.
    lv_obj_delete(page);
    for(unsigned i=0;i<200;++i) {
        auto* next=new lv_obj_t;
        { WhaleAvatar a(next); a.Poke(1); a.Update(2,audio,WhaleActivity::Listening,true); }
        lv_obj_delete(next);
    }
    { WhaleAvatar a(nullptr); a.Reset(); a.Poke(1); a.Update(2,audio,WhaleActivity::Listening,true); }
    std::cout << "Whale face: stare default, wake smile, varied/double blinks without half-lids, standby glances, shy after pat, "
                 "3-step mouth by loudness, coordinates, idle writes, 200 page lifecycles; not real LVGL or hardware\n";
}
