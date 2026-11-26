import { setTimeout as sleep } from 'node:timers/promises';

const standing = snapshot => snapshot.usbStandby || snapshot.lanStandby || snapshot.relayStandby;

/** Opt-in supervisor for the saved "be reachable after DSH starts" preference.
 * It only repeats what the owner's Start and standby buttons do. An explicit
 * Stop or shutdown from Settings holds it until the owner starts again. */
export function createAutoStandby({ runtime, getPreferences, delay = sleep, onState = () => {} }) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let held = false, started = false, loop;
  const wanted = () => {
    const preferences = getPreferences();
    return preferences.autoStandby === true && !!preferences.sessionId ? preferences.transport ?? 'lan' : null;
  };
  async function step() {
    const transport = wanted();
    if (!transport || held) return 'idle';
    let state = runtime.snapshot();
    // A service the owner (or a lost identity) stopped later is not restarted behind their back.
    if (state.phase === 'stopped' && !started) {
      state = await runtime.execute('start', signal);
      started = true;
    }
    if (state.phase !== 'listening' || state.connected || standing(state) || state.pendingChanges) return 'steady';
    await runtime.execute(`arm-${transport}`, signal);
    return 'armed';
  }
  async function run() {
    let wait = 1500;
    while (!signal.aborted) {
      try {
        const outcome = await step();
        if (outcome === 'armed') onState({ event: 'auto-standby-armed' });
        wait = 5000;
      } catch (error) {
        if (signal.aborted) break;
        onState({ event: 'auto-standby-waiting', code: typeof error?.code === 'string' ? error.code : 'unknown' });
        wait = Math.min(wait * 2, 60000);
      }
      try { await delay(wait, undefined, { signal }); } catch { break; }
    }
  }
  return {
    start() { loop ??= run(); },
    /** Wraps the owner-facing service so manual intent wins over the saved default. */
    wrap(service) {
      return new Proxy(service, {
        get(target, property, receiver) {
          if (property !== 'execute') return Reflect.get(target, property, receiver);
          return (action, ...rest) => {
            if (action === 'stop' || action === 'shutdown') held = true;
            else if (['start', 'connect', 'arm-usb', 'arm-lan', 'arm-relay'].includes(action)) {
              held = false;
              if (action === 'start') started = false;
            }
            return target.execute(action, ...rest);
          };
        },
      });
    },
    async dispose() {
      lifetime.abort();
      await loop?.catch(() => {});
    },
  };
}
