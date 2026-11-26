#!/usr/bin/env python3
"""Write (or restore) Sion's second-stage bootloader region 0x0-0x8000, in one ROM connection.

  install: the power-key selector (wiki/boot-selector-power-key.md)
  restore: the original bootloader region saved by a previous install

Before writing, in the same connection: identity and the 3.3 V flash strap; the first 64 KiB
(bootloader, partition table, NVS, otadata) read twice and saved when both reads agree;
the current region must be exactly what this mode expects to replace (the original
bootloader for install, the selector for restore). After writing, the whole region is read
back. It never retries a write. Run with the IDF Python (esptool 5).

  python scripts/install_boot_selector.py install --identity ID.json --selector bootloader.bin \
      --original-sha256 HEX --backups .local/backups [--auto-rom]
  python scripts/install_boot_selector.py restore --identity ID.json --selector bootloader.bin \
      --original-region .local/backups/sion-selector-before-*/region-0-10000.bin
"""
import argparse, hashlib, json, subprocess, sys, time
from pathlib import Path

REGION, HEAD = 0x8000, 0x10000


def log(event, **fields):
    print(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **fields}), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=('install', 'restore'))
    p.add_argument('--identity', type=Path, required=True)
    p.add_argument('--selector', type=Path, required=True)
    p.add_argument('--original-sha256', help='install: SHA-256 of the original 0x0-0x8000 region')
    p.add_argument('--original-region', type=Path, help='restore: the region-0-10000.bin saved before install')
    p.add_argument('--replace', type=Path, help='install: replace this selector build instead of the original bootloader')
    p.add_argument('--backups', type=Path, default=Path('.local/backups'))
    p.add_argument('--auto-rom', action='store_true')
    a = p.parse_args()
    import esptool.cmds as cmds

    identity = json.loads(a.identity.read_text())
    selector = a.selector.read_bytes()
    if not 0 < len(selector) <= REGION:
        log('refused', reason='selector-size'); return 2
    selector_region = selector.ljust(REGION, b'\xff')
    if a.mode == 'install':
        if not a.original_sha256 and not a.replace:
            log('refused', reason='original-sha256-required'); return 2
        expect_now, write = None, selector_region
        replacing = a.replace.read_bytes().ljust(REGION, b'\xff') if a.replace else None
    else:
        saved = a.original_region.read_bytes() if a.original_region else b''
        if len(saved) != HEAD:
            log('refused', reason='original-region-required'); return 2
        expect_now, write = selector_region, saved[:REGION]
    if subprocess.run(['/usr/sbin/lsof', '-t', identity['port']], capture_output=True).stdout.strip():
        log('refused', reason='port-in-use'); return 2
    try:
        esp = cmds.detect_chip(identity['port'], connect_mode='usb-reset' if a.auto_rom else 'no-reset', connect_attempts=1)
    except Exception as error:
        log('refused', reason='no-rom', detail=str(error)[:200], hint='Hold RST about 3 s until the green light'); return 3
    try:
        if ':'.join(f'{b:02x}' for b in esp.read_mac()) != identity['usbSerial'].lower():
            log('refused', reason='different-unit'); return 2
        voltage = esp._get_rtc_cntl_flash_voltage() or esp._get_efuse_flash_voltage()
        if voltage is None:
            voltage = '1.8V' if esp.read_reg(esp.GPIO_STRAP_REG) & esp.GPIO_STRAP_VDDSPI_MASK else '3.3V'
        if voltage != '3.3V':
            log('refused', reason='flash-voltage', voltage=voltage, hint='Hold RST about 3 s until the green light'); return 3
        cmds.attach_flash(esp)
        first = cmds.read_flash(esp, 0, HEAD, no_progress=True)
        second = cmds.read_flash(esp, 0, HEAD, no_progress=True)
        if first != second:
            log('refused', reason='unstable-read'); return 2
        current = first[:REGION]
        if a.mode == 'install':
            if (current != replacing) if replacing else (hashlib.sha256(current).hexdigest() != a.original_sha256):
                log('refused', reason='bootloader-not-original', sha256=hashlib.sha256(current).hexdigest()); return 2
            folder = a.backups / time.strftime('sion-selector-before-%Y%m%dT%H%M%SZ', time.gmtime())
            folder.mkdir(parents=True, mode=0o700)
            (folder / 'region-0-10000.bin').write_bytes(first)
            (folder / 'verification.json').write_text(json.dumps({
                'bytes': HEAD, 'twoReadsIdentical': True, 'sha256': hashlib.sha256(first).hexdigest(),
                'bootloaderRegionSha256': hashlib.sha256(current).hexdigest(), 'replacedSelector': bool(replacing),
                'mac': identity['usbSerial']}, indent=2) + '\n')
            log('backed-up', folder=str(folder))
        elif current != expect_now:
            log('refused', reason='bootloader-not-selector', sha256=hashlib.sha256(current).hexdigest()); return 2
        cmds.write_flash(esp, [(0, write)], flash_mode='keep', flash_freq='keep', flash_size='keep', no_compress=True)
        back = cmds.read_flash(esp, 0, REGION, no_progress=True)
        if back != write:
            log('failed', reason='readback-mismatch', hint='Do not power off; restore the saved region from download mode'); return 4
        log('written', mode=a.mode, sha256=hashlib.sha256(write).hexdigest())
        esp.write_reg(esp.RTC_CNTL_OPTION1_REG, 0, esp.RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK)
        cmds.reset_chip(esp, 'watchdog-reset')
        log('reset')
        return 0
    except Exception as error:
        log('failed', reason='esptool-error', detail=f'{type(error).__name__}: {error}'[:300]); return 4
    finally:
        try: esp._port.close()
        except Exception: pass


if __name__ == '__main__':
    sys.exit(main())
