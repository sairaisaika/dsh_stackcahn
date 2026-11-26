# Read the running DSH.AGENT's event trace and health ring over the built-in
# USB JTAG without resetting it.
#
#   zsh scripts/capture_live_state.zsh <trial-dir> <prepared-dir> <label> [--stacks] [--voice-active]
#
# The interrupt watchdog (800 ms in this build) keeps counting while both cores
# are halted, and an expired one panics the device right after resume; with a
# debugger once attached, the panic then waits instead of rebooting (seen in the
# v61 trial after a GDB capture that walked every stack). So the default path
# uses OpenOCD alone, with RTOS awareness off: halt, copy two RTC regions,
# resume, and report the halt in milliseconds. No GDB connection, no reset,
# write or breakpoint.
#
# --stacks additionally attaches GDB afterwards to walk every task's stack. That
# is slow enough to trip the watchdog: use it only as the last capture before a
# restore. --voice-active allows the capture while the voice service holds the
# serial port: JTAG is a separate interface of the same USB device (v56 also
# captured with its host attached). <trial-dir>/identified-device.json supplies
# the reviewed USB serial.
set -eu
umask 077
trial="$1"
prepared="$2"
label="$3"
stacks=''
voice_active=''
for option in "${@:4}"; do
  case "$option" in
    --stacks) stacks=1 ;;
    --voice-active) voice_active=1 ;;
    *) echo 'Unknown option'; exit 2 ;;
  esac
done
[[ "$label" =~ ^[a-z0-9-]{1,40}$ ]] || { echo 'Use a short lowercase label'; exit 2; }
tools="$PWD/work/idf-tools/tools"
ocd="$tools/openocd-esp32/v0.12.0-esp32-20260703/openocd-esp32"
gdb="$tools/xtensa-esp-elf-gdb/17.1_20260402/xtensa-esp-elf-gdb/bin/xtensa-esp32s3-elf-gdb"
nm="$tools/xtensa-esp-elf/esp-15.2.0_20251204/xtensa-esp-elf/bin/xtensa-esp32s3-elf-nm"
py='/opt/homebrew/bin/python3.13'
out="$trial/live-$label"
[[ ! -e "$out" ]] || { echo 'Choose a new label'; exit 2; }
mkdir "$out"
serial=$("$py" -c 'import json,sys;print(json.load(open(sys.argv[1]))["usbSerial"])' "$trial/identified-device.json")
port=$("$py" -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$trial/identified-device.json")
[[ "$serial" =~ ^[A-Za-z0-9:._-]{1,80}$ ]]
# esptool or the voice service must not hold the port while the probe attaches.
if [[ -z "$voice_active" ]] && /usr/sbin/lsof -t "$port" > /dev/null 2>&1; then echo 'Serial port in use'; exit 3; fi
if lsof -nP -t -iTCP:3375 -sTCP:LISTEN > /dev/null 2>&1; then echo 'GDB port 3375 already in use'; exit 3; fi

# Addresses come from the reviewed ELF, checked against the build receipt.
regions=$("$py" - "$prepared" "$nm" <<'PY'
import hashlib, json, re, subprocess, sys
from pathlib import Path
prepared, nm = Path(sys.argv[1]), sys.argv[2]
receipt = json.loads((prepared/'.agent-build.json').read_text())
elf = prepared/'firmware/build/stack-chan.elf'
assert hashlib.sha256(elf.read_bytes()).hexdigest() == receipt['artifacts'][elf.name]['sha256'], 'ELF differs from the receipt'
symbols = subprocess.check_output([nm, '-S', '--defined-only', str(elf)], text=True)
found = {}
for name, size in (('sion_device_trace', 5992), ('sion_device_health', 1456)):
    match = re.findall(rf'^([0-9a-f]+)\s+([0-9a-f]+)\s+\w\s+{name}$', symbols, re.M)
    assert len(match) == 1 and int(match[0][1], 16) == size, name
    address = int(match[0][0], 16)
    assert 0x50000000 <= address and address + size <= 0x50002000, name
    found[name] = (address, size)
print('0x%x %d 0x%x %d' % (*found['sion_device_trace'], *found['sion_device_health']))
PY
)
read trace_addr trace_size health_addr health_size <<< "$regions"

cat > "$out/openocd.cfg" <<EOF
# Pinned ESP32 OpenOCD; attach to the reviewed device only.
noinit
bindto 127.0.0.1
set ESP_FLASH_SIZE 0
set ESP_RTOS none
source [find board/esp32s3-builtin.cfg]
adapter serial {$serial}
gdb flash_program disable
gdb memory_map disable
gdb port disabled
telnet port disabled
tcl port disabled
EOF
"$ocd/bin/openocd" -s "$ocd/share/openocd/scripts" -f "$out/openocd.cfg" \
  -c init \
  -c 'set sion_start [clock milliseconds]' \
  -c 'halt 200' \
  -c "dump_image {$out/trace.bin} $trace_addr $trace_size" \
  -c "dump_image {$out/health.bin} $health_addr $health_size" \
  -c resume \
  -c 'echo "sion halt ms: [expr {[clock milliseconds] - $sion_start}]"' \
  -c shutdown > "$out/openocd.log" 2>&1 || { echo 'OpenOCD capture failed; see openocd.log'; exit 4; }
rg 'sion halt ms' "$out/openocd.log" || echo 'Halt duration not reported'

if [[ -n "$stacks" ]]; then
  # Separate, slow pass: expect a watchdog panic afterwards.
  sed -e 's/^gdb port disabled$/gdb port 3375/' -e 's/^set ESP_RTOS none$//' "$out/openocd.cfg" > "$out/openocd-stacks.cfg"
  "$py" scripts/device_trace.py gdb --prepared "$prepared" --nm "$nm" --dump "$out/trace-with-stacks.bin" --output "$out/trace.gdb"
  "$ocd/bin/openocd" -s "$ocd/share/openocd/scripts" -f "$out/openocd-stacks.cfg" -c init > "$out/openocd-stacks.log" 2>&1 &
  probe=$!
  trap 'kill "$probe" 2>/dev/null || true; wait "$probe" 2>/dev/null || true' EXIT
  for i in {1..50}; do
    kill -0 "$probe" 2>/dev/null || { echo 'OpenOCD exited; see openocd-stacks.log'; exit 4; }
    if rg -q 'Listening on port 3375 for gdb connections' "$out/openocd-stacks.log"; then break; fi
    sleep 0.1
  done
  "$gdb" -nx -batch -iex 'set auto-load off' "$prepared/firmware/build/stack-chan.elf" -ex 'set remotetimeout 4' \
    -x "$out/trace.gdb" -ex 'target remote 127.0.0.1:3375' -ex 'sion-capture' > "$out/gdb.log" 2>&1 || true
fi
# OpenOCD reports the chip's last reset cause on attach; continuity of the
# health ring (same boot, new sequence numbers) is the real no-reset check.
"$py" scripts/device_trace.py decode "$out/trace.bin" > "$out/trace.json" || echo 'Trace did not decode'
"$py" scripts/device_health.py table "$out/health.bin" | tee "$out/health.txt" || echo 'Health ring did not decode'
printf '%s\n' "Live state saved in $out."
