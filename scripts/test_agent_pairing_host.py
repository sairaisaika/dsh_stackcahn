"""Host journal tests use private temporary roots and fake device I/O only."""
import fcntl
import json
import multiprocessing
import os
import stat
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, mock_open, patch

import agent_usb_audio
from agent_pairing_host import Journal, HostError, execute, verify_managed_usb_port
from agent_pairing_usb import PairingError

DEVICE = '123456abcdef'
PAIR = 'a' * 32


def fake_generate(directory, url, _node):
    directory.mkdir(mode=0o700)
    record = dict(version=1, record=dict(pair_id=PAIR, key='PRIVATE-SECRET', local_url=url),
                  host=dict(cert='cert', key='HOST-SECRET'))
    (directory / 'pairing.json').write_text(json.dumps(record))
    (directory / 'pairing.json').chmod(0o600)


def response(pair='', state=None):
    return dict(ok=True, device_id=DEVICE, pair_id=pair, state=state or ('paired' if pair else 'empty'), busy=False)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = Journal(Path(self.temp.name) / 'private')
        self.device = ''
        self.mutations = 0

    def tearDown(self):
        self.temp.cleanup()

    def request(self, action, **extra):
        with self.journal.locked():
            revision = self.journal.load()['revision']
        req = dict(action=action, revision=revision, deviceId=DEVICE, **extra)
        if action in ('inspect', 'install', 'remove'):
            req['port'] = '/dev/cu.fake'
        return req

    def prepare(self):
        return execute(self.journal, self.request('prepare', localUrl='wss://192.168.1.2:1234/audio'), generate=fake_generate)

    def transport(self, _port, action, _device, expected, record):
        if action != 'status':
            self.assertEqual(expected, self.device)
            self.mutations += 1
            self.device = record['pair_id'] if action == 'install' else ''
        return response(self.device)

    def test_prepare_is_private_and_passive_then_install_remove(self):
        snap = self.prepare()
        self.assertEqual(snap['candidatePairId'], PAIR)
        self.assertNotIn('SECRET', json.dumps(snap))
        snap = execute(self.journal, self.request('install'), transport=self.transport)
        self.assertEqual(snap['activePairId'], PAIR)
        self.assertEqual(snap['candidatePairId'], '')
        snap = execute(self.journal, self.request('remove'), transport=self.transport)
        self.assertEqual(snap['activePairId'], '')
        self.assertFalse(snap['connected'])
        self.assertEqual(self.mutations, 2)
        self.assertEqual((self.journal.root / 'state.json').stat().st_mode & 0o777, 0o600)
        # Removed identities remain private recovery evidence, never secure-erased implicitly.
        self.assertEqual(len(list(self.journal.root.glob('*/pairing.json'))), 1)

    def test_identification_reads_once_without_creating_or_revising_the_journal(self):
        request = dict(action='identify', port='/dev/cu.fixture')
        port_check = Mock()
        transport = Mock(return_value=response(PAIR))
        with self.assertRaisesRegex(HostError, 'device_access_disabled'):
            execute(self.journal, request, validate_port=port_check)
        port_check.assert_not_called()
        identity = execute(self.journal, request, transport=transport, validate_port=port_check)
        port_check.assert_called_once_with('/dev/cu.fixture')
        transport.assert_called_once_with('/dev/cu.fixture', 'status', None, '', None)
        self.assertEqual(identity, {'deviceId': DEVICE})
        self.assertFalse(self.journal.root.exists())
        transport.return_value = response() | {'busy': True}
        with self.assertRaisesRegex(HostError, 'device_state_unavailable'):
            execute(self.journal, request, transport=transport)
        with self.assertRaisesRegex(HostError, 'invalid_port'):
            execute(self.journal, request | {'port': '/dev/disk3'}, transport=transport)
        self.assertFalse(self.journal.root.exists())

    def test_omitted_lan_checks_device_support_before_recording_write_intent(self):
        prepared = execute(self.journal, self.request('prepare', localUrl=''), generate=fake_generate)
        self.assertEqual(prepared['candidatePairId'], PAIR)
        request = self.request('install')
        journal_file = self.journal.root / 'state.json'
        before = journal_file.read_bytes()
        legacy = Mock(return_value=response() | {'ok': False, 'error': 'invalid_request'})
        with self.assertRaisesRegex(HostError, 'optional_lan_not_supported'):
            execute(self.journal, request, transport=legacy)
        legacy.assert_called_once_with('/dev/cu.fake', 'optional_lan_status', DEVICE, '', None)
        self.assertEqual(journal_file.read_bytes(), before)
        current = Mock(side_effect=[response(), response(PAIR)])
        active = execute(self.journal, request, transport=current)
        self.assertEqual(active['activePairId'], PAIR)
        self.assertEqual(current.call_args_list[1].args[-1]['local_url'], '')

    def test_relay_uses_only_local_file_and_device_bound_to_existing_pair(self):
        self.prepare()
        paired = execute(self.journal, self.request('install'), transport=self.transport)
        profile = Path(self.temp.name)
        filename = profile / '.stackchan-relay-device.json'
        stage = dict(version=1, pair_id=PAIR, revision='b'*32, origin='wss://relay.example.test',
                     room_id='d'*32, token='e'*64, ca='FIXTURE-CA', ssid='TEST-HOTSPOT', password='PRIVATE-PASSWORD')
        filename.write_text(json.dumps({'record':stage})); filename.chmod(0o600)
        status = execute(self.journal, {'action':'relay_check'}, profile=profile)
        self.assertEqual(status['stagedRevision'], stage['revision'])
        self.assertIsNone(status['device'])
        self.assertNotIn('PRIVATE-PASSWORD', json.dumps(status))
        inspect = dict(action='relay_inspect', revision=paired['revision'], port='/dev/cu.fixture')
        with self.assertRaisesRegex(HostError, '^device_access_disabled$'):
            execute(self.journal, inspect, profile=profile)
        base = (self.journal.root / 'state.json').read_bytes()
        sent = []
        def relay_transport(port, action, device, pair, record, **policy):
            self.assertEqual((port, device, pair), ('/dev/cu.fixture', DEVICE, PAIR))
            sent.append((action, policy))
            if action == 'relay_install':
                self.assertEqual(record,stage)
                return response(PAIR) | dict(relay_state='ready', relay_revision=stage['revision'])
            self.assertIsNone(record)
            return response(PAIR) | dict(relay_state='empty', relay_revision='')
        self.assertEqual(execute(self.journal, inspect, profile=profile, transport=relay_transport)['device']['state'], 'empty')
        install = inspect | dict(action='relay_install', expectedState='empty', expectedRevision='', stagedRevision='f'*32)
        with self.assertRaisesRegex(HostError, '^relay_bundle_changed$'):
            execute(self.journal, install, profile=profile, transport=relay_transport)
        with self.assertRaisesRegex(HostError, '^invalid_request$'):
            execute(self.journal, install | {'filename':'somewhere'}, profile=profile, transport=relay_transport)
        self.assertEqual(len(sent),1)
        installed = execute(self.journal, install | {'stagedRevision':stage['revision']}, profile=profile, transport=relay_transport)
        self.assertEqual(installed['device']['revision'], stage['revision'])
        self.assertEqual(sent[-1], ('relay_install', {'expected_relay': ('empty', '')}))
        self.assertNotIn(stage['token'], json.dumps(installed))
        remove = inspect | dict(action='relay_remove', expectedState='ready', expectedRevision=stage['revision'])
        def stale(*_args, **_kwargs):
            raise PairingError('relay_state_changed')
        with self.assertRaisesRegex(HostError, '^relay_state_changed$'):
            execute(self.journal, remove, profile=profile, transport=stale)
        self.assertEqual(execute(self.journal, remove, profile=profile, transport=relay_transport)['device']['state'], 'empty')
        self.assertEqual((self.journal.root / 'state.json').read_bytes(), base)

    def test_lost_reply_after_device_commit_reconciles_without_replay(self):
        self.prepare()
        def lost(*args):
            self.transport(*args)
            raise OSError('PRIVATE-SECRET')
        with self.assertRaises(OSError):
            execute(self.journal, self.request('install'), transport=lost)
        restarted = Journal(self.journal.root)
        snap = execute(restarted, {'action': 'snapshot'})
        self.assertEqual(snap['pending'], 'install')
        with self.assertRaisesRegex(HostError, 'reconcile_required'):
            execute(restarted, self.request('install'), transport=self.transport)
        snap = execute(restarted, self.request('inspect'), transport=self.transport)
        self.assertEqual(snap['activePairId'], PAIR)
        self.assertEqual(snap['pending'], '')
        self.assertEqual(self.mutations, 1)

    def test_failure_before_send_requires_inspection_and_explicit_retry(self):
        self.prepare()
        with self.assertRaises(OSError):
            execute(self.journal, self.request('install'), transport=lambda *a: (_ for _ in ()).throw(OSError()))
        snap = execute(self.journal, self.request('inspect'), transport=self.transport)
        self.assertEqual(snap['pending'], '')
        self.assertEqual(snap['candidatePairId'], PAIR)
        self.assertEqual(self.mutations, 0)

    def test_revoke_lost_reply_and_unknown_identity_fail_closed(self):
        self.prepare()
        execute(self.journal, self.request('install'), transport=self.transport)
        def lost(*args):
            self.transport(*args)
            raise OSError()
        with self.assertRaises(OSError):
            execute(self.journal, self.request('remove'), transport=lost)
        with self.assertRaisesRegex(HostError, 'identity_conflict'):
            execute(self.journal, self.request('inspect'), transport=lambda *a: response('b'*32))
        self.assertEqual(execute(self.journal, {'action': 'snapshot'})['pending'], 'remove')
        snap = execute(self.journal, self.request('inspect'), transport=self.transport)
        self.assertEqual(snap['activePairId'], '')

    def test_conflicts_and_disabled_device_do_not_open_transport(self):
        self.prepare()
        req = self.request('install')
        with self.assertRaisesRegex(HostError, 'device_access_disabled'):
            execute(self.journal, req)
        req['revision'] -= 1
        with self.assertRaisesRegex(HostError, 'revision_conflict'):
            execute(self.journal, req, transport=self.transport)
        req = self.request('inspect'); req['deviceId'] = '0'*12
        with self.assertRaisesRegex(HostError, 'wrong_device'):
            execute(self.journal, req, transport=self.transport)
        self.assertEqual(self.mutations, 0)

    def test_managed_precheck_rejects_before_creating_write_intent(self):
        previous = self.prepare()

        def reject(_path):
            raise HostError('managed_usb_port_unavailable')

        with self.assertRaisesRegex(HostError, 'managed_usb_port_unavailable'):
            execute(self.journal, self.request('install'), transport=self.transport, validate_port=reject)
        self.assertEqual(self.mutations, 0)
        self.assertEqual(execute(self.journal, {'action': 'snapshot'}), previous)

    def test_managed_port_requires_current_usbmodem_character_device_and_chip(self):
        path = '/dev/cu.usbmodem14101'
        usb = SimpleNamespace(device=path, vid=0x303A, pid=0x1001, serial_number='12:34:56:AB:CD:EF')
        inventory = SimpleNamespace(comports=lambda *, include_links: [] if include_links else [usb])
        modules = {'serial': SimpleNamespace(), 'serial.tools': SimpleNamespace(list_ports=inventory)}
        with patch.dict('sys.modules', modules), patch('sys.platform', 'darwin'), \
                patch('os.lstat', return_value=SimpleNamespace(st_mode=stat.S_IFCHR,
                      st_dev=1, st_ino=2, st_rdev=3)) as stat_path:
            verify_managed_usb_port(path)
            self.assertEqual(verify_managed_usb_port(path, DEVICE), (1, 2, 3))
            with self.assertRaisesRegex(HostError, 'managed_usb_identity_mismatch'):
                verify_managed_usb_port(path, '3'*12)
            usb.serial_number = None
            with self.assertRaisesRegex(HostError, 'managed_usb_identity_mismatch'):
                verify_managed_usb_port(path, DEVICE)
            verify_managed_usb_port(path)  # First pairing still uses physical authorization.
            usb.serial_number = '123456ABCDEF'
            self.assertEqual(verify_managed_usb_port(path, DEVICE), (1, 2, 3))
            with self.assertRaisesRegex(HostError, 'managed_usb_port_unavailable'):
                verify_managed_usb_port('/dev/cu.usbmodem-other')
            with self.assertRaisesRegex(HostError, 'managed_usb_port_unavailable'):
                verify_managed_usb_port('/dev/cu.Bluetooth-Incoming-Port')
            usb.pid = 0x0001
            with self.assertRaisesRegex(HostError, 'managed_usb_port_unavailable'):
                verify_managed_usb_port(path)
            usb.pid = 0x1001
            stat_path.return_value.st_mode = stat.S_IFLNK
            with self.assertRaisesRegex(HostError, 'managed_usb_port_unavailable'):
                verify_managed_usb_port(path)

    def test_audio_rejects_wrong_device_before_open_and_rechecks_open_handle(self):
        path = '/dev/cu.usbmodem14101'
        node = SimpleNamespace(st_dev=1, st_ino=2, st_rdev=3)
        changed = SimpleNamespace(st_dev=1, st_ino=7, st_rdev=3)
        for inventory, opened_node, opens in (
                ([HostError('managed_usb_identity_mismatch')], node, False),
                ([(1, 2, 3)], changed, True),
                ([(1, 2, 3), HostError('managed_usb_identity_mismatch')], node, True)):
            with self.subTest(opens=opens, inventory=len(inventory)):
                status = mock_open()
                port = MagicMock()
                port.is_open = False
                port.open.side_effect = lambda: setattr(port, 'is_open', True)
                def enter():
                    if not port.is_open:
                        port.open()
                    return port
                port.__enter__.side_effect = enter
                port.fileno.return_value = 12
                with patch.object(agent_usb_audio, 'configure_serial_port', return_value=port) as configure, \
                        patch.object(agent_usb_audio, 'verify_managed_usb_port', side_effect=inventory) as verify, \
                        patch.object(agent_usb_audio.os, 'fdopen', status), \
                        patch.object(agent_usb_audio.os, 'fstat', return_value=opened_node), \
                        patch.object(agent_usb_audio, 'forward') as forward:
                    self.assertEqual(agent_usb_audio.main(path, DEVICE), 1)
                status.return_value.write.assert_called_once_with(b'mismatch\n')
                self.assertEqual(port.open.called, opens)
                if opens:
                    port.open.assert_called_once_with()
                    configure.assert_called_once_with(path, preserve_modem_lines=True)
                else:
                    configure.assert_not_called()
                for call in verify.call_args_list:
                    self.assertEqual(call.args, (path, DEVICE))
                forward.assert_not_called()

    def test_corrupt_state_and_symlink_are_never_treated_as_empty(self):
        self.prepare()
        state = self.journal.root / 'state.json'
        state.write_text('{broken')
        with self.assertRaises(ValueError):
            execute(self.journal, {'action': 'snapshot'})
        state.unlink(); state.symlink_to(Path(self.temp.name) / 'outside')
        with self.assertRaises(OSError):
            execute(self.journal, {'action': 'snapshot'})

    def test_journal_failure_prevents_device_send_and_retains_candidate(self):
        self.prepare()
        with patch.object(self.journal, 'save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                execute(self.journal, self.request('install'), transport=self.transport)
        self.assertEqual(self.mutations, 0)
        self.assertEqual(execute(self.journal, {'action': 'snapshot'})['candidatePairId'], PAIR)

    def test_busy_device_does_not_resolve_pending(self):
        self.prepare()
        with self.assertRaises(OSError):
            execute(self.journal, self.request('install'), transport=lambda *a: (_ for _ in ()).throw(OSError()))
        with self.assertRaisesRegex(HostError, 'device_state_unavailable'):
            execute(self.journal, self.request('inspect'), transport=lambda *a: {**response(PAIR), 'busy': True})
        self.assertEqual(execute(self.journal, {'action': 'snapshot'})['pending'], 'install')

    def test_device_committed_but_final_host_save_failed_recovers_after_restart(self):
        self.prepare()
        save = self.journal.save
        calls = 0
        def fail_final(value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('disk unavailable after device commit')
            save(value)
        with patch.object(self.journal, 'save', side_effect=fail_final):
            with self.assertRaises(OSError):
                execute(self.journal, self.request('install'), transport=self.transport)
        restarted = Journal(self.journal.root)
        self.assertEqual(execute(restarted, {'action': 'snapshot'})['pending'], 'install')
        result = execute(restarted, self.request('inspect'), transport=self.transport)
        self.assertEqual(result['activePairId'], PAIR)
        self.assertEqual(self.mutations, 1)

    def test_failed_generation_does_not_replace_candidate(self):
        before = self.prepare()
        with self.assertRaises(OSError):
            execute(self.journal, self.request('prepare', localUrl='wss://192.168.1.2/audio'),
                    generate=lambda *a: (_ for _ in ()).throw(OSError('secret')))
        self.assertEqual(execute(self.journal, {'action': 'snapshot'}), before)

    def test_process_death_releases_lock(self):
        ctx = multiprocessing.get_context('fork')
        ready = ctx.Event()
        def owner():
            with self.journal.locked():
                ready.set()
                import time
                time.sleep(20)
        child = ctx.Process(target=owner)
        child.start()
        try:
            self.assertTrue(ready.wait(3))
            with self.assertRaisesRegex(HostError, 'host_busy'):
                execute(self.journal, {'action': 'snapshot'})
        finally:
            child.kill(); child.join(3)
        self.assertFalse(child.is_alive())
        self.assertEqual(execute(self.journal, {'action': 'snapshot'})['revision'], 0)


if __name__ == '__main__':
    unittest.main()
