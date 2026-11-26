"""Explicit, read-only Host diagnostics. Never opens a serial port or a journal."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def storage_status(directory):
    if not directory:
        return 'unconfigured'
    try:
        info = Path(directory).lstat()
    except FileNotFoundError:
        return 'absent'
    except OSError:
        return 'unavailable'
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        return 'invalid'
    return 'private'  # Metadata only; not proof of writable/valid journal contents.


def usb_candidates(infos):
    """USB metadata is a hint, not an authenticated device or firmware identity."""
    ports = {}
    for info in infos:
        path = getattr(info, 'device', None)
        vid, pid = getattr(info, 'vid', None), getattr(info, 'pid', None)
        if not isinstance(path, str) or not re.fullmatch(r'/dev/cu\.[A-Za-z0-9._-]{1,180}', path):
            continue
        if type(vid) is not int or type(pid) is not int or not (0 <= vid <= 65535 and 0 <= pid <= 65535):
            continue
        description = getattr(info, 'description', '')
        description = ''.join(c for c in description if c.isprintable())[:96] if isinstance(description, str) else ''
        ports[path] = {'path': path, 'description': description, 'vid': vid, 'pid': pid}
    ordered = [ports[key] for key in sorted(ports)]
    return ordered[:16], len(ordered) > 16


def serial_inventory():
    try:
        from serial.tools import list_ports
    except ModuleNotFoundError:
        return 'missing', [], False
    except Exception:
        return 'unavailable', [], False
    try:
        ports, truncated = usb_candidates(list_ports.comports(include_links=False))
        return 'available', ports, truncated
    except Exception:
        return 'unavailable', [], False


def openssl_status():
    try:
        result = subprocess.run(['openssl', 'version'], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=3, check=False)
        return 'available' if result.returncode == 0 else 'unavailable'
    except FileNotFoundError:
        return 'missing'
    except (OSError, subprocess.TimeoutExpired):
        return 'unavailable'


def report(directory='', device_access=False):
    supported = sys.platform == 'darwin'
    python_ready = sys.version_info >= (3, 10)
    serial, ports, truncated = serial_inventory() if supported and python_ready else ('not_checked', [], False)
    return {'platform': 'macos' if supported else 'unsupported', 'pythonReady': python_ready,
            'storage': storage_status(directory), 'deviceAccess': device_access,
            'serial': serial, 'openssl': openssl_status(), 'ports': ports, 'truncated': truncated}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='')
    parser.add_argument('--allow-device', action='store_true')
    args = parser.parse_args()
    print(json.dumps({'ok': True, 'value': report(args.root, args.allow_device)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
