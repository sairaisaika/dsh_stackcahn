/** Registers the on-demand StackChan body manual for every session. */
import { readFile } from 'node:fs/promises';

export function registerBodySkill(ctx) {
  const candidate = {
    name: 'stackchan-body',
    description: 'How to use the StackChan desk robot (Sion) as your body from any session: speak aloud, turn the head, take a photo, change the face, light the ring, read device status, share the device with other sessions and read its failure codes. Load before combining StackChan tools.',
    provider: 'dsh-stackchan', source: 'bundled', rank: 0, locator: null,
    invocation: { modelInvocable: true, userInvocable: true },
  };
  return ctx.skills.registerProvider(() => ({
    name: candidate.provider,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, options) {
      const content = await readFile(new URL('./skills/stackchan-body.md', import.meta.url), { encoding: 'utf8', signal: options?.signal });
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content };
    },
  }));
}
