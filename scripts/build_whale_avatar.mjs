// SPDX-License-Identifier: MIT
// Builds the whale-girl face for the 320x240 Sion screen from the community
// source images in firmware/whale-sources (see its NOTICE.md), and writes the
// firmware sprite blob, its header and a preview sheet. No device access.
// Run: node scripts/build_whale_avatar.mjs [--check]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const path = relative => fileURLToPath(new URL(relative, root));
const sources = path('firmware/whale-sources/');
const blobPath = path('firmware/agent/whale_assets.bin');
const headerPath = path('firmware/agent/whale_assets.h');
const previewPath = path('wiki/assets/whale-avatar-preview.png');
const SCREEN = { width: 320, height: 240 };
// Every face is scaled and moved so that its eyes land on the same screen points.
const EYES = { distance: 96, middleX: 160, y: 112 };

// Eye and mouth centres measured in each source image (source pixels; "left" is
// the viewer's left). Only scale and translation are applied, so a tilted head
// keeps the tilt its artist drew.
export const FACES = [
  { name: 'neutral', file: 'C12.jpg', left: [378, 423], right: [525, 416], mouth: [453, 478], talk: 'open', blink: true },
  { name: 'happy', file: 'C10.jpg', left: [388, 516], right: [568, 499], mouth: [479, 581], talk: 'closed' },
  { name: 'angry', file: 'C15.jpg', left: [363, 500], right: [539, 491], mouth: [456, 561], talk: 'open' },
  // 吃醋: furrowed brows, wet eyes and a pout. The closest drawn face to "sad".
  { name: 'sad', file: 'C84.jpg', left: [618, 872], right: [927, 824], mouth: [746, 1021], talk: 'open' },
  { name: 'doubt', file: 'C52.jpg', left: [624, 651], right: [855, 637], mouth: [714, 740], talk: 'open' },
  { name: 'sleepy', file: 'C78.jpg', left: [585, 911], right: [981, 836], mouth: [784, 1012] },
  { name: 'surprised', file: 'C17.jpg', left: [385, 427], right: [531, 417], mouth: [470, 486] },
  // Waiting for a reply shows the same puzzled drawing as doubt.
  { name: 'thinking', file: 'C52.jpg', left: [624, 651], right: [855, 637], mouth: [714, 740], talk: 'open' },
  // Head pat: the contented 得意 drawing under a script-drawn hand and hearts.
  { name: 'pat', file: 'C82.jpg', left: [565, 970], right: [932, 896], mouth: [756, 1098], talk: 'open' },
  // 呆萌盯着, the resting face: the smile drawing with the small flat mouth of
  // the puzzled sticker, so she simply looks at you, wide-eyed.
  { name: 'stare', file: 'C12.jpg', left: [378, 423], right: [525, 416], mouth: [453, 478], talk: 'open', blink: true, mouthFrom: 'tiny' },
  // 害羞脸红: shown for a moment after a head pat ends.
  { name: 'shy', file: 'P2.jpg', left: [395, 545], right: [587, 532], mouth: [478, 633], talk: 'open' },
];
// Donors for the parts that move. Same character sheet, nearly the same pose.
const DONORS = {
  open: { file: 'C04.jpg', left: [388, 407], right: [531, 396], mouth: [465, 472], size: [56, 44] },
  closed: { file: 'C12.jpg', left: [378, 423], right: [525, 416], mouth: [453, 478], size: [72, 54], core: 0.8 },
  wink: { file: 'C19.jpg', left: [390, 425], right: [550, 420], size: [88, 76], core: 0.82 },
  tiny: { file: 'C52.jpg', left: [624, 651], right: [855, 637], mouth: [714, 740], size: [46, 34], core: 0.6 },
};
const HAND = { x: 96, y: 0, width: 128, height: 76 };

const pascal = name => name[0].toUpperCase() + name.slice(1);
const transformOf = ({ left, right }) => {
  const scale = EYES.distance / Math.hypot(right[0] - left[0], right[1] - left[1]);
  const middle = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
  return { scale, toScreen: ([x, y]) => [(x - middle[0]) * scale + EYES.middleX, (y - middle[1]) * scale + EYES.y], middle };
};

