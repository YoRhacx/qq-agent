// 真人语感 + 发送前清洗（style guard）
//
// 为什么要有这个模块：人格卡里写一百遍「像真人说话」，模型还是照旧「您好，很高兴为您服务」——
// 因为它手里没有「这群人此刻到底怎么说话」的坐标。这里做三件事，一件都不调模型：
//   ① 统计：从最近 sampleSize（默认 300）条**真实群友**消息里算语感基准 —— 中位句长、
//      无标点率、口头禅 top N、表情/语气词频率、分条习惯（同一人 1 分钟内的连发算一组）；
//   ② 注入：把基准压成一小块带 marker 的提示词（STYLE_BEGIN … STYLE_END），
//      比讲道理省 token，也比讲道理管用；被 injectStyle / styleInGroup 两个开关卡住；
//   ③ 清洗：出站最后一道 checkOutgoing() —— 压客服腔、拆长段落、合并重复标点、砍结尾客套。
//
// 与 identity-guard 的分工：这里只改「怎么说」，不管「能不能说」。自曝类（我是 AI / 我是程序）
// 归 identity-guard，本模块不重复实现，所以 checkOutgoing().blocked 恒为 false —— 能拦话的
// 只有身份守卫，这里只让话变短、变人话。
//
// 落盘形状（state/style-guard.json，一份文件装所有会话的采样）：
//   { "version": 1, "samples": [ { "text": "在吗", "at": 1719849600000, "from": "10001" } ], "updatedAt": 0 }
//   - samples 只留最近 sampleSize 条（环形裁剪，新的在后）；
//   - 统计结果**不落盘**：300 条现算只要毫秒级，缓存反而多一种「文件里的数与样本不符」的可能。
//
// 开关独立可关（关掉真的不建文件、不生效）：
//   enabled=false       总闸：不读盘、不写盘、不采样、不注入、不清洗
//   collect=false       只停采样（仍然读已有样本、仍可注入/清洗）；同时不再写盘
//   injectStyle=false   不注入
//   styleInGroup=true   只在群聊注入（私聊没有「这群人」的语感基准）
//   cleanOutgoing=false 发送前不清洗
//
// 本模块不是 AGENTS.md 里说的「纯函数模块」：它自带一个小状态文件（写法照 src/reminders.js，
// 原子写 + 只在真改动时写）。纯函数部分都单独 export，测试可以直接喂数据，不碰 fs。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STYLE_VERSION = 1;
/** 注入块的起止 marker：重复注入时先剥旧块，避免提示词里越积越多。 */
export const STYLE_BEGIN = '<!-- STYLE:BEGIN -->';
export const STYLE_END = '<!-- STYLE:END -->';
export const STYLE_BLOCK_RE = /<!-- STYLE:BEGIN -->[\s\S]*?<!-- STYLE:END -->/g;
/** 代码块围栏（三个反引号）：用转义写出来，免得本文件自己出现围栏字符。 */
const CODE_FENCE = '\u0060\u0060\u0060';

/** 默认状态文件：跟着模块走（src/../state/），与进程 cwd 无关。 */
export const DEFAULT_STYLE_STATE_FILE = fileURLToPath(new URL('../state/style-guard.json', import.meta.url));

