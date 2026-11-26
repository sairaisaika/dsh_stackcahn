"""Build only the offline candidate second-stage bootloader in a fresh directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT/'firmware/boot-selector'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def boot_config(path):
    prefixes = ('CONFIG_IDF_TARGET', 'CONFIG_BOOTLOADER_', 'CONFIG_SECURE_', 'CONFIG_ESPTOOLPY_', 'CONFIG_PARTITION_TABLE_')
    options = {}
    for line in path.read_text().splitlines():
        if line.startswith(prefixes):
            name, value = line.split('=', 1)
            options[name] = value
        elif line.startswith('# ') and line.endswith(' is not set') and line[2:].startswith(prefixes):
            options[line[2:-11]] = 'n'
    return options


def build(destination, reference, stock_base):
    if stock_base:
        revision = json.loads((PROJECT/'stock-sdk.lock.json').read_text())['commit']
    else:
        revision = json.loads((ROOT/'firmware/upstream.lock.json').read_text())['idf']['commit']
    idf = Path(os.environ['IDF_PATH']).resolve()
    actual = subprocess.check_output(['git', '-C', str(idf), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != revision:
        raise ValueError('Use the pinned ESP-IDF checkout')
    subprocess.run(['git', '-C', str(idf), 'diff', '--quiet', 'HEAD', '--', 'components', 'tools'], check=True)

    reference_receipt = json.loads((ROOT/'firmware/agent-size-build.json').read_text())
    reference_config = reference/'build/agent-sdkconfig'
    config_sha = sha(reference_config)
    if config_sha != reference_receipt['artifacts']['agent-sdkconfig']['sha256']:
        raise ValueError('Reference sdkconfig is not the verified v23 build')
    prepared = reference.parent/'.agent-prepared.json'
    if sha(prepared) != reference_receipt['preparedReceiptSha256']:
        raise ValueError('Reference source receipt is not the verified v23 build')
    csv = reference/'partitions.csv'
    if sha(csv) != json.loads(prepared.read_text())['files']['firmware/partitions.csv']:
        raise ValueError('Reference partition input changed')
    expected = boot_config(PROJECT/'sdkconfig.stock.defaults' if stock_base else reference_config)
    sources = {p.relative_to(PROJECT): sha(p) for p in PROJECT.rglob('*') if p.is_file()}
    builder_sha = sha(Path(__file__))


    shutil.copytree(PROJECT, destination)
    shutil.copyfile(csv, destination/'partitions.csv')
    cmd = [str(idf/'tools/idf.py'), '-C', str(destination)]
    if stock_base:
        cmd.extend(['-DIDF_TARGET=esp32s3', '-DSDKCONFIG_DEFAULTS=sdkconfig.stock.defaults'])
    else:
        shutil.copyfile(reference_config, destination/'sdkconfig')
    subprocess.run([*cmd, 'bootloader'], check=True)

    actual_config = boot_config(destination/'sdkconfig')
    # The small project omits other components, but boot-related options must
    # retain the checked v23 values in the generated configuration.
    names = expected.keys() if stock_base else expected.keys() | actual_config.keys()
    differences = sorted(name for name in names
                         if expected.get(name) != actual_config.get(name, 'n' if stock_base else None))
    if differences:
        raise ValueError('Boot configuration drift: ' + ', '.join(differences))
    if any(sha(destination/p) != digest or sha(PROJECT/p) != digest for p,digest in sources.items()):
        raise ValueError('Selector source changed during the build')
    if sha(Path(__file__)) != builder_sha:
        raise ValueError('Selector build script changed during the build')
    artifacts = destination/'build/bootloader'
    output = artifacts/'bootloader.bin'
    elf = artifacts/'bootloader.elf'

    size = output.stat().st_size
    if not 0 < size <= 0x8000:
        raise ValueError('Candidate bootloader exceeds the original bootloader region')

    receipt = {
        'profile': 'independent-boot-selector-v2-stock-base' if stock_base else 'independent-boot-selector-v1',
        'stockSdkBase': stock_base,
        'idf': revision,
        'referenceConfigSha256': config_sha,
        'generatedConfigSha256': sha(destination/'sdkconfig'),
        'referencePartitionsSha256': sha(destination/'partitions.csv'),
        'inputs': {
            str(Path(__file__).resolve().relative_to(ROOT)): builder_sha,
            **{str((PROJECT/p).relative_to(ROOT)): digest for p,digest in sorted(sources.items())},
        },
        'artifacts': {p.name: {'bytes': p.stat().st_size, 'sha256': sha(p)} for p in (output, elf)},
        'candidateOnly': True,
        'installable': False,
        'hardwareValidated': False,
    }
    (destination/'.selector-build.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print('Local candidate bootloader recorded. No device access.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True, help='Verified prepared v23 firmware directory')
    parser.add_argument('--stock-base', action='store_true', help='Build on the original ESP-IDF v5.5.4 release')
    args = parser.parse_args()
    build(args.destination.resolve(), args.reference.resolve(), args.stock_base)
