// SPDX-License-Identifier: MIT
// Optional text clean-up between the recognizer and the conversation. Off by
// default; every personal correction lives in the user's own preferences.
import { hantHansPairs } from './transcript-hant-hans.mjs';

let table = null;
function hantHans() {
  if (!table) {
    table = new Map();
    const points = [...hantHansPairs];
    for (let i = 0; i + 1 < points.length; i += 2) table.set(points[i], points[i + 1]);
  }
  return table;
}

export function simplifyChinese(text) {
  const map = hantHans();
  let out = '';
  for (const ch of text) out += map.get(ch) ?? ch;
  return out;
}

/** Build a transcript filter. `replacements` are literal {from,to} pairs applied
 * after simplification, longest first so a short rule cannot break a long one. */
export function createTranscriptFilter({ simplify = false, replacements = [] } = {}) {
  const rules = replacements
    .filter(rule => typeof rule?.from === 'string' && rule.from && typeof rule.to === 'string')
    .map(rule => ({ from: simplify ? simplifyChinese(rule.from) : rule.from, to: rule.to }))
    .sort((a, b) => b.from.length - a.from.length);
  if (!simplify && !rules.length) return text => text;
  return text => {
    let result = simplify ? simplifyChinese(text) : text;
    for (const { from, to } of rules) result = result.split(from).join(to);
    return result;
  };
}
