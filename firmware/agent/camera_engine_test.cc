// SPDX-License-Identifier: MIT
#include "camera_engine.h"
#include <cassert>
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <thread>
using namespace sion::agent;
struct Port final:CameraPort {
    int opened=0,read=0,closed=0;
    bool open_ok=true,close_ok=true,bad_marker=false;
    Result read_result=Result::Done;
    CameraImageInfo info{4,640,480};
    std::function<void()> on_open,on_read,on_close;
    bool Open() override {++opened;if(on_open)on_open();return open_ok;}
    Result Read(uint8_t* target,size_t capacity,CameraImageInfo& output) override {
        ++read;assert(capacity==kCameraMaxBytes);if(on_read)on_read();
        target[0]=bad_marker ? 0 : 0xff; target[1]=0xd8;
        if(info.size>=4&&info.size<=capacity){target[info.size-2]=0xff;target[info.size-1]=0xd9;}
        output=info;return read_result;
    }
    bool Close() override {++closed;if(on_close)on_close();return close_ok;}
};
int main() {
    { // Permission, one result, correlation, repeated requests in same lease.
        Port p;CameraEngine e(p);CameraPicture out;
        assert(!e.Begin(1,0));e.AllowCapture(true);assert(!e.Begin(0,0));
        auto t=e.Begin(1,0);assert(t&&!e.Begin(1,0));
        e.Pump(0);e.Pump(1);assert(!e.Take(1,t,out));e.Pump(2);
        assert(p.closed==1&&!e.Begin(1,3));assert(!e.Take(2,t,out)&&!e.Take(1,t+1,out));
        assert(e.Take(1,t,out)&&out.jpeg&&out.info.size==4&&out.error==CameraError::None);
        assert(!e.Take(1,t,out));auto next=e.Begin(1,3);assert(next>t);
        e.Stop(2);assert(e.Stopped(2)==Result::Pending);e.Pump(4);
        assert(e.Stopped(2)==Result::Done&&p.opened==1&&!e.Begin(2,5));
        assert(e.Begin(3,5));e.Stop(1);e.Pump(5);assert(p.opened==2);
        e.Stop(4);e.Pump(6);assert(e.Stopped(4)==Result::Done);
    }
    { // Failed Open can leave resources. Result only after Close.
        Port p;p.open_ok=false;CameraEngine e(p);e.AllowCapture(true);auto t=e.Begin(1,0);
        CameraPicture out;e.Pump(0);assert(!e.Take(1,t,out));e.Pump(1);
        assert(p.closed==1&&e.Take(1,t,out)&&out.error==CameraError::Open&&!out.jpeg);
    }
    { // Read failure, timeout, clock reversal and strict envelope bounds.
        for(int variant=0;variant<9;++variant) {
            Port p;CameraEngine e(p);e.AllowCapture(true);auto t=e.Begin(1,10);CameraPicture out;
            CameraError expected=CameraError::InvalidImage;
            if(variant==0){p.read_result=Result::Failed;expected=CameraError::Capture;}
            if(variant==1){p.read_result=Result::Pending;expected=CameraError::Timeout;}
            if(variant==2)p.info.size=kCameraMaxBytes+1;
            if(variant==3)p.info.size=3;
            if(variant==4)p.info.width=641;
            if(variant==5)p.info.height=0;
            if(variant==6)p.bad_marker=true;
            if(variant==7)expected=CameraError::Timeout;
            if(variant==8){p.info.size=kCameraMaxBytes;expected=CameraError::None;}
            e.Pump(10);e.Pump(11);
            if(variant==1)e.Pump(10+kCameraTimeoutMs);
            else if(variant==7)e.Pump(9);
            else e.Pump(12);
            assert(e.Take(1,t,out)&&out.error==expected&&p.closed==1);
            assert(bool(out.jpeg)==(expected==CameraError::None));
        }
    }
    { // Stop is callable while Open/Read/Close runs (no engine lock held).
        for(int step=0;step<3;++step) {
            Port p;CameraEngine e(p);e.AllowCapture(true);auto t=e.Begin(1,0);CameraPicture out;
            auto stop=[&]{e.Stop(2);assert(e.Stopped(2)==Result::Pending);};
            if(step==0)p.on_open=stop;else if(step==1)p.on_read=stop;else p.on_close=stop;
            e.Pump(0);e.Pump(1);e.Pump(2);
            assert(e.Stopped(2)==Result::Done&&!e.Take(1,t,out)&&p.closed==1);
        }
    }
    { // Cleanup failure retains ownership, requires explicit retry, no success.
        Port p;p.close_ok=false;CameraEngine e(p);e.AllowCapture(true);auto t=e.Begin(1,0);
        CameraPicture out;e.Pump(0);e.Pump(1);e.Pump(2);
        assert(e.status().phase==CameraPhase::Fault&&!e.Take(1,t,out)&&!e.Begin(2,3));
        e.Pump(3);assert(p.closed==1);e.Stop(2);e.Pump(4);assert(e.Stopped(2)==Result::Failed);
        p.close_ok=true;e.Stop(3);e.Pump(5);assert(e.Stopped(3)==Result::Done&&p.closed==3);
    }
    { // A blocked I/O thread cannot publish after permission is revoked.
        Port p;CameraEngine e(p);e.AllowCapture(true);auto t=e.Begin(1,0);e.Pump(0);
        std::mutex m;std::condition_variable cv;bool entered=false,resume=false;
        p.on_read=[&]{std::unique_lock<std::mutex> lock(m);entered=true;cv.notify_all();cv.wait(lock,[&]{return resume;});};
        std::thread worker([&]{e.Pump(1);});
        {std::unique_lock<std::mutex> lock(m);cv.wait(lock,[&]{return entered;});}
        e.AllowCapture(false);assert(e.status().phase==CameraPhase::Closing&&!e.status().result_ready);
        e.AllowCapture(true);assert(!e.Begin(1,2));
        {std::lock_guard<std::mutex> lock(m);resume=true;cv.notify_all();}worker.join();
        CameraPicture out;assert(!e.Take(1,t,out));e.Pump(3);assert(e.status().phase==CameraPhase::Idle);
        auto next=e.Begin(1,4);assert(next>t); // New photo in the same audio session.
        e.Stop(2);e.Pump(4);assert(e.Stopped(2)==Result::Done&&!e.Begin(2,5));
    }
    { // Stop discards even a result already waiting for the transport.
        Port p;CameraEngine e(p);e.AllowCapture(true);auto t=e.Begin(1,0);CameraPicture out;
        e.Pump(0);e.Pump(1);e.Pump(2);assert(e.status().result_ready);
        e.Stop(2);assert(!e.Take(1,t,out)&&!e.status().result_ready&&e.Stopped(2)==Result::Done);
    }
    std::puts("camera engine: permission, bounded result, correlation, errors, timeout, cancellation and close retry passed");
}
