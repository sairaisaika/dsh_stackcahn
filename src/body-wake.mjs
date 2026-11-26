// Wake the resident body (wiki/residency.md, route R1): from the factory firmware, switch the
// robot into the DSH firmware in ota_0 once. Home or a restart returns to the factory firmware.
//
// This runs one fixed program, scripts/enter_dsh.py shipped in this package, with arguments
// taken from a local manifest the owner's installation writes:
//   <profile>/.stackchan-resident/resident.json
//   {"version":1,"python":"/abs/python with esptool 5","identity":"/abs/identified-device.json",
//    "image":"/abs/resident stack-chan.bin","sha256":"<64 hex>"}
// No shell, no other command. The program itself refuses rather than writes when anything
// does not match (unit, flash voltage, OTA records, the image in ota_0).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
export const ENTER_SCRIPT = fileURLToPath(new URL('../scripts/enter_dsh.py', import.meta.url));

/** What each refusal of enter_dsh.py means for the owner. */
export const WAKE_REFUSALS = {
  'flash-voltage': 'wake-press-rst', 'no-rom': 'wake-press-rst',
  'port-in-use': 'wake-port-busy', 'different-unit': 'wake-different-unit',
  'factory-not-confirmed-running': 'wake-not-from-factory', 'no-ota-record': 'wake-not-from-factory',
  'ota0-not-resident-dsh': 'wake-body-missing', 'image-file-changed': 'wake-not-installed',
};

function runProgram(python, args, { signal, timeoutMs }) {
  return new Promise(resolve => {
    execFile(python, args, { signal, timeout: timeoutMs, env: { ...process.env, ESPTOOL_OPEN_PORT_ATTEMPTS: '1' } },
      (error, stdout) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), error }));
  });
}

export function createBodyWake({ profileDirectory, runtime, run = runProgram, sleep = ms => new Promise(r => setTimeout(r, ms)),
  bootMs = 5000, timeoutMs = 120000 } = {}) {
  const directory = profileDirectory ? join(profileDirectory, '.stackchan-resident') : '';
  let busy = false;
  async function manifest() {
    if (!directory) throw fail('wake-not-installed');
    let m;
    try { m = JSON.parse(await readFile(join(directory, 'resident.json'), 'utf8')); } catch { throw fail('wake-not-installed'); }
    const paths = ['python', 'identity', 'image'];
    if (m?.version !== 1 || paths.some(k => typeof m[k] !== 'string' || !isAbsolute(m[k])) ||
        typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) throw fail('wake-not-installed');
    return m;
  }
  return {
    async wake({ signal } = {}) {
      signal?.throwIfAborted();
      const before = runtime?.snapshot?.();
      if (before?.connected === true) return { version: 1, status: 'already-awake' };
      if (busy) throw fail('wake-busy');
      busy = true;
      // A listening USB standby holds the port; release it for the switch and listen again after.
      const listening = before?.usbStandby === true;
      try {
        const m = await manifest();
        if (listening) await runtime.execute('stop', signal).catch(() => {});
        let code, stdout, last;
        // "port-in-use" is refused before any write; the released port can take a moment to close.
        for (let attempt = 0; attempt < 6; attempt++) {
          ({ code, stdout } = await run(m.python, [ENTER_SCRIPT, '--identity', m.identity, '--image', m.image,
            '--sha256', m.sha256, '--auto-rom', '--log', join(directory, 'enter.jsonl')], { signal, timeoutMs }));
          const events = stdout.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          last = events.at(-1);
          if (!(last?.event === 'refused' && last.reason === 'port-in-use')) break;
          await sleep(500);
        }
        if (code === 0 && last?.event === 'reset') {
          // Give the body time to start, then let the voice service attend it over USB when it runs.
          await sleep(bootMs);
          let attending = false;
          try { await runtime?.execute?.('arm-usb', signal); attending = true; } catch {}
          return { version: 1, status: 'woken', attending, note: 'If it does not link, tap the face once.' };
        }
        if (listening) await runtime.execute('arm-usb', signal).catch(() => {});
        if (last?.event === 'refused') throw fail(WAKE_REFUSALS[last.reason] ?? 'wake-refused', { reason: last.reason });
        throw fail('wake-failed', { reason: last?.reason ?? `exit-${code}` });
      } finally { busy = false; }
    },
  };
}
