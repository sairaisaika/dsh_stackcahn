#!/usr/bin/env python3
"""Host tests for scripts/enter_dsh.py's otadata decision; no device access."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from enter_dsh import OTADATA, SECTOR, plan_selection, record  # noqa: E402

NEW, PENDING, VALID, INVALID, ABORTED = 0, 1, 2, 3, 4
ERASED = b'\xff' * SECTOR


def sectors(first, second):
    pad = lambda r: r if r == ERASED else r.ljust(SECTOR, b'\xff')
    return pad(first) + pad(second)


# Factory confirmed in ota_1 (even sequence 2), other sector erased: write the other sector, odd 3.
p = plan_selection(sectors(record(2, VALID), ERASED))
assert p['active'] == 0 and p['target'] == OTADATA + SECTOR and p['sequence'] == 3, p
# Same, factory record in the second sector.
p = plan_selection(sectors(ERASED, record(4, VALID)))
assert p['active'] == 1 and p['target'] == OTADATA and p['sequence'] == 5, p
# After a DSH visit the other sector holds a higher ABORTED record: still factory running; replace it.
p = plan_selection(sectors(record(2, VALID), record(3, ABORTED)))
assert p['active'] == 0 and p['target'] == OTADATA + SECTOR and p['sequence'] == 3, p
# An old ABORTED record below the factory one (the IR Remote history) is overwritten the same way.
p = plan_selection(sectors(record(1, ABORTED), record(2, VALID)))
assert p['active'] == 1 and p['target'] == OTADATA and p['sequence'] == 3, p
# A record with a bad CRC is ignored.
bad = bytearray(record(9, ABORTED)); bad[-1] ^= 1
p = plan_selection(sectors(record(2, VALID), bytes(bad)))
assert p['sequence'] == 3, p
# Selected but never started (the reset fell back to download mode): nothing new to write.
p = plan_selection(sectors(record(2, VALID), record(3, NEW)))
assert p.get('already') and p['target'] == OTADATA + SECTOR and p['sequence'] == 3, p
# Refusals: DSH still selected or running, factory update not yet confirmed, nothing on flash.
for first, second, reason in (
        (record(2, VALID), record(3, PENDING), 'factory-not-confirmed-running'),
        (record(4, PENDING), record(3, ABORTED), 'factory-not-confirmed-running'),
        (ERASED, ERASED, 'no-ota-record'),
        (record(2, INVALID), ERASED, 'no-ota-record')):
    p = plan_selection(sectors(first, second))
    assert p.get('refused') == reason, (p, reason)
print('enter_dsh: otadata decisions for 6 accepted and 4 refused states passed')
