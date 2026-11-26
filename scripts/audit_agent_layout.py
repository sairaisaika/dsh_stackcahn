"""Verify an appended test app and config layout in memory. Emit only a JSON report."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

from review_agent_capacity import require, review

ROOT = Path(__file__).resolve().parents[1]
TABLE_OFFSET = 0x8000
TABLE_END = 0x9000


def pinned_partition_tool(idf, revision=None):
    relative = 'components/partition_table/gen_esp32part.py'
    if revision is None:
        revision = json.loads((ROOT/'firmware/upstream.lock.json').read_text())['idf']['commit']
    source = idf/relative
    expected = subprocess.check_output(['git', '-C', str(idf), 'show', f'{revision}:{relative}'])
    require(source.read_bytes() == expected, 'Partition tool differs from pinned ESP-IDF')
    spec = importlib.util.spec_from_file_location('agent_partition_tool', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.offset_part_table = TABLE_OFFSET
    return module


def validated_layout(flash, capacity, tool):
    require(capacity['fitsCurrentImage'], 'Current image does not fit the preserved layout')
    app = int(capacity['provisionalAppStart'], 16)
    config = int(capacity['provisionalConfigStart'], 16)
    original_end = int(capacity['originalPartitionsEnd'], 16)
    sector = flash[TABLE_OFFSET:TABLE_END]
    original = tool.PartitionTable.from_binary(sector)
    original.verify()
    require(original and len(flash) == 0x1000000 and original.flash_size() == original_end,
            'Backup and capacity geometry disagree')
    require(app == original_end and app % 0x10000 == 0 and
            config + capacity['configBytes'] == len(flash) and capacity['configBytes'] == 0x4000 and
            config - app == capacity['availableAppBytes'] and
            0 < capacity['imageBytes'] <= capacity['requiredAppBytes'] <= config - app,
            'Candidate must occupy the aligned tail of this 16 MiB profile')
    require(flash.count(0xff, app) == len(flash) - app,
            'Saved backup tail contains data outside the original partitions')
    require(sector == original.to_binary().ljust(TABLE_END-TABLE_OFFSET, b'\xff'),
            'Original table is not reproduced exactly, including flags, digest and padding')
    ota_slots = sorted(p.subtype for p in original if p.type == 0 and 0x10 <= p.subtype < 0x20)
    require(ota_slots == [0x10, 0x11], 'Original layout must have one ota_0 and one ota_1')
    require(not any(p.type == 0 and p.subtype == 0x20 for p in original),
            'Only one test application can be selected by this boot policy')

    addition = tool.PartitionTable.from_csv(
        f'dsh_agent,app,test,{app:#x},{config-app:#x},\n'
        f'sion_cfg,data,nvs,{config:#x},0x4000,\n')
    combined = tool.PartitionTable()
    combined.extend(original)
    combined.extend(addition)
    combined.verify()
    combined.verify_size_fits(len(flash))
    binary = combined.to_binary()
    checked = tool.PartitionTable.from_binary(binary)
    checked.verify()
    require([p.to_binary() for p in checked] == [p.to_binary() for p in combined],
            'Combined layout did not round-trip with the pinned SDK')
    original_rows_size = 32 * len(original)
    require(binary[:original_rows_size] == sector[:original_rows_size], 'Original partition rows changed')
    return binary.ljust(TABLE_END-TABLE_OFFSET, b'\xff'), checked, len(original)


def audit_layout(flash, capacity, tool):
    _, checked, original_count = validated_layout(flash, capacity, tool)
    return {
        'version': 1,
        'profile': capacity['profile'],
        'appVersion': capacity['appVersion'],
        'backupSha256': capacity['backupSha256'],
        'imageSha256': capacity['imageSha256'],
        'buildReceiptSha256': capacity['buildReceiptSha256'],
        'originalRowsPreserved': original_count,
        'backupTailErased': True,
        'sdkRoundTrip': True,
        'appImageBytes': capacity['imageBytes'],
        'remainingAlignedBytes': capacity['remainingBytes'],
        'proposedAdditions': [
            {'name': entry.name, 'type': entry.type, 'subtype': entry.subtype,
             'offset': hex(entry.offset), 'bytes': entry.size}
            for entry in checked[original_count:]
        ],
        'partitionTableArtifactEmitted': False,
        'bootSelectorGenerated': False,
        'deviceAccess': False,
        'installable': False,
        'unresolved': capacity['unresolved'],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('backup-dir', 'build-dir', 'receipt', 'output'):
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--idf', type=Path, default=ROOT/'work/esp-idf')
    args = parser.parse_args()
    checked_capacity = review(args.backup_dir, args.build_dir, args.receipt)
    saved_flash = (args.backup_dir/'flash-A.bin').read_bytes()
    require(hashlib.sha256(saved_flash).hexdigest() == checked_capacity['backupSha256'],
            'Snapshot changed after capacity review')
    report = audit_layout(saved_flash, checked_capacity, pinned_partition_tool(args.idf))
    os.umask(0o077)
    with args.output.open('x') as handle:
        handle.write(json.dumps(report, indent=2)+'\n')
    print('Offline layout checked. No binary table or selector emitted.')
