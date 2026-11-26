// SPDX-License-Identifier: MIT
#include "agent_usb_frames.h"
#include <cassert>
#include <iostream>
#include <string_view>
using namespace sion::agent;

int main() {
    UsbPreambleReader open;
    UsbPreambleReader<UsbStandbyProbe> probe;
    unsigned matches=0,probes=0;
    for(char byte:std::string_view("xSIONU1\nSIONU2\nSIONU1!\nxSIONU0\nSIONU0!\n\nSIONU0\n\nSIONU1\n")) {
        matches+=open.Feed(byte);
        probes+=probe.Feed(byte);
    }
    assert(matches==1);
    assert(probes==1);

    const uint8_t messages[]{1,0,3,'a','b','c',UsbKeepalive,0,1,0,2,0,1,0x42};
    UsbFrameReader reader;
    std::vector<std::pair<uint8_t,std::vector<uint8_t>>> parsed;
    auto receive=[&](uint8_t type,const uint8_t* bytes,size_t size) {
        parsed.push_back({type,{bytes,bytes+size}});return true;
    };
    assert(reader.Feed(messages,1,100,receive));
    assert(reader.Feed(messages+1,2,102,receive));
    assert(parsed.empty());
    assert(reader.Feed(messages+3,sizeof(messages)-3,105,receive));
    assert((parsed==std::vector<std::pair<uint8_t,std::vector<uint8_t>>>{{1,{'a','b','c'}},{3,{0}},{2,{0x42}}}));
    assert(!reader.Expired(10000));
    assert(reader.Feed(messages,2,10000,receive));
    assert(!reader.Expired(14999));assert(reader.Expired(15000));
    assert(!reader.Feed(messages+2,1,15000,receive));

    for(const auto invalid:std::array<std::array<uint8_t,3>,4>{{{0,0,1},{1,0,0},{2,8,1},{3,0,2}}}) {
        UsbFrameReader reject;
        assert(!reject.Feed(invalid.data(),invalid.size(),20,receive));
    }
    UsbFrameReader blocked;
    assert(!blocked.Feed(messages,sizeof(messages),20,[](uint8_t,const uint8_t*,size_t){return false;}));
    std::cout<<"USB preamble and bounded TLS message framing passed\n";
}
