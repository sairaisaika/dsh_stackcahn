"""Measure the App Center SDK writer on disposable QEMU Flash copies."""
import argparse
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess

from app_center_baseline import A, OTA, OWNER, owner_record, require_app_center_storage, review_app_center, reviewed_partition_csv
from audit_agent_qemu import OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID
from audit_agent_qemu import boot, default_efuse, ota_record
from audit_app_center_storage import APP as STORAGE_PROBE
from check_agent_preflight import ReadSnapshot, read_snapshot
from prepare_agent import APP_CENTER_HOME_VERSION, APP_CENTER_VERSION, app_center_headers_from_flash, verify
from prepare_agent_bundle import APP_OFFSET, CONFIG_OFFSET, EXPECTED_PARTITIONS, ROOT, SECTOR, TABLE_OFFSET, pad_sectors
from prepare_installation import image_info, sha
from review_app_center_recovery import plan_recovery, review_captures


PROBE_DIR = ROOT/'firmware/tests/app-center-ota-writer'
PROBE = 'sion-app-center-ota-probe'
SDK_SOURCE = 'components/esp_https_ota/src/esp_https_ota.c'
APP_SOURCE = 'firmware/main/hal/utils/ota/ota.c'
UPDATER_SOURCE = 'components/app_update/esp_ota_ops.c'
FIXTURE_MARKER = 0x544f4953


def prepare(args):
    shutil.copytree(PROBE_DIR, args.source)
    (args.source/'partitions.csv').write_text(reviewed_partition_csv())


def pinned_source(checkout, pin, relative):
    expected = subprocess.check_output(['git', '-C', str(checkout), 'show', f'{pin}:{relative}'])
    if expected != (checkout/relative).read_bytes():
        raise ValueError(f'File differs from locked source: {relative}')
    return expected.decode()


def checked_inputs(args, stock):
    lock = json.loads((ROOT/'firmware/upstream.lock.json').read_text())
    idf = lock['idf']
    head = subprocess.check_output(['git', '-C', str(args.idf), 'rev-parse', 'HEAD'], text=True).strip()
    if head != idf['commit'] or image_info(stock)['idf'] != idf['tag']:
        raise ValueError('Expected the locked application SDK matching the installed factory app')
    app = pinned_source(args.official, lock['official']['commit'], APP_SOURCE)
    sdk = pinned_source(args.idf, head, SDK_SOURCE)
    pinned_source(args.idf, head, UPDATER_SOURCE)
    if not re.search(r'esp_https_ota_config_t ota_config =\s*\{\s*\.http_config = &config,\s*\};', app) or not re.search(
            r'const size_t erase_size = handle->bulk_flash_erase [^;]+ : OTA_WITH_SEQUENTIAL_WRITES;', sdk):
        raise ValueError('The public App Center or SDK erase policy changed')

    build = args.source/'build'
    description = json.loads((build/'project_description.json').read_text())
    if (Path(description['idf_path']).resolve() != args.idf or description['project_name'] != PROBE or
            Path(description['project_path']).resolve() != args.source or
            'CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y' not in (args.source/'sdkconfig').read_text().splitlines()):
        raise ValueError('Probe must be compiled with the locked application SDK and rollback enabled')
    for path in PROBE_DIR.rglob('*'):
        if path.is_file() and path.read_bytes() != (args.source/path.relative_to(PROBE_DIR)).read_bytes():
            raise ValueError(f'Probe source differs: {path.name}')

    receipt = verify(args.agent_source)
    build_receipt = json.loads((args.agent_source/'.agent-build.json').read_text())
    agent_build = args.agent_source/'firmware/build'
    image = agent_build/'stack-chan.bin'
    agent_elf = agent_build/'stack-chan.elf'
    agent = image.read_bytes()
    digest = sha(agent)
    info = image_info(agent)
    version = APP_CENTER_HOME_VERSION if args.receiver else APP_CENTER_VERSION
    if (receipt['appVersion'] != version or not receipt.get('appCenter') or
            bool(receipt.get('appCenterHome')) != bool(args.receiver) or
            build_receipt['preparedReceiptSha256'] != sha((args.agent_source/'.agent-prepared.json').read_bytes()) or
            build_receipt['artifacts'][image.name] != {'sha256': digest, 'bytes': len(agent)} or
            info['version'] != version or info['imageBytes'] != len(agent)):
        raise ValueError('Expected the exact built App Center candidate')
    elf_receipt = build_receipt['artifacts'][agent_elf.name]
    if agent_elf.stat().st_size != elf_receipt['bytes'] or sha(agent_elf.read_bytes()) != elf_receipt['sha256']:
        raise ValueError('Candidate ELF differs from the build receipt')
    return agent, agent_elf, digest, lock['official']['commit'], idf


