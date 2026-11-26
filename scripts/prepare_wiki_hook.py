"""Fetch the reviewed Wiki gate by commit and hash; no host settings/trust changes."""
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parents[1]
lock = json.loads((root / '.project-wiki/skill.lock.json').read_text())
out = root / '.local/wiki-hooks'
prepared = {}
for path, expected in lock['files'].items():
    url = 'https://raw.githubusercontent.com/sairaisaika/projectWikiSkill/' + lock['revision'] + '/' + path
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != expected:
        raise SystemExit('Wiki dependency hash mismatch; no files changed')
    target = out / Path(path).name
    if target.exists() and target.read_bytes() != data:
        raise SystemExit('Existing Wiki dependency differs; review before replacement')
    prepared[target] = data
out.mkdir(parents=True, exist_ok=True)
for target, data in prepared.items():
    target.write_bytes(data)
print('Pinned Wiki gate and license prepared; host hooks are not installed or trusted.')
