import { setTimeout as sleep } from 'node:timers/promises';

const between = (random, low, high) => low + (high - low) * random();
const clamp = (value, low, high) => Math.round(Math.min(high, Math.max(low, value)));

/** Where a waiting robot looks next, in tenths of a degree. The mix follows the
 * factory assistant's standby (pinned v1.6.2 main/stackchan/modifiers/idle_motion.h):
 * half look somewhere new, three in ten drift from where they are, one in ten
 * glance aside and one in ten recentre. Pitch stays inside the manual's 5–85°. */
export function nextIdleTarget(previous = { yaw: 0, pitch: 300 }, random = Math.random) {
  const choice = random();
  let yaw, pitch;
  if (choice < 0.5) { yaw = between(random, -512, 512); pitch = between(random, 51, 534); }
  else if (choice < 0.8) {
    yaw = clamp(previous.yaw + between(random, -150, 150), -800, 800);
    pitch = clamp(previous.pitch + between(random, -80, 80), 50, 600);
  } else if (choice < 0.9) { yaw = between(random, -500, 500); pitch = between(random, 100, 400); }
  else { yaw = 0; pitch = between(random, 50, 400); }
  yaw = clamp(yaw, -800, 800); pitch = clamp(pitch, 50, 600);
  const travel = Math.max(Math.abs(yaw - previous.yaw), Math.abs(pitch - previous.pitch));
  // Unhurried: about a second for a small look, up to two for a wide one.
  return { yaw, pitch, durationMs: clamp(700 + travel * 1.6, 700, 2200) };
}

/** Moves the head now and then while `waiting()` holds: linked, connected and not
 * in a conversation. The device's own Motion permission is the owner's switch;
 * a refusal there pauses the attempts instead of repeating them. */
export function createIdleMotion({ waiting, move, delay = sleep, random = Math.random, onState = () => {} }) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let loop, last = { yaw: 0, pitch: 300 }, faults = 0;
  async function run() {
    let wait = 2000;
    while (!signal.aborted) {
      try { await delay(wait, undefined, { signal }); } catch { break; }
      wait = between(random, 4000, 8000);
      if (!waiting()) continue;
      const target = nextIdleTarget(last, random);
      try {
        await move(target, { signal });
        last = target;
        faults = 0;
      } catch (error) {
        if (signal.aborted) break;
        const code = typeof error?.code === 'string' ? error.code : 'unknown';
        // Busy just means something else is moving the head right now.
        if (code === 'motion-busy' || code === 'not-ready') continue;
        onState({ event: 'idle-motion-paused', code });
        if (['motion-disabled', 'motion-unsupported', 'motion-unavailable'].includes(code)) wait = 120000;
        else {
          // A drive fault does not fix itself: back off 30 s, 60 s, … up to 30 min,
          // so the retries neither spam the device nor fill its diagnostic record.
          faults++;
          wait = Math.min(30000 * 2 ** (faults - 1), 1800000);
        }
        continue;
      }
    }
  }
  return {
    start() { loop ??= run(); },
    async dispose() { lifetime.abort(); await loop?.catch(() => {}); },
  };
}
