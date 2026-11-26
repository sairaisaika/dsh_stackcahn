// Pure decisions of the power-key boot selector (wiki/boot-selector-power-key.md).
// No hardware access; host-tested in scripts/test_boot_selector_pek.py.
// SPDX-License-Identifier: MIT
#pragma once
#include <stdbool.h>
#include <stdint.h>

enum { PEK_OTA_NEW = 0, PEK_OTA_PENDING = 1, PEK_OTA_VALID = 2, PEK_OTA_INVALID = 3, PEK_OTA_ABORTED = 4 };
#define PEK_OTA_UNDEFINED 0xffffffffu
#define PEK_SHORT_BIT 0x08u     // AXP2101 0x49 bit3: power key short press (XPowersLib PKEY_SHORT_IRQ = _BV(11))
#define PEK_LONG_BIT 0x04u      // AXP2101 0x49 bit2: long press (_BV(10))
#define PEK_PRESSES_NEEDED 2u

typedef struct { uint32_t seq; uint32_t state; bool valid; } pek_record_t;

typedef enum { PEK_PLAN_WRITE, PEK_PLAN_ALREADY, PEK_PLAN_REFUSE } pek_plan_kind_t;
typedef struct { pek_plan_kind_t kind; int target; uint32_t seq; } pek_plan_t;

// Same choice as scripts/enter_dsh.py plan_selection and the reviewed trial install: the
// running slot is the highest valid record that is not ABORTED or INVALID and must be the
// confirmed factory firmware in ota_1 (even sequence); write running + 1 (odd, ota_0) as NEW
// in the other sector. A NEW ota_0 record just above the confirmed factory record means the
// selection is already there.
static inline pek_plan_t pek_plan(const pek_record_t rec[2])
{
    pek_plan_t refuse = {PEK_PLAN_REFUSE, -1, 0};
    int active = -1;
    for (int i = 0; i < 2; ++i) {
        if (!rec[i].valid || rec[i].state == PEK_OTA_INVALID || rec[i].state == PEK_OTA_ABORTED) continue;
        if (active < 0 || rec[i].seq > rec[active].seq) active = i;
    }
    if (active < 0) return refuse;
    const pek_record_t *run = &rec[active], *other = &rec[1 - active];
    if (run->state == PEK_OTA_NEW && (run->seq - 1) % 2 == 0 && other->valid && other->seq == run->seq - 1 &&
        (other->state == PEK_OTA_VALID || other->state == PEK_OTA_UNDEFINED))
        return (pek_plan_t){PEK_PLAN_ALREADY, active, run->seq};
    if ((run->seq - 1) % 2 != 1 || !(run->state == PEK_OTA_VALID || run->state == PEK_OTA_UNDEFINED)) return refuse;
    return (pek_plan_t){PEK_PLAN_WRITE, 1 - active, run->seq + 1};
}

// One poll of the 0x49 status byte: counts a short press and returns the bits to clear
// (write-1-to-clear, as M5Unified's getPekPress does).
static inline uint8_t pek_poll(uint8_t status, unsigned *presses)
{
    if (status & PEK_SHORT_BIT) ++*presses;
    return (uint8_t)(status & (PEK_SHORT_BIT | PEK_LONG_BIT));
}

static inline bool pek_version_is_dsh(const char *version, unsigned length)
{
    static const char prefix[] = "dsh-agent-";
    for (unsigned i = 0; i + 1 < sizeof prefix; ++i)
        if (i >= length || version[i] != prefix[i]) return false;
    return true;
}
