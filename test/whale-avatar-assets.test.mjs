// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const generator = new URL('scripts/build_whale_avatar.mjs', root);
const generated = ['firmware/agent/whale_assets.bin', 'firmware/agent/whale_assets.h', 'wiki/assets/whale-avatar-preview.png'];
async function assetHashes() {
  return Promise.all(generated.map(async path => {
    try {
      return createHash('sha256').update(await readFile(new URL(path, root))).digest('hex');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
}
const pixel = (rgb, x, y) => [...rgb.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];

test('every face names a source drawing recorded in the notice, and no face is a silent placeholder', async () => {
  const { FACES } = await import(generator.href);
  assert.ok(Array.isArray(FACES), 'the source mapping must be inspectable without generating assets');
  const notice = await readFile(new URL('firmware/whale-sources/NOTICE.md', root), 'utf8');
  assert.deepEqual(FACES.map(face => face.name),
    ['neutral', 'happy', 'angry', 'sad', 'doubt', 'sleepy', 'surprised', 'thinking', 'pat', 'stare', 'shy']);
  for (const face of FACES) {
    assert.match(notice, new RegExp(`\\| ${face.file.replace('.', '\\.')} \\|`), `${face.file} must be attributed`);
    assert.equal(face.placeholder, undefined, `${face.name} must show its own drawing`);
  }
  // The two faces that share a drawing do so on purpose.
  const file = name => FACES.find(face => face.name === name).file;
  assert.equal(file('thinking'), file('doubt'));
  assert.notEqual(file('pat'), file('neutral'));
  assert.notEqual(file('sad'), file('neutral'));
  // The resting stare is the smile drawing with the puzzled sticker's small mouth.
  const stare = FACES.find(face => face.name === 'stare');
  assert.equal(stare.file, file('neutral'));
  assert.equal(stare.mouthFrom, 'tiny');
  assert.match(notice, /\| C52\.jpg \|[^\n]*stare/);
});

test('generator labels only corrected layouts with the runtime version marker', async () => {
  const source = await readFile(generator, 'utf8');
  assert.match(source, /#define SION_WHALE_ASSET_LAYOUT_VERSION 3/);
});

// Check the static entry guard before importing: the old CLI writes assets on import.
test('avatar placement is import-safe and returns exact screen RGB', async t => {
  const source = await readFile(generator, 'utf8');
  assert.match(source, /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\) \{\s*await main\(\);\s*\}/);
  const before = await assetHashes();
  t.after(async () => assert.deepEqual(await assetHashes(), before, 'import/placement must not rewrite generated assets'));
  const { place } = await import(generator.href);
  assert.equal(typeof place, 'function');
  assert.deepEqual(await assetHashes(), before, 'import must not rewrite generated assets');

  // The source drawings are not redistributed (README); without them this check is skipped.
  const haveSources = await readFile(new URL('firmware/whale-sources/C12.jpg', root)).then(() => true, () => false);
  await t.test('real C12 source is exactly 320x240x3', { skip: !haveSources && 'artwork not present' }, async () => {
    const rgb = await place({ file: 'C12.jpg', left: [378, 423], right: [525, 416] });
    assert.ok(Buffer.isBuffer(rgb));
    assert.equal(rgb.length, 320 * 240 * 3);
  });

  const input = await sharp({ create: { width: 400, height: 300, channels: 4, background: '#ff0000' } }).png().toBuffer();
  for (const [name, eyes, white, red] of [
    ['interior crop with nonzero padding', [[160, 112], [256, 112]], null, [0, 0]],
    ['top-left edge with white padding', [[0, 0], [96, 0]], [0, 0], [120, 120]],
    ['bottom-right edge with white padding', [[304, 300], [400, 300]], [319, 239], [20, 20]],
  ]) {
    await t.test(name, async () => {
      const rgb = await place({ left: eyes[0], right: eyes[1] }, input);
      assert.ok(Buffer.isBuffer(rgb));
      assert.equal(rgb.length, 320 * 240 * 3);
      if (white) assert.deepEqual(pixel(rgb, ...white), [255, 255, 255]);
      assert.deepEqual(pixel(rgb, ...red), [255, 0, 0]);
    });
  }
});
