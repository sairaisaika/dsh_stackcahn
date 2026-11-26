"""Prepare and rehearse a specifically selected Sion candidate using saved backups only."""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path

from audit_agent_layout import ROOT, TABLE_OFFSET, TABLE_END, pinned_partition_tool, validated_layout
from inspect_backup import inspect
from prepare_installation import image_info, ota_records, sha
from review_agent_capacity import aligned, capacity, require

SECTOR = 0x1000
FLASH_SIZE = 0x1000000
APP_OFFSET, CONFIG_OFFSET = 0xe10000, 0xffc000
EXPECTED_PARTITIONS = {
    # (type, subtype, offset, bytes). Snapshot flags must all be zero.
    'nvs': (1, 2, 0x9000, 0x4000),
    'otadata': (1, 0, 0xd000, 0x2000),
    'phy_init': (1, 1, 0xf000, 0x1000),
    'ota_0': (0, 0x10, 0x20000, 0x4f0000),
    'ota_1': (0, 0x11, 0x510000, 0x4f0000),
    'assets': (1, 0x82, 0xa00000, 0x400000),
    'coredump': (1, 3, 0xe00000, 0x10000),
}
# Candidate selection is explicit and limited to reviewed source/build pairs.
CANDIDATES = {
    'v24': ('independent-factory-return-v24', 'agent-factory-return-build.json', 'firmware-agent-factory-return-v24'),
    'v26': ('independent-light-ring-v26', 'agent-light-ring-build.json', 'firmware-agent-light-ring-v26'),
    'v28': ('independent-usb-audio-v28', 'agent-usb-audio-build.json', 'firmware-agent-usb-audio-v28-final'),
    'v29': ('independent-cue-trim-v29', 'agent-sdk-trim-build.json', 'firmware-agent-cue-trim-v29-final'),
    'v30': ('independent-fish-avatar-v30', 'agent-appearance-build.json', 'firmware-agent-fish-avatar-v30'),
    'v31': ('independent-captions-v31', 'agent-captions-build.json', 'firmware-agent-captions-v31-final'),
    'v32': ('independent-caption-font-v32', 'agent-caption-font-build.json', 'firmware-agent-caption-font-v32'),
    'v35': ('independent-relay-provision-v35', 'agent-relay-provision-build.json', 'firmware-agent-relay-provision-v35'),
}
DEFAULT_BOOT = ROOT/'work/agent-selector-v2-stock-final/build/bootloader/bootloader.bin'
BOOT_RECEIPT = ROOT/'firmware/agent-selector-stock-build.json'
STOCK_LOCK = ROOT/'firmware/boot-selector/stock-sdk.lock.json'
SELECTOR_VARIANTS = {
    'grove': (DEFAULT_BOOT, BOOT_RECEIPT, 'independent-boot-selector-v2-stock-base'),
    'usb-entry-experiment': (
        ROOT/'work/v35-usb-entry-roundtrip/selector/build/bootloader/bootloader.bin',
        ROOT/'firmware/agent-selector-usb-entry-build.json',
        'independent-boot-selector-usb-entry-experiment',
    ),
}


@dataclass(frozen=True)
class ImageWrite:
    file: str
    offset: int
    payload: bytes

    @property
    def end(self):
        return self.offset + len(self.payload)

    def record(self, baseline):
        return {
            'file': self.file, 'offset': hex(self.offset),
            'endExclusive': hex(self.end), 'bytes': len(self.payload),
            'beforeSha256': sha(baseline[self.offset:self.end]),
            'expectedReadbackSha256': sha(self.payload),
        }


def pad_sectors(data, size=None):
    if size is None:
        size = aligned(len(data), SECTOR)
    require(len(data) <= size and size % SECTOR == 0, 'Invalid whole-sector payload')
    return data.ljust(size, b'\xff')


def validate_writes(install, restore):
    require(len(install) == 3 and len(restore) == 2, 'Unexpected staged write count')
    app, table, boot = install
    require(app.offset == APP_OFFSET and app.end <= CONFIG_OFFSET and app.end > APP_OFFSET and
            table.offset == TABLE_OFFSET and table.end == TABLE_END and
            boot.offset == 0 and 0 < boot.end <= TABLE_OFFSET, 'Write outside reviewed spans')
    require(all(w.end % SECTOR == 0 for w in (*install, *restore)) and
            [(w.offset, w.end) for w in restore] == [(table.offset, table.end), (boot.offset, boot.end)],
            'Recovery geometry does not match install sectors')


def require_unchanged_outside(before, after, writes):
    edge = 0
    for write in sorted(writes, key=lambda w: w.offset):
        require(before[edge:write.offset] == after[edge:write.offset], 'Unexpected bytes changed')
        edge = write.end
    require(before[edge:] == after[edge:], 'Unexpected bytes changed after final write')


def apply(flash, write):
    flash[write.offset:write.end] = write.payload
    require(flash[write.offset:write.end] == write.payload, 'Simulated exact readback failed')


def interrupted_write(flash, write):
    """Simulate erase followed by incomplete programming of the target span."""
    torn = flash.copy()
    torn[write.offset:write.end] = b'\xff' * len(write.payload)
    torn[write.offset:write.offset+32] = write.payload[:32]
    return torn


