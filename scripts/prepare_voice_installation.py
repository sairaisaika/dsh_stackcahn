"""Build one private speech candidate; hold lock until Host self-test accepts it."""
import argparse
from contextlib import contextmanager
import fcntl
from functools import partial
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import traceback
import urllib.request

# -I deliberately excludes the script directory; add only our known package scripts.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_voice import digest, install
from prepare_audio import prepare as prepare_audio

ROOT = Path(__file__).resolve().parents[1]
COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
WORKER = Path('vendor/voice/whisper-worker')
ACTIVE = 'active-aec-v12.json'
VERSION = 3
AEC_MANIFEST = 'vendor/audio/aec-v12.json'
INPUTS = ['scripts/prepare_voice_installation.py', 'scripts/prepare_voice.py', 'scripts/prepare_audio.py',
          'vendor/voice/assets.json', 'vendor/audio/assets.json', 'vendor/voice/installer-assets.json',
          'vendor/voice/requirements-macos-arm64.lock', 'vendor/voice/build-tools.lock',
          WORKER / 'CMakeLists.txt', WORKER / 'main.cpp', AEC_MANIFEST]


class InstallError(Exception):
    pass


def private(path, directory=False):
    s = path.lstat()
    correct = stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)
    if not correct or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise InstallError('voice_installation_storage_invalid')


def read_json(path):
    private(path)
    if path.stat().st_size > 8192:
        raise InstallError('voice_installation_storage_invalid')
    with path.open() as stream:
        return json.load(stream)


def fingerprint():
    return {str(name): digest(ROOT / name) for name in INPUTS}


def read_active(root):
    try:
        value = read_json(root / ACTIVE)
    except FileNotFoundError:
        return None
    if not isinstance(value, dict) or set(value) != {'version', 'generation'} or value['version'] != VERSION or not re.fullmatch('[0-9a-f]{32}', str(value['generation'])):
        raise InstallError('voice_installation_storage_invalid')
    return value['generation']


def write_json(path, value):
    # Destination is new or a one-shot temporary, never overwrite through a link.
    with path.open('x') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())


