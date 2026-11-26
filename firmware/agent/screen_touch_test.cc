// SPDX-License-Identifier: MIT
#include "screen_touch.h"
#include <cassert>
#include <cstdio>
using namespace sion::agent;
int main() {
    ScreenTouchLog log;ScreenTouchEvent e;
    assert(!log.Take(e));
    log.Note(false,0,0,0);assert(!log.Take(e));                         // Release without a press: nothing.
    log.Note(true,100,50,10);
    log.Note(true,104,52,20);                                           // Small and soon: thinned.
    log.Note(true,100,50,200);                                          // Back at the last point: nothing new.
    log.Note(true,120,60,210);                                          // Far enough: a move.
    log.Note(true,121,60,400);                                          // Small but late: a move.
    log.Note(false,0,0,420);
    assert(log.Take(e)&&e.phase==ScreenTouchEvent::Down&&e.x==100&&e.y==50&&e.at==10);
    assert(log.Take(e)&&e.phase==ScreenTouchEvent::Move&&e.x==120&&e.y==60);
    assert(log.Take(e)&&e.phase==ScreenTouchEvent::Move&&e.x==121);
    assert(log.Take(e)&&e.phase==ScreenTouchEvent::Up&&e.x==121&&e.y==60&&e.at==420);
    assert(!log.Take(e));
    for(int i=0;i<40;++i){log.Note(true,i*20,0,1000+i*200);}            // Bounded: oldest dropped, counted.
    unsigned n=0;while(log.Take(e))++n;
    assert(n==16&&log.Dropped()==40-16);
    log.Note(false,0,0,9000);log.Clear();assert(!log.Take(e));
    std::puts("Screen touch log: down/move/up, thinning, bounded queue and clear passed");
}
