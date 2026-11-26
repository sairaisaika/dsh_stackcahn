"""Compare saved App Center or stock trial captures without any device access."""
import argparse
import json
import os
from pathlib import Path

from app_center_baseline import OTA, OWNER, require_app_center_storage, review_app_center
from check_agent_preflight import compare, read_snapshot
from ota_record import OTA_ABORTED, OTA_INVALID, OTA_NEW, OTA_PENDING_VERIFY, ota_record
from prepare_agent import APP_CENTER_HOME_VERSION, APP_CENTER_VERSION, app_center_headers_from_flash, verify
from prepare_agent_bundle import CONFIG_OFFSET, EXPECTED_PARTITIONS, FLASH_SIZE, SECTOR, pad_sectors
from prepare_installation import image_info, ota_records, sha


def changed_spans(before, current, region, start, end):
    spans = []
    for offset in range(start, end, SECTOR):
        if before[offset:offset+SECTOR] == current[offset:offset+SECTOR]:
            continue
        if spans and spans[-1]['endExclusive'] == offset:
            spans[-1]['endExclusive'] += SECTOR
        else:
            spans.append({'region': region, 'start': offset, 'endExclusive': offset+SECTOR})
    return spans


def validate_stock_trial(before, reviewed):
    if reviewed.stock_slot != 'ota_1':
        raise ValueError('Direct staging requires the reviewed factory in ota_1')
    index = 1-reviewed.active_record_sector
    sector = OTA+index*SECTOR
    if before[sector:sector+SECTOR] == b'\xff'*SECTOR:
        return
    record = ota_records(before[OTA:OTA+2*SECTOR], include_crc=True)[index]
    if (not record['crcValid'] or record['state'] not in (OTA_INVALID, OTA_ABORTED) or
            record['sequence'] in (0, 0xffffffff) or record['sequence'] % 2 != 1):
        raise ValueError('Direct staging requires an erased or explicitly retired inactive record')


def inspection_state(before, current, sector, active_sequence, *, complete_write, stock_trial):
    earliest = before[sector:sector+SECTOR]
    latest = current[sector:sector+SECTOR]
    unchanged = latest == earliest
    if unchanged and not complete_write:
        return 'original-record'
    if latest == b'\xff'*SECTOR:
        return 'original-record' if unchanged else 'erased-record'
    record = ota_records(latest + b'\xff'*SECTOR, include_crc=True)[0]
    states = {OTA_NEW: 'candidate-new', OTA_PENDING_VERIFY: 'candidate-pending-verification',
              OTA_ABORTED: 'candidate-aborted'}
    if (record['crcValid'] and record['sequence'] == active_sequence+1 and record['state'] in states and
            latest[4:24] == b'\xff'*20 and latest[32:] == b'\xff'*(SECTOR-32)):
        state = states[record['state']]
        # A full install and rollback can reproduce the formerly aborted
        # record byte-for-byte. The exact image supplies missing evidence.
        if not unchanged:
            return state
        if state == 'candidate-aborted':
            return 'staged-or-returned' if stock_trial else state
    if unchanged:
        return 'original-record'
    if stock_trial and not record['crcValid']:
        expected = ota_record(active_sequence+1, OTA_NEW)
        prefix = latest.rstrip(b'\xff')
        if 0 < len(prefix) < len(expected) and expected.startswith(prefix):
            return 'candidate-selection-interrupted'
    raise ValueError('Inactive OTA record has an unrecognized sequence, state, checksum or padding')