def symbol(nm, elf, name):
    symbols = subprocess.check_output([nm, '--defined-only', '-C', str(elf)], text=True)
    return next(int(line.split()[0], 16) for line in symbols.splitlines() if line.endswith(f' T {name}'))


def expected_select(flash, selection, sequence, state):
    record = ota_record(sequence, state)
    # SDK updates the old entry in this sector, retaining reserved bytes.
    reserved = flash[selection+4:selection+24]
    return (record[:4] + reserved + record[24:]).ljust(SECTOR, b'\xff')


def exercise(args, original, agent, agent_elf, probe, probe_elf, efuse):
    reviewed = review_app_center(original)
    storage = require_app_center_storage(original, reviewed)
    generated = args.agent_source/'firmware/main/agent/app_center'
    for name, contents in app_center_headers_from_flash(original).items():
        if (generated/name).read_text() != contents:
            raise ValueError('Candidate was prepared for a different stock image or layout')
    stock = reviewed.stock
    factory = EXPECTED_PARTITIONS[reviewed.stock_slot][2]
    agent_slot = 'ota_1' if reviewed.stock_slot == 'ota_0' else 'ota_0'
    _, _, target, slot_size = EXPECTED_PARTITIONS[agent_slot]
    selection = OTA+(1-reviewed.active_record_sector)*SECTOR
    sequence = reviewed.active_sequence+1
    padded_size = len(pad_sectors(agent))
    if padded_size > slot_size or APP_OFFSET+12+len(agent) > OWNER:
        raise ValueError('Candidate does not fit target slot or disposable emulator input area')
    done = symbol(args.nm, probe_elf, 'sion_ota_writer_probe_done')
    hal = symbol(args.nm, agent_elf, 'Hal::init()')
    ownership = owner_record(reviewed.table)
    base = bytearray(original)
    # Use non-erased bytes even past the candidate image to detect excess erases.
    base[target:target+slot_size] = b'\x00'*slot_size

    def write_case(label, before, data, size, status):
        fixture = bytearray(before)
        fixture[factory:factory+len(probe)] = probe
        payload = struct.pack('<III', FIXTURE_MARKER, len(data), size) + data
        fixture[APP_OFFSET:APP_OFFSET+len(payload)] = payload
        expected = bytearray(fixture)
        written = pad_sectors(data[:size])
        expected[target:target+len(written)] = written
        # In rollback-enabled builds, esp_ota_begin invalidates the inactive
        # record before the first write if it still exists. A retry after an
        # interrupted download starts with this sector already erased.
        erase_inactive = fixture[selection:selection+SECTOR] != b'\xff'*SECTOR
        expected[selection:selection+SECTOR] = b'\xff'*SECTOR
        if status == 'selected':
            expected[selection:selection+SECTOR] = expected_select(expected, selection, sequence, OTA_NEW)

        slots, log, observed, _ = boot(label, 'stock', fixture, efuse, done, args.qemu, args.gdb, probe_elf)
        spans = [(int(address, 16), int(count)) for address, count in
                 re.findall(r'SION-OTA ERASE ([0-9a-f]{8}) (\d+)', log)]
        expected_sectors = [selection] if erase_inactive else []
        expected_sectors.extend(range(target, target+len(written), SECTOR))
        if status == 'selected':
            expected_sectors.append(selection)
        expanded = [sector for address, size in spans if address % SECTOR == 0 and size % SECTOR == 0
                    for sector in range(address, address+size, SECTOR)]
        if (slots != [factory] or f'SION-OTA RESULT {status}' not in log or observed != expected or
                any(address % SECTOR or size <= 0 or size % SECTOR for address, size in spans) or
                expanded != expected_sectors):
            first_difference = next((index for index, values in enumerate(zip(observed, expected))
                                     if values[0] != values[1]), None) if observed != expected else None
            raise ValueError(f'{label}: unexpected OTA result or write range. '
                             f'First differing byte offset: {first_difference}. '
                             f'First erased sectors: {[hex(s) for s in expanded[:3]]}')
        return {'bytesStreamed': size, 'candidateEraseSpan': [hex(target), hex(target+len(written))],
                'inactiveRecordErasedAtBegin': erase_inactive, 'newSelectionWritten': status == 'selected',
                'wholeFlashMatched': True}, observed

    empty, empty_flash = write_case('stop-after-begin', base, agent, 0, 'partial')
    partial, partial_flash = write_case('partial-stream', base, agent, SECTOR+37, 'partial')
    damaged = agent[:-1] + bytes([agent[-1] ^ 1])
    invalid, invalid_flash = write_case('invalid-image', base, damaged, len(damaged), 'rejected')
    complete, staged = write_case('complete-image', base, agent, len(agent), 'selected')

    # Hand off the actual SDK-written bytes to the unchanged original bootloader.
    # Keep only the measured OTA and payload ranges from the write fixture.
    # App startup uses the exact paired factory and DSH bytes.
    handoffs = {}
    reviews = {}

    def production_copy(before, observed, span):
        flash = bytearray(before)
        flash[target:target+span] = observed[target:target+span]
        flash[selection:selection+SECTOR] = observed[selection:selection+SECTOR]
        return flash

    def handoff(label, flash, offset, state=None):
        dsh = offset == target
        entry = hal if dsh else struct.unpack_from('<I', stock, 4)[0]
        mode = 'stock-without-adc-calibration' if dsh else 'stock'
        slots, log, observed, _ = boot(label, mode, flash, efuse, entry, args.qemu, args.gdb, agent_elf if dsh else probe_elf)
        if state is not None:
            flash[selection:selection+SECTOR] = expected_select(flash, selection, sequence, state)
        if dsh:
            flash[OWNER:OWNER+len(ownership)] = ownership
            if 'DSH.AGENT independent settings storage unavailable' in log:
                raise ValueError(f'{label}: DSH could not register independent storage')
        if slots != [offset] or observed != flash:
            raise ValueError(f'{label}: unexpected app or Flash state')
        handoffs[label] = {'slot': hex(offset), 'wholeFlashMatched': True,
                           'reached': 'DSH HAL entry' if dsh else 'factory app entry'}

    def recovery_check(label, observed, state, spans, *, preserve=()):
        report = plan_recovery(original, observed, agent)
        actual = [(entry['start'], entry['endExclusive']) for entry in report['restoreSpans']]
        if (report['inactiveRecordState'] != state or actual != spans or
                report['preserveChangedRegions'] != list(preserve) or report['flashAuthorized'] or report['deviceAccess']):
            raise ValueError(f'{label}: recovery review disagrees with actual Flash readback')
        reviews[label] = report

    def rejected_review(label, observed, message):
        try:
            plan_recovery(original, observed, agent)
        except ValueError as error:
            if message not in str(error):
                raise
        else:
            raise ValueError(f'{label}: unexpected recovery preview for unrecognized bytes')
        reviews[label] = {'status': 'rejected'}

    changed_record = (selection, selection+SECTOR)
    no_payload = production_copy(original, empty_flash, 0)
    handoff('stock-after-abort-before-payload', no_payload, factory)
    recovery_check('aborted-before-payload', no_payload, 'erased-record', [changed_record])
    interrupted = production_copy(original, partial_flash, 2*SECTOR)
    handoff('stock-after-partial-download', interrupted, factory)
    recovery_check('partial-download', interrupted, 'erased-record', [(target, target+2*SECTOR), changed_record])
    corrupted = production_copy(original, invalid_flash, padded_size)
    handoff('stock-after-corrupt-download', corrupted, factory)
    rejected_review('corrupt-candidate-bytes', corrupted, 'sequential partial write')
    retry, retried = write_case('retry-after-partial-download', interrupted, agent, len(agent), 'selected')
    launch = production_copy(original, staged, padded_size)
    if production_copy(interrupted, retried, padded_size) != launch:
        raise ValueError('Retry after an interrupted download produced a different launch state')
    recovery_check('new-candidate-waits-for-factory', launch, 'candidate-new', [])
    handoff('first-boot', launch, target, OTA_PENDING_VERIFY)
    recovery_check('pending-candidate-waits-for-factory', launch, 'candidate-pending-verification', [])
    handoff('unconfirmed-reboot', launch, factory, OTA_ABORTED)
    if args.receiver:
        # Exercise source and image receipt verification with actual QEMU
        # readbacks. The identity belongs to the fixture, not a device log.
        report = review_captures(ReadSnapshot(original, 'simulated-unit'),
                                 ReadSnapshot(bytes(launch), 'simulated-unit'), args.agent_source)
        if report['status'] != 'review-only' or report['candidateSha256'] != sha(agent):
            raise ValueError('Paired candidate source and actual readback do not produce a review')
    repeat, restaged = write_case('download-after-return', launch, agent, len(agent), 'selected')
    launch = production_copy(launch, restaged, padded_size)
    handoff('second-boot', launch, target, OTA_PENDING_VERIFY)
    handoff('second-unconfirmed-reboot', launch, factory, OTA_ABORTED)

    owner_span = [(OWNER, CONFIG_OFFSET)] if storage == 'erased' else []
    aborted_record = [changed_record] if launch[selection:selection+SECTOR] != original[selection:selection+SECTOR] else []
    sector_spans = [(target, target+padded_size)] + aborted_record + owner_span
    recovery_check('candidate-aborted', launch, 'candidate-aborted', sector_spans)
    retained = bytearray(launch)
    nvs = EXPECTED_PARTITIONS['nvs'][2]
    retained[nvs] ^= 1
    if storage == 'erased':
        # An already populated independent range must stay with its marker.
        retained[CONFIG_OFFSET] = 0
    recovery_check('retains-new-settings', retained, 'candidate-aborted',
                   [(target, target+padded_size)] + aborted_record, preserve=('nvs', 'sion_cfg') if owner_span else ('nvs',))
    protected = bytearray(launch)
    protected[factory+0x1000] ^= 1
    rejected_review('rejects-changed-factory-image', protected, 'Unreviewed Flash changes')
    protected = bytearray(launch)
    protected[target+padded_size] ^= 1
    rejected_review('rejects-extra-inactive-sector', protected, 'Unreviewed Flash changes')

    # With factory already selected, put back the inactive image before its
    # saved boot record. An interruption between these steps still boots factory.
    launch[target:target+padded_size] = original[target:target+padded_size]
    handoff('stock-after-inactive-image-restore', launch, factory)
    recovery_check('image-restored-before-record', launch, 'candidate-aborted' if aborted_record else 'original-record',
                   aborted_record + owner_span)
    launch[selection:selection+SECTOR] = original[selection:selection+SECTOR]
    launch[OWNER:CONFIG_OFFSET] = original[OWNER:CONFIG_OFFSET]
    if launch != original:
        raise ValueError('Restoring the measured spans must reproduce the saved Flash')
    handoff('stock-after-restoring-saved-spans', launch, factory)
    recovery_check('fully-restored', launch, 'original-record', [])
    restore_spans = [
        {'purpose': 'inactive app', 'start': hex(target), 'endExclusive': hex(target+padded_size)},
        {'purpose': 'inactive OTA record', 'start': hex(selection), 'endExclusive': hex(selection+SECTOR)},
    ]
    if storage == 'erased':
        restore_spans.append({'purpose': 'new ownership marker only', 'start': hex(OWNER), 'endExclusive': hex(CONFIG_OFFSET)})
    return {'factorySlot': reviewed.stock_slot, 'candidateSlot': agent_slot, 'independentStorageAtStart': storage,
            'candidateRecordSector': [hex(selection), hex(selection+SECTOR)],
            'restoreSpansAfterFactorySelected': restore_spans, 'readOnlyRecoveryReviews': reviews,
            'writes': {'abortedBeforePayload': empty, 'partial': partial, 'invalid': invalid, 'complete': complete,
                       'retryAfterPartial': retry, 'repeatDownload': repeat}, 'bootHandoffs': handoffs}


