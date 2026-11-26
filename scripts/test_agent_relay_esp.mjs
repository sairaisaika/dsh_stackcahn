// Run the ESP PSK implementation against the real Mac transport over loopback.
// QEMU UART replaces USB or the device SDK callbacks. No device ports are opened.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once, on } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { createAgentRelay } from '../src/agent-relay.mjs';
import { createAgentTransport } from '../src/agent-transport.mjs';

const [build, qemu] = process.argv.slice(2);
assert.ok(build && qemu, 'Pass the relay-probe build directory and Espressif qemu-system-xtensa');
const deviceId = '123456abcdef';
const pairing = { version: 1, host: { cert: '', key: '' }, record: {
  pair_id: '0123456789abcdef0123456789abcdef',
  local_token: '01' + '0'.repeat(62), local_url: 'wss://192.168.1.2:9080/audio',
} };

async function runProbe(flash, mode, connect) {
  const signal = AbortSignal.timeout(20000);
  const serial = net.createServer();
  serial.listen(0, '127.0.0.1');
  await once(serial, 'listening', { signal });
  const incoming = once(serial, 'connection', { signal });
  const emulator = spawn(qemu, ['-M','esp32s3','-m','32M','-nographic','-monitor','none','-nic','none',
    '-serial','stdio','-serial',`tcp:127.0.0.1:${serial.address().port}`,
    '-drive',`file=${flash},if=mtd,format=raw`,
    '-global','driver=timer.esp32s3.timg,property=wdt_disable,value=true'], { stdio: ['pipe','pipe','inherit'] });
  const exit = once(emulator, 'exit');
  exit.catch(() => {});
  const output = createInterface({ input: emulator.stdout });
  const lines = on(output, 'line', { signal });
  let socket;
  const transport = createAgentTransport({ pairing, deviceId, timeoutMs: 8000 });
  async function waitLine(expected) {
    for (;;) {
      const next = await lines.next();
      assert.ok(!next.done, `QEMU output ended before ${expected}`);
      const [line] = next.value;
      if (line === expected) return;
      if (line.startsWith('PROBE_') || line.includes('assert')) console.log(line);
    }
  }
  try {
    [socket] = await incoming;
    socket.on('error', () => {});
    socket.setNoDelay(true);
    await waitLine('PROBE_UART_READY');
    socket.write(mode);
    const authenticated = await connect(transport, socket, signal);
    assert.equal(authenticated.snapshot().phase, 'idle');
    assert.equal(authenticated.playbackSupported, true);
    await waitLine(`PROBE_AUTHENTICATED ${mode}`);
    console.log(`${mode === 'R' ? 'Relay' : 'USB'}: ESP TLS hello accepted and Mac encrypted heartbeat received`);
  } finally {
    socket?.destroy();
    await transport.close();
    output.close();
    await lines.return();
    emulator.kill();
    await exit.catch(() => {});
    await new Promise(resolve => serial.close(resolve));
  }
}

const directory = await mkdtemp(join(tmpdir(), 'sion-relay-esp-'));
let relay;
try {
  const args = JSON.parse(await readFile(join(build,'flasher_args.json'), 'utf8'));
  assert.equal(args.extra_esptool_args.chip, 'esp32s3');
  assert.equal(args.flash_settings.flash_size, '2MB');
  const image = Buffer.alloc(2 * 1024 * 1024, 0xff);
  for (const [address, filename] of Object.entries(args.flash_files)) {
    const bytes = await readFile(join(build, filename));
    assert.ok(Number(address) + bytes.length <= image.length);
    bytes.copy(image, Number(address));
  }
  const flash = join(directory, 'qemu.bin');
  await writeFile(flash, image, { mode: 0o600 });
  await runProbe(flash, 'U', (transport, socket) => transport.attachUsb(socket));

  const certFile = join(directory, 'relay.pem'), keyFile = join(directory, 'relay.key');
  execFileSync('openssl', ['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-out',certFile,'-keyout',keyFile], { stdio: 'ignore' });
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)]);
  const roomId = 'a'.repeat(32), hostToken = '1'.repeat(64), deviceToken = '2'.repeat(64);
  const digest = token => createHash('sha256').update(token, 'ascii').digest('hex');
  relay = createAgentRelay({ cert,key,rooms:[{roomId,hostTokenSha256:digest(hostToken),deviceTokenSha256:digest(deviceToken)}] });
  const {port} = await relay.listen();
  const endpoint = `wss://localhost:${port}`;
  await runProbe(flash, 'R', async (transport, socket, signal) => {
    const peer = new WebSocket(`${endpoint}/v1/rooms/${roomId}/device`, 'sion-rendezvous-v1', {
      ca:cert, headers:{Authorization:`Bearer ${deviceToken}`}, handshakeTimeout:5000,
    });
    peer.on('error', () => socket.destroy());
    peer.once('close', () => socket.destroy());
    socket.once('close', () => peer.terminate());
    peer.on('message', (bytes, binary) => {
      const header = Buffer.from([binary ? 2 : 1, bytes.length >> 8, bytes.length & 255]);
      if (!socket.write(Buffer.concat([header,bytes]))) peer.pause();
    });
    socket.on('drain', () => peer.resume());
    socket.on('data', bytes => peer.send(bytes, {binary:true}));
    await once(peer, 'open', {signal});
    return transport.attachRelay({ endpoint,roomId,token:hostToken,ca:cert,signal });
  });
} finally {
  await relay?.close();
  await rm(directory, { recursive: true, force: true });
}
