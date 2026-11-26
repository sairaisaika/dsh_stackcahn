from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import fcntl
import json
import os
import tempfile

import prepare_runtime as setup


class SetupTests(TestCase):
    def test_package_hash_failure_precedes_venv_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            vendor = base / 'vendor'; vendor.mkdir()
            (vendor / setup.WHEEL).write_bytes(b'CORRUPTED')
            with patch.object(setup, 'VENDOR', vendor), patch.object(setup, 'run') as run:
                with self.assertRaisesRegex(setup.SetupError, 'runtime_package_invalid'):
                    setup.prepare(base / 'runtime')
                run.assert_not_called()
            self.assertFalse((base / 'runtime/active.json').exists())

    def test_partial_environment_is_not_active_and_retry_uses_new_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'runtime'
            with patch.object(setup, 'run', side_effect=OSError('injected interruption')):
                with self.assertRaises(OSError): setup.prepare(root)
            first = {p.name for p in root.iterdir() if p.is_dir()}
            self.assertEqual(len(first), 1)
            self.assertFalse((root / 'active.json').exists())
            with patch.object(setup, 'run'), patch.object(setup, 'verify'):
                generation = setup.prepare(root)
                self.assertNotIn(generation, first)
                self.assertEqual(setup.prepare(root), generation)
            self.assertEqual(len([p for p in root.iterdir() if p.is_dir()]), 2)
            self.assertEqual((root / 'active.json').stat().st_mode & 0o777, 0o600)

    def test_publish_failure_does_not_activate_partial_result(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'runtime'
            with patch.object(setup, 'run'), patch.object(setup, 'verify'), patch.object(os, 'replace', side_effect=OSError('publish failure')):
                with self.assertRaises(OSError): setup.prepare(root)
            self.assertFalse((root / 'active.json').exists())
            self.assertTrue(any(p.is_dir() for p in root.iterdir()))

    def test_invalid_active_record_is_not_replaced_and_root_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'runtime'; root.mkdir(mode=0o700)
            manifest = root / 'active.json'; manifest.write_text('{"secret":"KEEP"}')
            os.chmod(manifest, 0o600)
            with self.assertRaises(setup.SetupError): setup.prepare(root)
            self.assertEqual(manifest.read_text(), '{"secret":"KEEP"}')
            link = Path(temp) / 'link'; link.symlink_to(root)
            with self.assertRaises(setup.SetupError): setup.prepare(link)

    def test_active_environment_verification_failure_preserves_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'runtime'; root.mkdir(mode=0o700)
            manifest = root / 'active.json'
            manifest.write_text(json.dumps({'version': 1, 'generation': 'a' * 32})); os.chmod(manifest, 0o600)
            before = manifest.read_bytes()
            with patch.object(setup, 'verify', side_effect=OSError('missing base interpreter')):
                with self.assertRaises(OSError): setup.prepare(root)
            self.assertEqual(manifest.read_bytes(), before)

    def test_lock_content_is_not_authority_but_live_lock_rejects_concurrent_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'runtime'; root.mkdir(mode=0o700)
            lock = root / 'setup.lock'; lock.write_text('old process'); os.chmod(lock, 0o600)
            with lock.open('r+') as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(setup.SetupError, 'host_busy'): setup.prepare(root)
            with patch.object(setup, 'run'), patch.object(setup, 'verify'):
                self.assertEqual(len(setup.prepare(root)), 32)


if __name__ == '__main__':
    main()
