"""Check the saved catalogue and OTA selection boundaries."""
import json
import struct
import unittest
from unittest.mock import patch
import zlib

from app_center_baseline import A, B, OTA, OWNER, AppCenterBaseline, owner_record
from prepare_agent_bundle import FLASH_SIZE, SECTOR, TABLE_OFFSET
from review_app_center_install import catalogue_entry, installation_scope


URL = 'https://catalogue.example.invalid/apps'
ID = 31337
DIGEST = 'ab'*32
ENTRY = {'id': ID, 'firmwareUrl': 'https://cdn.example.invalid/app.bin',
         'reopenImageSha256': DIGEST}


def ota_record(sequence, state):
    prefix = struct.pack('<I', sequence)
    return (prefix + b'\xff'*20 + struct.pack('<II', state, zlib.crc32(prefix, 0xffffffff))).ljust(SECTOR, b'\xff')


class CatalogueTests(unittest.TestCase):
    def test_both_envelope_shapes_and_upstream_download_alias(self):
        self.assertEqual(catalogue_entry(json.dumps([ENTRY]), URL, ID), DIGEST)
        alternative = {key: value for key, value in ENTRY.items() if key != 'firmwareUrl'}
        alternative['downloadUrl'] = ENTRY['firmwareUrl']
        self.assertEqual(catalogue_entry(json.dumps({'code': 0, 'data': [alternative]}), URL, ID), DIGEST)

    def test_reject_missing_or_ambiguous_entry_and_security_mismatch(self):
        cases = [
            ([ENTRY, ENTRY], URL), ([dict(ENTRY, id=True)], URL),
            ({'code': 1, 'data': [ENTRY]}, URL),
            ([dict(ENTRY, reopenImageSha256=DIGEST.upper())], URL),
            ([dict(ENTRY, firmwareUrl='http://cdn.example.invalid/app.bin')], URL),
            ([dict(ENTRY, firmwareUrl='https://user@cdn.example.invalid/app.bin')], URL),
            ([ENTRY], 'http://catalogue.example.invalid/apps'),
        ]
        for payload, source in cases:
            with self.subTest(payload=payload, source=source), self.assertRaises(ValueError):
                catalogue_entry(json.dumps(payload), source, ID)
        with self.assertRaisesRegex(ValueError, 'duplicate JSON'):
            catalogue_entry('[{"id":1,"id":31337}]', URL, ID)


class FootprintTests(unittest.TestCase):
    def setUp(self):
        self.data = bytearray(b'\xff'*FLASH_SIZE)
        self.table = bytes(self.data[TABLE_OFFSET:TABLE_OFFSET+SECTOR])
        self.candidate = b'x'*(SECTOR+1)

    def test_ota_record_address_does_not_follow_physical_slot_index(self):
        for factory_slot, sequence, active_sector, expected_app in [('ota_0', 3, 1, B), ('ota_1', 2, 0, A)]:
            with self.subTest(factory_slot=factory_slot):
                baseline = AppCenterBaseline(b'factory', factory_slot, sequence, active_sector, self.table)
                inactive = OTA + (1-active_sector)*SECTOR
                self.data[inactive:inactive+SECTOR] = ota_record(sequence-1, 4)
                report = installation_scope(self.data, baseline, self.candidate)
                self.assertEqual(report['entryPathFromSnapshot'], 'download')
                spans = {span['phase']: span for span in report['expectedWriteEnvelope']}
                self.assertEqual(spans['ota-begin']['start'], inactive)
                self.assertEqual(spans['select-boot']['start'], inactive)
                self.assertEqual(spans['ota-download']['start'], expected_app)
                self.assertEqual(spans['ota-download']['endExclusive'], expected_app + 2*SECTOR)
                self.assertEqual(spans['remember-shortcut']['rangeKind'], 'partition-envelope')
                self.assertIn('first-dsh-boot', spans)

    def test_exact_aborted_image_reopens_while_owned_storage_is_retained(self):
        baseline = AppCenterBaseline(b'factory', 'ota_1', 2, 1, self.table)
        self.data[OTA:OTA+SECTOR] = ota_record(3, 4)
        self.data[A:A+len(self.candidate)] = self.candidate
        self.data[OWNER:OWNER+SECTOR] = owner_record(self.table).ljust(SECTOR, b'\xff')
        with patch('review_app_center_install.inactive_image', return_value={'status': 'valid-image'}):
            report = installation_scope(self.data, baseline, self.candidate)
        self.assertEqual(report['entryPathFromSnapshot'], 'open')
        self.assertEqual(report['independentStorage'], 'owned')
        self.assertEqual([span['phase'] for span in report['expectedWriteEnvelope']],
                         ['select-boot', 'remember-shortcut'])
        self.assertFalse(report['replacesInactiveImage'])


if __name__ == '__main__':
    unittest.main()
