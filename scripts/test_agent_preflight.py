"""Test the offline Flash comparison's decision boundaries."""
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import json
import subprocess
import sys
import unittest

from capture_agent_preflight import collect, run_read
from check_agent_preflight import ReadSnapshot, check, compare, expected_after, outcome, read_snapshot, verify_materials
from check_stock_nvs import NVS_SIZE, compare_stock_nvs, inspect_stock_nvs
from prepare_agent_bundle import APP_OFFSET, CONFIG_OFFSET, FLASH_SIZE, ImageWrite
from prepare_installation import sha


STOCK_SDK = Path(__file__).resolve().parents[1]/'work/esp-idf-stock-v5.5.4'
OLD_BLOB_FIXTURE = STOCK_SDK/'components/nvs_flash/nvs_partition_generator/part_old_blob_format.bin'


@unittest.skipUnless(OLD_BLOB_FIXTURE.is_file(), 'requires the pinned stock SDK')
class StockNvsCheckTest(unittest.TestCase):
    def test_sdk_reports_clean_data_without_returning_keys_or_values(self):
        partition = OLD_BLOB_FIXTURE.read_bytes().ljust(NVS_SIZE, b'\xff')
        self.assertEqual(inspect_stock_nvs(partition, STOCK_SDK), {
            'sdk': 'v5.5.4',
            'sdkCommit': '735507283d5b2f9fb363a1901172dbd9e847945d',
            'status': 'checked',
            'pages': 4,
            'emptyPages': 3,
            'writtenEntries': 13,
            'sdkAnomalyIndicators': 0,
            'sdkWarnings': {},
            'invalidPageStates': 0,
            'unsupportedVersionPages': 0,
        })

    def test_sdk_detects_corruption_in_header_and_written_entries(self):
        partition = OLD_BLOB_FIXTURE.read_bytes().ljust(NVS_SIZE, b'\xff')
        for offset in (4, 66, 90):
            with self.subTest(offset=offset):
                damaged = bytearray(partition)
                damaged[offset] ^= 1
                report = inspect_stock_nvs(damaged, STOCK_SDK)
                self.assertEqual(report['status'], 'issues-found')
                self.assertGreater(report['sdkAnomalyIndicators'], 0)

    def test_corrupted_page_state_is_flagged_even_when_header_crc_matches(self):
        partition = bytearray(OLD_BLOB_FIXTURE.read_bytes().ljust(NVS_SIZE, b'\xff'))
        partition[:4] = bytes(4)  # Page state is deliberately excluded from the CRC.
        report = inspect_stock_nvs(partition, STOCK_SDK)
        self.assertEqual(report['status'], 'issues-found')
        self.assertEqual(report['invalidPageStates'], 1)

    def test_erased_partition_is_not_evidence_of_saved_preferences(self):
        report = inspect_stock_nvs(b'\xff' * NVS_SIZE, STOCK_SDK)
        self.assertEqual(report['status'], 'no-written-entries')
        self.assertEqual(report['writtenEntries'], 0)
        self.assertEqual(report['emptyPages'], 4)
        empty = b'\xff' * NVS_SIZE
        self.assertEqual(compare_stock_nvs(empty, empty, STOCK_SDK)['status'], 'inconclusive')

    @unittest.skipUnless(find_spec('esp_idf_nvs_partition_gen'), 'requires the ESP-IDF NVS partition generator')
    def test_opt_in_autostart_checks_only_the_stock_boolean(self):
        cases = [('boot_ai,data,u8,1', 'enabled'), ('boot_ai,data,u8,0', 'disabled'),
                 ('boot_ai,data,u8,2', 'unknown'), ('boot_ai,data,u16,1', 'unknown'),
                 ('unrelated,data,u8,1', 'not-recorded')]
        with TemporaryDirectory() as directory:
            source = Path(directory)/'settings.csv'
            binary = Path(directory)/'settings.bin'
            for row, expected in cases:
                with self.subTest(row=row):
                    source.write_text('key,type,encoding,value\nxiaozhi,namespace,,\n'+row+'\n')
                    subprocess.run([sys.executable, '-m', 'esp_idf_nvs_partition_gen', 'generate',
                                    str(source), str(binary), hex(NVS_SIZE)],
                                   capture_output=True, check=True, timeout=10)
                    data = binary.read_bytes()
                    report = inspect_stock_nvs(data, STOCK_SDK, check_ai_autostart=True)
                    self.assertEqual(report['savedAiAutostart'], expected)
                    self.assertNotIn('savedAiAutostart', inspect_stock_nvs(data, STOCK_SDK))

    def test_comparison_allows_page_relocation_but_rejects_inconsistent_pages(self):
        partition = OLD_BLOB_FIXTURE.read_bytes().ljust(NVS_SIZE, b'\xff')
        moved = partition[4096:] + partition[:4096]
        result = compare_stock_nvs(partition, moved, STOCK_SDK)
        self.assertEqual(result['status'], 'same-live-settings')
        self.assertFalse(result['rawBytesMatch'])
        damaged = bytearray(moved)
        damaged[-4096:-4092] = bytes(4)
        result = compare_stock_nvs(partition, damaged, STOCK_SDK)
        self.assertEqual(result['status'], 'inconclusive')

    @unittest.skipUnless(find_spec('esp_idf_nvs_partition_gen'), 'requires the ESP-IDF NVS partition generator')
    def test_comparison_protects_values_and_redacts_private_names(self):
        marker = 'private-test-value'
        record = '12'*32 + ('ab'*32).encode().hex()
        pref = 'feature_toggles,namespace,,\ndsh_visible,data,u8,1\n'
        shortcut = 'app_dsh_menu,namespace,,\nlaunch_v1,data,hex2bin,'+record+'\n'
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source, binary = root/'settings.csv', root/'settings.bin'

            def generate(voice, extra=''):
                payload = ('key,type,encoding,value\n'
                           'private-test,namespace,,\n'
                           f'voice,data,string,{voice}\n'
                           'state,data,hex2bin,'+'ab'*4500+'\n')
                source.write_text(payload+extra)
                subprocess.run([sys.executable, '-m', 'esp_idf_nvs_partition_gen', 'generate',
                                str(source), str(binary), hex(NVS_SIZE)],
                               capture_output=True, check=True, timeout=10)
                return binary.read_bytes()

            before = generate(marker)
            enrolled = generate(marker, shortcut+pref)
            matching = compare_stock_nvs(before, enrolled, STOCK_SDK)
            self.assertEqual(matching['status'], 'only-shortcut-settings-changed')
            self.assertEqual(matching['managedKeysChanged'], ['app_dsh_menu/launch_v1', 'feature_toggles/dsh_visible'])
            protected = compare_stock_nvs(before, generate('replacement', shortcut), STOCK_SDK)
            self.assertEqual(protected['status'], 'needs-review')
            self.assertEqual(protected['otherKeysChanged'], 1)
            self.assertNotIn('private-test', json.dumps(protected))
            invalid = compare_stock_nvs(before, generate(marker, pref.replace('u8,1', 'u8,2')), STOCK_SDK)
            self.assertEqual(invalid['status'], 'needs-review')
            self.assertEqual(invalid['managedKeysInvalid'], ['feature_toggles/dsh_visible'])


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self.before = bytes(FLASH_SIZE)

    def differences(self, *locations):
        observed = bytearray(self.before)
        for location in locations:
            observed[location] = 1
        return compare(self.before, observed)

    def test_changed_settings_require_new_review(self):
        changes = self.differences(0x9000, 0x9fff, 0xa000, 0xe00000)
        self.assertEqual([(x['region'], x['changedSectors']) for x in changes], [('nvs', 2), ('coredump', 1)])
        self.assertEqual(outcome(changes, 0, 'install'), 'saved-data-changed-rebuild-review')
        self.assertEqual(outcome(changes, 1, 'install'), 'readback-mismatch-stop')

    def test_changes_to_ota_boot_or_protected_but_unallocated_bytes_stop(self):
        for location in (0, 0x8000, 0xd000, 0x20000, 0x510000):
            self.assertEqual(outcome(self.differences(location), 0, 'install'),
                             'boot-layout-or-ota-changed-stop')
        for location in (APP_OFFSET, CONFIG_OFFSET, FLASH_SIZE-1):
            self.assertEqual(outcome(self.differences(location), 0, 'install'), 'tail-not-original-stop')
        self.assertEqual(self.differences(0x1ffff)[0]['region'], 'unallocated-gap')
        self.assertEqual(outcome(self.differences(0xa00000), 0, 'install'), 'unexpected-original-content-stop')

    def test_completed_stage_only_and_restore_uses_current_base(self):
        steps = [ImageWrite('agent', APP_OFFSET, b'x'), ImageWrite('table', 0x8000, b'y')]
        partial = expected_after(self.before, steps, 1)
        self.assertEqual(compare(partial, expected_after(self.before, steps, 1)), [])
        self.assertEqual(compare(partial, expected_after(self.before, steps, 2))[0]['region'], 'partition-table')
        with self.assertRaisesRegex(ValueError, 'Stage does not exist'):
            expected_after(self.before, steps, 3)
        recovery = bytearray(partial)
        recovery[0x9000] = 99
        reboot = expected_after(recovery, [ImageWrite('restore table', 0x8000, b'\x00')], 1)
        self.assertEqual(reboot[0x9000], 99)

    def test_agent_use_allows_only_independent_config_without_relaxing_stage_readback(self):
        steps = [ImageWrite('agent', APP_OFFSET, b'x'), ImageWrite('table', 0x8000, b'y'),
                 ImageWrite('boot', 0, b'z')]
        installed = expected_after(self.before, steps, 3)
        manifest = {'savedBaselineSha256': sha(self.before)}
        args = SimpleNamespace(historical=None, observed=None, bundle=None, app=None, selector=None,
                               idf=None, stock_idf=None, recovery_base=None, candidate='v35',
                               mode='install', stage=3, after_agent_use=True)
        address = '01:02:03:04:05:06'
        with patch('check_agent_preflight.prepare', return_value=(steps, manifest)), \
                patch('check_agent_preflight.verify_materials'), \
                patch('check_agent_preflight.read_snapshot') as read:
            for offset in (None, CONFIG_OFFSET, 0x9000, 0xd000, 0x20000, 0x510000,
                           0xa00000, 0xe00000, APP_OFFSET, 0x8000, 0, 0x1ffff):
                with self.subTest(offset=offset):
                    observed = installed.copy()
                    if offset is not None:
                        observed[offset] ^= 1
                    read.side_effect = [ReadSnapshot(self.before, address), ReadSnapshot(observed, address)]
                    report = check(args)
                    expected_match = offset in (None, CONFIG_OFFSET)
                    self.assertEqual(report['protectedBytesMatch'], expected_match)
                    self.assertEqual(report['exactExpectedBytes'], offset is None)
                    self.assertFalse(report['physicalRuntimeProven'])
                    self.assertFalse(report['flashAuthorized'])
            installed[CONFIG_OFFSET] ^= 1
            read.side_effect = [ReadSnapshot(self.before, address), ReadSnapshot(installed, address)]
            args.after_agent_use = False
            report = check(args)
            self.assertEqual(report['result'], 'readback-mismatch-stop')
            self.assertNotIn('protectedBytesMatch', report)

    def test_agent_use_mode_rejects_preflight_and_restore_before_reading(self):
        with patch('check_agent_preflight.read_snapshot') as read:
            for mode, stage in (('install', 0), ('install', 2), ('restore', 3)):
                with self.subTest(mode=mode, stage=stage), self.assertRaisesRegex(ValueError, 'three-stage'):
                    check(SimpleNamespace(mode=mode, stage=stage, after_agent_use=True))
            read.assert_not_called()

    def test_stock_return_compares_against_verified_after_agent_snapshot(self):
        steps = [ImageWrite('agent', APP_OFFSET, b'x'), ImageWrite('table', 0x8000, b'y'),
                 ImageWrite('boot', 0, b'z')]
        before_return = expected_after(self.before, steps, 3)
        before_return[CONFIG_OFFSET] ^= 1
        manifest = {'savedBaselineSha256': sha(self.before)}
        args = SimpleNamespace(historical=Path('stock'), observed=Path('after-stock'), bundle=None,
                               stock_return_base=Path('after-agent'), app=None, selector=None, idf=None,
                               stock_idf=None, recovery_base=None, candidate='v35', mode='install', stage=3)
        address = '01:02:03:04:05:06'
        with patch('check_agent_preflight.prepare', return_value=(steps, manifest)), \
                patch('check_agent_preflight.verify_materials'), \
                patch('check_agent_preflight.read_snapshot') as read:
            for offset in (None, 0x9000, 0xd000, 0x20000, 0x510000, 0xa00000, 0xe00000, CONFIG_OFFSET, 0):
                with self.subTest(offset=offset):
                    observed = before_return.copy()
                    if offset is not None:
                        observed[offset] ^= 1
                    read.side_effect = [ReadSnapshot(self.before, address), ReadSnapshot(observed, address),
                                        ReadSnapshot(before_return, address)]
                    report = check(args)
                    self.assertEqual(report['protectedBytesMatch'], offset in (None, 0x9000))
                    self.assertEqual(report['exactExpectedBytes'], offset is None)
                    self.assertFalse(report['snapshotFreshnessProven'])
                    self.assertFalse(report['physicalRuntimeProven'])
                    self.assertFalse(report['flashAuthorized'])

            before_return[0xd000] ^= 1
            read.side_effect = [ReadSnapshot(self.before, address), ReadSnapshot(before_return, address),
                                ReadSnapshot(before_return, address)]
            with self.assertRaisesRegex(ValueError, 'differs outside the independent configuration'):
                check(args)
            read.side_effect = [ReadSnapshot(self.before, address), ReadSnapshot(before_return, address),
                                ReadSnapshot(before_return, '00:00:00:00:00:00')]
            with self.assertRaisesRegex(ValueError, 'baseline identifies a different unit'):
                check(args)

    def test_stock_return_rejects_ambiguous_snapshot_roles_before_reading(self):
        defaults = dict(mode='install', stage=3, historical=Path('stock'), stock_return_base=Path('after-agent'),
                        observed=Path('after-stock'), after_agent_use=False)
        cases = [({'mode': 'restore'}, 'three-stage'), ({'stage': 2}, 'three-stage'),
                 ({'after_agent_use': True}, 'Choose either'), ({'observed': Path('after-agent')}, 'distinct')]
        with patch('check_agent_preflight.read_snapshot') as read:
            for changes, message in cases:
                with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                    check(SimpleNamespace(**(defaults | changes)))
            read.assert_not_called()

    def test_probe_transcripts_cannot_mix_units_or_replace_complete_reads(self):
        with TemporaryDirectory() as d:
            p = Path(d)
            for name in ('flash-A.bin', 'flash-B.bin'):
                (p/name).write_bytes(self.before)
            (p/'verification.json').write_text(json.dumps({
                'bytes': FLASH_SIZE, 'sha256': sha(self.before), 'identical': True, 'flashWritten': False,
            }))
            probe = 'MAC: 01:02:03:04:05:06\nChip type: ESP32-S3 (revision v0.2)\n'
            (p/'flash-id.txt').write_text(probe+'Detected flash size: 16MB\n')
            (p/'security-info.txt').write_text(probe+'Chip ID: 9\nSecure Boot: Disabled\nFlash Encryption: Disabled\n')
            read = probe+'Read 16777216 bytes from 0x00000000 in 1s.\n'
            for name in ('read-A.log', 'read-B.log'):
                (p/name).write_text(read)
            self.assertEqual(read_snapshot(p).data, self.before)
            (p/'read-B.log').write_text(read.replace('05:06', '05:07'))
            with self.assertRaisesRegex(ValueError, 'same device'):
                read_snapshot(p)
            (p/'read-B.log').write_text(read.replace('16777216', '16777215'))
            with self.assertRaisesRegex(ValueError, 'two full reads'):
                read_snapshot(p)

    def test_checked_payload_must_match_regenerated_material_even_if_manifest_is_unchanged(self):
        with TemporaryDirectory() as d:
            p = Path(d)
            manifest = {'flashAuthorized': False}
            (p/'manifest.json').write_text(json.dumps(manifest))
            item = ImageWrite('restore-1-partitions.bin', 0x8000, b'expected')
            (p/item.file).write_bytes(item.payload)
            verify_materials(p, [item], manifest)
            (p/item.file).write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'differs from regenerated'):
                verify_materials(p, [item], manifest)


    def test_capture_subprocess_uses_only_allowlisted_reads_and_no_reset(self):
        with TemporaryDirectory() as d, patch('capture_agent_preflight.subprocess.run',
                                               return_value=SimpleNamespace(returncode=0)) as process:
            p = Path(d)
            port = '/dev/cu.usbmodem-test'
            run_read(port, p, 'probe.log', 'get-security-info')
            run_read(port, p, 'read.log', 'read-flash', '0', str(FLASH_SIZE), 'flash-A.bin')
            with self.assertRaisesRegex(ValueError, 'Unsupported capture operation'):
                run_read(port, p, 'refused.log', 'write-flash', '0', 'test')
            self.assertEqual(process.call_count, 2)
            for call in process.call_args_list:
                argv = call.args[0]
                self.assertEqual(argv[argv.index('--before')+1], 'no-reset')
                self.assertEqual(argv[argv.index('--after')+1], 'no-reset')
                self.assertEqual(call.kwargs['env']['ESPTOOL_OPEN_PORT_ATTEMPTS'], '1')
            self.assertIn('--no-stub', process.call_args_list[0].args[0])

    def test_capture_refuses_wrong_unit_before_dumping_flash(self):
        with TemporaryDirectory() as d:
            p = Path(d)
            probe = 'MAC: 01:02:03:04:05:06\nChip type: ESP32-S3 (revision v0.2)\n'
            (p/'flash-id.txt').write_text(probe+'Detected flash size: 16MB\n')
            (p/'security-info.txt').write_text(probe+'Chip ID: 9\nSecure Boot: Disabled\nFlash Encryption: Disabled\n')
            with patch('capture_agent_preflight.run_read') as runner:
                with self.assertRaisesRegex(ValueError, 'Connected unit differs'):
                    collect('/dev/cu.usbmodem-test', p, '01:02:03:04:05:07')
                self.assertEqual([call.args[3] for call in runner.call_args_list],
                                 ['get-security-info', 'flash-id'])
                self.assertFalse((p/'verification.json').exists())
            with patch('capture_agent_preflight.run_read') as runner:
                for copy in 'AB':
                    (p/f'flash-{copy}.bin').write_bytes(self.before)
                    (p/f'read-{copy}.log').write_text(probe+'Read 16777216 bytes from 0x00000000 in 1s.\n')
                collect('/dev/cu.usbmodem-test', p, '01:02:03:04:05:06')
                self.assertEqual(runner.call_count, 4)
                self.assertEqual(read_snapshot(p).data, self.before)


if __name__ == '__main__':
    unittest.main()
