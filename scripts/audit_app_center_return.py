"""Prepare and emulate an explicit OTA return using the unchanged production bootloader."""
import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess

from audit_agent_qemu import A, B, OTA, OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, boot, default_efuse, ota_record
from app_center_baseline import digest_header, reviewed_firmware, reviewed_partition_csv
from prepare_agent_bundle import FLASH_SIZE, ROOT, SECTOR, TABLE_OFFSET
from prepare_installation import image_info, sha

PROBE = ROOT/'firmware/tests/app-center-return'
INVALID = 3


def prepare(args):
    _, stock = reviewed_firmware(args.backup)
    shutil.copytree(PROBE, args.source)
    (args.source/'main/reviewed_stock_digest.h').write_text(digest_header(stock))
    (args.source/'partitions.csv').write_text(reviewed_partition_csv())


def audit(args):
    original_start, stock = reviewed_firmware(args.backup)
    if (args.source/'main/reviewed_stock_digest.h').read_text() != digest_header(stock):
        raise ValueError('Build must pin the same verified stock digest')
    build = args.source/'build'
    path = build/'sion-app-center-return-probe'
    elf, probe = path.with_suffix('.elf'), path.with_suffix('.bin').read_bytes()
    if image_info(probe).get('project') != path.name:
        raise ValueError('Wrong probe image')
    symbols = subprocess.check_output([args.nm, '--defined-only', str(elf)], text=True)
    refusal = next(int(line.split()[0], 16) for line in symbols.splitlines()
                   if line.endswith(' T sion_app_center_return_refused'))
    stock_entry = struct.unpack_from('<I', stock, 4)[0]
    probe_entry = struct.unpack_from('<I', probe, 4)[0]
    fuse = default_efuse(args.idf)
    if args.output.exists():
        raise ValueError('Choose a new report path')
    results = {}

    def fixture(dev, dev_sequence, dev_state, stock_state=OTA_VALID, stock_image=stock):
        original = B if dev == A else A
        flash = bytearray(b'\xff'*FLASH_SIZE)
        flash[:len(original_start)] = original_start
        flash[dev:dev+len(probe)] = probe
        flash[original:original+len(stock_image)] = stock_image
        flash[OTA:OTA+32] = ota_record(dev_sequence-1, stock_state)
        flash[OTA+SECTOR:OTA+SECTOR+32] = ota_record(dev_sequence, dev_state)
        flash[0x9000:0x9013] = b'synthetic-stock-nvs'
        flash[0xa00000:0xa00016] = b'synthetic-stock-assets'
        flash[0xe00000:0xe00016] = b'synthetic-stock-crash!'
        return flash, original

    def run(name, flash, original, dev, sequence, final_state, refused=None):
        expect = bytearray(flash)
        expect[OTA+SECTOR:OTA+SECTOR+32] = ota_record(sequence, final_state)
        entry = refusal if refused else stock_entry
        slots = [dev] if refused else ([original] if final_state == OTA_ABORTED else [dev, original])
        loaded, uart, readback, _ = boot(name, 'stock', flash, fuse, entry, args.qemu, args.gdb, elf)
        if loaded != slots or readback != expect:
            raise ValueError(f'{name}: partition handoff or exact virtual Flash readback differs\n{uart[-1200:]}')
        message = f'refused ({refused})' if refused else 'official slot retained'
        if final_state != OTA_ABORTED and f'SION-APP-CENTER: {message}' not in uart:
            raise ValueError(f'{name}: expected SDK outcome missing')
        results[name] = {'loaded': list(map(hex, loaded)), 'finalAgentState': final_state,
                         'stockRecordUnchanged': True, 'outsideAgentOtaSectorUnchanged': True}
        return bytearray(readback)

    flash, original = fixture(A, 3, OTA_NEW)
    returned = run('first-launch-and-return', flash, original, A, 3, INVALID)
    loaded, _, reread, _ = boot('after-return-normal-start', 'stock', returned, fuse,
                                 stock_entry, args.qemu, args.gdb, elf)
    if loaded != [original] or reread != returned:
        raise ValueError('A subsequent ordinary boot did not preserve the confirmed stock slot')
    results['after-return-normal-start'] = {
        'loaded': [hex(original)], 'finalAgentState': INVALID, 'stockRecordUnchanged': True,
        'outsideAgentOtaSectorUnchanged': True,
    }

    # The official download writes the OTA selector anew. The probe is already
    # present in the inactive slot so only that selector update is modelled.
    returned[OTA+SECTOR:OTA+SECTOR+32] = ota_record(5, OTA_NEW)
    run('download-again-and-return', returned, original, A, 5, INVALID)
    flash, original = fixture(B, 4, OTA_VALID)
    run('reverse-slots-confirmed-agent-return', flash, original, B, 4, INVALID)
    flash, original = fixture(A, 3, OTA_NEW)
    loaded, _, interrupted, _ = boot('cut-at-first-app-entry', 'stock', flash, fuse,
                                      probe_entry, args.qemu, args.gdb, elf)
    flash[OTA+SECTOR:OTA+SECTOR+32] = ota_record(3, OTA_PENDING_VERIFY)
    if loaded != [A] or interrupted != flash:
        raise ValueError('The original bootloader did not leave the first launch pending')
    run('interrupted-first-launch', interrupted, original, A, 3, OTA_ABORTED)
    damaged = bytearray(stock)
    damaged[0x1000] ^= 1
    flash, original = fixture(A, 3, OTA_VALID, stock_image=damaged)
    run('damaged-original-refused', flash, original, A, 3, OTA_VALID, 'ESP_ERR_INVALID_CRC')
    flash, original = fixture(A, 3, OTA_VALID, stock_image=probe)
    run('different-valid-image-refused', flash, original, A, 3, OTA_VALID, 'ESP_ERR_INVALID_CRC')
    flash, original = fixture(A, 3, OTA_VALID, stock_state=OTA_ABORTED)
    run('unconfirmed-original-refused', flash, original, A, 3, OTA_VALID, 'ESP_ERR_INVALID_STATE')

    report = {'deviceAccess': False, 'installable': False,
              'productionBootloaderSha256': sha(original_start[:TABLE_OFFSET]),
              'productionTableSha256': sha(original_start[TABLE_OFFSET:]),
              'productionExecutableSha256': sha(stock), 'probeSha256': sha(probe), 'results': results}
    args.output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(required=True)
    for action, function in (('prepare', prepare), ('audit', audit)):
        command = subparsers.add_parser(action)
        options = ('backup', 'source') if action == 'prepare' else (
            'backup', 'source', 'idf', 'qemu', 'gdb', 'nm', 'output')
        for name in options:
            command.add_argument('--'+name, type=lambda path: Path(path).resolve(), required=True)
        command.set_defaults(action=function)
    arguments = parser.parse_args()
    arguments.action(arguments)
