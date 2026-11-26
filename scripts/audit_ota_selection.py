"""Offline host check of the locked IDF OTA selector. Never accesses a device."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'work/esp-idf/components/app_update/esp_ota_ops.c'
text = source.read_text()
start = text.index('const esp_partition_t* esp_ota_get_next_update_partition(')
opening = text.index('{', start)
depth = 1
end = opening + 1
while depth:
    depth += (text[end] == '{') - (text[end] == '}')
    end += 1
function = text[start:end]
out = ROOT / 'work/stock-boot-audit'
out.mkdir(parents=True, exist_ok=True)
harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
typedef unsigned int esp_partition_subtype_t;
typedef struct { unsigned int type, subtype; const char *label; } esp_partition_t;
enum { ESP_PARTITION_TYPE_APP=0, ESP_PARTITION_SUBTYPE_APP_OTA_0=0x10,
       ESP_PARTITION_SUBTYPE_APP_OTA_MAX=0x20 };
static esp_partition_t slots[4];
static unsigned count, running;
const esp_partition_t* esp_ota_get_running_partition(void) { return &slots[running]; }
const esp_partition_t* esp_partition_verify(const esp_partition_t* p) { return p; }
const esp_partition_t* esp_partition_find_first(unsigned type,unsigned subtype,const char* label) {
 (void)label;
 for(unsigned i=0;i<count;i++) if(slots[i].type==type&&slots[i].subtype==subtype) return &slots[i];
 return NULL;
}
'''
harness += function
harness += r'''
int main(void) {
 count=2; slots[0]=(esp_partition_t){0,0x10,"developer"}; slots[1]=(esp_partition_t){0,0x11,"official"};
 running=1; assert(esp_ota_get_next_update_partition(NULL)==&slots[0]);
 running=0; assert(esp_ota_get_next_update_partition(NULL)==&slots[1]);
 puts("two OTA slots: official update selects developer; developer default update selects official");
 count=3; slots[0].label="official-A"; slots[1].label="official-B";
 slots[2]=(esp_partition_t){0,0x12,"protected-developer"};
 for(running=0;running<3;running++) assert(esp_ota_get_next_update_partition(NULL)==&slots[(running+1)%3]);
 puts("three OTA slots: developer is still in update rotation; label does not protect it");
 slots[2].subtype=0x20;
 running=0; assert(esp_ota_get_next_update_partition(NULL)==&slots[1]);
 running=1; assert(esp_ota_get_next_update_partition(NULL)==&slots[0]);
 running=2; assert(esp_ota_get_next_update_partition(NULL)==&slots[0]);
 puts("two OTA slots + test app: official cycle skips test; developer must not use default OTA updater");
 count=1; slots[0]=(esp_partition_t){0,0x10,"only"}; running=0;
 assert(esp_ota_get_next_update_partition(NULL)==&slots[0]);
 puts("one OTA slot: selector returns running slot; not a safe update design");
 slots[0].subtype=0x20; assert(esp_ota_get_next_update_partition(NULL)==NULL);
 puts("no OTA slots: no OTA destination");
 return 0;
}
'''
(out/'ota-selector.c').write_text(harness)
subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
                '-fsanitize=address,undefined', str(out/'ota-selector.c'),
                '-o', str(out/'ota-selector')], check=True)
r = subprocess.run([str(out/'ota-selector')], check=True, capture_output=True, text=True)
(out/'ota-selector.log').write_text(r.stdout)
report = {
    'scope': 'Actual IDF selector with host partition-enumeration stubs, not device execution',
    'source': str(source.relative_to(ROOT)),
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'selectorSha256': hashlib.sha256(function.encode()).hexdigest(),
    'assertionsPassed': 10,
    'hardwareAccess': False,
    'originalSlotBytes': 0x4f0000,
    'unchangedLayoutTailBytes': 0x1000000-0xe10000,
    'historicalDeveloperImageBytes': 3801600,
    'historicalDeveloperFitsUnchangedTail': 3801600 <= 0x1000000-0xe10000,
}
(out/'ota-selection-report.json').write_text(json.dumps(report, indent=2)+'\n')
print(r.stdout, end='')
print('Unchanged-layout tail:', report['unchangedLayoutTailBytes'], 'bytes; this historical size comparison is superseded by review_agent_capacity.py')
