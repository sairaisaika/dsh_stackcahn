# Copy the event trace and health ring out of RTC slow memory while the chip
# sits in the ROM download mode, e.g. right after the restore script's
# usb-reset entry and before any Flash read or write. Read-only: esptool
# dump-mem with no reset before or after. RTC slow memory survives a system
# reset but not a power cycle (a long RST press); a lost copy simply fails to
# decode.
#
#   zsh scripts/capture_rom_records.zsh <trial-dir> <prepared-dir> <label>
set -eu
umask 077
trial="$1"
prepared="$2"
label="$3"
[[ "$label" =~ ^[a-z0-9-]{1,40}$ ]] || { echo 'Use a short lowercase label'; exit 2; }
py_idf="$PWD/work/idf-tools/python_env/idf6.1_py3.15_env/bin/python"
py='/opt/homebrew/bin/python3.13'
nm="$PWD/work/idf-tools/tools/xtensa-esp-elf/esp-15.2.0_20251204/xtensa-esp-elf/bin/xtensa-esp32s3-elf-nm"
out="$trial/rom-$label"
[[ ! -e "$out" ]] || { echo 'Choose a new label'; exit 2; }
mkdir "$out"
port=$("$py" -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$trial/identified-device.json")
if /usr/sbin/lsof -t "$port" > /dev/null 2>&1; then echo 'Serial port in use'; exit 3; fi
regions=$("$py" - "$prepared" "$nm" <<'PY'
import hashlib, json, re, subprocess, sys
from pathlib import Path
prepared, nm = Path(sys.argv[1]), sys.argv[2]
receipt = json.loads((prepared/'.agent-build.json').read_text())
elf = prepared/'firmware/build/stack-chan.elf'
assert hashlib.sha256(elf.read_bytes()).hexdigest() == receipt['artifacts'][elf.name]['sha256'], 'ELF differs from the receipt'
symbols = subprocess.check_output([nm, '-S', '--defined-only', str(elf)], text=True)
found = []
for name, size in (('sion_device_trace', 5992), ('sion_device_health', 1456)):
    match = re.findall(rf'^([0-9a-f]+)\s+([0-9a-f]+)\s+\w\s+{name}$', symbols, re.M)
    assert len(match) == 1 and int(match[0][1], 16) == size, name
    address = int(match[0][0], 16)
    assert 0x50000000 <= address and address + size <= 0x50002000, name
    found.append((address, size))
start = min(a for a, _ in found); end = max(a + n for a, n in found)
print('0x%x %d %d %d %d %d' % (start, end - start, found[0][0] - start, found[0][1], found[1][0] - start, found[1][1]))
PY
)
read base span trace_off trace_size health_off health_size <<< "$regions"
export ESPTOOL_OPEN_PORT_ATTEMPTS=1
"$py_idf" -I -m esptool --chip esp32s3 --port "$port" --connect-attempts 1 --before no-reset --after no-reset --no-stub \
  dump-mem "$base" "$span" "$out/rtc.bin" > "$out/esptool.log" 2>&1 || { echo 'Device is not in download mode; nothing read'; exit 4; }
"$py" - "$out" "$trace_off" "$trace_size" "$health_off" "$health_size" <<'PY'
import sys
from pathlib import Path
out = Path(sys.argv[1]); trace_off, trace_size, health_off, health_size = map(int, sys.argv[2:])
data = (out/'rtc.bin').read_bytes()
(out/'trace.bin').write_bytes(data[trace_off:trace_off + trace_size])
(out/'health.bin').write_bytes(data[health_off:health_off + health_size])
PY
"$py" scripts/device_trace.py decode "$out/trace.bin" > "$out/trace.json" || echo 'Trace did not survive (power cycle?)'
"$py" scripts/device_health.py table "$out/health.bin" | tee "$out/health.txt" || echo 'Health ring did not survive (power cycle?)'
printf '%s\n' "RTC records copied to $out without a reset."
