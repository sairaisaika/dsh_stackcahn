"""Compare saved Sion reads to the selected reviewed stages. Never opens a serial port."""
import argparse
from dataclasses import dataclass
import json
import re
from pathlib import Path
import sys

from prepare_agent_bundle import (
    ROOT, APP_OFFSET, CONFIG_OFFSET, EXPECTED_PARTITIONS, FLASH_SIZE,
    SECTOR, TABLE_OFFSET, TABLE_END, candidate_option, prepare, selector_option,
)
from prepare_installation import sha
from review_agent_capacity import require

@dataclass(frozen=True)
class ReadSnapshot:
    data: bytes
    mac: str


def field(text, name):
    matches = re.findall(rf'^{re.escape(name)}:[ \t]*([^\r\n]*?)[ \t]*$', text, re.M)
    require(len(matches) == 1 and bool(matches[0]), f'Missing or ambiguous {name} evidence')
    return matches[0]


def probe_identity(folder):
    security = (folder/'security-info.txt').read_text()
    flash_id = (folder/'flash-id.txt').read_text()
    mac = field(security, 'MAC').lower()
    require(re.fullmatch(r'[0-9a-f]{2}(?::[0-9a-f]{2}){5}', mac) and
            field(flash_id, 'MAC').lower() == mac, 'Probe logs do not identify the same device')
    require(all('ESP32-S3' in field(text, 'Chip type') and 'revision v0.2' in field(text, 'Chip type')
                for text in (security, flash_id)), 'Unsupported chip or revision in read evidence')
    require(field(flash_id, 'Detected flash size').replace(' ', '').upper() == '16MB',
            'Unsupported Flash size in read evidence')
    require(field(security, 'Chip ID') == '9' and field(security, 'Secure Boot') == 'Disabled' and
            field(security, 'Flash Encryption') == 'Disabled', 'Security profile differs from the reviewed device')
    return mac


def check_read_logs(folder, mac):
    reads = [(folder/name).read_text() for name in ('read-A.log', 'read-B.log')]
    require(all(field(text, 'MAC').lower() == mac for text in reads),
            'Probe and read logs do not identify the same device')
    # These are consistency checks on supplied logs, not a proof that the reads are new.
    require(all(len(re.findall(r'^Read 16777216 bytes from 0x0+\b', text, re.M)) == 1
                for text in reads), 'Logs do not record two full reads at address zero')


def read_snapshot(folder):
    """Cross-check two reads, receipt and probe transcripts, keeping MAC private."""
    first = (folder/'flash-A.bin').read_bytes()
    second = (folder/'flash-B.bin').read_bytes()
    receipt = json.loads((folder/'verification.json').read_text())
    require(len(first) == FLASH_SIZE and first == second and receipt['bytes'] == FLASH_SIZE and
            receipt['sha256'] == sha(first) and receipt['identical'] is True and receipt['flashWritten'] is False,
            'Double-read bytes or capture receipt do not agree')
    mac = probe_identity(folder)
    check_read_logs(folder, mac)
    return ReadSnapshot(first, mac)


def verify_materials(bundle, verified_files, expected_manifest):
    observed_manifest = json.loads((bundle/'manifest.json').read_text())
    require(observed_manifest == expected_manifest, 'Bundle manifest does not match regenerated review evidence')
    for item in verified_files:
        require((bundle/item.file).read_bytes() == item.payload,
                f'Bundle payload {item.file} differs from regenerated evidence')


def flash_regions():
    known = [(0, TABLE_OFFSET, 'bootloader'), (TABLE_OFFSET, TABLE_END, 'partition-table')]
    known.extend((start, start+size, name) for name, (_, _, start, size) in EXPECTED_PARTITIONS.items())
    known.extend([(APP_OFFSET, CONFIG_OFFSET, 'agent-tail'), (CONFIG_OFFSET, FLASH_SIZE, 'agent-config')])
    spans = []
    edge = 0
    for start, end, name in sorted(known):
        if start > edge:
            spans.append((edge, start, 'unallocated-gap'))
        spans.append((start, end, name))
        edge = end
    return spans


def compare(expected, observed):
    expected, observed = memoryview(expected), memoryview(observed)
    require(len(expected) == len(observed) == FLASH_SIZE, 'Expected and observed Flash size must be 16 MiB')
    changes = []
    for start, end, name in flash_regions():
        count = sum(expected[i:i+SECTOR] != observed[i:i+SECTOR] for i in range(start, end, SECTOR))
        if count:
            changes.append({'region': name, 'offset': hex(start), 'changedSectors': count})
    return changes


def expected_after(start, ordered_writes, stage):
    require(0 <= stage <= len(ordered_writes), 'Stage does not exist')
    expected = bytearray(start)
    for writer in ordered_writes[:stage]:
        expected[writer.offset:writer.end] = writer.payload
    return expected


def restore_retained_changes(original, current, install):
    """Reject unexplained drift before making a two-sector-range restore plan."""
    require(len(original) == len(current) == FLASH_SIZE, 'Restore evidence must cover the whole Flash')
    expected = bytearray(original)
    # An interrupted install or recovery can leave any bytes inside these
    # reviewed, whole-sector windows. The original table will hide the app.
    for step in install:
        expected[step.offset:step.end] = current[step.offset:step.end]
    changes = compare(expected, current)
    retained = {'nvs', 'coredump', 'agent-config'}
    unexpected = [change['region'] for change in changes if change['region'] not in retained]
    require(not unexpected, 'Restore requires a new review of changes outside the reviewed write windows: '
            + ', '.join(dict.fromkeys(unexpected)))
    return changes


