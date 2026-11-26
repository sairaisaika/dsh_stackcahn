"""Prepare an immutable, offline Python environment; never opens a device."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

WHEEL = 'pyserial-3.5-py2.py3-none-any.whl'
SHA256 = 'c4451db6ba391ca6ca299fb3ec7bae67a5c55dde170964c7a14ceefec02f2cf0'
VENDOR = Path(__file__).resolve().parents[1] / 'vendor' / 'pyserial'


class SetupError(Exception):
    pass


def private(path, directory=False):
    info = path.lstat()
    correct = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SetupError('runtime_storage_invalid')


def read_active(root):
    path = root / 'active.json'
    try:
        private(path)
    except FileNotFoundError:
        return None
    with path.open('rb') as stream:
        data = stream.read(4097)
    value = json.loads(data)
    if len(data) > 4096 or not isinstance(value, dict) or set(value) != {'version', 'generation'} or value['version'] != 1 or not isinstance(value['generation'], str) or not re.fullmatch('[0-9a-f]{32}', value['generation']):
        raise SetupError('runtime_storage_invalid')
    return value['generation']


def run(command, timeout=90):
    environment = {**os.environ, 'PIP_CONFIG_FILE': os.devnull}
    subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=timeout, check=True, env=environment)


def verify(directory):
    private(directory, directory=True)
    # Isolated mode excludes user site and PYTHONPATH. No serial port enumeration.
    code = "import sys, pathlib, serial, importlib.metadata as m; root=pathlib.Path(sys.argv[1]).resolve(); assert sys.version_info >= (3,10); assert pathlib.Path(sys.prefix).resolve() == root and sys.prefix != sys.base_prefix; assert pathlib.Path(serial.__file__).resolve().is_relative_to(root); assert serial.VERSION == '3.5' and m.version('pyserial') == '3.5'"
    run([str(directory / 'bin/python3'), '-I', '-c', code, str(directory)], timeout=10)


def prepare(root):
    if sys.version_info < (3, 10):
        raise SetupError('runtime_python_required')
    if not root.is_absolute() or not root.parent.is_dir():
        raise SetupError('runtime_storage_invalid')
    os.umask(0o077)
    try:
        root.mkdir(mode=0o700)
    except FileExistsError:
        pass
    private(root, directory=True)
    fd = os.open(root / 'setup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise SetupError('runtime_storage_invalid')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('host_busy') from None
        current = read_active(root)
        if current:
            verify(root / current)
            return current
        wheel = VENDOR / WHEEL
        if hashlib.sha256(wheel.read_bytes()).hexdigest() != SHA256:
            raise SetupError('runtime_package_invalid')
        generation = secrets.token_hex(16)
        directory = root / generation
        directory.mkdir(mode=0o700)  # final location: venv is never moved
        run([sys.executable, '-I', '-m', 'venv', '--copies', str(directory)])
        # Pin again at pip's boundary; no index, dependency resolution or sdist.
        run([str(directory / 'bin/python3'), '-I', '-m', 'pip', '--isolated', 'install',
             '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--no-index',
             '--no-deps', '--no-user', '--only-binary=:all:', '--require-hashes',
             '--find-links', str(VENDOR), '-r', str(VENDOR / 'requirements.txt')])
        verify(directory)
        temporary = root / ('.active-' + generation)
        with temporary.open('x', encoding='utf8') as stream:
            json.dump({'version': 1, 'generation': generation}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / 'active.json')
        directory_fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return generation
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    try:
        generation = prepare(args.root)
        print(json.dumps({'ok': True, 'generation': generation}))
        return 0
    except SetupError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'runtime_setup_failed'}))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
