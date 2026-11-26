// Read or seed the previous plugin in a fresh Node process for the upgrade rehearsal.
import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.send, 'Run this stage through test_dsh_native_voice.mjs');
const [{ dshDirectory, profile, patch, sessionId, selectedPreferences, save, recovery }] = await once(process, 'message');
const fromDsh = createRequire(join(dshDirectory, 'package.json'));
const loadDsh = name => import(pathToFileURL(fromDsh.resolve(name)).href);
const { createLaunchEnvironmentSnapshot } = await loadDsh('@deepseek-ai/dsh-launch-environment');
const { runProfile } = await loadDsh('@deepseek-ai/dsh/profile-boot');
const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: {
  DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: 'DISABLED', DSH_NATIVE_FIXTURE_KEY: 'local-fixture-only',
} }]);
const app = await runProfile({ profile, environment, patchFiles: [patch], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
function publish(value) {
  return new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
}

async function serveRecovery(ctx) {
  const messages=on(process,'message');
  const actions=new Set(['start','connect','stop']);
  try {
    await publish({ready:true});
    for await (const [action] of messages) {
      if (action==='finish') return;
      if (actions.has(action)) {
        await publish(await ctx.typertGateway.invoke({
          namespace:'stackchanVoice',method:'execute',args:{action},
          peer:{id:'recovery-fixture-owner',ctx,principal:{kind:'owner'},signal:AbortSignal.timeout(30000),interactions:'none'},
        }));
        continue;
      }
      assert.equal(action,'observe');
      const signal=AbortSignal.timeout(3000);
      const preferences=ctx.stackchanSettings.snapshot().preferences;
      assert.equal(preferences.sessionId,sessionId);
      const {values}=await ctx.sessionController.projections({sessionId},signal);
      const history=await ctx.sessionController.events({address:{kind:'session',sessionId},maxMessages:40},signal);
      const {running}=await ctx.sessionController.state({sessionId},signal);
      const {phase,connected,applied}=ctx.stackchanVoice.snapshot();
      await publish({preferences,history,running,phase,connected,applied,
        projection:{agentPreset:values.agentPreset,workingDirectory:values.workingDirectory}});
    }
  } finally {
    await messages.return();
  }
}

if (recovery) {
  try { await serveRecovery(app.ctx); }
  finally { await app.shutdown.shutdown(process.exitCode??0); }
  process.disconnect();
} else {
  await readPrevious();
}

async function readPrevious() {
  let result;
  try {
    const { ctx } = app;
    const current = ctx.stackchanSettings.snapshot().preferences;
    assert.equal(Object.hasOwn(ctx.stackchanVoice.snapshot(), 'relayStandby'), false);
    if (save) {
      assert.equal(current.sessionId, '');
      assert.equal(Object.hasOwn(current, 'measureLatency'), false);
      const preferences = Object.fromEntries(Object.entries({ ...current, ...selectedPreferences }).filter(([name]) => Object.hasOwn(current, name)));
      const row = ctx.settings.describe().find(item => item.ns === 'stackchan');
      await ctx.settings.mutate('stackchan', [{ op: 'set', path: ['preferences'], value: preferences }], row.revision);
      assert.deepEqual(ctx.stackchanSettings.snapshot().preferences, preferences);
    } else {
      assert.equal(current.sessionId, sessionId);
      await assert.rejects(ctx.typertGateway.invoke({
        namespace: 'stackchanVoice', method: 'execute', args: { action: 'arm-relay' },
        peer: { id: 'voice-fixture-owner', ctx, principal: { kind: 'owner' }, signal: AbortSignal.timeout(3000), interactions: 'none' },
      }), { code: 'gateway/input-invalid' });
    }
    const history = await ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 40 }, AbortSignal.timeout(3000));
    const { values } = await ctx.sessionController.projections({ sessionId }, AbortSignal.timeout(3000));
    result = { preferences: ctx.stackchanSettings.snapshot().preferences, history,
      projection: { agentPreset: values.agentPreset, workingDirectory: values.workingDirectory } };
  } finally {
    await app.shutdown.shutdown(process.exitCode ?? 0);
  }
  await publish(result);
  process.disconnect();
}
