"""No-port checks for the explicit trial confirmation CLI."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pairing_usb', Path(__file__).resolve().parents[1]/'scripts/pairing_usb.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class TrialUsbTests(unittest.TestCase):
    def invoke(self, args, status=None):
        serial = types.SimpleNamespace(Serial=lambda **kwargs: types.SimpleNamespace(open=lambda: None, close=lambda: None))
        self.calls = []
        def exchange(port, action, **fields):
            self.calls.append((action, fields))
            return status if action == 'status' else {'ok': True}
        with patch.object(sys, 'argv', ['pairing_usb.py', *args]), patch.dict(sys.modules, {'serial': serial}), patch.object(cli, 'exchange', exchange), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            cli.main()

    def args(self):
        return ['confirm_firmware', '--apply', '--port', 'FAKE-NOT-A-DEVICE',
                '--expected-device', '0123456789ab', '--expected-boot', 'boot',
                '--expected-image', 'hash', '--voice-and-app-verified']

    def status(self):
        return {'device_id': '0123456789ab', 'firmware_trial': {'state': 'pending', 'boot_nonce': 'boot', 'image_sha256': 'hash'}}

    def test_default_is_local_plan(self):
        self.invoke(['confirm_firmware'])
        self.assertEqual(self.calls, [])

    def test_requires_observed_voice_and_app(self):
        with self.assertRaises(SystemExit):
            self.invoke(self.args()[:-1])
        self.assertEqual(self.calls, [])

    def test_reject_wrong_boot_image_device_and_state(self):
        for field in ('device_id', 'boot_nonce', 'image_sha256', 'state'):
            status = self.status()
            if field == 'device_id': status[field] = 'other'
            else: status['firmware_trial'][field] = 'other'
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.invoke(self.args(), status)
            self.assertEqual([a for a, _ in self.calls], ['status'])

    def test_exact_confirmation_request(self):
        self.invoke(self.args(), self.status())
        self.assertEqual(self.calls[-1], ('confirm_firmware', {'boot_nonce': 'boot', 'image_sha256': 'hash', 'voice_and_app_verified': True}))


if __name__ == '__main__': unittest.main()
