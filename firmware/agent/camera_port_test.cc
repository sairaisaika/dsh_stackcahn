// SPDX-License-Identifier: MIT
#include "camera_port.h"
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
using namespace sion::agent;
namespace {
constexpr size_t Raw=640*480*2;
alignas(16) uint8_t raw[Raw];
int encoder;
struct Fake {
    std::string fail,variant;
    std::vector<std::string> calls;
    bool streaming=false,mapped=false,fd=false,initialized=false;
    int allocations=0,frees=0;
    bool Call(const char* name){calls.emplace_back(name);return fail!=name;}
} state;
}
void* heap_caps_aligned_alloc(size_t alignment,size_t size,int caps) {
    assert(alignment==16&&caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    if(!state.Call("allocate"))return nullptr;
    void* p=nullptr;assert(posix_memalign(&p,alignment,size)==0);++state.allocations;return p;
}
void heap_caps_free(void* p){if(p)++state.frees;free(p);}
bool InitializeAgentCameraVideo(){bool ok=state.Call("initialize");state.initialized=ok;return ok;}
int camera_open(const char* name,int mode){assert(!std::strcmp(name,ESP_VIDEO_DVP_DEVICE_NAME)&&mode==O_RDWR);if(!state.Call("open"))return -1;state.fd=true;return 19;}
int camera_ioctl(int fd,int command,void* value) {
    assert(fd==19&&state.fd);
    switch(command) {
        case VIDIOC_S_DQBUF_TIMEOUT: {
            auto& t=*static_cast<timeval*>(value);assert(t.tv_sec==0&&t.tv_usec==50000);
            return state.Call("timeout")?0:-1;
        }
        case VIDIOC_S_FMT: {
            auto& f=*static_cast<v4l2_format*>(value);
            assert(f.fmt.pix.width==640&&f.fmt.pix.height==480&&f.fmt.pix.pixelformat==V4L2_PIX_FMT_YUYV);
            return state.Call("set-format")?0:-1;
        }
        case VIDIOC_G_FMT: {
            auto& f=*static_cast<v4l2_format*>(value);
            f.fmt.pix.bytesperline=state.variant=="stride"?1282:1280;
            f.fmt.pix.sizeimage=state.variant=="size"?Raw+1:Raw;
            if(state.variant=="dimensions")f.fmt.pix.width=320;
            return state.Call("get-format")?0:-1;
        }
        case VIDIOC_REQBUFS: {
            auto& r=*static_cast<v4l2_requestbuffers*>(value);assert(r.count==1&&r.memory==V4L2_MEMORY_MMAP);
            if(state.variant=="count")r.count=2;
            return state.Call("request")?0:-1;
        }
        case VIDIOC_QUERYBUF: {
            auto& b=*static_cast<v4l2_buffer*>(value);assert(b.index==0);
            b.length=state.variant=="length"?Raw+1:Raw;return state.Call("query")?0:-1;
        }
        case VIDIOC_QBUF:return state.Call("queue")?0:-1;
        case VIDIOC_STREAMON:if(!state.Call("start"))return -1;state.streaming=true;return 0;
        case VIDIOC_STREAMOFF:if(!state.Call("stop"))return -1;state.streaming=false;return 0;
        case VIDIOC_DQBUF: {
            assert(state.streaming);if(!state.Call("dequeue")){errno=EIO;return -1;}
            if(state.variant=="timeout"){errno=ETIMEDOUT;return -1;}
            auto& b=*static_cast<v4l2_buffer*>(value);b.index=state.variant=="index"?1:0;
            b.bytesused=state.variant=="short"?Raw-1:Raw;
            return 0;
        }
    }
    std::abort();
}
void* camera_mmap(void*,size_t size,int,int,int fd,off_t) {
    assert(size==Raw&&fd==19);if(!state.Call("map"))return nullptr;
    if(state.variant=="map-failed")return MAP_FAILED;
    state.mapped=true;return raw;
}
int camera_munmap(void* p,size_t size) {
    assert(p==raw&&size==Raw&&!state.streaming);
    if(!state.Call("unmap"))return -1;state.mapped=false;return 0;
}
int camera_close(int fd) {
    assert(fd==19&&state.fd&&!state.streaming&&!state.mapped);
    state.fd=false;return state.Call("close")?0:-1;
}
int esp_video_deinit_with_flags(unsigned flags) {
    assert(flags==ESP_VIDEO_INIT_FLAGS_DVP&&!state.fd&&!state.streaming);
    if(!state.Call("deinitialize"))return -1;state.initialized=false;return 0;
}
int jpeg_enc_open(jpeg_enc_config_t* config,void** h) {
    assert(config->width==640&&config->height==480&&!config->task_enable&&config->quality==75);
    assert(config->src_type==JPEG_PIXEL_FORMAT_YCbYCr&&config->subsampling==JPEG_SUBSAMPLE_420);
    *h=&encoder;return state.Call("encoder-open")?0:-1; // partial allocation on failure
}
int jpeg_enc_process(void* h,const uint8_t* input,int size,uint8_t* out,int cap,int* used) {
    assert(h==&encoder&&size==int(Raw)&&input!=raw&&reinterpret_cast<uintptr_t>(input)%16==0);
    assert(cap>3&&std::memcmp(input,raw,Raw)==0);
    if(!state.Call("encode"))return -1;
    out[0]=0xff;out[1]=0xd8;out[2]=0xff;out[3]=0xd9;
    *used=state.variant=="overflow"?cap+1:4;return 0;
}
int jpeg_enc_close(void* h){assert(h==&encoder);return state.Call("encoder-close")?0:-1;}
int main() {
    std::memset(raw,0x42,Raw);
    { // Engine allocation failure never reaches the driver or board.
        state={};state.fail="allocate";EspCameraPort port;CameraEngine engine(port);
        engine.AllowCapture(true);auto ticket=engine.Begin(1,0);CameraPicture image;
        engine.Pump(0);engine.Pump(1);
        assert(engine.Take(1,ticket,image)&&image.error==CameraError::Memory&&!image.jpeg);
        assert(state.calls.size()==1&&state.calls[0]=="allocate");
    }
    { // Actual adapter + engine, aligned PSRAM seam, two discarded frames.
        state={};EspCameraPort port;CameraEngine engine(port);engine.AllowCapture(true);
        auto ticket=engine.Begin(1,0);CameraPicture image;
        for(int t=0;t<4;++t){engine.Pump(t);assert(!engine.Take(1,ticket,image));}
        engine.Pump(4);
        assert(engine.Take(1,ticket,image)&&image.error==CameraError::None&&image.info.width==640);
        assert(!state.streaming&&!state.fd&&!state.mapped&&!state.initialized);
        assert(state.allocations==2&&state.frees==1);image={};assert(state.frees==2);
        assert(engine.Begin(1,6));engine.Stop(2);engine.Pump(7);assert(engine.Stopped(2)==Result::Done);
    }
    for(const char* failure: {"allocate","open","timeout","set-format","get-format","request","query","map","queue","encoder-open"}) {
        state={};state.fail=failure;EspCameraPort port;assert(!port.Open());assert(port.Close());
        assert(!state.streaming&&!state.fd&&!state.mapped&&!state.initialized);
        assert(state.allocations==state.frees);
    }
    for(const char* variant: {"stride","size","dimensions","count","length","map-failed"}) {
        state={};state.variant=variant;EspCameraPort port;assert(!port.Open());assert(port.Close());
    }
    for(const char* variant: {"timeout","index","short","overflow"}) {
        state={};EspCameraPort port;assert(port.Open());uint8_t output[16];CameraImageInfo info;
        assert(port.Read(output,sizeof output,info)==Result::Pending);
        assert(port.Read(output,sizeof output,info)==Result::Pending);state.variant=variant;
        assert(port.Read(output,sizeof output,info)==(state.variant=="timeout"?Result::Pending:Result::Failed));
        assert(!info.size&&port.Close());
    }
    { // Invalid destination cannot dequeue or encode any frame.
        state={};EspCameraPort port;assert(port.Open());uint8_t out[4];CameraImageInfo info;
        auto count=state.calls.size();
        assert(port.Read(nullptr,4,info)==Result::Failed);
        assert(port.Read(out,3,info)==Result::Failed);
        assert(port.Read(out,kCameraMaxBytes+1,info)==Result::Failed);
        assert(state.calls.size()==count&&port.Close());
    }
    for(const char* failure: {"dequeue","queue","encode"}) {
        state={};EspCameraPort port;assert(port.Open());uint8_t output[16];CameraImageInfo info;
        port.Read(output,sizeof output,info);port.Read(output,sizeof output,info);state.fail=failure;
        assert(port.Read(output,sizeof output,info)==Result::Failed&&port.Close());
    }
    for(const char* failure: {"initialize","start","stop","unmap","close","deinitialize","encoder-close"}) {
        state={};EspCameraPort port;
        const bool opening=std::string(failure)=="initialize"||std::string(failure)=="start";
        if(opening)state.fail=failure;
        assert(port.Open()!=opening);state.fail=failure;
        assert(!port.Close());auto count=state.calls.size();state.fail.clear();
        assert(!port.Close()&&!port.Open()&&state.calls.size()==count); // cannot retry stale fd/partial destroy
    }
    { // Engine cannot turn a permanently uncertain driver teardown into idle.
        state={};EspCameraPort port;CameraEngine engine(port);engine.AllowCapture(true);
        engine.Begin(1,0);engine.Pump(0);state.fail="stop";
        engine.Stop(2);engine.Pump(1);assert(engine.Stopped(2)==Result::Failed);
        auto count=state.calls.size();state.fail.clear();engine.Stop(3);engine.Pump(2);
        assert(engine.Stopped(3)==Result::Failed&&state.calls.size()==count&&!engine.Begin(4,3));
    }
    std::puts("ESP camera adapter: PSRAM, format, discard, timeout, encoding, partial open and latched teardown fault cases passed; SDK seam only");
}
