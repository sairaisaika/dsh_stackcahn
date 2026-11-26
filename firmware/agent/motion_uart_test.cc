// SPDX-License-Identifier: MIT
#include "motion_uart.h"
#include "motion_hardware.h"
#include "motion_runtime.h"
#include <functional>
#include <array>
#include <motion_sdk.h>
#include <cassert>
#include <cstring>
#include <deque>
#include <iostream>
#include <string>
#include <vector>
using namespace sion::agent;
struct i2c_bus {} power_bus;
struct i2c_dev {} power_device;
namespace hal_bridge {i2c_master_bus_handle_t board_get_i2c_bus(){return &power_bus;}}
namespace {
struct Fixture {
    bool installed=false,attached=false,require_power=false;
    bool power_high_error=false,power_low_error=false,remove_error=false;
    int power_on=0,goal_writes=0;
    std::array<uint8_t,32> power_regs{};
    std::vector<std::string> events;
    std::function<void()> on_enable_wait;

    int64_t now=1000;
    int fail=0,step=0,deletes=0,closes=0,resets=0,reads=0,writes=0;
    int yaw=460,pitch=620;
    bool short_write=false,read_error=false,no_reply=false,trickle=false;
    bool wait_error=false,flush_error=false,late=false,reverse=false,reset_error=false,delete_error=false;
    std::vector<unsigned char> tx;
    std::deque<unsigned char> rx;
    unsigned char regs[3][80]{};
    bool Ok(){return ++step!=fail;}
    Fixture(){
        power_regs[2]=3;
        for(int id=1;id<=2;++id){regs[id][11]=3;regs[id][12]=232;}
        regs[1][56]=1;regs[1][57]=204; // 460
        regs[2][56]=2;regs[2][57]=252; // 764 = 45 degrees
    }
} f;
struct Power:ServoPowerStatus {bool ready=true;bool Ready()override{return ready;}};
void reset(){assert(!f.installed&&!f.attached);f=Fixture{};}
void packet(){
    assert(f.tx.size()>=6&&f.tx[0]==255&&f.tx[1]==255);
    const int id=f.tx[2],length=f.tx[3],instruction=f.tx[4];
    assert(id>=1&&id<=2&&f.tx.size()==size_t(length+4));
    unsigned sum=0;for(size_t i=2;i<f.tx.size();++i)sum+=f.tx[i];assert((sum&255)==255);
    std::vector<unsigned char> payload;
    const int address=f.tx[5];
    if(instruction==2){const int n=f.tx[6];assert(address+n<=80);payload.assign(f.regs[id]+address,f.regs[id]+address+n);}
    else {assert(instruction==3);const int n=length-3;
        assert((address==40&&n==1)||(address==42&&n==6));
        if(address==42)++f.goal_writes;
        std::memcpy(f.regs[id]+address,f.tx.data()+6,n);
    }
    std::vector<unsigned char> response{255,255,(unsigned char)id,(unsigned char)(payload.size()+2),0};
    response.insert(response.end(),payload.begin(),payload.end());sum=0;
    for(size_t i=2;i<response.size();++i)sum+=response[i];response.push_back(~sum);
    if(!f.no_reply)f.rx.insert(f.rx.end(),response.begin(),response.end());
}
}
esp_err_t nvs_open_from_partition(const char* p,const char* ns,int mode,nvs_handle_t* out){
    assert(std::string(p)=="nvs"&&std::string(ns)=="servo"&&mode==NVS_READONLY);
    f.events.push_back("nvs.read");
    if(!f.Ok())return -1;*out=3;return ESP_OK;
}
esp_err_t nvs_get_i32(nvs_handle_t h,const char* key,int32_t* out){
    assert(h==3);if(!f.Ok())return -1;
    const std::string k=key;assert(k=="zero_pos_1"||k=="zero_pos_2");
    *out=k=="zero_pos_1"?f.yaw:f.pitch;return ESP_OK;
}
void nvs_close(nvs_handle_t h){assert(h==3);++f.closes;}
bool uart_is_driver_installed(int n){assert(n==1);return f.installed;}
esp_err_t uart_driver_install(int n,int rx,int tx,int q,void* handle,int flags){
    assert(n==1&&rx==256&&tx==0&&q==0&&!handle&&flags==0&&!f.installed);
    if(!f.Ok())return -1;f.installed=true;f.events.push_back("uart.install");return ESP_OK;
}
esp_err_t uart_driver_delete(int n){assert(n==1&&f.installed);++f.deletes;
    if(f.delete_error)return -1;f.installed=false;return ESP_OK;}
