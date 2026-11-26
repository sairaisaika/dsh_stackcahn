"""Review or execute the selected reviewed Sion stages through one ROM connection."""
import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from dataclasses import dataclass
import fcntl
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import stat
import sys
import traceback

from check_agent_preflight import (
    ROOT, compare, flash_regions, read_snapshot, restore_retained_changes, verify_materials,
)
from prepare_agent_bundle import FLASH_SIZE, SECTOR, ImageWrite, candidate_option, prepare, selector_option, validate_writes
from prepare_installation import sha
from review_agent_capacity import require


@dataclass(frozen=True)
class Plan:
    unit_mac: str
    before: bytes
    writes: tuple[ImageWrite, ...]
    review: dict

    @property
    def approval_id(self):
        review = json.dumps(self.review, sort_keys=True, separators=(',', ':')).encode()
        return sha(bytes.fromhex(self.unit_mac.replace(':', '')) + review)


def load_plan(args):
    baseline = read_snapshot(args.baseline)
    selector_variant = getattr(args, 'selector_variant', 'grove')
    items, manifest = prepare(args.baseline, args.app, args.selector, args.idf, args.stock_idf,
                              candidate=args.candidate, selector_variant=selector_variant)
    require(manifest['savedBaselineSha256'] == sha(baseline.data),
            'Original snapshot changed during review')
    verify_materials(args.bundle, items, manifest)
    install, restore = items[:3], items[3:]
    validate_writes(install, restore)
    start = baseline
    writes = install
    retained = None
    if args.mode == 'restore':
        require(args.recovery_base is not None, 'Restore requires a current verified double read')
        start = read_snapshot(args.recovery_base)
        require(start.mac == baseline.mac, 'Restore snapshot belongs to a different unit')
        retained = restore_retained_changes(baseline.data, start.data, install)
        writes = restore
    else:
        require(args.recovery_base is None, 'A recovery snapshot is only used for restore')

    review = {
        'schema': 1,
        'operation': args.mode,
        'expectedStartSha256': sha(start.data),
        'originalSnapshotSha256': manifest['savedBaselineSha256'],
        'steps': [step.record(start.data) for step in writes],
        'automaticReset': False,
        'automaticRecovery': False,
    }
    if retained is not None:
        review['restoreRetainedDifferences'] = retained
    # The original v24 plan had no version field. Preserve its issued ID.
    if args.candidate != 'v24':
        review['applicationVersion'] = manifest['appVersion']
        review['applicationBuildReceiptSha256'] = manifest['applicationBuildReceiptSha256']
    if selector_variant != 'grove':
        review['selectorVariant'] = manifest['selectorVariant']
        review['selectorBuildReceiptSha256'] = manifest['selectorBuildReceiptSha256']
    return Plan(start.mac, start.data, tuple(writes), review)


