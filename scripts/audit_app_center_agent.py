"""Rehearse the App Center handoff on a temporary copy of a verified Flash read."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess

from app_center_baseline import OWNER_PREFIX, review_app_center, reviewed_firmware
from audit_agent_qemu import (A, B, OTA, OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID,
                              boot, call_site, default_efuse, ota_record)
from check_agent_preflight import ReadSnapshot, read_snapshot
from prepare_agent import APP_CENTER_VERSION, app_center_headers, sha, verify
from prepare_agent_bundle import (CONFIG_OFFSET, EXPECTED_PARTITIONS, SECTOR, TABLE_OFFSET,
                                  ImageWrite, apply, interrupted_write, pad_sectors)
from prepare_installation import image_info, ota_records
from review_app_center_recovery import plan_recovery, review_captures, validate_stock_trial


def audit(args):
    receipt = verify(args.source)
    if not receipt.get('appCenter') or receipt['appVersion'] != APP_CENTER_VERSION:
        raise ValueError('Expected prepared App Center candidate')
    if args.output.exists():
        raise ValueError('Choose a new report path')
    for name, expected in app_center_headers(args.backup).items():
        if (args.source/'firmware/main/agent/app_center'/name).read_text() != expected:
            raise ValueError('Factory baseline differs from the compiled candidate')
    start, stock = reviewed_firmware(args.backup)
    build = args.source/'firmware/build'
    compiled = json.loads((args.source/'.agent-build.json').read_text())
    if (compiled['profile'] != receipt['profile'] or compiled['appVersion'] != receipt['appVersion'] or
            compiled['preparedReceiptSha256'] != sha(args.source/'.agent-prepared.json')):
        raise ValueError('Build receipt is from a different prepared checkout')
    image, elf = build/'stack-chan.bin', build/'stack-chan.elf'
    for artifact in (image, elf):
        metadata = compiled['artifacts'][artifact.name]
        if sha(artifact) != metadata['sha256'] or artifact.stat().st_size != metadata['bytes']:
            raise ValueError('Built artifact differs from receipt')
    agent = image.read_bytes()
    app, stock_app = image_info(agent), image_info(stock)
    table = (build/'partition_table/partition-table.bin').read_bytes()
    if (app['version'] != APP_CENTER_VERSION or len(agent) > EXPECTED_PARTITIONS['ota_0'][3] or
            app['flashMode'] != stock_app['flashMode'] or table.ljust(SECTOR, b'\xff') != start[TABLE_OFFSET:]):
        raise ValueError('Application or build configuration differs from the reviewed OTA layout')

    symbols = subprocess.check_output([args.nm, '--defined-only', '-C', str(elf)], text=True)
    hal = next(int(line.split()[0], 16) for line in symbols.splitlines() if line.endswith(' T Hal::init()'))
    if 'ReviewedStockCanResume()' not in symbols or 'RegisterReviewedTailStorage()' not in symbols:
        raise ValueError('Factory return and isolated storage must be linked into the full image')
    efuse = default_efuse(args.idf)
    original = read_snapshot(args.backup).data
    records = ota_records(original[OTA:OTA+2*SECTOR], include_crc=True)
    confirmed = max((record for record in records if record['valid']), key=lambda record: record['sequence'])
    if (original[:len(start)] != start or original[B:B+len(stock)] != stock or
            confirmed['state'] != OTA_VALID or confirmed['sequence'] % 2 or confirmed['sequence'] > 0xfffffffa):
        raise ValueError('Factory image or its confirmed OTA record differs from the reviewed baseline')
    selection = OTA + (1-confirmed['sector'])*SECTOR
    if args.objdump:
        validate_stock_trial(original, review_app_center(original))
    first_sequence = confirmed['sequence']+1
    owner = CONFIG_OFFSET-SECTOR
    owner_record = OWNER_PREFIX+hashlib.sha256(start[TABLE_OFFSET:]).digest()
    stock_entry = struct.unpack_from('<I', stock, 4)[0]
    application = ImageWrite('candidate-application', A, pad_sectors(agent))
    staged = bytearray(original)
    apply(staged, application)
    results = {}
    recovery_reviews = {}

    def check_recovery(name, observed, *, ready=True, regions):
        if not args.objdump:
            return
        report = plan_recovery(original, observed, agent, stock_trial=True)
        expected_status = 'review-only' if ready else 'await-confirmed-factory-readback'
        observed_regions = list(dict.fromkeys(span['region'] for span in report['restoreSpans']))
        if (report['deviceAccess'] or report['flashAuthorized'] or report['status'] != expected_status or
                observed_regions != regions):
            raise ValueError(f'{name}: unexpected recovery spans or readiness')
        if ready:
            patched = bytearray(observed)
            for span in report['restoreSpans']:
                first, last = span['start'], span['endExclusive']
                patched[first:last] = original[first:last]
            if patched != original:
                raise ValueError(f'{name}: recovery scopes do not reproduce the baseline')
        recovery_reviews[name] = report

    def check(name, flash, expected, endpoint, slots, *, before_hal=False, storage_rejected=False, commands=()):
        mode = 'stock-without-adc-calibration' if before_hal or commands else 'stock'
        loaded, uart, readback, _ = boot(name, mode, flash, efuse, endpoint, args.qemu, args.gdb, elf,
                                         before_endpoint=commands)
        if loaded != slots or readback != expected:
            raise ValueError(f'{name}: selected slot or full Flash readback differs')
        if before_hal and ('DSH.AGENT independent settings storage unavailable' in uart) != storage_rejected:
            raise ValueError(f'{name}: unexpected storage registration result')
        results[name] = {'slot': hex(slots[-1]), 'wholeFlashMatched': True,
                         'reached': 'DSH HAL entry' if before_hal else 'factory app entry'}
        return readback

    def selected(flash, sequence, state):
        changed = bytearray(flash)
        changed[selection:selection+SECTOR] = ota_record(sequence, state).ljust(SECTOR, b'\xff')
        return changed

    torn_application = interrupted_write(bytearray(original), application)
    label = 'interrupted-staging-keeps-stock-bootable'
    check_recovery(label, check(label, torn_application, torn_application, stock_entry, [B]), regions=['ota_0'])
    label = 'staged-without-ota-selection'
    check_recovery(label, check(label, staged, staged, stock_entry, [B]), regions=['ota_0'])
    torn_selection = bytearray(staged)
    # The sequence and NEW state may reach Flash before the record's CRC.
    incomplete_record = ota_record(first_sequence, OTA_NEW)[:-4]
    torn_selection[selection:selection+SECTOR] = pad_sectors(incomplete_record)
    label = 'interrupted-selection-keeps-stock-bootable'
    check_recovery(label, check(label, torn_selection, torn_selection, stock_entry, [B]),
                   regions=['ota_0', 'inactive-ota-record'])
    first_launch = selected(staged, first_sequence, OTA_NEW)
    check_recovery('selection-awaits-confirmed-factory', first_launch, ready=False, regions=[])
    expected = selected(first_launch, first_sequence, OTA_PENDING_VERIFY)
    expected[owner:owner+len(owner_record)] = owner_record
    started = check('first-launch-claims-erased-tail', first_launch, expected, hal, [A], before_hal=True)
    check_recovery('pending-launch-awaits-confirmed-factory', started, ready=False, regions=[])
    expected = selected(started, first_sequence, OTA_ABORTED)
    returned = check('stock-after-interruption', started, expected, stock_entry, [B])

    if args.objdump:
        hal_call = call_site(args.objdump, elf, 'Hal::init()')
        home_call = call_site(args.objdump, elf, 'ReviewedStockCanResume()', after=hal_call)
        commands = [f'thbreak *{hal:#x}', 'continue', f'set $pc = {home_call:#x}']
        home = check('compiled-home-restarts-into-preserved-factory', first_launch, returned, stock_entry,
                     [A, B], commands=commands)
        home_regions = ['ota_0']
        if home[selection:selection+SECTOR] != original[selection:selection+SECTOR]:
            home_regions.append('inactive-ota-record')
        home_regions.append('unused-owner-marker')
        check_recovery('compiled-home-restarts-into-preserved-factory', home, regions=home_regions)
        review = review_captures(ReadSnapshot(original, 'simulated-unit'), ReadSnapshot(home, 'simulated-unit'),
                                 args.source, stock_trial=True)
        if review['candidateSha256'] != sha(image):
            raise ValueError('Stock trial recovery review lost the exact built candidate')

    partial_owner = bytearray(first_launch)
    partial_owner[owner:owner+16] = owner_record[:16]
    expected = selected(partial_owner, first_sequence, OTA_PENDING_VERIFY)
    partial_owner_started = check('incomplete-owner-record-is-not-claimed', partial_owner, expected,
                                  hal, [A], before_hal=True, storage_rejected=True)
    expected = selected(partial_owner_started, first_sequence, OTA_ABORTED)
    partial_owner_returned = check('stock-after-incomplete-owner-record', partial_owner_started,
                                   expected, stock_entry, [B])

    # Model another App Center launch. The claimed tail stays available without
    # any byte changes there. The published application is already in the slot.
    next_sequence = first_sequence+2
    launch = selected(returned, next_sequence, OTA_NEW)
    check('new-selection-reuses-owned-tail', launch, selected(launch, next_sequence, OTA_PENDING_VERIFY),
          hal, [A], before_hal=True)

    foreign = selected(staged, first_sequence, OTA_NEW)
    foreign[CONFIG_OFFSET] = 0
    check('foreign-tail-stays-unclaimed', foreign, selected(foreign, first_sequence, OTA_PENDING_VERIFY),
          hal, [A], before_hal=True, storage_rejected=True)

    restored = bytearray(partial_owner_returned)
    for first, last in ((A, application.end), (selection, selection+SECTOR), (owner, CONFIG_OFFSET)):
        restored[first:last] = original[first:last]
    check('restore-reviewed-bytes', restored, original, stock_entry, [B])
    if read_snapshot(args.backup).data != original:
        raise ValueError('Backup changed during offline rehearsals')

    report = {'deviceAccess': False, 'installable': False, 'stockRuntimeExecuted': False,
              'adcCalibrationConstructorSkippedInEmulator': True,
              'fullAgentSha256': sha(image), 'bootloaderAndTableUnchanged': True,
              'usedVerifiedFullFlashCopy': True,
              'modeledImageSectorSpan': [hex(A), hex(application.end)],
              'modeledOtaRecordSector': hex(selection), 'results': results}
    if args.objdump:
        report['trial'] = {
            'flashAuthorized': False, 'factorySlot': 'ota_1', 'candidateSlot': 'ota_0',
            'factoryImageSha256': hashlib.sha256(stock).hexdigest(),
            'beforeSha256': hashlib.sha256(original).hexdigest(),
            'stagedSha256': hashlib.sha256(staged).hexdigest(),
            'selectedSha256': hashlib.sha256(first_launch).hexdigest(),
            'afterHomeSha256': hashlib.sha256(returned).hexdigest(),
            'selectionSequence': first_sequence,
            'stagedSectors': [hex(A), hex(application.end)],
            'selectionSector': [hex(selection), hex(selection+SECTOR)],
            'firstStartOwnershipSector': [hex(owner), hex(CONFIG_OFFSET)],
            'homeScope': 'Compiled branch after resource release, ending at the preserved factory application entry',
        }
        report['recoveryReviews'] = recovery_reviews
    with args.output.open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('backup', 'source', 'idf', 'qemu', 'gdb', 'nm', 'output'):
        parser.add_argument('--'+name, type=lambda path: Path(path).resolve(), required=True)
    parser.add_argument('--objdump', type=lambda path: Path(path).resolve(),
                        help='Also verify the compiled Home branch and two-stage direct staging on the saved copy')
    audit(parser.parse_args())
