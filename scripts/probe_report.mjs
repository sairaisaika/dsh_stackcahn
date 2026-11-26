// Turn one guided body session (body_probe.mjs --steps ...) into a readable report.
//
//   node scripts/probe_report.mjs DIR [--whisper]
//
// Reads DIR/body-probe.jsonl, writes DIR/report.md and prints it. Only reads the session's own files;
// with --whisper it also transcribes the 'listen' recordings with the local whisper-cli (offline).
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { simplifyChinese } from '../src/transcript-text.mjs';

const db = v => v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -120;
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const stats = a => a.length ? { min: Math.min(...a), max: Math.max(...a), mean: Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 } : null;
const fmt = s => s ? `${s.min} … ${s.max}（均 ${s.mean}）` : '—';

/** Find where a channel is "on" in one duplex envelope: onset, offset, plateau and any later bursts. Exported for tests. */
export function analyseChannel(env, toneStart, toneWindows) {
  const pre = env.slice(0, Math.max(1, toneStart));
  const floor = Math.max(median(pre), 0.0005);
  const threshold = Math.max(floor * 6, 0.003);
  const on = env.map(v => v > threshold);
  const segments = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i]) continue;
    let j = i; while (j + 1 < on.length && (on[j + 1] || on[j + 2])) j++;   // bridge one-window dips
    segments.push([i, j]); i = j;
  }
  const after = segments.filter(([a]) => a >= toneStart);
  if (!after.length) return { floor, heard: false, segments: [] };
  const [onset, offset] = after[0];
  const plateau = median(env.slice(onset + 2, Math.max(onset + 3, Math.min(offset - 1, onset + toneWindows - 2))));
  return { floor, heard: true, onset, offset, latencyMs: (onset - toneStart) * 20, activeMs: (offset - onset + 1) * 20,
    plateau, extraBursts: after.slice(1).map(([a, b]) => ({ afterEndMs: (a - offset) * 20, lengthMs: (b - a + 1) * 20 })) };
}

/** Character error rate after dropping punctuation and spaces. Exported for tests. */
export function cer(reference, hypothesis) {
  const clean = s => [...s.replace(/[\s\p{P}]/gu, '').toLowerCase()];
  const a = clean(reference), b = clean(hypothesis);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return a.length ? Math.round(d[a.length][b.length] / a.length * 1000) / 1000 : 0;
}

