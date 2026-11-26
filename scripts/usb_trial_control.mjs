import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { usbPortPattern } from '../src/usb-port.mjs';

const fault = code => Object.assign(new Error(code), { code });

/** Single-use operator action. The installed serial helper is a direct child
 * of the native trial Host; losing it closes the open descriptor on the Mac. */
export function createUsbTrialCut({ helper, port, report }) {
  if (!isAbsolute(helper) || !helper.endsWith('/agent_usb_audio.py') || !usbPortPattern.test(port))
    throw fault('invalid_trial_endpoint');
  let issued = false;
  return snapshot => {
    if (issued) throw fault('trial_cut_already_issued');
    if (snapshot.transport !== 'usb' || snapshot.phase !== 'active' || snapshot.connected !== true)
      throw fault('trial_usb_not_active');
    const suffix = ' ' + helper + ' ' + port;
    const children = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='],
      { encoding: 'utf8', timeout: 1500 }).split('\n')
      .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
      .filter(row => row && Number(row[2]) === process.pid && row[3].endsWith(suffix));
    if (children.length !== 1) throw fault('trial_serial_owner_ambiguous');
    report('controlled-usb-cut-requested', { at: new Date().toISOString() });
    process.kill(Number(children[0][1]), 'SIGTERM');
    issued = true;
    report('controlled-usb-cut-issued', { at: new Date().toISOString() });
  };
}
