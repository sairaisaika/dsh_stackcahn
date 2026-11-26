"""Rehearse the menu candidate on a saved double read. Emit only an offline report."""
import argparse
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace

from audit_agent_layout import pinned_partition_tool, validated_layout
from audit_agent_menu_qemu import boot_case, fixture_addresses
from audit_agent_qemu import A, B, OTA, OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, boot, default_efuse, ota_record
from check_agent_preflight import read_snapshot
from inspect_backup import inspect
from prepare_agent_bundle import (APP_OFFSET, EXPECTED_PARTITIONS, SECTOR, TABLE_END, TABLE_OFFSET,
                                  ImageWrite, apply, interrupted_write, pad_sectors, require_unchanged_outside)
from prepare_agent_menu import ROOT, verify_menu
from prepare_installation import image_info, ota_records, sha
from review_agent_capacity import aligned, capacity, require

REVIEWED_AGENTS = {
    'dsh-agent-v40-menu': ('agent-head-touch-build.json', 'qemu-v40'),
    'dsh-agent-v41-menu': ('agent-power-state-build.json', 'qemu-v41'),
    'dsh-agent-v43-menu': ('agent-face-touch-build.json', 'qemu-v43'),
    'dsh-agent-v44-menu': ('agent-head-gestures-build.json', 'qemu-v44'),
    'dsh-agent-v45-menu': ('agent-interaction-feedback-build.json', 'qemu-v45'),
    'dsh-agent-v46-menu': ('agent-asset-diagnostics-build.json', 'qemu-v46'),
    'dsh-agent-v47-menu': ('agent-text-controls-build.json', 'qemu-v47'),
    'dsh-agent-v48-menu': ('agent-usb-standby-build.json', 'qemu-v48'),
    'dsh-agent-v49-menu': ('agent-head-touch-filter-build.json', 'qemu-v49'),
    'dsh-agent-v50-menu': ('agent-optional-lan-build.json', 'qemu-v50'),
    'dsh-agent-v51-menu': ('agent-head-touch-rearm-build.json', 'qemu-v51'),
}


