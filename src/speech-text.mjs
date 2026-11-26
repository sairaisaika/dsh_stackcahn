// SPDX-License-Identifier: MIT
/**
 * Turn a model reply into something worth saying aloud. Captions keep the
 * original text; only the synthesizer sees this. Modelled on OpenClaw's
 * speech-text handling (MIT): drop markup and code, keep link labels, say a
 * short notice when most of the reply is code.
 */
const ONSCREEN = { zh: '详细内容我放在屏幕上了。', en: "I've put the details on screen." };

// Leaked tool-call markup such as `</｜｜DSML｜｜invoke>` and ordinary tags.
const TOOL_MARKUP = /<\/?\s*[|｜]+[^<>]{0,120}>/gu;
const TAGS = /<\/?[A-Za-z][\w:-]{0,40}(\s[^<>]{0,200})?\/?>/g;
const FENCE = /```[^\n`]*\n?[\s\S]*?(```|$)/g;
const URL = /\bhttps?:\/\/[^\s)）>\]]+/gi;
// A path or slash command: /new, ~/x, /Users/a/b, C:\x. Not a lone slash like 1/2.
const PATH = /(^|[\s(（:：])(~?\/[\w.\-~]+(\/[\w.\-~]*)*|[A-Za-z]:\\[\w.\\-]+)/g;

export function speakable(text, language = 'zh') {
  if (typeof text !== 'string') return '';
  let value = text.replace(/\r\n?/g, '\n');
  const fenced = value.match(FENCE)?.join('').length ?? 0;
  if (fenced && fenced > value.replace(/\s+/g, '').length * 0.5) return ONSCREEN[language === 'en' ? 'en' : 'zh'];
  value = value
    .replace(FENCE, ' ')
    .replace(TOOL_MARKUP, ' ')
    .replace(TAGS, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')            // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')           // links keep their label
    .replace(URL, ' ')
    .replace(/`([^`\n]*)`/g, '$1')                     // inline code keeps its text
    .replace(PATH, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                // headings
    .replace(/^\s{0,3}>\s?/gm, '')                     // quotes
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')           // list markers
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '') // table rules
    .replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, '$1')      // table row edges
    .replace(/[ \t]*\|[ \t]*/g, '，')                  // table cells
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([^\n]*?\S)\1/g, '$2') // emphasis
    .replace(/[*_~#`<>|｜\\]/g, ' ')                   // stray markup characters
    .replace(/([。！？!?.,，、；;：:])\1+/g, '$1')      // repeated punctuation
    .replace(/^[，、；;：:\s]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return value;
}
