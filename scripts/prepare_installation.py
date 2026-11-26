"""Offline, device-specific installation review. Produces no flash commands or selector.

Run with the pinned ESP-IDF Python environment (esptool 5.6.0).
This report is deliberately never an authorization to install.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import zlib

from inspect_backup import inspect


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def image_info(data):
    from esptool.bin_image import ESP32S3FirmwareImage
    image = ESP32S3FirmwareImage(io.BytesIO(data))
    require(image.chip_id == 9, 'Not an ESP32-S3 image')
    require(image.checksum == image.calculate_checksum(), 'Image checksum mismatch')
    require(image.append_digest and image.stored_digest == image.calc_digest,
            'Missing or invalid image SHA-256')
    require(image.min_rev_full <= 2 and
            (image.max_rev_full in (0, 65535) or image.max_rev_full >= 2),
            'Image does not support inspected chip revision v0.2')
    result = {'imageBytes': image.data_length + 32,
              'flashMode': image.flash_mode, 'flashSizeFreq': image.flash_size_freq,
              'checksumValid': True, 'digestValid': True}
    if data[32:36] == struct.pack('<I', 0xabcd5432):
        for name, start, length in [('version', 48, 32), ('project', 80, 32), ('idf', 144, 32)]:
            result[name] = data[start:start+length].split(b'\0')[0].decode('ascii')
    return result


def ota_records(data, *, include_crc=False):
    require(len(data) == 8192, 'Expected two OTA sectors')
    result = []
    for sector in range(2):
        offset = sector * 4096
        seq = struct.unpack_from('<I', data, offset)[0]
        state, crc = struct.unpack_from('<II', data, offset + 24)
        crc_valid = crc == zlib.crc32(data[offset:offset+4], 0xffffffff)
        valid = seq not in (0, 0xffffffff) and state in (0, 1, 2, 0xffffffff) and crc_valid
        record = {'sector': sector, 'sequence': seq, 'state': state, 'valid': valid}
        if include_crc:
            record['crcValid'] = crc_valid
        result.append(record)
    return result


def assets_info(data):
    count, checksum, length = struct.unpack_from('<III', data)
    require(0 < count <= 1024 and count * 44 <= length <= len(data)-12,
            'Invalid assets bounds')
    require(sum(data[12:12+length]) & 0xffff == checksum, 'Assets checksum mismatch')
    files = {}
    for i in range(count):
        raw, size, offset, _, _ = struct.unpack_from('<32sIIHH', data, 12 + i * 44)
        name = raw.split(b'\0')[0].decode('ascii')
        start = 12 + count * 44 + offset
        require(name not in files and start+2+size <= 12+length, 'Invalid assets entry')
        require(data[start:start+2] == b'ZZ', 'Invalid asset marker')
        files[name] = data[start+2:start+2+size]
    index = json.loads(files['index.json'].rstrip(b'\0'))
    require(index['version'] == 1, 'Unsupported assets version')
    model = index['srmodels']
    require(model in files and index['text_font'] in files, 'Missing model/font asset')
    return {'files': count, 'payloadBytes': length, 'checksumValid': True,
            'indexVersion': index['version'], 'font': index['text_font'],
            'speechModelSha256': sha(files[model]),
            'partitionSha256': sha(data)}


def prepare(backup_dir, artifacts, receipt_path, review_path):
    backup = backup_dir / 'flash-A.bin'
    first = backup.read_bytes()
    second = (backup_dir / 'flash-B.bin').read_bytes()
    verification = json.loads((backup_dir / 'verification.json').read_text())
    require(len(first) == 16*1024*1024 and first == second, 'Full backups differ or wrong size')
    require(sha(first) == verification['sha256'], 'Backup receipt mismatch')
    table = inspect(backup)
    partitions = {p['label']: p for p in table['partitions']}
    expected = {'nvs': (0x9000, 0x4000), 'otadata': (0xd000, 0x2000),
                'phy_init': (0xf000, 0x1000), 'ota_0': (0x20000, 0x4f0000),
                'ota_1': (0x510000, 0x4f0000), 'assets': (0xa00000, 0x400000),
                'coredump': (0xe00000, 0x10000)}
    require(set(partitions) == set(expected), 'Unexpected partition set')
    for name, (offset, size) in expected.items():
        p = partitions[name]
        require((int(p['offset'], 16), p['bytes']) == (offset, size), 'Unexpected partition layout')
    def region(name):
        start, length = expected[name]
        return first[start:start+length]
    records = ota_records(region('otadata'))
    # This preparation is deliberately specific to the inspected device snapshot.
    require(records[0] == {'sector': 0, 'sequence': 3, 'state': 4, 'valid': False}
            and records[1] == {'sector': 1, 'sequence': 2, 'state': 2, 'valid': True},
            'OTA snapshot changed; repeat installation review')
    original = image_info(region('ota_1'))
    require(original.get('project') == 'stack-chan' and original.get('version') == '1.6.2',
            'Unexpected original application')
    candidate = (artifacts / 'build/stack-chan.bin').read_bytes()
    receipt = json.loads(receipt_path.read_text())
    item = next(a for a in receipt['artifacts'] if a['path'] == 'build/stack-chan.bin')
    require(len(candidate) == item['bytes'] and sha(candidate) == item['sha256'],
            'Candidate differs from build receipt')
    review = json.loads(review_path.read_text())
    require(review['candidateSha256'] == sha(candidate), 'Review belongs to another candidate')
    candidate_info = image_info(candidate)
    require(candidate_info.get('project') == 'stack-chan', 'Unexpected candidate project')
    require(len(candidate) <= expected['ota_0'][1], 'Candidate exceeds app slot')
    require(all(candidate_info[k] == original[k] for k in ('flashMode', 'flashSizeFreq')),
            'Flash header settings differ; review required')
    partition_binary = (artifacts / 'build/partition_table/partition-table.bin').read_bytes()
    require(first[0x8000:0x8000+len(partition_binary)] == partition_binary,
            'Candidate partition table differs')
    original_assets = assets_info(region('assets'))
    generated_assets = assets_info((artifacts / 'build/generated_assets.bin').read_bytes())
    erased = (len(candidate) + 4095) // 4096 * 4096
    return {'schemaVersion': 1, 'status': 'blocked-not-installable',
            'deviceAccess': False, 'flashAuthorized': False, 'readyToFlash': False,
            'backupSha256': sha(first), 'candidateSha256': sha(candidate),
            'originalApp': original, 'candidateApp': candidate_info,
            'originalBootloader': image_info(first[:0x8000]), 'otaRecords': records,
            'originalAssets': original_assets, 'generatedAssets': generated_assets,
            'speechModelBytesIdentical': original_assets['speechModelSha256'] == generated_assets['speechModelSha256'],
            'proposedInstall': {'slot': 'ota_0', 'offset': '0x20000', 'bytes': len(candidate),
                'eraseBytes': erased, 'eraseEndExclusive': hex(0x20000+erased),
                'preservedOriginalSlot': 'ota_1', 'activationSector': '0xd000',
                'activationBytes': 4096, 'preservedValidOtaSector': '0xe000',
                'selectorGenerated': False, 'note': 'Only after source fixes, new build and new review'},
            'recoveryLevels': [
                {'scope': 'Original boot selection', 'offset': '0xd000', 'bytes': 8192,
                 'sha256': sha(region('otadata')), 'condition': 'Original ota_1 and shared data intact'},
                {'scope': 'NVS snapshot', 'offset': '0x9000', 'bytes': 16384,
                 'sha256': sha(region('nvs')), 'condition': 'Only if configuration changed; snapshot loses later settings'},
                {'scope': 'Full same-device snapshot', 'offset': '0x0', 'bytes': len(first),
                 'sha256': sha(first), 'condition': 'Last resort, separately reviewed; cloud state excluded'}],
            'blockers': review['blockers'],
            'limitations': ['No restore-write test', 'Cloud binding cannot be backed up in Flash',
                            'Binary format validation is not hardware voice/App compatibility',
                            'Recheck live device and take fresh backups before any authorized installation']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('backup-dir', 'artifacts', 'receipt', 'review', 'output'):
        parser.add_argument('--'+arg, type=Path, required=True)
    args = parser.parse_args()
    report = prepare(args.backup_dir, args.artifacts, args.receipt, args.review)
    os.umask(0o077)
    with args.output.open('x') as output:
        output.write(json.dumps(report, indent=2)+'\n')
    print('Offline review saved. BLOCKED: no device access, no selector, no flash commands.')