/** The source placed on the screen. Returns raw RGB, 320x240. */
export async function place(source, input = sources + source.file) {
  const { scale, middle } = transformOf(source);
  const image = sharp(input);
  const { width, height } = await image.metadata();
  const region = { left: middle[0] - EYES.middleX / scale, top: middle[1] - EYES.y / scale,
    width: SCREEN.width / scale, height: SCREEN.height / scale };
  const pad = Math.ceil(Math.max(0, -region.left, -region.top, region.left + region.width - width, region.top + region.height - height)) + 2;
  // Resample the whole padded picture once, then cut the screen out of it.
  const scaledWidth = Math.round((width + 2 * pad) * scale), scaledHeight = Math.round((height + 2 * pad) * scale);
  const left = Math.round((region.left + pad) * scale), top = Math.round((region.top + pad) * scale);
  // Sharp schedules extend after resize/extract, regardless of chain order.
  // Materialise padding first so the crop coordinates use the padded image.
  const padded = await image.extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = await sharp(padded.data, { raw: { width: padded.info.width, height: padded.info.height, channels: padded.info.channels } })
    .resize(scaledWidth, scaledHeight, { kernel: 'lanczos3', fit: 'fill' })
    .extract({ left: Math.min(left, scaledWidth - SCREEN.width), top: Math.min(top, scaledHeight - SCREEN.height), width: SCREEN.width, height: SCREEN.height })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, SCREEN.width, 'placed frame width');
  assert.equal(result.info.height, SCREEN.height, 'placed frame height');
  assert.equal(result.info.channels, 3, 'placed frame RGB channels');
  assertRgb(result.data, 'placed frame');
  return result.data;
}

/** Blend an elliptical piece of `donor` (centred at `from`) into `target` at `to`. */
function transplant(target, donor, from, to, [width, height], { mirror = false, core = 0.66 } = {}) {
  const out = Buffer.from(target);
  const rx = width / 2, ry = height / 2;
  for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
    for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
      const distance = Math.hypot(dx / rx, dy / ry);
      if (distance >= 1) continue;
      // Opaque in the middle, feathered over the rim outside `core`.
      const alpha = distance < core ? 1 : (1 - distance) / (1 - core);
      const sx = Math.round(from[0] + (mirror ? -dx : dx)), sy = Math.round(from[1] + dy);
      const tx = Math.round(to[0] + dx), ty = Math.round(to[1] + dy);
      if (sx < 0 || sy < 0 || tx < 0 || ty < 0 || sx >= SCREEN.width || tx >= SCREEN.width || sy >= SCREEN.height || ty >= SCREEN.height) continue;
      for (let c = 0; c < 3; c++) {
        const t = (ty * SCREEN.width + tx) * 3 + c, s = (sy * SCREEN.width + sx) * 3 + c;
        out[t] = Math.round(out[t] * (1 - alpha) + donor[s] * alpha);
      }
    }
  }
  return out;
}

/** The in-between frame of `overlay` over `base` inside `region`. A mouth is
 * mixed half-and-half; eyes get a half-lowered lid instead (closed-eye pixels
 * above the eye line, the open eye below, feathered), which does not ghost. */
function halfway(base, overlay, { x, y, width, height }, kind) {
  const out = Buffer.from(base);
  for (let row = y; row < y + height; row++) {
    const lid = kind === 'blink' ? Math.max(0, Math.min(1, (EYES.y + 7 - row) / 5)) : 0.5;
    for (let column = x; column < x + width; column++)
      for (let c = 0; c < 3; c++) { const i = (row * SCREEN.width + column) * 3 + c; out[i] = Math.round(base[i] * (1 - lid) + overlay[i] * lid); }
  }
  return out;
}

const box = (centre, [width, height]) => {
  const x = Math.max(0, Math.round(centre[0] - width / 2) - 1), y = Math.max(0, Math.round(centre[1] - height / 2) - 1);
  return { x, y, width: Math.min(SCREEN.width - x, width + 3), height: Math.min(SCREEN.height - y, height + 3) };
};

