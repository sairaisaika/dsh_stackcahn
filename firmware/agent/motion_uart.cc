// SPDX-License-Identifier: MIT
#include "motion_uart.h"
#include <atomic>
#include <algorithm>
#include <driver/uart.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <nvs.h>

namespace sion::agent {
namespace {
std::atomic<bool> uart_lease{false};
constexpr auto kUart=UART_NUM_1;
constexpr int64_t kTransactionUs=100000;
bool Calibration(int& yaw,int& pitch) {
    nvs_handle_t handle=0;
    if(nvs_open_from_partition("nvs","servo",NVS_READONLY,&handle)!=ESP_OK)return false;
    int32_t y=-1,p=-1;
    const auto yr=nvs_get_i32(handle,"zero_pos_1",&y);
    const auto pr=nvs_get_i32(handle,"zero_pos_2",&p);
    nvs_close(handle);
    if(yr!=ESP_OK||pr!=ESP_OK||y<0||y>1000||p<0||p>1000)return false;
    yaw=y;pitch=p;return true;
}
}
bool EspServoUart::Prepare() {
    open_failure_=1;
    if(lease_)return false;
    bool available=false;
    if(!uart_lease.compare_exchange_strong(available,true))return false;
    lease_=true;healthy_=false;
    int y,p;
    open_failure_=2;
    if(uart_is_driver_installed(kUart))return false;
    open_failure_=3;
    if(!Calibration(y,p))return false;
    open_failure_=4;
    // No TX ring buffer: bounded nonblocking uart_tx_chars below, then checked
    // wait_tx_done. uart_write_bytes with a full ring can block indefinitely.
    if(uart_driver_install(kUart,256,0,0,nullptr,0)!=ESP_OK)return false;
    owned_=true;open_failure_=5;
    uart_config_t config{};
    config.baud_rate=1000000;config.data_bits=UART_DATA_8_BITS;
    config.parity=UART_PARITY_DISABLE;config.stop_bits=UART_STOP_BITS_1;
    config.flow_ctrl=UART_HW_FLOWCTRL_DISABLE;config.source_clk=UART_SCLK_DEFAULT;
    if(uart_param_config(kUart,&config)!=ESP_OK)return false;
    reset_tx_=reset_rx_=true; // pin setup may fail after a partial side effect
    open_failure_=6;
    if(uart_set_pin(kUart,6,7,UART_PIN_NO_CHANGE,UART_PIN_NO_CHANGE)!=ESP_OK)return false;
    yaw_zero_=y;pitch_zero_=p;prepared_=true;open_failure_=0;return true;
}
bool EspServoUart::Open(int& yaw,int& pitch) {
    if(open_attempted_)return false;
    open_attempted_=true;
    if(!prepared_&&!Prepare())return false;
    if(!power_.Ready()){open_failure_=7;return false;}
    ready_=true;yaw=yaw_zero_;pitch=pitch_zero_;return true;
}
bool EspServoUart::Close() {
    ready_=false;healthy_=false;prepared_=false;
    if(!lease_){open_attempted_=false;return true;}
    if(owned_) {
        // Missing driver is uncertain ownership loss, not our successful close.
        if(!uart_is_driver_installed(kUart)||uart_driver_delete(kUart)!=ESP_OK)return false;
        owned_=false;
    }
    bool ok=true;
    if(reset_tx_) {if(gpio_reset_pin(GPIO_NUM_6)==ESP_OK)reset_tx_=false;else ok=false;}
    if(reset_rx_) {if(gpio_reset_pin(GPIO_NUM_7)==ESP_OK)reset_rx_=false;else ok=false;}
    if(!ok)return false;
    lease_=false;open_attempted_=false;uart_lease.store(false);return true;
}
void EspServoUart::Pause(unsigned milliseconds) {
    vTaskDelay(std::max<TickType_t>(1,pdMS_TO_TICKS(milliseconds)));
}
bool EspServoUart::WithinDeadline() {
    const auto now=esp_timer_get_time();
    if(!ready_||!healthy_||now<last_time_||now>=deadline_)healthy_=false;
    last_time_=now;return healthy_;
}
void EspServoUart::rFlushSCS() {
    healthy_=ready_&&owned_;
    last_time_=esp_timer_get_time();deadline_=last_time_+kTransactionUs;
    if(!healthy_)return;
    if(!power_.Ready()||uart_flush_input(kUart)!=ESP_OK)healthy_=false;
    WithinDeadline();
}
int EspServoUart::writeSCS(unsigned char* data,int size) {
    if(!data||size<=0||!WithinDeadline())return 0;
    const int count=uart_tx_chars(kUart,reinterpret_cast<const char*>(data),size);
    if(count!=size)healthy_=false;
    WithinDeadline();return healthy_?count:0;
}
int EspServoUart::writeSCS(unsigned char value) {return writeSCS(&value,1);}
void EspServoUart::wFlushSCS() {
    if(!WithinDeadline())return;
    const auto remaining=deadline_-last_time_;
    const auto ticks=std::max<TickType_t>(1,pdMS_TO_TICKS(remaining/1000));
    if(uart_wait_tx_done(kUart,ticks)!=ESP_OK)healthy_=false;
    WithinDeadline();
}
int EspServoUart::readSCS(unsigned char* data,int size) {
    if(!data||size<=0||!WithinDeadline())return 0;
    int count=0;
    while(count<size&&WithinDeadline()) {
        const int n=uart_read_bytes(kUart,data+count,size-count,0);
        if(n<0||n>size-count){healthy_=false;break;}
        count+=n;
        if(!WithinDeadline())break;
        if(n==0)vTaskDelay(1);
    }
    if(count!=size)healthy_=false;
    return healthy_?count:0;
}
int EspServoUart::readSCS(unsigned char* data,int size,unsigned long timeout) {
    // Upstream's optional sync-read timeout may shorten but never extend the
    // absolute transaction budget. Current ScsMotionPort uses ordinary reads.
    const auto now=esp_timer_get_time();
    const auto limit=std::min<unsigned long>(timeout,100)*1000;
    deadline_=std::min(deadline_,now+static_cast<int64_t>(limit));
    return readSCS(data,size);
}
}
