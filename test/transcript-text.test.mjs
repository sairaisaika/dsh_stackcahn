import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptFilter, simplifyChinese } from '../src/transcript-text.mjs';

test('the transcript filter is a no-op unless the user turns it on', () => {
  const filter = createTranscriptFilter();
  assert.equal(filter('請記住這個'), '請記住這個');
});

test('traditional characters from the recognizer become simplified', () => {
  assert.equal(simplifyChinese('請記住，你能夠控制轉頭嗎？'), '请记住，你能够控制转头吗？');
  assert.equal(simplifyChinese('hello 123'), 'hello 123');
});

test('user replacements run after simplification, longest first', () => {
  const filter = createTranscriptFilter({ simplify: true, replacements: [
    { from: '在嗎', to: '在吗' }, { from: '有地在嗎', to: '小D在吗' }, { from: '', to: 'x' }] });
  assert.equal(filter('有地在嗎?'), '小D在吗?');
  assert.equal(filter('你在嗎'), '你在吗');
});
