"""Exercise the actual display adapter against an offline SDK seam; no hardware."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='sion-display-') as directory:
    out = Path(directory)
    (out/'display').mkdir()
    (out/'src/misc/cache').mkdir(parents=True)
    (out/'src/misc/cache/lv_cache.h').write_text('#include "sdk.h"\n')
    (out/'sdk.h').write_text(r'''#pragma once
#include <cstdint>
#include <cstddef>
#include <cassert>
#include <string>
#include <vector>
constexpr int ESP_OK=0,ESP_ERR_INVALID_ARG=1,ESP_ERR_NOT_SUPPORTED=2,ESP_ERR_NO_MEM=3,ESP_ERR_TIMEOUT=4;
inline void sdk_error_check(int error){if(error)throw error;}
#define ESP_ERROR_CHECK(call) sdk_error_check(call)
using esp_lcd_panel_io_handle_t=void*;using esp_lcd_panel_handle_t=void*;
struct esp_lcd_panel_io_event_data_t {};
using ColorDone=bool(*)(esp_lcd_panel_io_handle_t,esp_lcd_panel_io_event_data_t*,void*);
struct esp_lcd_panel_io_callbacks_t {ColorDone on_color_trans_done=nullptr;};
struct lv_event_t {void* context;};
using FlushStart=void(*)(lv_event_t*);
constexpr int LV_EVENT_FLUSH_START=1;
struct lv_font_t {const lv_font_t* fallback=nullptr;int line_height=14;};
extern const lv_font_t default_font,chinese_font;
#define LV_FONT_DEFAULT (&default_font)
#define LV_FONT_DECLARE(name) extern const lv_font_t name
struct lv_disp_t{volatile int flushing=0;uint32_t inv_p=0;};using lv_display_t=lv_disp_t;struct lv_obj_t{};struct lv_theme_t{};
constexpr int LV_COLOR_FORMAT_RGB565=16,LV_PALETTE_BLUE=1,LV_PALETTE_RED=2;
inline int lv_palette_main(int value){return value;}
struct lvgl_port_cfg_t {int task_priority=4,task_affinity=-1;};
#define ESP_LVGL_PORT_INIT_CONFIG() {}
struct lvgl_port_display_cfg_t {
 void* io_handle=nullptr;void* panel_handle=nullptr;void* control_handle=nullptr;
 uint32_t buffer_size=0;bool double_buffer=false;int trans_size=0,hres=0,vres=0;bool monochrome=false;
 struct {bool swap_xy=false,mirror_x=false,mirror_y=false;}rotation;
 int color_format=0;
 struct {int buff_dma=0,buff_spiram=0,sw_rotate=0,swap_bytes=0,full_refresh=0,direct_mode=0;}flags;
};
extern std::vector<std::string> calls;extern std::string fail_at;extern bool locked;
extern lvgl_port_display_cfg_t last_config;extern lvgl_port_cfg_t last_port;
extern const lv_font_t* selected_font;extern size_t cache_size,psram_size;
extern int offset_x,offset_y,on_result;
extern bool last_chunk;
extern unsigned flush_ready_calls;
extern ColorDone color_done;
extern void* color_context;
extern FlushStart flush_start;
extern void* flush_context;
inline bool step(const char* name){calls.emplace_back(name);return fail_at==name;}
inline int esp_lcd_panel_draw_bitmap(void*,int,int,int,int,const void*){return step("draw")?ESP_ERR_NO_MEM:ESP_OK;}
inline int esp_lcd_panel_disp_on_off(void*,bool on){assert(on);step("on");return on_result;}
inline int esp_lcd_panel_io_tx_param(void*,int cmd,const void* param,size_t len){assert(locked&&cmd==-1&&!param&&!len);step("fence");return ESP_OK;}
inline int esp_lcd_panel_io_register_event_callbacks(void*,const esp_lcd_panel_io_callbacks_t* cb,void* ctx){assert(locked);color_done=cb->on_color_trans_done;color_context=ctx;step("callback");return ESP_OK;}
inline void lv_init(){step("lv_init");}
inline size_t esp_psram_get_size(){return psram_size;}
inline void lv_image_cache_resize(size_t size,bool){cache_size=size;step("cache");}
inline int lvgl_port_init(const lvgl_port_cfg_t* p){last_port=*p;return step("port")?ESP_ERR_NO_MEM:ESP_OK;}
inline lv_disp_t* lvgl_port_add_disp(const lvgl_port_display_cfg_t* p){static lv_disp_t d;last_config=*p;return step("display")?nullptr:&d;}
inline bool lvgl_port_lock(uint32_t ms){assert(ms==30000);if(step("lock"))return false;locked=true;return true;}
inline void lvgl_port_unlock(){assert(locked);locked=false;step("unlock");}
inline void lv_display_set_offset(lv_disp_t*,int x,int y){assert(locked);offset_x=x;offset_y=y;step("offset");}
inline void lv_display_add_event_cb(lv_disp_t*,FlushStart cb,int filter,void* ctx){assert(locked&&filter==LV_EVENT_FLUSH_START);flush_start=cb;flush_context=ctx;}
inline void* lv_event_get_user_data(lv_event_t* event){return event->context;}
inline bool lv_display_flush_is_last(lv_disp_t*){return last_chunk;}
inline void lv_display_flush_ready(lv_disp_t*){++flush_ready_calls;}
inline lv_theme_t* lv_theme_default_init(lv_disp_t*,int,int,bool,const lv_font_t* f){assert(locked);selected_font=f;static lv_theme_t theme;return step("theme")?nullptr:&theme;}
inline void lv_display_set_theme(lv_disp_t*,lv_theme_t*){assert(locked);step("set-theme");}
inline int lvgl_port_remove_disp(lv_disp_t* d){assert(d&&locked&&!color_done);step("remove");return ESP_OK;}
inline int lvgl_port_deinit(){step("deinit");return ESP_OK;}
// Direct frames (direct_frames.h): the worker task is recorded, not run.
extern int invalidation_enabled,screen_invalidated,notified;extern void (*worker_fn)(void*);
inline void lv_display_enable_invalidation(lv_disp_t*,bool en){assert(locked);invalidation_enabled+=en?1:-1;}
inline lv_obj_t* lv_screen_active(){static lv_obj_t screen;return &screen;}
inline void lv_obj_invalidate(lv_obj_t*){assert(locked);++screen_invalidated;}
constexpr int MALLOC_CAP_DMA=1,MALLOC_CAP_INTERNAL=2;
inline void* heap_caps_malloc(size_t size,int){static std::vector<std::vector<uint8_t>> keep;keep.emplace_back(size);return keep.back().data();}
using BaseType_t=int;using TickType_t=uint32_t;using SemaphoreHandle_t=int*;using TaskHandle_t=int*;
constexpr int pdFALSE=0,pdTRUE=1,pdPASS=1;constexpr TickType_t portMAX_DELAY=~0u;
inline TickType_t pdMS_TO_TICKS(uint32_t ms){return ms;}
inline SemaphoreHandle_t xSemaphoreCreateCounting(int,int){static int c;return &c;}
inline SemaphoreHandle_t xSemaphoreCreateMutex(){static int m;return &m;}
inline int xSemaphoreTake(SemaphoreHandle_t s,TickType_t){if(*s>0)--*s;return pdTRUE;}
inline int xSemaphoreGive(SemaphoreHandle_t s){++*s;return pdTRUE;}
inline int xSemaphoreGiveFromISR(SemaphoreHandle_t s,BaseType_t* woken){++*s;*woken=pdTRUE;return pdTRUE;}
inline uint32_t ulTaskNotifyTake(int,TickType_t){return 1;}
inline void xTaskNotifyGive(TaskHandle_t){++notified;}
inline void vTaskDelay(TickType_t){}
inline int xTaskCreatePinnedToCore(void(*fn)(void*),const char*,int,void*,int,TaskHandle_t* t,int){static int task;worker_fn=fn;*t=&task;return pdPASS;}
''')
    (out/'display/display.h').write_text('''#pragma once
#include "sdk.h"
class Display {public: virtual ~Display()=default;protected:int width_=0,height_=0;
virtual bool Lock(int)=0;virtual void Unlock()=0;};
''')
    (out/'freertos').mkdir()
    (out/'src/display').mkdir(parents=True)
    for name in ('freertos/FreeRTOS.h','freertos/semphr.h','freertos/task.h','src/display/lv_display_private.h','esp_heap_caps.h'):
        (out/name).write_text('#include "sdk.h"\n' if '/' not in name else '#include "../sdk.h"\n' if name.count('/')==1 else '#include "../../sdk.h"\n')
    for name in ('esp_lcd_panel_io.h','esp_lcd_panel_ops.h','esp_err.h','esp_lvgl_port.h','esp_psram.h'):
        (out/name).write_text('#include "sdk.h"\n')
    target = out/'display-test'
    compiler = ['clang++','-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-g']
    trace = out/'trace.o'
    subprocess.run([*compiler,'-c',str(ROOT/'firmware/agent/device_trace.cc'),'-o',str(trace)],check=True)
    subprocess.run([*compiler,'-DESP_PLATFORM','-DCONFIG_SPIRAM=1','-DCONFIG_SOC_CPU_CORES_NUM=2','-DBUILTIN_TEXT_FONT=chinese_font',
                    '-I'+str(out),'-I'+str(ROOT/'firmware/agent'),
                    str(ROOT/'firmware/agent/agent_display.cc'),str(ROOT/'firmware/agent/agent_display_test.cc'),
                    str(trace),'-o',str(target)],check=True)
    subprocess.run([str(target)],check=True,timeout=20)
