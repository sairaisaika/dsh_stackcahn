"""Review and run a one-time v54 trial using the original Sion bootloader."""
import argparse
from dataclasses import replace
import json
from pathlib import Path

from app_center_baseline import OTA, review_app_center
from check_agent_preflight import read_snapshot
from execute_agent_bundle import Plan, execute, write_scope
from ota_record import OTA_NEW, ota_record
from prepare_agent import APP_CENTER_VERSION
from prepare_agent_bundle import ImageWrite, SECTOR, pad_sectors
from prepare_installation import sha
from review_app_center_install import read_bounded
from review_app_center_recovery import review_captures, reviewed_candidate
from review_stock_trial_install import review


def make_plan(operation, snapshot, writes, report):
    return Plan(snapshot.mac, snapshot.data, tuple(writes), {
        'schema': 1, 'operation': operation, 'review': report,
        'steps': [step.record(snapshot.data) for step in writes],
        'automaticReset': False, 'automaticRecovery': False,
    })


def install_plan(reference, before, source, audit, host_archive):
    report = review(reference, before, source, audit, host_archive)
    candidate = reviewed_candidate(before.data, source, stock_trial=True)
    stage, select = report['expectedWriteEnvelope'][:2]
    writes = (
        ImageWrite('stage', stage['start'], pad_sectors(candidate)),
        ImageWrite('select-once', select['start'], ota_record(report['selectionSequence'], OTA_NEW).ljust(SECTOR, b'\xff')),
    )
    expected = bytearray(before.data)
    for step, envelope, digest in zip(writes, (stage, select), ('stagedSha256', 'selectedSha256'), strict=True):
        if (step.file != envelope['phase'] or step.end != envelope['endExclusive'] or
                step.offset % SECTOR or step.end % SECTOR):
            raise ValueError('Install write differs from the reviewed sector envelope')
        expected[step.offset:step.end] = step.payload
        if sha(expected) != report[digest]:
            raise ValueError('Install write differs from the reviewed whole-Flash checkpoint')
    return make_plan('stock-trial-install', before, writes, report)


def restore_plan(before, current, source, *, cancel_selection=False):
    report = review_captures(before, current, source, stock_trial=True)
    writes = []
    if report['status'] != 'review-only':
        if not cancel_selection or report['status'] != 'await-confirmed-factory-readback':
            raise ValueError('Return to the confirmed factory app and take a new double read before restoring')
        factory = review_app_center(before.data)
        start = OTA + (1 - factory.active_record_sector) * SECTOR
        selection = ImageWrite('cancel-trial-selection', start, before.data[start:start + SECTOR])
        canceled = bytearray(current.data)
        canceled[selection.offset:selection.end] = selection.payload
        after_cancel = review_captures(before, replace(current, data=bytes(canceled)), source, stock_trial=True)
        if after_cancel['status'] != 'review-only':
            raise ValueError('The original factory slot would not be selected after canceling')
        after_cancel.update({'cancelsTrialState': report['inactiveRecordState'],
                             'currentSha256': report['currentSha256'], 'canceledSelectionSha256': sha(canceled)})
        report = after_cancel
        writes.append(selection)
    for span in report['restoreSpans']:
        start, end = span['start'], span['endExclusive']
        writes.append(ImageWrite(f"restore-{span['region']}-{start:x}", start, before.data[start:end]))
    restored = bytearray(current.data)
    for step in writes:
        restored[step.offset:step.end] = step.payload
    report['restoredSha256'] = sha(restored)
    return make_plan('stock-trial-restore', current, writes, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('install', 'restore'))
    for option in ('before', 'agent-source'):
        parser.add_argument('--'+option, type=Path, required=True)
    for option in ('reference', 'audit', 'host-archive', 'current'):
        parser.add_argument('--'+option, type=Path)
    parser.add_argument('--port', help='Identified Sion port already in ROM mode')
    parser.add_argument('--cancel-selection', action='store_true',
                        help='Restore a pending trial directly in ROM, before the factory app runs')
    parser.add_argument('--approve', help='Exact approval ID from this operation’s offline preview')
    parser.add_argument('--run', help='New private execution record name')
    args = parser.parse_args()
    try:
        if APP_CENTER_VERSION != 'dsh-agent-v54-ota':
            raise ValueError('Use the frozen v54 scripts and reviewed firmware source')
        if not (bool(args.port) == bool(args.approve) == bool(args.run)):
            raise ValueError('Supply port, exact approval ID and run name together for execution')
        before = read_snapshot(args.before)
        source = args.agent_source.resolve()
        if args.operation == 'install':
            if not (args.reference and args.audit and args.host_archive) or args.current or args.cancel_selection:
                raise ValueError('Install needs the rehearsal reference, report and host archive')
            if args.reference.resolve() == args.before.resolve():
                raise ValueError('Use separate rehearsal and current double reads')
            plan = install_plan(read_snapshot(args.reference), before, source,
                                json.loads(read_bounded(args.audit, 1024*1024)),
                                read_bounded(args.host_archive, 64*1024*1024))
        else:
            if not args.current or args.reference or args.audit or args.host_archive:
                raise ValueError('Restore needs the preinstall and current double reads')
            if args.current.resolve() == args.before.resolve():
                raise ValueError('Use separate preinstall and current double reads')
            plan = restore_plan(before, read_snapshot(args.current), source, cancel_selection=args.cancel_selection)
        if args.port:
            execute(args, plan)
            print('All stages verified. The ROM connection was closed with no requested reset.')
        else:
            print(json.dumps(dict(plan.review, approvalId=plan.approval_id, deviceAccess=False,
                                  writeScope=write_scope(plan)), indent=2))
    except (ImportError, KeyError, OSError, ValueError) as error:
        parser.exit(1, f'v54 stock trial refused or stopped: {error}\n')


if __name__ == '__main__':
    main()
