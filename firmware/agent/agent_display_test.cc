#include "agent_display.h"
#include "direct_frames.h"
#include "device_trace.h"
#include <algorithm>
#include <iostream>

const lv_font_t default_font{},chinese_font{nullptr,20};
std::vector<std::string> calls;
std::string fail_at;
bool locked=false;
lvgl_port_display_cfg_t last_config{};
lvgl_port_cfg_t last_port{};
const lv_font_t* selected_font=nullptr;
size_t cache_size=0,psram_size=8*1024*1024;
int offset_x=0,offset_y=0,on_result=ESP_OK;
bool last_chunk=false;
unsigned flush_ready_calls=0;
ColorDone color_done=nullptr;
void* color_context=nullptr;
FlushStart flush_start=nullptr;
void* flush_context=nullptr;
int invalidation_enabled=0,screen_invalidated=0,notified=0;
void (*worker_fn)(void*)=nullptr;
using sion::agent::AgentDisplay;
namespace trace = sion::agent::diagnostics;
static std::vector<std::pair<trace::Event,uint32_t>> transfers;
void trace::Record(trace::Lane lane,trace::Event event,uint32_t detail){
    assert((event==Event::PageFlushStarted&&lane==Lane::Lvgl)||(event==Event::PageFlushCompleted&&lane==Lane::Lcd));
    transfers.emplace_back(event,detail);
}
void reset(){calls.clear();fail_at.clear();locked=false;cache_size=0;on_result=ESP_OK;}
int main(){
    void* io=reinterpret_cast<void*>(1);void* panel=reinterpret_cast<void*>(2);
    {
        AgentDisplay display(io,panel,320,240,3,4,true,false,true);
        assert(display.GetLvglDisplay());
        assert(std::count(calls.begin(),calls.end(),"draw")==240);
        assert(last_config.io_handle==io&&last_config.panel_handle==panel);
        assert(last_config.hres==320&&last_config.vres==240&&last_config.buffer_size==6400);
        assert(last_config.rotation.mirror_x&&!last_config.rotation.mirror_y&&last_config.rotation.swap_xy);
        assert(last_config.flags.buff_dma&&last_config.flags.swap_bytes&&!last_config.double_buffer);
        assert(!last_config.flags.buff_spiram&&!last_config.flags.full_refresh&&!last_config.flags.direct_mode);
        assert(last_config.color_format==LV_COLOR_FORMAT_RGB565&&last_port.task_priority==3&&last_port.task_affinity==1);
        assert(cache_size==2*1024*1024&&offset_x==3&&offset_y==4&&!locked);
        assert(selected_font->line_height==default_font.line_height&&selected_font->fallback==&chinese_font);
        display.LvglLock();assert(locked);display.LvglUnlock();

        lv_event_t event{flush_context};
        trace::SetPageForFlush(7);
        flush_start(&event); // First strip; the last strip claims the page.
        assert(transfers.empty()&&!color_done(io,nullptr,color_context)&&flush_ready_calls==1);
        last_chunk=true;
        flush_start(&event);
        assert(transfers.size()==1&&transfers.back()==std::make_pair(trace::Event::PageFlushStarted,7u));
        trace::SetPageForFlush(8); // A newer page cannot confirm an older in-flight transfer.
        assert(!color_done(io,nullptr,color_context)&&flush_ready_calls==2);
        assert(transfers.size()==2&&transfers.back()==std::make_pair(trace::Event::PageFlushCompleted,7u));
        flush_start(&event);
        assert(!color_done(io,nullptr,color_context)&&flush_ready_calls==3);
        assert(transfers.size()==4&&transfers.back()==std::make_pair(trace::Event::PageFlushCompleted,8u));
        assert(!color_done(io,nullptr,color_context)&&flush_ready_calls==4&&transfers.size()==4);
        // Direct frames: LVGL stops drawing (pending areas dropped) while frames go straight to the
        // panel, then draws the whole screen again. The worker task is created once, not run here.
        display.GetLvglDisplay()->inv_p=3;
        display.LvglLock();assert(sion::agent::DirectFramesBegin()&&sion::agent::DirectFramesBegin());display.LvglUnlock();
        assert(invalidation_enabled==-1&&display.GetLvglDisplay()->inv_p==0&&worker_fn);
        static uint8_t pixels[320*30*2];
        sion::agent::DirectFramesShow(pixels,320,30,0,0);
        assert(notified==1);
        display.LvglLock();sion::agent::DirectFramesEnd();sion::agent::DirectFramesEnd();display.LvglUnlock();
        assert(invalidation_enabled==0&&screen_invalidated==1);
        sion::agent::DirectFramesShow(pixels,320,30,0,0);   // After End a request is not taken.
        assert(!color_done(io,nullptr,color_context)&&flush_ready_calls==5);   // LVGL's flushes are LVGL's again.
    }
    assert(calls[calls.size()-3]=="remove"&&calls.back()=="deinit"&&!color_done);
    // ESP_ERROR_CHECK aborts on target. Here the seam throws to observe that no
    // later display/theme publication follows a failure; no recovery is claimed.
    for(const auto* failure:{"draw","port","display","lock","theme"}){
        reset();fail_at=failure;bool failed=false;
        try{AgentDisplay display(io,panel,320,240,0,0,false,false,false);}catch(int){failed=true;}
        assert(failed&&calls.back()==failure);
        assert(std::find(calls.begin(),calls.end(),"set-theme")==calls.end());
    }
    reset();on_result=ESP_ERR_NO_MEM;
    try{AgentDisplay display(io,panel,320,240,0,0,false,false,false);assert(false);}catch(int){assert(calls.back()=="on");}
    reset();
    try{AgentDisplay display(nullptr,panel,320,240,0,0,false,false,false);assert(false);}catch(int){assert(calls.empty());}
    for(size_t memory:{size_t(0),size_t(2*1024*1024)}){
        reset();psram_size=memory;on_result=ESP_ERR_NOT_SUPPORTED;
        AgentDisplay display(io,panel,320,240,0,0,false,false,false);
        assert(cache_size==(memory?512*1024:0));
    }
    std::cout<<"Actual AgentDisplay: geometry, RGB565/DMA, font fallback, lock, teardown and 7 init failures passed; SDK seam, no display hardware\n";
    std::cout<<"Actual AgentDisplay callbacks: final strip only, SPI acknowledgement and overlapping page changes passed\n";
}
