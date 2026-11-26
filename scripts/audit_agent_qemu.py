"""Boot reviewed Sion startup, recovery and factory OTA scenarios under ESP32-S3 QEMU."""
import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import time

from check_agent_preflight import read_snapshot, verify_materials
from ota_record import OTA_ABORTED, OTA_INVALID, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, ota_record
from prepare_agent_bundle import (
    ROOT, BOOT_RECEIPT, DEFAULT_BOOT, FLASH_SIZE, APP_OFFSET, CONFIG_OFFSET, SECTOR, EXPECTED_PARTITIONS,
    apply, candidate_option, interrupted_write, prepare, require_unchanged_outside,
)
from prepare_installation import image_info, ota_records, sha
from review_agent_capacity import require

A, B = 0x20000, 0x510000
OTA = 0xd000
QEMU_VERSION = 'esp_develop_9.2.2_20260417'
# These addresses refer to inputs in the checked v2 selector ELF.
ELF_SHA = '71212b30e3f237eed65d764c24824a448734d9209f31e8370134e626af014819'
IDLE_SAMPLE = '0x403c8a0e'
RELEASE_SAMPLE = '0x403c8a62'
ROM_RESET_RESULT = '0x403c89cd'
FIRST_GPIO_ACCESS = '0x403c89d0'
CPU0_SOFTWARE_RESET = 12


@dataclass(frozen=True)
class Scenario:
    name: str
    sequence: int
    trigger: str
    expected_offset: int | None
    corrupt: tuple[int, ...] = ()
    ota_state: int = 2
    expected_ota_state: int = 2
    corrupt_agent_hash: bool = False


SCENARIOS = (
    Scenario('normal-newer-original', 2, 'idle', B),
    Scenario('normal-older-original', 1, 'idle', A),
    Scenario('stuck-low-falls-through', 2, 'stuck', B),
    Scenario('explicit-agent-keeps-ota-new', 2, 'release', APP_OFFSET, ota_state=0, expected_ota_state=0),
    Scenario('software-return-keeps-original-slot', 2, 'software-return', B),
    Scenario('bad-agent-falls-back-and-runs-ota', 2, 'release', B, (APP_OFFSET,), 0, 1),
    Scenario('bad-agent-digest-falls-back-and-runs-ota', 2, 'release', B, ota_state=0,
             expected_ota_state=1, corrupt_agent_hash=True),
    Scenario('bad-selected-original-falls-back', 2, 'idle', A, (B,)),
    Scenario('both-originals-invalid-do-not-boot-agent', 2, 'idle', None, (A, B)),
)


def call_site(objdump, elf, target, *, after=0):
    # Keep the debugger in app_main's existing stack frame when resuming a branch.
    assembly = subprocess.check_output([objdump, '-d', '-C', '--disassemble=app_main', str(elf)], text=True)
    pattern = r'^\s*([0-9a-f]+):\s+[0-9a-f]+\s+call\d+\s+[0-9a-f]+ <'+re.escape(target)+r'>$'
    candidates = [int(address, 16) for address in re.findall(pattern, assembly, re.M)]
    later = [address for address in candidates if address > after]
    if len(later) != 1:
        raise ValueError(f'Expected a single app_main call to {target} after {after:#x}')
    return later[0]


def default_efuse(idf):
    # Use the pinned SDK's official blank v0.3 fixture, not the device's eFuses.
    path = 'tools/idf_py_actions/qemu_ext.py'
    pin = json.loads((ROOT/'firmware/upstream.lock.json').read_text())['idf']['commit']
    checked = subprocess.check_output(['git', '-C', str(idf), 'show', f'{pin}:{path}'])
    require(checked == (idf/path).read_bytes(), 'QEMU fixture differs from pinned SDK')
    sys.path.insert(0, str(idf/'tools'))
    try:
        from idf_py_actions.qemu_ext import QEMU_TARGETS
        return QEMU_TARGETS['esp32s3'].default_efuse
    finally:
        sys.path.pop(0)


