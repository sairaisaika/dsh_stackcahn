"""Check the distinct App Center and direct USB staged-recovery boundaries."""
import unittest
from unittest.mock import Mock, patch

from app_center_baseline import A, OTA, OWNER, AppCenterBaseline, owner_record
from check_agent_preflight import ReadSnapshot
from execute_agent_bundle import run_stages
from execute_stock_trial import restore_plan
from ota_record import OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, ota_record
from prepare_agent_bundle import CONFIG_OFFSET, EXPECTED_PARTITIONS, FLASH_SIZE, SECTOR
from review_app_center_recovery import plan_recovery
from test_execute_agent_bundle import SimulatedFlash


class StockTrialRecovery(unittest.TestCase):
    def setUp(self):
        self.baseline = AppCenterBaseline(b'confirmed factory', 'ota_1', 2, 1, b'reviewed table')
        self.before = bytearray(b'\xff'*FLASH_SIZE)
        self.before[OTA:OTA+32] = ota_record(3, OTA_ABORTED)
        self.before[OTA+SECTOR:OTA+SECTOR+32] = ota_record(2, OTA_VALID)
        self.before[A:A+3*SECTOR] = b'X'*(3*SECTOR)
        self.candidate = b'A'*SECTOR + b'B'*SECTOR + b'C'*SECTOR
        fake = patch('review_app_center_recovery.review_app_center', return_value=self.baseline)
        fake.start()
        self.addCleanup(fake.stop)

    def review(self, observed, *, stock_trial=True):
        return plan_recovery(self.before, observed, self.candidate, stock_trial=stock_trial)

    def staged(self):
        device = self.before.copy()
        device[A:A+len(self.candidate)] = self.candidate
        return device

    def test_stage_before_select_keeps_the_default_app_center_check_strict(self):
        self.before[OTA:OTA+32] = ota_record(1, OTA_ABORTED)
        observed = self.staged()
        with self.assertRaisesRegex(ValueError, 'record still matches the original'):
            self.review(observed, stock_trial=False)
        report = self.review(observed)
        self.assertFalse(report['flashAuthorized'])
        self.assertEqual(report['installationMethod'], 'stock-trial')
        self.assertEqual(report['restoreSpans'], [{'region': 'ota_0', 'start': A, 'endExclusive': A+3*SECTOR}])

    def test_interrupted_stage_and_interrupted_restore(self):
        observed = self.before.copy()
        observed[A:A+32] = self.candidate[:32]
        observed[A+32:A+3*SECTOR] = b'\xff'*(3*SECTOR-32)
        self.assertEqual(self.review(observed)['restoreSpans'][0]['start'], A)
        observed = self.staged()
        observed[A:A+SECTOR] = self.before[A:A+SECTOR]
        report = self.review(observed)
        self.assertEqual(report['restoreSpans'], [{'region': 'ota_0', 'start': A+SECTOR, 'endExclusive': A+3*SECTOR}])
        observed[A+SECTOR+10] ^= 1
        with self.assertRaisesRegex(ValueError, 'sequential partial write'):
            self.review(observed)

    def test_torn_selection_requires_the_entire_staged_application(self):
        observed = self.staged()
        observed[OTA:OTA+SECTOR] = ota_record(3, OTA_NEW)[:28].ljust(SECTOR, b'\xff')
        review = self.review(observed)
        self.assertEqual(review['inactiveRecordState'], 'candidate-selection-interrupted')
        self.assertEqual([entry['start'] for entry in review['restoreSpans']], [A, OTA])
        with self.assertRaisesRegex(ValueError, 'unrecognized sequence'):
            self.review(observed, stock_trial=False)
        observed[A:A+SECTOR] = self.before[A:A+SECTOR]
        with self.assertRaisesRegex(ValueError, 'reviewed complete image'):
            self.review(observed)

    def test_complete_selection_returns_no_write_spans_before_factory_returns(self):
        for state in (OTA_NEW, OTA_PENDING_VERIFY):
            with self.subTest(state=state):
                observed = self.staged()
                observed[OTA:OTA+32] = ota_record(3, state)
                report = self.review(observed)
                self.assertEqual(report['status'], 'await-confirmed-factory-readback')
                self.assertEqual(report['restoreSpans'], [])

    def test_preserves_original_settings_and_live_independent_data(self):
        observed = self.staged()
        # At Home the candidate's ABORTED record can equal the original bytes.
        owned = owner_record(self.baseline.table)
        observed[OWNER:OWNER+len(owned)] = owned
        observed[CONFIG_OFFSET] = 0
        observed[EXPECTED_PARTITIONS['nvs'][2]] = 0
        report = self.review(observed)
        self.assertEqual(report['inactiveRecordState'], 'staged-or-returned')
        self.assertEqual(report['preserveChangedRegions'], ['nvs', 'sion_cfg'])
        self.assertEqual([entry['region'] for entry in report['restoreSpans']], ['ota_0'])
        observed[0x510000] ^= 1
        with self.assertRaisesRegex(ValueError, 'Unreviewed Flash changes'):
            self.review(observed)

    def test_rom_cancellation_verifies_restored_selector_before_touching_application(self):
        observed = self.staged()
        observed[OTA:OTA+32] = ota_record(3, OTA_PENDING_VERIFY)
        owner = owner_record(self.baseline.table)
        observed[OWNER:OWNER+len(owner)] = owner
        observed[CONFIG_OFFSET] = 0
        same_device = '01:02:03:04:05:06'
        before = ReadSnapshot(bytes(self.before), same_device)
        current = ReadSnapshot(bytes(observed), same_device)
        with patch('review_app_center_recovery.reviewed_candidate', return_value=self.candidate), \
                patch('execute_stock_trial.review_app_center', return_value=self.baseline):
            with self.assertRaisesRegex(ValueError, 'Return to the confirmed factory'):
                restore_plan(before, current, None)
            plan = restore_plan(before, current, None, cancel_selection=True)
        self.assertEqual([write.offset for write in plan.writes], [OTA, A])

        flash = SimulatedFlash(observed)
        run_stages(plan, flash, Mock())
        self.assertEqual(flash.transfers, ['read', 'cancel-trial-selection', 'read', 'restore-ota_0-20000', 'read'])
        self.assertEqual(flash.data[:OWNER], self.before[:OWNER])
        self.assertEqual(flash.data[OWNER:], observed[OWNER:])

        def damage_confirmed_record(data, _step):
            data[OTA+SECTOR] ^= 1

        faulty = SimulatedFlash(observed, damage_confirmed_record)
        with self.assertRaisesRegex(ValueError, 'Whole-Flash read differs'):
            run_stages(plan, faulty, Mock())
        self.assertEqual(faulty.transfers, ['read', 'cancel-trial-selection', 'read'])

    def test_refuses_originally_bootable_inactive_record(self):
        self.before[OTA:OTA+32] = ota_record(1, OTA_VALID)
        with self.assertRaisesRegex(ValueError, 'explicitly retired inactive record'):
            self.review(self.staged())
