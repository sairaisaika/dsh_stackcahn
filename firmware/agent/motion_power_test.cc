// SPDX-License-Identifier: MIT
#include "motion_power.h"
#include <motion_sdk.h>
#include <array>
#include <cassert>
#include <iostream>
#include <vector>
struct i2c_bus {} bus;
struct i2c_dev {} device;
using namespace sion::agent;
namespace {
struct Fixture {
    bool attached=false,stuck_input=false,wrong_readback=false,apply_on_error=false;
    int fail=0,step=0,removes=0,delays=0;
    std::array<uint8_t,32> regs{},original{};
    std::vector<std::pair<uint8_t,uint8_t>> writes;
    Fixture(){regs.fill(0xa4);regs[2]=3;regs[3]=0xa4;regs[5]=0xa5;regs[7]=0xa5;original=regs;}
    bool Ok(){return ++step!=fail;}
} f;
void reset(){assert(!f.attached);f=Fixture{};}
void unrelated(){
    for(size_t i=0;i<f.regs.size();++i){
        if(i==3||i==5||i==7||i==9||i==11||i==19)assert((f.regs[i]&0xfe)==(f.original[i]&0xfe));
        else assert(f.regs[i]==f.original[i]);
    }
}
}
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t b,const i2c_device_config_t* c,i2c_master_dev_handle_t* out){
    assert(b==&bus&&!f.attached&&c->device_address==0x6f&&c->dev_addr_length==I2C_ADDR_BIT_LEN_7&&c->scl_speed_hz==100000);
    if(!f.Ok())return -1;f.attached=true;*out=&device;return ESP_OK;
}
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t d){
    assert(d==&device&&f.attached);++f.removes;if(!f.Ok())return -1;f.attached=false;return ESP_OK;
}
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t d,const uint8_t* reg,size_t n,uint8_t* out,size_t size,int timeout){
    assert(d==&device&&f.attached&&n==1&&size==1&&timeout==20&&*reg<32);
    if(!f.Ok())return -1;
    if(*reg==7&&!f.stuck_input)f.regs[7]=uint8_t((f.regs[7]&0xfe)|(f.regs[5]&1));
    *out=f.regs[*reg];if(f.wrong_readback&&*reg==5)*out^=1;return ESP_OK;
}
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t d,const uint8_t* bytes,size_t n,int timeout){
    assert(d==&device&&f.attached&&n==2&&timeout==20);
    const auto reg=bytes[0],value=bytes[1];
    assert(reg==3||reg==5||reg==9||reg==11||reg==19);
    assert((value&0xfe)==(f.regs[reg]&0xfe));
    f.writes.emplace_back(reg,value);
    const bool ok=f.Ok();if(ok||f.apply_on_error)f.regs[reg]=value;return ok?ESP_OK:-1;
}
void vTaskDelay(TickType_t ticks){assert(ticks==20);++f.delays;}
int main(){
    int open_steps=0,enable_steps=0,close_steps=0;
    {reset();EspServoPower p(&bus);assert(!p.Ready());assert(p.Open());open_steps=f.step;
        assert(!(f.regs[5]&1)&&!p.Ready()&&f.delays==0);assert(!p.Open());
        assert(p.Enable()&&p.Ready());enable_steps=f.step-open_steps;
        assert(!p.Enable()&&f.delays==1);const auto start=f.step;
        assert(p.Close()&&!f.attached&&!p.Ready());close_steps=f.step-start;
        assert(!(f.regs[5]&1));assert(p.Close());unrelated();}
    // Each actual I2C operation can fail before or after a write reaches the IC.
    for(bool applied:{false,true})for(int failure=2;failure<=open_steps;++failure){
        reset();f.fail=failure;f.apply_on_error=applied;EspServoPower p(&bus);
        assert(!p.Open()&&!p.Ready());assert(!p.Enable()&&!p.Open());
        f.fail=0;assert(p.Close()&&!f.attached);unrelated();
    }
    for(bool applied:{false,true})for(int failure=1;failure<=enable_steps;++failure){
        reset();EspServoPower p(&bus);assert(p.Open());f.fail=f.step+failure;f.apply_on_error=applied;
        const bool enabled=p.Enable();const bool ready=p.Ready();assert(!enabled||!ready);
        assert(!p.Enable());f.fail=0;assert(p.Close()&&!(f.regs[5]&1));unrelated();
    }
    for(bool applied:{false,true})for(int failure=1;failure<=close_steps;++failure){
        reset();EspServoPower p(&bus);assert(p.Open()&&p.Enable());f.fail=f.step+failure;f.apply_on_error=applied;
        assert(!p.Close()&&f.attached&&!p.Open()&&!p.Ready());
        f.fail=0;assert(p.Close()&&!f.attached&&!(f.regs[5]&1));unrelated();
    }
    for(int version:{0,255}){
        reset();f.regs[2]=version;EspServoPower p(&bus);
        assert(!p.Open()&&f.writes.empty());assert(p.Close()&&f.writes.empty());
    }
    {reset();EspServoPower p(nullptr);assert(!p.Open()&&p.Close()&&f.step==0);}
    {reset();EspServoPower a(&bus),b(&bus);assert(a.Open());const auto steps=f.step;
        assert(!b.Open()&&b.Close()&&f.step==steps);assert(a.Close());assert(b.Open()&&b.Close());}
    // Real Sion (v64 trace: power-enable/enable-readback x16): the PY32 input
    // bit of VM_EN reads low while the pin is driven high. Mode + latch decide.
    {reset();EspServoPower p(&bus);assert(p.Open());f.stuck_input=true;
        assert(p.Enable()&&p.Ready());f.stuck_input=false;assert(p.Close()&&!(f.regs[5]&1));}
    {reset();EspServoPower p(&bus);assert(p.Open()&&p.Enable());f.stuck_input=true;
        assert(!p.Close()&&f.attached);f.stuck_input=false;assert(p.Close());}
    {reset();EspServoPower p(&bus);assert(p.Open());f.wrong_readback=true;
        assert(!p.Enable());f.wrong_readback=false;assert(p.Close());}
    // Failed low-latch write must not force input -> output with old high data.
    {reset();f.fail=4;EspServoPower p(&bus);assert(!p.Open());
        assert(!(f.regs[3]&1));for(auto [reg,value]:f.writes){(void)value;assert(reg!=3);}
        f.fail=0;assert(p.Close());}
    // IDF add-device can discard a failed rollback result without returning a
    // handle. Keep uncertain allocation/lease latched until board restart.
    {reset();f.fail=1;EspServoPower p(&bus),other(&bus);
        assert(!p.Open()&&!p.Close()&&!p.Open()&&!p.Ready());
        assert(!other.Open()&&other.Close());assert(f.writes.empty()&&f.removes==0);}
    std::cout<<"PY32 power: "<<open_steps+enable_steps+close_steps
             <<" I2C failure boundaries; GPIO0 isolation, uncertain allocation latch and cleanup retry passed; no hardware\n";
}
