"""Private Host pairing journal. No device I/O without --allow-device and an action.

One root owns one device. Callers send bounded JSON on stdin; public output never
contains bundle paths, tokens, keys, the USB window, or provider exception text.
"""
import argparse
from contextlib import contextmanager
import fcntl
import ipaddress
import json
import os
import re
from pathlib import Path
import secrets
import stat
import subprocess
import sys
from urllib.parse import urlsplit

from agent_pairing_usb import (
    PairingError, configure_serial_port, hex_value, perform, read_private_relay_bundle, unique_object,
)

RELAY_REQUESTS = {
    'relay_check': {'action'},
    'relay_inspect': {'action', 'revision', 'port'},
    'relay_install': {'action', 'revision', 'port', 'expectedState', 'expectedRevision', 'stagedRevision'},
    'relay_remove': {'action', 'revision', 'port', 'expectedState', 'expectedRevision'},
}


class HostError(Exception):
    pass


def private_info(info, directory=False):
    if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise HostError('private_storage_required')


def read_private(path, limit=32768):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        private_info(os.fstat(source.fileno()))
        data = source.read(limit + 1)
    if len(data) > limit:
        raise HostError('private_storage_invalid')
    return json.loads(data, object_pairs_hook=unique_object)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def empty_state():
    return dict(version=1, revision=0, device='', active=None, candidate=None,
                pending=None, observed=None)


class Journal:
    def __init__(self, root):
        self.root = Path(root).absolute()

    @contextmanager
    def locked(self):
        # Host composition supplies an app-private parent, never a Client path.
        self.root.mkdir(mode=0o700, exist_ok=True)
        private_info(self.root.lstat(), True)
        fd = os.open(self.root / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            private_info(os.fstat(fd))
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise HostError('host_busy') from None
            yield
        finally:
            os.close(fd)  # Kernel releases the lock on normal exit or process death.

    def load(self):
        try:
            value = read_private(self.root / 'state.json')
        except FileNotFoundError:
            return empty_state()
        if (not isinstance(value, dict) or set(value) != set(empty_state()) or type(value['version']) is not int or value['version'] != 1
                or type(value['revision']) is not int or not 0 <= value['revision'] < 2**53-1
                or not isinstance(value['device'], str)
                or (value['device'] and not hex_value(value['device'], 12))):
            raise HostError('private_storage_invalid')
        for name in ('active', 'candidate'):
            if value[name] is not None:
                self.bundle(value[name])
        pending = value['pending']
        if pending is not None and (not isinstance(pending, dict)
                or set(pending) != {'action', 'previous', 'target'}
                or pending['action'] not in ('install', 'remove')
                or not isinstance(pending['previous'], str)
                or pending['previous'] != self.pair_id(value['active'])
                or pending['target'] != (self.pair_id(value['candidate']) if pending['action'] == 'install' else '')
                or (pending['action'] == 'install' and not value['candidate'])):
            raise HostError('private_storage_invalid')
        observed = value['observed']
        if observed is not None and (not isinstance(observed, dict) or set(observed) != {'state', 'pairId'}
                or observed['state'] not in ('empty', 'paired', 'revoked', 'unavailable', 'corrupt', 'storage_error')
                or not isinstance(observed['pairId'], str)
                or (observed['state'] == 'paired' and not hex_value(observed['pairId'], 32))
                or (observed['state'] != 'paired' and observed['pairId'] != '')):
            raise HostError('private_storage_invalid')
        return value

    def bundle(self, ident):
        if not hex_value(ident, 32):
            raise HostError('private_storage_invalid')
        directory = self.root / ident
        private_info(directory.lstat(), True)
        value = read_private(directory / 'pairing.json')
        if (not isinstance(value, dict) or value.get('version') != 1
                or not isinstance(value.get('record'), dict)
                or not hex_value(value['record'].get('pair_id'), 32)
                or not isinstance(value.get('host'), dict)
                or not all(isinstance(value['host'].get(k), str) and value['host'][k] for k in ('cert', 'key'))):
            raise HostError('private_storage_invalid')
        return value

    def pair_id(self, ident):
        return self.bundle(ident)['record']['pair_id'] if ident else ''

    def save(self, value):
        if value['revision'] >= 2**53-2:
            raise HostError('private_storage_invalid')
        value['revision'] += 1
        temporary = self.root / ('.state-' + secrets.token_hex(16))
        try:
            with open(temporary, 'x', opener=lambda p, f: os.open(p, f, 0o600)) as out:
                json.dump(value, out, separators=(',', ':'), allow_nan=False)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, self.root / 'state.json')
            sync_dir(self.root)
        finally:
            temporary.unlink(missing_ok=True)

    def snapshot(self, value):
        return dict(revision=value['revision'], deviceId=value['device'],
                    activePairId=self.pair_id(value['active']),
                    candidatePairId=self.pair_id(value['candidate']),
                    pending=value['pending']['action'] if value['pending'] else '',
                    observed=value['observed'], connected=False)


