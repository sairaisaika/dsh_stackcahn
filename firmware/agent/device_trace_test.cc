// SPDX-License-Identifier: MIT
#include "device_trace.h"
#include <cassert>
#include <fstream>
#include <iostream>

using namespace sion::agent::diagnostics;

void touch_cases(Book& book) {
    TouchInputTrace driver;
    LvglInputTrace lvgl;
    assert(driver.Sample(book, 10, true, false, 0, 0)==0);
    lvgl.Sample(book, 11, false, 0);
    for(uint16_t gesture=1;gesture<=9;++gesture) {
        const uint32_t ms=gesture*20;
        assert(driver.Sample(book,ms,true,true,40,148)==gesture);
        assert(driver.Sample(book,ms+1,true,true,42,149)==gesture); // Held sample does not emit a second Down.
        if(gesture>1)lvgl.Sample(book,ms+2,true,gesture);
        assert(driver.Sample(book,ms+3,true,false,0,0)==gesture);
        if(gesture>1)lvgl.Sample(book,ms+4,false,gesture);
        if(gesture<3)continue;
        Put(book,Lane::Actions,Event::UiActionQueued,ms+5,TracePair(gesture,gesture),false);
        if(gesture==3)continue;
        Put(book,Lane::Actions,Event::UiActionStarted,ms+6,TracePair(gesture,1),false);
        if(gesture==4)continue;
        if(gesture!=8)Put(book,Lane::Actions,gesture==9?Event::PageContentChanged:Event::PageBuildStart,
                          ms+7,TracePair(gesture,gesture),false);
        if(gesture==5)continue;
        if(gesture!=8)Put(book,Lane::Actions,Event::PageBuilt,ms+8,TracePair(gesture,2),false);
        Put(book,Lane::Actions,Event::UiActionFinished,ms+9,TracePair(gesture,gesture==8?1:2),false);
        if(gesture==8)continue;
        Put(book,Lane::Lvgl,Event::PageFlushStarted,ms+10,gesture,false);
        if(gesture==7||gesture==9)Put(book,Lane::Lcd,Event::PageFlushCompleted,ms+11,gesture,false);
    }
    driver.Sample(book,500,false,false,0,0);
    driver.Sample(book,510,false,false,0,0);
    driver.Sample(book,520,true,false,0,0);
    lvgl.Sample(book,2000,true,10);
    lvgl.Sample(book,2020,true,11); // The GUI missed the release between gestures.
    assert(lvgl.gesture()==10);
    lvgl.Sample(book,2040,false,11);
    assert(lvgl.gesture()==10);
    // A render after a newer revision was published does not claim the superseded revision.
    SetPageForFlush(10);
    SetPageForFlush(11);
    assert(TakePageForFlush()==11&&TakePageForFlush()==0);
    assert(NextTraceId(UINT16_MAX)==1);
}

int main(int argc, char** argv) {
    Book book{};
    Begin(book, 1, true);
    assert(book.boot == 1 && book.magic == Magic);
    for (unsigned i=0;i<35;++i) Put(book,Lane::Ui,Event::UiIntent,i,i,false);
    auto& ui=book.lanes[static_cast<unsigned>(Lane::Ui)];
    assert(ui.latest==35 && ui.entries[2].sequence==35);
    Put(book,Lane::Ui,Event::ResourceCheck,45,8,true);
    assert(ui.latest==35 && ui.checkpoint.sequence==1);
    Put(book,Lane::Usb,Event::UsbPumpExit,42,static_cast<unsigned>(UsbEnd::PeerQuiet),false);
    Put(book,Lane::Audio,Event::AudioClosing,43,0,true);
    Begin(book, 7, false);
    Put(book,Lane::Boot,Event::HalEntry,1,0,false);
    assert(book.boot==2 && ui.checkpoint.boot==1 && ui.latest==35);
    ui.entries[2].sequence=0; // A debugger can halt a writer mid-record.
    touch_cases(book);
    if(argc==2) {
        std::ofstream dump(argv[1],std::ios::binary);
        dump.write(reinterpret_cast<const char*>(&book),sizeof(book));
        assert(dump);
    }
    Begin(book,1,true);
    assert(book.boot==1 && ui.latest==0 && ui.checkpoint.sequence==0);
    std::cout<<"Device trace ring, checkpoints, incomplete entry and retained restart history passed\n";
}
