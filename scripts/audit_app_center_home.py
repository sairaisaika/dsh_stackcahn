"""Check a volatile one-shot Home handoff using the original bootloader in QEMU."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

from app_center_baseline import A, B, OTA, OWNER_PREFIX, reviewed_firmware, reviewed_partition_csv
from audit_agent_qemu import OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, boot, default_efuse, ota_record
from audit_app_center_ota_writer import symbol
from check_agent_preflight import read_snapshot
from prepare_agent import APP_CENTER_HOME_VERSION, app_center_headers, verify
from prepare_agent_bundle import APP_OFFSET, CONFIG_OFFSET, EXPECTED_PARTITIONS, ROOT, SECTOR, TABLE_OFFSET
from prepare_installation import image_info, ota_records, sha


APP = 'sion-app-center-home-probe'
FIXTURE = ROOT/'firmware/tests/app-center-home'
HANDOFF = ROOT/'firmware/app-center/home_menu_request.h'
RECEIVER = 'SION-HOME: receiver software={software:d} menu={menu:d} clear=1'
STOCK_NOTICE = 'SION_APP_CENTER_HOME_V1'
SLOW_MEMORY_LAYOUT = r'^rtc_slow_seg\s+0x0*50000020\s+0x0*1fe0\b'


def prepare(args):
    shutil.copytree(FIXTURE, args.source)
    shutil.copyfile(HANDOFF, args.source/'main'/HANDOFF.name)
    (args.source/'partitions.csv').write_text(reviewed_partition_csv())


def audit_factory_receiver(args, flash, efuse, idf_tag):
    if (args.receiver/'firmware/main/hal/app_center_home_menu.h').read_bytes() != HANDOFF.read_bytes():
        raise ValueError('Factory receiver uses different handoff source')
    build = args.receiver/'firmware/build'
    factory = (build/'stack-chan.bin').read_bytes()
    elf = build/'stack-chan.elf'
    info = image_info(factory)
    if (info['imageBytes'] != len(factory) or info['project'] != 'stack-chan' or info['version'] != '1.6.2' or
            info['idf'] != idf_tag or STOCK_NOTICE.encode()+b'\0' not in factory or
            not re.search(SLOW_MEMORY_LAYOUT, (build/'stack-chan.map').read_text(), re.M)):
        raise ValueError('Expected the paired public factory receiver')
    if len(factory) > EXPECTED_PARTITIONS['ota_1'][3]:
        raise ValueError('Factory receiver exceeds stock partition')
    before_hal = symbol(args.nm, elf, 'Hal::init()')
    flash = bytearray(flash)
    flash[B:B+len(factory)] = factory
    results = []
    for mode in ('H', 'N'):
        flash[APP_OFFSET] = ord(mode)
        flash[OTA:OTA+32] = ota_record(3, OTA_NEW)
        loaded, uart, observed, _ = boot(f'public-factory-receiver-{mode}', 'stock-without-adc-calibration',
                                         flash, efuse, before_hal, args.qemu, args.gdb, elf)
        expected = bytearray(flash)
        expected[OTA:OTA+32] = ota_record(3, OTA_ABORTED)
        accepted = STOCK_NOTICE in uart.splitlines()
        if loaded != [A, B] or observed != expected or accepted != (mode == 'H'):
            raise ValueError(f'Public receiver {mode}: unexpected boot outcome\n{uart[-1600:]}')
        results.append({'mode': mode, 'accepted': accepted, 'wholeFlashMatched': True})
    return {'sha256': sha(factory), 'scope': 'Through the compiled receiver to HAL entry', 'results': results}


def audit_agent_start(args, original, table, efuse):
    prepared = verify(args.agent)
    build = args.agent/'firmware/build'
    receipt = json.loads((args.agent/'.agent-build.json').read_text())
    image, elf = build/'stack-chan.bin', build/'stack-chan.elf'
    for artifact in (image, elf):
        if receipt['artifacts'][artifact.name] != {'sha256': sha(artifact.read_bytes()), 'bytes': artifact.stat().st_size}:
            raise ValueError(f'Paired artifact differs from build receipt: {artifact.name}')
    agent = image.read_bytes()
    info = image_info(agent)
    if (not prepared.get('appCenterHome') or info['version'] != APP_CENTER_HOME_VERSION or
            info['imageBytes'] != len(agent) or len(agent) > EXPECTED_PARTITIONS['ota_0'][3] or
            receipt['preparedReceiptSha256'] != sha((args.agent/'.agent-prepared.json').read_bytes()) or
            not re.search(SLOW_MEMORY_LAYOUT, (build/'stack-chan.map').read_text(), re.M) or
            (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff') != table):
        raise ValueError('Expected an exact paired build on the reviewed layout')

    receiver_image = args.receiver/'firmware/build/stack-chan.bin'
    for name, expected in app_center_headers(args.backup, receiver_image).items():
        if (args.agent/'firmware/main/agent/app_center'/name).read_text() != expected:
            raise ValueError('Candidate was built for a different receiver')
    before_hal = symbol(args.nm, elf, 'Hal::init()')
    task_exit = symbol(args.nm, elf, 'vTaskDelete')
    flash = bytearray(original)
    flash[A:A+len(agent)] = agent
    flash[OTA:OTA+32] = ota_record(3, OTA_NEW)
    expected = bytearray(flash)
    expected[OTA:OTA+32] = ota_record(3, OTA_PENDING_VERIFY)
    loaded, uart, observed, _ = boot('v52-rejects-unpaired-factory', 'stock-without-adc-calibration',
                                     flash, efuse, task_exit, args.qemu, args.gdb, elf)
    if (loaded != [A] or observed != expected or
            'DSH.AGENT requires a verified factory return slot' not in uart):
        raise ValueError(f'Unmatched factory did not stop before hardware or storage access\n{uart[-1600:]}')

    receiver = receiver_image.read_bytes()
    flash[B:B+len(receiver)] = receiver
    expected[B:B+len(receiver)] = receiver
    owner = CONFIG_OFFSET-SECTOR
    ownership = OWNER_PREFIX+hashlib.sha256(table).digest()
    expected[owner:owner+len(ownership)] = ownership
    loaded, uart, observed, _ = boot('v52-accepts-paired-receiver', 'stock-without-adc-calibration',
                                     flash, efuse, before_hal, args.qemu, args.gdb, elf)
    if (loaded != [A] or observed != expected or 'DSH.AGENT independent settings storage unavailable' in uart):
        raise ValueError(f'Paired receiver did not permit DSH start or expected ownership write\n{uart[-1600:]}')

    # Start a new emulator from the pending readback to model a cold restart.
    receiver_elf = receiver_image.with_suffix('.elf')
    receiver_hal = symbol(args.nm, receiver_elf, 'Hal::init()')
    expected[OTA:OTA+32] = ota_record(3, OTA_ABORTED)
    loaded, uart, returned, _ = boot('v52-cold-fallback', 'stock-without-adc-calibration',
                                     observed, efuse, receiver_hal, args.qemu, args.gdb, receiver_elf)
    if loaded != [B] or returned != expected or STOCK_NOTICE in uart.splitlines():
        raise ValueError(f'Cold restart did not use the regular paired factory startup\n{uart[-1600:]}')

    # Restore the exact ranges changed in this test fixture, then verify the
    # genuine original application entry and entire 16 MiB readback.
    restored = bytearray(returned)
    for start, end in ((A, A+len(agent)), (B, B+len(receiver)), (OTA, OTA+SECTOR), (owner, CONFIG_OFFSET)):
        restored[start:end] = original[start:end]
    stock_entry = int.from_bytes(original[B+4:B+8], 'little')
    loaded, _, observed, _ = boot('v52-restore-review-baseline', 'stock', restored, efuse, stock_entry,
                                  args.qemu, args.gdb, receiver_elf)
    if loaded != [B] or restored != original or observed != original:
        raise ValueError('Restore did not match the original Flash and genuine application entry')
    return {'sha256': sha(agent), 'version': info['version'], 'acceptedPairedReceiver': True,
            'rejectedUnpairedFactory': True, 'coldFallbackReachedPairedReceiver': True,
            'restoredGenuineFactoryEntry': True, 'wholeFlashMatched': True, 'scope': 'Through application or HAL entry'}


def audit(args):
    header, stock = reviewed_firmware(args.backup)
    original = read_snapshot(args.backup).data
    if original[:len(header)] != header or original[B:B+len(stock)] != stock:
        raise ValueError('Backup differs from the reviewed read')
    metadata = ota_records(original[OTA:OTA+2*SECTOR])
    if [(record['sequence'], record['state']) for record in metadata] != [(3, OTA_ABORTED), (2, OTA_VALID)]:
        raise ValueError('Expected the reviewed A=ABORTED and B=VALID OTA records')
    for path in FIXTURE.rglob('*'):
        if path.is_file() and path.read_bytes() != (args.source/path.relative_to(FIXTURE)).read_bytes():
            raise ValueError(f'Probe source differs: {path.name}')
    if (args.source/'main'/HANDOFF.name).read_bytes() != HANDOFF.read_bytes():
        raise ValueError('Prepared handoff code changed')
    build = args.source/'build'
    project = build/APP
    elf = project.with_suffix('.elf')
    probe = project.with_suffix('.bin').read_bytes()
    lock = json.loads((ROOT/'firmware/upstream.lock.json').read_text())
    description = json.loads((build/'project_description.json').read_text())
    info = image_info(probe)
    table = (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff')
    if (info['project'] != APP or info['imageBytes'] != len(probe) or info['idf'] != lock['idf']['tag'] or
            info['idf'] != image_info(stock)['idf'] or Path(description['idf_path']).resolve() != args.idf or
            table != header[TABLE_OFFSET:]):
        raise ValueError('Probe must use the same SDK release and partition layout as the reviewed factory app')
    if not re.search(SLOW_MEMORY_LAYOUT, project.with_suffix('.map').read_text(), re.M):
        raise ValueError('Expected linker map to exclude the first 32 RTC slow bytes')
    if args.output.exists():
        raise ValueError('Choose a new report path')

    symbols = subprocess.check_output([args.nm, '--defined-only', str(elf)], text=True)
    done = next(int(line.split()[0], 16) for line in symbols.splitlines()
                if line.endswith(' T sion_home_probe_done'))
    efuse = default_efuse(args.idf)
    flash = bytearray(original)
    for slot in ('ota_0', 'ota_1'):
        _, _, offset, size = EXPECTED_PARTITIONS[slot]
        if len(probe) > size:
            raise ValueError(f'Probe exceeds partition {slot}')
        flash[offset:offset+len(probe)] = probe
    results = []
    for name, mode, sender, receiver in (
            ('one-shot-menu', 'H', True, [(1, 1), (1, 0)]),
            ('ordinary-software-restart', 'N', True, [(1, 0)]),
            ('wrong-target', 'W', True, [(1, 0)]),
            ('incomplete-ticket', 'T', True, [(1, 0)]),
            ('cold-stale-ticket', 'C', False, [(0, 0), (1, 0)])):
        flash[APP_OFFSET] = ord(mode)
        flash[OTA:OTA+32] = ota_record(3, OTA_NEW if sender else OTA_ABORTED)
        offsets = ([A] if sender else []) + [B]*len(receiver)
        expected_log = ([f'SION-HOME: sender pending, fixture={mode}'] if sender else []) + [
            RECEIVER.format(software=software, menu=menu) for software, menu in receiver]
        loaded, uart, observed, _ = boot(name, 'stock', flash, efuse, done, args.qemu, args.gdb, elf)
        actual_log = [line for line in uart.splitlines() if line.startswith('SION-HOME:')]
        if loaded != offsets or actual_log != expected_log:
            raise ValueError(f'{name}: unexpected boot or menu outcome\n{uart[-1600:]}')
        expected = bytearray(flash)
        expected[OTA:OTA+32] = ota_record(3, OTA_ABORTED)
        if observed != expected:
            raise ValueError(f'{name}: expected only SDK rollback metadata to change')
        results.append({'case': name, 'slots': [hex(offset) for offset in loaded],
                        'menuByBoot': [bool(menu) for _, menu in receiver], 'wholeFlashMatched': True})

    report = {'deviceAccess': False, 'installable': False,
              'productionBootloaderSha256': sha(header[:TABLE_OFFSET]), 'probeSha256': sha(probe), 'results': results}
    if args.receiver is not None:
        report['publicFactoryReceiver'] = audit_factory_receiver(args, flash, efuse, info['idf'])
    if args.agent is not None:
        report['pairedAgentStart'] = audit_agent_start(args, original, header[TABLE_OFFSET:], efuse)
    if read_snapshot(args.backup).data != original:
        raise ValueError('Saved backup changed during the test')
    with args.output.open('x') as output:
        output.write(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(required=True)
    for action, function in (('prepare', prepare), ('audit', audit)):
        command = subparsers.add_parser(action)
        options = ('source',) if action == 'prepare' else ('source', 'backup', 'idf', 'qemu', 'gdb', 'nm', 'output')
        for name in options:
            command.add_argument('--'+name, type=lambda path: Path(path).resolve(), required=True)
        if action == 'audit':
            command.add_argument('--receiver', type=lambda path: Path(path).resolve(),
                                 help='Also run the compiled public receiver through its HAL entry')
            command.add_argument('--agent', type=lambda path: Path(path).resolve(),
                                 help='Also verify a paired DSH build; requires --receiver')
        command.set_defaults(action=function)
    arguments = parser.parse_args()
    if getattr(arguments, 'agent', None) and not arguments.receiver:
        parser.error('--agent requires --receiver')
    arguments.action(arguments)
