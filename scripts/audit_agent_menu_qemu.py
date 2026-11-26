"""Boot touch-menu receiver scenarios using synthetic Flash and no network or hardware."""
import argparse
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import time

from app_center_baseline import reviewed_firmware
from audit_agent_qemu import A, B, APP_OFFSET, FLASH_SIZE, OTA, SECTOR, default_efuse, ota_record
from audit_agent_qemu import OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID
from prepare_installation import image_info, sha


def fixture_addresses(objdump, elf):
    def disassemble(symbol):
        return subprocess.check_output([objdump, '-d', '--disassemble='+symbol, elf], text=True)

    call = re.search(r'<esp_rom_get_reset_reason>\).*?\n[^\n]*\bcallx8\b[^\n]*\n([0-9a-f]+):',
                     disassemble('call_start_cpu0'), re.S)
    buffer = re.search(r'\bl32r\s+a2,.*?\((60[0-9a-f]{6})\b',
                       disassemble('bootloader_common_get_rtc_retain_mem'))
    if call is None or buffer is None:
        raise ValueError('Could not resolve the actual reset return and RTC retention buffer')
    return int(call[1], 16), int(buffer[1], 16)+12


def boot_case(args, efuse, base, fixture, name, reset, request, destination, received,
              corrupt=False, ota_transition=None):
    output = args.output/name
    output.mkdir()
    virtual = bytearray(base)
    entry = struct.unpack_from('<I', virtual, destination+4)[0]
    if corrupt:
        virtual[APP_OFFSET] = 0
    disk = output/'flash.bin'
    disk.write_bytes(virtual)
    tag = b'SIONDSH'
    ticket = tag+bytes([request]) if request else bytes(8)
    breakpoint, rtc = fixture
    with tempfile.TemporaryDirectory(prefix='sion-menu-qemu-') as temp:
        socket = Path(temp)/'gdb.sock'
        command_file = output/'probe.gdb'
        command_file.write_text(f'''set confirm off
target remote {socket}
thbreak *{breakpoint:#x}
continue
if $a10 != 1
quit 2
end
set $a10 = {reset}
set *(unsigned int*){rtc:#x} = {int.from_bytes(ticket[:4], 'little'):#x}
set *(unsigned int*){rtc+4:#x} = {int.from_bytes(ticket[4:], 'little'):#x}
hbreak *{entry:#x}
continue
printf "MENU-RESULT entry=%p rtc=%08x:%08x\\n", $pc, *(unsigned int*){rtc:#x}, *(unsigned int*){rtc+4:#x}
monitor quit
''')
        uart = output/'uart.log'
        command = [str(args.qemu), '-M', 'esp32s3', '-m', '32M', '-nographic',
                   '-monitor', 'none', '-serial', f'file:{uart}', '-nic', 'none',
                   '-S', '-gdb', f'unix:{socket},server=on,wait=off',
                   '-drive', f'file={disk},if=mtd,format=raw',
                   '-drive', f'file={efuse},if=none,format=raw,id=efuse',
                   '-global', 'driver=nvram.esp32s3.efuse,property=drive,value=efuse',
                   '-global', 'driver=timer.esp32s3.timg,property=wdt_disable,value=true']
        with (output/'qemu.log').open('wb') as log:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+4
                while not socket.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                if not socket.exists():
                    raise RuntimeError(f'{name}: emulator debugger did not open')
                debug = subprocess.run([args.gdb, '-nx', '-batch', '-iex', 'set auto-load off',
                                        args.selector/'bootloader.elf', '-x', command_file],
                                       capture_output=True, text=True, timeout=25)
                (output/'gdb.log').write_text(debug.stdout+debug.stderr)
                result = re.search(r'^MENU-RESULT entry=(0x[0-9a-f]+) rtc=([0-9a-f]{8}):([0-9a-f]{8})$',
                                   debug.stdout, re.M)
                if not result or int(result[1], 16) != entry or process.wait(timeout=5) != 0:
                    raise RuntimeError(f'{name}: emulator did not reach the expected application')
                readback = b''.join(int(word, 16).to_bytes(4, 'little') for word in result.groups()[1:])
                expected = tag+bytes([received]) if received else bytes(8)
                if readback != expected or f'Loaded app from partition at offset {destination:#x}' not in uart.read_text():
                    raise RuntimeError(f'{name}: application slot or retained request differs')
                if ota_transition:
                    offset, sequence, state = ota_transition
                    virtual[offset:offset+32] = ota_record(sequence, state)
                if disk.read_bytes() != virtual:
                    raise RuntimeError(f'{name}: differences outside the expected OTA transition')
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
    return {'partition': hex(destination), 'menuReady': received == 3,
            'virtualFlashUnchanged': ota_transition is None,
            'otaAfter': ota_transition[2] if ota_transition else None}


