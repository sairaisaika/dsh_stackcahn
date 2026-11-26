"""Decode the device-health ring (sion_device_health) read from RTC memory.

The dump comes from the same no-reset JTAG capture as the event trace, or from
esptool dump-mem while the chip is in download mode. No device access here.
"""
import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

MAGIC = 0x484C5448
SCHEMA = 1
CAPACITY = 40
HEAD = struct.Struct('<4I')
SAMPLE = struct.Struct('<3I h 3H I 3H 4B H')
BYTES = HEAD.size + CAPACITY * SAMPLE.size
UNKNOWN = 0xFFFF
NO_TEMPERATURE = -32768
FLAGS = {1: 'battery_valid', 2: 'charging', 4: 'discharging', 8: 'temperature_failed', 16: 'task_table_full'}
assert SAMPLE.size == 36 and BYTES == 1456


def permille(value):
    return None if value == UNKNOWN else value / 10


def decode(data):
    if len(data) != BYTES:
        raise ValueError(f'Health dump must be {BYTES} bytes')
    magic, schema, size, latest = HEAD.unpack_from(data)
    if magic != MAGIC or schema != SCHEMA or size != BYTES:
        raise ValueError('Health ring is missing, has lost retention, or belongs to a different layout')
    samples = []
    for index in range(CAPACITY):
        (sequence, boot, ms, temperature, busy0, busy1, top, name, touch_gap, lvgl_gap, ui_gap,
         touch_errors, battery, flags, brightness, mouth_ticks) = SAMPLE.unpack_from(data, HEAD.size + index * SAMPLE.size)
        if not sequence or sequence > latest:
            continue  # Empty, torn mid-write, or stale beyond the recorded head.
        samples.append({
            'sequence': sequence, 'boot': boot, 'seconds': round(ms / 1000, 1),
            'chipCelsius': None if temperature == NO_TEMPERATURE else temperature / 10,
            'cpuBusyPercent': [permille(busy0), permille(busy1)],
            'busiestTask': name.to_bytes(4, 'little').rstrip(b'\0').decode('ascii', 'replace'),
            'busiestTaskPercent': permille(top),
            'longestGapMs': {'touchPoll': touch_gap, 'lvglRead': lvgl_gap, 'appLoop': ui_gap},
            'touchReadErrors': touch_errors,
            'batteryPercent': None if battery == 0xFF else battery,
            'brightness': None if brightness == 0xFF else brightness,
            'mouthOpenTicks': mouth_ticks,
            'flags': [label for bit, label in FLAGS.items() if flags & bit],
        })
    samples.sort(key=lambda sample: sample['sequence'])
    return {'schema': schema, 'latest': latest, 'samples': samples}


def table(report):
    rows = ['seq  boot  time(s)  chip°C  cpu0%  cpu1%  busiest(%)        touch/lvgl/app gap ms  touchErr  mouth  batt  flags']
    for s in report['samples']:
        busy = ['-' if v is None else f'{v:.0f}' for v in s['cpuBusyPercent']]
        top = '-' if s['busiestTaskPercent'] is None else f"{s['busiestTask']}({s['busiestTaskPercent']:.0f})"
        gaps = s['longestGapMs']
        rows.append(f"{s['sequence']:<4} {s['boot']:<5} {s['seconds']:<8} {s['chipCelsius'] if s['chipCelsius'] is not None else '-':<7} "
                    f"{busy[0]:<6} {busy[1]:<6} {top:<17} {gaps['touchPoll']}/{gaps['lvglRead']}/{gaps['appLoop']:<14} "
                    f"{s['touchReadErrors']:<9} {s['mouthOpenTicks']:<6} {s['batteryPercent'] if s['batteryPercent'] is not None else '-':<5} {','.join(s['flags'])}")
    return '\n'.join(rows)


