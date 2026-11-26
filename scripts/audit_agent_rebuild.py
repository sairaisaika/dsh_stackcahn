"""Compare two prepared Agent builds offline without authorizing installation."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import struct
import sys

from elftools.common.exceptions import ELFError
from elftools.elf.elffile import ELFFile

from prepare_agent import verify
from prepare_installation import image_info, sha


def image(raw, elf):
    result = image_info(raw)
    if result['imageBytes'] != len(raw) or 'version' not in result:
        raise ValueError('Expected a complete ESP32-S3 image with an application descriptor')
    _, descriptor_size = struct.unpack_from('<II', raw, 24)
    if descriptor_size < 256 or raw[176:208].hex() != sha(elf):
        raise ValueError('Application descriptor or embedded ELF SHA-256 does not match')
    normalized = bytearray(raw[:-32])
    # esp_app_desc_t at image offset 32, then the checksum byte at the end.
    normalized[112:144] = bytes(32)
    normalized[176:208] = bytes(32)
    normalized[-1] = 0
    result.update(sha256=sha(raw), normalizedSha256=sha(normalized), elfSha256=sha(elf),
                  compileTime=raw[112:128].partition(b'\0')[0].decode('ascii'),
                  compileDate=raw[128:144].partition(b'\0')[0].decode('ascii'))
    return result, normalized


def sections(raw):
    return {section.name: {'bytes': section['sh_size'], 'address': section['sh_addr'],
                           'allocated': bool(section['sh_flags'] & 2),
                           'sha256': None if section['sh_type'] == 'SHT_NOBITS'
                           else sha(section.data())}
            for section in ELFFile(BytesIO(raw)).iter_sections()}


def build(root):
    prepared = verify(root)
    prep = root.joinpath('.agent-prepared.json').read_bytes()
    rec = json.loads(root.joinpath('.agent-build.json').read_bytes())
    if (rec['preparedReceiptSha256'] != sha(prep) or
            any(rec[key] != prepared[key] for key in ('profile', 'appVersion', 'inputs'))):
        raise ValueError('Build receipt does not match prepared source receipt')
    directory = root / 'firmware/build'
    artifacts = {name: directory.joinpath(name).read_bytes()
                 for name in ('stack-chan.bin', 'stack-chan.elf', 'agent-sdkconfig')}
    for name, data in artifacts.items():
        if rec['artifacts'][name] != {'sha256': sha(data), 'bytes': len(data)}:
            raise ValueError('Build artifact does not match receipt: ' + name)
    return prep, rec, artifacts


def compare(reference, rebuild):
    a_prep, a_receipt, a = build(reference)
    b_prep, b_receipt, b = build(rebuild)
    a_info, a_norm = image(a['stack-chan.bin'], a['stack-chan.elf'])
    b_info, b_norm = image(b['stack-chan.bin'], b['stack-chan.elf'])
    a_sections, b_sections = sections(a['stack-chan.elf']), sections(b['stack-chan.elf'])
    differences = sorted(name for name in a_sections.keys() | b_sections.keys()
                         if a_sections.get(name) != b_sections.get(name))
    first = next((i for i, (x, y) in enumerate(zip(a_norm, b_norm)) if x != y), None)
    identities_match = all(a_receipt[k] == b_receipt[k] for k in ('idf', 'profile', 'appVersion', 'inputs'))
    partition_path = 'firmware/build/partition_table/partition-table.bin'
    partition_tables_match = (reference / partition_path).read_bytes() == (rebuild / partition_path).read_bytes()
    return {
        'profile': a_receipt['profile'], 'idf': a_receipt['idf'], 'inputs': len(a_receipt['inputs']),
        'buildIdentitiesMatch': identities_match, 'preparedReceiptsMatch': a_prep == b_prep,
        'preparedFiles': len(json.loads(a_prep)['files']),
        'sdkconfigMatch': a['agent-sdkconfig'] == b['agent-sdkconfig'],
        'partitionTableMatch': partition_tables_match,
        'applicationIdentical': a_info['sha256'] == b_info['sha256'],
        'normalizedApplicationIdentical': a_norm == b_norm,
        'firstNormalizedDifference': first,
        'byteDifferencesExcludingMetadata': sum(x != y for x, y in zip(a_norm, b_norm)) + abs(len(a_norm) - len(b_norm)),
        'elfIdentical': a_info['elfSha256'] == b_info['elfSha256'],
        'differingElfSections': differences,
        'differingAllocatedElfSections': [name for name in differences if
            a_sections.get(name, {}).get('allocated') or b_sections.get(name, {}).get('allocated')],
        'reference': a_info, 'rebuild': b_info,
        'installable': False, 'hardwareValidated': False,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path)
    parser.add_argument('rebuild', type=Path)
    args = parser.parse_args()
    try:
        result = compare(args.reference.resolve(), args.rebuild.resolve())
    except (ELFError, KeyError, OSError, RuntimeError, ValueError) as error:
        sys.exit(f'Rebuild comparison stopped: {error}')
    print(json.dumps(result, indent=2))
    if not all(result[k] for k in ('buildIdentitiesMatch', 'preparedReceiptsMatch', 'sdkconfigMatch',
                                   'partitionTableMatch', 'normalizedApplicationIdentical')):
        sys.exit(1)