def rehearse(baseline, install, restore):
    validate_writes(install, restore)
    require(all(w.payload == baseline[w.offset:w.end] for w in restore),
            'Recovery bytes differ from historical snapshot')

    state = bytearray(baseline)
    interruptions = []
    for write in install:
        # Model a sector erase and incomplete programming. Recovery is from
        # ROM maintenance, not by assuming the damaged state can boot.
        torn = interrupted_write(state, write)
        require_unchanged_outside(baseline, torn, install)
        for original in restore:
            apply(torn, original)
        require_unchanged_outside(baseline, torn, install[:1])
        interruptions.append(write.file)

        apply(state, write)
        require_unchanged_outside(baseline, state, install)

    installed = bytes(state)
    # Future factory or DSH use could legitimately change data. This rehearsal
    # proves the metadata-only restore does not copy back a stale snapshot.
    for name in ('nvs', 'otadata', 'ota_0', 'assets'):
        state[EXPECTED_PARTITIONS[name][2]] ^= 1
    state[CONFIG_OFFSET] ^= 1
    later = bytes(state)
    for original in restore:
        apply(state, original)
    require_unchanged_outside(later, state, restore)
    require(state[:TABLE_END] == baseline[:TABLE_END], 'Original boot and table did not restore')
    return installed, interruptions


def checked_image(path, receipt, artifact):
    image = path.read_bytes()
    require(receipt['artifacts'][artifact] == {'bytes': len(image), 'sha256': sha(image)},
            f'{artifact} differs from the checked build receipt')
    info = image_info(image)
    require(info['imageBytes'] == len(image), f'{artifact} has invalid trailing bytes')
    return image, info


def candidate_option(parser):
    parser.add_argument('--candidate', choices=CANDIDATES, default='v24',
                        help='Select the version recorded in the reviewed manifest')


def selector_option(parser):
    parser.add_argument('--selector-variant', choices=SELECTOR_VARIANTS, default='grove',
                        help='Use the reviewed Grove selector or the separately reviewed v35 USB trial')