def debugger_command(prepared, nm, dump, trace_dump=None):
    """GDB command `sion-health`: halt, copy the ring (and the event trace), resume.

    The halt must stay well under the interrupt watchdog (800 ms in this build):
    the watchdog keeps counting while both cores are halted, and an expired one
    panics the device right after resume. So nothing slow (stack walks) happens
    inside this halt. No reset, write or breakpoint."""
    receipt = json.loads((prepared/'.agent-build.json').read_text())
    elf = prepared/'firmware/build/stack-chan.elf'
    if hashlib.sha256(elf.read_bytes()).hexdigest() != receipt['artifacts'][elf.name]['sha256']:
        raise ValueError('Debugger ELF does not match the candidate build receipt')
    header = Path(__file__).resolve().parents[1]/'firmware/agent/device_health.h'
    if hashlib.sha256(header.read_bytes()).hexdigest() != receipt['inputs'].get('firmware/agent/device_health.h'):
        raise ValueError('Use the health decoder from the build checkout')
    symbols = subprocess.check_output([str(nm), '-S', '--defined-only', str(elf)], text=True)
    matches = re.findall(r'^([0-9a-f]+)\s+([0-9a-f]+)\s+\w\s+sion_device_health$', symbols, re.M)
    if len(matches) != 1 or int(matches[0][1], 16) != BYTES:
        raise ValueError('Candidate ELF is missing the expected health symbol')
    address = int(matches[0][0], 16)
    if not 0x50000000 <= address <= 0x50002000 - BYTES:
        raise ValueError('The health ring must be located in RTC slow memory')
    trace = re.findall(r'^([0-9a-f]+)\s+([0-9a-f]+)\s+\w\s+sion_device_trace$', symbols, re.M)
    if trace_dump is not None and (len(trace) != 1 or not 0x50000000 <= int(trace[0][0], 16) < 0x50002000):
        raise ValueError('Candidate ELF is missing the trace symbol')
    copies = [(address, BYTES, dump)] + ([(int(trace[0][0], 16), int(trace[0][1], 16), trace_dump)] if trace_dump else [])
    return f'''# Sourcing only defines a command; attach with the device_trace.py openocd configuration.
# sion-health temporarily halts the target to copy the ring. No reset, flash, variable write or breakpoint.
python
import gdb
from pathlib import Path
class SionHealth(gdb.Command):
    def __init__(self):
        super().__init__("sion-health", gdb.COMMAND_USER)
    def invoke(self, args, from_tty):
        del args, from_tty
        import time
        copies = {[(a, n, str(Path(d).resolve())) for a, n, d in copies]!r}
        if any(Path(d).exists() for _, _, d in copies):
            raise gdb.GdbError("Choose a new diagnostic output")
        payloads = []
        started = time.monotonic()
        try:
            gdb.execute("monitor halt")
            for address, size, _ in copies:
                payloads.append(bytes(gdb.selected_inferior().read_memory(address, size)))
        finally:
            gdb.execute("monitor resume")
            print(f"sion-health halted for {{(time.monotonic() - started) * 1000:.0f}} ms")
        for (_, _, path), payload in zip(copies, payloads):
            with Path(path).open("xb") as handle:
                handle.write(payload)
SionHealth()
end
'''


def self_test(binary):
    with tempfile.TemporaryDirectory() as directory:
        dump = Path(directory) / 'health.bin'
        subprocess.run([binary, str(dump)], check=True, capture_output=True)
        report = decode(dump.read_bytes())
    sequences = [s['sequence'] for s in report['samples']]
    assert report['latest'] == 4 and sequences == [1, 2, 4], sequences  # The torn third sample is dropped.
    first, last = report['samples'][0], report['samples'][-1]
    assert first['chipCelsius'] == 40.0 and first['seconds'] == 10.0 and first['boot'] == 3
    assert first['cpuBusyPercent'] == [12.0, 98.0] and first['busiestTask'] == 'sion' and first['busiestTaskPercent'] == 97.5
    assert first['longestGapMs'] == {'touchPoll': 21, 'lvglRead': 40, 'appLoop': 9000}
    assert first['touchReadErrors'] == 2 and first['batteryPercent'] == 87 and first['brightness'] == 70
    assert first['flags'] == ['battery_valid', 'charging']
    assert first['mouthOpenTicks'] == 33
    assert last['chipCelsius'] is None and 'temperature_failed' in last['flags']
    for bad in (b'', bytes(BYTES)):
        try:
            decode(bad)
        except ValueError:
            continue
        raise AssertionError('An empty or uninitialised dump must be rejected')
    print('Device health decoder agrees with the C++ layout, drops torn samples and rejects lost retention')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', metavar='BINARY', help='Check against the C++ fixture writer')
    parser.add_argument('mode', nargs='?', choices=('decode', 'table', 'gdb'))
    parser.add_argument('dump', nargs='?', type=Path)
    parser.add_argument('--prepared', type=Path, help='gdb: the prepared build checkout')
    parser.add_argument('--nm', type=Path, help='gdb: the pinned xtensa nm')
    parser.add_argument('--output', type=Path, help='gdb: where to write the command file')
    parser.add_argument('--trace-dump', type=Path, help='gdb: also copy sion_device_trace here in the same halt')
    args = parser.parse_args()
    if args.self_test:
        self_test(args.self_test)
        return
    if args.mode == 'gdb':
        if not (args.prepared and args.nm and args.output and args.dump):
            parser.error('gdb needs the dump path plus --prepared, --nm and --output')
        with args.output.open('x') as out:
            out.write(debugger_command(args.prepared, args.nm, args.dump, args.trace_dump))
        return
    if not args.mode or not args.dump:
        parser.error('decode or table needs a dump file')
    report = decode(args.dump.read_bytes())
    print(json.dumps(report, indent=2) if args.mode == 'decode' else table(report))


if __name__ == '__main__':
    main()
