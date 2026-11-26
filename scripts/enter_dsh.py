#!/usr/bin/env python3
"""Start the resident DSH body once (wiki/residency.md, route R1).

The factory firmware stays the default. DSH lives in ota_0. To start it, this tool
writes one "boot ota_0 once" OTA record (a single 4 KiB sector of otadata) and resets;
DSH's Home or any later restart returns to the factory firmware through the stock
bootloader. Everything happens in one ROM connection, because a second connection after
a long read has failed on this unit ("Failed to configure SPI flash pins").

It refuses, without writing, when:
  - the port is in use, the unit is not the identified one, or the flash voltage strap is
    not the 3.3 V this unit was verified with (press RST for download mode and retry);
  - the factory firmware is not the confirmed running slot (ota_1);
  - ota_0 does not hold exactly the resident DSH image (a factory update may have replaced
    it: reinstall is a separate, reviewed step).
It never retries a write. Run with the IDF Python (it needs esptool 5).

  python scripts/enter_dsh.py --identity .local/residency/device/identified-device.json \
      --image PATH/stack-chan.bin --sha256 HEX [--auto-rom]
"""
import argparse
import hashlib
import json
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

OTADATA, SECTOR, OTA0 = 0xd000, 0x1000, 0x20000
OTA_NEW, OTA_VALID, OTA_INVALID, OTA_ABORTED, OTA_UNDEFINED = 0, 2, 3, 4, 0xffffffff


def record(sequence, state):
    seq = struct.pack('<I', sequence)
    return seq + b'\xff' * 20 + struct.pack('<II', state, zlib.crc32(seq, 0xffffffff))


def parse(sector):
    seq, = struct.unpack_from('<I', sector, 0)
    state, crc = struct.unpack_from('<II', sector, 24)
    valid = seq != 0xffffffff and crc == zlib.crc32(struct.pack('<I', seq), 0xffffffff)
    return {'seq': seq, 'state': state, 'valid': valid}


def plan_selection(otadata):
    """Which otadata sector to write, and the sequence that selects ota_0 once.

    The running slot is the highest valid record that is not ABORTED or INVALID (after a DSH
    visit the other sector holds a higher, ABORTED DSH record). It must be the confirmed
    factory firmware in ota_1 (even sequence); its sequence + 1 (odd) selects ota_0 once.
    """
    records = [parse(otadata[i * SECTOR:(i + 1) * SECTOR]) for i in (0, 1)]
    valid = [(r['seq'], i) for i, r in enumerate(records) if r['valid']]
    running = [(s, i) for s, i in valid if records[i]['state'] not in (OTA_INVALID, OTA_ABORTED)]
    if not running:
        return {'refused': 'no-ota-record', 'records': records}
    seq, active = max(running)
    # Already selected but not started yet (a reset went back to download mode): the NEW
    # ota_0 record sits right above the confirmed factory record. Nothing to write.
    other = records[1 - active]
    if (records[active]['state'] == OTA_NEW and (seq - 1) % 2 == 0 and other['valid'] and
            other['seq'] == seq - 1 and other['state'] in (OTA_VALID, OTA_UNDEFINED)):
        return {'active': 1 - active, 'target': OTADATA + active * SECTOR, 'records': records,
                'sequence': seq, 'already': True}
    if (seq - 1) % 2 != 1 or records[active]['state'] not in (OTA_VALID, OTA_UNDEFINED):
        return {'refused': 'factory-not-confirmed-running', 'records': records}
    # Same choice as the reviewed trial install (review_stock_trial_install.py): running
    # sequence + 1 in the other sector, replacing whatever that sector held.
    return {'active': active, 'target': OTADATA + (1 - active) * SECTOR, 'records': records, 'sequence': seq + 1}


def log(path, event, **fields):
    line = json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **fields})
    print(line)
    if path:
        with open(path, 'a') as out:
            out.write(line + '\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--identity', type=Path, required=True)
    p.add_argument('--image', type=Path, required=True)
    p.add_argument('--sha256', required=True, help='expected SHA-256 of the resident image file')
    p.add_argument('--auto-rom', action='store_true', help='try a USB reset into download mode first')
    p.add_argument('--log', type=Path)
    a = p.parse_args()
    import esptool.cmds as cmds

    identity = json.loads(a.identity.read_text())
    port, mac = identity['port'], identity['usbSerial'].lower()
    image = a.image.read_bytes()
    if hashlib.sha256(image).hexdigest() != a.sha256:
        log(a.log, 'refused', reason='image-file-changed'); return 2
    if subprocess.run(['/usr/sbin/lsof', '-t', port], capture_output=True).stdout.strip():
        log(a.log, 'refused', reason='port-in-use', port=port); return 2
    try:
        esp = cmds.detect_chip(port, connect_mode='usb-reset' if a.auto_rom else 'no-reset', connect_attempts=1)
    except Exception as error:
        log(a.log, 'refused', reason='no-rom', detail=str(error)[:200],
            hint='Hold RST about 3 s until the green light, then retry'); return 3
    try:
        if ':'.join(f'{b:02x}' for b in esp.read_mac()) != mac:
            log(a.log, 'refused', reason='different-unit'); return 2
        voltage = esp._get_rtc_cntl_flash_voltage() or esp._get_efuse_flash_voltage()
        if voltage is None:
            voltage = '1.8V' if esp.read_reg(esp.GPIO_STRAP_REG) & esp.GPIO_STRAP_VDDSPI_MASK else '3.3V'
        if voltage != '3.3V':
            log(a.log, 'refused', reason='flash-voltage', voltage=voltage,
                hint='Hold RST about 3 s until the green light, then retry'); return 3
        cmds.attach_flash(esp)
        otadata = cmds.read_flash(esp, OTADATA, 2 * SECTOR, no_progress=True)
        plan = plan_selection(otadata)
        if 'refused' in plan:
            log(a.log, 'refused', reason=plan['refused'], records=plan['records']); return 2
        new_seq, active = plan['sequence'], plan['active']
        md5 = esp.flash_md5sum(OTA0, len(image))
        if md5 != hashlib.md5(image).hexdigest():
            log(a.log, 'refused', reason='ota0-not-resident-dsh',
                hint='A factory update may have replaced DSH; reinstall is a separate reviewed step'); return 2
        target = OTADATA + (1 - active) * SECTOR
        wanted = record(new_seq, OTA_NEW).ljust(SECTOR, b'\xff')
        current = otadata[(1 - active) * SECTOR:(2 - active) * SECTOR]
        if current != wanted:
            cmds.write_flash(esp, [(target, wanted)], flash_size='keep', no_compress=True)
            if cmds.read_flash(esp, target, SECTOR, no_progress=True) != wanted:
                log(a.log, 'failed', reason='readback-mismatch', sector=hex(target),
                    hint='Do not retry; restore from the backup in .local/backups'); return 4
        log(a.log, 'selected', sector=hex(target), sequence=new_seq)
        # A USB-reset entry into download mode sets the force-download-boot flag; clear it so the
        # reset starts the application instead of returning to download mode (esptool's own
        # hard reset does the same).
        esp.write_reg(esp.RTC_CNTL_OPTION1_REG, 0, esp.RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK)
        cmds.reset_chip(esp, 'watchdog-reset')
        log(a.log, 'reset', note='DSH starts once; Home or a restart returns to the factory firmware')
        return 0
    except Exception as error:   # Report and stop; a write is never retried.
        log(a.log, 'failed', reason='esptool-error', detail=f'{type(error).__name__}: {error}'[:300])
        return 4
    finally:
        try:
            esp._port.close()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