def plan_recovery(before, current, candidate, *, stock_trial=False):
    reviewed = review_app_center(before)
    if len(current) != FLASH_SIZE:
        raise ValueError('Expected a full observed Flash snapshot')
    if stock_trial:
        validate_stock_trial(before, reviewed)
    previous_storage = require_app_center_storage(before, reviewed)
    observed_storage = require_app_center_storage(current, reviewed)
    if previous_storage == 'owned' and observed_storage != 'owned':
        raise ValueError('Originally owned independent configuration is missing')

    opposite = 'ota_1' if reviewed.stock_slot == 'ota_0' else 'ota_0'
    _, _, target, slot_size = EXPECTED_PARTITIONS[opposite]
    padded = pad_sectors(candidate)
    if not padded or len(padded) > slot_size:
        raise ValueError('Candidate exceeds the reviewed inactive slot')
    sector = OTA+(1-reviewed.active_record_sector)*SECTOR
    actions = changed_spans(before, current, opposite, target, target+len(padded))
    complete_image = current[target:target+len(padded)] == padded
    state = inspection_state(before, current, sector, reviewed.active_sequence,
                             complete_write=bool(actions) and complete_image, stock_trial=stock_trial)
    if actions:
        extent = actions[-1]['endExclusive']
        observed = current[target:extent]
        payload = observed.rstrip(b'\xff')
        if observed != padded[:len(observed)] and not candidate.startswith(payload):
            # A restore interrupted between sectors may leave both exact source
            # images in the reviewed envelope. Unknown sector bytes still fail.
            known_sectors = stock_trial and all(
                current[offset:offset+SECTOR] in (before[offset:offset+SECTOR],
                                                padded[offset-target:offset-target+SECTOR])
                for offset in range(target, extent, SECTOR))
            if not known_sectors:
                raise ValueError('Inactive image does not match the candidate or a sequential partial write')
        if state == 'original-record' and not stock_trial:
            raise ValueError('Candidate bytes changed while the inactive record still matches the original')
    if state in ('candidate-new', 'candidate-pending-verification', 'candidate-selection-interrupted') and not complete_image:
        raise ValueError('Selected candidate does not match the reviewed complete image')
    actions += changed_spans(before, current, 'inactive-ota-record', sector, sector+SECTOR)

    # The only disposable ownership marker is one created from an empty range
    # that still has no configuration bytes. Treat all other owned data as live.
    config_erased = current.count(0xff, CONFIG_OFFSET) == FLASH_SIZE-CONFIG_OFFSET
    if previous_storage == 'erased' and observed_storage == 'owned' and config_erased:
        actions += changed_spans(before, current, 'unused-owner-marker', OWNER, CONFIG_OFFSET)

    masked = bytearray(current)
    for action in actions:
        start, end = action['start'], action['endExclusive']
        masked[start:end] = before[start:end]
    preserved = []
    regions = [(name, EXPECTED_PARTITIONS[name][2], EXPECTED_PARTITIONS[name][3]) for name in ('nvs', 'coredump')]
    regions.append(('sion_cfg', OWNER, FLASH_SIZE-OWNER))
    for name, start, size in regions:
        end = start+size
        if masked[start:end] != before[start:end]:
            preserved.append(name)
            masked[start:end] = before[start:end]
    unexpected = compare(before, masked)
    if unexpected:
        names = ', '.join(entry['region'] for entry in unexpected)
        raise ValueError(f'Unreviewed Flash changes require a new recovery review: {names}')

    waiting = state in ('candidate-new', 'candidate-pending-verification')
    if not waiting and review_app_center(current) != reviewed:
        raise ValueError('The same confirmed factory slot is required before recovery')
    return {'status': 'await-confirmed-factory-readback' if waiting else 'review-only',
            'deviceAccess': False, 'flashAuthorized': False, 'factorySlot': reviewed.stock_slot, 'inactiveSlot': opposite,
            'inactiveRecordState': state, 'restoreSpans': [] if waiting else actions, 'preserveChangedRegions': preserved,
            **({'installationMethod': 'stock-trial'} if stock_trial else {})}


def reviewed_candidate(baseline, source, *, stock_trial=False):
    receipt = verify(source)
    candidate = (source/'firmware/build/stack-chan.bin').read_bytes()
    built = json.loads((source/'.agent-build.json').read_text())
    info = image_info(candidate)
    digest = sha(candidate)
    version = APP_CENTER_VERSION if stock_trial else APP_CENTER_HOME_VERSION
    if (not receipt.get('appCenter') or bool(receipt.get('appCenterHome')) != (not stock_trial) or
            receipt['appVersion'] != version or info['version'] != version or info['imageBytes'] != len(candidate) or
            built['preparedReceiptSha256'] != sha((source/'.agent-prepared.json').read_bytes()) or
            built['artifacts']['stack-chan.bin'] != {'sha256': digest, 'bytes': len(candidate)}):
        label = 'stock trial' if stock_trial else 'App Center Home'
        raise ValueError(f'Expected the exact current {label} build and its source receipt')
    generated = source/'firmware/main/agent/app_center'
    for name, contents in app_center_headers_from_flash(baseline).items():
        if (generated/name).read_text() != contents:
            raise ValueError('Candidate is not paired with the factory image in this baseline')
    return candidate


def review_captures(before, current, source, *, stock_trial=False):
    if before.mac != current.mac:
        raise ValueError('Both double reads must identify the same unit')
    candidate = reviewed_candidate(before.data, source, stock_trial=stock_trial)
    report = plan_recovery(before.data, current.data, candidate, stock_trial=stock_trial)
    report.update({'candidateSha256': sha(candidate), 'beforeSha256': sha(before.data), 'currentSha256': sha(current.data)})
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('before', 'current', 'agent-source', 'output'):
        parser.add_argument('--'+option, type=Path, required=True)
    parser.add_argument('--stock-trial', action='store_true',
                        help='Review the direct USB trial staged against unchanged production firmware')
    args = parser.parse_args()
    if args.before.resolve() == args.current.resolve():
        parser.error('Provide two independently captured double reads')
    try:
        report = review_captures(read_snapshot(args.before), read_snapshot(args.current), args.agent_source.resolve(),
                                 stock_trial=args.stock_trial)
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(report, indent=2)+'\n')
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f'Recovery review rejected: {error}\n')
    print('Recovery review saved. Device access and Flash authorization are disabled.')