def outcome(changes, stage, mode):
    if not changes:
        return 'bytes-match'
    regions = {change['region'] for change in changes}
    if mode == 'install' and stage == 0:
        if regions <= {'nvs', 'coredump'}:
            return 'saved-data-changed-rebuild-review'
        if regions & {'agent-tail', 'agent-config'}:
            return 'tail-not-original-stop'
        if regions & {'bootloader', 'partition-table', 'otadata', 'ota_0', 'ota_1'}:
            return 'boot-layout-or-ota-changed-stop'
        return 'unexpected-original-content-stop'
    return 'readback-mismatch-stop'


def check(args):
    after_agent_use = getattr(args, 'after_agent_use', False)
    stock_return_base = getattr(args, 'stock_return_base', None)
    require(not (after_agent_use and stock_return_base is not None),
            'Choose either the After-Agent or the stock-return comparison')
    require(not after_agent_use or (args.mode == 'install' and args.stage == 3),
            'After-Agent comparison requires a completed three-stage installation')
    require(stock_return_base is None or (args.mode == 'install' and args.stage == 3),
            'Stock-return comparison requires a completed three-stage installation')
    if stock_return_base is not None:
        require(len({path.resolve() for path in (args.historical, stock_return_base, args.observed)}) == 3,
                'Stock-return comparison requires three distinct snapshot directories')
    historical = read_snapshot(args.historical)
    observed = read_snapshot(args.observed)
    require(historical.mac == observed.mac, 'Observed reads identify a different unit')
    items, manifest = prepare(args.historical, args.app, args.selector, args.idf, args.stock_idf,
                              candidate=args.candidate, selector_variant=getattr(args, 'selector_variant', 'grove'))
    require(manifest['savedBaselineSha256'] == sha(historical.data), 'Historical source changed during review')
    verify_materials(args.bundle, items, manifest)
    retained = None
    if args.mode == 'restore':
        require(args.recovery_base is not None, 'Recovery comparison requires the immediate pre-restore snapshot')
        recovery_base = read_snapshot(args.recovery_base)
        require(recovery_base.mac == historical.mac, 'Recovery baseline identifies a different unit')
        retained = restore_retained_changes(historical.data, recovery_base.data, items[:3])
        expected = expected_after(recovery_base.data, items[3:], args.stage)
    else:
        require(args.recovery_base is None, 'Recovery baseline is only for restore comparisons')
        expected = expected_after(historical.data, items[:3], args.stage)

    runtime_check = None
    if stock_return_base is not None:
        before_return = read_snapshot(stock_return_base)
        require(before_return.mac == historical.mac, 'Stock-return baseline identifies a different unit')
        require(all(change['region'] == 'agent-config' for change in compare(expected, before_return.data)),
                'Stock-return baseline differs outside the independent configuration')
        expected = before_return.data
        runtime_check = ('stock-return', 'nvs')
    elif after_agent_use:
        runtime_check = ('runtime', 'agent-config')

    changes = compare(expected, observed.data)
    result = outcome(changes, args.stage, args.mode)
    runtime = {}
    if runtime_check:
        label, mutable_region = runtime_check
        protected_match = all(change['region'] == mutable_region for change in changes)
        result = f'{label}-protected-bytes-match' if protected_match else f'{label}-protected-bytes-changed-stop'
        runtime = {'protectedBytesMatch': protected_match, 'physicalRuntimeProven': False}
    return {
        'version': 1,
        'operation': args.mode,
        'completedStageCount': args.stage,
        'result': result,
        'changedRegions': changes,
        **runtime,
        **({'restoreRetainedDifferences': retained} if retained is not None else {}),
        'exactExpectedBytes': not changes,
        'unitIdentityConsistentInSavedLogs': True,
        'verifiedBundlePayloads': len(items),
        'snapshotFreshnessProven': False,
        'deviceAccess': False,
        'flashAuthorized': False,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('historical', 'observed', 'bundle'):
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--mode', choices=('install', 'restore'), default='install')
    parser.add_argument('--stage', type=int, default=0, help='Number of completed stages, zero for preflight')
    parser.add_argument('--after-agent-use', action='store_true',
                        help='Compare after independent Agent use and before any factory boot; allow only sion_cfg changes')
    parser.add_argument('--stock-return-base', type=Path,
                        help='Verified saved reads after Agent use and before stock boot; compare after return, allowing only factory NVS changes')
    parser.add_argument('--recovery-base', type=Path, help='Saved reads taken immediately before recovery')
    candidate_option(parser)
    selector_option(parser)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--selector', type=Path)
    parser.add_argument('--idf', type=Path, default=ROOT/'work/esp-idf')
    parser.add_argument('--stock-idf', type=Path, default=ROOT/'work/esp-idf-stock-v5.5.4')
    args = parser.parse_args()
    try:
        report = check(args)
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'Preflight evidence refused: {error}')
    print(json.dumps(report, indent=2))
    sys.exit(0 if report.get('protectedBytesMatch', report['exactExpectedBytes']) else 2)
