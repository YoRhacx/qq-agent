// 自我语感自画像（self style）
//
// 为什么要有这个模块：style-guard 学的是「这群人怎么说话」，管的是**别人**；
// 但模型自己的语感会漂 —— 连着几天赶工，句子越来越长、表情越来越多、傲娇只剩个「哼」。
// 人格卡是死的，语感是活的。这里每 N 条**自己的**发言算一次自己的语气参数，
// 压成一句话给自己看（「我最近说话偏短、爱用『啦』收尾」），漂得厉害时记一条 drift。
//
// 和 style-guard 的分工：
//   style-guard  = 群友样本 → 注入「像这群人一样说话」+ 出站清洗；
//   self-style   = 自己的样本 → 注入「我最近的说话手感」+ 漂移提醒。
//   两者都只读样本、只写自己的状态文件，互不 import。
//
// 落盘形状（state/self-style.json）：
//   { "version": 1,
//     "samples": [ { "text": "才不是呢", "at": 1719849600000 } ],
//     "profile": { "n": 60, "medianLen": 9, ... } | null,
//     "profileAt": 0, "windows": 3,
//     "drift": [ { "at": 0, "metric": "medianLen", "from": 6.5, "to": 11.2, "ratio": 0.72 } ],
//     "updatedAt": 0 }
//   - samples 留最近 sampleSize 条；profile 是上一次窗口算出的参数（drift 的对照基准）；
//   - drift 只留最近 maxEntries 条，避免文件无限长。
//
// 开关独立可关（关掉不建文件、不生效）：enabled / collect / inject / drift.enabled。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF_STYLE_VERSION = 1;
export const SELF_STYLE_BEGIN = '<!-- SELF-STYLE:BEGIN -->';
export const SELF_STYLE_END = '<!-- SELF-STYLE:END -->';
export const SELF_STYLE_BLOCK_RE = /<!-- SELF-STYLE:BEGIN -->[\s\S]*?<!-- SELF-STYLE:END -->/g;

export const DEFAULT_SELF_STYLE_STATE_FILE = fileURLToPath(new URL('../state/self-style.json', import.meta.url));