function handOverlay(shift) {
  const x = 160 + shift;
  const heart = (hx, hy, s) => `<path transform="translate(${hx} ${hy}) scale(${s})" d="M0 6 C-10 -2 -6 -10 0 -5 C6 -10 10 -2 0 6 Z" fill="#ff6f91" stroke="#ffffff" stroke-width="${1.3 / s}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
    <path d="M${x - 20} -6 L${x - 17} 26 L${x + 17} 26 L${x + 20} -6 Z" fill="#ffffff" stroke="#c9d6f2" stroke-width="2"/>
    <path transform="translate(${x} -4)" d="M-34 44 C-36 24 -22 16 0 16 C22 16 36 24 34 44 C34 54 28 60 22 54 C20 62 10 64 8 56 C4 64 -6 64 -8 56 C-12 64 -22 62 -22 54 C-28 60 -34 54 -34 44 Z"
          fill="#ffe9de" stroke="#3b2a55" stroke-width="3" stroke-linejoin="round"/>
    <path transform="translate(${x} -4)" d="M-8 44 v10 M8 44 v10 M-22 42 v10 M22 42 v10" stroke="#3b2a55" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
    ${heart(shift < 0 ? 112 : 108, shift < 0 ? 24 : 16, 1.5)}${heart(shift < 0 ? 208 : 212, shift < 0 ? 16 : 26, 1.2)}
  </svg>`);
}

// Ordered dither keyed by absolute screen position: an unchanged pixel in a patch
// quantises to exactly the value it has in the full frame beneath it.
const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
function assertRgb(rgb, label) {
  assert.ok(Buffer.isBuffer(rgb), `${label} must be a Buffer`);
  assert.equal(rgb.length, SCREEN.width * SCREEN.height * 3, `${label} must be 320x240 RGB`);
}

function rgb565(rgb, { x, y, width, height }) {
  assertRgb(rgb, 'sprite frame');
  assert.ok([x, y, width, height].every(Number.isInteger), 'sprite region must contain integers');
  assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= SCREEN.width && y + height <= SCREEN.height,
    'sprite region must fit the screen');
  const out = Buffer.alloc(width * height * 2);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const sx = x + column, sy = y + row, source = (sy * SCREEN.width + sx) * 3;
    const threshold = (bayer[sy & 3][sx & 3] + 0.5) / 16 - 0.5;
    const channel = (value, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(value / 255 * ((1 << bits) - 1) + threshold * 0.9)));
    out.writeUInt16LE(channel(rgb[source], 5) << 11 | channel(rgb[source + 1], 6) << 5 | channel(rgb[source + 2], 5), (row * width + column) * 2);
  }
  return out;
}