def seed_settings(args, original, reviewed, efuse):
    fixture = bytearray(original)
    build = args.storage_probe/'build'
    store = build/STORAGE_PROBE
    probe = store.with_suffix('.bin').read_bytes()
    info = image_info(probe)
    table = (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff')
    if (info.get('project') != STORAGE_PROBE or info.get('idf') != image_info(reviewed.stock)['idf'] or
            require_app_center_storage(original, reviewed) != 'erased' or table != reviewed.table):
        raise ValueError('Expected the target storage fixture and a virgin independent range')
    sector = OTA+(1-reviewed.active_record_sector)*SECTOR
    sequence = reviewed.active_sequence+1
    fixture[A:A+len(probe)] = probe
    fixture[sector:sector+SECTOR] = expected_select(fixture, sector, sequence, OTA_NEW)
    entry = struct.unpack_from('<I', reviewed.stock, 4)[0]
    loaded, log, observed, _ = boot('seed-upgraded-baseline-settings', 'stock', fixture, efuse, entry,
                                     args.qemu, args.gdb, store.with_suffix('.elf'))
    fixture[sector:sector+SECTOR] = expected_select(fixture, sector, sequence, OTA_ABORTED)
    ownership = owner_record(reviewed.table).ljust(SECTOR, b'\xff')
    if (loaded != [A, EXPECTED_PARTITIONS[reviewed.stock_slot][2]] or 'SION-STORE: saved through DSH stores' not in log or
            observed[:OWNER] != fixture[:OWNER] or observed[OWNER:CONFIG_OFFSET] != ownership or
            observed[CONFIG_OFFSET:] == original[CONFIG_OFFSET:]):
        raise ValueError(f'Expected a real synthetic pairing and settings payload\n{log[-1200:]}')
    return observed[OWNER:]


def audit(args):
    if args.output.exists():
        raise ValueError('Choose a new report path')
    original = read_snapshot(args.backup).data
    reviewed = review_app_center(original)
    agent, agent_elf, digest, official_pin, idf = checked_inputs(args, reviewed.stock)
    build = args.source/'build'
    probe = (build/(PROBE+'.bin')).read_bytes()
    elf = build/(PROBE+'.elf')
    probe_info = image_info(probe)
    if (probe_info.get('project') != PROBE or probe_info.get('idf') != idf['tag'] or
            (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff') != reviewed.table):
        raise ValueError('Probe or partition table does not match the test configuration')
    efuse = default_efuse(args.idf)
    if args.receiver:
        if reviewed.stock_slot != 'ota_1':
            raise ValueError('Use the historical factory-in-B capture to derive the simulated upgrade')
        receiver_path = args.receiver/'firmware/build/stack-chan.bin'
        app_center_headers_from_flash(original, receiver_path)
        receiver = receiver_path.read_bytes()
        factory_b = bytearray(original)
        factory_b_start = EXPECTED_PARTITIONS['ota_1'][2]
        factory_b[factory_b_start:factory_b_start+len(receiver)] = receiver
        factory_a = bytearray(factory_b)
        factory_a[A:A+len(receiver)] = receiver
        sector = OTA+(1-reviewed.active_record_sector)*SECTOR
        factory_a[sector:sector+SECTOR] = expected_select(factory_a, sector, reviewed.active_sequence+1, OTA_VALID)
        factory_a[OWNER:] = seed_settings(args, original, reviewed, efuse)
        baselines = (factory_b, factory_a)
    else:
        baselines = (original,)
    orientations = [exercise(args, baseline, agent, agent_elf, probe, elf, efuse) for baseline in baselines]
    if read_snapshot(args.backup).data != original:
        raise ValueError('Saved backup changed during the audit')

    result = {'deviceAccess': False, 'installable': False, 'candidateSha256': digest,
              'candidateVersion': image_info(agent)['version'],
              'probeSha256': sha(probe),
              'officialSourceCommit': official_pin, 'writerIdfCommit': idf['commit'],
              'writerIdfVersion': idf['tag'], 'factoryAppIdfVersion': image_info(reviewed.stock)['idf'],
              'adcCalibrationConstructorSkippedInEmulator': True,
              'exercise': 'SDK writer and startup through factory or DSH entry on virtual Flash'}
    if args.receiver:
        result['orientations'] = orientations
    else:
        result.update(orientations[0])
    with args.output.open('x') as report:
        json.dump(result, report, indent=2)
        report.write('\n')
    print(f'Six SDK write cases and nine original-bootloader handoffs matched for {len(orientations)} orientation(s).')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    for name, handler, options in (
            ('prepare', prepare, ('source',)),
            ('audit', audit, ('source', 'backup', 'agent-source', 'official', 'idf',
                              'qemu', 'gdb', 'nm', 'output'))):
        command = commands.add_parser(name)
        for option in options:
            command.add_argument('--'+option, type=lambda path: Path(path).resolve(), required=True)
        if name == 'audit':
            command.add_argument('--receiver', type=lambda path: Path(path).resolve(),
                                 help='Run both slot orders with the paired public receiver checkout')
            command.add_argument('--storage-probe', type=lambda path: Path(path).resolve(),
                                 help='Target storage fixture for the after-update baseline')
        command.set_defaults(run=handler)
    args = parser.parse_args()
    if getattr(args, 'receiver', None) and not args.storage_probe:
        parser.error('--receiver requires --storage-probe')
    args.run(args)
