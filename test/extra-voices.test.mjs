// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PYTHON ?? 'python3';
const run = (code, ...args) => execFileSync(python, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(root, 'scripts'))})\n${code}`, ...args],
  { encoding: 'utf8' }).trim();

test('the optional voice manifest pins zf_038 at the same model revision as the installed voices', async () => {
  const extra = JSON.parse(await readFile(join(root, 'vendor/voice/extra-voices.json'), 'utf8'));
  const pinned = JSON.parse(await readFile(join(root, 'vendor/voice/assets.json'), 'utf8'));
  const revision = url => url.match(/resolve\/([0-9a-f]{40})\//)[1];
  assert.deepEqual(extra.voices.map(v => v.voice), ['zf_038']);
  const [voice] = extra.voices;
  assert.equal(revision(voice.url), revision(pinned.files[0].url));
  assert.match(voice.sha256, /^[0-9a-f]{64}$/);
  assert.equal(voice.path, 'kokoro/voices/zf_038.pt');
  // Adding an optional voice must not touch the pinned installation manifest.
  assert.ok(!pinned.files.some(file => file.path.includes('zf_038')));
});

test('add_voice places only a verified file, keeps a verified one and refuses a different one', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sion-voice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assets = join(dir, 'assets');
  await mkdir(join(assets, 'kokoro/voices'), { recursive: true, mode: 0o700 });
  for (const path of [assets, join(assets, 'kokoro'), join(assets, 'kokoro/voices')]) await chmod(path, 0o700);
  const good = Buffer.from('fake voice tensor');
  const manifest = join(dir, 'extra.json');
  await writeFile(manifest, JSON.stringify({ version: 1, voices: [{ voice: 'zf_038', language: 'zh', path: 'kokoro/voices/zf_038.pt',
    url: 'https://invalid.example/never', bytes: good.length, sha256: createHash('sha256').update(good).digest('hex'), license: 'Apache-2.0' }] }));
  const source = join(dir, 'source.pt'), wrong = join(dir, 'wrong.pt');
  await writeFile(source, good); await writeFile(wrong, Buffer.from('fake voice tensoR'));
  const place = `import add_voice\nfrom pathlib import Path\nprint(add_voice.place(sys.argv[1], 'zf_038', sys.argv[2], opener=None, manifest=Path(sys.argv[3])))`;
  assert.throws(() => run(place, assets, wrong, manifest), /voice-verification-failed/);
  assert.equal(run(place, assets, source, manifest), 'placed');
  const placed = join(assets, 'kokoro/voices/zf_038.pt');
  assert.deepEqual(await readFile(placed), good);
  assert.equal((await stat(placed)).mode & 0o777, 0o600);
  assert.equal(run(place, assets, source, manifest), 'present');
  await chmod(placed, 0o600); await writeFile(placed, Buffer.from('tampered'));
  assert.throws(() => run(place, assets, source, manifest), /voice-target-differs/);
});

test('the speech worker accepts zf_038 and loads only a matching optional file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sion-voice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fields = `import local_speech\nprint(local_speech.request_fields({'request_id': '0'*36, 'text': '你好', 'language': 'zh', 'voice': sys.argv[1], 'speed': 1})[3])`;
  assert.equal(run(fields, 'zf_038'), 'zf_038');
  assert.equal(run(fields, ''), 'zf_001');  // The worker swaps in zf_038 only once it is loaded.
  assert.throws(() => run(fields, 'zf_999'), /invalid-request/);
  await mkdir(join(dir, 'kokoro/voices'), { recursive: true });
  await writeFile(join(dir, 'kokoro/voices/zf_038.pt'), 'not the pinned file');
  assert.equal(run(`import local_speech\nfrom pathlib import Path\nprint(len(local_speech.extra_voices(Path(sys.argv[1]))))`, dir), '0');
});
