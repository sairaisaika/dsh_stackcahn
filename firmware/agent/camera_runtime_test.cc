// SPDX-License-Identifier: MIT
// Exercise the actual worker entry with a deterministic scheduler and fake port.
#include "camera_runtime.cc"
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <cstdio>
using namespace sion::agent;
namespace {
void(*entry)(void*)=nullptr;
bool create_ok=false,cancel_read=false;
int creates=0,opens=0,reads=0,closes=0,remaining=0,ticks=0;
struct Yielded {};
}
int xTaskCreate(void(*fn)(void*),const char* name,unsigned stack,void* arg,unsigned priority,TaskHandle_t* handle) {
    ++creates;assert(!std::strcmp(name,"sion_camera")&&stack==12288&&priority==1&&!arg);
    if(!create_ok)return 0;
    entry=fn;*handle=&creates;return pdPASS;
}
void vTaskDelay(TickType_t delay){assert(delay==1);++ticks;if(--remaining==0)throw Yielded{};}
int64_t esp_timer_get_time(){return int64_t(ticks)*10000;}
void* heap_caps_aligned_alloc(size_t align,size_t size,int caps){assert(align==16&&caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));void* p=nullptr;assert(!posix_memalign(&p,align,size));return p;}
void heap_caps_free(void* p){free(p);}
bool EspCameraPort::Open(){++opens;return true;}
Result EspCameraPort::Read(uint8_t* out,size_t cap,CameraImageInfo& info) {
    ++reads;assert(cap==kCameraMaxBytes);out[0]=0xff;out[1]=0xd8;out[2]=0xff;out[3]=0xd9;
    if(cancel_read)DeviceCamera().Stop(4);
    info={4,640,480};return Result::Done;
}
bool EspCameraPort::Close(){++closes;return true;}
void run(int count){remaining=count;try{entry(nullptr);assert(false);}catch(Yielded&) {}}
int main() {
    assert(!StartCameraWorker()&&creates==1&&!entry);
    create_ok=true;assert(StartCameraWorker()&&StartCameraWorker()&&creates==2);
    auto& e=DeviceCamera();run(2);assert(!e.status().allowed&&opens==0);
    e.AllowCapture(true);run(2);assert(opens==0); // permission alone never opens hardware
    auto ticket=e.Begin(1,ticks*10);assert(ticket);run(3);CameraPicture picture;
    assert(e.Take(1,ticket,picture)&&picture.jpeg&&opens==1&&reads==1&&closes==1);picture={};
    auto next=e.Begin(3,ticks*10);assert(next>ticket);cancel_read=true;run(3);
    assert(!e.Take(3,next,picture)&&e.Stopped(4)==Result::Done&&opens==2&&closes==2);
    e.AllowCapture(false);run(2);assert(!e.Begin(5,ticks*10)&&opens==2);
    std::puts("Actual camera worker: creation failure/retry, idempotence, no automatic capture, task pumping and cancellation passed; scheduler/port seam only");
}
