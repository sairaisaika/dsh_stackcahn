// SPDX-License-Identifier: MIT
// Official DVP/V4L2 and JPEG APIs; no Xiaozhi camera, preview, sound or Explain.
#include "camera_port.h"
#include <esp_video_init.h>
#include <esp_video_device.h>
#include <esp_video_ioctl.h>
#include <esp_jpeg_enc.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>

// Defined by the prepared official board; it only initializes DVP using the
// board-owned I2C bus. It does not construct the original AI camera wrapper.
bool InitializeAgentCameraVideo();

namespace sion::agent {
namespace {
constexpr unsigned Width=640,Height=480;
constexpr size_t RawBytes=Width*Height*2;
v4l2_buffer FrameBuffer() {
    v4l2_buffer buffer{};
    buffer.type=V4L2_BUF_TYPE_VIDEO_CAPTURE;buffer.memory=V4L2_MEMORY_MMAP;
    return buffer;
}
}
bool EspCameraPort::Open() {
    if(poisoned_||initialized_||fd_>=0||encoder_||input_) return false;
    input_=AllocateCameraBuffer(RawBytes);
    if(!input_) return false;
    // esp_video_init internally attempts rollback, but drops rollback errors.
    // Failure therefore cannot prove resources are gone; do not retry globally.
    if(!InitializeAgentCameraVideo()) {poisoned_=true;return false;}
    initialized_=true;
    fd_=open(ESP_VIDEO_DVP_DEVICE_NAME,O_RDWR);
    if(fd_<0) return false;
    timeval timeout{};timeout.tv_usec=50000;
    if(ioctl(fd_,VIDIOC_S_DQBUF_TIMEOUT,&timeout)!=0) return false;
    v4l2_format format{};format.type=V4L2_BUF_TYPE_VIDEO_CAPTURE;
    format.fmt.pix.width=Width;format.fmt.pix.height=Height;
    format.fmt.pix.pixelformat=V4L2_PIX_FMT_YUYV;
    if(ioctl(fd_,VIDIOC_S_FMT,&format)!=0||ioctl(fd_,VIDIOC_G_FMT,&format)!=0) return false;
    if(format.fmt.pix.width!=Width||format.fmt.pix.height!=Height||
       format.fmt.pix.pixelformat!=V4L2_PIX_FMT_YUYV||
       (format.fmt.pix.bytesperline&&format.fmt.pix.bytesperline!=Width*2)||
       format.fmt.pix.sizeimage!=RawBytes) return false;
    v4l2_requestbuffers req{};req.type=V4L2_BUF_TYPE_VIDEO_CAPTURE;
    req.memory=V4L2_MEMORY_MMAP;req.count=1;
    if(ioctl(fd_,VIDIOC_REQBUFS,&req)!=0||req.count!=1) return false;
    auto buffer=FrameBuffer();
    if(ioctl(fd_,VIDIOC_QUERYBUF,&buffer)!=0||buffer.length!=RawBytes) return false;
    mapping_size_=buffer.length;
    mapping_=mmap(nullptr,mapping_size_,PROT_READ|PROT_WRITE,MAP_SHARED,fd_,buffer.m.offset);
    // Pinned ESP mmap returns NULL on error; also reject POSIX MAP_FAILED.
    if(!mapping_||mapping_==MAP_FAILED) {mapping_=nullptr;mapping_size_=0;return false;}
    if(ioctl(fd_,VIDIOC_QBUF,&buffer)!=0) return false;
    jpeg_enc_config_t config=DEFAULT_JPEG_ENC_CONFIG();
    config.width=Width;config.height=Height;config.src_type=JPEG_PIXEL_FORMAT_YCbYCr;
    config.subsampling=JPEG_SUBSAMPLE_420;config.quality=75;
    config.task_enable=false;
    if(jpeg_enc_open(&config,&encoder_)!=JPEG_ERR_OK||!encoder_) return false;
    int type=V4L2_BUF_TYPE_VIDEO_CAPTURE;
    // Upstream start rollback ignores some cleanup errors. If STREAMON fails,
    // keep a fault instead of freeing buffers potentially still owned by DMA.
    if(ioctl(fd_,VIDIOC_STREAMON,&type)!=0) {poisoned_=true;return false;}
    streaming_=true;discard_=2;
    return true;
}
Result EspCameraPort::Read(uint8_t* target,size_t capacity,CameraImageInfo& info) {
    info={};
    if(poisoned_||!streaming_||!encoder_||!mapping_||!input_||!target||
       capacity<4||capacity>kCameraMaxBytes) return Result::Failed;
    auto buffer=FrameBuffer();
    if(ioctl(fd_,VIDIOC_DQBUF,&buffer)!=0)
        return errno==ETIMEDOUT ? Result::Pending : Result::Failed;
    if(buffer.index!=0||buffer.bytesused!=RawBytes||buffer.bytesused>mapping_size_)
        return Result::Failed; // Close stops DMA before releasing its buffer.
    const bool discard=discard_!=0;
    if(discard) --discard_;
    else std::memcpy(input_.get(),mapping_,RawBytes);
    if(ioctl(fd_,VIDIOC_QBUF,&buffer)!=0) return Result::Failed;
    if(discard) return Result::Pending;
    int size=0;
    if(jpeg_enc_process(encoder_,input_.get(),int(RawBytes),target,int(capacity),&size)!=JPEG_ERR_OK||
       size<4||size>int(capacity)) return Result::Failed;
    info={size_t(size),Width,Height};
    return Result::Done;
}
bool EspCameraPort::Close() {
    if(poisoned_) return false;
    if(streaming_) {
        int type=V4L2_BUF_TYPE_VIDEO_CAPTURE;
        if(ioctl(fd_,VIDIOC_STREAMOFF,&type)!=0) {poisoned_=true;return false;}
        streaming_=false;
    }
    if(mapping_) {
        if(munmap(mapping_,mapping_size_)!=0) {poisoned_=true;return false;}
        mapping_=nullptr;mapping_size_=0;
    }
    if(fd_>=0) {
        const int fd=fd_;fd_=-1;
        // ESP VFS unregisters the descriptor even if device close fails. Retrying
        // that number could close an unrelated newly opened descriptor.
        if(close(fd)!=0) {poisoned_=true;return false;}
    }
    if(initialized_) {
        // Destroy is not transactionally retryable: SCCB/sensor can be freed
        // before a later failure. A failed call must not be issued again.
        if(esp_video_deinit_with_flags(ESP_VIDEO_INIT_FLAGS_DVP)!=ESP_OK) {poisoned_=true;return false;}
        initialized_=false;
    }
    if(encoder_) {
        auto handle=encoder_;encoder_=nullptr;
        if(jpeg_enc_close(handle)!=JPEG_ERR_OK) {poisoned_=true;return false;}
    }
    input_.reset();discard_=0;
    return true;
}
}
