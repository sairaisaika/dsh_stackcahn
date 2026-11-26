"""Exercise the paired Open/Home path with either confirmed factory slot."""
import argparse
import json
from pathlib import Path
import struct
import subprocess

from app_center_baseline import A, OTA, OWNER, owner_record, require_app_center_storage, review_app_center
from audit_agent_qemu import OTA_ABORTED, OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, boot, call_site, default_efuse, ota_record
from audit_app_center_home import HANDOFF, STOCK_NOTICE
from audit_app_center_ota_writer import expected_select, symbol
from audit_app_center_reopen import APP as OPEN_APP, FIXTURE as OPEN_SOURCE, HELPER as OPEN_HELPER, MARKER as OPEN_MARKER
from audit_app_center_storage import APP as STORE_APP, PROBE as STORE_SOURCE
from check_agent_preflight import read_snapshot
from prepare_agent import APP_CENTER_HOME_VERSION, app_center_headers_from_flash, verify
from prepare_agent_bundle import APP_OFFSET, CONFIG_OFFSET, EXPECTED_PARTITIONS, ROOT, SECTOR, TABLE_OFFSET
from prepare_installation import image_info, sha


def image(project, name, table, idf):
    build = project/'build'
    binary = (build/(name+'.bin')).read_bytes()
    description = json.loads((build/'project_description.json').read_text())
    info = image_info(binary)
    if (info['project'] != name or info['imageBytes'] != len(binary) or
            Path(description['idf_path']).resolve() != idf or
            (build/'partition_table/partition-table.bin').read_bytes().ljust(SECTOR, b'\xff') != table):
        raise ValueError(f'Unreviewed build or partition table: {name}')
    return binary, build/(name+'.elf')