@contextmanager
def locked(root):
    if not root.is_absolute() or not root.parent.is_dir():
        raise InstallError('voice_installation_storage_invalid')
    os.umask(0o077)
    root.mkdir(mode=0o700, exist_ok=True)
    private(root, directory=True)
    fd = os.open(root / 'install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
            raise InstallError('voice_installation_storage_invalid')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError('voice_installation_busy') from None
        yield
    finally:
        os.close(fd)


def run(command, directory, timeout=1200):
    env = {k: os.environ[k] for k in ['PATH', 'HOME', 'TMPDIR', 'LANG'] if k in os.environ}
    env.update(PIP_CONFIG_FILE=os.devnull, GIT_CEILING_DIRECTORIES=str(directory), PYTHONNOUSERSITE='1')
    with (directory / 'installation.log').open('a') as log:
        os.chmod(directory / 'installation.log', 0o600)
        subprocess.run(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                       env=env, cwd=directory, check=True, timeout=timeout)


def prerequisites():
    if sys.version_info[:2] != (3, 11):
        raise InstallError('voice_installation_python_required')
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise InstallError('voice_installation_platform_unsupported')
    # xcrun checks existing developer tools; it does not request an installation.
    for tool in ['clang', 'make', 'git']:
        try:
            subprocess.run(['/usr/bin/xcrun', '--find', tool], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=5, check=True)
        except Exception:
            raise InstallError('voice_installation_tools_required') from None


def unpack(archive_path, destination):
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 200_000_000:
            raise InstallError('voice_installation_source_invalid')
        for m in members:
            p = Path(m.name)
            if p.is_absolute() or '..' in p.parts or not (m.isdir() or m.isfile()):
                raise InstallError('voice_installation_source_invalid')
        for m in members:
            target = destination / m.name
            if m.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.extractfile(m) as source, target.open('xb') as out:
                    shutil.copyfileobj(source, out)
                target.chmod(0o700 if m.mode & 0o111 else 0o600)


def build(directory, emit):
    prerequisites()
    emit('python')
    venv = directory / 'venv'
    # Standalone macOS Python locates libpython relative to its executable.
    # A copied executable loses that layout; standard venv symlinks retain it.
    run([sys.executable, '-I', '-m', 'venv', '--symlinks', str(venv)], directory, 90)
    python = str(venv / 'bin/python3')
    pip = [python, '-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
           '--no-input', '--no-user', '--no-cache-dir', '--index-url', 'https://pypi.org/simple', '--require-hashes', '--no-deps']
    emit('dependencies')
    run(pip + ['--only-binary=:all:', '-r', str(ROOT / 'vendor/voice/build-tools.lock')], directory)
    # These fixed releases have no wheels; only their hash-locked sdists may
    # build, using the already installed tools, never an implicit resolver.
    run(pip + ['--no-build-isolation', '--only-binary=:all:', '--no-binary=jieba,docopt',
               '-r', str(ROOT / 'vendor/voice/requirements-macos-arm64.lock')], directory)
    # Use the hash-locked certifi bundle just installed in the candidate. Some
    # standalone Python distributions have an older base CA store. Keep TLS
    # verification enabled for every request, including redirects.
    ca = subprocess.check_output([python, '-I', '-c', 'import certifi;print(certifi.where())'],
                                 stderr=subprocess.DEVNULL, timeout=10, text=True).strip()
    opener = partial(urllib.request.urlopen, context=ssl.create_default_context(cafile=ca))
    emit('models')
    install(directory / 'assets', opener=opener)
    emit('audio')
    cmake = venv / 'bin/cmake'
    install(directory / 'audio/assets', ROOT / 'vendor/audio/assets.json', opener=opener)
    prepare_audio(directory / 'audio', cmake=cmake)
    install(directory / 'audio/aec-v12', ROOT / AEC_MANIFEST, opener=opener)
    emit('whisper')
    archives = directory / 'sources'
    install(archives, ROOT / 'vendor/voice/installer-assets.json', opener=opener)
    binary = build_whisper_worker(directory, cmake, archives / 'whisper-source.tar.gz')
    write_json(directory / 'candidate.json', {'version': VERSION, 'generation': directory.name,
               'inputs': fingerprint(), 'whisperSha256': digest(binary)})


def build_whisper_worker(directory, cmake, archive):
    with tempfile.TemporaryDirectory(prefix='whisper-build-', dir=directory) as temp:
        work = Path(temp)
        unpack(archive, work)
        source = work / ('whisper.cpp-' + COMMIT)
        compiled = work / 'build'
        shutil.copytree(ROOT / WORKER, source / 'examples/sion-whisper-worker')
        with (source / 'examples/CMakeLists.txt').open('a') as target:
            target.write('\nadd_subdirectory(sion-whisper-worker)\n')
        run([str(cmake), '-S', str(source), '-B', str(compiled), '-DCMAKE_BUILD_TYPE=Release',
             '-DBUILD_SHARED_LIBS=OFF', '-DGGML_BACKEND_DL=OFF', '-DWHISPER_CURL=OFF',
             '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_COREML=OFF',
             '-DGGML_METAL=ON', '-DGGML_BLAS=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'], directory, 180)
        run([str(cmake), '--build', str(compiled), '--target', 'sion-whisper-worker', '-j4'], directory, 600)
        (directory / 'bin').mkdir(mode=0o700)
        binary = directory / 'bin/sion-whisper-worker'
        shutil.copyfile(compiled / 'bin/sion-whisper-worker', binary)
        binary.chmod(0o700)
        # This pinned whisper.cpp archive carries the ggml authors' MIT notice
        # at its root; it has no separate ggml/LICENSE file.
        shutil.copyfile(source / 'LICENSE', directory / 'whisper-LICENSE')
    return binary


def candidate(root, replace, emit):
    generation = read_active(root)  # malformed pointers are not silently discarded
    if generation and not replace:
        directory = root / generation
        private(directory, directory=True)
        record = read_json(directory / 'candidate.json')
        if record.get('version') != VERSION or record.get('inputs') != fingerprint() or record.get('generation') != generation:
            raise InstallError('voice_installation_outdated')
        return generation
    prerequisites()
    generation = secrets.token_hex(16)
    directory = root / generation
    directory.mkdir(mode=0o700)
    try:
        build(directory, emit)
    except Exception:
        # Detailed local diagnostics stay in the private candidate, never in
        # the JSON protocol or settings error messages.
        with (directory / 'installation.log').open('a') as log:
            os.chmod(directory / 'installation.log', 0o600)
            traceback.print_exc(file=log)
        raise
    return generation


def publish(root, generation):
    pending = root / ('.active-' + secrets.token_hex(16))
    write_json(pending, {'version': VERSION, 'generation': generation})
    os.replace(pending, root / ACTIVE)
    fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def serve(root, replace=False, source=sys.stdin, sink=sys.stdout):
    def send(value):
        print(json.dumps(value, separators=(',', ':')), file=sink, flush=True)
    with locked(root):
        generation = candidate(root, replace, lambda stage: send({'type': 'progress', 'stage': stage}))
        send({'type': 'candidate', 'generation': generation})
        # EOF/cancellation does not publish. The Host owns actual model self-test.
        if source.readline(32) != 'commit\n':
            raise InstallError('voice_installation_cancelled')
        publish(root, generation)
        send({'type': 'done', 'generation': generation})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--replace', action='store_true')
    args = parser.parse_args()
    try:
        serve(args.root, args.replace)
    except Exception as error:
        allowed = {'voice_installation_storage_invalid', 'voice_installation_busy', 'voice_installation_python_required',
                   'voice_installation_platform_unsupported', 'voice_installation_tools_required', 'voice_installation_source_invalid',
                   'voice_installation_outdated', 'voice_installation_cancelled'}
        code = str(error) if isinstance(error, InstallError) and str(error) in allowed else 'voice_installation_failed'
        print(json.dumps({'type': 'error', 'code': code}), flush=True)
        raise SystemExit(1)
