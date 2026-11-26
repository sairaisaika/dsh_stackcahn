#!/usr/bin/env python3
"""Replace the resident DSH image in ota_0 with another build, in one ROM connection
(wiki/residency.md). Otadata, the bootloader and the factory slot are not touched.

Before writing: identity and the 3.3 V strap; the factory firmware must be the confirmed
running slot (same rule as enter_dsh.py); ota_0 must hold exactly --from (MD5 on the chip).
After writing: MD5 of --to on the chip. Swap --from and --to to go back. Never retries a
write. Run with the IDF Python (esptool 5).
"""
import argparse, hashlib, json, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from enter_dsh import OTADATA, SECTOR, plan_selection  # noqa: E402

OTA0, OTA0_SIZE = 0x20000, 0x4f0000


def log(event, **fields):
    print(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **fields}), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--identity', type=Path, required=True)
    p.add_argument('--from', dest='old', type=Path, required=True)
    p.add_argument('--to', dest='new', type=Path, required=True)
    p.add_argument('--auto-rom', action='store_true')
    a = p.parse_args()
    import esptool.cmds as cmds
    identity = json.loads(a.identity.read_text())
    old, new = a.old.read_bytes(), a.new.read_bytes()
    if not 0 < len(new) <= OTA0_SIZE:
        log('refused', reason='image-size'); return 2
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
        plan = plan_selection(cmds.read_flash(esp, OTADATA, 2 * SECTOR, no_progress=True))
        if 'refused' in plan:
            log('refused', reason=plan['refused'], records=plan['records']); return 2
        if esp.flash_md5sum(OTA0, len(old)) != hashlib.md5(old).hexdigest():
            log('refused', reason='ota0-not-the-expected-image'); return 2
        padded = new + b'\xff' * ((-len(new)) % SECTOR)
        cmds.write_flash(esp, [(OTA0, padded)], flash_mode='keep', flash_freq='keep', flash_size='keep')
        if esp.flash_md5sum(OTA0, len(new)) != hashlib.md5(new).hexdigest():
            log('failed', reason='readback-mismatch', hint='Do not retry blindly; write --from back'); return 4
        log('written', sha256=hashlib.sha256(new).hexdigest(), bytes=len(new))
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
