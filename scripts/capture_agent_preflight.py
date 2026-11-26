"""Read Sion only after an approved manual entry to ROM download mode."""
import argparse
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

from check_agent_preflight import ROOT, FLASH_SIZE, probe_identity, check_read_logs, read_snapshot
from prepare_installation import sha
from review_agent_capacity import require


def run_read(port, directory, log, *operation):
    # No other verbs are accepted, including reset, terminal passthrough or flash writes.
    if operation in (('get-security-info',), ('flash-id',)):
        flags = ['--no-stub']
    else:
        require(operation in (
            ('read-flash', '0', str(FLASH_SIZE), 'flash-A.bin'),
            ('read-flash', '0', str(FLASH_SIZE), 'flash-B.bin'),
        ), 'Unsupported capture operation')
        flags = ['--baud', '921600']
    env = dict(os.environ, ESPTOOL_OPEN_PORT_ATTEMPTS='1')
    args = [sys.executable, '-I', '-m', 'esptool', '--chip', 'esp32s3', '--port', port,
            '--before', 'no-reset', '--after', 'no-reset', *flags, *operation]
    with (directory/log).open('xb') as output:
        result = subprocess.run(args, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                stdout=output, stderr=subprocess.STDOUT, timeout=360, check=False)
    require(result.returncode == 0, f'{operation[0]} failed. See its private log.')


def collect(port, destination, historical_mac):
    run_read(port, destination, 'security-info.txt', 'get-security-info')
    run_read(port, destination, 'flash-id.txt', 'flash-id')
    mac = probe_identity(destination)
    require(mac == historical_mac, 'Connected unit differs from the reviewed Sion')
    run_read(port, destination, 'read-A.log', 'read-flash', '0', str(FLASH_SIZE), 'flash-A.bin')
    run_read(port, destination, 'read-B.log', 'read-flash', '0', str(FLASH_SIZE), 'flash-B.bin')
    check_read_logs(destination, mac)
    first = (destination/'flash-A.bin').read_bytes()
    require(len(first) == FLASH_SIZE and first == (destination/'flash-B.bin').read_bytes(),
            'The two full reads differ or are incomplete')
    with (destination/'verification.json').open('x') as output:
        output.write(json.dumps({
            'bytes': len(first), 'copies': ['flash-A.bin', 'flash-B.bin'], 'identical': True,
            'sha256': sha(first), 'flashWritten': False,
        }, indent=2)+'\n')


def capture(port, historical, destination):
    require(re.fullmatch(r'/dev/cu\.usb(?:modem|serial)[A-Za-z0-9._-]+', port) and
            not Path(port).is_symlink() and stat.S_ISCHR(Path(port).stat().st_mode),
            'Select the Mac USB serial port observed for Sion in download mode')
    require(version('esptool') == '5.6.0', 'Use the verified esptool 5.6.0 environment')
    base = ROOT/'.local/backups'
    require(base.resolve() == base and destination.parent == base,
            'Capture must use a new directory directly under this checkout’s .local/backups')
    baseline = read_snapshot(historical)
    old_mask = os.umask(0o077)
    try:
        destination.mkdir(mode=0o700)
        collect(port, destination, baseline.mac)
    finally:
        os.umask(old_mask)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--historical', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        capture(args.port, args.historical, args.output.resolve())
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        sys.exit(f'Read-only capture stopped: {error}')
    print('Two verified reads saved privately. No Flash write. Return Sion to its normal boot manually.')
