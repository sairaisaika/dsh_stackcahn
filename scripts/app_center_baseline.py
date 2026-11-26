"""Review a captured boot layout and generate build-time identities. No device access."""
from dataclasses import dataclass
import hashlib

from check_agent_preflight import read_snapshot
from inspect_backup import inspect_partitions
from prepare_agent_bundle import CONFIG_OFFSET, EXPECTED_PARTITIONS, FLASH_SIZE, SECTOR, TABLE_END, TABLE_OFFSET
from prepare_installation import image_info, ota_records

A, B = (EXPECTED_PARTITIONS[name][2] for name in ('ota_0', 'ota_1'))
OTA = EXPECTED_PARTITIONS['otadata'][2]
OWNER_PREFIX = b'SION-DSH-CFG-V1\0'
OWNER = CONFIG_OFFSET-SECTOR


@dataclass(frozen=True)
class AppCenterBaseline:
    stock: bytes
    stock_slot: str
    active_sequence: int
    active_record_sector: int
    table: bytes


def review_app_center(data):
    if len(data) != FLASH_SIZE:
        raise ValueError('Expected a full 16 MiB App Center snapshot')
    layout = inspect_partitions(data)
    observed = {p['label']: (p['type'], p['subtype'], int(p['offset'], 16), p['bytes']) for p in layout}
    if len(layout) != len(EXPECTED_PARTITIONS) or observed != EXPECTED_PARTITIONS or any(p['flags'] for p in layout):
        raise ValueError('Expected the reviewed unmodified two-slot table')
    records = [r for r in ota_records(data[OTA:OTA+2*SECTOR], include_crc=True)
               if r['crcValid'] and r['sequence'] != 0xffffffff]
    # esp_ota_get_state_partition checks the first matching slot record even
    # when the bootloader selected another by sequence. Reject conflicts.
    if any(r['sequence'] == 0 or r['state'] not in (0, 1, 2, 3, 4, 0xffffffff) for r in records):
        raise ValueError('Unexpected CRC-valid OTA record')
    if len(records) == 2 and records[0]['sequence'] % 2 == records[1]['sequence'] % 2:
        raise ValueError('Conflicting OTA records name the same slot')
    active = max((r for r in records if r['valid']), key=lambda r: r['sequence'], default=None)
    if not active or active['state'] != 2:
        raise ValueError('The selected factory application must be confirmed before preparing DSH')
    if active['sequence'] >= 0xfffffffe:
        raise ValueError('No OTA sequence space for the inactive slot')
    stock_slot = f'ota_{(active["sequence"] - 1) % 2}'
    _, _, offset, size = EXPECTED_PARTITIONS[stock_slot]
    stock_data = data[offset:offset+size]
    app = image_info(stock_data)
    if app.get('project') != 'stack-chan' or app.get('version') != '1.6.2':
        raise ValueError('Expected the reviewed production StackChan v1.6.2 image')
    return AppCenterBaseline(bytes(stock_data[:app['imageBytes']]), stock_slot, active['sequence'],
                             active['sector'], bytes(data[TABLE_OFFSET:TABLE_END]))


def reviewed_firmware(backup, *, erased_tail_from=None):
    """Read the historical factory-in-B baseline for the original audits."""
    data = read_snapshot(backup).data
    baseline = review_app_center(data)
    if baseline.stock_slot != 'ota_1':
        raise ValueError('This historical audit requires the confirmed factory image in ota_1')
    if erased_tail_from is not None and data.count(0xff, erased_tail_from) != FLASH_SIZE-erased_tail_from:
        raise ValueError('Saved factory image does not have an erased tail')
    return data[:TABLE_END], baseline.stock


def owner_record(table):
    return OWNER_PREFIX + hashlib.sha256(table).digest()


def require_app_center_storage(data, baseline):
    if data.count(0xff, OWNER) == FLASH_SIZE-OWNER:
        return 'erased'
    expected = owner_record(baseline.table).ljust(SECTOR, b'\xff')
    if data[OWNER:CONFIG_OFFSET] == expected:
        return 'owned'
    raise ValueError('Independent settings region has unknown or incomplete ownership')


def digest_header(stock):
    values = ', '.join(f'0x{byte:02x}' for byte in stock[-32:])
    return '#include <stdint.h>\nstatic const uint8_t reviewed_stock_digest[] = {'+values+'};\n'


def layout_header(table):
    digest = hashlib.sha256(table).digest()
    declarations = ['#include <array>', '#include <cstdint>']
    for name, data in (('ReviewedTableDigest', digest), ('ReviewedOwnerRecord', owner_record(table))):
        values = ', '.join(f'0x{byte:02x}' for byte in data)
        declarations.append(f'inline constexpr std::array<uint8_t, {len(data)}> {name}{{{values}}};')
    return '\n'.join(declarations)+'\n'


def reviewed_partition_csv():
    return '\n'.join(
        f'{label}, {kind:#x}, {subtype:#x}, {offset:#x}, {size:#x},'
        for label, (kind, subtype, offset, size) in EXPECTED_PARTITIONS.items()
    )+'\n'
