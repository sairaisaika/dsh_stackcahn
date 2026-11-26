// SPDX-License-Identifier: MIT
#include "agent_network_queue.h"
#include <cassert>
#include <iostream>
#include <thread>
using namespace sion::agent;
int main() {
    AgentNetworkQueue q;NetworkEvent event;const uint8_t data[]={1,2,3,4};
    auto begin=[&]{auto g=q.Begin();assert(g&&q.Connected(g));assert(q.Poll(g,event)&&event.kind==NetworkEventKind::Connected);return g;};
    auto closed=[&](uint64_t g){assert(q.Closing(g));assert(q.Poll(g,event)&&event.kind==NetworkEventKind::Closed);assert(!q.Poll(g,event));assert(!q.Begin());q.Finish(g);};
    auto g=begin();
    // Two SDK chunks inside an unfinished RFC frame, then a continuation frame.
    assert(q.Receive(g,2,false,3,0,data,1,100));assert(!q.Poll(g,event));
    assert(q.Receive(g,2,false,3,1,data+1,2,101));assert(!q.Poll(g,event));
    assert(q.Receive(g,0,true,1,0,data+3,1,102));assert(q.Poll(g,event));
    assert(event.kind==NetworkEventKind::Binary&&event.bytes==std::vector<uint8_t>({1,2,3,4}));
    assert(q.Send(g,NetworkEventKind::Text,data,4));q.Close(g);
    assert(!q.TakeOutput(g,event)&&!q.Connected(g));closed(g);
    const auto old=g;g=begin();q.Close(old);q.Finish(old);
    assert(!q.Receive(old,1,true,1,0,data,1,0)&&!q.Closing(g));
    q.Close(g);closed(g);
    // Offset gaps, opcode/FIN changes, malformed lengths and null pointers fail closed.
    for(int bad=0;bad<8;++bad) {
        g=begin();assert(q.Receive(g,1,true,4,0,data,1,10));
        const bool accepted=q.Receive(g,bad==0?2:1,bad!=1,bad==2?5:4,bad==3?2:1,
            bad==4?nullptr:data,bad==5?-1:bad==6?4:1,bad==7?5010:11);
        assert(!accepted);closed(g);
    }
    g=begin();assert(!q.Receive(g,0,true,1,0,data,1,0));closed(g);
    g=begin();assert(!q.Receive(g,1,true,2049,0,data,1,0));closed(g);
    g=begin();assert(q.Receive(g,1,false,0,0,nullptr,0,0));
    for(int i=1;i<32;++i)assert(q.Receive(g,0,false,0,0,nullptr,0,i));
    assert(!q.Receive(g,0,true,0,0,nullptr,0,33));closed(g);
    g=begin();for(int i=0;i<64;++i)assert(q.Receive(g,1,true,65,i,data,1,i));
    assert(!q.Receive(g,1,true,65,64,data,1,64));closed(g);
    g=begin();assert(q.Receive(g,1,false,1,0,data,1,10));q.Expire(g,5009);assert(!q.Closing(g));
    q.Expire(g,5010);closed(g);
    g=begin();for(size_t i=0;i<AgentNetworkQueue::MaxMessages;++i)assert(q.Receive(g,1,true,1,0,data,1,i));
    assert(!q.Receive(g,1,true,1,0,data,1,30));closed(g);
    const std::vector<uint8_t> full(2048,42);
    g=begin();for(int i=0;i<16;++i)assert(q.Receive(g,2,true,2048,0,full.data(),2048,i));
    assert(!q.Receive(g,1,true,1,0,data,1,30));closed(g);
    g=begin();for(int i=0;i<16;++i)assert(q.Send(g,NetworkEventKind::Binary,full.data(),full.size()));
    assert(!q.Send(g,NetworkEventKind::Text,data,1));closed(g);
    g=begin();for(int i=0;i<16;++i)assert(q.CameraText(g,"photo"));
    assert(!q.CameraText(g,"photo")&&!q.Closing(g));
    for(int i=0;i<8;++i)assert(q.Send(g,NetworkEventKind::Binary,data,4));
    assert(q.TakeOutput(g,event));assert(!q.CameraText(g,"photo")&&!q.Closing(g));
    q.Close(g);closed(g);
    g=begin();for(int i=0;i<12;++i)assert(q.CameraText(g,std::string(2048,'x')));
    assert(!q.CameraText(g,"photo")&&!q.Closing(g));
    for(int i=0;i<4;++i)assert(q.Send(g,NetworkEventKind::Binary,full.data(),full.size()));
    q.Close(g);closed(g);
    // Capture yields at the control reserve and resumes as soon as the peer drains.
    const std::vector<uint8_t> capture(992,7);
    g=q.Begin();assert(g&&!q.Congested(g)&&q.Connected(g));
    for(int i=0;i<16;++i){assert(!q.Congested(g));assert(q.Send(g,NetworkEventKind::Binary,capture.data(),capture.size()));}
    assert(q.Congested(g)&&!q.Closing(g));
    for(int i=0;i<8;++i)assert(q.Send(g,NetworkEventKind::Text,data,1)); // Control still fits.
    assert(q.TakeOutput(g,event)&&q.Congested(g));
    for(int i=0;i<8;++i)assert(q.TakeOutput(g,event));
    assert(!q.Congested(g)&&!q.Closing(g)&&!q.Congested(g+1));
    q.Close(g);assert(!q.Congested(g));closed(g);
    // A callback racing Stop cannot repopulate a closed or subsequent connection.
    for(int run=0;run<100;++run) {
        g=begin();const auto captured=g;
        std::thread callback([&]{for(int i=0;i<100;++i)q.Receive(captured,1,true,1,0,data,1,i);});
        q.Close(g);callback.join();assert(!q.TakeOutput(g,event));closed(g);
    }
    std::cout<<"Network mailbox: fragmented/chunked frames, limits, expiry, cancellation and stale generation races passed\n";
}
