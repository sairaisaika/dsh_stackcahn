"""Private PTY for the native DSH rehearsal. Do not open an enumerated USB device."""

import os
import json
from pathlib import Path
import pty
import re
import select
import subprocess
import sys
import tty


FIXTURE_PORT = '/dev/cu.usbmodemfixture'
PTY_PATH = re.compile(r'/dev/(?:ttys[0-9a-z]+|pts/[0-9]+)')


def bridge(state):
    from agent_usb_audio import forward

    master, slave = pty.openpty()
    try:
        tty.setraw(slave)
        name = os.ttyname(slave)
        assert PTY_PATH.fullmatch(name)
        with state.open('x') as file:
            file.write(name)
        with os.fdopen(3, 'wb') as status:
            status.write(b'ready\n')
        forward(master)
    finally:
        os.close(master)
        os.close(slave)


def pairing_bridge(state, executable, device, captured):
    os.umask(0o077)
    assert re.fullmatch('[a-f0-9]{12}', device) and not captured.exists()
    master, slave = pty.openpty()
    try:
        tty.setraw(slave)
        name = os.ttyname(slave)
        assert PTY_PATH.fullmatch(name)
        with subprocess.Popen([executable, '--stdio-capture', device, captured],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE) as peer:
            with state.open('x') as file:
                file.write(name)
            with os.fdopen(3, 'wb') as status:
                status.write(b'ready\n')
            dropped = False
            replies = b''
            try:
                while True:
                    ready, _, _ = select.select([0, master, peer.stdout], [], [])
                    if 0 in ready:
                        assert os.read(0, 1) == b'', 'unexpected fixture control data'
                        break
                    if master in ready:
                        peer.stdin.write(os.read(master, 4096))
                        peer.stdin.flush()
                    if peer.stdout in ready:
                        block = os.read(peer.stdout.fileno(), 4096)
                        assert block, 'paired device probe stopped'
                        replies += block
                        while b'\n' in replies:
                            line, _, replies = replies.partition(b'\n')
                            assert line.startswith(b'SIONA1 ')
                            value = json.loads(line[7:])
                            if not dropped and value['ok'] and value['state'] == 'paired':
                                assert captured.is_file(), 'device must commit before its reply is lost'
                                dropped = True
                                continue
                            wire = line + b'\n'
                            assert os.write(master, wire) == len(wire)
                assert dropped, 'fixture did not exercise the lost write acknowledgement'
            finally:
                peer.stdin.close()
                try:
                    assert peer.wait(timeout=3) == 0
                except subprocess.TimeoutExpired:
                    peer.kill()
                    raise
    finally:
        os.close(master)
        os.close(slave)


def launch(state, args):
    helper_name = Path(args[0]).name if args else ''
    is_pairing = helper_name == 'agent_pairing_host.py' and state.with_suffix('.pairing').is_file()
    if helper_name != 'agent_usb_audio.py' and not is_pairing:
        os.execv(sys.executable, [sys.executable, *args])
    helper = Path(args[0]).resolve(strict=True)
    assert helper.is_relative_to(state.parent / 'dsh'), f'helper resolved outside the isolated profile: {helper}'
    endpoint = (state.with_suffix('.pairing') if is_pairing else state).read_text()
    assert PTY_PATH.fullmatch(endpoint), 'invalid fixture PTY record'

    sys.path[:0] = [str(helper.parent), str(helper.parent.parent / 'vendor/pyserial/pyserial-3.5-py2.py3-none-any.whl')]
    if is_pairing:
        import agent_pairing_host

        open_device = agent_pairing_host.device_call

        def open_pty(path, *fields, **policy):
            assert path == FIXTURE_PORT
            return open_device(endpoint, *fields, **policy)

        agent_pairing_host.device_call = open_pty
        sys.argv = args
        return agent_pairing_host.main()

    assert args[1:] == [FIXTURE_PORT], f'unexpected fixture port arguments: {args[1:]!r}'
    import agent_usb_audio
    device = agent_usb_audio.read_device_id()
    assert device == '123456abcdef', 'audio identity must come from the installed pairing lease'

    # Replace only USB discovery. Use the installed serial helper and its wheel.
    def verify_pty(path, expected):
        assert path == endpoint and PTY_PATH.fullmatch(path) and expected == device
        return agent_usb_audio.usb_node_identity(os.lstat(path))

    agent_usb_audio.verify_managed_usb_port = verify_pty
    return agent_usb_audio.main(endpoint, device)


if __name__ == '__main__':
    mode, path, *args = sys.argv[1:]
    state = Path(path).resolve()
    if mode == 'bridge':
        assert not args
        bridge(state)
    elif mode == 'pairing':
        executable, device, captured = args
        pairing_bridge(state, executable, device, Path(captured))
    elif mode == 'launch':
        try:
            result = launch(state, args)
        except Exception as error:
            state.with_suffix('.error').write_text(f'{type(error).__name__}: {error}\n')
            raise
        if result:
            state.with_suffix('.error').write_text(f'installed serial helper exited with {result}\n')
        raise SystemExit(result)
    else:
        raise ValueError('unknown USB fixture mode')
