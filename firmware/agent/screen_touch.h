// SPDX-License-Identifier: MIT
#pragma once
#include <array>
#include <cstdint>
#include <mutex>

namespace sion::agent {
// Screen touches as facts for the Host: where a finger went down, moved and
// came up, from the touch driver's own samples. Moves are thinned (a new point
// only after kMoveStepPx or kMoveEveryMs) and the queue is bounded; when full,
// the oldest event is dropped and counted. The face's own tap handling is separate.
struct ScreenTouchEvent {
    enum Phase : uint8_t { Down, Move, Up } phase=Down;
    int16_t x=0,y=0;
    uint64_t at=0;
};
class ScreenTouchLog {
public:
    static constexpr int kMoveStepPx=12;
    static constexpr uint64_t kMoveEveryMs=100;
    void Note(bool pressed,int x,int y,uint64_t now) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!pressed) {
            if(down_){Push({ScreenTouchEvent::Up,last_x_,last_y_,now});down_=false;}
            return;
        }
        if(!down_){down_=true;Set(x,y,now);Push({ScreenTouchEvent::Down,int16_t(x),int16_t(y),now});return;}
        const int dx=x-last_x_,dy=y-last_y_;
        if(dx*dx+dy*dy>=kMoveStepPx*kMoveStepPx||(now-last_at_>=kMoveEveryMs&&(dx||dy))) {
            Set(x,y,now);Push({ScreenTouchEvent::Move,int16_t(x),int16_t(y),now});
        }
    }
    bool Take(ScreenTouchEvent& event) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!count_)return false;
        event=queue_[head_];head_=(head_+1)%queue_.size();--count_;return true;
    }
    uint32_t Dropped() const {std::lock_guard<std::mutex> lock(mutex_);return dropped_;}
    void Clear() {std::lock_guard<std::mutex> lock(mutex_);head_=count_=0;}
private:
    mutable std::mutex mutex_;
    std::array<ScreenTouchEvent,16> queue_{};
    unsigned head_=0,count_=0;
    uint32_t dropped_=0;
    bool down_=false;
    int16_t last_x_=0,last_y_=0;
    uint64_t last_at_=0;
    void Set(int x,int y,uint64_t now){last_x_=int16_t(x);last_y_=int16_t(y);last_at_=now;}
    void Push(const ScreenTouchEvent& event) {
        if(count_==queue_.size()){head_=(head_+1)%queue_.size();--count_;++dropped_;}
        queue_[(head_+count_)%queue_.size()]=event;++count_;
    }
};
ScreenTouchLog& DeviceScreenTouch();
}
