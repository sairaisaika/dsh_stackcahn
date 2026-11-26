import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareAgentRelay } from '../scripts/prepare_agent_relay.mjs';
import { readRelayConfiguration } from '../src/agent-relay-config.mjs';
import { openAgentRelayStream } from '../src/agent-relay.mjs';

const prepareCli = fileURLToPath(new URL('../scripts/prepare_agent_relay.mjs', import.meta.url));
const relayCli = fileURLToPath(new URL('../scripts/run_agent_relay.mjs', import.meta.url));
const secret = 'fixture only 123!';
const openssl = (cwd, ...args) => execFileSync('openssl', args, { cwd, stdio: 'ignore' });
const config = { endpoint: 'wss://localhost:8443/', pairId: 'a'.repeat(32), certFile: 'server.pem',
  keyFile: 'server.key', caFile: 'ca.pem', ssid: '测试热点', password: secret, bindPort: 0 };
let root;

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackchan-relay-provision-'));
  openssl(root, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Relay test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', 'ca.key', '-out', 'ca.pem');
  openssl(root, 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr');
  await writeFile(join(root, 'server.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  openssl(root, 'x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext');
});
test.after(() => root && rm(root, { recursive: true, force: true }));

async function input(name, options = {}) {
  const path = join(root, `${name}.json`);
  await writeFile(path, JSON.stringify({ ...config, ...options }), { mode: 0o600 });
  return path;
}

async function startRelay(configPath, t) {
  const processHandle = spawn(process.execPath, [relayCli, configPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(processHandle, 'exit');
  exited.catch(() => {});
  t.after(async () => { processHandle.kill(); await exited.catch(() => {}); });
  const found = new Promise(resolve => processHandle.stdout.once('data', resolve));
  const line = await Promise.race([found, exited.then(() => { throw new Error('fixture exited during startup'); })]);
  const match = /Sion relay listening on 127\.0\.0\.1 port (\d+)/.exec(line.toString());
  assert.ok(match);
  return `wss://localhost:${match[1]}`;
}

test('preparation generates private portable files that the relay and two roles actually use', { timeout: 15000 }, async t => {
  const source = await input('ready');
  const output = join(root, 'bundle');
  const stdout = execFileSync(process.execPath, [prepareCli, source, output], { encoding: 'utf8', timeout: 5000 });
  const profile = join(output, 'profile');
  const host = await readRelayConfiguration(profile);
  const { record } = JSON.parse(await readFile(join(profile, '.stackchan-relay-device.json'), 'utf8'));
  const relay = JSON.parse(await readFile(join(output, 'relay/relay.json'), 'utf8'));
  assert.equal(host.pairId, record.pair_id);
  assert.equal(host.endpoint, record.origin + '/');
  assert.equal(host.roomId, record.room_id);
  assert.equal(host.ca, record.ca);
  assert.equal(record.password, secret);
  assert.match(record.revision, /^[0-9a-f]{32}$/);
  assert.notEqual(host.token, record.token);
  for (const value of [host.token, record.token, secret, record.pair_id]) {
    assert.ok(!JSON.stringify(relay).includes(value));
    assert.ok(!stdout.includes(value));
  }
  assert.ok(!JSON.stringify(host).includes(secret));
  assert.ok(!JSON.stringify(record).includes(host.token));
  for (const directory of [output, profile, join(output, 'relay')])
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of ['profile/.stackchan-relay.json', 'profile/.stackchan-relay-device.json', 'relay/relay.json', 'relay/certificate.pem', 'relay/private-key.pem'])
    assert.equal((await stat(join(output, file))).mode & 0o777, 0o600);
  const endpoint = await startRelay(join(output, 'relay/relay.json'), t);
  const common = { endpoint, roomId: host.roomId, ca: host.ca, timeoutMs: 2000 };
  await assert.rejects(openAgentRelayStream({ ...common, role: 'host', token: record.token }));
  const [mac, device] = await Promise.all([
    openAgentRelayStream({ ...common, role: 'host', token: host.token }),
    openAgentRelayStream({ ...common, role: 'device', token: record.token }),
  ]);
  t.after(() => { mac.destroy(); device.destroy(); });
  const fromMac = once(device, 'data'), fromDevice = once(mac, 'data');
  mac.write(Buffer.from([1,2,3])); device.write(Buffer.from([4,5,6]));
  assert.deepEqual(await fromMac, [Buffer.from([1,2,3])]);
  assert.deepEqual(await fromDevice, [Buffer.from([4,5,6])]);

  const rotation = join(root, 'rotation');
  await prepareAgentRelay(source, rotation);
  const next = await readRelayConfiguration(join(rotation, 'profile'));
  assert.notEqual(next.roomId, host.roomId);
  assert.notEqual(next.token, host.token);
});

test('configuration or TLS trust failures publish no bundle and existing output is preserved', { timeout: 15000 }, async () => {
  for (const [name, options, code] of [
    ['hostname', { endpoint: 'wss://not-the-cert.test' }, 'tls'],
    ['wrong-key', { keyFile: 'ca.key' }, 'tls'],
    ['wrong-ca', { caFile: 'server.pem' }, 'tls'],
    ['plain-http', { endpoint: 'http://localhost' }, 'input'],
    ['bad-wifi', { ssid: '' }, 'input'],
    ['long-ssid', { ssid: '热'.repeat(12) }, 'input'],
  ]) {
    const source = await input(name, options);
    const destination = join(root, `${name}-out`);
    await assert.rejects(prepareAgentRelay(source, destination), { code });
    await assert.rejects(access(destination), { code: 'ENOENT' });
  }
  const source = await input('permissions');
  const out = join(root, 'existing');
  await mkdir(out);
  await writeFile(join(out, 'keep'), 'previous deployment');
  await assert.rejects(prepareAgentRelay(source, out), { code: 'output' });
  assert.equal(await readFile(join(out, 'keep'), 'utf8'), 'previous deployment');
  const link = join(root, 'source-link.json');
  await symlink(source, link);
  await assert.rejects(prepareAgentRelay(link, join(root, 'link-output')), { code: 'input' });
  await chmod(source, 0o644);
  await assert.rejects(prepareAgentRelay(source, join(root, 'public-output')), { code: 'input' });
});
