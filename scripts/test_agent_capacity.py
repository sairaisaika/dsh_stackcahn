"""Capacity boundaries only; image/backup validation is separately exercised offline."""
import unittest
import tempfile
import hashlib
import json
from pathlib import Path
from unittest.mock import patch
from review_agent_capacity import capacity, review


class CapacityTests(unittest.TestCase):
    def test_partition_inspection_must_match_the_validated_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = b'saved snapshot'
            for name in ('flash-A.bin', 'flash-B.bin'):
                (root/name).write_bytes(payload)
            (root/'verification.json').write_text(json.dumps({'sha256': hashlib.sha256(payload).hexdigest()}))
            with patch('review_agent_capacity.inspect', return_value={'sha256': 'changed', 'bytes': len(payload)}):
                with self.assertRaisesRegex(ValueError, 'changed during partition inspection'):
                    review(root, root, root/'unused-receipt.json')

    def plan(self, size, end=0xe10000):
        return capacity(0x1000000, [{'offset': '0x9000', 'bytes': end-0x9000}], size)

    def test_config_and_sector_rounding_not_just_raw_image_size(self):
        result = self.plan(2082912)
        self.assertEqual(result['availableAppBytes'], 2015232)
        self.assertEqual(result['requiredAppBytes'], 2084864)
        self.assertEqual(result['remainingBytes'], -69632)
        self.assertFalse(result['fitsCurrentImage'])

    def test_exact_fit_still_never_authorizes_installation(self):
        for size, fits in [(2015231, True), (2015232, True), (2015233, False)]:
            result = self.plan(size)
            self.assertEqual(result['fitsCurrentImage'], fits)
            for flag in ('installable', 'partitionTableGenerated', 'bootSelectorGenerated', 'deviceAccess'):
                self.assertFalse(result[flag])
            self.assertTrue(result['unresolved'])

    def test_app_start_alignment_and_no_remaining_tail(self):
        result = self.plan(4096, 0xe11000)
        self.assertEqual(result['provisionalAppStart'], '0xe20000')
        self.assertEqual(result['availableAppBytes'], 0x1dc000)
        self.assertFalse(self.plan(4096, 0x1000000)['fitsCurrentImage'])

    def test_invalid_geometry_is_not_a_report(self):
        for size in (0, -1, True, 0x1000001):
            with self.assertRaises(ValueError): self.plan(size)
        for partitions in ([], [{'offset': '0xffff00', 'bytes': 4096}],
                           [{'offset': '0x9000', 'bytes': 4096}, {'offset': '0x9800', 'bytes': 4096}]):
            with self.assertRaises(ValueError): capacity(0x1000000, partitions, 4096)
        with self.assertRaises(ValueError): capacity(0x800000, [{'offset': '0x9000', 'bytes': 4096}], 4096)


if __name__ == '__main__': unittest.main()
