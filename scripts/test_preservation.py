"""Compile preservation code and the actual prepared Hal::init body on the host."""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def run(source):
    out = ROOT/'work/preservation-tests'
    out.mkdir(parents=True, exist_ok=True)
    common = ['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
              '-fsanitize=address,undefined', '-g', '-I'+str(ROOT/'firmware/overlay')]
    def compile_run(name, files, extra=()):
        subprocess.run(common+list(extra)+list(map(str, files))+['-o', str(out/name)], check=True)
        subprocess.run([str(out/name)], check=True)
    compile_run('policy', [ROOT/'firmware/tests/preservation_policy_test.cc'])
    (out/'sdkconfig.h').write_text('')
    (out/'nvs.h').write_text('''#pragma once
using esp_err_t=int; using nvs_handle_t=int;
enum nvs_open_mode_t {NVS_READONLY=0,NVS_READWRITE=1};
constexpr int ESP_OK=0,ESP_ERR_NOT_SUPPORTED=0x106;
''')
    (out/'nvs_flash.h').write_text('#pragma once\n#include "nvs.h"\n')
    (out/'storage_test.cc').write_text('''#include <cassert>
#include <iostream>
#include "nvs.h"
static int erases=0; static nvs_open_mode_t last=NVS_READWRITE;
extern "C" {
int __real_nvs_open(const char*,nvs_open_mode_t m,nvs_handle_t* h){last=m;*h=42;return ESP_OK;}
int __real_nvs_open_from_partition(const char*,const char* n,nvs_open_mode_t m,nvs_handle_t* h){return __real_nvs_open(n,m,h);}
int __real_nvs_flash_erase(){++erases;return ESP_OK;}
int __real_nvs_flash_erase_partition(const char*){++erases;return ESP_OK;}
int __wrap_nvs_open(const char*,nvs_open_mode_t,nvs_handle_t*);
int __wrap_nvs_open_from_partition(const char*,const char*,nvs_open_mode_t,nvs_handle_t*);
int __wrap_nvs_flash_erase();
int __wrap_nvs_flash_erase_partition(const char*);
}
int main(){
 nvs_handle_t h=0;
 for(const char* ns:{"board","wifi","mqtt","websocket","assets","account","app_config"}){
  assert(__wrap_nvs_open(ns,NVS_READWRITE,&h)==ESP_OK);
  assert(last==(CONFIG_SION_DUAL_BACKEND?NVS_READONLY:NVS_READWRITE));
  assert(__wrap_nvs_open_from_partition("nvs",ns,NVS_READWRITE,&h)==ESP_OK);
  assert(last==(CONFIG_SION_DUAL_BACKEND?NVS_READONLY:NVS_READWRITE));
 }
 assert(__wrap_nvs_open("sion_pair",NVS_READWRITE,&h)==ESP_OK&&last==NVS_READWRITE);
 assert(__wrap_nvs_open("warm_boot",NVS_READWRITE,&h)==ESP_OK&&last==NVS_READWRITE);
 assert(__wrap_nvs_flash_erase()==(CONFIG_SION_DUAL_BACKEND?ESP_ERR_NOT_SUPPORTED:ESP_OK));
 assert(__wrap_nvs_flash_erase_partition("nvs")== (CONFIG_SION_DUAL_BACKEND?ESP_ERR_NOT_SUPPORTED:ESP_OK));
 assert(erases==(CONFIG_SION_DUAL_BACKEND?0:2));
 std::cout<<"Production NVS wrappers passed (feature="<<CONFIG_SION_DUAL_BACKEND<<")\\n";
}
''')
    for enabled in (0, 1):
        compile_run('storage-'+str(enabled), [out/'storage_test.cc', ROOT/'firmware/overlay/sion/preservation_storage.cc'],
                    ['-I'+str(out), '-DCONFIG_SION_DUAL_BACKEND='+str(enabled)])
    # Extract the exact prepared production initialization body; do not rewrite
    # its branching in the test. Hardware methods are no-op dependencies.
    text = (source/'main/hal/hal.cpp').read_text()
    start = text.index('void Hal::init()')
    end = text.index('\n/* -----', start)
    method = text[start:end]
    (out/'init_test.cc').write_text('''#include <cassert>
#include <iostream>
using esp_err_t=int;
constexpr int ESP_OK=0,ESP_ERR_NVS_NO_FREE_PAGES=1,ESP_ERR_NVS_NEW_VERSION_FOUND=2;
static int initial_error=0,calls=0,erases=0,started=0;
int nvs_flash_init(){return calls++==0?initial_error:ESP_OK;}
int nvs_flash_erase(){++erases;return ESP_OK;}
#define ESP_ERROR_CHECK(x) do { int e=(x); if(e) throw e; } while(0)
namespace sion {void StartFirmwareTrial(){++started;}}
namespace mclog {void tagInfo(const char*,const char*){}}
const char* _tag="test";
class Hal {public: void init();
void xiaozhi_board_init(){} void xiaozhi_mcp_init(){} void head_touch_init(){}
void io_expander_init(){} void rtc_init(){} void imu_init(){} void servo_init(){} void lvgl_init(){}
};
'''+method+'''
int main(){for(int error:{ESP_OK,ESP_ERR_NVS_NO_FREE_PAGES,ESP_ERR_NVS_NEW_VERSION_FOUND,3}){
 initial_error=error;calls=erases=started=0;bool failed=false;
 try{Hal().init();}catch(int e){failed=true;assert(e==error);}
 bool should_fail=error&&(CONFIG_SION_DUAL_BACKEND||error==3);
 assert(failed==should_fail);
 assert(erases==(!CONFIG_SION_DUAL_BACKEND&&(error==1||error==2)?1:0));
 assert(started==(!should_fail?1:0));
 } std::cout<<"Production Hal::init: success and three NVS errors passed (feature="<<CONFIG_SION_DUAL_BACKEND<<")\\n";}
''')
    for enabled in (0, 1):
        compile_run('init-'+str(enabled), [out/'init_test.cc'], ['-DCONFIG_SION_DUAL_BACKEND='+str(enabled)])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT/'work/firmware-preservation/firmware')
    run(parser.parse_args().source)