esp_err_t uart_param_config(int n,const uart_config_t* c){
    assert(n==1&&f.installed&&c->baud_rate==1000000&&c->data_bits==8&&c->parity==0&&c->stop_bits==1&&c->flow_ctrl==0);
    return f.Ok()?ESP_OK:-1;
}
esp_err_t uart_set_pin(int n,int tx,int rx,int rts,int cts){
    assert(n==1&&tx==6&&rx==7&&rts==-1&&cts==-1);return f.Ok()?ESP_OK:-1;
}
esp_err_t gpio_reset_pin(int pin){assert(pin==6||pin==7);++f.resets;return f.reset_error?-1:ESP_OK;}
int uart_tx_chars(int n,const char* data,uint32_t size){
    assert(n==1&&f.installed);++f.writes;
    assert(!f.require_power||(f.attached&&(f.power_regs[5]&1)));
    if(f.short_write)return size-1;
    f.tx.insert(f.tx.end(),data,data+size);return size;
}
int uart_read_bytes(int n,void* data,uint32_t size,TickType_t ticks){
    assert(n==1&&f.installed&&ticks==0);++f.reads;
    if(f.read_error)return -1;
    if(f.reverse)f.now-=10000;
    if(f.trickle)f.now+=40000;
    unsigned count=0;auto out=static_cast<unsigned char*>(data);
    while(count<size&&!f.rx.empty()){out[count++]=f.rx.front();f.rx.pop_front();if(f.trickle)break;}
    return count;
}
esp_err_t uart_wait_tx_done(int n,TickType_t ticks){
    assert(n==1&&ticks>0&&ticks<=10);
    if(f.wait_error)return -1;
    if(f.late)f.now+=100000;
    packet();return ESP_OK;
}
esp_err_t uart_flush_input(int n){assert(n==1);f.tx.clear();f.rx.clear();return f.flush_error?-1:ESP_OK;}
int64_t esp_timer_get_time(){return f.now;}
namespace {struct Yield{};bool yield_worker=false;void(*worker_fn)(void*)=nullptr;int task_creates=0;bool task_ok=false;}
void vTaskDelay(TickType_t ticks){
    assert(ticks==1||ticks==20);f.now+=ticks*10000;
    if(ticks==20&&f.on_enable_wait)f.on_enable_wait();
    if(ticks==1&&yield_worker)throw Yield{};
}
int xTaskCreate(void(*fn)(void*),const char* name,unsigned stack,void* arg,unsigned priority,TaskHandle_t* out){
    assert(std::string(name)=="sion_motion"&&stack==6144&&!arg&&priority==1);++task_creates;
    if(!task_ok)return 0;worker_fn=fn;*out=reinterpret_cast<void*>(1);return pdPASS;
}
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t bus,const i2c_device_config_t* c,i2c_master_dev_handle_t* out){
    assert(bus==&power_bus&&c->device_address==0x6f&&!f.attached);f.attached=true;*out=&power_device;
    f.events.push_back("power.attach");return ESP_OK;
}
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t d){
    assert(d==&power_device&&f.attached);if(f.remove_error)return -1;f.attached=false;return ESP_OK;
}
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t d,const uint8_t* reg,size_t len,uint8_t* out,size_t n,int timeout){
    assert(d==&power_device&&f.attached&&len==1&&n==1&&timeout==20);
    *out=*reg==7?f.power_regs[5]:f.power_regs[*reg];return ESP_OK;
}
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t d,const uint8_t* bytes,size_t n,int timeout){
    assert(d==&power_device&&f.attached&&n==2&&timeout==20);
    f.power_regs[bytes[0]]=bytes[1]; // Even a failed ACK may follow a real write.
    if(bytes[0]==5){
        const bool high=bytes[1]&1;f.events.push_back(high?"power.on":"power.off");
        if(high)++f.power_on;
        if(high?f.power_high_error:f.power_low_error)return -1;
    }
    return ESP_OK;
}