export const DEFAULT_SELF_STYLE_CONFIG = Object.freeze({
  enabled: true,
  collect: true,
  sampleSize: 200,         // 自画像的滑动窗口
  minSamples: 30,          // 少于这个数不注入、不判 drift
  windowEvery: 20,         // 每 N 条自己的发言重算一次参数（0 = 不自动重算）
  inject: true,
  tailTopN: 5,
  maxInjectChars: 160,
  drift: Object.freeze({
    enabled: true,
    threshold: 0.3,        // 相对变化超过 30% 记一条
    minSamples: 30,
    maxEntries: 50,
    minAbsolute: 0.05      // 比例类指标的绝对下限，防 0.02→0.04 这种「翻倍」噪声
  }),
  stateFile: ''
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
const ratio = (hit, total) => (total > 0 ? round3(hit / total) : 0);

function clip(text, max = 120) {
  const arr = Array.from(String(text ?? ''));
  return arr.length > max ? arr.slice(0, Math.max(0, max - 1)).join('') + '…' : arr.join('');
}

// ── 词表 ────────────────────────────────────────────────────────────────────
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const KAOMOJI_RE = /(?:[（(][^（）()\n]{1,12}[）)])|(?:[qQ][wW][qQ])|(?:[tT]_[tT])|(?:\^_?\^)|(?:>_<)/;
const FACE_RE = /\[[^\[\]\n]{1,10}\]/g;
/** 去掉标点/表情，用来取「句尾尾巴」。 */
const TAIL_STRIP_RE = /[\s。！？!?…~～、，,。,.．·'"“”‘’（）()\[\]【】《》<>]/g;
/** 傲娇句式：命中任意一条就算（只用来算占比，不评判好不好）。 */
const TSUNDERE_RES = [
  /哼/,
  /才(?:不|没|不是|不会)/,
  /谁(?:要|稀罕|知道|管)/,
  /讨厌(?:啦|死了)?/,
  /笨蛋|傻瓜|呆子/,
  /不是啦/,
  /别(?:误会|多想|自作多情)/,
  /(?:我)?才不(?:会|要|是)/,
  /……/,
  /(?:你|您)(?:少|来|别)(?:管|说)/
];
/** 科技/代码类消息不进语感统计：那不是「说话」。三个反引号用转义写，免得本文件自己出现围栏。 */
const TECH_RE = /\u0060{3}|(?:^|\n)\s*(?:function|const|let|var|import|export|class|def|SELECT|curl|npm|git)\s|[{};]\s*$/m;

function normalizeSelfSample(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:\[[^\[\]]{0,40}\]\s*)+/, '').trim();
  return t;
}

/** 一条自己的发言值不值得统计（太短、纯占位、纯代码都不算）。 */
export function isSelfSample(text) {
  const t = normalizeSelfSample(text);
  if (charLen(t) < 2 || charLen(t) > 400) return false;
  if (/^(?:\[[^\[\]\n]{1,10}\]\s*)+$/.test(t)) return false;
  if (TECH_RE.test(t)) return false;
  return t.replace(FACE_RE, '').replace(EMOJI_RE, '').replace(/[\s\p{P}]/gu, '').length >= 1;
}

/**
 * 傲娇句式判定。
 * @param {string} text
 * @returns {boolean}
 */
export function isTsundere(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return TSUNDERE_RES.some((re) => re.test(t));
}

/** 句尾尾巴：去掉标点/表情后取最后一个字（「好耶」→「耶」，「哈哈哈哈」→「哈」）。 */
export function tailOf(text) {
  let t = String(text ?? '').replace(FACE_RE, '').replace(EMOJI_RE, '').replace(KAOMOJI_RE, '');
  t = t.replace(TAIL_STRIP_RE, '');
  if (!t) return '';
  const chars = Array.from(t);
  return chars[chars.length - 1] || '';
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 算自己的语气参数。纯函数：不读盘、不看时间。
 * @param {Array<string|{text?:string,at?:number}>} rows
 * @param {object} [options] 覆盖 DEFAULT_SELF_STYLE_CONFIG
 * @returns {object} { n, medianLen, avgLen, minLen, maxLen, shortRatio(<=5), noPunctRatio,
 *                     emojiDensity, kaomojiDensity, tsundereRatio, questionRatio, exclaimRatio,
 *                     tails:[{word,count}], topTail }
 */
export function analyzeSelfStyle(rows, options = {}) {
  const cfg = { ...DEFAULT_SELF_STYLE_CONFIG, ...(isPlainObject(options) ? options : {}) };
  const samples = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = typeof row === 'string' ? row : (isPlainObject(row) ? row.text : '');
    const text = normalizeSelfSample(raw);
    if (!isSelfSample(text)) continue;
    samples.push(text);
  }
  const n = samples.length;
  if (!n) {
    return {
      n: 0, medianLen: 0, avgLen: 0, minLen: 0, maxLen: 0, shortRatio: 0, noPunctRatio: 0,
      emojiDensity: 0, kaomojiDensity: 0, tsundereRatio: 0, questionRatio: 0, exclaimRatio: 0,
      tails: [], topTail: ''
    };
  }

  const lens = samples.map((s) => charLen(s));
  const tailCounts = {};
  let withEmoji = 0;
  let withKaomoji = 0;
  let tsundere = 0;
  let noPunct = 0;
  let questions = 0;
  let exclaims = 0;

  for (const s of samples) {
    const tail = tailOf(s);
    if (tail) tailCounts[tail] = (tailCounts[tail] || 0) + 1;
    EMOJI_RE.lastIndex = 0;
    if (EMOJI_RE.test(s)) withEmoji += 1;
    if (KAOMOJI_RE.test(s)) withKaomoji += 1;
    if (isTsundere(s)) tsundere += 1;
    if (!/[。！？!?…~～]$/.test(s.trimEnd())) noPunct += 1;
    if (/[？?]/.test(s)) questions += 1;
    if (/[！!]/.test(s)) exclaims += 1;
  }
  EMOJI_RE.lastIndex = 0;

  const tails = Object.keys(tailCounts)
    .sort((a, b) => (tailCounts[b] - tailCounts[a]) || a.localeCompare(b))
    .slice(0, Math.max(1, Math.round(clampNum(cfg.tailTopN, 1, 10, 5))))
    .map((word) => ({ word, count: tailCounts[word] }));

  return {
    n,
    medianLen: round1(median(lens)),
    avgLen: round1(lens.reduce((a, b) => a + b, 0) / n),
    minLen: Math.min(...lens),
    maxLen: Math.max(...lens),
    shortRatio: ratio(lens.filter((x) => x <= 5).length, n),
    noPunctRatio: ratio(noPunct, n),
    emojiDensity: ratio(withEmoji, n),
    kaomojiDensity: ratio(withKaomoji, n),
    tsundereRatio: ratio(tsundere, n),
    questionRatio: ratio(questions, n),
    exclaimRatio: ratio(exclaims, n),
    tails,
    topTail: tails.length ? tails[0].word : ''
  };
}

/**
 * drift 判定：新旧两套参数逐项比，相对变化超过 threshold 的记一条。
 * 比例类指标额外要求绝对差 >= minAbsolute，避免 0.02→0.04 这种翻倍噪声。
 * @param {object} prev 上一次的 profile
 * @param {object} next 本次的 profile
 * @param {object} [options] { threshold, minAbsolute, maxEntries }
 * @returns {Array<{metric:string, from:number, to:number, ratio:number}>}
 */
export function detectDrift(prev, next, options = {}) {
  const cfg = { ...DEFAULT_SELF_STYLE_CONFIG.drift, ...(isPlainObject(options) ? options : {}) };
  if (!prev || !next) return [];
  if (!Number.isFinite(prev.n) || !Number.isFinite(next.n)) return [];
  if (prev.n < cfg.minSamples || next.n < cfg.minSamples) return [];
  const metrics = ['medianLen', 'avgLen', 'shortRatio', 'noPunctRatio', 'emojiDensity', 'kaomojiDensity', 'tsundereRatio'];
  const out = [];
  for (const metric of metrics) {
    const from = Number(prev[metric]);
    const to = Number(next[metric]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const base = Math.max(Math.abs(from), 1e-6);
    const delta = Math.abs(to - from);
    const rel = delta / base;
    if (rel <= cfg.threshold) continue;
    const ratioLike = /Ratio$|Density$/i.test(metric);
    if (ratioLike && delta < cfg.minAbsolute) continue;
    out.push({ metric, from: round1(from), to: round1(to), ratio: round3(rel) });
    if (out.length >= Math.max(1, Math.round(cfg.maxEntries))) break;
  }
  return out;
}

/**
 * 把参数压成一句「我最近的说话手感」。样本不够返回 ''。
 * @param {object} profile analyzeSelfStyle 的返回
 * @param {object} [options] { minSamples, maxInjectChars }
 * @returns {string} 带 marker 的一句，或 ''
 */
export function buildSelfStyleBlock(profile, options = {}) {
  const cfg = { ...DEFAULT_SELF_STYLE_CONFIG, ...(isPlainObject(options) ? options : {}) };
  if (!profile || !Number.isFinite(profile.n) || profile.n < Math.max(1, Math.round(cfg.minSamples))) return '';
  const medianLen = Math.max(1, Math.round(profile.medianLen || 0));
  const bits = ['我最近说话偏' + (medianLen <= 10 ? '短' : medianLen >= 20 ? '长' : '中等') + '（中位 ' + medianLen + ' 字）'];
  if (profile.topTail) bits.push('爱用「' + profile.topTail + '」收尾');
  if ((profile.emojiDensity || 0) >= 0.15) bits.push('表情不少');
  else if ((profile.emojiDensity || 0) <= 0.02) bits.push('基本不带表情');
  if ((profile.kaomojiDensity || 0) >= 0.1) bits.push('偶尔颜文字');
  if ((profile.tsundereRatio || 0) >= 0.2) bits.push('傲娇句式占 ' + Math.round(profile.tsundereRatio * 100) + '%');
  if ((profile.noPunctRatio || 0) >= 0.6) bits.push('多数不带句号');
  const body = clip(bits.join('，') + '。', Math.max(40, Math.round(cfg.maxInjectChars)));
  return SELF_STYLE_BEGIN + '\n' + body + '\n' + SELF_STYLE_END;
}

/** 剥掉旧的自我语感块。 */
export function stripSelfStyleBlock(text) {
  return String(text ?? '').replace(SELF_STYLE_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 配置归一化：每个字段单独兜底，也认参考包的 snake_case 键名。 */
export function normalizeSelfStyleConfig(input = {}) {
  const raw = isPlainObject(input) ? input : {};
  const pick = (...keys) => {
    for (const key of keys) if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    return undefined;
  };
  const d = DEFAULT_SELF_STYLE_CONFIG;
  const driftRaw = isPlainObject(raw.drift) ? raw.drift : {};
  const stateFile = pick('stateFile', 'state_file', 'file');
  return {
    enabled: boolOf(raw.enabled, d.enabled),
    collect: boolOf(pick('collect', 'collect_messages'), d.collect),
    sampleSize: Math.round(clampNum(pick('sampleSize', 'sample_size'), 10, 2000, d.sampleSize)),
    minSamples: Math.round(clampNum(pick('minSamples', 'min_samples'), 5, 500, d.minSamples)),
    windowEvery: Math.round(clampNum(pick('windowEvery', 'window_every', 'every_n'), 0, 500, d.windowEvery)),
    inject: boolOf(pick('inject', 'inject_self_style'), d.inject),
    tailTopN: Math.round(clampNum(pick('tailTopN', 'tail_top_n'), 1, 10, d.tailTopN)),
    maxInjectChars: Math.round(clampNum(pick('maxInjectChars', 'max_inject_chars'), 40, 800, d.maxInjectChars)),
    drift: {
      enabled: boolOf(driftRaw.enabled, d.drift.enabled),
      threshold: clampNum(driftRaw.threshold ?? pick('driftThreshold', 'drift_threshold'), 0.05, 5, d.drift.threshold),
      minSamples: Math.round(clampNum(driftRaw.minSamples ?? pick('driftMinSamples'), 5, 1000, d.drift.minSamples)),
      maxEntries: Math.round(clampNum(driftRaw.maxEntries ?? pick('driftMaxEntries'), 1, 500, d.drift.maxEntries)),
      minAbsolute: clampNum(driftRaw.minAbsolute ?? pick('driftMinAbsolute'), 0, 1, d.drift.minAbsolute)
    },
    stateFile: typeof stateFile === 'string' && stateFile.trim() ? stateFile.trim() : ''
  };
}

/** 原子写：tmp + rename（照 src/reminders.js）。 */
function writeFileAtomicSync(filePath, buf) {
  const tmp = filePath + '.part-' + process.pid.toString(36) + '-' + Date.now().toString(36);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败无所谓 */ }
    throw error;
  }
}

/**
 * 创建自我语感画像。
 * @param {{ stateFile?: string, config?: object, now?: () => number, flushEvery?: number }} [options]
 */
export function createSelfStyle(options = {}) {
  const cfg = normalizeSelfStyleConfig({ ...(isPlainObject(options.config) ? options.config : {}), ...options });
  const file = options.stateFile
    ? path.resolve(String(options.stateFile))
    : (cfg.stateFile ? path.resolve(cfg.stateFile) : DEFAULT_SELF_STYLE_STATE_FILE);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const flushEvery = Math.max(1, Math.round(clampNum(options.flushEvery, 1, 1000, 10)));

  const state = { version: SELF_STYLE_VERSION, samples: [], profile: null, profileAt: 0, windows: 0, drift: [], updatedAt: 0 };
  const warnings = [];
  let loaded = false;
  let dirty = 0;
  let sinceWindow = 0;

  const off = () => cfg.enabled === false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (off()) return;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') warnings.push('读 ' + path.basename(file) + ' 失败：' + (error.message || error));
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (!isPlainObject(raw)) throw new Error('顶层不是对象');
      const rows = Array.isArray(raw.samples) ? raw.samples : [];
      state.samples = rows
        .map((row) => {
          const t = normalizeSelfSample(typeof row === 'string' ? row : row?.text);
          return isSelfSample(t) ? { text: t, at: Number.isFinite(row?.at) ? row.at : 0 } : null;
        })
        .filter(Boolean)
        .slice(-cfg.sampleSize);
      state.profile = isPlainObject(raw.profile) ? raw.profile : null;
      state.profileAt = Number.isFinite(raw.profileAt) ? raw.profileAt : 0;
      state.windows = Number.isFinite(raw.windows) ? raw.windows : 0;
      state.drift = Array.isArray(raw.drift) ? raw.drift.filter(isPlainObject).slice(-cfg.drift.maxEntries) : [];
      state.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    } catch (error) {
      warnings.push('解析 ' + path.basename(file) + ' 失败，按空样本继续：' + (error.message || error));
    }
  }

  function flush() {
    if (off() || cfg.collect === false) return false;
    if (!dirty) return false;
    try {
      state.updatedAt = now();
      const payload = {
        version: SELF_STYLE_VERSION,
        samples: state.samples,
        profile: state.profile,
        profileAt: state.profileAt,
        windows: state.windows,
        drift: state.drift,
        updatedAt: state.updatedAt
      };
      writeFileAtomicSync(file, JSON.stringify(payload, null, 2));
      dirty = 0;
      return true;
    } catch (error) {
      warnings.push('写 ' + path.basename(file) + ' 失败：' + (error.message || error));
      return false;
    }
  }

  /** 重算窗口：更新 profile，并与上一份 profile 比 drift。 */
  function rollWindow() {
    const next = analyzeSelfStyle(state.samples, cfg);
    state.windows += 1;
    if (cfg.drift.enabled && state.profile) {
      const hits = detectDrift(state.profile, next, cfg.drift);
      for (const hit of hits) state.drift.push({ at: now(), ...hit });
      if (state.drift.length > cfg.drift.maxEntries) state.drift = state.drift.slice(-cfg.drift.maxEntries);
    }
    state.profile = next;
    state.profileAt = now();
    dirty += 1;
    return next;
  }

  return {
    config: cfg,
    stateFile: file,
    get enabled() { return cfg.enabled !== false; },
    /** 记一条自己的发言。关掉/不收集/不值得统计都返回 false。 */
    observe(text) {
      load();
      if (off() || cfg.collect === false) return false;
      const t = normalizeSelfSample(text);
      if (!isSelfSample(t)) return false;
      state.samples.push({ text: t, at: now() });
      if (state.samples.length > cfg.sampleSize) state.samples = state.samples.slice(-cfg.sampleSize);
      dirty += 1;
      sinceWindow += 1;
      if (cfg.windowEvery > 0 && sinceWindow >= cfg.windowEvery) {
        sinceWindow = 0;
        rollWindow();
      }
      if (dirty >= flushEvery) flush();
      return true;
    },
    /** 当前参数（现算，不看缓存；缓存只用于 drift 对照）。 */
    profile() {
      load();
      return analyzeSelfStyle(state.samples, cfg);
    },
    /** 上一次窗口存下的参数（drift 对照基准）；没滚过窗口就是 null。 */
    lastProfile() {
      load();
      return state.profile ? { ...state.profile } : null;
    },
    /** 强制重算一次窗口（测试/控制台按钮用）。 */
    refresh() {
      load();
      if (off()) return null;
      const next = rollWindow();
      flush();
      return next;
    },
    /** 注入块：开关/样本量不过就返回 ''。 */
    buildSelfStyleBlock() {
      load();
      if (off() || cfg.inject === false) return '';
      return buildSelfStyleBlock(analyzeSelfStyle(state.samples, cfg), cfg);
    },
    stripSelfStyleBlock,
    /** drift 记录（只读副本，新的在后）。 */
    driftLog() {
      load();
      return state.drift.map((d) => ({ ...d }));
    },
    flush,
    clear() {
      load();
      if (off()) return false;
      state.samples = [];
      state.profile = null;
      state.profileAt = 0;
      state.windows = 0;
      state.drift = [];
      sinceWindow = 0;
      dirty = 1;
      return flush();
    },
    snapshot() {
      load();
      return {
        enabled: cfg.enabled !== false,
        collect: cfg.collect !== false,
        inject: cfg.inject !== false,
        windowEvery: cfg.windowEvery,
        samples: state.samples.length,
        windows: state.windows,
        profileAt: state.profileAt,
        profile: analyzeSelfStyle(state.samples, cfg),
        lastProfile: state.profile,
        drift: state.drift.length,
        updatedAt: state.updatedAt
      };
    },
    warnings
  };
}
