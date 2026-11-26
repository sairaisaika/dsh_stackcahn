"""Test the existing DSH stores with a runtime NVS allocation and stock bootloader."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess

from audit_agent_layout import pinned_partition_tool
from audit_agent_qemu import A, B, OTA, OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, boot, default_efuse, ota_record
from app_center_baseline import OWNER_PREFIX, layout_header, reviewed_firmware, reviewed_partition_csv
from prepare_agent_bundle import CONFIG_OFFSET, FLASH_SIZE, ROOT, SECTOR, TABLE_END, TABLE_OFFSET
from prepare_installation import image_info, sha

PROBE = ROOT/'firmware/tests/app-center-storage'
APP = 'sion-app-center-storage-probe'
OWNER = CONFIG_OFFSET-SECTOR
CJSON_DIGESTS = {
    'cJSON.c': '607e756460fa0de37d20a7a9181f2de29c97bfb7ce5a0e6c2f548243836cd852',
    'cJSON.h': '25b0145150d500498e4d209cec69c18c42cf818bffcc54690be3b895a2a16dee',
}


def prepare(args):
    start, _ = reviewed_firmware(args.backup, erased_tail_from=OWNER)
    for name, expected in CJSON_DIGESTS.items():
        if sha((args.cjson_source/name).read_bytes()) != expected:
            raise ValueError('Use cJSON from the reviewed v38 build')
    shutil.copytree(PROBE, args.source)
    main = args.source/'main'
    for name in ('tail_storage.cc', 'tail_storage.h'):
        shutil.copyfile(ROOT/'firmware/app-center'/name, main/name)
    (main/'reviewed_layout.h').write_text(layout_header(start[TABLE_OFFSET:]))
    (args.source/'partitions.csv').write_text(reviewed_partition_csv())
    store_sources = ROOT/'firmware/agent'
    (main/'agent').mkdir()
    for name in ('storage_guard.cc', 'settings_store.cc', 'pairing_store.cc', 'agent_relay_config.cc'):
        shutil.copyfile(store_sources/name, main/'agent'/name)
    for source in store_sources.glob('*.h'):
        shutil.copyfile(source, main/'agent'/source.name)
    (main/'sion').mkdir()
    for name in ('endpoint_policy.h', 'pairing_config.h'):
        shutil.copyfile(ROOT/'firmware/overlay/sion'/name, main/'sion'/name)
    for name in (*CJSON_DIGESTS, 'LICENSE'):
        shutil.copyfile(args.cjson_source/name, main/name)


def audit(args):
    start, stock = reviewed_firmware(args.backup)
    binary = args.source/'build'/APP
    elf = binary.with_suffix('.elf')
    probe = binary.with_suffix('.bin').read_bytes()
    if (args.source/'main/reviewed_layout.h').read_text() != layout_header(start[TABLE_OFFSET:]):
        raise ValueError('Probe was prepared for a different board layout')
    if image_info(probe).get('project') != APP:
        raise ValueError('Wrong probe image')
    if args.output.exists():
        raise ValueError('Choose a new report path')

    symbols = subprocess.check_output([args.nm, '--defined-only', str(elf)], text=True)
    done = next(int(line.split()[0], 16) for line in symbols.splitlines()
                if line.endswith(' T sion_storage_probe_done'))
    stock_entry = struct.unpack_from('<I', stock, 4)[0]
    efuse = default_efuse(args.idf)
    flash = bytearray(b'\xff'*FLASH_SIZE)
    flash[:len(start)] = start
    flash[A:A+len(probe)] = probe
    flash[B:B+len(stock)] = stock
    flash[OTA:OTA+32] = ota_record(2, OTA_VALID)
    flash[OTA+SECTOR:OTA+SECTOR+32] = ota_record(3, OTA_NEW)
    for address, marker in ((0x9000, b'synthetic-stock-nvs'), (0xa00000, b'synthetic-stock-assets'),
                            (0xe00000, b'synthetic-stock-crash')):
        flash[address:address+len(marker)] = marker

    def check(name, data, endpoint, offsets, message):
        loaded, uart, observed, _ = boot(name, 'stock', data, efuse, endpoint, args.qemu, args.gdb, elf)
        if loaded != offsets or f'SION-STORE: {message}' not in uart:
            raise ValueError(f'{name}: unexpected boot or storage status\n{uart[-1400:]}')
        return bytearray(observed)

    persisted = check('first-enrollment', flash, stock_entry, [A, B], 'saved through DSH stores')
    expected = bytearray(flash)
    expected[OTA+SECTOR:OTA+SECTOR+32] = ota_record(3, OTA_ABORTED)
    owner_record = OWNER_PREFIX+hashlib.sha256(start[TABLE_OFFSET:]).digest()
    if (persisted[:OWNER] != expected[:OWNER] or persisted[OWNER:OWNER+len(owner_record)] != owner_record or
            persisted.count(0xff, OWNER+len(owner_record), CONFIG_OFFSET) != SECTOR-len(owner_record) or
            persisted[CONFIG_OFFSET:] == flash[CONFIG_OFFSET:]):
        raise ValueError('Expected only the owned storage and probe OTA sector to change')

    def restore(name, data, status):
        data = bytearray(data)
        data[OTA+SECTOR:OTA+SECTOR+32] = ota_record(5, OTA_NEW)
        observed = check(name, data, done, [A], status)
        data[OTA+SECTOR:OTA+SECTOR+32] = ota_record(5, OTA_PENDING_VERIFY)
        if observed != data:
            raise ValueError(f'{name}: expected only a bootloader OTA state transition')

    restore('credentials-and-settings-reloaded', persisted, 'pairing and preferences restored')
    torn = bytearray(persisted)
    torn[OWNER+len(OWNER_PREFIX):OWNER+len(owner_record)] = b'\xff'*32
    restore('torn-ownership-record', torn, 'unavailable (ESP_ERR_INVALID_STATE)')
    occupied = bytearray(flash)
    occupied[CONFIG_OFFSET] = 0xf0
    restore('nonempty-unclaimed-tail', occupied, 'unavailable (ESP_ERR_INVALID_STATE)')
    different_table = bytearray(flash)
    tool = pinned_partition_tool(args.idf)
    layout = tool.PartitionTable.from_csv(reviewed_partition_csv()+f'reserved,data,0x40,{OWNER:#x},0x1000,\n')
    layout.verify()
    different_table[TABLE_OFFSET:TABLE_END] = layout.to_binary().ljust(SECTOR, b'\xff')
    restore('updated-table-claims-tail', different_table, 'unavailable (ESP_ERR_NOT_SUPPORTED)')

    report = {'deviceAccess': False, 'installable': False,
              'productionBootloaderSha256': sha(start[:TABLE_OFFSET]),
              'productionTableSha256': sha(start[TABLE_OFFSET:]),
              'probeSha256': sha(probe), 'appCenterReentryModelled': True,
              'firstEnrollment': {'ownershipSector': hex(OWNER), 'isolatedNvsStart': hex(CONFIG_OFFSET),
                                  'stockApplicationEntryReached': True, 'preservedOutsideReviewedRegions': True},
              'coldReentry': {'pairingReloaded': True, 'preferencesReloaded': True, 'storageUnchanged': True},
              'rejectedWithoutStorageWrites': ['torn ownership record', 'unclaimed nonempty tail',
                                               'changed partition table with tail reservation']}
    args.output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(required=True)
    for action, function in (('prepare', prepare), ('audit', audit)):
        command = subparsers.add_parser(action)
        options = ('backup', 'source', 'cjson-source') if action == 'prepare' else (
            'backup', 'source', 'idf', 'qemu', 'gdb', 'nm', 'output')
        for name in options:
            command.add_argument('--'+name, type=lambda path: Path(path).resolve(), required=True)
        command.set_defaults(action=function)
    arguments = parser.parse_args()
    arguments.action(arguments)
