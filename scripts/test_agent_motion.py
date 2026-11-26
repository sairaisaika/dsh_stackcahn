"""Exercise the actual motion ownership core with a fake port; never accesses hardware."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='sion-motion-') as directory:
    binary = Path(directory) / 'motion-test'
    subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=address,undefined', '-g', '-pthread',
                    str(root/'firmware/agent/motion_engine_test.cc'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=30)
    include = Path(directory)
    driver = include/'hal/drivers/FTServo_Arduino/src'
    driver.mkdir(parents=True)
    vendor = root/'firmware/tests/vendor/ftservo'
    for name in ('SCS.h', 'SCS.cpp', 'INST.h'):
        shutil.copy2(vendor/name, driver/name)
    adapter = include/'motion-scs-test'
    subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=address,undefined', '-g', '-pthread', '-I'+str(include),
                    str(root/'firmware/agent/motion_scs.cc'),
                    str(root/'firmware/agent/motion_scs_test.cc'),
                    str(driver/'SCS.cpp'), '-o', str(adapter)], check=True)
    subprocess.run([str(adapter)], check=True, timeout=30)
    # Checked ESP UART implementation with injected SDK failures; no hardware.
    (include/'driver').mkdir()
    (include/'freertos').mkdir()
    (include/'motion_sdk.h').write_text('''#pragma once
#include <cstdint>
#include <cstddef>
using esp_err_t=int;using nvs_handle_t=uint32_t;using TickType_t=uint32_t;
using TaskHandle_t=void*;constexpr int pdPASS=1;
int xTaskCreate(void(*)(void*),const char*,unsigned,void*,unsigned,TaskHandle_t*);
constexpr int ESP_OK=0,NVS_READONLY=0,UART_NUM_1=1,UART_DATA_8_BITS=8;
constexpr int UART_PARITY_DISABLE=0,UART_STOP_BITS_1=1,UART_HW_FLOWCTRL_DISABLE=0;
constexpr int UART_SCLK_DEFAULT=0,UART_PIN_NO_CHANGE=-1,GPIO_NUM_6=6,GPIO_NUM_7=7;
struct uart_config_t {int baud_rate,data_bits,parity,stop_bits,flow_ctrl,source_clk;};
inline TickType_t pdMS_TO_TICKS(int64_t ms){return ms/10;}
esp_err_t nvs_open_from_partition(const char*,const char*,int,nvs_handle_t*);
esp_err_t nvs_get_i32(nvs_handle_t,const char*,int32_t*);
void nvs_close(nvs_handle_t);
bool uart_is_driver_installed(int);
esp_err_t uart_driver_install(int,int,int,int,void*,int);
esp_err_t uart_driver_delete(int);
esp_err_t uart_param_config(int,const uart_config_t*);
esp_err_t uart_set_pin(int,int,int,int,int);
esp_err_t gpio_reset_pin(int);
int uart_tx_chars(int,const char*,uint32_t);
int uart_read_bytes(int,void*,uint32_t,TickType_t);
esp_err_t uart_wait_tx_done(int,TickType_t);
esp_err_t uart_flush_input(int);
int64_t esp_timer_get_time();
void vTaskDelay(TickType_t);
''')
    for name in ('driver/uart.h','driver/gpio.h','freertos/FreeRTOS.h',
                 'freertos/task.h','esp_timer.h','nvs.h'):
        (include/name).write_text('#include "motion_sdk.h"\n')
    (include/'driver/i2c_master.h').write_text('''#pragma once
#include "motion_sdk.h"
struct i2c_bus;struct i2c_dev;
using i2c_master_bus_handle_t=i2c_bus*;
using i2c_master_dev_handle_t=i2c_dev*;
constexpr int I2C_ADDR_BIT_LEN_7=0;
struct i2c_device_config_t {int dev_addr_length;uint16_t device_address;uint32_t scl_speed_hz;};
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t,const i2c_device_config_t*,i2c_master_dev_handle_t*);
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t);
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t,const uint8_t*,size_t,uint8_t*,size_t,int);
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t,const uint8_t*,size_t,int);
''')
    uart=include/'motion-uart-test'
    subprocess.run(['clang++','-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-g','-pthread','-I'+str(include),
                    str(root/'firmware/agent/motion_uart.cc'),
                    str(root/'firmware/agent/motion_power.cc'),
                    str(root/'firmware/agent/py32_expander.cc'),
                    str(root/'firmware/agent/motion_hardware.cc'),
                    str(root/'firmware/agent/motion_runtime.cc'),
                    str(root/'firmware/agent/motion_scs.cc'),
                    str(root/'firmware/agent/motion_uart_test.cc'),
                    str(driver/'SCS.cpp'),'-o',str(uart)],check=True)
    subprocess.run([str(uart)],check=True,timeout=30)
    power=include/'motion-power-test'
    subprocess.run(['clang++','-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-g','-pthread','-I'+str(include),
                    str(root/'firmware/agent/motion_power.cc'),
                    str(root/'firmware/agent/py32_expander.cc'),
                    str(root/'firmware/agent/motion_power_test.cc'),
                    '-o',str(power)],check=True)
    subprocess.run([str(power)],check=True,timeout=30)
    ring=include/'ring-port-test'
    subprocess.run(['clang++','-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-g','-pthread','-I'+str(include),
                    str(root/'firmware/agent/motion_power.cc'),
                    str(root/'firmware/agent/py32_expander.cc'),
                    str(root/'firmware/agent/ring_port.cc'),
                    str(root/'firmware/agent/ring_port_test.cc'),
                    '-o',str(ring)],check=True)
    subprocess.run([str(ring)],check=True,timeout=30)
