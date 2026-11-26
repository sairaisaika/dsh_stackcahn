"""Mac helper for the experimental, one-boot USB entry. No Flash or reset commands."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import select
import stat
import sys
import time

from check_agent_preflight import read_snapshot


READY = b'SION-BOOT-READY 1'
REQUEST = b'SION-BOOT-AGENT 1\n'
CALL_OUT = re.compile(r'/dev/cu\.usbmodem[A-Za-z0-9._-]{1,172}')


class EntryError(Exception):
    """A fixed status suitable for publication without device identifiers."""


def device_node(info):
    return info.st_dev, info.st_ino, info.st_rdev


def matching_port(mac, ports):
    candidates = [port.device for port in ports
                  if (port.vid, port.pid) == (0x303A, 0x1001)
                  and (port.serial_number or '').lower() == mac
                  and CALL_OUT.fullmatch(port.device)]
    if len(candidates) > 1:
        raise EntryError('ambiguous-device')
    if not candidates:
        return None
    path = candidates[0]
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISCHR(info.st_mode):
        raise EntryError('invalid-device-node')
    return path, device_node(info)


@contextmanager
def open_serial(path):
    import serial

    with serial.Serial(port=None, baudrate=115200, timeout=0,
                       write_timeout=0.1, exclusive=True) as port:
        port.dtr = False
        port.rts = False
        port.port = path
        port.open()
        yield port


def wait_ready(port, deadline):
    line = bytearray()
    seen = 0
    overlong = False
    while (remaining := deadline - time.monotonic()) > 0:
        if not select.select([port], [], [], remaining)[0]:
            return False
        data = port.read(128)
        if not data:
            raise OSError('serial closed')
        seen += len(data)
        if seen > 4096:
            raise EntryError('unexpected-data')
        for byte in data:
            if byte == 10:
                if not overlong and line == READY:
                    return True
                line.clear()
                overlong = False
            elif not overlong and len(line) < 64:
                line.append(byte)
            else:
                overlong = True
    return False


def request_entry(mac, enumerate_ports, timeout, *, open_port=open_serial, on_listening=None):
    deadline = time.monotonic() + timeout
    last_attempt = None
    while (remaining := deadline - time.monotonic()) > 0:
        candidate = matching_port(mac, enumerate_ports())
        if candidate is None or candidate == last_attempt:
            if candidate is None:
                last_attempt = None
            time.sleep(min(0.025, remaining))
            continue
        last_attempt = candidate
        path, node = candidate
        send_attempted = False
        try:
            with open_port(path) as port:
                if device_node(os.fstat(port.fileno())) != node:
                    raise EntryError('device-changed')
                if on_listening is not None:
                    on_listening()
                    on_listening = None
                if not wait_ready(port, deadline):
                    return 'ready-timeout'
                if matching_port(mac, enumerate_ports()) != candidate:
                    raise EntryError('device-changed')
                if time.monotonic() >= deadline:
                    return 'ready-timeout'
                # Once any write is attempted, even a lost result cannot cause
                # another request. The application must confirm its own arrival.
                send_attempted = True
                return 'request-queued' if port.write(REQUEST) == len(REQUEST) else 'send-unconfirmed'
        except OSError:
            if send_attempted:
                return 'send-unconfirmed'
            # Retry only after we observe a new node or loss and reappearance.
            continue
    return 'ready-timeout' if last_attempt else 'device-unavailable'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True, help='Verified read-only device backup')
    parser.add_argument('--listen', action='store_true', help='Explicitly open the matched port and wait for one boot request')
    parser.add_argument('--timeout', type=int, choices=range(1, 16), default=8)
    args = parser.parse_args()
    try:
        if sys.platform != 'darwin':
            raise EntryError('unsupported-platform')
        from serial.tools import list_ports

        snapshot = read_snapshot(args.baseline)
        mac = snapshot.mac
        del snapshot

        def ports():
            return list_ports.comports(include_links=False)

        if args.listen:
            def listening():
                print('Matched USB port open. Waiting for Sion to restart.', file=sys.stderr, flush=True)

            print('Looking for the matched USB port.', file=sys.stderr, flush=True)
            status = request_entry(mac, ports, args.timeout, on_listening=listening)
        else:
            status = 'matched' if matching_port(mac, ports()) else 'device-unavailable'
    except EntryError as error:
        status = str(error)
    except (ImportError, OSError, KeyError, TypeError, ValueError):
        status = 'private-evidence-or-serial-unavailable'
    print(json.dumps({'status': status, 'listeningRequested': args.listen, 'agentVerified': False}))
    return 0 if status in ('matched', 'request-queued') else 2


if __name__ == '__main__':
    raise SystemExit(main())