def checked_stages(backup, baseline, menu_source, selector, agent, idf, stock_idf, agent_version):
    verify_menu(menu_source)
    stock = (menu_source/'stock/firmware/build/stack-chan.bin').read_bytes()
    loader = (selector/'bootloader.bin').read_bytes()
    independent = agent.read_bytes()
    receipt, handoff = REVIEWED_AGENTS[agent_version]
    compiled = json.loads((ROOT/'firmware'/receipt).read_text())
    tested = json.loads((menu_source/handoff/'result.json').read_text())
    digests = {'publicMenu': sha(stock), 'selector': sha(loader), 'independentAgent': sha(independent)}
    require(tested['publicMenuSha256'] == digests['publicMenu'] and tested['selectorSha256'] == digests['selector'] and
            tested['dshSha256'] == digests['independentAgent'] == compiled['artifacts']['stack-chan.bin']['sha256'],
            'Expected the exact tested menu, selector and selected independent image')

    inspected = inspect(backup/'flash-A.bin')
    old = inspected['partitions']
    require(inspected['sha256'] == sha(baseline) and len(old) == len(EXPECTED_PARTITIONS) and
            {part['label']: (part['type'], part['subtype'], int(part['offset'], 16), part['bytes'])
             for part in old} == EXPECTED_PARTITIONS and all(part['flags'] == 0 for part in old),
            'Saved factory layout differs from the reviewed profile')
    require(ota_records(baseline[OTA:OTA+2*SECTOR]) == [
        {'sector': 0, 'sequence': 3, 'state': OTA_ABORTED, 'valid': False},
        {'sector': 1, 'sequence': 2, 'state': OTA_VALID, 'valid': True},
    ], 'Expected an aborted A and a confirmed original B')
    original_loader = image_info(baseline[:TABLE_OFFSET])
    original_a = image_info(baseline[A:B])
    original_b = image_info(baseline[B:B+EXPECTED_PARTITIONS['ota_1'][3]])
    menu_info, agent_info, loader_info = (image_info(data) for data in (stock, independent, loader))
    require(original_a.get('project') == 'ir_remote' and original_b.get('project') == 'stack-chan' and
            original_b.get('version') == menu_info.get('version') == '1.6.2' and
            menu_info.get('project') == 'stack-chan' and agent_info.get('version') == agent_version == compiled['appVersion'],
            'Unexpected original or candidate application identity')
    boot_end = aligned(max(original_loader['imageBytes'], len(loader)), SECTOR)
    require(boot_end <= TABLE_OFFSET and len(loader) == loader_info['imageBytes'] and
            len(stock) == menu_info['imageBytes'] and len(stock) <= B-A and
            len(independent) == agent_info['imageBytes'], 'Image size mismatch')
    for field in ('flashMode', 'flashSizeFreq'):
        require(loader_info[field] == original_loader[field] and
                original_b[field] == menu_info[field] == agent_info[field], 'Candidate Flash mode mismatch')

    available = capacity(len(baseline), old, len(independent))
    table, _, rows = validated_layout(baseline, available, pinned_partition_tool(idf, compiled['idf']))
    stock_sdk = json.loads((ROOT/'firmware/boot-selector/stock-sdk.lock.json').read_text())['commit']
    stock_table, _, _ = validated_layout(baseline, available, pinned_partition_tool(stock_idf, stock_sdk))
    require(table == stock_table, 'The pinned SDKs produced different table bytes')
    install = [
        ImageWrite('dsh-agent', APP_OFFSET, pad_sectors(independent)),
        ImageWrite('menu-in-inactive-a', A, pad_sectors(stock)),
        ImageWrite('partition-table', TABLE_OFFSET, table),
        ImageWrite('second-stage-selector', 0, pad_sectors(loader, boot_end)),
        ImageWrite('select-a-as-new', OTA, pad_sectors(ota_record(3, OTA_NEW))),
    ]
    return install, old, rows, available['remainingBytes'], digests


def rehearse_stages(baseline, stages):
    spans = sorted((stage.offset, stage.end) for stage in stages)
    require(all(start % SECTOR == end % SECTOR == 0 and 0 <= start < end <= len(baseline)
                for start, end in spans) and all(a[1] <= b[0] for a, b in zip(spans, spans[1:])),
            'Install writes must be disjoint whole sectors')
    by_name = {stage.file: stage for stage in stages}
    restore = []
    for name in ('select-a-as-new', 'partition-table', 'second-stage-selector', 'menu-in-inactive-a', 'dsh-agent'):
        stage = by_name[name]
        restore.append(ImageWrite(name, stage.offset, baseline[stage.offset:stage.end]))

    def check_restore(state):
        require_unchanged_outside(baseline, state, stages)
        for region in restore:
            apply(state, region)
        require(state == baseline, 'Recovery did not reproduce the original full read')
        return state

    state = bytearray(baseline)
    for stage in stages:
        check_restore(interrupted_write(state, stage))
        apply(state, stage)
    after = state.copy()
    for step in restore:
        check_restore(interrupted_write(after, step))
        apply(after, step)
    require(after == baseline, 'Completed recovery differs from full read')
    return state, restore, check_restore


