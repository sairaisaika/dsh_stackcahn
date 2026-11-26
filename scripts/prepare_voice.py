"""Download explicitly selected, hash-pinned local speech assets. No device access."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'vendor/voice/assets.json'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = path.lstat().st_mode
    if path.is_symlink() or not stat.S_ISDIR(mode) or mode & 0o077:
        raise ValueError('asset-directory-must-be-private')


def install(directory, manifest=MANIFEST, opener=urllib.request.urlopen):
    # The manifest is bundled code, never a user-provided URL or remote script.
    spec = json.loads(manifest.read_text())
    if spec.get('version') != 1 or not spec.get('files'):
        raise ValueError('invalid-manifest')
    private_directory(directory)
    lock_fd = os.open(directory / '.install.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # A failed revalidation must not leave an old success marker behind.
        # Inference verifies actual assets as well; a receipt is not a signature.
        (directory / 'installed.json').unlink(missing_ok=True)
        for item in spec['files']:
            relative = Path(item['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('invalid-asset-path')
            path = directory / relative
            current = directory
            for part in relative.parts[:-1]:
                current = current / part
                private_directory(current)
            if path.exists() or path.is_symlink():
                if path.is_symlink() or not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
                    raise ValueError('existing-asset-mismatch')
                continue
            temporary = path.with_name(path.name + '.partial')
            # Only remove our previous interrupted download, never a symlink.
            if temporary.is_symlink():
                raise ValueError('unsafe-partial-file')
            temporary.unlink(missing_ok=True)
            try:
                count = 0
                with opener(item['url'], timeout=30) as response, temporary.open('xb') as output:
                    temporary.chmod(0o600)
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        count += len(chunk)
                        if count > item['bytes']:
                            raise ValueError('asset-size-mismatch')
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if count != item['bytes'] or digest(temporary) != item['sha256']:
                    raise ValueError('asset-hash-mismatch')
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        receipt = {'version': 1, 'manifestSha256': digest(manifest),
                   'files': {item['path']: item['sha256'] for item in spec['files']}}
        temporary = directory / '.installed.pending'
        if temporary.is_symlink():
            raise ValueError('unsafe-receipt-file')
        temporary.unlink(missing_ok=True)
        with temporary.open('x') as stream:
            temporary.chmod(0o600)
            json.dump(receipt, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / 'installed.json')
        return receipt
    finally:
        os.close(lock_fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = install(args.directory.absolute())
        print(json.dumps({'status': 'verified', 'files': len(result['files']),
                          'deviceAccess': False, 'modelInference': False}))
    except Exception:
        # Do not echo paths, proxy configuration or arbitrary remote error bodies.
        print(json.dumps({'status': 'failed', 'error': 'asset-install-failed'}))
        raise SystemExit(1)
