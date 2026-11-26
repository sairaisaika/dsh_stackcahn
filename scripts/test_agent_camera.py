"""Compile the actual ESP camera adapter against a fault-injectable SDK seam. No hardware."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='sion-camera-sdk-') as directory:
    include = Path(directory)
    (include/'camera_sdk.h').write_text(r'''#pragma once
#include <cstddef>
#include <cstdint>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <unistd.h>
constexpr int ESP_OK=0,ESP_VIDEO_INIT_FLAGS_DVP=2;
constexpr int MALLOC_CAP_SPIRAM=1,MALLOC_CAP_8BIT=2;
constexpr const char* ESP_VIDEO_DVP_DEVICE_NAME="/dev/video0";
constexpr int V4L2_BUF_TYPE_VIDEO_CAPTURE=1,V4L2_MEMORY_MMAP=1,V4L2_PIX_FMT_YUYV=99;
enum {VIDIOC_S_DQBUF_TIMEOUT=100,VIDIOC_S_FMT,VIDIOC_G_FMT,VIDIOC_REQBUFS,
      VIDIOC_QUERYBUF,VIDIOC_QBUF,VIDIOC_STREAMON,VIDIOC_DQBUF,VIDIOC_STREAMOFF};
struct v4l2_pix_format {unsigned width=0,height=0,pixelformat=0,bytesperline=0,sizeimage=0;};
struct v4l2_format {int type=0;struct {v4l2_pix_format pix;} fmt;};
struct v4l2_buffer {unsigned type=0,memory=0,index=0,length=0,bytesused=0;struct {unsigned offset=0;}m;};
struct v4l2_requestbuffers {unsigned type=0,memory=0,count=0;};
constexpr int JPEG_ERR_OK=0,JPEG_PIXEL_FORMAT_YCbYCr=1,JPEG_SUBSAMPLE_420=2;
struct jpeg_enc_config_t {int width=0,height=0,src_type=0,subsampling=0,quality=0;bool task_enable=true;};
#define DEFAULT_JPEG_ENC_CONFIG() jpeg_enc_config_t{}
void* heap_caps_aligned_alloc(size_t,size_t,int);
void heap_caps_free(void*);
int esp_video_deinit_with_flags(unsigned);
int jpeg_enc_open(jpeg_enc_config_t*,void**);
int jpeg_enc_process(void*,const uint8_t*,int,uint8_t*,int,int*);
int jpeg_enc_close(void*);
int camera_open(const char*,int);
int camera_ioctl(int,int,void*);
void* camera_mmap(void*,size_t,int,int,int,off_t);
int camera_munmap(void*,size_t);
int camera_close(int);
// Include real POSIX declarations above before replacing call sites.
#define open camera_open
#define ioctl camera_ioctl
#define mmap camera_mmap
#define munmap camera_munmap
#define close camera_close
''')
    for name in ('esp_video_init.h','esp_video_device.h','esp_video_ioctl.h','esp_jpeg_enc.h','esp_heap_caps.h'):
        (include/name).write_text('#include "camera_sdk.h"\n')
    (include/'freertos').mkdir()
    (include/'freertos/FreeRTOS.h').write_text('''#pragma once
#include <cstdint>
using TickType_t=uint32_t;using TaskHandle_t=void*;
constexpr int pdPASS=1;
inline TickType_t pdMS_TO_TICKS(unsigned ms){return ms/10;}
''')
    (include/'freertos/task.h').write_text('''#pragma once
#include "FreeRTOS.h"
int xTaskCreate(void(*)(void*),const char*,unsigned,void*,unsigned,TaskHandle_t*);
void vTaskDelay(TickType_t);
''')
    (include/'esp_timer.h').write_text('#pragma once\n#include <cstdint>\nint64_t esp_timer_get_time();\n')
    binary=include/'camera-test'
    subprocess.run(['clang++','-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-g','-pthread','-DESP_PLATFORM',
                    '-I'+str(include),str(root/'firmware/agent/camera_port.cc'),
                    str(root/'firmware/agent/camera_port_test.cc'),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True,timeout=20)
    worker=include/'camera-worker-test'
    # Only this scheduler fixture replaces EspCameraPort's methods; unused SDK
    # fields are expected here. The actual adapter above keeps all warnings fatal.
    subprocess.run(['clang++','-std=c++17','-Wall','-Wextra','-Werror',
                    '-Wno-unused-private-field',
                    '-fsanitize=address,undefined','-g','-pthread','-DESP_PLATFORM',
                    '-I'+str(include),str(root/'firmware/agent/camera_runtime_test.cc'),'-o',str(worker)],check=True)
    subprocess.run([str(worker)],check=True,timeout=20)
