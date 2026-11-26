#!/usr/bin/env python3
"""Refuse a tree that must not go to the public repository.

Usage: check_public_tree.py DIR   (exit 0 clean, 1 refused)

Path rules are public and live here. Content rules that would themselves reveal
something private (a card number, a home path, an address) live only in the
ignored file .local/public-deny.txt of the private checkout, one regular
expression per line; pass it with --deny.
"""
import argparse
import re
import sys
from pathlib import Path

# Local data, build output and artwork whose licence does not allow redistribution (README).
FORBIDDEN_PATHS = [
    r'^\.local/', r'^work/', r'^recordings/', r'^models/', r'(^|/)\.env', r'(^|/)node_modules/',
    r'\.tgz$', r'\.elf$', r'(^|/)build/', r'(^|/)managed_components/', r'(^|/)sdkconfig(\.old)?$',
    r'^firmware/whale-sources/.*\.(jpe?g|png|webp)$', r'^firmware/agent/whale_assets\.bin$',
    r'^wiki/assets/whale-avatar-preview\.png$',
]
# Generic secrets. Test fixtures that only spell out the PEM header are allowed below.
SECRET_PATTERNS = [
    r'-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[A-Za-z0-9+/=\s]{64,}',
    r'\bsk-[A-Za-z0-9]{20,}', r'\bghp_[A-Za-z0-9]{30,}', r'\bAKIA[0-9A-Z]{16}\b', r'\bxox[bp]-[A-Za-z0-9-]{10,}',
]
LARGE_BYTES = 5 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--deny', type=Path, help='extra private content patterns, one regex per line')
    args = parser.parse_args()
    root = args.root.resolve()
    deny = list(SECRET_PATTERNS)
    if args.deny:
        deny += [line.strip() for line in args.deny.read_text().splitlines() if line.strip() and not line.startswith('#')]
    content = [re.compile(p) for p in deny]
    paths = [re.compile(p) for p in FORBIDDEN_PATHS]
    problems = []
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        if rel == '.git' or rel.startswith('.git/') or not path.is_file():
            continue
        if any(p.search(rel) for p in paths):
            problems.append(f'path   {rel}')
            continue
        if path.stat().st_size > LARGE_BYTES:
            problems.append(f'large  {rel} ({path.stat().st_size} bytes)')
        try:
            text = path.read_text(errors='ignore')
        except OSError:
            continue
        for rule in content:
            if rule.search(text):
                problems.append(f'content {rel} (rule {deny[content.index(rule)][:12]}…)')
                break
    for line in problems:
        print('REFUSED', line)
    print(f'{len(problems)} problem(s) in {root}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
