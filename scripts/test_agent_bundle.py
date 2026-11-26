"""Regression checks for the offline sector plan and recovery invariants."""
from dataclasses import replace
import unittest

from prepare_agent_bundle import (
    APP_OFFSET, CONFIG_OFFSET, FLASH_SIZE, SECTOR, TABLE_OFFSET,
    ImageWrite, pad_sectors, rehearse,
)


class BundleRehearsalTest(unittest.TestCase):
    def setUp(self):
        self.baseline = bytes(FLASH_SIZE)
        self.agent = ImageWrite('agent', APP_OFFSET, pad_sectors(b'test-app'))
        self.table = ImageWrite('table', TABLE_OFFSET, b't' * SECTOR)
        self.boot = ImageWrite('selector', 0, b'b' * (6 * SECTOR))
        self.install = [self.agent, self.table, self.boot]
        self.restore = [
            replace(self.table, file='old-table', payload=self.baseline[self.table.offset:self.table.end]),
            replace(self.boot, file='old-boot', payload=self.baseline[:self.boot.end]),
        ]

    def test_three_interruptions_and_exact_programmed_sector_padding(self):
        installed, interrupted = rehearse(self.baseline, self.install, self.restore)
        self.assertEqual(interrupted, [w.file for w in self.install])
        self.assertEqual(installed[APP_OFFSET:APP_OFFSET+8], b'test-app')
        self.assertEqual(installed[APP_OFFSET+8:APP_OFFSET+SECTOR], b'\xff' * (SECTOR-8))
        self.assertEqual(installed[CONFIG_OFFSET:], self.baseline[CONFIG_OFFSET:])

    def test_reject_factory_overlap_and_off_by_one_at_nvs_boundary(self):
        with self.assertRaisesRegex(ValueError, 'Write outside'):
            rehearse(self.baseline, [self.agent, replace(self.table, offset=0xd000), self.boot], self.restore)
        with self.assertRaisesRegex(ValueError, 'Write outside'):
            rehearse(self.baseline, [replace(self.agent, payload=bytes(CONFIG_OFFSET-APP_OFFSET+1)),
                                    self.table, self.boot], self.restore)
        with self.assertRaisesRegex(ValueError, 'Recovery geometry'):
            rehearse(self.baseline, self.install, self.restore[::-1])

    def test_app_at_exact_config_boundary_keeps_entire_config_sector_range(self):
        full = replace(self.agent, payload=b'a' * (CONFIG_OFFSET - APP_OFFSET))
        installed, _ = rehearse(self.baseline, [full, self.table, self.boot], self.restore)
        self.assertEqual(installed[CONFIG_OFFSET - 1], ord('a'))
        self.assertEqual(installed[CONFIG_OFFSET:], self.baseline[CONFIG_OFFSET:])

    def test_reject_mixed_history_restore_payload(self):
        wrong = replace(self.restore[1], payload=b'x' + self.restore[1].payload[1:])
        with self.assertRaisesRegex(ValueError, 'Recovery bytes differ'):
            rehearse(self.baseline, self.install, [self.restore[0], wrong])


if __name__ == '__main__':
    unittest.main()
