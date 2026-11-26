#!/usr/bin/env python3
"""QEMU check of the power-key boot selector (wiki/boot-selector-power-key.md). No device access.

Builds a virtual flash from a Sion snapshot (stock in ota_1), the resident DSH image in
ota_0 and the selector bootloader at 0x0, then boots it in Espressif QEMU under gdb:

  no-gesture             QEMU has no AXP2101, so the gesture is never read: stock (ota_1)
                         starts and the whole flash is unchanged.
  gesture-selects-dsh    gdb returns "two presses" from the real gesture function:
                         one NEW record (stock seq + 1) is written, the stock loader marks it
                         PENDING_VERIFY and DSH (ota_0) starts. Nothing else changes.
  gesture-bad-dsh        the same with a corrupted ota_0 image: nothing is written, stock starts.
  return-after-visit     the DSH record marked ABORTED (as after Home): stock starts.
"""
import argparse, hashlib, json, re, struct, subprocess, sys, tempfile, time, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from audit_agent_qemu import default_efuse  # noqa: E402

A, B, OTADATA, SECTOR = 0x20000, 0x510000, 0xd000, 0x1000


def record(seq, state):
    s = struct.pack('<I', seq)
    return s + b'\xff'*20 + struct.pack('<II', state, zlib.crc32(s, 0xffffffff))


def parse(sector):
    seq, = struct.unpack_from('<I', sector, 0)
    state, crc = struct.unpack_from('<II', sector, 24)
    return seq, state, seq != 0xffffffff and crc == zlib.crc32(struct.pack('<I', seq), 0xffffffff)


def entry(flash, offset):
    return struct.unpack_from('<I', flash, offset + 4)[0]


