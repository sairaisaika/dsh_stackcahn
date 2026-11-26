"""Verify shortcut enrollment and offline selection on an ESP32-S3 Flash copy."""
import argparse
import json
from pathlib import Path
import shutil
import struct

from app_center_baseline import A, B, OTA, review_app_center, reviewed_partition_csv
from audit_agent_qemu import OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, boot, default_efuse
from audit_app_center_ota_writer import expected_select, symbol
from check_agent_preflight import read_snapshot
from check_stock_nvs import compare_stock_nvs
from prepare_agent_bundle import APP_OFFSET, EXPECTED_PARTITIONS, ROOT, SECTOR, TABLE_OFFSET
from prepare_installation import image_info, sha


SOURCE = ROOT/'contributions/m5stack-app-center-shortcut/tests/esp'
HELPERS = ('app_center_reopen.h', 'app_center_dsh_shortcut.h')
PROJECT = 'sion-dsh-shortcut-probe'


def prepare(args):
    shutil.copytree(SOURCE, args.source)
    for name in HELPERS:
        shutil.copyfile(args.stock/'firmware/main/hal'/name, args.source/'main'/name)
    (args.source/'partitions.csv').write_text(reviewed_partition_csv())


def audit(args):
    if args.output.exists():
        raise ValueError('Choose a new report path')
    for path in SOURCE.rglob('*'):
        if path.is_file() and path.read_bytes() != (args.source/path.relative_to(SOURCE)).read_bytes():
            raise ValueError('Target-side fixture source does not match')
    for name in HELPERS:
        if (args.stock/'firmware/main/hal'/name).read_bytes() != (args.source/'main'/name).read_bytes():
            raise ValueError('Probe must use the same shortcut helper as the launcher')
    original = read_snapshot(args.backup).data
    baseline = review_app_center(original)
    if baseline.stock_slot != 'ota_1':
        raise ValueError('This rehearsal starts with the historical factory in B')
    build = args.source/'build'
    probe = (build/(PROJECT+'.bin')).read_bytes()
    elf = build/(PROJECT+'.elf')
    candidate = args.agent.read_bytes()
    probe_info = image_info(probe)
    info = image_info(candidate)
    project = json.loads((build/'project_description.json').read_text())
    slot_limit = min(EXPECTED_PARTITIONS[slot][3] for slot in ('ota_0', 'ota_1'))
    if (max(len(probe), len(candidate)) > slot_limit or
            probe_info['imageBytes'] != len(probe) or probe_info['project'] != PROJECT or
            probe_info['idf'] != image_info(baseline.stock)['idf'] or
            Path(project['idf_path']).resolve() != args.idf or
            (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff') != baseline.table or
            info['imageBytes'] != len(candidate) or info['project'] != 'stack-chan' or
            not info['version'].startswith('dsh-agent-v')):
        raise ValueError('Wrong target fixture or candidate image')
    _, _, nvs, size = EXPECTED_PARTITIONS['nvs']
    end_nvs = nvs+size
    done = symbol(args.nm, elf, 'sion_shortcut_probe_done')
    efuse = default_efuse(args.idf)

    def exercise(factory_slot, agent_slot, selection, sequence, base):
        orientation = 'factory-a' if factory_slot == A else 'factory-b'

        def step(label, flash, endpoint, expected_slots, marker=None):
            slots, uart, observed, _ = boot(f'{orientation}-{label}', 'stock', flash, efuse,
                                            endpoint, args.qemu, args.gdb, elf)
            if slots != expected_slots or (marker and f'SION-SHORTCUT {marker}' not in uart):
                raise ValueError(f'{orientation}-{label}: unexpected selection or shortcut result\n{uart[-1200:]}')
            return observed

        base[agent_slot:agent_slot+len(candidate)] = candidate
        base[factory_slot:factory_slot+len(probe)] = probe
        base[nvs:end_nvs] = b'\xff'*size
        base[selection:selection+SECTOR] = expected_select(base, selection, sequence, OTA_ABORTED)
        base[APP_OFFSET:APP_OFFSET+65] = b'S' + candidate[-32:].hex().encode()
        seeded = step('seed-unrelated-nvs', base, done, [factory_slot], 'seeded')
        if seeded[:nvs] != base[:nvs] or seeded[end_nvs:] != base[end_nvs:] or seeded[nvs:end_nvs] == base[nvs:end_nvs]:
            raise ValueError('Seeding must change only the synthetic NVS')
        fixture = bytearray(seeded)
        fixture[APP_OFFSET] = ord('O')

        no_record = step('open-before-enrollment', fixture, done, [factory_slot], 'absent')
        if no_record != fixture:
            raise ValueError('Opening without a shortcut must not change Flash')

        enroll = bytearray(fixture)
        enroll[APP_OFFSET] = ord('I')
        enrolled = step('remember-an-explicit-open', enroll, done, [factory_slot], 'enrolled')
        expected = bytearray(enroll)
        expected[selection:selection+SECTOR] = expected_select(enroll, selection, sequence, OTA_NEW)
        if (enrolled[:nvs] != expected[:nvs] or enrolled[end_nvs:] != expected[end_nvs:] or
                enrolled[nvs:end_nvs] == expected[nvs:end_nvs]):
            raise ValueError('Enrollment must change only the OTA record and the synthetic NVS')

        config_review = compare_stock_nvs(fixture[nvs:end_nvs], enrolled[nvs:end_nvs], args.stock_idf)
        if (config_review['status'] != 'only-shortcut-settings-changed' or
                config_review['managedKeysChanged'] != ['app_dsh_menu/launch_v1']):
            raise ValueError('Enrollment changed settings outside the expected shortcut record')

        pending = step('candidate-boot', enrolled, struct.unpack_from('<I', candidate, 4)[0], [agent_slot])
        expected = bytearray(enrolled)
        expected[selection:selection+SECTOR] = expected_select(enrolled, selection, sequence, OTA_PENDING_VERIFY)
        if pending != expected:
            raise ValueError('Unexpected readback at the candidate entry')
        restored = step('return-after-unconfirmed-trial', pending, struct.unpack_from('<I', probe, 4)[0], [factory_slot])
        expected[selection:selection+SECTOR] = expected_select(pending, selection, sequence, OTA_ABORTED)
        if restored != expected:
            raise ValueError('Returning to the main image must preserve the shortcut record')

        after_return = bytearray(restored)
        after_return[APP_OFFSET] = ord('O')
        opened = step('offline-shortcut-after-return', after_return, done, [factory_slot], 'opened')
        expected = bytearray(after_return)
        expected[selection:selection+SECTOR] = expected_select(after_return, selection, sequence, OTA_NEW)
        if opened != expected:
            raise ValueError('Offline shortcut must write only the OTA selection record')

        corrupt = bytearray(after_return)
        corrupt[agent_slot+len(candidate)-1] ^= 1
        if step('offline-shortcut-refuses-replacement', corrupt, done, [factory_slot], 'mismatch') != corrupt:
            raise ValueError('Rejected image changed Flash')

        return {'factorySlot': hex(factory_slot), 'candidateSlot': hex(agent_slot),
                'unrelatedSettingsReadable': True, 'wholeFlashMatched': True,
                'factoryNvsComparison': config_review}

    active = OTA+baseline.active_record_sector*SECTOR
    inactive = OTA+(1-baseline.active_record_sector)*SECTOR
    next_sequence = baseline.active_sequence+1
    swapped = bytearray(original)
    # Simulate a factory update which has booted and been confirmed in A.
    swapped[inactive:inactive+SECTOR] = expected_select(swapped, inactive, next_sequence, OTA_VALID)
    orientations = [
        exercise(B, A, inactive, next_sequence, bytearray(original)),
        exercise(A, B, active, next_sequence+1, swapped),
    ]
    if read_snapshot(args.backup).data != original:
        raise ValueError('Saved capture changed during rehearsal')

    report = {'deviceAccess': False, 'installable': False, 'candidateSha256': sha(candidate), 'probeSha256': sha(probe),
              'productionBootloaderSha256': sha(original[:TABLE_OFFSET]), 'offlineSelectionPersistedAcrossReboot': True,
              'invalidImageRefused': True, 'configuredNvsUnchangedAtShortcutOpen': True, 'orientations': orientations}
    with args.output.open('x') as output:
        output.write(json.dumps(report, indent=2)+'\n')
    print('Both slots passed ESP32-S3 enrollment, cold return, offline selection and invalid-image refusal.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    for label, handler, options in (
            ('prepare', prepare, ('stock', 'source')),
            ('audit', audit, ('stock', 'source', 'backup', 'idf', 'qemu', 'gdb', 'nm', 'agent', 'output'))):
        command = commands.add_parser(label)
        for option in options:
            command.add_argument('--'+option, type=lambda path: Path(path).resolve(), required=True)
        if label == 'audit':
            command.add_argument('--stock-idf', type=lambda path: Path(path).resolve(), default=ROOT/'work/esp-idf-stock-v5.5.4')
        command.set_defaults(run=handler)
    args = parser.parse_args()
    args.run(args)
