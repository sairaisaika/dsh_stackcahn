import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import {registerCapabilityTools} from '../src/capability-tools.mjs';
import {parseCapabilityContainer, parseNdefMessage, parseType2Tlvs} from '../src/nfc-ndef.mjs';

// An NTAG215 laid out as NXP ships it: 135 pages, CC E1 10 3E 00 (496-byte data area).
function ntag215(records) {
  const memory = Buffer.alloc(135 * 4);
  Buffer.from('04a1b2 9f c3d4e580 a7 48 0000'.replace(/ /g, ''), 'hex').copy(memory, 0);
  Buffer.from('e1103e00', 'hex').copy(memory, 12);
  const message = Buffer.concat(records);
  const tlv = message.length < 255 ? Buffer.from([0x03, message.length]) : Buffer.from([0x03, 0xff, message.length >> 8, message.length & 255]);
  Buffer.concat([Buffer.from([0x01, 0x03, 0xa0, 0x0c, 0x34]), tlv, message, Buffer.from([0xfe])]).copy(memory, 16);
  return memory;
}
const uriRecord = (first, last, code, rest) => Buffer.concat([Buffer.from([0x10 | 0x01 | (first ? 0x80 : 0) | (last ? 0x40 : 0), 1, 1 + rest.length, 0x55, code]), Buffer.from(rest)]);
const textRecord = (first, last, lang, text) => {
  const body = Buffer.from(text), size = 1 + lang.length + body.length, flags = 0x01 | (first ? 0x80 : 0) | (last ? 0x40 : 0);
  const head = size < 256 ? Buffer.from([flags | 0x10, 1, size]) : Buffer.from([flags, 1, size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255]);
  return Buffer.concat([head, Buffer.from([0x54, lang.length]), Buffer.from(lang), body]);
};

test('Type 2 capability container, TLVs and NDEF records decode, with raw bytes kept', () => {
  const memory = ntag215([uriRecord(true, false, 4, 'm5stack.com/stackchan'), textRecord(false, true, 'en', 'Tap to Build')]);
  assert.deepEqual(parseCapabilityContainer(memory.subarray(12, 16)), { version: '1.0', dataAreaBytes: 496, readAccess: 0, writeAccess: 0 });
  assert.equal(parseCapabilityContainer(Buffer.from('00000000', 'hex')), null);
  const { ndef } = parseType2Tlvs(memory.subarray(16));
  assert.equal(ndef.complete, true);
  assert.equal(ndef.records.length, 2);
  assert.equal(ndef.records[0].uri, 'https://m5stack.com/stackchan');
  assert.equal(ndef.records[0].type, 'U');
  assert.equal(ndef.records[0].payloadHex, Buffer.concat([Buffer.from([4]), Buffer.from('m5stack.com/stackchan')]).toString('hex'));
  assert.deepEqual([ndef.records[1].text, ndef.records[1].language], ['Tap to Build', 'en']);
  // Three-byte TLV length, a cut-off message, UTF-16 text and media records.
  const long = textRecord(true, true, 'zh', '你好'.repeat(60));
  assert.equal(parseType2Tlvs(ntag215([long]).subarray(16)).ndef.records[0].text, '你好'.repeat(60));
  assert.equal(parseType2Tlvs(ntag215([long]).subarray(16, 16 + 100)).ndef.complete, false);
  const utf16 = Buffer.concat([Buffer.from([0xd1, 1, 7, 0x54, 0x82]), Buffer.from('en'), Buffer.from([0x4f, 0x60, 0x59, 0x7d])]);
  assert.equal(parseNdefMessage(utf16).records[0].text, '你好');
  const media = Buffer.concat([Buffer.from([0xd2, 10, 2]), Buffer.from('text/plain'), Buffer.from('hi')]);
  assert.deepEqual(parseNdefMessage(media).records[0].mediaType, 'text/plain');
  assert.deepEqual(parseType2Tlvs(Buffer.from([0x00, 0xfe])), { ndef: null, terminated: true });
});

test('stackchan_nfc_read reads the NDEF area in device-sized chunks and only reads', async t => {
  const ctx = new Context(); ctx.provide('systemPrompt', { tools() { return () => {}; } });
  await ctx.plugin(Tools); await ctx.plugin(Native); t.after(() => ctx.fiber.dispose());
  let memory = ntag215([uriRecord(true, true, 4, 'm5stack.com')]);
  let uid = '04a1b2c3d4e580';
  const requests = [];
  await ctx.plugin({ name: 'nfc-fixture', inject: ['tools'], apply(child) { registerCapabilityTools(child, {
    async readNfc(_agent, { page, count }, signal) {
      signal.throwIfAborted();
      requests.push([page, count]);
      assert.ok(count >= 1 && count <= 64 && page + count <= 256);
      if ((page + count) * 4 > memory.length) throw Object.assign(new Error('nfc-failed'), { code: 'nfc-failed' });
      const result = { version: 1, card: { uid, atqa: 68, sak: 0, getVersion: '0004040201001103' }, page, count,
        dataHex: memory.subarray(page * 4, (page + count) * 4).toString('hex') };
      uid = uid === 'swap' ? 'other' : uid;
      return result;
    } }); } });
  let id = 0;
  const run = async args => (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'nfc-' + (++id), name: 'stackchan_nfc_read',
    arguments: JSON.stringify(args) }], signal: new AbortController().signal })).results[0].result;
  const ndef = await run({});
  assert.equal(ndef.isError, false, JSON.stringify(ndef));
  assert.deepEqual(requests, [[0, 4], [4, 64], [68, 60]]);           // 496 bytes = 124 pages after the header
  assert.equal(ndef.value.count, 128);
  assert.equal(ndef.value.dataHex, memory.subarray(0, 128 * 4).toString('hex'));
  assert.equal(ndef.value.card.getVersion, '0004040201001103');
  assert.equal(ndef.value.ndef.records[0].uri, 'https://m5stack.com');
  requests.length = 0;
  const pages = await run({ page: 130, count: 5 });                  // Exactly what was asked for
  assert.deepEqual(requests, [[130, 5]]);
  assert.equal(pages.value.dataHex.length, 40);
  assert.match(JSON.stringify(await run({ page: 133, count: 5 })), /nfc-failed/);   // Past the end of the card
  assert.equal((await run({ page: 250, count: 7 })).isError, true);
  assert.equal((await run({ page: 0, count: 4, write: true })).isError, true);
  memory = Buffer.alloc(135 * 4);                                     // No capability container
  assert.match(JSON.stringify(await run({})), /nfc-no-ndef/);
  memory = ntag215([uriRecord(true, true, 4, 'm5stack.com')]);uid = 'swap';
  assert.match(JSON.stringify(await run({})), /nfc-card-changed/);
});
