// 文学性尺子的命令行：给一段话打分，或跑 40 条基准看尺子还准不准。
//
// 用法（在 qq-bridge 目录下）：
//   npm run eval:literary                    跑基准集：分组均值 + 分得开不开，分不开退出码 1
//   npm run eval:literary -- --text "一句话"  给单句打分，打印各项与扣分理由
//   npm run eval:literary -- --file a.txt    给文件打分（整篇）
//   npm run eval:literary -- --json          机器可读输出
//   npm run eval:literary -- --set 其它.json  换一套基准
//   npm run eval:literary -- --history      拿她最近 200 条真实发言打分（state/history/ 里读）
//   npm run eval:literary -- --history 500  同上，取最近 500 条
//
// 为什么退出码有意义：这把尺子会被拿去比「改人格卡前 / 改之后」，如果它自己都分不开
// good / flat / slop，那任何比较都没有意义。所以基准跑不过就非零退出，方便挂进 CI。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreBatch, scoreText } from '../src/literary-score.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_SET = path.join(root, 'scripts', 'fixtures', 'literary-eval.json');

function parseArgs(argv) {
  const out = { text: null, file: null, set: DEFAULT_SET, json: false, help: false, history: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') out.text = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--set') out.set = argv[++i];
    else if (a === '--history') {
      // --history 后面跟数字就取那么多条，否则默认 200
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) { out.history = Number(next); i++; } else out.history = 200;
    }
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('--')) out.text = a;
  }
  return out;
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmt(n, width = 5) {
  return String(Math.round(n * 10) / 10).padStart(width);
}

function printOne(label, text) {
  const r = scoreText(text);
  console.log('');
  console.log(label + '  ' + r.total + ' 分 · ' + r.band + '  (' + r.chars + ' 字)');
  console.log('  具体性 ' + fmt(r.metrics.concreteness.score * 100) + '  画面 ' + fmt(r.metrics.imagery.score * 100) + '  节奏 ' + fmt(r.metrics.rhythm.score * 100) + '  质感 ' + fmt(r.metrics.texture.score * 100) + '  人味 ' + fmt(r.metrics.voice.score * 100) + '  AI腔 ' + fmt(r.metrics.slop.score * 100));
  const c = r.metrics.concreteness;
  if (c.hits.length) console.log('  看见的东西：' + c.hits.slice(0, 10).join('、'));
  const im = r.metrics.imagery;
  const img = [].concat(im.similes, im.measures, im.senses);
  if (img.length) console.log('  画面来源：' + img.slice(0, 10).join('、'));
  const sl = r.metrics.slop;
  if (sl.hits.length) console.log('  AI 腔：' + sl.hits.join('、'));
  if (r.notes.length) for (const n of r.notes) console.log('  · ' + n);
  console.log('');
}

// 拿她自己说过的话打分：只取 out（出站）、去掉媒体占位符、太短的反应句（"草"「行吧」）不算——
// 那种句子本来就该画面低、人味高，混进均值只会把结论带偏。
function readOutbound(n) {
  const dir = path.join(root, 'state', 'history');
  if (!fs.existsSync(dir)) return [];
  const lines = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.dir !== 'out' || !row.text) continue;
      const text = String(row.text)
        .replace(/\[(?:图片|表情|语音|视频|文件|卡片)[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length < 6) continue;
      if (text.includes('\uFFFD')) continue; // 早期日志有过编码坏掉的行，别让它拉低均值
      lines.push({ at: row.tsMs || 0, text });
    }
  }
  lines.sort((a, b) => a.at - b.at);
  return lines.slice(-n);
}

