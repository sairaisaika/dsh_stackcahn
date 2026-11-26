"""Offline independent-Agent capacity review; never emits a selector or flash command.

Run using the pinned IDF Python environment (esptool required).
The backup is a historical snapshot, not a fresh device observation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from inspect_backup import inspect


def require(condition, message):
    if not condition:
        raise ValueError(message)


def aligned(value, alignment):
    return (value + alignment - 1) // alignment * alignment


def capacity(flash_bytes, partitions, image_bytes):
    require(flash_bytes == 16 * 1024 * 1024, 'Only the inspected 16 MiB profile is supported')
    require(type(image_bytes) is int and 0 < image_bytes <= flash_bytes, 'Invalid candidate size')
    require(bool(partitions), 'No original partitions')
    spans = []
    for partition in partitions:
        start, size = int(partition['offset'], 16), partition['bytes']
        require(type(size) is int and size > 0 and start >= 0x9000 and start + size <= flash_bytes,
                'Original partition outside inspected Flash')
        spans.append((start, start + size))
    spans.sort()
    require(all(a[1] <= b[0] for a, b in zip(spans, spans[1:])), 'Original partitions overlap')
    app_start = aligned(spans[-1][1], 0x10000)
    config_start = flash_bytes - 0x4000
    available = max(0, config_start - app_start)
    required = aligned(image_bytes, 0x1000)
    remaining = available - required
    return {
        'originalPartitionsEnd': hex(spans[-1][1]),
        'provisionalAppStart': hex(app_start),
        'appStartAlignment': 0x10000,
        'appSizeAlignment': 0x1000,
        'provisionalConfigStart': hex(config_start),
        'configBytes': 0x4000,
        'availableAppBytes': available,
        'imageBytes': image_bytes,
        'requiredAppBytes': required,
        'remainingBytes': remaining,
        'fitsCurrentImage': app_start <= config_start and remaining >= 0,
        'installable': False,
        'partitionTableGenerated': False,
        'bootSelectorGenerated': False,
        'deviceAccess': False,
        'unresolved': ['Boot entry and manual factory return', 'Factory OTA coexistence',
                       'Remaining camera/motion and other feature growth',
                       'Fresh device inspection before an approved installation',
                       'Hardware voice/binding and restore-write acceptance'],
    }


def review(backup_dir, build_dir, receipt_path):
    # Import lazily so pure alignment checks require no IDF installation.
    from prepare_installation import image_info
    first = (backup_dir/'flash-A.bin').read_bytes()
    second = (backup_dir/'flash-B.bin').read_bytes()
    verification = json.loads((backup_dir/'verification.json').read_text())
    digest = lambda value: hashlib.sha256(value).hexdigest()
    require(first == second and digest(first) == verification['sha256'], 'Backup copies/receipt mismatch')
    table = inspect(backup_dir/'flash-A.bin')
    require(table['sha256'] == digest(first) and table['bytes'] == len(first),
            'Backup changed during partition inspection')
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    require(receipt['profile'].startswith('independent-'), 'Not an independent Agent build')
    candidate = (build_dir/'stack-chan.bin').read_bytes()
    artifact = receipt['artifacts']['stack-chan.bin']
    require(len(candidate) == artifact['bytes'] and digest(candidate) == artifact['sha256'],
            'Candidate does not match the build receipt')
    info = image_info(candidate)
    require(info.get('version') == receipt['appVersion'] and info['imageBytes'] == len(candidate),
            'Actual image identity/length does not match receipt')
    result = capacity(len(first), table['partitions'], len(candidate))
    result.update({'version': 1, 'profile': receipt['profile'], 'appVersion': receipt['appVersion'],
                   'backupSha256': digest(first), 'imageSha256': digest(candidate),
                   'buildReceiptSha256': digest(receipt_bytes), 'imageValidation': info,
                   'observation': 'Saved backup and local candidate only; no live device check'})
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('backup-dir', 'build-dir', 'receipt', 'output'):
        parser.add_argument('--'+name, type=Path, required=True)
    args = parser.parse_args()
    result = review(args.backup_dir, args.build_dir, args.receipt)
    os.umask(0o077)
    with args.output.open('x') as output:
        output.write(json.dumps(result, indent=2)+'\n')
    print('Offline capacity review saved; installable=false. No device access.')
