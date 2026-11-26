"""Measure BMI270 link cost using a completed Ninja build, with no device access."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess


PROBES = {
    'control': (),
    'bosch-register-api': ('bmi270_init', 'bmi2_get_regs', 'bmi2_set_regs'),
    'm5stack-bmi270': (
        '_ZN6BMI270C1EP16i2c_master_bus_th', '_ZN6BMI270D1Ev',
        '_ZN6BMI2705beginEv', '_ZN6BMI2706updateEv', '_ZN6BMI2707getDataEv',
    ),
    'factory-shake': ('_ZN3Hal8imu_initEv',),
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build_commands(build):
    cache = (build/'CMakeCache.txt').read_text()
    ninja = re.search(r'^CMAKE_MAKE_PROGRAM:FILEPATH=(.+)$', cache, re.M)
    if ninja is None:
        raise ValueError('A completed Ninja build is required')
    commands = subprocess.check_output(
        [ninja[1], '-t', 'commands', 'gen_project_binary'], cwd=build, text=True,
    ).splitlines()
    link = next((shlex.split(line) for line in commands if line.endswith(' -o stack-chan.elf && :')), None)
    convert = next((shlex.split(line.split(' && ')[1]) for line in commands if ' elf2image ' in line), None)
    if (not link or link[:2] != [':', '&&'] or not link[2].endswith('elf-g++') or
            not convert or convert[-3:] != ['-o', str(build/'stack-chan.bin'), str(build/'stack-chan.elf')]):
        raise ValueError('Generated link or image command does not match the independent Agent build')
    return link[2:-2], convert[:-2]


def response_file(build, output):
    text = (build/'build.ninja').read_text()
    target = re.search(r'^build stack-chan\.elf:[^\n]+\n((?:  [^\n]*\n)+)', text, re.M)
    if target is None:
        raise ValueError('Independent Agent link target is missing')
    objects = target[0].splitlines()[0].split(' | ', 1)[0].split()[3:]
    fields = dict(re.findall(r'^  (\w+) = (.*)$', target[1], re.M))
    if not objects or not {'LINK_PATH', 'LINK_LIBRARIES'} <= fields.keys():
        raise ValueError('Could not reproduce the original link response file')
    result = output/'inputs.rsp'
    result.write_text('\n'.join([*objects, fields['LINK_PATH'], fields['LINK_LIBRARIES']])+'\n')
    return result


def probe(source, output, slot_bytes):
    build = source/'firmware/build'
    receipt = json.loads((source/'.agent-build.json').read_text())
    for filename in ('stack-chan.bin', 'stack-chan.elf'):
        path = build/filename
        if receipt['artifacts'][filename] != {'bytes': path.stat().st_size, 'sha256': digest(path)}:
            raise ValueError('Built artifact differs from the receipt: '+filename)
    pristine = {path: digest(path) for path in (build/'stack-chan.bin', build/'stack-chan.elf', build/'stack-chan.map')}
    link, convert = build_commands(build)
    for prefix in ('@CMakeFiles/', '-Wl,--Map='):
        if sum(arg.startswith(prefix) for arg in link) != 1:
            raise ValueError('Generated link format changed')
    output.mkdir()
    inputs = response_file(build, output)
    results = {}
    for name, symbols in PROBES.items():
        elf = output/(name+'.elf')
        binary = output/(name+'.bin')
        link_map = output/(name+'.map')
        command = [
            '@'+str(inputs) if arg.startswith('@CMakeFiles/') else
            '-Wl,--Map='+str(link_map) if arg.startswith('-Wl,--Map=') else arg
            for arg in link[:-1]
        ]
        retain = ['-Wl,-u,'+symbol for symbol in symbols]
        subprocess.run([*command, str(elf), *retain], cwd=build, check=True)
        subprocess.run([*convert, str(binary), str(elf)], cwd=build, check=True)
        size = binary.stat().st_size
        aligned = (size+4095)//4096*4096
        results[name] = {'imageBytes': size, 'alignedBytes': aligned,
                         'remainingBytes': slot_bytes-aligned, 'sha256': digest(binary)}
        if name == 'control' and results[name]['sha256'] != pristine[build/'stack-chan.bin']:
            raise ValueError('The control does not reproduce the original image byte for byte')
    if any(digest(path) != sha256 for path, sha256 in pristine.items()):
        raise ValueError('Original build artifacts changed during the measurement')
    report = {'appVersion': receipt['appVersion'], 'appSlotBytes': slot_bytes, 'deviceAccess': False, 'results': results}
    (output/'result.json').write_text(json.dumps(report, indent=2)+'\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--app-slot-bytes', type=int, required=True)
    args = parser.parse_args()
    if args.app_slot_bytes <= 0 or args.app_slot_bytes % 4096:
        parser.error('--app-slot-bytes must be a positive multiple of 4096')
    print(json.dumps(probe(args.source.resolve(), args.output.resolve(), args.app_slot_bytes), indent=2))
