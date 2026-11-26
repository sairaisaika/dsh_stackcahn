"""Build pinned input DSP libraries privately; no device or global install."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

from prepare_voice import digest, install, private_directory

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'vendor/audio/assets.json'
VQE_COMMIT = '7f61cd05095d42e56a135b303f5bb4d761da22b9'
GGML_COMMIT = 'c044a8eeae2591faa0950c8b5e514cbc4bbfc4ca'


def extract(archive_path, destination):
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) > 2500 or sum(m.size for m in members) > 25_000_000:
            raise ValueError('archive-limit')
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('archive-path')
        # No links/devices or reliance on version-specific tar defaults.
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.extractfile(member) as source_file, target.open('xb') as output:
                    shutil.copyfileobj(source_file, output)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)


def prepare(directory, cmake=None):
    # Current build flags/receipt are validated for the requested Mac target.
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('audio-build-platform-unverified')
    private_directory(directory)
    lock = os.open(directory / '.build.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assets = directory / 'assets'
        install(assets, manifest=MANIFEST)
        receipt = directory / 'native.json'
        expected = {'version': 2, 'system': platform.system(), 'machine': platform.machine(),
                    'manifestSha256': digest(MANIFEST), 'builderSha256': digest(Path(__file__)),
                    'localvqeCommit': VQE_COMMIT, 'ggmlCommit': GGML_COMMIT}
        names = ['libspeexdsp.dylib', 'liblocalvqe.dylib']
        if receipt.exists():
            record = json.loads(receipt.read_text())
            if any(record.get(k) != v for k, v in expected.items()) or set(record.get('libraries', {})) != set(names):
                raise ValueError('native-install-mismatch')
            for name in names:
                library = directory / name
                if library.is_symlink() or not library.is_file() or digest(library) != record['libraries'][name]:
                    raise ValueError('native-install-mismatch')
            return record
        if any((directory / name).exists() or (directory / name).is_symlink() for name in names):
            raise ValueError('unverified-native-file')
        cmake = str(Path(cmake or shutil.which('cmake')).resolve())
        with tempfile.TemporaryDirectory(prefix='build-', dir=directory) as temporary:
            stage = Path(temporary)
            for archive in ['speexdsp-1.2.1.tar.gz', 'localvqe-source.tar.gz', 'localvqe-ggml.tar.gz']:
                extract(assets / archive, stage)
            speex = stage / 'speexdsp-1.2.1'
            vqe = stage / ('LocalVQE-' + VQE_COMMIT)
            ggml = stage / ('ggml-' + GGML_COMMIT)
            target = vqe / 'ggml/vendor/ggml'
            if target.exists():
                target.rmdir()  # The pinned source's submodule placeholder must be empty.
            shutil.move(str(ggml), target)
            env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LANG') if k in os.environ}
            # These are hash-verified source archives, not Git checkouts. Do not
            # let git apply discover the user's enclosing project and silently
            # skip hunks outside its current prefix. No Git initialization needed.
            env['GIT_CEILING_DIRECTORIES'] = str(stage)
            build = stage / 'vqe-build'
            patch = str(vqe / 'ggml/patches/ggml-gru.patch')
            commands = [
                (['git', 'apply', '--check', patch], target),
                (['git', 'apply', '--whitespace=nowarn', patch], target),
                (['git', 'apply', '--reverse', '--check', patch], target),
                ([str(speex / 'configure'), '--disable-static', '--enable-shared', '--disable-examples', '--prefix=' + str(directory)], speex),
                (['make', '-j4'], speex),
                ([cmake, '-S', str(vqe / 'ggml'), '-B', str(build), '-DCMAKE_BUILD_TYPE=Release',
                  '-DLOCALVQE_BUILD_SHARED=ON', '-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF'], stage),
                ([cmake, '--build', str(build), '--target', 'localvqe_shared', '-j4'], stage),
            ]
            with (directory / 'build.log').open('w') as log:
                os.chmod(directory / 'build.log', 0o600)
                for command, cwd in commands:
                    subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
            compiled = [speex / 'libspeexdsp/.libs/libspeexdsp.1.dylib', build / 'liblocalvqe.0.1.0.dylib']
            record = {**expected, 'libraries': {name: digest(path) for name, path in zip(names, compiled)},
                      'ggmlPatchSha256': digest(vqe / 'ggml/patches/ggml-gru.patch')}
            for source, name in [(speex / 'COPYING', 'speexdsp-COPYING'), (vqe / 'LICENSE', 'localvqe-LICENSE'), (target / 'LICENSE', 'ggml-LICENSE')]:
                shutil.copyfile(source, directory / name)
            for name, source in zip(names, compiled):
                staged = stage / name
                shutil.copyfile(source, staged)
                staged.chmod(0o600)
            pending = stage / 'native.json'
            pending.write_text(json.dumps(record, indent=2) + '\n')
            pending.chmod(0o600)
            for name in names:
                os.replace(stage / name, directory / name)
            os.replace(pending, receipt)  # Publish only after every library is present.
            return record
    finally:
        os.close(lock)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--cmake', type=Path)
    args = parser.parse_args()
    try:
        record = prepare(args.directory.absolute(), args.cmake)
        print(json.dumps({'status': 'verified', 'libraries': record['libraries'], 'deviceAccess': False}))
    except Exception:
        print(json.dumps({'status': 'failed', 'error': 'audio-build-failed'}))
        raise SystemExit(1)
