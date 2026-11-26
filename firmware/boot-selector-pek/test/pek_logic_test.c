// Host test for pek_logic.h: the same otadata cases as scripts/test_enter_dsh.py, plus the
// press counter and the DSH version check.
#include <assert.h>
#include <stdio.h>
#include "../bootloader_components/sion_pek/pek_logic.h"

static pek_plan_t plan(pek_record_t a, pek_record_t b) { pek_record_t r[2] = {a, b}; return pek_plan(r); }
#define R(s, st) ((pek_record_t){(s), (st), true})
#define ERASED ((pek_record_t){0xffffffffu, 0xffffffffu, false})

int main(void)
{
    pek_plan_t p;
    p = plan(R(2, PEK_OTA_VALID), ERASED);  assert(p.kind == PEK_PLAN_WRITE && p.target == 1 && p.seq == 3);
    p = plan(ERASED, R(4, PEK_OTA_VALID));  assert(p.kind == PEK_PLAN_WRITE && p.target == 0 && p.seq == 5);
    p = plan(R(2, PEK_OTA_VALID), R(3, PEK_OTA_ABORTED)); assert(p.kind == PEK_PLAN_WRITE && p.target == 1 && p.seq == 3);
    p = plan(R(1, PEK_OTA_ABORTED), R(2, PEK_OTA_VALID)); assert(p.kind == PEK_PLAN_WRITE && p.target == 0 && p.seq == 3);
    p = plan(R(2, PEK_OTA_VALID), ((pek_record_t){9, PEK_OTA_ABORTED, false})); assert(p.kind == PEK_PLAN_WRITE && p.seq == 3);
    p = plan(R(2, PEK_OTA_VALID), R(3, PEK_OTA_NEW)); assert(p.kind == PEK_PLAN_ALREADY);
    p = plan(R(2, PEK_OTA_VALID), R(3, PEK_OTA_PENDING)); assert(p.kind == PEK_PLAN_REFUSE);
    p = plan(R(4, PEK_OTA_PENDING), R(3, PEK_OTA_ABORTED)); assert(p.kind == PEK_PLAN_REFUSE);
    p = plan(ERASED, ERASED); assert(p.kind == PEK_PLAN_REFUSE);
    p = plan(R(2, PEK_OTA_INVALID), ERASED); assert(p.kind == PEK_PLAN_REFUSE);

    unsigned presses = 0;
    assert(pek_poll(0x00, &presses) == 0 && presses == 0);
    assert(pek_poll(0x03, &presses) == 0 && presses == 0);                 // edges only: not a press
    assert(pek_poll(0x04, &presses) == 0x04 && presses == 0);              // long press: cleared, not counted
    assert(pek_poll(0x0B, &presses) == 0x08 && presses == 1);
    assert(pek_poll(0x08, &presses) == 0x08 && presses == 2 && presses >= PEK_PRESSES_NEEDED);

    assert(pek_version_is_dsh("dsh-agent-v76-direct-frames-ota", 32));
    assert(!pek_version_is_dsh("1b7145c", 32) && !pek_version_is_dsh("1.6.2", 32) && !pek_version_is_dsh("dsh-agen", 8));
    puts("boot selector (power key): 10 otadata cases, press counter and DSH version check passed");
    return 0;
}