def debugger_program(sock, trigger, endpoint, *, before_endpoint=()):
    commands = [f'target remote {sock}', 'set confirm off', 'set $samples = 0']
    if trigger in ('idle', 'release'):
        address = IDLE_SAMPLE if trigger == 'idle' else RELEASE_SAMPLE
        commands += [f'hbreak *{address}', 'commands', 'silent',
                     'set $a8 = $a8 | 0x200', 'set $samples = $samples + 1', 'continue', 'end']
    elif trigger == 'software-return':
        # Supply the ROM result a software CPU reset would return. Break before
        # the first GPIO access to detect entry into the cold gesture path.
        commands += [f'thbreak *{ROM_RESET_RESULT}', 'continue', 'if $a10 != 1', 'quit 2', 'end',
                     f'set $a10 = {CPU0_SOFTWARE_RESET}', f'hbreak *{FIRST_GPIO_ACCESS}',
                     'commands', 'silent', 'set $samples = $samples + 1', 'continue', 'end']
    elif trigger == 'stock-without-adc-calibration':
        # ESP32-S3 QEMU does not complete the SDK constructor's ADC calibration.
        # Skip this one constructor in the emulator, leaving app logic intact.
        commands += ['thbreak adc_hw_calibration', 'continue', 'return']
    commands.extend(before_endpoint)
    commands += [f'hbreak *{endpoint:#x}', 'continue',
                 'printf "SION-HANDOFF pc=%p samples=%d\\n", $pc, $samples',
                 'monitor quit']
    return '\n'.join(commands)+'\n'


def boot(name, trigger, flash, efuse, endpoint, qemu, gdb, elf, *, before_endpoint=()):
    with tempfile.TemporaryDirectory(prefix='sion-qemu-') as temporary:
        d = Path(temporary)
        disk, fuse, uart, sock = (d/name for name in ('flash.bin', 'efuse.bin', 'uart.log', 'gdb.sock'))
        disk.write_bytes(flash)
        fuse.write_bytes(efuse)
        commands = d/'probe.gdb'
        commands.write_text(debugger_program(sock, trigger, endpoint, before_endpoint=before_endpoint))
        memory = '8M' if trigger == 'stock-without-adc-calibration' else '32M'
        args = [str(qemu), '-M','esp32s3','-m',memory,'-nographic','-monitor','none',
                '-serial',f'file:{uart}','-nic','none',
                '-S','-gdb',f'unix:{sock},server=on,wait=off',
                '-drive',f'file={disk},if=mtd,format=raw',
                '-drive',f'file={fuse},if=none,format=raw,id=efuse',
                '-global','driver=nvram.esp32s3.efuse,property=drive,value=efuse',
                '-global','driver=timer.esp32s3.timg,property=wdt_disable,value=true']
        with (d/'qemu.log').open('wb') as log:
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+4
                while not sock.exists() and process.poll() is None and time.monotonic()<deadline:
                    time.sleep(0.05)
                require(sock.exists() and process.poll() is None, 'QEMU local debugger did not start')
                probe = subprocess.run([str(gdb), '-nx','-batch','-iex','set auto-load off',
                                        str(elf),'-x',str(commands)],
                                       capture_output=True, text=True, timeout=25, check=False)
                mark = re.search(r'^SION-HANDOFF pc=(0x[0-9a-f]+) samples=(\d+)$', probe.stdout, re.M)
                expected_samples = {'idle': 1, 'release': 5, 'stuck': 0, 'stock': 0,
                                    'stock-without-adc-calibration': 0, 'software-return': 0}[trigger]
                if mark is None or int(mark[1],16) != endpoint or int(mark[2]) != expected_samples:
                    gdb_detail = (probe.stdout[:500] + '\n' + probe.stderr[:700]).strip()
                    raise ValueError(f'{name}: no expected handoff at {endpoint:#x} with {expected_samples} samples.\n{gdb_detail}')
                require(process.wait(timeout=4) == 0, f'{name}: emulator did not exit cleanly')
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
        serial = uart.read_text(errors='replace')
        loaded = [int(x,16) for x in re.findall(r'Loaded app from partition at offset (0x[0-9a-f]+)', serial)]
        return loaded, serial, disk.read_bytes(), expected_samples