def audit(args):
    original = read_snapshot(args.backup).data
    historical = review_app_center(original)
    table = historical.table
    if historical.stock_slot != 'ota_1' or require_app_center_storage(original, historical) != 'erased':
        raise ValueError('Start the two-orientation rehearsal with the reviewed factory in B and an erased tail')
    if args.output.exists():
        raise ValueError('Choose a new report path')

    factory, factory_elf = image(args.receiver/'firmware', 'stack-chan', table, args.idf)
    agent, agent_elf = image(args.agent/'firmware', 'stack-chan', table, args.idf)
    opener, opener_elf = image(args.open_probe, OPEN_APP, table, args.idf)
    storage, storage_elf = image(args.storage_probe, STORE_APP, table, args.idf)
    for binary, slot in ((agent, 'ota_0'), (factory, 'ota_1'), (opener, 'ota_1'), (storage, 'ota_0')):
        if len(binary) > EXPECTED_PARTITIONS[slot][3]:
            raise ValueError('Fixture image exceeds slot size')
    for source, prepared_probe in ((OPEN_SOURCE, args.open_probe), (STORE_SOURCE, args.storage_probe)):
        for path in source.rglob('*'):
            if path.is_file() and path.read_bytes() != (prepared_probe/path.relative_to(source)).read_bytes():
                raise ValueError(f'Probe fixture source differs: {path.name}')
    for name in ('storage_guard.cc', 'settings_store.cc', 'pairing_store.cc', 'preferences.h'):
        if (args.storage_probe/'main/agent'/name).read_bytes() != (ROOT/'firmware/agent'/name).read_bytes():
            raise ValueError(f'Probe storage source differs: {name}')
    if (args.open_probe/'main/app_center_reopen.h').read_bytes() != (args.receiver/OPEN_HELPER).read_bytes():
        raise ValueError('Open fixture differs from the compiled receiver source')
    if (args.receiver/'firmware/main/hal/app_center_home_menu.h').read_bytes() != HANDOFF.read_bytes():
        raise ValueError('Receiver source differs from the one-shot Home protocol')
    prepared = verify(args.agent)
    receipt = json.loads((args.agent/'.agent-build.json').read_text())
    if (image_info(agent)['version'] != APP_CENTER_HOME_VERSION or not prepared.get('appCenterHome') or
            receipt['preparedReceiptSha256'] != sha((args.agent/'.agent-prepared.json').read_bytes()) or
            receipt['artifacts']['stack-chan.bin']['sha256'] != sha(agent) or
            receipt['artifacts']['stack-chan.elf']['sha256'] != sha(agent_elf.read_bytes())):
        raise ValueError('Expected the verified paired DSH build')
    generated = args.agent/'firmware/main/agent/app_center'
    headers = {name: (generated/name).read_text() for name in ('reviewed_layout.h', 'reviewed_stock_digest.h')}
    if headers != app_center_headers_from_flash(original, factory_elf.with_suffix('.bin')):
        raise ValueError('Home target digest differs from the prepared image')

    efuse = default_efuse(args.idf)
    def run(name, flash, endpoint, elf, *, trigger='stock', commands=()):
        return boot(name, trigger, flash, efuse, endpoint, args.qemu, args.gdb, elf, before_endpoint=commands)[:3]

    # Create a real, populated independent NVS using the target SDK fixture.
    initial = EXPECTED_PARTITIONS[historical.stock_slot][2]
    seed_sector = OTA+(1-historical.active_record_sector)*SECTOR
    seed_sequence = historical.active_sequence+1
    fixture = bytearray(original)
    fixture[A:A+len(storage)] = storage
    fixture[seed_sector:seed_sector+SECTOR] = expected_select(fixture, seed_sector, seed_sequence, OTA_NEW)
    entry = struct.unpack_from('<I', historical.stock, 4)[0]
    loaded, log, seeded = run('seed-pairing-and-preferences', fixture, entry, storage_elf)
    fixture[seed_sector:seed_sector+SECTOR] = expected_select(fixture, seed_sector, seed_sequence, OTA_ABORTED)
    ownership = owner_record(table).ljust(SECTOR, b'\xff')
    if (loaded != [A, initial] or 'SION-STORE: saved through DSH stores' not in log or
            seeded[:OWNER] != fixture[:OWNER] or seeded[OWNER:CONFIG_OFFSET] != ownership or
            seeded[CONFIG_OFFSET:] == fixture[CONFIG_OFFSET:]):
        raise ValueError(f'Expected isolated DSH settings to be written\n{log[-1200:]}')

    open_done = symbol(args.nm, opener_elf, 'sion_reopen_probe_done')
    store_done = symbol(args.nm, storage_elf, 'sion_storage_probe_done')
    factory_hal = symbol(args.nm, factory_elf, 'Hal::init()')
    before_hal = call_site(args.objdump, agent_elf, 'Hal::init()')
    home_call = call_site(args.objdump, agent_elf, 'ReviewedStockReturnAddress()')
    commands = [f'thbreak *{before_hal:#x}', 'continue', f'set $pc = {home_call:#x}',
                f'symbol-file {json.dumps(str(factory_elf))}', 'thbreak adc_hw_calibration', 'continue', 'return']

    def open_installed(name, flash, factory_offset, sector, sequence, *, allowed, update_queued=False):
        # The Open probe stands in for the catalog UI only. Carry forward just
        # the readback OTA record after proving the complete probe copy matches.
        fixture = bytearray(flash)
        fixture[factory_offset:factory_offset+len(opener)] = opener
        payload = struct.pack('<II64s', OPEN_MARKER, int(update_queued), agent[-32:].hex().encode())
        fixture[APP_OFFSET:APP_OFFSET+len(payload)] = payload
        expected = bytearray(fixture)
        if allowed or update_queued:
            expected[sector:sector+SECTOR] = expected_select(fixture, sector, sequence, OTA_NEW)
        loaded, log, readback = run(name, fixture, open_done, opener_elf)
        marker = f'SION-REOPEN result={int(allowed)} selectCalls={int(allowed)}'
        if loaded != [factory_offset] or readback != expected or marker not in log:
            raise ValueError(f'{name}: unexpected Open result or Flash readback\n{log[-1200:]}')
        return readback[sector:sector+SECTOR]

    def cycles_from_factory(flash):
        reviewed = review_app_center(flash)
        if require_app_center_storage(flash, reviewed) != 'owned' or app_center_headers_from_flash(flash) != headers:
            raise ValueError('Prepared DSH must remain compatible with the installed receiver and retained storage')
        factory_offset = EXPECTED_PARTITIONS[reviewed.stock_slot][2]
        agent_slot = 'ota_1' if reviewed.stock_slot == 'ota_0' else 'ota_0'
        agent_offset = EXPECTED_PARTITIONS[agent_slot][2]
        sector = OTA+(1-reviewed.active_record_sector)*SECTOR
        sequence = reviewed.active_sequence+1

        # Model the state after a first installation has already returned Home.
        baseline = bytearray(flash)
        baseline[agent_offset:agent_offset+len(agent)] = agent
        baseline[sector:sector+SECTOR] = expected_select(baseline, sector, sequence, OTA_ABORTED)
        working = bytearray(baseline)
        cycles = []
        for cycle in (1, 2):
            working[sector:sector+SECTOR] = open_installed(f'open-{reviewed.stock_slot}-{cycle}', working,
                                                            factory_offset, sector, sequence, allowed=True)
            # Run the real compiled Home branch with the full paired images in place.
            loaded, log, returned = run(f'home-{reviewed.stock_slot}-{cycle}', working, factory_hal, agent_elf,
                                        trigger='stock-without-adc-calibration', commands=commands)
            if loaded != [agent_offset, factory_offset] or returned != baseline or STOCK_NOTICE not in log.splitlines():
                raise ValueError(f'Unexpected Home result for factory {reviewed.stock_slot}\n{log[-1600:]}')
            working = bytearray(returned)
            cycles.append({'cycle': cycle, 'loadedSlots': [hex(slot) for slot in loaded],
                           'publicReceiverAcceptedHome': True, 'wholeFlashMatched': True})

        open_installed('open-defers-to-queued-update', working, factory_offset, sector, sequence,
                       allowed=False, update_queued=True)
        replaced = bytearray(working)
        replaced[agent_offset:agent_offset+len(historical.stock)] = historical.stock
        open_installed('open-refuses-replaced-image', replaced, factory_offset, sector, sequence, allowed=False)

        # Decode the retained settings through the same firmware store that wrote them.
        fixture = bytearray(working)
        fixture[agent_offset:agent_offset+len(storage)] = storage
        fixture[sector:sector+SECTOR] = expected_select(fixture, sector, sequence, OTA_NEW)
        loaded, log, checked = run('read-pairing-after-reentry', fixture, store_done, storage_elf)
        fixture[sector:sector+SECTOR] = expected_select(fixture, sector, sequence, OTA_PENDING_VERIFY)
        if loaded != [agent_offset] or checked != fixture or 'SION-STORE: pairing and preferences restored' not in log:
            raise ValueError(f'Independent stores did not retain valid settings\n{log[-1200:]}')

        restored = bytearray(working)
        restored[agent_offset:agent_offset+len(agent)] = flash[agent_offset:agent_offset+len(agent)]
        restored[sector:sector+SECTOR] = flash[sector:sector+SECTOR]
        loaded, log, observed = run('restore-the-new-factory-baseline', restored, factory_hal, factory_elf,
                                    trigger='stock-without-adc-calibration')
        if loaded != [factory_offset] or observed != flash or STOCK_NOTICE in log.splitlines():
            raise ValueError(f'Uninstall did not return to the current factory baseline\n{log[-1200:]}')
        return {'factorySlot': reviewed.stock_slot, 'agentSlot': agent_slot, 'cycles': cycles,
                'queuedUpdateSelectionKept': True, 'replacedAppRefused': True,
                'pairingAndPreferencesDecodedAfterReentry': True, 'restoredCurrentFactoryBaseline': True}

    factory_b = bytearray(original)
    factory_b[initial:initial+len(factory)] = factory
    factory_b[OWNER:] = seeded[OWNER:]
    # Model an installed official update confirmed in A, with the previous B
    # application still valid and the independent configuration untouched.
    factory_a = bytearray(factory_b)
    factory_a[A:A+len(factory)] = factory
    factory_a[seed_sector:seed_sector+SECTOR] = expected_select(factory_a, seed_sector, seed_sequence, OTA_VALID)

    # Reject ambiguous OTA metadata and nonempty space that the device would
    # refuse to recognize as its independent settings region.
    opposite_sector = OTA+historical.active_record_sector*SECTOR
    rejected = []
    for name, offset, payload, reason in (
            ('selected-app-pending', seed_sector, ota_record(seed_sequence, OTA_PENDING_VERIFY), 'must be confirmed'),
            ('two-records-for-one-slot', opposite_sector, ota_record(seed_sequence+2, OTA_VALID), 'same slot'),
            ('unknown-selection-state', opposite_sector, ota_record(seed_sequence+1, 99), 'Unexpected CRC-valid'),
            ('missing-tail-owner', OWNER, b'\xff'*SECTOR, 'ownership'),
            ('partial-tail-owner', OWNER+len(owner_record(table))-1, b'\x00', 'ownership'),
            ('extra-bytes-in-owner-sector', CONFIG_OFFSET-1, b'\x00', 'ownership')):
        changed = bytearray(factory_a)
        changed[offset:offset+len(payload)] = payload
        try:
            app_center_headers_from_flash(changed)
        except ValueError as error:
            if reason not in str(error):
                raise
        else:
            raise ValueError(f'Unsafe baseline accepted: {name}')
        rejected.append(name)

    swapped = bytearray(factory_a)
    swapped[OTA:OTA+2*SECTOR] = factory_a[OTA+SECTOR:OTA+2*SECTOR]+factory_a[OTA:OTA+SECTOR]
    if (review_app_center(swapped).active_record_sector == review_app_center(factory_a).active_record_sector or
            app_center_headers_from_flash(swapped) != headers):
        raise ValueError('Slot identity must follow its sequence, independent of its record sector')
    orientations = [cycles_from_factory(factory_b), cycles_from_factory(factory_a)]
    if read_snapshot(args.backup).data != original:
        raise ValueError('Saved backup changed during the rehearsal')
    report = {'deviceAccess': False, 'installable': False, 'agentSha256': sha(agent), 'receiverSha256': sha(factory),
              'productionBootloaderSha256': sha(original[:TABLE_OFFSET]), 'orientations': orientations,
              'baselineRejected': rejected, 'recordSectorIndependentOfAppSlot': True,
              'scope': {'open': 'App Center selection helper with a catalog fixture',
                        'home': 'Debugger jumps within compiled DSH app_main from the HAL call to the drained Home branch',
                        'receiver': 'Compiled public factory receiver through HAL entry'}}
    with args.output.open('x') as output:
        output.write(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('backup', 'idf', 'qemu', 'gdb', 'nm', 'objdump', 'receiver', 'agent', 'open-probe',
                   'storage-probe', 'output'):
        parser.add_argument('--'+option, type=lambda path: Path(path).resolve(), required=True)
    audit(parser.parse_args())
