"""Explicit Wiki-first gate for this checkout; never enables host hooks or reads device data."""
import argparse
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STAMP = ROOT / '.local/wiki-context.json'
ROUTES = ROOT / 'wiki/development-workflow.md'
GATE = ROOT / '.local/wiki-hooks/edit_gate.py'
LOCK = ROOT / '.project-wiki/edit-gate.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local_file(raw, must_exist=False):
    path = ROOT / raw
    if Path(raw).is_absolute() or '..' in Path(raw).parts or not path.resolve().is_relative_to(ROOT):
        raise ValueError('path must stay in this checkout')
    if must_exist and not path.is_file():
        raise ValueError('required local file missing: ' + raw)
    return path


def prepare(files):
    rules = []
    for line in ROUTES.read_text().splitlines():
        if line.startswith('| `'):
            values = re.findall(r'`([^`]+)`', line)
            rules.append((values[0], values[1:]))
    pages = {'wiki/README.md', 'wiki/product-plan.md', 'wiki/development-workflow.md'}
    selected = sorted(set(files))
    if not selected:
        raise ValueError('select files explicitly')
    for path in selected:
        local_file(path)
        matched = [refs for pattern, refs in rules if fnmatch.fnmatchcase(path, pattern)]
        if not matched:
            raise ValueError('no Wiki route for ' + path)
        for refs in matched:
            pages.update(refs)
    record = {'files': selected, 'page_hashes': {p: digest(local_file(p, True)) for p in sorted(pages)},
              'gate_sha256': digest(GATE), 'config_sha256': digest(LOCK),
              'observation': 'captured; reading and semantic correctness not proved'}
    STAMP.parent.mkdir(exist_ok=True)
    STAMP.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    print('Read these pages before editing:')
    print('\n'.join(sorted(pages)))
    print(record['observation'])


def check():
    record = json.loads(STAMP.read_text())
    for page, expected in record['page_hashes'].items():
        if digest(local_file(page, True)) != expected:
            raise ValueError('Wiki changed; recapture and review: ' + page)
    if digest(GATE) != record['gate_sha256']:
        raise ValueError('gate source changed; inspect before recapturing')
    if digest(LOCK) != record['config_sha256']:
        raise ValueError('gate configuration changed; inspect before recapturing')
    # Explicit invocation of the skill's existing Claude event adapter, not a
    # claim that Codex emitted or trusted a PreToolUse event.
    for path in record['files']:
        event = {'hook_event_name': 'PreToolUse', 'tool_name': 'Edit', 'cwd': str(ROOT),
                 'tool_input': {'file_path': str(local_file(path))}}
        result = subprocess.run([sys.executable, str(GATE)], input=json.dumps(event),
                                text=True, capture_output=True, check=False)
        if result.returncode or 'unavailable' in result.stderr or 'not judged' in result.stderr:
            raise ValueError('skill gate did not pass: ' + result.stderr.strip())
    print('Wiki byte freshness and explicit skill gate passed for %d files; no host-hook claim.' % len(record['files']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'check'])
    parser.add_argument('--files', nargs='+', default=[])
    args = parser.parse_args()
    try:
        prepare(args.files) if args.action == 'prepare' else check()
    except (ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