def write_scope(plan):
    """Describe a validated plan against its saved start, in whole Flash sectors."""
    stages = []
    for step in plan.writes:
        matches = plan.before[step.offset:step.end] == step.payload
        stages.append({
            'file': step.file,
            'offset': hex(step.offset),
            'endExclusive': hex(step.end),
            'sectorCount': len(step.payload) // SECTOR,
            'matchesStart': matches,
        })
    regions = []
    for start, end, name in flash_regions():
        covered = sum(max(0, min(end, step.end) - max(start, step.offset))
                      for step in plan.writes)
        regions.append({'region': name, 'offset': hex(start), 'endExclusive': hex(end),
                        'plannedWriteSectors': covered // SECTOR})
    return {
        'sectorBytes': SECTOR,
        'flashBytes': FLASH_SIZE,
        'expectedEraseSectors': sum(stage['sectorCount'] for stage in stages if not stage['matchesStart']),
        'stages': stages,
        'regions': regions,
    }


class Flash:
    def __init__(self, esp, commands):
        self.esp = esp
        self.commands = commands

    def read(self):
        data = self.commands.read_flash(self.esp, 0, FLASH_SIZE, no_progress=True)
        require(isinstance(data, bytes) and len(data) == FLASH_SIZE, 'Incomplete full Flash read')
        return data

    def write(self, step):
        self.commands.write_flash(
            self.esp, [(step.offset, step.payload)],
            flash_freq='keep', flash_mode='keep', flash_size='keep', no_progress=True,
        )


@contextmanager
def open_rom(port, unit_mac):
    from esptool import cmds

    with cmds.connect_esp(port=port, chip='esp32s3', before='no-reset',
                          connect_attempts=1, open_port_attempts=1) as rom:
        info = rom.get_security_info()
        flags = info['parsed_flags']
        require(info['chip_id'] == 9 and rom.get_chip_revision() == 2 and not rom.IS_STUB,
                'Expected ESP32-S3 rev v0.2 in ROM download mode')
        require(not flags['SECURE_BOOT_EN'] and not flags['SECURE_DOWNLOAD_ENABLE'] and
                info['flash_crypt_cnt'].bit_count() % 2 == 0,
                'Current security mode differs from the reviewed profile')
        require(bytes(rom.read_mac('BASE_MAC')).hex(':') == unit_mac,
                'Connected unit differs from the reviewed device')
        # esptool 5.6.0 derives the ESP32-S3 Flash setting from the latched
        # strap unless forced by eFuse. This Sion was reviewed at 3.3 V.
        forced = rom.read_reg(rom.EFUSE_VDD_SPI_REG) & rom.VDD_SPI_FORCE
        low_voltage = rom.read_reg(rom.GPIO_STRAP_REG) & rom.GPIO_STRAP_VDDSPI_MASK
        require(not forced and not low_voltage, 'Expected the reviewed 3.3 V Flash strap before any write')
        cmds.attach_flash(rom)
        require(cmds.detect_flash_size(rom) == '16MB', 'Current Flash capacity differs from the review')
        stub = cmds.run_stub(rom)
        stub.change_baud(921600)
        cmds.attach_flash(stub)
        yield Flash(stub, cmds)


def verify(expected, data, journal, event, step=None):
    changes = compare(expected, data)
    journal(event, step=step, sha256=sha(data), changedRegions=changes)
    require(not changes, 'Whole-Flash read differs from the expected stage')


def run_stages(plan, flash, journal):
    expected = bytearray(plan.before)
    observed = flash.read()
    verify(expected, observed, journal, 'initial-read')
    for step in plan.writes:
        expected[step.offset:step.end] = step.payload
        if expected == observed:
            journal('already-matched', step=step.file, sha256=sha(observed))
            continue
        journal('write-started', step=step.file)
        flash.write(step)
        observed = flash.read()
        verify(expected, observed, journal, 'readback', step.file)
    journal('all-stages-verified', sha256=sha(observed))


def execute(args, plan):
    require(args.approve == plan.approval_id, 'Approval ID must match the reviewed plan')
    require(re.fullmatch(r'/dev/cu\.usb(?:modem|serial)[A-Za-z0-9._-]+', args.port) and
            not Path(args.port).is_symlink() and stat.S_ISCHR(Path(args.port).stat().st_mode),
            'Select the already identified Mac USB serial device in ROM mode')
    require(version('esptool') == '5.6.0', 'Use the reviewed esptool 5.6.0 environment')
    require(args.run and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', args.run),
            'Pass a new local run name')
    root = ROOT/'.local/agent-flash-runs'
    require(root.resolve() == root, 'Run directory must stay in the private workspace')
    old_mask = os.umask(0o077)
    try:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (root/'.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            directory = root/args.run
            directory.mkdir(mode=0o700)
            with (directory/'plan.json').open('x') as output:
                json.dump(dict(plan.review, approvalId=plan.approval_id), output, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
            with (directory/'stages.jsonl').open('x') as stages, (directory/'esptool.log').open('x') as log:
                def journal(event, **fields):
                    stages.write(json.dumps(dict(event=event, **fields))+'\n')
                    stages.flush()
                    os.fsync(stages.fileno())

                try:
                    with redirect_stdout(log), redirect_stderr(log), open_rom(args.port, plan.unit_mac) as flash:
                        run_stages(plan, flash, journal)
                except (Exception, KeyboardInterrupt):
                    traceback.print_exc(file=log)
                    journal('stopped')
                    raise ValueError(f'Execution stopped. Inspect the private record in {directory}.') from None
    finally:
        os.umask(old_mask)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('install', 'restore'), required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--recovery-base', type=Path)
    candidate_option(parser)
    selector_option(parser)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--selector', type=Path)
    parser.add_argument('--idf', type=Path, default=ROOT/'work/esp-idf')
    parser.add_argument('--stock-idf', type=Path, default=ROOT/'work/esp-idf-stock-v5.5.4')
    parser.add_argument('--scope', action='store_true', help='Include sector coverage in the offline preview')
    parser.add_argument('--port', help='Already in ROM download mode. Omit to review offline.')
    parser.add_argument('--approve', help='Exact approval ID from the reviewed operation')
    parser.add_argument('--run', help='New private execution record name')
    args = parser.parse_args()
    try:
        require(bool(args.port) == bool(args.approve) == bool(args.run),
                'Pass port, exact approval ID and run name together, or none for offline review')
        require(not (args.scope and args.port), '--scope is for offline review only')
        plan = load_plan(args)
        if args.port:
            execute(args, plan)
            print('All stages verified. The ROM connection was closed without resetting Sion.')
        else:
            preview = dict(plan.review, approvalId=plan.approval_id, deviceAccess=False)
            if args.scope:
                preview['writeScope'] = write_scope(plan)
            print(json.dumps(preview, indent=2))
    except (KeyError, ImportError, OSError, ValueError) as error:
        sys.exit(f'{args.candidate} bundle operation refused or stopped: {error}')


if __name__ == '__main__':
    main()