def emulate(scenario, base_flash, efuse, endpoints, qemu, gdb, elf):
    flash = bytearray(base_flash)
    flash[OTA:OTA+32] = ota_record(scenario.sequence, scenario.ota_state)
    for offset in scenario.corrupt:
        flash[offset] = 0
    if scenario.corrupt_agent_hash:
        # Last byte of the serialized image is part of the verified appended SHA-256.
        end = APP_OFFSET + image_info(bytes(flash[APP_OFFSET:]))['imageBytes']
        flash[end-1] ^= 1
    endpoint = endpoints[scenario.expected_offset]
    loaded, serial, readback, samples = boot(scenario.name, scenario.trigger, flash, efuse, endpoint, qemu, gdb, elf)
    if scenario.expected_offset is None:
        require(not loaded and 'No bootable app partitions in the partition table' in serial,
                'Both-slot failure did not take the expected maintenance path')
    else:
        require(loaded == [scenario.expected_offset], f'{scenario.name}: unexpected loaded partition')
    if scenario.corrupt_agent_hash:
        require('Image hash failed' in serial and 'DSH image did not verify; choosing factory OTA' in serial,
                'Damaged app digest did not reach the expected SHA-256 rejection')
    require(readback[OTA:OTA+32] == ota_record(scenario.sequence, scenario.expected_ota_state) and
            readback[OTA+32:OTA+0x2000] == flash[OTA+32:OTA+0x2000],
            f'{scenario.name}: OTA metadata differs from expected policy')
    result = {'case': scenario.name, 'loadedOffset': hex(loaded[0]) if loaded else None,
              'endpoint': hex(endpoint), 'gpioSamplesProvidedByDebugger': samples,
              'otaBefore': scenario.ota_state, 'otaAfter': scenario.expected_ota_state}
    if scenario.trigger == 'software-return':
        require(readback == flash, 'Software-return fixture modified Flash before the factory application entry')
        result.update(injectedRomResetReason=CPU0_SOFTWARE_RESET, gpioEntryPathReached=False, flashUnchangedAtHandoff=True)
    return result


