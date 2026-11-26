from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
from io import StringIO
import fcntl
import json
import os
import tempfile

import prepare_voice_installation as setup


def fake_build(directory, emit):
    (directory / 'bin').mkdir(mode=0o700)
    (directory / 'bin/sion-whisper-worker').write_bytes(b'test binary')
    (directory / 'bin/sion-whisper-worker').chmod(0o700)
    (directory / 'venv/bin').mkdir(mode=0o700, parents=True)
    setup.write_json(directory / 'candidate.json', {'version': setup.VERSION, 'generation': directory.name,
                     'inputs': setup.fingerprint(), 'whisperSha256': setup.digest(directory / 'bin/sion-whisper-worker')})
    emit('whisper')


class InstallationTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'runtime'
        self.p = patch.object(setup, 'prerequisites'); self.p.start(); self.addCleanup(self.p.stop)
        self.b = patch.object(setup, 'build', side_effect=fake_build); self.build = self.b.start(); self.addCleanup(self.b.stop)

    def test_candidate_is_not_published_without_host_commit(self):
        with self.assertRaisesRegex(setup.InstallError, 'cancelled'):
            setup.serve(self.root, source=StringIO(''), sink=StringIO())
        self.assertIsNone(setup.read_active(self.root))
        self.assertEqual(len([p for p in self.root.iterdir() if p.is_dir()]), 1)

    def test_commit_reuse_and_explicit_repair(self):
        setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())
        first = setup.read_active(self.root)
        setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())
        self.assertEqual(setup.read_active(self.root), first); self.assertEqual(self.build.call_count, 1)
        setup.serve(self.root, replace=True, source=StringIO('commit\n'), sink=StringIO())
        self.assertNotEqual(setup.read_active(self.root), first)
        self.assertTrue((self.root / first).is_dir())

    def test_interrupted_repair_and_publish_failure_keep_previous_pointer(self):
        setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())
        previous = (self.root / setup.ACTIVE).read_bytes()
        with self.assertRaises(setup.InstallError): setup.serve(self.root, True, source=StringIO(''), sink=StringIO())
        self.assertEqual((self.root / setup.ACTIVE).read_bytes(), previous)
        with patch.object(setup.os, 'replace', side_effect=OSError('failed')):
            with self.assertRaises(OSError): setup.serve(self.root, True, source=StringIO('commit\n'), sink=StringIO())
        self.assertEqual((self.root / setup.ACTIVE).read_bytes(), previous)

    def test_live_lock_and_invalid_pointer_are_not_overridden(self):
        self.root.mkdir(mode=0o700)
        with (self.root / 'install.lock').open('w+') as held:
            os.chmod(held.name, 0o600); fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(setup.InstallError, 'busy'): setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())
        setup.write_json(self.root / setup.ACTIVE, {'version': setup.VERSION, 'generation': '../outside'})
        with self.assertRaisesRegex(setup.InstallError, 'storage_invalid'): setup.serve(self.root, True, source=StringIO('commit\n'), sink=StringIO())
        self.build.assert_not_called()

    def test_changed_inputs_require_explicit_repair(self):
        setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())
        with patch.object(setup, 'fingerprint', return_value={'changed': 'input'}):
            with self.assertRaisesRegex(setup.InstallError, 'outdated'): setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())

    def test_root_symlink_rejected_and_bad_host_command_never_commits(self):
        other = Path(self.temp.name) / 'other'; other.mkdir(mode=0o700); self.root.symlink_to(other)
        with self.assertRaises(setup.InstallError): setup.serve(self.root, source=StringIO('commit\n'), sink=StringIO())
        self.root.unlink()
        with self.assertRaisesRegex(setup.InstallError, 'cancelled'): setup.serve(self.root, source=StringIO('COMMIT\n'), sink=StringIO())
        self.assertIsNone(setup.read_active(self.root))


if __name__ == '__main__': main()
