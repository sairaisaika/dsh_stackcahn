"""Decode a Sion RAM trace or generate a read-only debugger capture command."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
HEADER = ROOT / 'firmware/agent/device_trace.h'
MAGIC = 0x53494f4e
CAPACITY = 32
LEGACY_LANES = ('boot', 'ui', 'usb', 'audio', 'network')
LANES = (*LEGACY_LANES, 'touch', 'lvgl', 'actions', 'lcd')
SCHEMAS = {1: LEGACY_LANES, 2: LANES}
HEAD = struct.Struct('<4I')
ENTRY = struct.Struct('<5I')
LANE_BYTES = 4 + ENTRY.size * (CAPACITY + 1)
BYTES = HEAD.size + len(LANES) * LANE_BYTES
SERIAL_MASK = 0xffffffff
PHASES = ('idle', 'connecting', 'active', 'draining', 'returning', 'home', 'fault')
PAGES = ('Entry', 'Agent', 'Settings', 'Pairing', 'Avatar', 'CameraSettings',
         'MotionSettings', 'RingSettings', 'DisplaySettings', 'FactoryConfirm')
USB_END = ('closing', 'no-bus', 'peer-quiet', 'partial-frame', 'write-timeout',
           'read-error', 'frame-rejected', 'write-error')
RESOURCE_NAMES = ('audio', 'camera', 'motion', 'lights', 'ambient', 'head-touch', 'imu', 'carrier', 'pairing')
RESET_REASONS = ('unknown', 'power-on', 'external', 'software', 'panic', 'interrupt-watchdog',
                 'task-watchdog', 'watchdog', 'deep-sleep', 'brownout', 'sdio', 'usb',
                 'jtag', 'efuse', 'power-glitch', 'cpu-lockup')
HOST_FIELDS = frozenset(('at', 'run', 'capture', 'transport', 'event', 'elapsedMs', 'source', 'code',
                         'stage', 'outcome', 'cause', 'windowMs', 'usbReads', 'inputFrames',
                         'usbReadGapMsMax', 'inputGapMsMax',
                         'queueDepthMax', 'queueWaitMsMax', 'droppedByAge', 'droppedByCapacity',
                         'frontendCalls', 'frontendMsMax', 'frontendPendingMs', 'clockDelayMsMax'))


def event_names():
    declaration = re.search(r'enum class Event\s*:\s*uint32_t\s*\{([^}]+)\}', HEADER.read_text())
    names = [item.strip().split()[0] for item in declaration.group(1).split(',') if item.strip()]
    return dict(enumerate(names, start=1))


MOTION_STEPS = ('', 'held', 'uart', 'bus', 'power-open', 'power-enable', 'scs')
MOTION_DETAIL = {
    'uart': ('', 'lease', 'uart1-installed', 'calibration', 'install', 'config', 'pins', 'power-not-ready'),
    'power-open': ('', 'bus-or-lease', 'expander-claim', 'expander-version', 'gpio-prepare'),
    'power-enable': ('', '', '', '', '', 'enable-write', 'enable-readback'),
    'scs': ('', 'state', 'link', 'zero', 'torque-off', 'yaw-limits', 'pitch-limits', 'feedback'),
}


def interpret(event, detail):
    if event == 'MotionOpenFailed':
        step = MOTION_STEPS[detail >> 16] if (detail >> 16) < len(MOTION_STEPS) else detail >> 16
        low = detail & 0xff
        names = MOTION_DETAIL.get(step, ())
        result = {'step': step, 'cause': names[low] if low < len(names) else low}
        if step == 'scs' and low == 2:
            uart = (detail >> 8) & 0xff
            result['uart'] = MOTION_DETAIL['uart'][uart] if uart < 8 else uart
        return result
    if event == 'MotionLimits':
        return {'axis': ('yaw', 'pitch')[(detail >> 20) & 1], 'min': (detail >> 10) & 0x3ff, 'max': detail & 0x3ff}
    if event == 'MotionTorqueProbe':
        count = lambda value: -1 if value == 3 else value
        return {'axis': ('yaw', 'pitch')[detail >> 31], 'linkHealthy': bool((detail >> 30) & 1),
                'writeCount': count((detail >> 28) & 3), 'readCount': count((detail >> 26) & 3),
                'writeError': bool((detail >> 25) & 1), 'readError': bool((detail >> 24) & 1),
                'writeStatus': (detail >> 16) & 0xff, 'readStatus': (detail >> 8) & 0xff, 'torque': detail & 0xff}
    if event == 'MotionServoInfo':
        return {'axis': ('yaw', 'pitch')[detail >> 31], 'lastWriteAcked': bool((detail >> 25) & 1),
                'read': bool((detail >> 24) & 1), 'baudCode': (detail >> 16) & 0xff,
                'returnDelay': (detail >> 8) & 0xff, 'responseLevel': detail & 0xff}
    if event == 'SensorOpenFailed':
        steps = {1: 'bus-open', 2: 'chip-id-read', 3: 'wrong-chip-id', 4: 'status-read', 5: 'config-load',
                 6: 'settings-read', 7: 'configure', 0x10: 'ten-reads-not-ready', 0x11: 'ten-read-errors'}
        step = detail & 0xffff
        return {'sensor': ('ambient', 'head-touch', 'imu')[detail >> 16] if (detail >> 16) < 3 else detail >> 16,
                'step': steps.get(step, step)}
    if event == 'MotionOpenAttempts':
        return {'attempts': detail >> 16, 'waitedMs': detail & 0xffff}
    if event == 'TouchPosition':
        return {'x': detail >> 16, 'y': detail & 0xffff}
    if event == 'Boot' and detail < len(RESET_REASONS):
        return RESET_REASONS[detail]
    if event == 'UsbPumpExit' and detail < len(USB_END):
        return USB_END[detail]
    if event in ('SessionPhase', 'UiSessionTick') and detail < len(PHASES):
        return PHASES[detail]
    if event in ('ResourceCheck', 'ResourceSample') and 0 < detail <= len(RESOURCE_NAMES):
        return RESOURCE_NAMES[detail-1]
    if event == 'ReleasePending':
        return {name: ('pending', 'done', 'failed', 'unknown')[(detail >> (2*index)) & 3]
                for index, name in enumerate(RESOURCE_NAMES[:7])}
    if event == 'ResourceStates':
        return {name: {'phase': (detail >> (4*index)) & 15, 'error': (detail >> (16+4*index)) & 15}
                for index, name in enumerate(RESOURCE_NAMES[:4])}
    if event == 'UsbTlsResult' and detail >= 2**31:
        return detail - 2**32
    return detail


def decode(data):
    if len(data) < HEAD.size:
        raise ValueError('Incomplete Sion trace header')
    magic, schema, size, boot = HEAD.unpack_from(data)
    lane_names = SCHEMAS.get(schema, ())
    if (magic != MAGIC or not boot or not lane_names or size != len(data) or
            size != HEAD.size + len(lane_names) * LANE_BYTES):
        raise ValueError('Sion trace is missing, has lost retention, or belongs to a different layout')
    names = event_names()

    def entry(offset):
        sequence, entry_boot, ms, code, detail = ENTRY.unpack_from(data, offset)
        if not sequence or not 0 < entry_boot <= boot or code not in names:
            return None
        event = names[code]
        return dict(sequence=sequence, boot=entry_boot, deviceMs=ms, event=event, detail=interpret(event, detail))

    lanes = {}
    for index, name in enumerate(lane_names):
        offset = HEAD.size + index * LANE_BYTES
        latest, = struct.unpack_from('<I', data, offset)
        checkpoint = entry(offset + 4)
        checkpoint_sequence, = struct.unpack_from('<I', data, offset + 4)
        records = []
        for slot in range(CAPACITY):
            record = entry(offset + 4 + ENTRY.size * (slot + 1))
            if record and latest and (record['sequence']-1) % CAPACITY == slot:
                sequence = record['sequence']
                age = (latest-sequence) % SERIAL_MASK
                if age < CAPACITY:
                    records.append((age, record))
        lanes[name] = {'checkpoint': checkpoint,
                       'checkpointHealth': 'valid' if checkpoint else 'invalid' if checkpoint_sequence else 'uncommitted-or-unused',
                       'events': [row for _,row in sorted(records, reverse=True)]}
    report = {'schema': schema, 'currentBoot': boot, 'lanes': lanes}
    if schema >= 2:
        report['touchscreen'] = touchscreen_report(lanes, boot)
    return report


def touchscreen_report(lanes, boot):
    def events(lane, name):
        return [row for row in lanes[lane]['events'] if row['boot'] == boot and row['event'] == name]

    def by_detail(lane, name):
        return {row['detail']: row['deviceMs'] for row in events(lane, name)}

    def pairs(lane, name):
        return [(row['detail'] >> 16, row['detail'] & 0xffff, row['deviceMs']) for row in events(lane, name)]

    def page_name(number):
        return PAGES[number] if number < len(PAGES) else number

    down = by_detail('touch', 'TouchDown')
    up = by_detail('touch', 'TouchUp')
    positions = {row['deviceMs']: row['detail'] for row in events('touch', 'TouchPosition')}
    lvgl_down = by_detail('lvgl', 'TouchLvglDown')
    lvgl_up = by_detail('lvgl', 'TouchLvglUp')
    started = {batch: (page, ms) for batch, page, ms in pairs('actions', 'UiActionStarted')}
    finished = {batch: (page, ms) for batch, page, ms in pairs('actions', 'UiActionFinished')}
    built = {revision: (page, ms) for revision, page, ms in pairs('actions', 'PageBuilt')}
    flush = by_detail('lvgl', 'PageFlushStarted')
    done = by_detail('lcd', 'PageFlushCompleted')
    maps = {}
    for row in lanes['actions']['events']:
        if row['boot'] != boot or row['event'] not in ('PageBuildStart', 'PageContentChanged'):
            continue
        batch, revision = row['detail'] >> 16, row['detail'] & 0xffff
        ms = row['deviceMs']
        kind = 'transition' if row['event'] == 'PageBuildStart' else 'content'
        frame = {'revision': revision, 'kind': kind, 'buildStartedMs': ms,
                 'lastObserved': 'building-page' if kind == 'transition' else 'page-content-changed'}
        if revision in built and built[revision][1] >= ms:
            page, built_ms = built[revision]
            frame.update(page=page_name(page), builtMs=built_ms, lastObserved='page-built')
            if revision in flush and flush[revision] >= built_ms:
                frame.update(flushStartedMs=flush[revision], lastObserved='lcd-transfer-started')
                if revision in done and done[revision] >= flush[revision]:
                    frame.update(flushCompletedMs=done[revision], lastObserved='lcd-transfer-completed')
        maps.setdefault(batch, []).append(frame)

    actions = {}
    unattributed = []
    for batch, gesture, ms in pairs('actions', 'UiActionQueued'):
        action = {'batch': batch, 'queuedMs': ms, 'lastObserved': 'app-action-queued'}
        if batch in started and started[batch][1] >= ms:
            page, begun_ms = started[batch]
            action.update(startedMs=begun_ms, pageBefore=page_name(page), lastObserved='app-action-started')
            if batch in finished and finished[batch][1] >= begun_ms:
                page, ended_ms = finished[batch]
                action.update(finishedMs=ended_ms, pageAfter=page_name(page), lastObserved='app-action-finished')
            frames = [frame for frame in maps.get(batch, []) if frame['buildStartedMs'] >= begun_ms]
            if frames:
                action['pages'] = frames
                action['lastObserved'] = frames[-1]['lastObserved']
            elif 'finishedMs' in action:
                action['lastObserved'] = 'handled-without-page-build'
        if gesture and (gesture in down and down[gesture] <= ms or gesture in lvgl_down and lvgl_down[gesture] <= ms):
            actions.setdefault(gesture, []).append(action)
        else:
            unattributed.append({'gesture': gesture or None, **action})

    interactions = []
    for gesture in sorted(down.keys() | lvgl_down.keys(), key=lambda key: down.get(key, lvgl_down.get(key, 0))):
        if not gesture:
            continue
        row = {'gesture': gesture, 'lastObserved': 'driver-sampled'}
        for name, receipts in (('driverDownMs', down), ('driverUpMs', up),
                               ('lvglDownMs', lvgl_down), ('lvglUpMs', lvgl_up)):
            if gesture in receipts and receipts[gesture] >= down.get(gesture, 0):
                row[name] = receipts[gesture]
        if 'lvglDownMs' in row:
            row['lastObserved'] = 'lvgl-input-sampled'
        if gesture in down and down[gesture] in positions:
            row['position'] = positions[down[gesture]]
        if gesture in actions:
            row['actions'] = actions[gesture]
            row['lastObserved'] = actions[gesture][-1]['lastObserved']
        interactions.append(row)

    samplers = {}
    for name, event in (('touch', 'TouchDriverAlive'), ('lvgl', 'TouchLvglAlive')):
        checkpoint = lanes[name]['checkpoint']
        current = checkpoint and checkpoint['boot'] == boot and checkpoint['event'] == event
        samplers[name] = {'lastSampleMs': checkpoint['deviceMs'] if current else None,
                          'checkpointHealth': lanes[name]['checkpointHealth']}
    return {'interactions': interactions, 'unattributedActions': unattributed,
            'unattributedPageUpdates': maps.get(0, []), 'samplers': samplers,
            'driverReadErrors': events('touch', 'TouchReadError'),
            'driverReadRecoveries': events('touch', 'TouchReadRecovered')}


def load_snapshot(path):
    with path.open('rb') as stream:
        return decode(stream.read(BYTES+1))


def compare_checkpoints(previous, current):
    result = {}
    for name, lane in current['lanes'].items():
        earlier = previous['lanes'][name]['checkpoint']
        latest = lane['checkpoint']
        result[name] = None if earlier is None or latest is None else earlier != latest
    return result


def host_events(paths, selected_run):
    rows = []
    for path in paths:
        if path.stat().st_size > 1024 * 1024:
            raise ValueError('Expected a bounded profile voice diagnostics file')
        for line in path.read_text(errors='replace').splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue  # Crash or interruption may leave one incomplete line.
            if isinstance(row, dict) and row.get('version') == 1 and isinstance(row.get('run'), str):
                rows.append({key: value for key, value in row.items() if key in HOST_FIELDS})
    if not rows:
        return []
    selected_run = selected_run or rows[-1]['run']
    return [row for row in rows if row['run'] == selected_run]


def digest(path):
    result = sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            result.update(block)
    return result.hexdigest()


def openocd_config(adapter_serial, gdb_port):
    if not re.fullmatch(r'[A-Za-z0-9:._-]{1,80}', adapter_serial):
        raise ValueError('Supply the reviewed USB JTAG adapter serial')
    if not 1024 <= gdb_port <= 65535:
        raise ValueError('Choose an unprivileged GDB port')
    return f'''# Load with the pinned ESP32 OpenOCD. Pass -c init only to attach to the reviewed device.
noinit
bindto 127.0.0.1
# The board's gdb-attach callback can otherwise reset the target to disable memory protection.
set ESP_FLASH_SIZE 0
source [find board/esp32s3-builtin.cfg]
adapter serial {{{adapter_serial}}}
gdb flash_program disable
gdb memory_map disable
gdb port {gdb_port}
telnet port disabled
tcl port disabled
'''


def debugger_command(prepared, nm, dump):
    receipt = json.loads((prepared/'.agent-build.json').read_text())
    elf = prepared/'firmware/build/stack-chan.elf'
    if digest(elf) != receipt['artifacts'][elf.name]['sha256']:
        raise ValueError('Debugger ELF does not match the candidate build receipt')
    if digest(HEADER) != receipt['inputs']['firmware/agent/device_trace.h']:
        raise ValueError('Use the diagnostic decoder from the build checkout')
    symbols = subprocess.check_output([str(nm), '-S', '--defined-only', str(elf)], text=True)
    matches = re.findall(r'^([0-9a-f]+)\s+([0-9a-f]+)\s+\w\s+sion_device_trace$', symbols, re.M)
    if len(matches) != 1 or int(matches[0][1], 16) != BYTES:
        raise ValueError('Candidate ELF is missing the expected trace symbol')
    address = int(matches[0][0], 16)
    if not 0x50000000 <= address <= 0x50002000 - BYTES:
        raise ValueError('The ESP32-S3 trace must be located in RTC slow memory')
    return f'''# Sourcing only defines a command. Attach using the device_trace.py openocd configuration.
# sion-capture temporarily halts the attached target. No reset, flash, variable write or breakpoint.
python
import gdb
from pathlib import Path
class SionCapture(gdb.Command):
    def __init__(self):
        super().__init__("sion-capture", gdb.COMMAND_USER)
    def invoke(self, args, from_tty):
        del args, from_tty
        path = Path({str(dump.resolve())!r})
        if path.exists():
            raise gdb.GdbError("Choose a new diagnostic output")
        try:
            gdb.execute("monitor halt")
            payload = bytes(gdb.selected_inferior().read_memory({address}, {BYTES}))
            with path.open("xb") as handle:
                handle.write(payload)
            gdb.execute("set print frame-arguments none")
            gdb.execute("info threads")
            gdb.execute("thread apply all bt 5")
        finally:
            gdb.execute("monitor resume")
SionCapture()
end
'''


def self_test(executable):
    with tempfile.TemporaryDirectory(prefix='sion-trace-test-') as name:
        dump = Path(name)/'trace.bin'
        subprocess.run([executable,str(dump)],check=True)
        decoded = load_snapshot(dump)
        lanes = decoded['lanes']
        assert decoded['currentBoot'] == 2
        assert [row['detail'] for row in lanes['boot']['events'] if row['event'] == 'Boot'] == ['power-on','watchdog']
        assert [row['sequence'] for row in lanes['ui']['events']] == list(range(4,35))
        assert lanes['ui']['checkpoint']['detail'] == 'carrier'
        assert lanes['audio']['checkpoint']['event'] == 'AudioClosing'
        assert lanes['usb']['events'][-1]['detail'] == 'peer-quiet'
        assert compare_checkpoints(decoded, decoded)['ui'] is False
        raw = bytearray(dump.read_bytes())
        ui_checkpoint_boot = HEAD.size + LANE_BYTES + 8
        struct.pack_into('<I', raw, ui_checkpoint_boot, decoded['currentBoot'] + 1)
        damaged = decode(raw)
        assert damaged['lanes']['ui']['checkpointHealth'] == 'invalid'
        assert compare_checkpoints(decoded, damaged)['ui'] is None
        touch = decoded['touchscreen']
        assert [row['lastObserved'] for row in touch['interactions']] == [
            'driver-sampled', 'lvgl-input-sampled', 'app-action-queued', 'app-action-started',
            'building-page', 'lcd-transfer-started', 'lcd-transfer-completed',
            'handled-without-page-build', 'lcd-transfer-completed', 'lvgl-input-sampled',
        ]
        assert touch['interactions'][0]['position'] == {'x':40,'y':148}
        assert touch['interactions'][6]['actions'][0]['pages'][0]['page'] == 'Settings'
        assert touch['interactions'][8]['actions'][0]['pages'][0]['kind'] == 'content'
        assert len(touch['driverReadErrors']) == len(touch['driverReadRecoveries']) == 1
        legacy_size = HEAD.size + len(LEGACY_LANES) * LANE_BYTES
        legacy = raw[:legacy_size]
        HEAD.pack_into(legacy, 0, MAGIC, 1, legacy_size, decoded['currentBoot'])
        assert decode(legacy)['schema'] == 1 and 'touchscreen' not in decode(legacy)
        try:
            decode(bytes(BYTES))
        except ValueError:
            pass
        else:
            raise AssertionError('An uninitialized RTC dump must be rejected')
        logfile = dump.with_suffix('.jsonl')
        logfile.write_text('{"version":1,"run":"fixture","event":"link-ended","payload":"private"}\n{"version":')
        assert host_events([logfile], None) == [{'run':'fixture','event':'link-ended'}]
        config = openocd_config('00:11:22:33:44:55', 3375)
        assert config.index('set ESP_FLASH_SIZE 0') < config.index('source [find board/')
        assert 'gdb flash_program disable\n' in config and 'gdb memory_map disable\n' in config
        for serial, port in [('bad}\ninit', 3375), ('fixture', 23)]:
            try:
                openocd_config(serial, port)
            except ValueError:
                continue
            raise AssertionError('Invalid debugger settings must be rejected')
    print('C++ recorder and host decoder agree after an interrupted entry and a retained reset')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', type=Path, help=argparse.SUPPRESS)
    modes = parser.add_subparsers(dest='command')
    decode_args = modes.add_parser('decode')
    decode_args.add_argument('dump', type=Path, nargs='?', help='Optional when Mac logs are available')
    decode_args.add_argument('--mac', type=Path, action='append', default=[], help='Older Mac JSONL first; may be repeated')
    decode_args.add_argument('--run', help='Select a specific Mac diagnostic run')
    decode_args.add_argument('--previous-device', type=Path, help='Compare two device snapshots before a reset')
    gdb_args = modes.add_parser('gdb')
    for name in ('prepared', 'nm', 'dump', 'output'):
        gdb_args.add_argument('--'+name, type=Path, required=True)
    openocd_args = modes.add_parser('openocd')
    openocd_args.add_argument('--adapter-serial', required=True)
    openocd_args.add_argument('--gdb-port', type=int, default=3375)
    openocd_args.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.self_test:
        self_test(args.self_test)
    elif args.command == 'gdb':
        program = debugger_command(args.prepared,args.nm,args.dump)
        with args.output.open('x') as out:
            out.write(program)
    elif args.command == 'openocd':
        try:
            config = openocd_config(args.adapter_serial, args.gdb_port)
        except ValueError as error:
            parser.error(str(error))
        with args.output.open('x') as out:
            out.write(config)
    elif args.command == 'decode':
        if not args.dump and not args.mac:
            parser.error('Supply a device dump, Mac JSONL, or both')
        report = {}
        if args.dump:
            try:
                report['device'] = load_snapshot(args.dump)
            except (FileNotFoundError, ValueError):
                if not args.mac:
                    raise
                report['deviceEvidence'] = 'unavailable'
        if args.previous_device and not args.dump:
            parser.error('--previous-device also needs a current device dump')
        if args.previous_device and 'device' in report:
            previous = load_snapshot(args.previous_device)
            now = report['device']
            report['sameBoot'] = (previous['schema'] == now['schema'] and
                                  previous['currentBoot'] == now['currentBoot'])
            if report['sameBoot']:
                report['checkpointAdvanced'] = compare_checkpoints(previous, now)
        if args.mac:
            report['macEvents'] = host_events(args.mac,args.run)
            report['clocks'] = 'Independent clocks; match the operation and capture number before comparing elapsed times.'
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        parser.error('Select decode, gdb or openocd')


if __name__ == '__main__':
    main()