def audit_ota_lifecycle(base, efuse, endpoints, args):
    """Carry each bootloader readback into the next QEMU boot, in both OTA directions."""
    cases = []

    def boot_step(name, trigger, flash, expected_slot, record_change=None):
        expected = bytearray(flash)
        if record_change:
            address, sequence, state = record_change
            expected[address:address+32] = ota_record(sequence, state)
        endpoint = endpoints[expected_slot]
        loaded, _, readback, samples = boot(name, trigger, flash, efuse, endpoint, args.qemu, args.gdb, args.elf)
        require(loaded == [expected_slot], f'{name}: unexpected partition handoff')
        require(readback == expected, f'{name}: virtual Flash differs from the expected OTA transition')
        cases.append({
            'case': name, 'loadedOffset': hex(expected_slot), 'endpoint': hex(endpoint),
            'gpioSamplesProvidedByDebugger': samples,
            'otaBefore': ota_records(flash[OTA:OTA+2*SECTOR]),
            'otaAfter': ota_records(readback[OTA:OTA+2*SECTOR]),
            'flashUnchangedAtHandoff': readback == flash,
        })
        return readback

    for candidate, sequences in ((0, (3, 2)), (1, (3, 4))):
        flash = bytearray(base)
        # Non-erased synthetic data detects accidental erasure of otherwise blank regions.
        for address in (EXPECTED_PARTITIONS['nvs'][2], EXPECTED_PARTITIONS['assets'][2], CONFIG_OFFSET):
            flash[address:address+8] = b'OTA-test'
        for sector, sequence in enumerate(sequences):
            address = OTA + sector * SECTOR
            flash[address:address+32] = ota_record(sequence, OTA_NEW if sector == candidate else OTA_VALID)
        name = f'ota_{candidate}'
        address = OTA + candidate * SECTOR
        sequence = sequences[candidate]
        slot, fallback = ((A, B), (B, A))[candidate]

        new = boot_step(f'{name}-agent-keeps-new', 'release', flash, APP_OFFSET)
        pending = boot_step(f'{name}-factory-enters-pending', 'idle', new, slot,
                            (address, sequence, OTA_PENDING_VERIFY))
        pending = boot_step(f'{name}-agent-keeps-pending', 'release', pending, APP_OFFSET)
        rolled_back = boot_step(f'{name}-software-return-rolls-back', 'software-return', pending, fallback,
                                (address, sequence, OTA_ABORTED))
        boot_step(f'{name}-rollback-persists', 'idle', rolled_back, fallback)

        # The emulator stops at application entry. Model an app confirming itself
        # on a separate branch from the PENDING_VERIFY image seen above.
        confirmed = bytearray(pending)
        confirmed[address:address+32] = ota_record(sequence, OTA_VALID)
        boot_step(f'{name}-confirmed-image-starts', 'idle', confirmed, slot)

    return {'modeledApplicationConfirmation': True, 'factoryOtaApplicationExecuted': False, 'cases': cases}


def restore_flash(flash, restore):
    recovered = flash.copy()
    for write in restore:
        apply(recovered, write)
    require_unchanged_outside(flash, recovered, restore)
    return recovered


def recovery_states(stock, install, restore):
    flash = stock.copy()
    yield 'factory-before-install', 'stock', flash
    for write, name in zip(install, ('agent-only', 'table-added', 'selector-installed'), strict=True):
        torn = interrupted_write(flash, write)
        yield f'restored-after-interrupted-{name}', 'stock', restore_flash(torn, restore)
        apply(flash, write)
        yield name, 'idle' if name == 'selector-installed' else 'stock', flash
    yield 'restored-after-complete-install', 'stock', restore_flash(flash, restore)
    for write, name in zip(restore, ('restore-table', 'restore-bootloader'), strict=True):
        torn = interrupted_write(flash, write)
        yield f'retried-after-interrupted-{name}', 'stock', restore_flash(torn, restore)
        apply(flash, write)
        if name == 'restore-table':
            # With the original partition table back, the selector doesn't read the entry GPIO.
            yield 'restore-table-only', 'stock', flash


def audit_recovery(factory_apps, snapshot, files, efuse, endpoint, args):
    install, restore = files[:3], files[3:]
    stock = factory_apps.copy()
    for write in restore:
        apply(stock, write)
    # Retain the recorded A/B selection, but reconstruct bootstrap metadata. The emulator
    # never receives the actual OTA sectors, original NVS, assets, or device eFuses.
    records = ota_records(snapshot[OTA:OTA+2*SECTOR])
    for record in records:
        offset = OTA + record['sector'] * SECTOR
        stock[offset:offset+32] = ota_record(record['sequence'], record['state'])
    results = []
    for name, trigger, flash in recovery_states(stock, install, restore):
        loaded, _, readback, samples = boot(name, trigger, flash, efuse, endpoint, args.qemu, args.gdb, args.elf)
        require(loaded == [B], f'{name}: boot did not hand off to the reviewed factory application')
        require(readback == flash, f'{name}: simulator changed Flash before the factory application entry')
        results.append({'case': name, 'loadedOffset': hex(B), 'endpoint': hex(endpoint),
                        'gpioSamplesProvidedByDebugger': samples, 'flashUnchangedAtHandoff': True})
    return {'factoryAppVersion': image_info(snapshot[B:])['version'], 'reconstructedOta': records, 'cases': results}


