// SPDX-License-Identifier: MIT
#include "ina226.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
using namespace sion::agent;
struct Bus {
    std::array<uint16_t,256> regs{};
    bool open=false,fail=false;int opens=0,closes=0;std::vector<uint8_t> writes;
    bool Open(){++opens;open=true;return true;}
    bool Close(){++closes;open=false;return true;}
    bool Read(uint8_t reg,uint8_t* out,size_t n){assert(open&&n==2);if(fail)return false;out[0]=regs[reg]>>8;out[1]=regs[reg];return true;}
};
int main() {
    Bus bus;Ina226Monitor<Bus> monitor(bus);
    monitor.Pump(0);assert(!monitor.Latest(0).valid&&monitor.OpenFailures()==1&&!bus.open);   // Wrong chip: closed.
    bus.regs[0xfe]=0x5449;bus.regs[0xff]=0x2260;bus.regs[0x02]=3200;bus.regs[0x01]=0xfff0;   // 4.0 V, -16 raw.
    monitor.Pump(10);assert(!monitor.Latest(10).valid);                                     // Waits before reopening.
    monitor.Pump(5000);
    auto s=monitor.Latest(5000);assert(s.valid&&s.bus_raw==3200&&s.shunt_raw==-16);
    assert(!monitor.Latest(6000).valid);                                                    // Stale after 1 s.
    bus.fail=true;for(uint64_t t=5100;t<=6100;t+=100)monitor.Pump(t);
    assert(!bus.open&&bus.closes==2);                                                       // Ten failed reads: closed.
    bus.fail=false;monitor.Pump(11100);monitor.Pump(11100);assert(monitor.Latest(11100).valid);
    std::puts("INA226 monitor: identity check, read-only sampling, staleness and reopen passed");
}
