"""Generate hardware-only GDB probes for the reviewed v54 startup or Home return."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

from prepare_firmware import sha


ROOT = Path(__file__).resolve().parents[1]
USB_WORKER = 'sion::agent::(anonymous namespace)::PairingUsb::Worker()'


def call_and_return(assembly, target):
    instructions = re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]+)\s+(.*?)\s*$', assembly, re.M)
    call = re.compile(r'^call8\s+[0-9a-f]+ <'+re.escape(target)+r'>$')
    matches = [(int(address, 16), int(next_address, 16)) for (address, opcode, instruction),
               (next_address, _, _) in zip(instructions, instructions[1:])
               if len(opcode) == 6 and call.fullmatch(instruction) and int(next_address, 16) == int(address, 16)+3]
    if len(matches) != 1:
        raise ValueError(f'Expected one direct Xtensa call8 and its adjacent instruction for {target}')
    return matches[0]


def reviewed_elf(build):
    receipt = json.loads((ROOT/'firmware/agent-stock-trial-v54-build.json').read_text())
    elf = build/'stack-chan.elf'
    for artifact in (build/'stack-chan.bin', elf):
        if {'bytes': artifact.stat().st_size, 'sha256': sha(artifact)} != receipt['artifacts'][artifact.name]:
            raise ValueError(f'{artifact.name} does not match the reviewed v54 build')
    return elf


def disassemble(objdump, elf, symbol):
    return subprocess.check_output([str(objdump), '-d', '-C', '--disassemble='+symbol, str(elf)], text=True)


def startup_points(build, objdump):
    elf = reviewed_elf(build)
    main, worker = (disassemble(objdump, elf, symbol) for symbol in ('app_main', USB_WORKER))
    hal_call, hal_return = call_and_return(main, 'Hal::init()')
    usb_call, usb_task_return = call_and_return(main, 'sion::agent::StartPairingUsb()')
    _, usb_driver_return = call_and_return(worker, 'sion::agent::(anonymous namespace)::PairingUsb::Install()')
    return hal_call, hal_return, usb_call, usb_task_return, usb_driver_return


def home_restart_point(assembly):
    # app_main also restarts for a settings request. Only the call guarded
    # by the successful stock-return check belongs to Home.
    addresses = re.findall(
        r'^\s*([0-9a-f]+):\s+[0-9a-f]{6}\s+call8\s+[0-9a-f]+ <ReviewedStockCanResume\(\)>\n'
        r'^\s*([0-9a-f]+):\s+[0-9a-f]{4}\s+beqz\.n\s+a10, ([0-9a-f]+) <app_main\+0x[0-9a-f]+>\n'
        r'^\s*([0-9a-f]+):\s+[0-9a-f]{6}\s+or\s+a1, a1, a1\n'
        r'^\s*([0-9a-f]+):\s+[0-9a-f]{6}\s+call8\s+[0-9a-f]+ <esp_restart>$',
        assembly, re.M)
    if len(addresses) != 1:
        raise ValueError('Expected one Home restart guarded by the reviewed stock-return check')
    check, branch, rejected, barrier, restart = (int(address, 16) for address in addresses[0])
    if (branch, barrier, restart) != (check+3, branch+2, barrier+3) or rejected <= restart+3:
        raise ValueError('The checked Home branch does not skip the restart on failure')
    return restart


def home_gdb_program(restart):
    return f"""# Load after attaching to the reviewed v54, with OpenOCD flash support disabled.
# Run sion-check-home-return, then perform Home on the device. Remain attached
# at the reported stop; detaching can resume the pending restart.
set remote hardware-breakpoint-limit 1
set print frame-arguments none

define sion-check-home-return
  set $sion_home_observed = 0
  thbreak *{restart:#x}
  set $sion_home_bp = $bpnum
  continue
  if $pc == {restart:#x}
    if $a10 == 1
      set $sion_home_observed = 1
      printf "[SION-HOME] checked factory return reached before esp_restart at %p\\n", $pc
    else
      printf "[SION-HOME] unexpected return-check result at %p\\n", $pc
    end
  else
    delete $sion_home_bp
    printf "[SION-HOME] unexpected stop at %p\\n", $pc
  end
  bt 6
end
"""


def gdb_program(points):
    hal, hal_return, usb, task, driver = points
    return f"""# v54 stock trial. Load after attaching to the staged candidate, while halted before app_main.
# Sourcing defines commands only. Run sion-check-hal, then sion-check-usb from its USB call stop.
set remote hardware-breakpoint-limit 2
set print frame-arguments none

define sion-check-hal
  hbreak esp_panic_handler
  set $sion_panic = $bpnum
  set $sion_next = {hal:#x}
  set $sion_stage = 0
  while $sion_stage < 3
    thbreak *$sion_next
    set $sion_temporary = $bpnum
    continue
    if $pc != $sion_next
      printf "[SION-STARTUP] stopped before stage %d at %p\\n", $sion_stage, $pc
      bt 16
      delete $sion_temporary
      set $sion_stage = 3
    else
      if $sion_stage == 0
        printf "[SION-STARTUP] HAL call\\n"
        set $sion_next = {hal_return:#x}
      else
        if $sion_stage == 1
          printf "[SION-STARTUP] HAL returned\\n"
          set $sion_next = {usb:#x}
        else
          printf "[SION-STARTUP] at USB task call\\n"
        end
      end
      set $sion_stage = $sion_stage + 1
    end
  end
  delete $sion_panic
end

define sion-check-usb
  if $pc == {usb:#x}
    set $sion_task_result = -1
    set $sion_driver_result = -1
    hbreak *{task:#x}
    set $sion_task_bp = $bpnum
    hbreak *{driver:#x}
    set $sion_driver_bp = $bpnum
    set $sion_checks = 0
    while $sion_checks < 2
      continue
      if $pc == {task:#x}
        disable $sion_task_bp
        set $sion_task_result = (unsigned int)$a10
        printf "[SION-STARTUP] USB task result %u\\n", $sion_task_result
        if $sion_task_result == 0
          set $sion_checks = 2
        end
      else
        if $pc == {driver:#x}
          disable $sion_driver_bp
          set $sion_driver_result = (unsigned int)$a10
          printf "[SION-STARTUP] USB driver ready %u\\n", $sion_driver_result
        else
          printf "[SION-STARTUP] unexpected USB startup stop at %p\\n", $pc
          bt 16
          set $sion_checks = 2
        end
      end
      set $sion_checks = $sion_checks + 1
    end
    delete $sion_task_bp $sion_driver_bp
  else
    printf "[SION-STARTUP] first stop at the USB task call using sion-check-hal\\n"
  end
end
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('build', 'objdump', 'output'):
        parser.add_argument('--'+option, type=Path, required=True)
    parser.add_argument('--probe', choices=('startup', 'home'), default='startup')
    args = parser.parse_args()
    try:
        objdump = args.objdump.resolve()
        if args.probe == 'home':
            assembly = disassemble(objdump, reviewed_elf(args.build), 'app_main')
            probe = home_gdb_program(home_restart_point(assembly))
        else:
            probe = gdb_program(startup_points(args.build, objdump))
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(probe)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'v54 debug preparation stopped: {error}\n')


if __name__ == '__main__':
    main()