function runHistory(n, json) {
  const items = readOutbound(n);
  if (!items.length) {
    console.error('state/history/ 里没有可打分的出站消息（她还没说过话，或历史关闭）。');
    return 1;
  }
  const scored = items.map((it) => ({ text: it.text, score: scoreText(it.text) }));
  const totals = scored.map((x) => x.score.total);
  const metrics = ['concreteness', 'imagery', 'rhythm', 'texture', 'voice', 'slop'];
  const means = {};
  for (const k of metrics) means[k] = mean(scored.map((x) => x.score.metrics[k].score));
  const bands = {};
  for (const x of scored) bands[x.score.band] = (bands[x.score.band] || 0) + 1;

  if (json) {
    console.log(JSON.stringify({
      n: scored.length,
      mean: Math.round(mean(totals) * 10) / 10,
      median: Math.round(median(totals) * 10) / 10,
      metrics: means,
      bands,
      worst: scored.slice().sort((a, b) => a.score.total - b.score.total).slice(0, 5).map((x) => ({ total: x.score.total, text: x.text })),
      best: scored.slice().sort((a, b) => b.score.total - a.score.total).slice(0, 5).map((x) => ({ total: x.score.total, text: x.text }))
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log('她最近 ' + scored.length + ' 条发言（出站，去掉图片/表情与 6 字以下的反应句）');
  console.log('');
  console.log('  均值 ' + fmt(mean(totals)) + '   中位 ' + fmt(median(totals)) + '   最低 ' + fmt(Math.min(...totals)) + '   最高 ' + fmt(Math.max(...totals)));
  console.log('  具体性 ' + fmt(means.concreteness * 100) + '  画面 ' + fmt(means.imagery * 100) + '  节奏 ' + fmt(means.rhythm * 100) + '  质感 ' + fmt(means.texture * 100) + '  人味 ' + fmt(means.voice * 100) + '  AI腔 ' + fmt(means.slop * 100));
  console.log('  分档：' + Object.entries(bands).map(([b, c]) => b + ' ' + c).join('   '));
  // 长度分组：聊天里大半是短反应句，混在一起看均值会误判成"文学性差"
  const buckets = [['短（6~14 字）', 6, 15], ['中（15~39 字）', 15, 40], ['长（40 字以上）', 40, Infinity]];
  const bucketText = buckets.map(([label, lo, hi]) => {
    const rows = scored.filter((x) => x.text.length >= lo && x.text.length < hi);
    return rows.length ? label + ' n=' + rows.length + ' 均值 ' + (Math.round(mean(rows.map((x) => x.score.total)) * 10) / 10) : label + ' 无样本';
  });
  for (const line of bucketText) console.log('  ' + line);
  console.log('');
  const sorted = scored.slice().sort((a, b) => b.score.total - a.score.total);
  console.log('  最像人写的 5 条：');
  for (const x of sorted.slice(0, 5)) console.log('   ' + fmt(x.score.total) + '  ' + x.text.slice(0, 46));
  console.log('');
  console.log('  最平的 5 条：');
  for (const x of sorted.slice(-5).reverse()) console.log('   ' + fmt(x.score.total) + '  ' + x.text.slice(0, 46));
  console.log('');
  console.log('  短句（"草""行吧"）本来就画面低，别拿单句下结论；要看变化就同口径前后各跑一次比均值。');
  console.log('');
  return 0;
}

function runSet(setPath, json) {
  const raw = fs.readFileSync(setPath, 'utf8');
  const set = JSON.parse(raw);
  const rows = scoreBatch(set.items || []);
  const byLabel = new Map();
  for (const row of rows) {
    if (!byLabel.has(row.label)) byLabel.set(row.label, []);
    byLabel.get(row.label).push(row.score.total);
  }
  const stats = [...byLabel.entries()].map(([label, scores]) => ({
    label,
    n: scores.length,
    mean: Math.round(mean(scores) * 10) / 10,
    median: Math.round(median(scores) * 10) / 10,
    min: Math.round(Math.min(...scores) * 10) / 10,
    max: Math.round(Math.max(...scores) * 10) / 10
  }));

  // 分得开的三条判据：均值有序、两条间隙 ≥ 8 分、good 的下四分位仍高于 slop 的上四分位
  const pick = (l) => (byLabel.get(l) || []);
  const goodScores = pick('good');
  const flatScores = pick('flat');
  const slopScores = pick('slop');
  const checks = [];
  const g = mean(goodScores);
  const f = mean(flatScores);
  const s = mean(slopScores);
  if (goodScores.length && flatScores.length) checks.push({ name: 'good 均值 > flat 均值 + 8', ok: g > f + 8, detail: g.toFixed(1) + ' vs ' + f.toFixed(1) });
  if (flatScores.length && slopScores.length) checks.push({ name: 'flat 均值 > slop 均值 + 8', ok: f > s + 8, detail: f.toFixed(1) + ' vs ' + s.toFixed(1) });
  if (goodScores.length && slopScores.length) {
    const worstGood = goodScores.slice().sort((a, b) => a - b)[Math.max(0, Math.floor(goodScores.length * 0.25))];
    const bestSlop = slopScores.slice().sort((a, b) => b - a)[Math.max(0, Math.floor(slopScores.length * 0.25))];
    checks.push({ name: 'good 下四分位 > slop 上四分位', ok: worstGood > bestSlop, detail: worstGood.toFixed(1) + ' vs ' + bestSlop.toFixed(1) });
  }

  if (json) {
    console.log(JSON.stringify({ set: path.basename(setPath), stats, checks, rows: rows.map((r) => ({ id: r.id, label: r.label, total: r.score.total, band: r.score.band, text: r.text })) }, null, 2));
    return checks.every((c) => c.ok);
  }

  console.log('');
  console.log('基准：' + (set.name || path.basename(setPath)) + '（' + rows.length + ' 条）');
  console.log('');
  console.log('  组     条数   均值   中位   最低   最高');
  for (const st of stats) {
    console.log('  ' + st.label.padEnd(6) + String(st.n).padStart(4) + fmt(st.mean, 7) + fmt(st.median, 7) + fmt(st.min, 7) + fmt(st.max, 7));
  }
  console.log('');
  const worst = rows.slice().sort((a, b) => a.score.total - b.score.total).slice(0, 5);
  console.log('  最低的 5 条：');
  for (const r of worst) console.log('   ' + r.id + ' [' + r.label + '] ' + fmt(r.score.total) + ' ' + r.score.band + '  ' + r.text.slice(0, 34));
  console.log('');
  let failed = false;
  for (const c of checks) {
    console.log('  ' + (c.ok ? '✅' : '❌') + ' ' + c.name + '（' + c.detail + '）');
    if (!c.ok) failed = true;
  }
  console.log('');
  console.log(failed ? '基准没分开：改词表/权重后先让它重新拉开，再用它比改动的效果。' : '尺子分得开：可以用它比较「改之前 / 改之后」。');
  return !failed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：eval-literary [--text 句子 | --file 文件 | --history [条数]] [--set 基准.json] [--json]');
    return 0;
  }
  if (args.text != null) { printOne('单句', args.text); return 0; }
  if (args.file) { printOne(path.basename(args.file), fs.readFileSync(args.file, 'utf8')); return 0; }
  if (args.history != null) return runHistory(args.history, args.json);
  if (!fs.existsSync(args.set)) {
    console.error('找不到基准文件：' + args.set);
    return 1;
  }
  return runSet(args.set, args.json) ? 0 : 1;
}

process.exit(main());