def generate_bundle(directory, local_url, node):
    if local_url:
        try:
            parsed = urlsplit(local_url)
            address = ipaddress.IPv4Address(parsed.hostname or '')
        except ValueError:
            raise HostError('invalid_local_url') from None
        if (parsed.scheme != 'wss' or parsed.username or parsed.password or parsed.query or parsed.fragment
                or not any(address in ipaddress.ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))):
            raise HostError('invalid_local_url')
    result = subprocess.run([node, str(Path(__file__).with_name('pairing.mjs')), 'prepare', str(directory), local_url],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
    if result.returncode:
        raise HostError('identity_generation_failed')
    # Keep the immutable credentials durable before recording their identifier.
    for path in directory.iterdir():
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise HostError('private_storage_invalid')
            os.fsync(fd)
        finally:
            os.close(fd)
    sync_dir(directory)
    sync_dir(directory.parent)


def device_call(port_name, action, device, expected_pair, record, *, preserve_modem_lines=False, **policy):
    port = None
    try:
        port = configure_serial_port(port_name, preserve_modem_lines=preserve_modem_lines, timeout=0.1, write_timeout=1)
        port.open()
        return perform(port, action, device, expected_pair, record, **policy)
    finally:
        if port is not None:
            port.close()


def usb_node_identity(node):
    return node.st_dev, node.st_ino, node.st_rdev


def verify_managed_usb_port(path, device=None):
    try:
        from serial.tools import list_ports
        if sys.platform != 'darwin' or not re.fullmatch(r'/dev/cu\.usbmodem[A-Za-z0-9._-]{1,172}', path):
            raise HostError('managed_usb_port_unavailable')
        node = os.lstat(path)
        if not stat.S_ISCHR(node.st_mode):
            raise HostError('managed_usb_port_unavailable')
        ports = [port for port in list_ports.comports(include_links=False)
                 if port.device == path and (port.vid, port.pid) == (0x303A, 0x1001)]
        if len(ports) != 1:
            raise HostError('managed_usb_port_unavailable')
        if device is not None:
            serial = ports[0].serial_number or ''
            if (not re.fullmatch(r'(?:[0-9a-fA-F]{12}|(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})', serial)
                    or serial.replace(':', '').lower() != device):
                raise HostError('managed_usb_identity_mismatch')
        return usb_node_identity(node)
    except (ImportError, OSError):
        raise HostError('managed_usb_port_unavailable') from None


def managed_device_call(port_name, action, device, expected_pair, record, **policy):
    verify_managed_usb_port(port_name)
    return device_call(port_name, action, device, expected_pair, record, preserve_modem_lines=True, **policy)


def staged_relay(profile, pair):
    if profile is None:
        return 'unavailable', None
    path = profile / '.stackchan-relay-device.json'
    try:
        path.lstat()
        record = read_private_relay_bundle(path)
    except FileNotFoundError:
        return 'missing', None
    except (OSError, PairingError):
        return 'invalid', None
    fields = {'version', 'pair_id', 'revision', 'origin', 'room_id', 'token', 'ca', 'ssid', 'password'}
    if (set(record) != fields or type(record['version']) is not int or record['version'] != 1
            or not hex_value(record['revision'], 32) or not hex_value(record['pair_id'], 32)
            or not hex_value(record['room_id'], 32) or not hex_value(record['token'], 64)
            or any(not isinstance(record[name], str) or '\x00' in record[name]
                   for name in ('origin', 'ca', 'ssid', 'password'))):
        return 'invalid', None
    return ('ready', record) if pair and record['pair_id'] == pair else ('pair_mismatch', None)


def execute_relay(journal, state, request, profile, transport, validate_port):
    action = request['action']
    pair = journal.pair_id(state['active'])
    staged, record = staged_relay(profile, pair)
    report = dict(revision=state['revision'], pairId=pair, pairingPending=bool(state['pending']),
                  staged=staged, stagedRevision=record['revision'] if record else '', device=None)
    if action == 'relay_check':
        return report
    if type(request['revision']) is not int or request['revision'] != state['revision']:
        raise HostError('revision_conflict')
    if state['pending']:
        raise HostError('reconcile_required')
    if not pair or not state['device']:
        raise HostError('active_identity_required')
    if profile is None:
        raise HostError('relay_profile_required')
    port = request['port']
    if not isinstance(port, str) or not re.fullmatch(r'/dev/cu\.[A-Za-z0-9._-]{1,180}', port):
        raise HostError('invalid_port')
    if transport is None:
        raise HostError('device_access_disabled')
    if validate_port is not None:
        validate_port(port)
    policy = {}
    if action != 'relay_inspect':
        expected, previous = request['expectedState'], request['expectedRevision']
        if expected not in ('ready', 'empty', 'invalid') or (previous != '' and (
                expected != 'ready' or not hex_value(previous, 32))):
            raise HostError('invalid_request')
        policy['expected_relay'] = (expected, previous)
    if action == 'relay_install' and (record is None or request['stagedRevision'] != record['revision']):
        raise HostError('relay_bundle_changed')
    try:
        result = transport(port, 'relay_status' if action == 'relay_inspect' else action,
                           state['device'], pair, record if action == 'relay_install' else None, **policy)
    except PairingError as error:
        reason = str(error)
        if reason not in ('relay_not_supported', 'relay_state_changed', 'physical_window_required', 'wrong_device', 'identity_conflict'):
            reason = 'device_result_unconfirmed'
        raise HostError(reason) from None
    if (not result['ok'] or result['busy'] or result['state'] != 'paired'
            or result['pair_id'] != pair or 'relay_state' not in result):
        raise HostError('device_result_unconfirmed')
    report['device'] = dict(state=result['relay_state'], revision=result['relay_revision'])
    return report


def identify_device(port, transport, validate_port):
    if not isinstance(port, str) or not re.fullmatch(r'/dev/cu\.[A-Za-z0-9._-]{1,180}', port):
        raise HostError('invalid_port')
    if transport is None:
        raise HostError('device_access_disabled')
    if validate_port is not None:
        validate_port(port)
    try:
        status = transport(port, 'status', None, '', None)
    except (OSError, PairingError):
        raise HostError('device_state_unavailable') from None
    if not status['ok'] or status['busy'] or not hex_value(status['device_id'], 12):
        raise HostError('device_state_unavailable')
    return {'deviceId': status['device_id']}


def execute(journal, request, *, transport=None, validate_port=None, generate=generate_bundle, node='node', profile=None):
    if not isinstance(request, dict):
        raise HostError('invalid_request')
    action = request.get('action')
    fields = {'snapshot': {'action'},
              'identify': {'action', 'port'},
              'prepare': {'action', 'revision', 'deviceId', 'localUrl'},
              'inspect': {'action', 'revision', 'deviceId', 'port'},
              'install': {'action', 'revision', 'deviceId', 'port'},
              'remove': {'action', 'revision', 'deviceId', 'port'}}
    fields.update(RELAY_REQUESTS)
    if action not in fields or set(request) != fields[action]:
        raise HostError('invalid_request')
    if action == 'identify':
        return identify_device(request['port'], transport, validate_port)
    with journal.locked():
        state = journal.load()
        if action in RELAY_REQUESTS:
            return execute_relay(journal, state, request, profile, transport, validate_port)
        if action == 'snapshot':
            return journal.snapshot(state)
        if type(request['revision']) is not int or request['revision'] != state['revision']:
            raise HostError('revision_conflict')
        device = request['deviceId']
        if not hex_value(device, 12) or (state['device'] and device != state['device']):
            raise HostError('wrong_device')
        if action == 'prepare':
            if state['pending']:
                raise HostError('reconcile_required')
            if not isinstance(request['localUrl'], str) or len(request['localUrl']) > 384:
                raise HostError('invalid_local_url')
            ident = secrets.token_hex(16)
            generate(journal.root / ident, request['localUrl'], node)
            journal.bundle(ident)
            state.update(device=device, candidate=ident)
            journal.save(state)
            return journal.snapshot(state)
        if not isinstance(request['port'], str) or not request['port'].startswith('/dev/cu.') or len(request['port']) > 256 or '\x00' in request['port']:
            raise HostError('invalid_port')
        if transport is None:
            raise HostError('device_access_disabled')
        if validate_port is not None:
            validate_port(request['port'])
        active = journal.pair_id(state['active'])
        if action == 'inspect':
            result = transport(request['port'], 'status', device, active, None)
            if not result['ok'] or result['device_id'] != device or result['busy']:
                raise HostError('device_state_unavailable')
            pending = state['pending']
            if pending and result['state'] in ('empty', 'paired', 'revoked'):
                actual = result['pair_id']
                if pending['action'] == 'install' and actual == pending['target']:
                    state.update(active=state['candidate'], candidate=None, pending=None)
                elif pending['action'] == 'remove' and not actual:
                    state.update(active=None, pending=None)
                elif actual == pending['previous']:
                    state['pending'] = None  # Old identity confirmed. Retry still needs a new explicit action.
                else:
                    raise HostError('identity_conflict')
            state.update(device=device, observed=dict(state=result['state'], pairId=result['pair_id']))
            journal.save(state)
            return journal.snapshot(state)
        if state['pending']:
            raise HostError('reconcile_required')
        if action == 'install' and not state['candidate']:
            raise HostError('candidate_required')
        if action == 'remove' and not state['active']:
            raise HostError('active_identity_required')
        target = journal.pair_id(state['candidate']) if action == 'install' else ''
        record = journal.bundle(state['candidate'])['record'] if action == 'install' else None
        if record is not None and record.get('local_url') == '':
            support = transport(request['port'], 'optional_lan_status', device, active, None)
            if not support['ok']:
                raise HostError('optional_lan_not_supported')
        # Persist intent before sending a USB mutation. Errors never remove credentials.
        state.update(device=device, pending=dict(action=action, previous=active, target=target))
        journal.save(state)
        result = transport(request['port'], action, device, active, record)
        if (not result['ok'] or result['device_id'] != device or result['busy']
                or result['pair_id'] != target
                or (action == 'install' and result['state'] != 'paired')
                or (action == 'remove' and result['state'] not in ('empty', 'revoked'))):
            raise HostError('device_result_unconfirmed')
        state.update(active=state['candidate'] if action == 'install' else None,
                     candidate=None if action == 'install' else state['candidate'], pending=None,
                     observed=dict(state=result['state'], pairId=result['pair_id']))
        journal.save(state)
        return journal.snapshot(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', default='node')
    parser.add_argument('--profile', type=Path)
    device_mode = parser.add_mutually_exclusive_group()
    device_mode.add_argument('--allow-device', action='store_true')
    device_mode.add_argument('--allow-managed-usb', action='store_true')
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise HostError('invalid_request')
        request = json.loads(raw, object_pairs_hook=unique_object)
        transport = managed_device_call if args.allow_managed_usb else device_call if args.allow_device else None
        profile = args.profile if args.profile is not None and args.profile.is_absolute() else None
        value = execute(Journal(args.root), request, node=args.node, transport=transport, profile=profile,
                        validate_port=verify_managed_usb_port if args.allow_managed_usb else None)
        response = dict(ok=True, value=value)
    except HostError as error:
        response = dict(ok=False, error=str(error))
    except Exception:
        # In particular, provider messages may contain private paths or records.
        response = dict(ok=False, error='operation_unconfirmed')
    print(json.dumps(response, separators=(',', ':')))
    return 0 if response['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