async function main() {
const donorFrames = {};
for (const [name, donor] of Object.entries(DONORS)) donorFrames[name] = { rgb: await place(donor), at: transformOf(donor).toScreen };
const whole = { x: 0, y: 0, ...SCREEN };
const sprites = [], scenes = [];
for (const face of FACES) {
  const at = transformOf(face).toScreen;
  let rgb = await place(face);
  if (face.mouthFrom) {
    const donor = DONORS[face.mouthFrom], frame = donorFrames[face.mouthFrom];
    rgb = transplant(rgb, frame.rgb, frame.at(donor.mouth), at(face.mouth), donor.size, { core: donor.core });
  }
  const entry = { face: face.name, rgb, overlays: {} };
  sprites.push({ group: 'face', name: face.name, region: whole, rgb });
  if (face.talk) {
    const donor = DONORS[face.talk], frame = donorFrames[face.talk];
    const to = at(face.mouth);
    entry.overlays.talk = { region: box(to, donor.size), rgb: transplant(rgb, frame.rgb, frame.at(donor.mouth), to, donor.size, { core: donor.core }) };
  }
  if (face.blink) {
    const donor = DONORS.wink, frame = donorFrames.wink;
    const from = frame.at(donor.right);
    let closed = transplant(rgb, frame.rgb, from, at(face.right), donor.size, { core: donor.core });
    closed = transplant(closed, frame.rgb, from, at(face.left), donor.size, { mirror: true, core: donor.core });
    const a = box(at(face.left), donor.size), b = box(at(face.right), donor.size);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    entry.overlays.blink = { region: { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }, rgb: closed };
  }
  for (const kind of ['talk', 'blink']) {
    const overlay = entry.overlays[kind];
    if (overlay) entry.overlays[`${kind}Half`] = { region: overlay.region, rgb: halfway(rgb, overlay.rgb, overlay.region, kind) };
    sprites.push({ group: kind, name: face.name, ...(overlay ?? { region: null }) });
    sprites.push({ group: `${kind}Half`, name: face.name, ...(entry.overlays[`${kind}Half`] ?? { region: null }) });
  }
  scenes.push(entry);
}
const patted = scenes.find(scene => scene.face === 'pat');
const hands = [];
for (const [index, shift] of [-9, 9].entries()) {
  const rgb = await sharp(patted.rgb, { raw: { ...SCREEN, channels: 3 } }).composite([{ input: handOverlay(shift) }]).removeAlpha().raw().toBuffer();
  hands.push(rgb);
  sprites.push({ group: 'hand', name: index ? 'b' : 'a', region: HAND, rgb });
}
// An overlay may only differ from its face inside its own rectangle.
for (const scene of scenes) for (const [kind, overlay] of [...Object.entries(scene.overlays), ...(scene.face === 'pat' ? hands.map(rgb => ['hand', { region: HAND, rgb }]) : [])]) {
  const { x, y, width, height } = overlay.region;
  for (let p = 0; p < SCREEN.width * SCREEN.height; p++) {
    const px = p % SCREEN.width, py = Math.floor(p / SCREEN.width);
    if (px >= x && px < x + width && py >= y && py < y + height) continue;
    if (overlay.rgb[p * 3] !== scene.rgb[p * 3] || overlay.rgb[p * 3 + 1] !== scene.rgb[p * 3 + 1] || overlay.rgb[p * 3 + 2] !== scene.rgb[p * 3 + 2])
      throw new Error(`${scene.face}/${kind} draws outside its patch at ${px},${py}`);
  }
}

const parts = []; let offset = 0;
for (const sprite of sprites) {
  if (!sprite.region) { sprite.offset = 0; continue; }
  const pixels = rgb565(sprite.rgb, sprite.region);
  assert.equal(pixels.length, sprite.region.width * sprite.region.height * 2, `${sprite.name} RGB565 byte length`);
  sprite.offset = offset;
  parts.push(pixels); offset += pixels.length;
  const padding = (4 - offset % 4) % 4;
  if (padding) { parts.push(Buffer.alloc(padding)); offset += padding; }
}
const blob = Buffer.concat(parts);
const digest = createHash('sha256').update(blob).digest('hex');
const row = sprite => sprite.region
  ? `    {${sprite.offset}u, ${sprite.region.x}, ${sprite.region.y}, ${sprite.region.width}, ${sprite.region.height}}, // ${sprite.name}`
  : `    {0u, 0, 0, 0, 0}, // ${sprite.name}: none`;
const table = group => sprites.filter(sprite => sprite.group === group).map(row).join('\n');
const header = `// SPDX-License-Identifier: MIT
// Generated by scripts/build_whale_avatar.mjs. Do not edit by hand.
// Artwork: see firmware/whale-sources/NOTICE.md.
// Sprite blob: whale_assets.bin, ${blob.length} bytes, RGB565 little-endian, sha256 ${digest}
#pragma once
#define SION_WHALE_ASSET_LAYOUT_VERSION 3
#include <cstddef>
#include <cstdint>

namespace sion::agent::whale {
// Screen position and size of a sprite, and where its pixels start in the blob.
// A zero width means the face has no such overlay.
struct Sprite { uint32_t offset; int16_t x, y; uint16_t width, height; };
inline constexpr size_t kBlobBytes = ${blob.length};
enum class Face : uint8_t { ${FACES.map(face => pascal(face.name)).join(', ')} };
inline constexpr size_t kFaceCount = ${FACES.length};
// Full-screen frames, one per Face.
inline constexpr Sprite kFaceSprites[kFaceCount] = {
${table('face')}
};
// The other mouth position of each face: shown and hidden in turn while speaking.
inline constexpr Sprite kTalkSprites[kFaceCount] = {
${table('talk')}
};
// Half-open mouth: the in-between frame of the talk patch, same rectangle.
inline constexpr Sprite kTalkHalfSprites[kFaceCount] = {
${table('talkHalf')}
};
// Closed eyes for a blink.
inline constexpr Sprite kBlinkSprites[kFaceCount] = {
${table('blink')}
};
// Half-closed eyes: the in-between frame of a blink, same rectangle.
inline constexpr Sprite kBlinkHalfSprites[kFaceCount] = {
${table('blinkHalf')}
};
// The patting hand, in its two positions, over Face::Pat.
inline constexpr Sprite kHandSprites[2] = {
${table('hand')}
};
// LVGL image sources backed by the embedded blob. Null when there is none.
const void* FaceImage(Face value);
const void* TalkImage(Face value);
const void* TalkHalfImage(Face value);
const void* BlinkImage(Face value);
const void* BlinkHalfImage(Face value);
const void* HandImage(unsigned index);
}
`;

if (process.argv.includes('--check')) {
  const [currentBlob, currentHeader] = await Promise.all([readFile(blobPath), readFile(headerPath, 'utf8')]);
  if (!currentBlob.equals(blob) || currentHeader !== header) {
    console.error('Whale avatar assets are stale. Run node scripts/build_whale_avatar.mjs');
    process.exit(1);
  }
  console.log(`Whale avatar assets match their sources (${blob.length} bytes, sha256 ${digest}).`);
} else {
  const titles = { neutral: '聆听', happy: '开心 happy', angry: '生气 angry', sad: '难过 sad', doubt: '疑惑 doubt / 连接中',
    sleepy: '犯困 sleepy / 离线', surprised: '被戳 · 惊讶', thinking: '思考中（等回复）', pat: '摸头',
    stare: '呆萌盯着（默认）', shy: '害羞（摸头之后）' };
  const shots = [];
  for (const scene of scenes) {
    shots.push([titles[scene.face], scene.rgb]);
    if (scene.overlays.blink) shots.push([`${titles[scene.face]} · 半眨`, scene.overlays.blinkHalf.rgb], [`${titles[scene.face]} · 眨眼`, scene.overlays.blink.rgb]);
    if (scene.overlays.talk) shots.push([`${titles[scene.face]} · 半张嘴`, scene.overlays.talkHalf.rgb], [`${titles[scene.face]} · 说话`, scene.overlays.talk.rgb]);
    if (scene.face === 'pat') hands.forEach((rgb, index) => shots.push([`摸头 · 手 ${index ? 'B' : 'A'}`, rgb]));
  }
  const scale = 2, gap = 10, label = 26, columns = 4, rows = Math.ceil(shots.length / columns);
  const cell = { width: SCREEN.width * scale, height: SCREEN.height * scale + label };
  const tiles = [];
  for (const [index, [title, rgb]] of shots.entries()) {
    const left = gap + index % columns * (cell.width + gap), topEdge = gap + Math.floor(index / columns) * (cell.height + gap);
    tiles.push({ input: await sharp(rgb, { raw: { ...SCREEN, channels: 3 } }).resize(SCREEN.width * scale, SCREEN.height * scale, { kernel: 'nearest' }).png().toBuffer(), left, top: topEdge + label });
    tiles.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell.width}" height="${label}">
      <text x="4" y="19" font-family="PingFang SC, Helvetica, sans-serif" font-size="17" fill="#e8eefc">${title}</text></svg>`), left, top: topEdge });
  }
  await sharp({ create: { width: columns * (cell.width + gap) + gap, height: rows * (cell.height + gap) + gap, channels: 3, background: '#1b1f27' } })
    .composite(tiles).png().toFile(previewPath);
  await Promise.all([writeFile(blobPath, blob), writeFile(headerPath, header)]);
  console.log(`Wrote ${sprites.filter(sprite => sprite.region).length} sprites, ${blob.length} bytes, sha256 ${digest}`);
  console.log(`Preview: ${previewPath}`);
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
