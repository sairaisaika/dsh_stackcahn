import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { openUsbSerial } from '../src/usb-serial.mjs';
const deviceId = '123456abcdef';

test('serial helper rejects an absent candidate and closes without opening a TTY', async () => {
  const serial = openUsbSerial({ python: 'python3', port: `/dev/cu.usbmodem${randomUUID()}`, deviceId });
  try { await assert.rejects(serial.ready, { code: 'voice_usb_port_unavailable' }); }
  finally { await serial.close(); }
  assert.equal(serial.stream.closed, true);
});

test('serial process stdio separates readiness, raw bytes and handle release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sion-usb-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, 'fixture');
  await writeFile(program, `#!${process.execPath}
const fs = require('node:fs');
if (fs.readFileSync(4, 'ascii') !== '${deviceId}\\n') process.exit(1);
if (process.argv.includes('${deviceId}')) process.exit(1);
fs.writeSync(3, 'ready\\n'); fs.closeSync(3);
process.stdin.pipe(process.stdout);
`, { mode: 0o700 });
  const lease = openUsbSerial({ python: program, port: '/dev/cu.usbmodemfixture', deviceId });
  try {
    await lease.ready;
    const got = once(lease.stream, 'data');
    const bytes = Buffer.from([0, 0xff, 0x0a, 0x03, 0x0d]);
    lease.stream.write(bytes);
    assert.deepEqual((await got)[0], bytes);
  } finally { await lease.close(); }
  await lease.closed;
  assert.equal(lease.stream.closed, true);
});

test('real Python relay carries both directions through a PTY and exits on unplug', { timeout: 9000 }, async () => {
  const code = String.raw`
import os, select, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

def put(fd, data):
    while data:
        data = data[os.write(fd, data):]

def take(fd, size):
    data = bytearray()
    while len(data) < size:
        piece = os.read(fd, size-len(data))
        assert piece
        data.extend(piece)
    return data

master, slave = os.openpty()
ready_read, ready_write = os.pipe()
relay = """import os, sys
status = int(sys.argv[1]); os.dup2(status, 3)
if status != 3: os.close(status)
sys.path[:0] = ['scripts', 'vendor/pyserial/pyserial-3.5-py2.py3-none-any.whl']
import agent_usb_audio
# An isolated PTY supplies the stand-in for macOS USB metadata only.
agent_usb_audio.verify_managed_usb_port = lambda path, _: agent_usb_audio.usb_node_identity(os.lstat(path))
raise SystemExit(agent_usb_audio.main(sys.argv[2], '123456abcdef'))
"""
child = subprocess.Popen([sys.executable,'-c',relay,str(ready_write),os.ttyname(slave)], pass_fds=(ready_write,),
                         stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
os.close(ready_write)
host = bytes(range(256))*125
peer = bytes(range(255,-1,-1))*120
try:
    assert select.select([ready_read],[],[],3)[0]
    assert os.read(ready_read,16) == b'ready\n'
    os.close(slave)
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = [pool.submit(put, child.stdin.fileno(), host), pool.submit(put, master, peer)]
        got_host = pool.submit(take, master, len(host))
        got_peer = pool.submit(take, child.stdout.fileno(), len(peer))
        assert got_host.result(timeout=3) == host
        assert got_peer.result(timeout=3) == peer
        for job in jobs: job.result(timeout=3)
    os.close(master)
    child.wait(timeout=3)
finally:
    if child.poll() is None: child.kill(); child.wait()
`;
  await promisify(execFile)('python3', ['-c', code], { timeout: 8000 });
});
