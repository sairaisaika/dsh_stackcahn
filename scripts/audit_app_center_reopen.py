"""Rehearse reselecting an installed image on verified virtual Flash copies."""
import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess

from app_center_baseline import reviewed_firmware, reviewed_partition_csv
from audit_agent_qemu import A, APP_OFFSET, B, OTA, OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY
from audit_agent_qemu import boot, default_efuse, ota_record
from audit_app_center_ota_writer import expected_select, symbol
from check_agent_preflight import read_snapshot
from prepare_agent import APP_CENTER_VERSION, verify
from prepare_agent_bundle import ROOT, SECTOR, TABLE_OFFSET
from prepare_installation import image_info, ota_records, sha


FIXTURE = ROOT/'firmware/tests/app-center-reopen'
APP = 'sion-app-center-reopen-probe'
HELPER = 'firmware/main/hal/app_center_reopen.h'
MARKER = 0x4f50454e


def prepare(args):
    shutil.copytree(FIXTURE, args.source)
    shutil.copyfile(args.stock/HELPER, args.source/'main/app_center_reopen.h')
    (args.source/'partitions.csv').write_text(reviewed_partition_csv())


def audit(args):
    if args.output.exists():
        raise ValueError('Choose a new report path')
    lock = json.loads((ROOT/'firmware/upstream.lock.json').read_text())
    checkout = subprocess.check_output(['git', '-C', str(args.stock), 'rev-parse', 'HEAD'], text=True).strip()
    if checkout != lock['official']['commit']:
        raise ValueError('Expected the locked public StackChan checkout')
    for path in FIXTURE.rglob('*'):
        if path.is_file() and path.read_bytes() != (args.source/path.relative_to(FIXTURE)).read_bytes():
            raise ValueError(f'Probe source differs: {path.name}')
    helper = (args.stock/HELPER).read_bytes()
    if (args.source/'main/app_center_reopen.h').read_bytes() != helper:
        raise ValueError('The probe must exercise the same helper as App Center')

    start, stock = reviewed_firmware(args.backup)
    original = read_snapshot(args.backup).data
    if original[:len(start)] != start or original[B:B+len(stock)] != stock:
        raise ValueError('Saved factory image differs from the reviewed read')
    sdk = image_info(stock)['idf']
    build = args.source/'build'
    probe = (build/(APP+'.bin')).read_bytes()
    elf = build/(APP+'.elf')
    info = image_info(probe)
    description = json.loads((build/'project_description.json').read_text())
    if (info['project'] != APP or info['idf'] != sdk or sdk != lock['idf']['tag'] or
            Path(description['idf_path']).resolve() != args.idf or
            (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff') != start[TABLE_OFFSET:]):
        raise ValueError('Probe and factory app must use the locked SDK and reviewed partition layout')

    prepared = verify(args.agent_source)
    receipt = json.loads((args.agent_source/'.agent-build.json').read_text())
    candidate = (args.agent_source/'firmware/build/stack-chan.bin').read_bytes()
    candidate_info = image_info(candidate)
    if (not prepared.get('appCenter') or prepared['appVersion'] != APP_CENTER_VERSION or
            candidate_info['version'] != APP_CENTER_VERSION or candidate_info['imageBytes'] != len(candidate) or
            receipt['preparedReceiptSha256'] != sha((args.agent_source/'.agent-prepared.json').read_bytes()) or
            receipt['artifacts']['stack-chan.bin']['sha256'] != sha(candidate)):
        raise ValueError('Expected the exact reviewed App Center image')
    digest = candidate[-32:].hex().encode()

    efuse = default_efuse(args.idf)
    endpoint = symbol(args.nm, elf, 'sion_reopen_probe_done')
    stock_entry = struct.unpack_from('<I', stock, 4)[0]
    agent_entry = struct.unpack_from('<I', candidate, 4)[0]
    saved_meta = ota_records(original[OTA:OTA+2*SECTOR])
    if saved_meta[0]['sequence'] != 3 or saved_meta[0]['state'] != OTA_ABORTED or saved_meta[1]['sequence'] != 2:
        raise ValueError('Expected the reviewed A=ABORTED and B=VALID OTA records')
    base = bytearray(original)
    base[A:A+len(candidate)] = candidate
    results = {}

    def reopen(name, before, expected, *, offered=digest, success=False, queued=False):
        fixture = bytearray(before)
        fixture[B:B+len(probe)] = probe
        request = struct.pack('<II64s', MARKER, int(queued), offered)
        fixture[APP_OFFSET:APP_OFFSET+len(request)] = request
        if expected is None:
            expected = bytearray(fixture)
        else:
            expected = bytearray(expected)
            expected[B:B+len(probe)] = probe
            expected[APP_OFFSET:APP_OFFSET+len(request)] = request
        loaded, serial, observed, _ = boot(name, 'stock', fixture, efuse, endpoint, args.qemu, args.gdb, elf)
        result = f'SION-REOPEN result={int(success)} selectCalls={int(success)}'
        if loaded != [B] or result not in serial or observed != expected:
            raise ValueError(f'{name}: unexpected selection or complete Flash readback')
        results[name] = {'selectedByReopen': success, 'wholeFlashMatched': True}
        return observed

    wrong = bytes([ord('0') if digest[0] != ord('0') else ord('1')]) + digest[1:]
    reopen('other-catalog-digest', base, None, offered=wrong)
    reopen('missing-catalog-digest', base, None, offered=b'')
    corrupted = bytearray(base)
    corrupted[A+len(candidate)-1] ^= 1
    reopen('corrupted-image', corrupted, None)
    erased = bytearray(base)
    erased[OTA:OTA+SECTOR] = b'\xff'*SECTOR
    reopen('no-candidate-ota-record', erased, None)

    factory_pending = bytearray(base)
    factory_pending[OTA+SECTOR:OTA+2*SECTOR] = expected_select(base, OTA+SECTOR, 2, OTA_NEW)
    pending_readback = bytearray(factory_pending)
    pending_readback[OTA+SECTOR:OTA+2*SECTOR] = expected_select(factory_pending, OTA+SECTOR, 2, OTA_PENDING_VERIFY)
    reopen('factory-confirmation-pending', factory_pending, pending_readback)

    selected = bytearray(base)
    selected[OTA:OTA+SECTOR] = expected_select(base, OTA, 3, OTA_NEW)
    reopen('another-update-already-selected', base, selected, queued=True)

    def handoff(name, flash, slot, address, stage):
        expected = bytearray(flash)
        expected[OTA:OTA+SECTOR] = expected_select(flash, OTA, 3, stage)
        loaded, _, observed, _ = boot(name, 'stock', flash, efuse, address, args.qemu, args.gdb, elf)
        if loaded != [slot] or observed != expected:
            raise ValueError(f'{name}: unexpected boot destination or Flash modifications')
        results[name] = {'slot': hex(slot), 'wholeFlashMatched': True}
        return expected

    before = base
    for attempt in (1, 2):
        observed = reopen(f'open-installed-{attempt}', before, selected, success=True)
        first_boot = bytearray(before)
        first_boot[OTA:OTA+SECTOR] = observed[OTA:OTA+SECTOR]
        pending = handoff(f'dsh-entry-{attempt}', first_boot, A, agent_entry, OTA_PENDING_VERIFY)
        before = handoff(f'factory-return-{attempt}', pending, B, stock_entry, OTA_ABORTED)
        if before != base:
            raise ValueError('The second Open must start with the same installed image and factory bytes')
    if read_snapshot(args.backup).data != original:
        raise ValueError('Saved backup changed during the test')

    report = {'deviceAccess': False, 'installable': False, 'publicAppCenterCommit': checkout,
              'helperSha256': sha(helper), 'candidateVersion': APP_CENTER_VERSION, 'candidateSha256': sha(candidate),
              'scope': 'App Center selection helper and original bootloader, not stock UI or catalog service',
              'successWriteSpan': [hex(OTA), hex(OTA+SECTOR)], 'results': results}
    with args.output.open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    print(f'{len(results)} installed-app selection and boot checks passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    operations = parser.add_subparsers(required=True)
    for name, handler, parameters in (
            ('prepare', prepare, ('stock', 'source')),
            ('audit', audit, ('stock', 'source', 'backup', 'agent-source', 'idf', 'qemu', 'gdb', 'nm', 'output'))):
        command = operations.add_parser(name)
        for parameter in parameters:
            command.add_argument('--'+parameter, type=lambda raw: Path(raw).resolve(), required=True)
        command.set_defaults(run=handler)
    args = parser.parse_args()
    args.run(args)
