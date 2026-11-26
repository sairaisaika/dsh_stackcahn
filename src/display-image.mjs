// Pictures for the face screen: any image macOS can open, fitted inside a box
// and turned into little-endian RGB565 (the byte order the face sprites use).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fault = code => Object.assign(new Error(code), { code });

/** Uncompressed 24- or 32-bit BMP (bottom-up or top-down) → {width, height, rgb565}. */
export function bmpToRgb565(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') throw fault('display-image-invalid');
  const offset = bytes.readUInt32LE(10), width = bytes.readInt32LE(18), rawHeight = bytes.readInt32LE(22);
  const bits = bytes.readUInt16LE(28), compression = bytes.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  if (width < 1 || height < 1 || width > 320 || height > 240 || ![24, 32].includes(bits) || ![0, 3].includes(compression))
    throw fault('display-image-invalid');
  const step = bits / 8, stride = Math.ceil(width * step / 4) * 4;
  if (offset + stride * height > bytes.length) throw fault('display-image-invalid');
  const out = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y++) {
    const row = offset + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * step, b = bytes[p], g = bytes[p + 1], r = bytes[p + 2];
      out.writeUInt16LE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), (y * width + x) * 2);
    }
  }
  return { width, height, rgb565: out };
}

/** Fit an image file inside maxWidth x maxHeight (aspect kept) with sips, then convert. */
export async function loadImageRgb565(path, { maxWidth = 320, maxHeight = 240 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-image-'));
  try {
    const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeout: 15000 });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]), height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    if (!(width > 0 && height > 0)) throw fault('display-image-unreadable');
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
    const bmp = join(directory, 'image.bmp');
    await run('/usr/bin/sips', ['-s', 'format', 'bmp', '-z', String(h), String(w), path, '--out', bmp], { timeout: 15000 });
    return bmpToRgb565(await readFile(bmp));
  } catch (error) {
    throw error?.code?.startsWith?.('display-') ? error : fault('display-image-unreadable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