export const DEFAULT_STYLE_GUARD_CONFIG = Object.freeze({
  enabled: true,
  collect: true,
  sampleSize: 300,
  minSamples: 20,          // 少于这个数不注入：样本太少的中位数没有说服力，只会污染提示词
  injectStyle: true,
  styleInGroup: true,
  cleanOutgoing: true,
  particleTopN: 5,
  exampleCount: 4,
  maxBlockChars: 600,
  maxParagraphChars: 100,  // 单行超过这个长度才拆
  lineChars: 40,           // 拆完每行尽量不超过这个长度
  shortLineMax: 30,        // 短句（<=N 字）结尾的句号去掉，微信式
  burstGapMs: 60 * 1000,   // 同一人在这段时间内的连续消息算一组（分条习惯）
  fallbackText: '嗯',      // 清洗后一个字都不剩时说的话
  stateFile: ''            // 空 = state/style-guard.json（config 里可覆盖）
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const boolOf = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
const charLen = (s) => Array.from(String(s ?? '')).length;
const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;

function clip(text, max = 120) {
  const arr = Array.from(String(text ?? ''));
  return arr.length > max ? arr.slice(0, Math.max(0, max - 1)).join('') + '…' : arr.join('');
}

// ── 词表 ────────────────────────────────────────────────────────────────────
/** 口头禅候选：单字语气词（参考包 PARTICLES，补了几个常见的）。 */
const PARTICLES = ['吧', '哦', '呢', '嘛', '呀', '啊', '哈', '啦', '呗', '咯', '诶', '唉', '嘿', '嗯', '噢', '喔'];
/** QQ 表情码 / 卡片占位的方括号段，如 [微笑] [图片] [卡片消息]。 */
const FACE_RE = /\[[^\[\]\n]{1,10}\]/g;
/** 整条消息只是一串方括号占位（[图片][表情]）时，不算「说的话」。 */
const MEDIA_ONLY_RE = /^(?:\[[^\[\]\n]{1,10}\]\s*)+$/;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const KAOMOJI_RE = /(?:[（(][^（）()\n]{1,12}[）)])|(?:[qQ][wW][qQ])|(?:[tT]_[tT])|(?:\^_?\^)|(?:>_<)/;
const PUNCT_END_RE = /[。！？!?…]+$/;
/** 整条只是一个链接：贴链接不是「说话」，混进统计会把中位句长拉歪。 */
const LINK_ONLY_RE = /^(?:https?:\/\/|www\.)\S+$/i;
/** 例子块要跳过的东西：引用/卡片/链接不是「说话」。 */
const EXAMPLE_SKIP_RE = /\[引用|\[At:|\[图片|\[表情|\[文件|\[卡片|\[转发消息|\[对方发来|https?:\/\//;

/**
 * 采样文本清洗：压成单行、剥掉「[管理员的朋友 xxx]」这类引用前缀。
 * 只统计真正说的话——前缀混进句长里会把中位数整体拉长两三字。
 */
export function normalizeSampleText(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:\[[^\[\]]{0,40}\]\s*)+/, '').trim();
  return t;
}

/** 一条消息值不值得进统计：剥掉表情/标点后至少还剩一个字。 */
function isWorthStats(text) {
  if (!text) return false;
  if (charLen(text) > 400) return false;                 // 整段粘贴不算「说话」
  if (MEDIA_ONLY_RE.test(text)) return false;            // 只有 [图片][表情]
  if (LINK_ONLY_RE.test(text)) return false;             // 整条只是一个链接
  const bare = text.replace(FACE_RE, '').replace(EMOJI_RE, '').replace(/[\s~～!?？。，,…、：:；;'"“”‘’]/g, '');
  return bare.length >= 1;
}

/** 去掉句尾的表情/标点，用来判断「有没有句末标点」。 */
function coreOf(text) {
  return String(text ?? '')
    .replace(FACE_RE, '')
    .replace(EMOJI_RE, '')
    .replace(KAOMOJI_RE, '')
    .replace(/\s+$/, '');
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function ratio(hit, total) {
  return total > 0 ? round3(hit / total) : 0;
}

/** 比例说成人话：0.72 → { cheng: '七成', pct: 72 }。 */
export function describeRatio(value) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const pct = Math.round(v * 100);
  const tenth = Math.round(v * 10);
  const CHENG = ['一', '两', '三', '四', '五', '六', '七', '八', '九'];
  const cheng = tenth <= 0 ? '不到一成' : tenth >= 10 ? '几乎全部' : CHENG[tenth - 1] + '成';
  return { pct, cheng };
}

/** 字符个数（按码点算，一个 emoji 算一个字）。 */
export function textLength(text) {
  return charLen(text);
}

/** 解析一条采样（容忍 archive/jsonl 里的各种字段名）。 */
function readSampleRow(row) {
  if (typeof row === 'string') return { text: row, at: null, from: '' };
  if (!isPlainObject(row)) return null;
  const rawAt = row.at ?? row.ts ?? row.createdAt ?? row.time;
  let at = null;
  if (Number.isFinite(Number(rawAt))) {
    const n = Number(rawAt);
    at = n > 1e12 ? Math.round(n) : Math.round(n * 1000);
  }
  const from = row.from ?? row.senderId ?? row.sender ?? row.uid ?? row.qq ?? '';
  return {
    text: String(row.text ?? row.content ?? row.message ?? row.msg ?? ''),
    at,
    from: from === '' || from == null ? '' : String(from)
  };
}

/**
 * 统计语感。纯函数：不读盘、不看时间。
 * @param {Array<string|object>} rows 采样（字符串，或 {text, at, from}）
 * @param {object} [options] 覆盖 DEFAULT_STYLE_GUARD_CONFIG 里的 particleTopN / exampleCount / burstGapMs
 * @returns {object} stats：n / medianLen / avgLen / shortRatio / noPunctRatio / qqFaceRatio /
 *                    emojiRatio / kaomojiRatio / particleCounts / particles / burst / examples
 */
export function analyzeStyle(rows, options = {}) {
  const cfg = { ...DEFAULT_STYLE_GUARD_CONFIG, ...(isPlainObject(options) ? options : {}) };
  const samples = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = readSampleRow(row);
    if (!item) continue;
    const text = normalizeSampleText(item.text);
    if (charLen(text) < 2 || !isWorthStats(text)) continue;
    samples.push({ text, at: item.at, from: item.from });
  }
  const n = samples.length;
  if (!n) {
    return {
      n: 0, medianLen: 0, avgLen: 0, shortRatio: 0, noPunctRatio: 0,
      qqFaceRatio: 0, emojiRatio: 0, kaomojiRatio: 0,
      particleCounts: {}, particles: [], burst: null, examples: []
    };
  }

  const lens = samples.map((s) => charLen(s.text));
  const particleCounts = {};
  for (const p of PARTICLES) {
    let count = 0;
    for (const s of samples) if (s.text.includes(p)) count += 1;
    if (count > 0) particleCounts[p] = count;
  }
  const particles = Object.keys(particleCounts)
    .sort((a, b) => (particleCounts[b] - particleCounts[a]) || (PARTICLES.indexOf(a) - PARTICLES.indexOf(b)))
    .slice(0, Math.max(1, Math.round(cfg.particleTopN)));

  let withFace = 0;
  let withEmoji = 0;
  let withKaomoji = 0;
  let noPunct = 0;
  for (const s of samples) {
    if (!PUNCT_END_RE.test(coreOf(s.text))) noPunct += 1;
    FACE_RE.lastIndex = 0;
    if (FACE_RE.test(s.text)) withFace += 1;
    EMOJI_RE.lastIndex = 0;
    if (EMOJI_RE.test(s.text)) withEmoji += 1;
    if (KAOMOJI_RE.test(s.text)) withKaomoji += 1;
  }
  FACE_RE.lastIndex = 0;
  EMOJI_RE.lastIndex = 0;

  // 分条习惯：同一个人、间隔 <= burstGapMs 的连续消息算一组
  let burst = null;
  const timed = samples.filter((s) => s.from && Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  if (timed.length >= 2) {
    const groups = [];
    let current = null;
    for (const s of timed) {
      if (current && current.from === s.from && s.at - current.lastAt <= cfg.burstGapMs) {
        current.count += 1;
        current.lastAt = s.at;
      } else {
        current = { from: s.from, count: 1, lastAt: s.at };
        groups.push(current);
      }
    }
    const singles = groups.filter((g) => g.count === 1).length;
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    burst = {
      groups: groups.length,
      avg: groups.length ? round1(total / groups.length) : 0,
      singleRatio: ratio(singles, groups.length),
      max: groups.reduce((m, g) => Math.max(m, g.count), 0)
    };
  }

  // 例子：最近的、6~40 字、去重、不含链接/引用 —— 学节奏用的，不是给模型照抄的
  const examples = [];
  const seen = new Set();
  for (let i = samples.length - 1; i >= 0 && examples.length < Math.max(0, Math.round(cfg.exampleCount)); i -= 1) {
    const t = samples[i].text;
    if (EXAMPLE_SKIP_RE.test(t)) continue;
    const len = charLen(t);
    if (len < 6 || len > 40) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    examples.push(t);
  }

  return {
    n,
    medianLen: round1(median(lens)),
    avgLen: round1(lens.reduce((a, b) => a + b, 0) / n),
    shortRatio: ratio(lens.filter((x) => x <= 5).length, n),
    noPunctRatio: ratio(noPunct, n),
    qqFaceRatio: ratio(withFace, n),
    emojiRatio: ratio(withEmoji, n),
    kaomojiRatio: ratio(withKaomoji, n),
    particleCounts,
    particles,
    burst,
    examples
  };
}

/**
 * 把统计压成一小块提示词。样本不够（< minSamples）返回空串——宁可不注入，也不要一句
 * 「中位句长 3 字」的假基准。
 * @param {object} stats analyzeStyle 的返回
 * @param {object} [options] { minSamples, examples, maxBlockChars, exampleCount }
 * @returns {string} 带 marker 的块，或 ''
 */
export function buildStyleBlock(stats, options = {}) {
  const cfg = { ...DEFAULT_STYLE_GUARD_CONFIG, ...(isPlainObject(options) ? options : {}) };
  if (!stats || !Number.isFinite(stats.n) || stats.n < Math.max(1, Math.round(cfg.minSamples))) return '';
  const examples = Array.isArray(options.examples) ? options.examples : (stats.examples || []);
  const medianLen = Math.max(1, Math.round(stats.medianLen || 0));
  const noPunct = describeRatio(stats.noPunctRatio || 0);
  const short = describeRatio(stats.shortRatio || 0);
  const has = (arr) => Array.isArray(arr) && arr.length > 0;

  const lines = ['【这群人怎么说话】'];
  lines.push(
    '像这群人一样说话：中位句长 ' + medianLen + ' 字、'
    + noPunct.cheng + '不带句号（' + noPunct.pct + '%）、'
    + short.cheng + '不到 5 字；常用语气词 '
    + (has(stats.particles) ? stats.particles.join('/') : '吧/哦/呢') + '。'
  );
  const emojiRatio = Math.min(1, (stats.emojiRatio || 0) + (stats.qqFaceRatio || 0));
  if (emojiRatio >= 0.08) {
    lines.push(describeRatio(emojiRatio).pct + '% 的消息带表情，想带就带，不用每句都带。');
  }
  if (stats.burst && stats.burst.groups >= 3 && stats.burst.avg >= 1.4) {
    lines.push('真人常一口气发 ' + stats.burst.avg + ' 条短消息（'
      + describeRatio(stats.burst.singleRatio).pct + '% 只发一条），该分条就分条。');
  }
  if (has(examples) && cfg.exampleCount > 0) {
    lines.push('几句真人原话（学节奏，不要照抄）：');
    for (const ex of examples.slice(0, Math.max(0, Math.round(cfg.exampleCount)))) lines.push('- ' + clip(ex, 40));
  }

  // 预算兜底：先丢例子，再截断（marker 必须成对，缺一个就会污染后续注入）
  let body = lines.join('\n');
  const budget = Math.max(120, Math.round(cfg.maxBlockChars));
  while (charLen(body) > budget && lines.length > 2) {
    lines.pop();
    body = lines.join('\n');
  }
  if (charLen(body) > budget) body = clip(body, budget);
  return STYLE_BEGIN + '\n' + body + '\n' + STYLE_END;
}

/** 剥掉提示词里旧的语感块（重复注入前先调它）。 */
export function stripStyleBlock(text) {
  return String(text ?? '').replace(STYLE_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ── 出站清洗 ────────────────────────────────────────────────────────────────
/** 结尾客套：命中就整段砍掉（不是替换成另一句客服话）。 */
const TAIL_RULES = [
  /(?:还有)?(?:什么|啥)(?:可以|能|需要)(?:帮|为)(?:你|您)[^。！？!?\n]{0,12}[？?]?$/,
  /(?:希望|但愿)(?:能)?(?:对你|对您)?有(?:所)?帮助[。！!~～]?$/,
  /(?:如果|要是)?(?:有|遇到)(?:任何|什么)?(?:问题|需要)[^。！？!?\n]{0,16}(?:随时|可以|欢迎|尽管)(?:告诉|找|联系|问我|吩咐)[^。！？!?\n]{0,8}[。！!~～]?$/,
  /(?:随时|有事(?:就)?)(?:告诉|叫|找)我[^。！？!?\n]{0,8}[。！!~～]?$/,
  /(?:祝|祝您|祝你)(?:生活愉快|使用愉快|愉快|顺利|开心)[^。！？!?\n]{0,8}[。！!~～]?$/,
  /(?:感谢|谢谢)(?:您的|你的)?(?:咨询|使用|提问|信任|理解)[。！!~～]?$/,
  /(?:如有|若有)(?:任何)?(?:疑问|问题)[^。！？!?\n]{0,15}[？?]?$/,
  /(?:欢迎)?(?:随时)?(?:联系|咨询)(?:我们|客服)[。！!~～]?$/
];

/** 整句客服腔：命中这句就整句删掉。 */
const BANNED_SENTENCE = [
  /有什么(?:可以|能|需要)(?:帮|为)/,
  /需要我(?:做|帮|处理)/,
  /要不要我帮/,
  /我可以帮你/,
  /随时(?:告诉|叫|找)我/,
  /有事(?:就)?叫我/,
  /尽管(?:告诉|吩咐|说)/,
  /希望(?:对你|能)有(?:所)?帮助/,
  /很(?:高兴|荣幸)(?:能)?(?:为|帮)(?:你|您)/,
  /请问(?:有什么|您还有)/,
  /(?:如果|要是)你(?:还)?(?:有|需要)(?:任何)?(?:问题|帮助)/,
  /(?:我)?(?:正在|随时)(?:为您|为你)(?:服务|待命)/,
  /以上(?:就)?是(?:我)?(?:对|关于)[^。！？!?\n]{0,20}(?:的)?(?:说明|解答|回答)/,
  /^(?:好的|好嘞|没问题)[，,](?:以下|下面)是/
];

const GREETING_RE = /^(?:您好|你好|哈喽|亲)[，,、！!：:\s]+/;

/** 只削「不配对的」结尾右括号：`嗯（笑））` → `嗯（笑）`，而完整的 `嗯（笑）` 不动。 */
function stripUnbalancedTail(text) {
  let t = String(text ?? '');
  for (let i = 0; i < 5; i += 1) {
    const m = t.match(/[）)]\s*$/);
    if (!m) break;
    const close = m[0][0];
    const open = close === '）' ? '（' : '(';
    const count = (ch) => (t.match(new RegExp(ch === '（' || ch === '）' ? ch : '\\' + ch, 'g')) || []).length;
    if (count(close) > count(open)) { t = t.slice(0, t.length - m[0].length); continue; }
    break;
  }
  return t;
}
const SENTENCE_SPLIT_RE = /(?<=[。！？!?~…\n])/;
/** 有没有「实词」：删完客服腔只剩标点的结果不是话，不该发出去。 */
const HAS_WORD_RE = /[\p{L}\p{N}]/u;
const SENTENCE_RE = /[^。！？!?…\n]+[。！？!?…]*\n?/g;

/**
 * 长段落拆分：单行超过 maxParagraphChars 且有句末标点时，按句末切成多行。
 * 只加换行、不动字，所以「只清洗不改意思」在这条上成立。
 */
function splitLongParagraphs(text, cfg) {
  const out = [];
  let changed = null;
  for (const para of String(text).split('\n')) {
    if (charLen(para) <= cfg.maxParagraphChars) { out.push(para); continue; }
    const sentences = para.match(SENTENCE_RE) || [para];
    if (sentences.length < 2) { out.push(para); continue; }
    const lines = [];
    let buf = '';
    for (const sentence of sentences) {
      const next = buf + sentence;
      if (buf && charLen(next) > cfg.lineChars) { lines.push(buf.trim()); buf = sentence; }
      else buf = next;
      if (charLen(buf) >= cfg.lineChars) { lines.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) lines.push(buf.trim());
    if (lines.length < 2) { out.push(para); continue; }
    if (!changed) changed = { before: clip(para, 120), after: clip(lines.join(' / '), 120) };
    out.push(lines.join('\n'));
  }
  return { text: out.join('\n'), changed };
}

/**
 * 出站清洗。只改「怎么说」，不改意思；blocked 恒为 false（自曝归 identity-guard）。
 * @param {string} text
 * @param {object} [options] { config, enabled }
 * @returns {{text:string, changes:Array<{type:string,before:string,after:string}>, blocked:false, skipped?:string}}
 */
export function checkOutgoing(text, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const cfg = normalizeStyleConfig({ ...(isPlainObject(opts.config) ? opts.config : {}), ...opts });
  const src = String(text ?? '');
  const done = (value, changes, extra) => ({ text: value, changes, blocked: false, ...(extra || {}) });

  if (!src.trim()) return done(src, []);
  if (opts.enabled === false || cfg.enabled === false || cfg.cleanOutgoing === false) {
    return done(src, [], { skipped: 'disabled' });
  }
  // 代码块原样保留：里面是给人复制的命令/代码，动了就是事故
  if (src.includes(CODE_FENCE)) return done(src, [], { skipped: 'codeblock' });

  let cur = src;
  const changes = [];
  const record = (type, before, after) => {
    if (before === after || changes.length >= 20) return;
    changes.push({ type, before: clip(before, 120), after: clip(after, 120) });
  };

  // 1) 开头的客服问候：「您好，」后面还有内容时才砍（单说「您好」不动）
  if (GREETING_RE.test(cur) && charLen(cur) > 3) {
    const next = cur.replace(GREETING_RE, '');
    record('greeting', cur, next);
    cur = next;
  }

  // 2) 结尾客套：整段砍掉
  for (const re of TAIL_RULES) {
    const m = cur.match(re);
    if (!m || m.index == null) continue;
    const next = cur.slice(0, m.index).trim().replace(/[，,、\s]+$/, '').trim();
    record('tail', cur, next);
    cur = next;
    break;
  }

  // 3) 整句客服腔：删句，不替换（替换出来的还是客服话）
  const parts = cur.split(SENTENCE_SPLIT_RE);
  if (parts.length > 1) {
    const kept = parts.filter((part) => !BANNED_SENTENCE.some((re) => re.test(part)));
    if (kept.length !== parts.length) {
      // 删掉整句后会留下孤立的标点（「！」「。」「…」），那不是话，一并丢掉
      const next = kept.filter((part) => HAS_WORD_RE.test(part) || !part.trim()).join('');
      record('banned', cur, next);
      cur = next;
    }
  } else if (BANNED_SENTENCE.some((re) => re.test(cur))) {
    record('banned', cur, '');
    cur = '';
  }

  // 4) 长段落拆分（只加换行）
  const split = splitLongParagraphs(cur, cfg);
  if (split.changed) {
    record('split', split.changed.before, split.changed.after);
    cur = split.text;
  }

  // 5) 连续重复标点：？？？？ → ？ ；！！！ → ！；。。。 → 。
  const punctFixed = cur.replace(/([。！？!?…~～])[。！？!?…~～]+/g, '$1').replace(/\.{3,}/g, '…');
  if (punctFixed !== cur) {
    record('punct', cur, punctFixed);
    cur = punctFixed;
  }

  // 6) 空括号 / 句尾孤零零的右括号（模型爱留「（笑）」的残骸）
  //    注意：配对完好的「（笑）」一个字都不许动，只清不配对的尾巴
  const bracketFixed = stripUnbalancedTail(cur
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/^\s*[（(](?![^（(]*[）)])/g, ''));
  if (bracketFixed !== cur) {
    record('bracket', cur, bracketFixed);
    cur = bracketFixed;
  }

  // 7) 短句去掉句尾句号（微信式；长句/代码不动）
  if (cfg.shortLineMax > 0) {
    const perLine = cur.split('\n').map((line) => {
      const trimmed = line.trimEnd();
      return charLen(trimmed) <= cfg.shortLineMax && /。$/.test(trimmed) ? trimmed.slice(0, -1) : line;
    });
    const next = perLine.join('\n');
    if (next !== cur) {
      record('period', cur, next);
      cur = next;
    }
  }

  // 8) 空白整理
  const tidy = cur
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (tidy !== cur) {
    record('space', cur, tidy);
    cur = tidy;
  }

  // 9) 一句话都不剩（或只剩标点）：与其发一串标点，不如说一个字
  if (!cur || (!HAS_WORD_RE.test(cur) && HAS_WORD_RE.test(src))) {
    changes.push({ type: 'fallback', before: '', after: cfg.fallbackText });
    cur = cfg.fallbackText;
  }

  return done(cur, changes);
}

// ── 配置归一化 ──────────────────────────────────────────────────────────────
/** 配置归一化：每个字段单独兜底；也认参考包的 snake_case 键名。 */
export function normalizeStyleConfig(input = {}) {
  const raw = isPlainObject(input) ? input : {};
  const pick = (...keys) => {
    for (const key of keys) if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    return undefined;
  };
  const d = DEFAULT_STYLE_GUARD_CONFIG;
  const stateFile = pick('stateFile', 'state_file', 'file');
  return {
    enabled: boolOf(raw.enabled, d.enabled),
    collect: boolOf(pick('collect', 'collect_messages'), d.collect),
    sampleSize: Math.round(clampNum(pick('sampleSize', 'sample_size', 'style_sample_size'), 20, 2000, d.sampleSize)),
    minSamples: Math.round(clampNum(pick('minSamples', 'min_samples'), 5, 300, d.minSamples)),
    injectStyle: boolOf(pick('injectStyle', 'inject_style'), d.injectStyle),
    styleInGroup: boolOf(pick('styleInGroup', 'style_in_group'), d.styleInGroup),
    cleanOutgoing: boolOf(pick('cleanOutgoing', 'clean_outgoing'), d.cleanOutgoing),
    particleTopN: Math.round(clampNum(pick('particleTopN', 'particle_top_n'), 1, 8, d.particleTopN)),
    exampleCount: Math.round(clampNum(pick('exampleCount', 'example_count'), 0, 8, d.exampleCount)),
    maxBlockChars: Math.round(clampNum(pick('maxBlockChars', 'max_block_chars'), 120, 2000, d.maxBlockChars)),
    maxParagraphChars: Math.round(clampNum(pick('maxParagraphChars', 'max_paragraph_chars'), 40, 1000, d.maxParagraphChars)),
    lineChars: Math.round(clampNum(pick('lineChars', 'line_chars'), 16, 200, d.lineChars)),
    shortLineMax: Math.round(clampNum(pick('shortLineMax', 'short_line_max'), 0, 120, d.shortLineMax)),
    burstGapMs: Math.round(clampNum(pick('burstGapMs', 'burst_gap_ms'), 5000, 600000, d.burstGapMs)),
    fallbackText: (() => {
      const value = pick('fallbackText', 'fallback_text');
      return typeof value === 'string' && value.trim() ? clip(value.trim(), 20) : d.fallbackText;
    })(),
    stateFile: typeof stateFile === 'string' && stateFile.trim() ? stateFile.trim() : ''
  };
}

// ── 状态文件 ────────────────────────────────────────────────────────────────
/** 原子写：tmp + rename，避免进程中断在状态文件里留下半截 JSON（照 src/reminders.js）。 */
function writeFileAtomicSync(filePath, buf) {
  const tmp = filePath + '.part-' + process.pid.toString(36) + '-' + Date.now().toString(36);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败无所谓，下一次写会覆盖 */ }
    throw error;
  }
}

function sanitizeSample(raw) {
  const item = readSampleRow(raw);
  if (!item) return null;
  const text = normalizeSampleText(item.text);
  if (charLen(text) < 2) return null;
  return { text, at: Number.isFinite(item.at) ? item.at : 0, from: item.from };
}

/**
 * 创建语感守卫。
 * @param {{ stateFile?: string, config?: object, now?: () => number, flushEvery?: number }} [options]
 *   stateFile 状态文件路径（测试传临时目录；默认 state/style-guard.json）
 *   config    覆盖 DEFAULT_STYLE_GUARD_CONFIG（含 stateFile 键）
 *   now       取当前时间的函数（测试注入假时钟）
 *   flushEvery 每攒够几条采样落一次盘（默认 10；测试传 1）
 */
export function createStyleGuard(options = {}) {
  const cfg = normalizeStyleConfig({ ...(isPlainObject(options.config) ? options.config : {}), ...options });
  const file = options.stateFile
    ? path.resolve(String(options.stateFile))
    : (cfg.stateFile ? path.resolve(cfg.stateFile) : DEFAULT_STYLE_STATE_FILE);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const flushEvery = Math.max(1, Math.round(clampNum(options.flushEvery, 1, 1000, 10)));

  const state = { version: STYLE_VERSION, samples: [], updatedAt: 0 };
  const warnings = [];
  let loaded = false;
  let dirty = 0;

  const off = () => cfg.enabled === false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (off()) return;      // 总闸关掉：不读盘、不建文件
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') warnings.push('读 ' + path.basename(file) + ' 失败：' + (error.message || error));
      return;
    }
    try {
      const raw = JSON.parse(text);
      const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.samples) ? raw.samples : []);
      state.samples = rows.map(sanitizeSample).filter(Boolean).slice(-cfg.sampleSize);
      state.updatedAt = Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0;
    } catch (error) {
      warnings.push('解析 ' + path.basename(file) + ' 失败，按空样本继续：' + (error.message || error));
    }
  }

  function flush() {
    if (off() || cfg.collect === false) return false;   // 采样关掉就不写盘（不建文件）
    if (!dirty) return false;
    try {
      state.updatedAt = now();
      writeFileAtomicSync(file, JSON.stringify({ version: STYLE_VERSION, samples: state.samples, updatedAt: state.updatedAt }, null, 2));
      dirty = 0;
      return true;
    } catch (error) {
      warnings.push('写 ' + path.basename(file) + ' 失败：' + (error.message || error));
      return false;
    }
  }

  return {
    /** 生效中的配置（已归一化）。 */
    config: cfg,
    /** 状态文件绝对路径（关掉也照样能看，方便排查「为什么没建文件」）。 */
    stateFile: file,
    get enabled() { return cfg.enabled !== false; },
    /** 采样一条群友消息。不收集/关掉/不值得统计都返回 false（调用方据此决定要不要 flush）。 */
    observe(sample = {}) {
      load();
      if (off() || cfg.collect === false) return false;
      const item = readSampleRow(sample);
      if (!item) return false;
      const text = normalizeSampleText(item.text);
      if (charLen(text) < 2 || !isWorthStats(text)) return false;
      state.samples.push({ text, at: Number.isFinite(item.at) ? item.at : now(), from: item.from });
      if (state.samples.length > cfg.sampleSize) state.samples = state.samples.slice(-cfg.sampleSize);
      dirty += 1;
      if (dirty >= flushEvery) flush();
      return true;
    },
    /** 当前样本的统计（永远现算，不缓存）。 */
    stats() {
      load();
      return analyzeStyle(state.samples, cfg);
    },
    /** 注入块：开关/群聊/样本量任何一条不过就返回 ''。 */
    buildStyleBlock(injectOptions = {}) {
      load();
      if (off() || cfg.injectStyle === false) return '';
      if (cfg.styleInGroup && injectOptions.isGroup === false) return '';
      return buildStyleBlock(analyzeStyle(state.samples, cfg), { ...cfg, ...injectOptions });
    },
    /** 出站清洗。 */
    checkOutgoing(text) {
      if (off() || cfg.cleanOutgoing === false) {
        return { text: String(text ?? ''), changes: [], blocked: false, skipped: 'disabled' };
      }
      return checkOutgoing(text, { config: { ...cfg, enabled: true }, enabled: true });
    },
    /** 剥掉提示词里旧的语感块。 */
    stripStyleBlock,
    flush,
    /** 只清内存与磁盘上的样本；文件仍然存在（要删文件请自己删）。 */
    clear() {
      load();
      if (off()) return false;
      state.samples = [];
      dirty = 1;
      return flush();
    },
    /** 只读快照：给控制台/端点用。 */
    snapshot() {
      load();
      const stats = analyzeStyle(state.samples, cfg);
      return {
        enabled: cfg.enabled !== false,
        collect: cfg.collect !== false,
        injectStyle: cfg.injectStyle !== false,
        styleInGroup: cfg.styleInGroup !== false,
        cleanOutgoing: cfg.cleanOutgoing !== false,
        sampleSize: cfg.sampleSize,
        samples: state.samples.length,
        updatedAt: state.updatedAt,
        stats
      };
    },
    warnings
  };
}