def audit_upgrade(args, efuse, base, addresses, previous):
    updated = bytearray(base)
    updated[A:A+len(previous)] = previous
    updated[OTA:OTA+32] = ota_record(1, OTA_VALID)
    updated[OTA+SECTOR:OTA+SECTOR+32] = ota_record(2, OTA_NEW)
    results = {}

    def check(name, image, request, destination, ready=0, transition=None):
        results[name] = boot_case(args, efuse, image, addresses, name,
                                  12, request, destination, ready, ota_transition=transition)
        return bytearray((args.output/name/'flash.bin').read_bytes())

    pending = check('official-update-first-start', updated, 0, B,
                    transition=(OTA+SECTOR, 2, OTA_PENDING_VERIFY))
    check('stale-dsh-request-during-pending', pending, 1, A,
          transition=(OTA+SECTOR, 2, OTA_ABORTED))

    # The original app owns confirmation. Exercise the bootloader result from
    # the same verified readback after modelling that app's confirmed record.
    pending[OTA+SECTOR:OTA+SECTOR+32] = ota_record(2, OTA_VALID)
    entered = check('confirmed-update-enters-dsh', pending, 1, APP_OFFSET)
    returned = check('home-after-confirmed-update', entered, 2, B, ready=3)
    check('same-menu-reenters-dsh', returned, 1, APP_OFFSET)

    # The next official OTA can replace the menu app with an image that does
    # not contain the extension. Its selection leaves the separate DSH intact.
    returned[OTA:OTA+32] = ota_record(3, OTA_VALID)
    check('official-image-without-menu-extension', returned, 0, A)
    return results


def audit(args):
    args.output.mkdir()
    selector, stock, agent, layout = (path.read_bytes() for path in (
        args.selector/'bootloader.bin', args.stock, args.agent, args.layout,
    ))
    if (not 0 < len(selector) <= 0x8000 or len(layout) != 4096 or not 0 < len(stock) <= 0x4f0000 or
            not 0 < len(agent) <= 0x1ec000 or
            image_info(stock).get('version') != '1.6.2' or
            image_info(agent).get('version') != args.agent_version):
        raise ValueError('Expected paired public menu and the selected independent build with a 16 MiB table')
    base = bytearray(b'\xff'*FLASH_SIZE)
    for offset, content in ((0, selector), (0x8000, layout), (OTA, ota_record(2, 2)), (B, stock), (APP_OFFSET, agent)):
        base[offset:offset+len(content)] = content
    efuse = args.output/'fixture-efuse.bin'
    efuse.write_bytes(default_efuse(args.idf))
    addresses = fixture_addresses(args.objdump, args.selector/'bootloader.elf')
    cases = {
        'enter-dsh': (12, 1, APP_OFFSET, 0),
        'return-to-menu': (12, 2, B, 3),
        'reset-before-stock-consumes': (12, 3, B, 0),
        'cold-stale-return': (1, 2, B, 0),
        'ordinary-software-reset': (12, 0, B, 0),
        'corrupt-dsh-falls-back': (12, 1, B, 0, True),
    }
    results = {name: boot_case(args, efuse, base, addresses, name, *case) for name, case in cases.items()}
    report = {'deviceAccess': False, 'injectedRtcAndResetReason': True, 'selectorSha256': sha(selector),
              'publicMenuSha256': sha(stock), 'dshSha256': sha(agent), 'scenarios': results}
    if args.baseline:
        _, previous = reviewed_firmware(args.baseline)
        report['upgradeSequences'] = audit_upgrade(args, efuse, base, addresses, previous)
        report['modeledApplicationConfirmation'] = True
    (args.output/'result.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('selector', 'stock', 'agent', 'layout', 'idf', 'qemu', 'gdb', 'objdump', 'output'):
        parser.add_argument('--'+name, type=lambda path: Path(path).resolve(), required=True)
    parser.add_argument('--baseline', type=lambda path: Path(path).resolve(),
                        help='Verified double-read to also test an upgrade from the original application')
    parser.add_argument('--agent-version', default='dsh-agent-v38-menu',
                        choices=('dsh-agent-v38-menu', 'dsh-agent-v40-menu', 'dsh-agent-v41-menu',
                                 'dsh-agent-v43-menu', 'dsh-agent-v44-menu', 'dsh-agent-v45-menu',
                                 'dsh-agent-v46-menu', 'dsh-agent-v47-menu', 'dsh-agent-v48-menu',
                                 'dsh-agent-v49-menu', 'dsh-agent-v50-menu', 'dsh-agent-v51-menu'))
    audit(parser.parse_args())
