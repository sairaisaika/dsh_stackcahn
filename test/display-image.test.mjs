import test from 'node:test';
import assert from 'node:assert/strict';
import { bmpToRgb565 } from '../src/display-image.mjs';

const bmp = (width, height, pixel, { topDown = false } = {}) => {
  const stride = Math.ceil(width * 3 / 4) * 4, bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM', 0, 'ascii'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(topDown ? -height : height, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = pixel(x, y), p = 54 + (topDown ? y : height - 1 - y) * stride + x * 3;
    bytes[p] = b; bytes[p + 1] = g; bytes[p + 2] = r;
  }
  return bytes;
};

test('BMP pixels become little-endian RGB565 in screen order', () => {
  const pixel = (x, y) => (y === 0 ? [255, 0, 0] : [0, 0, 255]);
  for (const topDown of [false, true]) {
    const image = bmpToRgb565(bmp(3, 2, pixel, { topDown }));
    assert.deepEqual([image.width, image.height], [3, 2]);
    assert.equal(image.rgb565.readUInt16LE(0), 0xf800);          // Top row red.
    assert.equal(image.rgb565.readUInt16LE(3 * 2), 0x001f);      // Second row blue.
  }
  assert.throws(() => bmpToRgb565(bmp(321, 1, () => [0, 0, 0])), { code: 'display-image-invalid' });
  assert.throws(() => bmpToRgb565(Buffer.from('nope')), { code: 'display-image-invalid' });
});