def audit(args):
    firmware = args.elf.read_bytes()
    receipt = json.loads(BOOT_RECEIPT.read_text())
    require(sha(firmware) == receipt['artifacts']['bootloader.elf']['sha256'] == ELF_SHA,
            'Disassembled GPIO fixtures do not match the candidate ELF')
    version = subprocess.check_output([str(args.qemu),'--version'],text=True).splitlines()[0]
    require(QEMU_VERSION in version, 'Use the pinned Espressif simulator')
    evidence = read_snapshot(args.historical)
    files, manifest = prepare(args.historical, args.app, DEFAULT_BOOT, args.idf, args.stock_idf, candidate=args.candidate)
    verify_materials(args.bundle, files, manifest)
    require(manifest['savedBaselineSha256'] == sha(evidence.data), 'Baseline changed while preparing QEMU')
    factory_apps = bytearray(b'\xff' * FLASH_SIZE)
    # Copy executable images only. No original NVS, assets, eFuse or OTA records.
    for offset in (A,B):
        image = evidence.data[offset:offset+0x4f0000]
        size = image_info(image)['imageBytes']
        factory_apps[offset:offset+size] = image[:size]
    flash = factory_apps.copy()
    for item in files[:3]:
        apply(flash, item)
    endpoints = {offset: struct.unpack_from('<I', flash, offset+4)[0] for offset in (A,B,APP_OFFSET)}
    nm = subprocess.check_output([str(args.nm), '-n',str(args.elf)],text=True)
    reset = re.search(r'^([0-9a-f]+) T bootloader_reset$',nm,re.M)
    require(reset is not None, 'Bootloader reset symbol not found')
    endpoints[None] = int(reset[1],16)
    efuse = default_efuse(args.idf)
    results = [emulate(case, flash, efuse, endpoints, args.qemu, args.gdb, args.elf) for case in SCENARIOS]
    report = {'qemu':version,'applicationVersion':manifest['appVersion'],'selectorElfSha256':ELF_SHA,'bundleManifestSha256':sha((args.bundle/'manifest.json').read_bytes()),
              'deviceAccess':False,'networkEnabled':False,'syntheticGpioAndOta':True,'hardwareValidated':False,
              'stoppedAtApplicationEntryOrBootReset':True,'cases':results}
    if args.recovery:
        report['factoryRecovery'] = audit_recovery(factory_apps, evidence.data, files, efuse, endpoints[B], args)
    if args.ota_lifecycle:
        report['factoryOtaLifecycle'] = audit_ota_lifecycle(flash, efuse, endpoints, args)
    with args.output.open('x') as handle:
        handle.write(json.dumps(report,indent=2)+'\n')
    for result in results:
        print(result['case'],result['loadedOffset'],result['otaBefore'],'→',result['otaAfter'])
    if args.recovery:
        for result in report['factoryRecovery']['cases']:
            print(result['case'], result['loadedOffset'], 'virtual Flash unchanged at handoff')
    if args.ota_lifecycle:
        for result in report['factoryOtaLifecycle']['cases']:
            before = [record['state'] for record in result['otaBefore']]
            after = [record['state'] for record in result['otaAfter']]
            print(result['case'], result['loadedOffset'], before, '→', after)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('historical','bundle','elf','qemu','gdb','nm','output'):
        parser.add_argument('--'+name,type=lambda raw: Path(raw).resolve(),required=True)
    candidate_option(parser)
    parser.add_argument('--recovery', action='store_true', help='Also boot the original image after staged install and recovery operations')
    parser.add_argument('--ota-lifecycle', action='store_true', help='Also follow both original OTA slots through validation and rollback')
    parser.add_argument('--app',type=Path)
    parser.add_argument('--idf',type=Path,default=ROOT/'work/esp-idf')
    parser.add_argument('--stock-idf',type=Path,default=ROOT/'work/esp-idf-stock-v5.5.4')
    audit(parser.parse_args())
