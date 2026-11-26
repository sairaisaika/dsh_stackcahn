"""Place one optional Kokoro voice from vendor/voice/extra-voices.json into an
installed speech environment. The file is checked against its pinned size and
SHA-256 before it is moved into place; nothing else in the environment changes.
No device access.

  python3 -I scripts/add_voice.py --assets <installation>/assets --voice zf_038 [--source <file>]

Without --source the pinned Hugging Face URL is downloaded.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import urllib.request

EXTRA = Path(__file__).resolve().parents[1] / 'vendor/voice/extra-voices.json'


def entry(voice, manifest=EXTRA):
    for item in json.loads(manifest.read_text())['voices']:
        if item['voice'] == voice:
            return item
    raise ValueError('voice-not-listed')


def private_directory(path):
    mode = path.lstat().st_mode
    if path.is_symlink() or not stat.S_ISDIR(mode) or mode & 0o077 or path.stat().st_uid != os.getuid():
        raise ValueError('asset-directory-must-be-private')


def place(assets, voice, source=None, opener=urllib.request.urlopen, manifest=EXTRA):
    item = entry(voice, manifest)
    assets = Path(assets)
    private_directory(assets)
    target = assets / item['path']
    for directory in (target.parent.parent, target.parent):
        private_directory(directory)
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file():
            raise ValueError('voice-target-not-a-file')
        with target.open('rb') as stream:
            if hashlib.sha256(stream.read()).hexdigest() == item['sha256']:
                return 'present'
        raise ValueError('voice-target-differs')
    if source is not None:
        data = Path(source).read_bytes()
    else:
        with opener(item['url'], timeout=60) as response:
            data = response.read(item['bytes'] + 1)
    if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError('voice-verification-failed')
    descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix='.voice-')
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.link(temporary, target)  # Fails rather than replacing a file that appeared meanwhile.
    finally:
        os.unlink(temporary)
    return 'placed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--voice', required=True)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    print(place(args.assets.absolute(), args.voice, args.source))
