"""Regression for the guarded tail layout using the pinned IDF round-trip."""
import unittest

from audit_agent_layout import ROOT, TABLE_OFFSET, audit_layout, pinned_partition_tool
from review_agent_capacity import capacity


class LayoutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = pinned_partition_tool(ROOT/'work/esp-idf')

    def fixture(self, *, size=1900000, occupied_tail=False, test_slot=False):
        csv = ('nvs,data,nvs,0x9000,0x4000,\n'
               'otadata,data,ota,0xd000,0x2000,\n'
               'ota_0,app,ota_0,0x20000,0x4f0000,\n'
               'ota_1,app,ota_1,0x510000,0x4f0000,\n'
               'assets,data,0x82,0xa00000,0x400000,\n'
               'coredump,data,coredump,0xe00000,0x10000,\n')
        if test_slot:
            csv = csv.replace('assets,data,0x82,0xa00000,0x400000,',
                              'other,app,test,0xa00000,0x400000,')
        original = self.tool.PartitionTable.from_csv(csv)
        flash = bytearray(b'\xff' * 0x1000000)
        binary = original.to_binary()
        flash[TABLE_OFFSET:TABLE_OFFSET+len(binary)] = binary
        if occupied_tail:
            flash[0xe10000] = 0
        report = capacity(len(flash), [{'offset':hex(p.offset),'bytes':p.size} for p in original], size)
        report.update({key:'fixture' for key in ('profile','appVersion','backupSha256',
                                                'imageSha256','buildReceiptSha256')})
        return flash, report

    def test_preserves_all_rows_and_separates_agent_from_ota(self):
        flash, report = self.fixture()
        checked = audit_layout(flash, report, self.tool)
        self.assertEqual(checked['originalRowsPreserved'], 6)
        self.assertEqual(checked['proposedAdditions'][0]['subtype'], 0x20)
        self.assertEqual(checked['proposedAdditions'][1]['offset'], '0xffc000')
        self.assertFalse(checked['installable'])
        self.assertFalse(checked['partitionTableArtifactEmitted'])

    def test_rejects_oversize_and_undeclared_tail_data(self):
        for options, message in [({'size': 2015233}, 'does not fit'),
                                 ({'occupied_tail': True}, 'contains data')]:
            flash, report = self.fixture(**options)
            with self.assertRaisesRegex(ValueError, message):
                audit_layout(flash, report, self.tool)

    def test_rejects_duplicate_test_app_or_noncanonical_original_metadata(self):
        flash, report = self.fixture(test_slot=True)
        with self.assertRaisesRegex(ValueError, 'Only one test application'):
            audit_layout(flash, report, self.tool)
        flash, report = self.fixture()
        flash[0x8fff] = 0
        with self.assertRaisesRegex(ValueError, 'Original table is not reproduced'):
            audit_layout(flash, report, self.tool)


if __name__ == '__main__':
    unittest.main()
