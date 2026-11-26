"""Bounded package metadata probe; no imports of models, network or device access."""
import importlib.metadata
import json
from pathlib import Path
import re
import sys


def report():
    compatible = sys.version_info[:2] == (3, 11) and sys.prefix != sys.base_prefix
    if not compatible:
        return dict(version=1, python='unsupported', packages='not_checked')
    lock = (Path(__file__).resolve().parents[1] / 'vendor/voice/requirements-macos-arm64.lock').read_text()
    expected = dict(re.findall(r'^([a-zA-Z0-9_-]+)==([^\s\\]+)', lock, re.M))
    # The fixed language wheel is an URL requirement rather than == in the lock.
    if 'en_core_web_sm-3.8.0-py3-none-any.whl' not in lock or len(expected) < 10:
        raise ValueError('invalid-lock')
    expected['en-core-web-sm'] = '3.8.0'
    missing = mismatch = False
    for name, version in expected.items():
        try:
            mismatch |= importlib.metadata.version(name) != version
        except importlib.metadata.PackageNotFoundError:
            missing = True
    return dict(version=1, python='available', packages='missing' if missing else 'invalid' if mismatch else 'verified')


if __name__ == '__main__':
    try:
        print(json.dumps(report()))
    except Exception:
        print(json.dumps(dict(version=1, python='invalid', packages='not_checked')))
        raise SystemExit(1)
