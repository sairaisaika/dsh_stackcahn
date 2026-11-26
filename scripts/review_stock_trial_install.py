"""Preview a one-time USB trial from saved evidence. No serial or Flash access."""
import argparse
import json
import os
from pathlib import Path
import struct

from app_center_baseline import OTA, OWNER, require_app_center_storage, review_app_center
from check_agent_preflight import compare, read_snapshot
from ota_record import OTA_NEW, ota_record
from prepare_agent_bundle import CONFIG_OFFSET, EXPECTED_PARTITIONS, FLASH_SIZE, SECTOR, TABLE_OFFSET, pad_sectors
from prepare_installation import sha
from review_app_center_install import inactive_image, read_bounded
from review_app_center_recovery import reviewed_candidate, validate_stock_trial


def preview_stages(data, padded, target, selection, sequence):
    staged = bytearray(data)
    staged[target:target+len(padded)] = padded
    staged_digest = sha(staged)
    staged[selection:selection+SECTOR] = ota_record(sequence, OTA_NEW).ljust(SECTOR, b'\xff')
    return {'stagedSha256': staged_digest, 'selectedSha256': sha(staged)}


def review(reference, before, source, audit, host_archive):
    if reference.mac != before.mac:
        raise ValueError('Reference and current double reads must identify the same unit')
    drift = compare(reference.data, before.data)
    unexpected = [change['region'] for change in drift if change['region'] not in ('nvs', 'coredump')]
    if unexpected:
        raise ValueError('Current state requires a new trial rehearsal: '+', '.join(unexpected))
    baseline = review_app_center(before.data)
    validate_stock_trial(before.data, baseline)
    storage = require_app_center_storage(before.data, baseline)
    candidate = reviewed_candidate(before.data, source, stock_trial=True)
    padded = pad_sectors(candidate)
    _, _, target, capacity = EXPECTED_PARTITIONS['ota_0']
    if not padded or len(padded) > capacity:
        raise ValueError('Trial candidate cannot fit in the inactive app slot')
    selection = OTA+(1-baseline.active_record_sector)*SECTOR
    sequence = baseline.active_sequence+1
    candidate_digest = sha(candidate)
    reference_digest = sha(reference.data)
    if not isinstance(audit, dict) or any(not isinstance(audit.get(key), dict) for key in ('trial', 'results')):
        raise ValueError('Expected the stock trial rehearsal and its checkpoint results')
    audit_scope, results = audit['trial'], audit['results']
    audited_final_states = {
        'interrupted-staging-keeps-stock-bootable', 'staged-without-ota-selection',
        'interrupted-selection-keeps-stock-bootable', 'compiled-home-restarts-into-preserved-factory',
        'restore-reviewed-bytes',
    }
    audit_expectations = {
        'flashAuthorized': False, 'factorySlot': baseline.stock_slot, 'candidateSlot': 'ota_0',
        'factoryImageSha256': sha(baseline.stock), 'beforeSha256': reference_digest,
        'selectionSequence': sequence,
        'stagedSectors': [hex(target), hex(target+len(padded))],
        'selectionSector': [hex(selection), hex(selection+SECTOR)],
        'firstStartOwnershipSector': [hex(OWNER), hex(CONFIG_OFFSET)],
        **preview_stages(reference.data, padded, target, selection, sequence),
    }
    if (audit.get('deviceAccess') is not False or audit.get('installable') is not False or
            audit.get('fullAgentSha256') != candidate_digest or audit_scope.get('flashAuthorized') is not False or
            any(audit_scope.get(name) != value for name, value in audit_expectations.items()) or
            any(not isinstance(results.get(state), dict) or results[state].get('wholeFlashMatched') is not True
                for state in audited_final_states)):
        raise ValueError('Offline rehearsal does not match the reference and exact trial candidate')

    inactive = inactive_image(before.data[target:target+capacity])
    if inactive['status'] == 'unverified-existing-bytes':
        raise ValueError('The inactive image bytes need manual review')
    writes = [
        {'phase': 'stage', 'region': 'ota_0', 'start': target, 'endExclusive': target+len(padded)},
        {'phase': 'select-once', 'region': 'inactive-ota-record', 'start': selection, 'endExclusive': selection+SECTOR},
    ]
    if storage == 'erased':
        writes.append({'phase': 'first-dsh-boot', 'region': 'independent-owner-marker',
                       'start': OWNER, 'endExclusive': CONFIG_OFFSET})
    return {
        'status': 'review-only', 'deviceAccess': False, 'flashAuthorized': False,
        'factorySlot': baseline.stock_slot, 'inactiveSlot': 'ota_0', 'inactiveImage': inactive,
        'independentStorage': storage, 'selectionSequence': sequence,
        'referenceSha256': reference_digest, 'beforeSha256': sha(before.data),
        'bootloaderRegionSha256': sha(before.data[:TABLE_OFFSET]), 'partitionTableRegionSha256': sha(baseline.table),
        'factoryImageSha256': sha(baseline.stock), 'candidateSha256': candidate_digest,
        'macPluginArchiveSha256': sha(host_archive), 'referenceChanges': drift,
        'expectedWriteEnvelope': writes,
        **preview_stages(before.data, padded, target, selection, sequence),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('reference', 'before', 'agent-source', 'audit', 'host-archive', 'output'):
        parser.add_argument('--'+option, type=Path, required=True)
    args = parser.parse_args()
    if args.reference.resolve() == args.before.resolve():
        parser.error('Provide separate reference and current double read directories')
    try:
        from esptool.util import FatalError
    except ImportError:
        parser.exit(1, 'Use the reviewed ESP-IDF Python environment with esptool.\n')
    try:
        result = review(read_snapshot(args.reference), read_snapshot(args.before), args.agent_source.resolve(),
                        json.loads(read_bounded(args.audit, 1024*1024)), read_bounded(args.host_archive, 64*1024*1024))
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(result, indent=2)+'\n')
    except (OSError, ValueError, RuntimeError, FatalError, KeyError, TypeError, struct.error) as error:
        parser.exit(1, f'Stock trial install review rejected: {error}\n')
    print('Stock trial preview saved. No device access or Flash authorization.')


if __name__ == '__main__':
    main()