def run(name, flash, efuse, args, gdb_steps, expect_entry):
    with tempfile.TemporaryDirectory(prefix='sion-pek-') as t:
        d = Path(t)
        disk, fuse, uart, sock = d/'flash.bin', d/'efuse.bin', d/'uart.log', d/'gdb.sock'
        disk.write_bytes(flash); fuse.write_bytes(efuse)
        script = [f'target remote {sock}', 'set confirm off', *gdb_steps,
                  f'hbreak *{expect_entry:#x}', 'continue', 'printf "SION-PEK pc=%p\\n", $pc', 'monitor quit']
        (d/'probe.gdb').write_text('\n'.join(script) + '\n')
        qemu = [str(args.qemu), '-M', 'esp32s3', '-m', '32M', '-nographic', '-monitor', 'none', '-serial', f'file:{uart}',
                '-nic', 'none', '-S', '-gdb', f'unix:{sock},server=on,wait=off',
                '-drive', f'file={disk},if=mtd,format=raw', '-drive', f'file={fuse},if=none,format=raw,id=efuse',
                '-global', 'driver=nvram.esp32s3.efuse,property=drive,value=efuse',
                '-global', 'driver=timer.esp32s3.timg,property=wdt_disable,value=true']
        with (d/'qemu.log').open('wb') as log:
            p = subprocess.Popen(qemu, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 4
                while not sock.exists() and p.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                probe = subprocess.run([str(args.gdb), '-nx', '-batch', '-iex', 'set auto-load off', str(args.elf),
                                        '-x', str(d/'probe.gdb')], capture_output=True, text=True, timeout=60)
            finally:
                if p.poll() is None:
                    p.terminate()
                    try: p.wait(timeout=4)
                    except subprocess.TimeoutExpired: p.kill(); p.wait()
        serial = uart.read_text(errors='replace') if uart.exists() else ''
        qlog = (d/'qemu.log').read_text(errors='replace')
        mark = re.search(r'SION-PEK pc=(0x[0-9a-f]+)', probe.stdout)
        loaded = [int(x, 16) for x in re.findall(r'Loaded app from partition at offset (0x[0-9a-f]+)', serial)]
        return {'reached': int(mark[1], 16) if mark else None, 'loaded': loaded, 'flash': disk.read_bytes(),
                'serial': serial, 'gdb': (probe.stdout + probe.stderr)[-800:] + '\nQEMU: ' + qlog[-600:]}


def main():
    p = argparse.ArgumentParser()
    for name in ('snapshot', 'selector', 'elf', 'dsh', 'qemu', 'gdb', 'idf', 'output'):
        p.add_argument('--' + name, type=Path, required=True)
    args = p.parse_args()
    base = bytearray((args.snapshot/'flash-A.bin').read_bytes())
    boot = args.selector.read_bytes()
    assert 0 < len(boot) <= 0x8000
    base[0:0x8000] = boot.ljust(0x8000, b'\xff')
    dsh = args.dsh.read_bytes()
    pad = (-len(dsh)) % SECTOR
    base[A:A+len(dsh)+pad] = dsh + b'\xff'*pad
    # Otadata as on Sion after a DSH visit: stock seq 2 VALID, DSH seq 3 ABORTED.
    base[OTADATA:OTADATA+2*SECTOR] = record(3, 4).ljust(SECTOR, b'\xff') + record(2, 2).ljust(SECTOR, b'\xff')
    flash = bytes(base)
    efuse = default_efuse(args.idf)
    stock_entry, dsh_entry = entry(flash, B), entry(flash, A)
    # Enter the real gesture function and return "two presses" from it; everything after runs as
    # on a real cold boot. (A gdb inferior call would run with an unaligned stack on xtensa.)
    select = ['hbreak read_gesture', 'continue', 'return (_Bool)1', 'delete']
    results = {}

    def check(name, image, steps, expect_entry, expect_otadata, expect_loaded):
        r = run(name, image, efuse, args, steps, expect_entry)
        changed = [hex(o) for o in range(0, len(image), SECTOR) if r['flash'][o:o+SECTOR] != image[o:o+SECTOR]]
        ota = [parse(r['flash'][OTADATA+i*SECTOR:OTADATA+(i+1)*SECTOR]) for i in (0, 1)]
        ok = (r['reached'] == expect_entry and r['loaded'][-1:] == [expect_loaded] and
              ota == expect_otadata and set(changed) <= {hex(OTADATA), hex(OTADATA+SECTOR)})
        results[name] = {'passed': ok, 'reachedEntry': hex(r['reached']) if r['reached'] else None,
                         'loaded': [hex(x) for x in r['loaded']], 'otadata': ota, 'changedSectors': changed,
                         'selectorLog': re.findall(r'.*sion-pek.*', r['serial'])}
        if not ok:
            results[name]['gdb'] = r['gdb']; results[name]['serialTail'] = r['serial'][-1200:]

    check('no-gesture', flash, [], stock_entry, [(3, 4, True), (2, 2, True)], B)
    check('gesture-selects-dsh', flash, select, dsh_entry, [(3, 1, True), (2, 2, True)], A)
    bad = bytearray(flash); bad[A + 0x1000] ^= 0xff
    check('gesture-bad-dsh', bytes(bad), select, stock_entry, [(3, 4, True), (2, 2, True)], B)
    visited = bytearray(flash); visited[OTADATA:OTADATA+SECTOR] = record(3, 4).ljust(SECTOR, b'\xff')
    check('return-after-visit', bytes(visited), [], stock_entry, [(3, 4, True), (2, 2, True)], B)

    report = {'selectorSha256': hashlib.sha256(boot).hexdigest(), 'dshSha256': hashlib.sha256(dsh).hexdigest(),
              'snapshot': args.snapshot.name, 'deviceAccess': False, 'results': results,
              'allPassed': all(r['passed'] for r in results.values())}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for name, r in results.items():
        print(name, 'PASS' if r['passed'] else 'FAIL', r['reachedEntry'], r['loaded'], r['otadata'], r['changedSectors'])
    return 0 if report['allPassed'] else 1


if __name__ == '__main__':
    sys.exit(main())
