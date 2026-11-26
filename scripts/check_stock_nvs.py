"""Inspect Sion's saved factory NVS with the pinned SDK and report redacted findings."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from check_agent_preflight import ROOT, read_snapshot
from inspect_backup import inspect_partitions
from prepare_agent_bundle import EXPECTED_PARTITIONS, STOCK_LOCK


SDK_COMPONENT = 'components/nvs_flash/nvs_partition_tool'
SDK_MODULES = ('nvs_parser', 'nvs_logger', 'nvs_check')
_, _, NVS_OFFSET, NVS_SIZE = EXPECTED_PARTITIONS['nvs']
SDK_PREAMBLE = """
import json
import os
import sys
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, sys.argv[1])
from nvs_check import integrity_check
from nvs_logger import NVS_Logger
from nvs_parser import NVS_Partition

class Counts(NVS_Logger):
    def __init__(self):
        super().__init__(color='never')
        self.anomalies = 0
        self.warnings = Counter()

    def red(self, value):
        self.anomalies += 1
        return ''

    def yellow(self, value):
        category = 'unused-namespace' if value == 'Found unused namespace.' else 'other'
        self.warnings[category] += 1
        return ''

    def error(self, *args, **kwargs):
        self.anomalies += 1

    def info(self, *args, **kwargs):
        pass

"""

RUN_INSPECTOR = SDK_PREAMBLE + """
def saved_ai_autostart(partition, status):
    if status != 'checked' or any(not page.is_empty and page.header['status'] not in ('Active', 'Full')
                                  for page in partition.pages):
        return 'unknown'
    entries = [entry for page in partition.pages for entry in page.entries if entry.state == 'Written']
    spaces = [entry for entry in entries if entry.metadata['namespace'] == 0 and entry.key == 'xiaozhi']
    if not spaces:
        return 'not-recorded'
    if len(spaces) != 1 or spaces[0].metadata['type'] != 'uint8_t':
        return 'unknown'
    space = spaces[0].data['value']
    if not 0 < space < 255:
        return 'unknown'
    flags = [entry for entry in entries if entry.metadata['namespace'] == space and entry.key == 'boot_ai']
    if not flags:
        return 'not-recorded'
    if len(flags) != 1 or flags[0].metadata['type'] != 'uint8_t':
        return 'unknown'
    return {0: 'disabled', 1: 'enabled'}.get(flags[0].data['value'], 'unknown')

sink = Counts()
with open(os.devnull, 'w') as discard, redirect_stdout(discard), redirect_stderr(discard):
    partition = NVS_Partition('stock-nvs', bytearray(sys.stdin.buffer.read()))
    integrity_check(partition, sink)

written = sum(entry.state == 'Written' for page in partition.pages for entry in page.entries)
invalid_states = sum(page.header['status'] in ('Corrupted', 'Invalid') for page in partition.pages)
unknown_versions = sum(not page.is_empty and page.header['version'] > 2 for page in partition.pages)
status = 'checked' if written else 'no-written-entries'
if sink.anomalies or invalid_states or unknown_versions:
    status = 'issues-found'
report = {
    'status': status,
    'pages': len(partition.pages),
    'emptyPages': sum(page.is_empty for page in partition.pages),
    'writtenEntries': written,
    'sdkAnomalyIndicators': sink.anomalies,
    'sdkWarnings': dict(sink.warnings),
    'invalidPageStates': invalid_states,
    'unsupportedVersionPages': unknown_versions,
}
if sys.argv[2] == '1':
    report['savedAiAutostart'] = saved_ai_autostart(partition, status)
print(json.dumps(report))
"""


RUN_COMPARISON = SDK_PREAMBLE + """
from collections import defaultdict

MANAGED = {('app_dsh_menu', 'launch_v1'), ('feature_toggles', 'dsh_visible')}

def variable_bytes(entry):
    size = entry.data['size']
    payload = b''.join(bytes(child.raw) for child in entry.children)
    if size > len(payload) or any(child.state != 'Written' for child in entry.children):
        raise ValueError('missing variable data')
    return payload[:size]

def logical_value(entries):
    if len(entries) == 1:
        entry = entries[0]
        kind = entry.metadata['type']
        if kind.endswith('_t'):
            return kind, entry.data['value']
        if kind in ('string', 'blob'):
            return kind, variable_bytes(entry)
    indices = [entry for entry in entries if entry.metadata['type'] == 'blob_index']
    chunks = {entry.metadata['chunk_index']: entry for entry in entries if entry.metadata['type'] == 'blob_data'}
    if len(indices) != 1 or len(chunks) != len(entries)-1:
        raise ValueError('ambiguous live item')
    index = indices[0].data
    order = range(index['chunk_start'], index['chunk_start'] + index['chunk_count'])
    if chunks.keys() != set(order):
        raise ValueError('missing or duplicated blob chunk')
    value = b''.join(variable_bytes(chunks[number]) for number in order)
    if len(value) != index['size']:
        raise ValueError('incomplete blob')
    return 'blob', value

def logical_settings(raw):
    sink = Counts()
    partition = NVS_Partition('stock-nvs', bytearray(raw))
    integrity_check(partition, sink)
    if (sink.anomalies or sink.warnings.get('other') or
            any(not page.is_empty and (page.header['status'] not in ('Active', 'Full') or
                                      page.header['version'] not in (1, 2)) for page in partition.pages)):
        raise ValueError('unsupported or inconsistent NVS')
    entries = [entry for page in partition.pages for entry in page.entries if entry.state == 'Written']
    namespaces = {}
    grouped = defaultdict(list)
    for entry in entries:
        number = entry.metadata['namespace']
        if not entry.key:
            raise ValueError('unreadable key')
        if number == 0:
            index = entry.data['value']
            if (entry.metadata['type'] != 'uint8_t' or not 0 < index < 255 or
                    index in namespaces or entry.key in namespaces.values()):
                raise ValueError('ambiguous namespace')
            namespaces[index] = entry.key
        else:
            grouped[number, entry.key].append(entry)
    return ({(namespaces[number], key): logical_value(items) for (number, key), items in grouped.items()},
            set(namespaces.values()))