def prepare(backup_dir, app_path, boot_path, idf, stock_idf, *, candidate='v24', selector_variant='grove'):
    require(candidate in CANDIDATES, 'Unsupported candidate version')
    require(selector_variant in SELECTOR_VARIANTS and (selector_variant == 'grove' or candidate == 'v35'),
            'USB selector trial requires the v35 application')
    default_boot, boot_receipt_path, selector_profile = SELECTOR_VARIANTS[selector_variant]
    profile, receipt_name, build_name = CANDIDATES[candidate]
    receipt_path = ROOT/'firmware'/receipt_name
    if app_path is None:
        app_path = ROOT/'work'/build_name/'firmware/build/stack-chan.bin'
    baseline_path = backup_dir/'flash-A.bin'
    baseline = baseline_path.read_bytes()
    backup_receipt = json.loads((backup_dir/'verification.json').read_text())
    require(len(baseline) == FLASH_SIZE and baseline == (backup_dir/'flash-B.bin').read_bytes() and
            sha(baseline) == backup_receipt['sha256'], 'Backup copies or receipt differ')
    security = (backup_dir/'security-info.txt').read_bytes()
    lines = security.decode().splitlines()
    for entry in ('Secure Boot: Disabled', 'Flash Encryption: Disabled'):
        key = entry.split(':')[0]+':'
        require([line.strip() for line in lines if line.strip().startswith(key)] == [entry],
                'Saved security profile differs from the reviewed device')
    parsed = inspect(baseline_path)
    require(parsed['sha256'] == sha(baseline), 'Backup changed during inspection')
    old = parsed['partitions']
    require(len(old) == len(EXPECTED_PARTITIONS) and all(p['flags'] == 0 for p in old) and
            {p['label']: (p['type'], p['subtype'], int(p['offset'], 16), p['bytes']) for p in old}
            == EXPECTED_PARTITIONS, 'Original partition layout differs from selection policy')
    ota = ota_records(baseline[0xd000:0xf000])
    require(ota == [
        {'sector': 0, 'sequence': 3, 'state': 4, 'valid': False},
        {'sector': 1, 'sequence': 2, 'state': 2, 'valid': True},
    ], 'Saved factory selection differs from the reviewed snapshot')

    original_boot = image_info(baseline[:TABLE_OFFSET])
    original_a = image_info(baseline[0x20000:0x510000])
    original_b = image_info(baseline[0x510000:0xa00000])
    require(original_a.get('idf') == 'v5.5.4' and original_b.get('version') == '1.6.2' and
            original_b.get('project') == 'stack-chan', 'Original A/B images differ from the reviewed profile')
    receipt_bytes = receipt_path.read_bytes()
    app_receipt = json.loads(receipt_bytes)
    boot_receipt_bytes = boot_receipt_path.read_bytes()
    boot_receipt = json.loads(boot_receipt_bytes)
    stock = json.loads(STOCK_LOCK.read_text())
    require(app_receipt['profile'] == profile and app_receipt['appVersion'] == 'dsh-agent-'+candidate and
            boot_receipt['profile'] == selector_profile and
            boot_receipt['stockSdkBase'] and boot_receipt['idf'] == stock['commit'],
            'Expected the selected reviewed application and stock SDK selector')
    app, app_info = checked_image(app_path, app_receipt, 'stack-chan.bin')
    boot, boot_info = checked_image(default_boot if boot_path is None else boot_path, boot_receipt, 'bootloader.bin')
    if selector_variant != 'grove':
        require(all(sha((ROOT/name).read_bytes()) == expected for name, expected in boot_receipt['inputs'].items()),
                'USB selector patch or its frozen base changed')
    require(app_info.get('project') == 'stack-chan' and app_info.get('version') == app_receipt['appVersion'],
            'Independent image identity mismatch')
    for field in ('flashMode', 'flashSizeFreq'):
        require(original_boot[field] == boot_info[field] and original_b[field] == app_info[field],
                'Candidate Flash header differs from the saved original')

    layout = capacity(len(baseline), old, len(app))
    tool = pinned_partition_tool(idf, app_receipt['idf'])
    table, _, preserved = validated_layout(baseline, layout, tool)
    stock_tool = pinned_partition_tool(stock_idf, stock['commit'])
    stock_table, _, _ = validated_layout(baseline, layout, stock_tool)
    require(table == stock_table, 'Pinned SDKs disagree on candidate sector bytes')

    boot_bytes = aligned(max(original_boot['imageBytes'], len(boot)), SECTOR)
    require(baseline[original_boot['imageBytes']:TABLE_OFFSET].count(0xff) ==
            TABLE_OFFSET-original_boot['imageBytes'], 'Unexpected content after original bootloader')
    install = [
        ImageWrite('stage-1-agent.bin', APP_OFFSET, pad_sectors(app)),
        ImageWrite('stage-2-partitions.bin', TABLE_OFFSET, table),
        ImageWrite('stage-3-selector.bin', 0, pad_sectors(boot, boot_bytes)),
    ]
    restore = [
        ImageWrite('restore-1-partitions.bin', TABLE_OFFSET, baseline[TABLE_OFFSET:TABLE_END]),
        ImageWrite('restore-2-bootloader.bin', 0, baseline[:boot_bytes]),
    ]
    installed, interruptions = rehearse(baseline, install, restore)
    manifest = {
        'schemaVersion': 1,
        'status': 'offline-review-only',
        'flashAuthorized': False, 'installable': False, 'deviceAccess': False, 'hardwareValidated': False,
        'savedBaselineSha256': sha(baseline), 'savedSecurityEvidenceSha256': sha(security),
        'applicationBuildReceiptSha256': sha(receipt_bytes),
        'selectorBuildReceiptSha256': sha(boot_receipt_bytes),
        'appVersion': app_receipt['appVersion'], 'selectorSDK': stock['release'],
        'sectorBytes': SECTOR, 'originalTableRowsPreserved': preserved,
        'remainingAlignedBytes': layout['remainingBytes'],
        'preservedPartitions': [{k: p[k] for k in ('label', 'offset', 'bytes', 'sha256')} for p in old],
        'installInOrder': [w.record(baseline) for w in install],
        'restoreInOrder': [
            {k: v for k, v in w.record(installed).items() if k != 'beforeSha256'} for w in restore
        ],
        'rehearsal': {'interruptedStagesRestoredFromRomModel': interruptions,
                      'laterOriginalAndAgentChangesRetained': True},
        'pending': ['Fresh same-device read-only baseline and security verification',
                    'Physical Grove input and ROM recovery access',
                    'Explicit approval of exact operations',
                    'Real original voice, binding, local conversation and rollback tests'],
    }
    if selector_variant != 'grove':
        manifest['selectorVariant'] = selector_variant
        manifest['pending'][1] = 'Physical USB startup timing and ROM recovery access'
    return install + restore, manifest


def write_private_bundle(destination, files, manifest):
    private = ROOT/'.local'
    require(private.resolve() == private and destination.is_relative_to(private) and destination != private,
            'Bundle must be inside this checkout’s private .local directory')
    old_mask = os.umask(0o077)
    try:
        destination.mkdir(mode=0o700)
        for entry in files:
            with (destination/entry.file).open('xb') as output:
                output.write(entry.payload)
        with (destination/'manifest.json').open('x') as output:
            output.write(json.dumps(manifest, indent=2)+'\n')
    finally:
        os.umask(old_mask)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('backup-dir', 'output'):
        parser.add_argument('--'+name, type=Path, required=True)
    candidate_option(parser)
    selector_option(parser)
    parser.add_argument('--selector', type=Path)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--idf', type=Path, default=ROOT/'work/esp-idf')
    parser.add_argument('--stock-idf', type=Path, default=ROOT/'work/esp-idf-stock-v5.5.4')
    args = parser.parse_args()
    files, manifest = prepare(args.backup_dir, args.app, args.selector, args.idf, args.stock_idf,
                              candidate=args.candidate, selector_variant=args.selector_variant)
    write_private_bundle(args.output.resolve(), files, manifest)
    print('Private offline review bundle written; no device access or authorization.')