int main(){
    Power power;
    // Every NVS/driver/config/pin failure keeps outputs untouched; partial
    // ownership is explicitly released, never repaired by writing defaults.
    for(int failure=1;failure<=6;++failure){
        reset();f.fail=failure;EspServoUart link(power);int y=-5,p=-6;
        assert(!link.Open(y,p)&&y==-5&&p==-6);assert(!link.Open(y,p));
        assert(link.Close()&&!f.installed);assert(link.Close());
        assert(f.closes==(failure==1?0:1));assert(f.writes==0);
    }
    for(int invalid:{-1,1001}){
        reset();f.yaw=invalid;EspServoUart link(power);int y=0,p=0;
        assert(!link.Open(y,p)&&link.Close()&&f.deletes==0);
        reset();f.pitch=invalid;EspServoUart other(power);
        assert(!other.Open(y,p)&&other.Close()&&f.deletes==0);
    }
    {reset();f.installed=true;EspServoUart link(power);int y=0,p=0;
        assert(!link.Open(y,p)&&link.Close()&&f.deletes==0&&f.step==0);f.installed=false;}
    {reset();EspServoUart first(power),second(power);int y=0,p=0;
        assert(first.Open(y,p)&&y==460&&p==620);assert(!second.Open(y,p));
        assert(second.Close()&&f.deletes==0);assert(first.Close());
        assert(second.Open(y,p)&&second.Close());}
    {reset();power.ready=false;EspServoUart link(power);int y=0,p=0;
        assert(!link.Open(y,p)&&link.Close()&&f.writes==0);power.ready=true;}
    // Actual SCS transaction through actual ESP adapter, with each SDK fault.
    for(int failure=0;failure<9;++failure){
        reset();EspServoUart link(power);int y=0,p=0;assert(link.Open(y,p));
        f.short_write=failure==1;f.wait_error=failure==2;f.flush_error=failure==3;
        f.read_error=failure==4;f.no_reply=failure==5;f.trickle=failure==6;
        f.late=failure==7;f.reverse=failure==8;
        unsigned char torque=99;const int result=link.Read(1,40,&torque,1);
        if(!failure)assert(result==1&&torque==0&&link.Healthy());
        else assert(!link.Healthy());
        // A subsequent transaction resets the latch, never individual fragments.
        f.short_write=f.wait_error=f.flush_error=f.read_error=f.no_reply=false;
        f.trickle=f.late=f.reverse=false;
        assert(link.Read(1,40,&torque,1)==1&&link.Healthy());assert(link.Close());
    }
    {reset();EspServoUart link(power);int y=0,p=0;assert(link.Open(y,p));
        power.ready=false;assert(link.readByte(1,40)==-1&&!link.Healthy()&&f.writes==0);
        power.ready=true;f.delete_error=true;assert(!link.Close()&&f.installed);
        assert(!link.Open(y,p));f.delete_error=false;assert(link.Close());}
    // Compose the real register adapter, SDK link and codec. GPIO reset can fail
    // after UART deletion: retry cleanup without issuing torque packets again.
    {reset();EspServoUart link(power);ScsMotionPort port(link,link);
        assert(port.Open());assert(port.Move({0,450,1000}));
        MotionFeedback sample;assert(port.Poll(sample)==Result::Done&&sample.pitch==450);
        f.reset_error=true;assert(port.Release()==Result::Failed&&!f.installed);
        const auto writes=f.writes;assert(!port.Open());
        assert(port.Release()==Result::Failed&&f.writes==writes);
        f.reset_error=false;assert(port.Release()==Result::Done&&f.writes==writes);
        assert(port.Open()&&port.Release()==Result::Done);
    }
    // Staged UART reserves hardware without requiring power or emitting bytes.
    {reset();power.ready=false;EspServoUart link(power);int y=-1,p=-1;
        assert(link.Prepare()&&f.writes==0&&!link.Prepare());power.ready=true;
        assert(link.Open(y,p)&&y==460&&p==620&&!link.Open(y,p));assert(link.Close());}
    // Full hardware composition: no I2C or supply enable on failed calibration/UART.
    for(int failure=1;failure<=6;++failure){
        reset();f.fail=failure;EspMotionPort port(hal_bridge::board_get_i2c_bus);
        assert(!port.Open()&&!f.attached&&f.power_on==0);
        assert(port.Release()==Result::Done&&!f.installed);
    }
    {reset();f.require_power=true;EspMotionPort port(hal_bridge::board_get_i2c_bus);
        MotionEngine engine(port);engine.AllowMotion(true);auto ticket=engine.Begin(1,{0,450,1000},0);
        assert(ticket);engine.Pump(0);engine.Pump(1);engine.Pump(50);engine.Pump(100);engine.Pump(101);
        MotionOutcome result;assert(engine.Take(1,ticket,result)&&result.error==MotionError::None);
        assert(!f.installed&&!f.attached&&f.power_on==1&&f.goal_writes==2);
        assert(f.events[0]=="nvs.read"&&f.events[1]=="uart.install"&&f.events[2]=="power.attach");
    }
    {reset();EspMotionPort port(hal_bridge::board_get_i2c_bus);f.power_high_error=true;
        assert(!port.Open()&&f.power_on==1);assert(port.Release()==Result::Done&&!f.attached&&!f.installed);}
    // Stop arriving during power settling must prevent the later position command.
    {reset();EspMotionPort port(hal_bridge::board_get_i2c_bus);MotionEngine engine(port);
        engine.AllowMotion(true);assert(engine.Begin(1,{},0));f.on_enable_wait=[&]{engine.Stop(2);};
        engine.Pump(0);assert(engine.Stopped(2)==Result::Pending);engine.Pump(1);
        assert(engine.Stopped(2)==Result::Done&&f.goal_writes==0&&!f.attached&&!f.installed);}
    // Torque-off ACK failure: still cut power and close UART, but latch fault.
    {reset();f.require_power=true;EspMotionPort port(hal_bridge::board_get_i2c_bus);
        assert(port.Open()&&port.Move({}));f.no_reply=true;
        assert(port.Release()==Result::Failed&&!f.attached&&!f.installed&&!(f.power_regs[5]&1));
        auto writes=f.writes;f.no_reply=false;
        assert(port.Release()==Result::Failed&&f.writes==writes&&!port.Open());}
    // Confirmed torque-off + partial UART close: cleanup can complete on retry,
    // with no attempt to communicate after the power domain has been disabled.
    {reset();f.require_power=true;EspMotionPort port(hal_bridge::board_get_i2c_bus);
        assert(port.Open()&&port.Move({}));f.reset_error=true;
        assert(port.Release()==Result::Failed&&!f.attached&&!f.installed);
        const auto writes=f.writes;f.reset_error=false;
        assert(port.Release()==Result::Done&&f.writes==writes);}
    // The other cleanup is attempted even if power removal cannot be confirmed.
    {reset();EspMotionPort port(hal_bridge::board_get_i2c_bus);assert(port.Open());
        f.power_low_error=true;assert(port.Release()==Result::Failed&&!f.installed&&f.attached);
        f.power_low_error=false;assert(port.Release()==Result::Done&&!f.attached);}
    // Actual worker and engine; fake scheduler yields after each loop iteration.
    {reset();auto& engine=DeviceMotion();assert(!engine.Begin(1,{},0));
        assert(!StartMotionWorker());task_ok=true;assert(StartMotionWorker());
        assert(StartMotionWorker()&&task_creates==2);yield_worker=true;
        const auto step=[] {try{worker_fn(nullptr);assert(false);}catch(const Yield&) {}};
        step();assert(f.step==0&&!f.attached&&!f.installed);
        engine.AllowMotion(true);assert(engine.Begin(1,{},f.now/1000));step();step();
        engine.Stop(2);step();assert(engine.Stopped(2)==Result::Done&&!f.attached&&!f.installed);
        assert(StartMotionWorker()&&task_creates==2);yield_worker=false;
    }
    std::cout<<"Motion ESP UART/NVS and actual SCS composition passed (SDK fixture, no hardware)\n";
}
