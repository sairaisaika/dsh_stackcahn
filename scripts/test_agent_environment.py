"""Read-only environment checks with OS/USB fixtures; no real port is opened."""
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace, ModuleType
from unittest import TestCase, main
from unittest.mock import patch, Mock
import json
import os
import subprocess
import sys
import tempfile

import agent_environment as env


def port(path='/dev/cu.fixture', vid=0x303a, pid=0x1001, description='USB fixture'):
    return SimpleNamespace(device=path, vid=vid, pid=pid, description=description,
                           serial_number='PRIVATE-SERIAL', hwid='PRIVATE-HWID')


class EnvironmentTests(TestCase):
    def test_inventory_filters_bounds_sorts_and_does_not_promote_identity(self):
        candidates, truncated = env.usb_candidates([
            port('/dev/tty.fixture'), port('/dev/cu.Bluetooth', None, None),
            port('/dev/cu.bad\n'), port('/dev/cu.bad', True, 1),
            port(description='test\x00\n\u202e' + '中' * 150), port(),
        ] + [port('/dev/cu.usb%02d' % n) for n in range(20)])
        self.assertEqual(len(candidates), 16)
        self.assertTrue(truncated)
        self.assertEqual([p['path'] for p in candidates], sorted(p['path'] for p in candidates))
        self.assertEqual(set(candidates[0]), {'path', 'description', 'vid', 'pid'})
        self.assertNotIn('PRIVATE', json.dumps(candidates))
        sanitized, _ = env.usb_candidates([port(description='test\x00\n\u202e' + '中' * 150)])
        self.assertEqual(len(sanitized[0]['description']), 96)
        self.assertTrue(sanitized[0]['description'].isprintable())

    def test_storage_only_stats_directory_and_leaves_journal_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            private = Path(root) / 'private'
            self.assertEqual(env.storage_status(''), 'unconfigured')
            self.assertEqual(env.storage_status(private), 'absent')
            self.assertFalse(private.exists())
            private.mkdir(mode=0o700)
            secret = private / 'state.json'
            secret.write_text('DO NOT READ OR REPAIR')
            with patch('pathlib.Path.open', side_effect=AssertionError('no contents access')):
                self.assertEqual(env.storage_status(private), 'private')
            self.assertEqual(secret.read_text(), 'DO NOT READ OR REPAIR')
            os.chmod(private, 0o755)
            self.assertEqual(env.storage_status(private), 'invalid')
            link = Path(root) / 'link'
            link.symlink_to(private)
            self.assertEqual(env.storage_status(link), 'invalid')
            self.assertEqual(env.storage_status(secret), 'invalid')

    def test_pyserial_uses_only_comports_never_serial_constructor(self):
        serial = ModuleType('serial')
        serial.Serial = Mock(side_effect=AssertionError('must not open serial'))
        tools = ModuleType('serial.tools')
        tools.list_ports = SimpleNamespace(comports=Mock(return_value=[port()]))
        with patch.dict(sys.modules, {'serial': serial, 'serial.tools': tools}):
            status, ports, truncated = env.serial_inventory()
        self.assertEqual(status, 'available')
        self.assertEqual(len(ports), 1)
        self.assertFalse(truncated)
        tools.list_ports.comports.assert_called_once_with(include_links=False)
        serial.Serial.assert_not_called()

    def test_missing_serial_and_failed_enumeration_are_distinct(self):
        with patch.dict(sys.modules, {'serial': None, 'serial.tools': None}):
            self.assertEqual(env.serial_inventory(), ('missing', [], False))
        tools = ModuleType('serial.tools')
        tools.list_ports = SimpleNamespace(comports=Mock(side_effect=RuntimeError('SECRET')))
        with patch.dict(sys.modules, {'serial': ModuleType('serial'), 'serial.tools': tools}):
            self.assertEqual(env.serial_inventory(), ('unavailable', [], False))

    def test_unsupported_platform_or_python_does_not_enumerate(self):
        for platform, version in [('linux', (3, 15)), ('darwin', (3, 9))]:
            with ExitStack() as stack:
                stack.enter_context(patch.object(sys, 'platform', platform))
                stack.enter_context(patch.object(sys, 'version_info', version))
                scan = stack.enter_context(patch.object(env, 'serial_inventory', side_effect=AssertionError('no scan')))
                stack.enter_context(patch.object(env, 'openssl_status', return_value='missing'))
                result = env.report()
                self.assertEqual(result['serial'], 'not_checked')
                self.assertEqual(result['ports'], [])
                self.assertFalse(result['deviceAccess'])
                scan.assert_not_called()

    def test_openssl_is_fixed_bounded_subprocess_and_errors_do_not_leak(self):
        for effect, expected in [(FileNotFoundError('SECRET'), 'missing'),
                                 (subprocess.TimeoutExpired('SECRET', 3), 'unavailable'),
                                 (OSError('SECRET'), 'unavailable')]:
            with patch.object(subprocess, 'run', side_effect=effect):
                self.assertEqual(env.openssl_status(), expected)
        with patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            self.assertEqual(env.openssl_status(), 'available')
            self.assertEqual(run.call_args.args[0], ['openssl', 'version'])
            self.assertEqual(run.call_args.kwargs['timeout'], 3)
            self.assertEqual(run.call_args.kwargs['stdout'], subprocess.DEVNULL)


if __name__ == '__main__':
    main()
