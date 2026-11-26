"""Exclusive raw USB audio relay. The Host owns TLS, not this subprocess."""
import os
import re
import select
import sys

from agent_pairing_host import HostError, usb_node_identity, verify_managed_usb_port
from agent_pairing_usb import configure_serial_port


BUFFER_LIMIT = 8192


def forward(port_fd, source=0, destination=1):
    for fd in (port_fd, source, destination):
        os.set_blocking(fd, False)
    to_port, to_host = bytearray(), bytearray()
    while True:
        signals = [(source, port_fd, to_port), (port_fd, destination, to_host)]
        readable, writable, _ = select.select(
            [reader for reader, _, buffer in signals if len(buffer) < BUFFER_LIMIT],
            [writer for _, writer, buffer in signals if buffer], [])
        for reader, writer, buffer in signals:
            try:
                if writer in writable:
                    del buffer[:os.write(writer, buffer)]
                if reader in readable:
                    data = os.read(reader, BUFFER_LIMIT - len(buffer))
                    if not data:
                        return
                    buffer.extend(data)
            except BlockingIOError:
                continue


def read_device_id():
    with os.fdopen(4, 'rb') as identity:
        value = identity.read(14)
    return value[:-1].decode('ascii') if re.fullmatch(b'[0-9a-f]{12}\n', value) else ''


def main(path, device):
    with os.fdopen(3, 'wb', buffering=0) as status:
        try:
            if not re.fullmatch('[0-9a-f]{12}', device):
                raise HostError('managed_usb_identity_mismatch')
            node = verify_managed_usb_port(path, device)
            port = configure_serial_port(path, preserve_modem_lines=True)
            port.open()
            with port:
                if (usb_node_identity(os.fstat(port.fileno())) != node
                        or verify_managed_usb_port(path, device) != node):
                    raise HostError('managed_usb_identity_mismatch')
                status.write(b'ready\n')
                status.close()
                forward(port.fileno())
        except HostError as error:
            status.write(b'mismatch\n' if str(error) == 'managed_usb_identity_mismatch' else b'unavailable\n')
            return 1
        except (OSError, ValueError, ImportError):
            if not status.closed:
                status.write(b'open-failed\n')
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1] if len(sys.argv) == 2 else '', read_device_id()))
