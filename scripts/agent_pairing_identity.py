"""Host-private identity lease. Stdout contains credentials: never expose via Remote.

Uses the existing journal lock and validation. No serial access, identity generation,
state mutation or device writes. EOF on the private stdin pipe releases the lock.
"""
import argparse
import json
import sys
from agent_pairing_host import Journal, HostError, hex_value


def serve(root):
    journal = Journal(root)
    with journal.locked():
        state = journal.load()
        if state['pending']:
            raise HostError('reconcile_required')
        if not state['active'] or not hex_value(state['device'], 12):
            raise HostError('active_identity_required')
        pairing = journal.bundle(state['active'])
        # Ready is emitted only while the same OS lock remains held.
        print(json.dumps(dict(ok=True, deviceId=state['device'], pairing=pairing),
                         separators=(',', ':')), flush=True)
        if sys.stdin.buffer.read(1):
            raise HostError('invalid_request')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    try:
        serve(args.root)
    except Exception as error:
        code = str(error) if isinstance(error, HostError) else 'private_storage_invalid'
        if code not in {'reconcile_required', 'active_identity_required', 'host_busy',
                        'private_storage_required', 'private_storage_invalid', 'invalid_request'}:
            code = 'private_storage_invalid'
        print(json.dumps(dict(ok=False, error=code)), flush=True)
        raise SystemExit(1)
