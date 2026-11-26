"""SIONA1 client. Dry-run by default; only --apply opens an explicit serial port."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

PREFIX = b'SIONA1 '
RESYNC = b'\x00\n'
STATES = {'empty', 'paired', 'revoked', 'unavailable', 'corrupt', 'storage_error'}
RELAY_ACTIONS = {'relay_status', 'relay_install', 'relay_remove'}
RELAY_STATES = {'empty', 'ready', 'invalid', 'unavailable', 'storage_error'}
WRITE_RESULTS = {'', 'saved', 'unchanged', 'identity_conflict', 'invalid_record',
                 'unavailable', 'corrupt', 'storage_error', 'no_space', 'write_unconfirmed'}
ERRORS = WRITE_RESULTS | {'invalid_request', 'usb_unavailable', 'wrong_device',
                         'maintenance_busy', 'window_closed'}


def configure_serial_port(path, *, preserve_modem_lines=False, timeout=None, write_timeout=None):
    """Configure a closed pySerial port. Its caller owns opening and closing it."""
    import serial

    port_type = serial.Serial
    if preserve_modem_lines:
        # The verified ESP32-S3 USB CDC data path does not use modem signals.
        # pySerial 3.5 POSIX open() otherwise issues these two modem ioctls.
        class DataPort(serial.Serial):
            def _update_dtr_state(self):
                pass

            def _update_rts_state(self):
                pass

        port_type = DataPort
    port = port_type(port=None, baudrate=115200, timeout=timeout, write_timeout=write_timeout, exclusive=True)
    if not preserve_modem_lines:
        port.dtr = False
        port.rts = False
    port.port = path
    return port

class PairingError(Exception):
    """Contains only a fixed error code, never serial data or credential input."""

def hex_value(value, length):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{'+str(length)+'}', value) is not None

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PairingError('invalid_response')
        result[key] = value
    return result

def validate_reply(value):
    fields = {'request_id', 'ok', 'error', 'device_id', 'pair_id', 'state',
              'ready', 'busy', 'window', 'remaining_ms', 'result'}
    relay_fields = {'relay_state', 'relay_revision'}
    if not isinstance(value, dict) or set(value) not in (fields, fields | relay_fields):
        raise PairingError('invalid_response')
    if not (hex_value(value['request_id'], 32) and hex_value(value['device_id'], 12)
            and (value['pair_id'] == '' or hex_value(value['pair_id'], 32))
            and (value['window'] == '' or hex_value(value['window'], 32))
            and type(value['ok']) is bool and type(value['ready']) is bool and type(value['busy']) is bool
            and type(value['remaining_ms']) is int and 0 <= value['remaining_ms'] <= 120000
            and isinstance(value['state'], str) and value['state'] in STATES
            and isinstance(value['result'], str) and value['result'] in WRITE_RESULTS
            and isinstance(value['error'], str) and value['error'] in ERRORS):
        raise PairingError('invalid_response')
    if (value['state'] == 'paired') != bool(value['pair_id']):
        raise PairingError('invalid_response')
    if bool(value['window']) != (value['remaining_ms'] > 0) or (value['ok'] and value['error']):
        raise PairingError('invalid_response')
    if relay_fields <= value.keys():
        state, revision = value['relay_state'], value['relay_revision']
        if (not isinstance(state, str) or state not in RELAY_STATES
                or (revision != '' and (state != 'ready' or not hex_value(revision, 32)))
                or (state == 'ready' and value['state'] != 'paired')):
            raise PairingError('invalid_response')
    return value

def exchange(port, request, *, timeout=5, clock=time.monotonic):
    """One bounded send/read attempt. Caller must query after an unknown outcome."""
    request = {**request, 'request_id': secrets.token_hex(16)}
    frame = PREFIX + json.dumps(request, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii') + b'\n'
    if len(frame) > 8193:
        raise PairingError('request_too_large')
    # NUL makes a stale line invalid even if its JSON was complete. A bare
    # newline could instead complete and execute an interrupted mutation.
    wire = RESYNC + frame
    deadline = clock() + timeout
    try:
        if port.write(wire) != len(wire):
            raise PairingError('write_unconfirmed')
        buffer = bytearray()
        total = 0
        while clock() < deadline:
            chunk = port.read(256)
            total += len(chunk)
            if total > 32768:
                raise PairingError('response_limit')
            for byte in chunk:
                if byte != 10:
                    buffer.append(byte)
                    if len(buffer) > 8192:
                        raise PairingError('response_limit')
                    continue
                line = bytes(buffer).rstrip(b'\r'); buffer.clear()
                if not line.startswith(PREFIX):
                    continue
                try:
                    response = json.loads(line[len(PREFIX):], object_pairs_hook=unique_object)
                    response = validate_reply(response)
                except (ValueError, TypeError, RecursionError):
                    raise PairingError('invalid_response') from None
                if response['request_id'] == request['request_id']:
                    return response
        raise PairingError('response_unconfirmed')
    except PairingError:
        raise
    except Exception:
        raise PairingError('transport_unconfirmed') from None

def public_status(reply):
    fields = ('ok', 'error', 'device_id', 'pair_id', 'state', 'ready', 'busy', 'remaining_ms', 'result')
    return {key: reply[key] for key in (*fields, 'relay_state', 'relay_revision') if key in reply}

def perform(port, action, expected_device=None, expected_pair='', record=None, *, call=exchange, expected_relay=None):
    relay = action in RELAY_ACTIONS
    status_action = 'relay_status' if relay else 'optional_lan_status' if action == 'optional_lan_status' else 'status'
    status = call(port, {'action': status_action})
    if expected_device is not None and status['device_id'] != expected_device:
        raise PairingError('wrong_device')
    if relay and 'relay_state' not in status:
        raise PairingError('relay_not_supported')
    if action in ('status', 'relay_status', 'optional_lan_status'):
        return public_status(status)
    if action not in ('install', 'remove', 'relay_install', 'relay_remove') or not hex_value(expected_device, 12):
        raise PairingError('expected_device_required')
    if not status['ok'] or status['state'] not in {'empty', 'paired', 'revoked'}:
        raise PairingError('device_storage_unavailable')
    if status['pair_id'] != expected_pair:
        raise PairingError('identity_conflict')
    if relay and not hex_value(expected_pair, 32):
        raise PairingError('invalid_expected_pair')
    if expected_relay is not None and (status['relay_state'], status['relay_revision']) != expected_relay:
        raise PairingError('relay_state_changed')
    if not status['ready'] or status['busy'] or not status['window']:
        raise PairingError('physical_window_required')
    request = {'action': action, 'expected_device': expected_device,
               'expected_pair_id': expected_pair, 'window': status['window']}
    if action == 'install':
        if not isinstance(record, dict) or not hex_value(record.get('pair_id'), 32):
            raise PairingError('invalid_record')
        request['record'] = record
    elif action == 'relay_install':
        if (not isinstance(record, dict) or record.get('pair_id') != expected_pair
                or not hex_value(record.get('revision'), 32)):
            raise PairingError('invalid_record')
        request['record'] = record
    result = call(port, request)  # Never repeat this request automatically.
    if result['device_id'] != expected_device:
        raise PairingError('write_unconfirmed')
    if relay and (('relay_state' not in result) or (result['ok'] and (
            result['state'] != 'paired' or result['pair_id'] != expected_pair or
            (action == 'relay_install' and (result['relay_state'] != 'ready' or result['relay_revision'] != record['revision'])) or
            (action == 'relay_remove' and result['relay_state'] != 'empty')))):
        raise PairingError('write_unconfirmed')
    if result['ok'] and (result['busy'] or (action == 'install' and
            (result['state'] != 'paired' or result['pair_id'] != record['pair_id'])) or
            (action == 'remove' and result['state'] not in {'empty', 'revoked'})):
        raise PairingError('write_unconfirmed')
    return public_status(result)

def read_private_relay_bundle(path):
    """Local owner-only bundle. Never log its contents or a decoding error."""
    if path is None:
        raise PairingError('invalid_private_bundle')
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or not 0 < info.st_size <= 16384):
                raise ValueError()
            data = source.read(16385)
            if len(data) != info.st_size:
                raise ValueError()
        bundle = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object)
        if not isinstance(bundle, dict) or set(bundle) != {'record'} or not isinstance(bundle['record'], dict):
            raise ValueError()
        record = bundle['record']
        if len(json.dumps(record, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()) > 4096:
            raise ValueError()
        return record
    except (OSError, ValueError, TypeError, RecursionError, PairingError):
        raise PairingError('invalid_private_bundle') from None

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'install', 'remove', 'relay_status', 'relay_install', 'relay_remove'))
    parser.add_argument('--port')
    parser.add_argument('--expected-device')
    parser.add_argument('--expected-pair', default='')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    if not args.apply:
        print(json.dumps({'apply': False, 'action': args.action, 'opensSerial': False,
                          'requiresInstalledAgentAndPhysicalWindow': args.action not in ('status', 'relay_status')}))
        return 0
    try:
        if not args.port:
            raise PairingError('port_required')
        if args.action not in ('status', 'relay_status') and not hex_value(args.expected_device, 12):
            raise PairingError('expected_device_required')
        if args.expected_pair and not hex_value(args.expected_pair, 32):
            raise PairingError('invalid_expected_pair')
        if args.action in ('relay_install', 'relay_remove') and not hex_value(args.expected_pair, 32):
            raise PairingError('invalid_expected_pair')
        record = None
        if args.action == 'install':
            try:
                if not args.bundle or args.bundle.stat().st_size > 32768:
                    raise ValueError()
                record = json.loads(args.bundle.read_text(), object_pairs_hook=unique_object)['record']
                if not isinstance(record, dict) or len(json.dumps(record, ensure_ascii=True).encode()) > 4096:
                    raise ValueError()
            except Exception:
                raise PairingError('invalid_private_bundle') from None
        elif args.action == 'relay_install':
            record = read_private_relay_bundle(args.bundle)
        # No serial module import, enumeration or open occurs during dry-run.
        port = None
        try:
            port = configure_serial_port(args.port, timeout=0.1, write_timeout=1)
            port.open()
        except Exception:
            if port is not None:
                try:
                    port.close()
                except Exception:
                    pass
            raise PairingError('serial_open_failed') from None
        try:
            result = perform(port, args.action, args.expected_device, args.expected_pair, record)
        finally:
            try:
                port.close()
            except Exception:
                raise PairingError('serial_close_unconfirmed') from None
        print(json.dumps(result))
        return 0 if result['ok'] else 1
    except PairingError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'retryMutation': False,
                          'next': 'query relay_status before any further write' if args.action in RELAY_ACTIONS
                                  else 'query status before any further write'}))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
