"""Exercise the install/recovery order with failure injection and no device I/O."""
from contextlib import redirect_stdout
from io import StringIO
import json
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

from check_agent_preflight import ReadSnapshot
from execute_agent_bundle import Flash, Plan, execute, load_plan, main, open_rom, run_stages, write_scope
from prepare_agent_bundle import APP_OFFSET, CONFIG_OFFSET, FLASH_SIZE, SECTOR, ImageWrite, prepare
from prepare_installation import sha


class SimulatedFlash:
    def __init__(self, data, after_write=None):
        self.data = bytearray(data)
        self.transfers = []
        self.after_write = after_write

    def read(self):
        self.transfers.append('read')
        return bytes(self.data)

    def write(self, step):
        self.transfers.append(step.file)
        self.data[step.offset:step.end] = step.payload
        if self.after_write:
            self.after_write(self.data, step)


class FlashExecutionTest(unittest.TestCase):
    def setUp(self):
        self.before = b'\xff' * FLASH_SIZE
        self.steps = (
            ImageWrite('app', APP_OFFSET, b'a' * SECTOR),
            ImageWrite('table', 0x8000, b't' * SECTOR),
            ImageWrite('selector', 0, b's' * SECTOR),
        )
        self.journal = Mock()

    def plan(self, before=None, steps=None, mode='install'):
        return Plan('01:02:03:04:05:06', self.before if before is None else before,
                    self.steps if steps is None else steps, {'operation': mode})

    def test_rom_requires_the_same_3v3_flash_configuration_as_the_reviewed_sion(self):
        unit = bytes.fromhex('010203040506')
        for registers, allowed in (((0, 0), True), ((0, 16), False), ((64, 0), False)):
            with self.subTest(registers=registers):
                rom = Mock(IS_STUB=False, EFUSE_VDD_SPI_REG=1, VDD_SPI_FORCE=64,
                           GPIO_STRAP_REG=2, GPIO_STRAP_VDDSPI_MASK=16)
                rom.get_security_info.return_value = {'chip_id': 9, 'flash_crypt_cnt': 0, 'parsed_flags': {
                    'SECURE_BOOT_EN': False, 'SECURE_DOWNLOAD_ENABLE': False,
                }}
                rom.get_chip_revision.return_value = 2
                rom.read_mac.return_value = unit
                rom.read_reg.side_effect = {1: registers[0], 2: registers[1]}.__getitem__
                commands = MagicMock()
                commands.connect_esp.return_value.__enter__.return_value = rom
                commands.detect_flash_size.return_value = '16MB'
                with patch.dict('sys.modules', {'esptool': SimpleNamespace(cmds=commands)}):
                    if allowed:
                        with open_rom('/dev/cu.usbmodem-test', unit.hex(':')) as flash:
                            self.assertIsInstance(flash, Flash)
                        commands.run_stub.assert_called_once_with(rom)
                    else:
                        with self.assertRaisesRegex(ValueError, '3.3 V Flash strap'):
                            with open_rom('/dev/cu.usbmodem-test', unit.hex(':')):
                                self.fail('Unexpected Flash connection')
                        commands.attach_flash.assert_not_called()
                        commands.run_stub.assert_not_called()

    def test_full_read_before_and_immediately_after_each_stage(self):
        flash = SimulatedFlash(self.before)
        run_stages(self.plan(), flash, self.journal)
        self.assertEqual(flash.transfers, ['read', 'app', 'read', 'table', 'read', 'selector', 'read'])
        self.journal.assert_called_with('all-stages-verified', sha256=sha(flash.data))

    def test_usb_selector_has_separate_plan_identity_and_rejects_grove_approval_before_io(self):
        args = SimpleNamespace(mode='install', baseline='original', recovery_base=None, bundle='review',
                               app=None, selector=None, idf=None, stock_idf=None, candidate='v35',
                               selector_variant='grove')
        mac = '01:02:03:04:05:06'
        manifest = {'savedBaselineSha256': sha(self.before), 'appVersion': 'dsh-agent-v35',
                    'applicationBuildReceiptSha256': 'app-receipt'}
        trial = dict(manifest, selectorVariant='usb-entry-experiment', selectorBuildReceiptSha256='trial-receipt')
        restore = (ImageWrite('restore-table', 0x8000, self.before[0x8000:0x9000]),
                   ImageWrite('restore-boot', 0, self.before[:SECTOR]))
        with patch('execute_agent_bundle.read_snapshot', return_value=ReadSnapshot(self.before, mac)), \
                patch('execute_agent_bundle.prepare', side_effect=[((*self.steps, *restore), manifest),
                                                                    ((*self.steps, *restore), trial)]), \
                patch('execute_agent_bundle.verify_materials'):
            grove = load_plan(args)
            args.selector_variant = 'usb-entry-experiment'
            usb = load_plan(args)
        self.assertNotIn('selectorVariant', grove.review)
        self.assertEqual(usb.review['selectorVariant'], args.selector_variant)
        self.assertNotEqual(grove.approval_id, usb.approval_id)
        with patch('execute_agent_bundle.open_rom') as open_rom:
            with self.assertRaisesRegex(ValueError, 'Approval ID must match'):
                execute(SimpleNamespace(approve=grove.approval_id), usb)
            open_rom.assert_not_called()

    def test_usb_selector_rejects_other_agent_versions_before_baseline_read(self):
        with self.assertRaisesRegex(ValueError, 'requires the v35'):
            prepare(None, None, None, None, None, candidate='v32', selector_variant='usb-entry-experiment')

    def test_changed_original_nvs_stops_before_any_write(self):
        flash = SimulatedFlash(self.before)
        flash.data[0x9000] ^= 1
        with self.assertRaisesRegex(ValueError, 'differs'):
            run_stages(self.plan(), flash, self.journal)
        self.assertEqual(flash.transfers, ['read'])
        self.assertEqual(self.journal.call_args.kwargs['changedRegions'][0]['region'], 'nvs')

    def test_wrong_bytes_inside_or_outside_span_stop_later_stages(self):
        for address in (APP_OFFSET, 0x9000, 0xd000, CONFIG_OFFSET):
            with self.subTest(address=hex(address)):
                flash = SimulatedFlash(self.before, lambda data, step: data.__setitem__(address, data[address] ^ 1))
                with self.assertRaisesRegex(ValueError, 'differs'):
                    run_stages(self.plan(), flash, self.journal)
                self.assertEqual(flash.transfers, ['read', 'app', 'read'])

    def test_interrupted_programming_retains_last_started_stage(self):
        def disconnect(data, step):
            if step.file == 'table':
                raise OSError('connection lost')

        flash = SimulatedFlash(self.before, disconnect)
        with self.assertRaisesRegex(OSError, 'connection lost'):
            run_stages(self.plan(), flash, self.journal)
        self.assertEqual(flash.transfers, ['read', 'app', 'read', 'table'])
        self.journal.assert_called_with('write-started', step='table')

    def test_recovery_skips_matching_table_and_leaves_later_data_alone(self):
        base = bytearray(self.before)
        base[0] = 23
        base[0x9000] = 9
        base[0xd000] = 7
        base[APP_OFFSET] = 42
        base[CONFIG_OFFSET] = 11
        writes = (ImageWrite('restore-table', 0x8000, b'\xff' * SECTOR),
                  ImageWrite('restore-boot', 0, b'\xff' * SECTOR))
        flash = SimulatedFlash(base)
        run_stages(self.plan(base, writes, 'restore'), flash, self.journal)
        self.assertEqual(flash.transfers, ['read', 'restore-boot', 'read'])
        base[0] = 0xff
        self.assertEqual(flash.data, base)

    def restore_plan(self, recovery):
        args = SimpleNamespace(mode='restore', baseline='original', recovery_base='current',
                               bundle='review', app=None, selector=None, idf=None, stock_idf=None, candidate='v24')
        mac = '01:02:03:04:05:06'
        snapshots = [ReadSnapshot(self.before, mac), ReadSnapshot(bytes(recovery), mac)]
        restore = (ImageWrite('restore-table', 0x8000, self.before[0x8000:0x9000]),
                   ImageWrite('restore-boot', 0, self.before[:SECTOR]))
        with patch('execute_agent_bundle.read_snapshot', side_effect=snapshots), \
                patch('execute_agent_bundle.prepare',
                      return_value=((*self.steps, *restore), {'savedBaselineSha256': sha(self.before)})), \
                patch('execute_agent_bundle.verify_materials'):
            return load_plan(args)

    def test_restore_plan_accepts_interruption_and_retains_current_configuration(self):
        recovery = bytearray(self.before)
        for address in (0, SECTOR - 1, 0x8fff, APP_OFFSET + SECTOR - 1, 0x9000, 0xe00000, CONFIG_OFFSET):
            recovery[address] = 0x11
        plan = self.restore_plan(recovery)
        self.assertEqual([x['region'] for x in plan.review['restoreRetainedDifferences']],
                         ['nvs', 'coredump', 'agent-config'])
        flash = SimulatedFlash(plan.before)
        run_stages(plan, flash, self.journal)
        for address in (APP_OFFSET + SECTOR - 1, 0x9000, 0xe00000, CONFIG_OFFSET):
            self.assertEqual(flash.data[address], 0x11)
        for address in (0, SECTOR - 1, 0x8fff):
            self.assertEqual(flash.data[address], 0xff)

    def test_restore_preview_refuses_unverified_stock_and_adjacent_sector_changes(self):
        for address, region in ((SECTOR, 'bootloader'), (0xd000, 'otadata'), (0xf000, 'phy_init'),
                                (0x11000, 'unallocated-gap'), (0x20000, 'ota_0'), (0x510000, 'ota_1'),
                                (0xa00000, 'assets'), (APP_OFFSET + SECTOR, 'agent-tail')):
            with self.subTest(region=region):
                recovery = bytearray(self.before)
                recovery[address] = 0x11
                with self.assertRaisesRegex(ValueError, 'Restore requires a new review .*' + region):
                    self.restore_plan(recovery)

    def test_scope_keeps_full_stage_spans_and_covers_the_whole_flash(self):
        plan = self.plan()
        scope = write_scope(plan)
        self.assertEqual(scope['sectorBytes'], SECTOR)
        self.assertEqual(scope['expectedEraseSectors'], 3)
        self.assertEqual(scope['stages'][0], {
            'file': 'app', 'offset': hex(APP_OFFSET), 'endExclusive': hex(APP_OFFSET + SECTOR),
            'sectorCount': 1, 'matchesStart': False,
        })
        edge = 0
        for region in scope['regions']:
            self.assertEqual(int(region['offset'], 16), edge)
            edge = int(region['endExclusive'], 16)
        self.assertEqual(edge, FLASH_SIZE)
        occupied = {row['region']: row['plannedWriteSectors'] for row in scope['regions']
                    if row['plannedWriteSectors']}
        self.assertEqual(occupied, {'bootloader': 1, 'partition-table': 1, 'agent-tail': 1})

    def test_scope_marks_already_matching_restore_stage_and_preserves_user_data(self):
        recovery = bytearray(self.before)
        for address in (0, APP_OFFSET, 0x9000, CONFIG_OFFSET):
            recovery[address] = 0x11
        plan = self.restore_plan(recovery)
        scope = write_scope(plan)
        self.assertEqual(scope['expectedEraseSectors'], 1)
        self.assertEqual([(row['file'],row['matchesStart']) for row in scope['stages']],
                         [('restore-table', True), ('restore-boot', False)])
        covered = {row['region']: row['plannedWriteSectors'] for row in scope['regions']}
        for name in ('agent-tail', 'agent-config', 'nvs', 'otadata', 'assets', 'ota_0', 'ota_1'):
            self.assertEqual(covered[name], 0, name)

    def test_scope_is_optional_offline_and_keeps_the_approval_id(self):
        plan = self.plan()
        args = ['execute', '--mode', 'install', '--baseline', 'saved', '--bundle', 'reviewed']
        outputs = []
        for options in ([], ['--scope']):
            output = StringIO()
            with patch('sys.argv', args + options), patch('execute_agent_bundle.load_plan', return_value=plan), \
                    patch('execute_agent_bundle.execute') as execute, redirect_stdout(output):
                main()
            execute.assert_not_called()
            outputs.append(json.loads(output.getvalue()))
        self.assertEqual(outputs[1].pop('writeScope'), write_scope(plan))
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0]['approvalId'], plan.approval_id)
        with patch('sys.argv', args + ['--scope', '--port', 'rom', '--approve', plan.approval_id, '--run', 'record']), \
                patch('execute_agent_bundle.load_plan') as load:
            with self.assertRaisesRegex(SystemExit, 'offline review only'):
                main()
        load.assert_not_called()

    def test_approval_changes_with_operation_and_unit(self):
        plan = self.plan()
        different_unit = Plan('01:02:03:04:05:07', plan.before, plan.writes, plan.review)
        self.assertNotEqual(plan.approval_id, self.plan(mode='restore').approval_id)
        self.assertNotEqual(plan.approval_id, different_unit.approval_id)

    def test_esptool_keeps_flash_header_and_reads_whole_chip(self):
        esp = object()
        commands = Mock()
        commands.read_flash.return_value = self.before
        flash = Flash(esp, commands)
        self.assertIs(flash.read(), self.before)
        commands.read_flash.assert_called_once_with(esp, 0, FLASH_SIZE, no_progress=True)
        flash.write(self.steps[0])
        commands.write_flash.assert_called_once_with(
            esp, [(APP_OFFSET, self.steps[0].payload)],
            flash_freq='keep', flash_mode='keep', flash_size='keep', no_progress=True,
        )
        commands.read_flash.return_value = b'truncated'
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            flash.read()


if __name__ == '__main__':
    unittest.main()
