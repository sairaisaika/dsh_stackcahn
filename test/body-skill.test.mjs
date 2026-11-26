import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBodySkill } from '../src/body-skill.mjs';

test('body manual is registered for every session and states facts without etiquette rules', async () => {
  let provider;
  registerBodySkill({ skills: { registerProvider: factory => { provider = factory(); return () => {}; } } });
  const [candidate] = await provider.list();
  assert.equal(candidate.name, 'stackchan-body');
  assert.equal(candidate.invocation.modelInvocable, true);
  const skill = await provider.get(candidate, {});
  for (const tool of ['stackchan_say', 'stackchan_move_head', 'stackchan_take_photo', 'stackchan_light_ring', 'stackchan_set_expression', 'stackchan_device_status'])
    assert.match(skill.content, new RegExp(tool));
  assert.match(skill.content, /Any DSH session/);
  assert.doesNotMatch(skill.content, /quiet hours|at night|don't disturb/i);
  assert.equal('rank' in skill, false);
});
