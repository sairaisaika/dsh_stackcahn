// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable } from '../src/speech-text.mjs';

test('leaked tool-call markup is never read aloud', () => {
  // Seen on the v63 device trial: the reply carried DSML tool-call tags and the voice said "slash".
  const said = speakable('好的，我看一下。</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜calls>');
  assert.equal(said, '好的，我看一下。');
  assert.doesNotMatch(speakable('<｜DSML｜invoke name="x">{"a":1}'), /[<>｜]/);
});

test('markdown, links, urls and paths are reduced to their words', () => {
  assert.equal(speakable('## 结果\n- **第一**：完成\n- 第二：[文档](https://example.com/x)'), '结果\n第一：完成\n第二：文档');
  assert.equal(speakable('看这里 https://example.com/a?b=1 就行'), '看这里 就行');
  assert.equal(speakable('文件在 /Users/me/a/b.txt 里'), '文件在 里');
  assert.equal(speakable('输入 /new 开始'), '输入 开始');
  assert.equal(speakable('用 `npm test` 跑一下'), '用 npm test 跑一下');
  assert.equal(speakable('一半是 1/2'), '一半是 1/2');  // Not a path.
  assert.equal(speakable('> 引用\n真的吗？？？'), '引用\n真的吗？');
  assert.equal(speakable('| 名称 | 值 |\n|---|---|\n| 温度 | 12度 |'), '名称，值\n温度，12度');
});

test('mostly code becomes a short notice; a little code is dropped', () => {
  const code = '```js\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\n```';
  assert.equal(speakable(`这样写：\n${code}`), '详细内容我放在屏幕上了。');
  assert.equal(speakable(code, 'en'), "I've put the details on screen.");
  assert.equal(speakable('先说结论：可以直接用，原因是它已经支持缓存，也不需要额外的配置。\n```\nx\n```'),
    '先说结论：可以直接用，原因是它已经支持缓存，也不需要额外的配置。');
});

test('plain speech passes through unchanged', () => {
  for (const text of ['我在呢，怎么啦？', '今天是11月22日，气温大概12度。', "Hello, it's me.", 'DeepSeek 的新模型已经发布了。'])
    assert.equal(speakable(text), text);
  assert.equal(speakable('```\n```'), '详细内容我放在屏幕上了。');
  assert.equal(speakable(''), '');
  assert.equal(speakable(null), '');
});