def simulate(args, temp, baseline, installed, check_restore):
    elf = args.selector/'bootloader.elf'
    efuse = default_efuse(args.idf)
    fixture = fixture_addresses(args.objdump, elf)
    efuse_path = temp/'efuse.bin'
    efuse_path.write_bytes(efuse)
    local = SimpleNamespace(output=temp, qemu=args.qemu, gdb=args.gdb, selector=args.selector)
    cases = {}

    def cold(name, virtual, offset):
        endpoint = struct.unpack_from('<I', virtual, offset+4)[0]
        loaded, _, readback, _ = boot(name, 'stock', virtual, efuse, endpoint, args.qemu, args.gdb, elf)
        require(loaded == [offset] and readback == virtual, f'{name}: boot or readback differs')
        cases[name] = {'partition': hex(offset), 'virtualFlashUnchanged': True}

    def menu(name, virtual, request, offset, *, ready=0, ota_after=None, corrupt=False):
        transition = None if ota_after is None else (OTA, 3, ota_after)
        cases[name] = boot_case(local, efuse_path, virtual, fixture, name, 12 if request else 1,
                                request, offset, ready, corrupt=corrupt, ota_transition=transition)
        path = temp/name/'flash.bin'
        readback = bytearray(path.read_bytes())
        path.unlink()
        return readback

    cold('original-baseline', baseline, B)
    staged = installed.copy()
    staged[OTA:OTA+SECTOR] = baseline[OTA:OTA+SECTOR]
    cold('before-selecting-menu-original-still-boots', staged, B)
    pending = menu('menu-first-boot', installed, 0, A, ota_after=OTA_PENDING_VERIFY)
    menu('restart-before-menu-confirmation', pending, 1, B, ota_after=OTA_ABORTED)

    # The real application owns confirmation. This models the later state
    # after confirmation without running live settings, Wi-Fi or cloud code.
    pending[OTA:OTA+32] = ota_record(3, OTA_VALID)
    entered = menu('confirmed-menu-enters-dsh', pending, 1, APP_OFFSET)
    returned = menu('home-returns-to-the-same-menu', entered, 2, A, ready=3)
    menu('same-menu-reenters-dsh', returned, 1, APP_OFFSET)
    menu('damaged-dsh-returns-to-confirmed-menu', returned, 1, A, corrupt=True)
    cold('exact-original-after-full-recovery', check_restore(returned), B)
    return cases


def audit(args):
    require(not args.output.exists(), 'Choose a new report path')
    baseline = read_snapshot(args.backup).data
    stages, old, rows, remaining, digests = checked_stages(
        args.backup, baseline, args.menu_source, args.selector, args.agent, args.idf, args.stock_idf,
        args.agent_version)
    installed, restore, check_restore = rehearse_stages(baseline, stages)
    with tempfile.TemporaryDirectory(prefix='sion-menu-recovery-') as temporary:
        cases = simulate(args, Path(temporary), baseline, installed, check_restore)
    require(read_snapshot(args.backup).data == baseline, 'Backup changed during offline rehearsals')

    def region(stage):
        return {'region': stage.file, 'offset': hex(stage.offset), 'endExclusive': hex(stage.end),
                'bytes': len(stage.payload)}

    report = {
        'deviceAccess': False, 'installable': False, 'containsFlashPayloads': False,
        'historicalBackupSha256': sha(baseline), 'originalPartitionRowsPreserved': rows,
        'agentVersion': args.agent_version,
        'testedImageSha256': digests,
        'independentAlignedBytesRemaining': remaining,
        'simulatedWriteOrder': [region(stage) for stage in stages],
        'simulatedRecoveryOrder': [region(stage) for stage in restore],
        'preservedOriginalPartitions': [part['label'] for part in old
                                        if part['label'] not in ('otadata', 'ota_0')],
        'partialInstallStagesRecovered': len(stages), 'partialRecoveryStagesRecovered': len(restore),
        'restoredFlashMatchesBackup': True, 'modeledApplicationConfirmation': True,
        'qemuAtApplicationEntry': cases,
    }
    with args.output.open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(f'{len(cases)} QEMU handoffs and {len(stages)+len(restore)} interrupted-stage recoveries passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('backup', 'menu-source', 'selector', 'agent', 'idf', 'stock-idf', 'qemu', 'gdb', 'objdump', 'output'):
        parser.add_argument('--'+argument, type=lambda path: Path(path).resolve(), required=True)
    parser.add_argument('--agent-version', choices=REVIEWED_AGENTS, default='dsh-agent-v40-menu')
    audit(parser.parse_args())
