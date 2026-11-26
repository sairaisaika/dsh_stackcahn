"""Exercise device selection and single-request ownership without physical USB."""
from contextlib import contextmanager
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import agent_usb_entry as entry


MAC = '12:34:56:78:90:ab'
NODE = SimpleNamespace(st_mode=stat.S_IFCHR, st_dev=1, st_ino=2, st_rdev=3)
FIRST = '/dev/cu.usbmodemFixture1'
SECOND = '/dev/cu.usbmodemFixture2'


def port(path, serial_number=MAC):
    return SimpleNamespace(device=path, serial_number=serial_number, vid=0x303A, pid=0x1001)


class EntryTests(unittest.TestCase):
    def test_identifies_one_device_by_complete_serial_number(self):
        with patch.object(entry.os, 'lstat', return_value=NODE) as lstat:
            self.assertEqual(entry.matching_port(MAC, [port(FIRST, MAC.upper()), port(SECOND, '12:00:00:00:00:ab'),
                                                       port('/dev/tty.usbmodemFixture1')]), (FIRST, (1, 2, 3)))
        lstat.assert_called_once_with(FIRST)

    def test_refuses_duplicates_and_link_nodes(self):
        with self.assertRaisesRegex(entry.EntryError, 'ambiguous-device'):
            entry.matching_port(MAC, [port(FIRST), port(SECOND)])
        with patch.object(entry.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFLNK)):
            with self.assertRaisesRegex(entry.EntryError, 'invalid-device-node'):
                entry.matching_port(MAC, [port(FIRST)])

    def exercise(self, inventory, *, open_fault=None, write_fault=None, close_fault=None, short_write=False,
                 opened_node=NODE):
        opened, messages = [], []

        def write(message):
            messages.append(message)
            if write_fault:
                raise write_fault
            return len(message) - short_write

        @contextmanager
        def at_path(path):
            opened.append(path)
            if path == FIRST and open_fault:
                raise open_fault
            yield SimpleNamespace(fileno=lambda: 5, write=write)
            if close_fault:
                raise close_fault

        with patch.object(entry.os, 'lstat', return_value=NODE), patch.object(entry.os, 'fstat', return_value=opened_node), \
                patch.object(entry, 'wait_ready', return_value=True):
            result = entry.request_entry(MAC, inventory, 0.25, open_port=at_path)
        return result, opened, messages

    def test_open_failure_can_retry_after_same_unit_reenumerates(self):
        events = iter(([port(FIRST)], [], [port(SECOND)], [port(SECOND)]))
        self.assertEqual(self.exercise(lambda: next(events), open_fault=OSError()),
                         ('request-queued', [FIRST, SECOND], [entry.REQUEST]))

    def test_open_failure_does_not_reopen_the_same_identity_and_node_in_a_loop(self):
        self.assertEqual(self.exercise(lambda: [port(FIRST)], open_fault=OSError()),
                         ('ready-timeout', [FIRST], []))

    def test_wrong_physical_unit_after_ready_is_rejected_before_writing(self):
        events = iter(([port(FIRST)], [port(FIRST, 'ab:cd:ef:00:00:01')]))
        with self.assertRaisesRegex(entry.EntryError, 'device-changed'):
            self.exercise(lambda: next(events))

    def test_rejects_different_node_returned_by_open(self):
        swapped = SimpleNamespace(st_dev=1, st_ino=100, st_rdev=3)
        with self.assertRaisesRegex(entry.EntryError, 'device-changed'):
            self.exercise(lambda: [port(FIRST)], opened_node=swapped)

    def test_signals_listening_once_after_validating_an_open_port(self):
        events = []
        inventory = iter(([port(FIRST)], [], [port(SECOND)], [port(SECOND)]))

        @contextmanager
        def at_path(path):
            events.append(path)
            yield SimpleNamespace(fileno=lambda: 5, write=lambda message: len(message))

        def ready(_port, _deadline):
            events.append('read')
            if events.count('read') == 1:
                raise OSError('device restarted')
            return True

        with patch.object(entry.os, 'lstat', return_value=NODE), patch.object(entry.os, 'fstat', return_value=NODE), \
                patch.object(entry, 'wait_ready', side_effect=ready):
            result = entry.request_entry(MAC, lambda: next(inventory), 0.25, open_port=at_path,
                                         on_listening=lambda: events.append('listening'))

        self.assertEqual(result, 'request-queued')
        self.assertEqual(events, [FIRST, 'listening', 'read', SECOND, 'read'])

    def test_never_resends_after_partial_write_write_error_or_close_error(self):
        for flags in ({'short_write': True}, {'write_fault': OSError()}, {'close_fault': OSError()}):
            with self.subTest(flags=flags):
                self.assertEqual(self.exercise(lambda: [port(FIRST)], **flags),
                                 ('send-unconfirmed', [FIRST], [entry.REQUEST]))


if __name__ == '__main__':
    unittest.main()