def valid_managed(key, value):
    if value is None:
        return False
    kind, data = value
    if key == ('feature_toggles', 'dsh_visible'):
        return kind == 'uint8_t' and data in (0, 1)
    return (kind == 'blob' and len(data) == 96 and any(data[:32]) and
            all(byte in b'0123456789abcdef' for byte in data[32:]))

raw = sys.stdin.buffer.read()
middle = len(raw)//2
try:
    with open(os.devnull, 'w') as discard, redirect_stdout(discard), redirect_stderr(discard):
        before, old_spaces = logical_settings(raw[:middle])
        if not before:
            raise ValueError('no baseline settings')
        current, new_spaces = logical_settings(raw[middle:])
except (ValueError, TypeError, KeyError, IndexError, AttributeError):
    print(json.dumps({'status': 'inconclusive'}))
    sys.exit(0)

changed = {key for key in before.keys() | current.keys() if before.get(key) != current.get(key)}
managed = changed & MANAGED
invalid = {key for key in managed if not valid_managed(key, current.get(key))}
added_managed_spaces = {key[0] for key in managed - invalid}
other_spaces = (old_spaces - new_spaces) | ((new_spaces - old_spaces) - added_managed_spaces)
protected = changed - MANAGED
status = 'only-shortcut-settings-changed' if managed else 'same-live-settings'
if invalid or protected or other_spaces:
    status = 'needs-review'
print(json.dumps({
    'status': status,
    'rawBytesMatch': raw[:middle] == raw[middle:],
    'managedKeysChanged': ['/'.join(key) for key in sorted(managed)],
    'managedKeysInvalid': ['/'.join(key) for key in sorted(invalid)],
    'otherKeysChanged': len(protected),
    'otherNamespacesChanged': len(other_spaces),
}))
"""


def run_locked_inspector(program, data, stock_sdk, *options):
    lock = json.loads(STOCK_LOCK.read_text())
    # Pass settings through stdin to the isolated SDK, and return its redacted report.
    with TemporaryDirectory(prefix='sion-nvs-sdk-') as directory:
        for module in SDK_MODULES:
            relative = f'{SDK_COMPONENT}/{module}.py'
            source = subprocess.check_output(
                ['git', '-C', str(stock_sdk), 'show', f'{lock["commit"]}:{relative}'],
                stderr=subprocess.DEVNULL, timeout=10)
            (Path(directory)/f'{module}.py').write_bytes(source)
        result = subprocess.run([sys.executable, '-I', '-B', '-c', program, directory, *options],
                                input=data, capture_output=True, timeout=10)
    if result.returncode != 0:
        raise ValueError('Locked SDK could not inspect the partition; diagnostic contents withheld')
    return {'sdk': lock['release'], 'sdkCommit': lock['commit'], **json.loads(result.stdout)}


def inspect_stock_nvs(data, stock_sdk, *, check_ai_autostart=False):
    if len(data) != NVS_SIZE:
        raise ValueError('Expected the 16 KiB factory NVS region')
    return run_locked_inspector(RUN_INSPECTOR, data, stock_sdk, str(int(check_ai_autostart)))


def compare_stock_nvs(before, current, stock_sdk):
    if len(before) != NVS_SIZE or len(current) != NVS_SIZE:
        raise ValueError('Expected two 16 KiB factory NVS regions')
    return run_locked_inspector(RUN_COMPARISON, bytes(before)+bytes(current), stock_sdk)


def factory_nvs(data):
    records = [entry for entry in inspect_partitions(data) if entry['label'] == 'nvs']
    kind, subtype, addr, size = EXPECTED_PARTITIONS['nvs']
    if len(records) != 1:
        raise ValueError('Expected exactly one factory NVS partition')
    item = records[0]
    if (item['type'], item['subtype'], int(item['offset'], 16), item['bytes'], item['flags']) != (kind, subtype, addr, size, 0):
        raise ValueError('Unrecognized factory NVS layout')
    return data[NVS_OFFSET:NVS_OFFSET+NVS_SIZE]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path, help='Saved Sion double-read directory')
    parser.add_argument('--stock-idf', type=Path, default=ROOT/'work/esp-idf-stock-v5.5.4')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--compare-to', type=Path, metavar='CURRENT',
                      help='Compare live settings with another saved double read of the same unit')
    mode.add_argument('--check-ai-autostart', action='store_true',
                        help='Include the saved stock AI autostart state when it can be read unambiguously')
    args = parser.parse_args()
    try:
        evidence = read_snapshot(args.snapshot)
        saved = factory_nvs(evidence.data)
        if args.compare_to is not None:
            current = read_snapshot(args.compare_to)
            if args.snapshot.resolve() == args.compare_to.resolve() or current.mac != evidence.mac:
                raise ValueError('Expected two captures of the same unit')
            report = compare_stock_nvs(saved, factory_nvs(current.data), args.stock_idf)
        else:
            report = inspect_stock_nvs(saved, args.stock_idf, check_ai_autostart=args.check_ai_autostart)
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        parser.exit(1, 'Factory NVS inspection could not complete. Check the double read and locked SDK.\n')
    print(json.dumps({'scope': 'saved-factory-nvs', 'deviceAccess': False, **report}, indent=2))
    return 0 if report['status'] in ('checked', 'same-live-settings', 'only-shortcut-settings-changed') else 2


if __name__ == '__main__':
    sys.exit(main())