function transcribe(wav, channel) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cli = join(root, 'work/whisper-v1.9.5/build-sion/bin/whisper-cli');
  const voice = join(homedir(), '.dsh/profiles/desktop/.stackchan-voice');
  const model = existsSync(voice) ? execFileSync('find', [voice, '-name', 'ggml-*.bin'], { encoding: 'utf8' }).split('\n')[0] : '';
  if (!existsSync(cli) || !model) return { error: 'whisper-cli or model not found' };
  const dir = mkdtempSync(join(tmpdir(), 'probe-asr-'));
  try {
    const mono = join(dir, 'mono.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-i', wav, '-af', `pan=mono|c0=c${channel}`, '-ar', '16000', mono]);
    const text = execFileSync(cli, ['-m', model, '-l', 'zh', '-nt', '-np', '-f', mono], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { text: simplifyChinese(text.trim()) };
  } catch (error) { return { error: String(error.message ?? error).slice(0, 200) }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export function buildReport(lines, { whisper = false } = {}) {
  const events = lines.filter(Boolean).map(l => JSON.parse(l));
  let section = 'start', volume = null;
  for (const e of events) {
    if (e.event === 'label' && e.text.startsWith('section:')) section = e.text.slice(8);
    if (e.event === 'volume') volume = e.target?.volume ?? volume;
    e.section = section; e.volume = volume;
  }
  const out = [];
  const say = s => out.push(s);
  const of = (sec, kind) => events.filter(e => e.section === sec && (!kind || e.event === kind));
  const started = events.find(e => e.event === 'probe-started');
  say(`# 身体测试报告`);
  say(`\n开始 ${started?.at ?? '?'}，共 ${events.length} 条事件。由 \`scripts/probe_report.mjs\` 生成，数字直接来自 body-probe.jsonl。`);

  const problems = events.filter(e => /-failed$|^link-closed$/.test(e.event));
  say(`\n## 总览\n`);
  say(`- 能力：\`${JSON.stringify(events.find(e => e.event === 'authenticated')?.capabilities ?? null)}\``);
  say(`- 失败或断线：${problems.length ? '' : '无'}`);
  for (const p of problems) say(`  - [${p.section}] \`${p.event}\` ${p.code ?? ''} ${p.missing ? `缺 ${p.missing}` : ''}`);

  // Baseline sensors.
  const base = of('baseline', 'record')[0]?.result?.samples ?? [];
  if (base.length) {
    say(`\n## 静止基线\n`);
    const pick = (sensor, f) => base.filter(s => s.sensor === sensor && s.value).map(s => f(s.value)).filter(v => Number.isFinite(v));
    say(`| 传感器 | 范围 |\n|---|---|`);
    say(`| IMU 加速度 z（mg） | ${fmt(stats(pick('imu', v => v.accelerationMg?.[2])))} |`);
    for (let c = 0; c < 3; c++) say(`| 头顶通道 ${c + 1} | ${fmt(stats(pick('headTouch', v => v.levels?.[c])))} |`);
    say(`| 环境光 | ${fmt(stats(pick('ambient', v => v.light)))} |`);
    say(`| 接近（原始） | ${fmt(stats(pick('ambient', v => v.proximityRaw)))} |`);
    say(`| 电流（mA） | ${fmt(stats(pick('power', v => v.currentMa)))} |`);
    say(`| 总线电压（mV） | ${fmt(stats(pick('power', v => v.busMv)))} |`);
    say(`| 电量（%） | ${fmt(stats(pick('battery', v => v.percent)))} |`);
    const mic = of('baseline', 'mic')[0]?.result;
    if (mic) say(`\n房间底噪（两个输入通道 RMS）：${mic.rms?.map(v => `${db(v)} dBFS`).join(' / ')}`);
  }

  // Audio: which channel is the echo reference, and what each tone looked like on both.
  const duplex = events.filter(e => e.event === 'duplex');
  let micChannel = 0;
  if (duplex.length) {
    const floors = [0, 1].map(c => median(duplex.map(d => median(d.envelope[c].slice(0, Math.max(1, d.toneStartWindow))))));
    const refChannel = floors[0] < floors[1] ? 0 : 1;
    micChannel = 1 - refChannel;
    say(`\n## 声音：喇叭 → 自己的麦克风和回声参考\n`);
    say(`按开播前的底噪判断，通道 ${refChannel} 是回声参考（底噪 ${db(floors[refChannel])} dBFS），通道 ${micChannel} 是麦克风（${db(floors[micChannel])} dBFS）。`);
    say(`「延迟」是 Mac 开始发送到该通道出现声音；「多出」是声音持续时长减去应有时长（正值偏大说明结尾被重复播放）。\n`);
    say(`| 段 | 音量 | 频率 | 参考：延迟 / 电平 / 多出 | 麦克风：延迟 / 电平 / 多出 | 麦克风比参考 | 之后的额外声段 |`);
    say(`|---|---|---|---|---|---|---|`);
    for (const d of duplex) {
      const r = analyseChannel(d.envelope[refChannel], d.toneStartWindow, d.toneWindows);
      const m = analyseChannel(d.envelope[micChannel], d.toneStartWindow, d.toneWindows);
      const cell = a => a.heard ? `${a.latencyMs} ms / ${db(a.plateau)} dBFS / ${a.activeMs - d.target.durationMs} ms` : '没听到';
      const bursts = [...r.extraBursts ?? []].map(b => `参考 +${b.afterEndMs} ms 长 ${b.lengthMs} ms`)
        .concat((m.extraBursts ?? []).map(b => `麦 +${b.afterEndMs} ms 长 ${b.lengthMs} ms`)).join('；') || '—';
      say(`| ${d.section} | ${d.volume ?? '?'} | ${d.target.hz} Hz | ${cell(r)} | ${cell(m)} | ${r.heard && m.heard ? `${Math.round((db(m.plateau) - db(r.plateau)) * 10) / 10} dB` : '—'} | ${bursts} |`);
    }
    say(`\n峰值接近 1.0 的行可能削波；把麦克风电平随音量的变化和主人的主观回答对照着看。`);
    const current = of('audio-current', 'bgrecord')[0]?.result?.samples ?? [];
    const amps = current.filter(s => s.sensor === 'power' && s.value).map(s => s.value.currentMa);
    if (amps.length) say(`\n音量 100 播 2.5 秒时的电流：${fmt(stats(amps))} mA（对照基线电流看正负号和幅度）。`);
  }

  // Every prompt and its answer.
  const asks = events.filter(e => e.event === 'ask');
  if (asks.length) {
    say(`\n## 屏幕提问与回答\n`);
    say(`| 段 | 提问 | 回答 | 位置 | 用时 |\n|---|---|---|---|---|`);
    const zh = { left: '左', middle: '中', right: '右' };
    for (const a of asks) say(`| ${a.section} | ${a.text.slice(0, 40)} | ${a.answered ? zh[a.zone] : '超时'} | ${a.answered ? `(${a.x}, ${a.y}) ${a.angleDeg}°` : ''} | ${a.afterMs ?? ''} ms |`);
  }

  // LED geometry: each LED's tap direction.
  const ledEvents = events.filter(e => e.section === 'leds');
  const leds = [];
  ledEvents.forEach((e, k) => {
    if (e.event !== 'leds' || e.target.color === '#000000') return;
    const answer = ledEvents.slice(k + 1).find(x => x.event === 'ask');
    leds.push({ led: e.target.leds[0], answer });
  });
  if (leds.length) {
    say(`\n## 灯环编号与位置\n`);
    say(`角度按屏幕坐标：0° 朝右、90° 朝下、180° 朝左、270° 朝上（「右」是看着屏幕的主人的右手边）。\n`);
    say(`| 编号 | 点的位置 | 角度 | 区域 |\n|---|---|---|---|`);
    for (const { led, answer } of leds) say(`| ${led} | ${answer?.answered ? `(${answer.x}, ${answer.y})` : '超时'} | ${answer?.angleDeg ?? ''} | ${answer?.zone ?? ''} |`);
  }

  // Ambient, IR, NFC.
  const amb = of('ambient', 'record').map(r => (r.result?.samples ?? []).filter(s => s.sensor === 'ambient').map(s => s.value));
  if (amb.length) {
    say(`\n## 环境光 / 接近\n`);
    ['盖住', '拿开'].forEach((name, k) => amb[k] && say(`- ${name}：光 ${fmt(stats(amb[k].map(v => v.light)))}；接近 ${fmt(stats(amb[k].map(v => v.proximityRaw)))}`));
  }
  const irIn = of('ir-receive', 'record')[0]?.result?.samples?.filter(s => s.sensor === 'infrared') ?? [];
  const irOut = events.filter(e => e.event === 'ir' || e.event === 'ir-failed');
  if (irIn.length || irOut.length || of('ir-receive').length) {
    say(`\n## 红外\n`);
    say(`- 收到 ${irIn.length} 个编码：${irIn.slice(0, 12).map(s => `${s.value.address}/${s.value.command}${s.value.repeat ? '(重复)' : ''}`).join('，') || '无'}`);
    say(`- 发送 ${irOut.length} 次，设备回执：${irOut.map(e => e.event === 'ir' ? 'ok' : e.code).join('，')}`);
  }
  const nfcRuns = ['nfc-on', 'nfc-off'].map(sec => ({ sec, reads: events.filter(e => e.section === sec && /^nfc(-failed)?$/.test(e.event)),
    cards: of(sec, 'record').flatMap(r => r.result?.samples?.filter(s => s.sensor === 'nfc') ?? []) }));
  if (nfcRuns.some(r => r.reads.length)) {
    say(`\n## NFC\n`);
    for (const r of nfcRuns) say(`- ${r.sec === 'nfc-on' ? '放卡' : '拿开'}：读 ${r.reads.length} 次，成功 ${r.reads.filter(e => e.event === 'nfc').length}；失败原因 ${r.reads.filter(e => e.event !== 'nfc').map(e => e.code).join('，') || '—'}；卡事件 ${r.cards.map(c => `${c.value.phase}:${c.value.uid ?? ''}`).join('，') || '无'}`);
  }

  // Camera.
  const photos = events.filter(e => e.section === 'camera' && /^photo(-failed)?$/.test(e.event));
  if (photos.length) {
    say(`\n## 相机\n`);
    for (const p of photos) say(p.event === 'photo' ? `- ${p.width}×${p.height}，${p.bytes} 字节，${p.tookMs} ms：\`${p.path}\`` : `- 失败 \`${p.code}\`，相机状态 \`${JSON.stringify(p.camera)}\``);
  }

  // Motion and stall.
  for (const sec of ['motion-free', 'motion-stall']) {
    const rec = of(sec, 'bgrecord')[0]?.result?.samples ?? [];
    const moves = events.filter(e => e.section === sec && /^(move|read)(-failed)?$/.test(e.event));
    if (!rec.length && !moves.length) continue;
    say(`\n## ${sec === 'motion-free' ? '转头（不挡）' : '转头（主人扶住）'}\n`);
    say(`- 电流 ${fmt(stats(rec.filter(s => s.sensor === 'power' && s.value).map(s => s.value.currentMa)))} mA`);
    for (const m of moves) say(`- \`${m.event}\` ${m.tookMs ?? ''} ms ${m.code ?? ''} \`${JSON.stringify(m.result ?? null).slice(0, 300)}\``);
  }

  // Fish tank.
  const stored = of('fishtank-store', 'storecrops')[0]?.result;
  const timelines = events.filter(e => /^timeline(-failed)?$/.test(e.event));
  if (stored || timelines.length) {
    say(`\n## 鱼缸\n`);
    if (stored) say(`- 存入 ${stored.length} 块：${Object.entries(stored.reduce((c, s) => ({ ...c, [s.status]: (c[s.status] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join('，')}`);
    for (const t of timelines) say(`- [${t.section}] \`${t.event}\` ${t.tookMs ?? ''} ms ${t.code ?? ''} \`${JSON.stringify(t.result ?? null).slice(0, 300)}\``);
  }

  // Listening: what the body's microphone heard of known sentences.
  const listens = events.filter(e => e.event === 'listen');
  if (listens.length) {
    say(`\n## 听写：Mac 念、身体录\n`);
    say(`| 原句 | 电平（麦） | 识别 | 字错率 |\n|---|---|---|---|`);
    for (const l of listens) {
      const asr = whisper ? transcribe(l.path, micChannel) : null;
      say(`| ${l.target.text} | ${db(l.rms?.[micChannel] ?? 0)} dBFS，峰 ${l.peak?.[micChannel]} | ${asr ? asr.text ?? asr.error : '（加 --whisper）'} | ${asr?.text ? cer(l.target.text, asr.text) : ''} |`);
    }
  }
  return out.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] ?? '.');
  const report = buildReport(readFileSync(join(dir, 'body-probe.jsonl'), 'utf8').split('\n'), { whisper: process.argv.includes('--whisper') });
  writeFileSync(join(dir, 'report.md'), report, { mode: 0o600 });
  console.log(report);
}
