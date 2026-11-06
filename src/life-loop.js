// 生活层（life loop）
//
// 为什么要有这个模块：她「有生活」不能只靠人格卡里写的「喜欢看番」——那是设定，不是经历。
// 生活层记的是**具体哪天干了什么**：周三看了一部番、周五读到一段话、今天有点丧。
// 有了这些，主动说话才有素材（「那部番我还没看完」），安静时也才像在过日子而不是在待机。
//
// 参考包的做法（D:\gjdxm\task\_yz\pkg 的 memory_brain/media.py）是两路 jsonl：
//   watched.jsonl：{ts, note, items:[{desc}]} —— 看过的视频，一个 desc 一条；
//   notes.jsonl：  {ts, kind, keep:'long'|'temp', text} —— 随手记，long 进长期、temp 进当天。
// 这里把两路**归一成本地一种形状**，并按「兴趣」聚合，供 pickInterest 用：
//   { id, date: 'YYYY-MM-DD', kind: 'watch'|'read'|'game'|'mood',
//     title, text, interest, weight: 0..1, createdAt }
//
// pickInterest 的用法（任务要求的两路）：
//   心情差（mood 分 <= -0.2）→ 偏向安慰型兴趣：听歌 / 看番 / 散步；
//   心情好（mood 分 >= +0.2）→ 偏向烧脑 / 创作：推理 / 写点东西 / 学点新东西。
//   中间地带不偏，按历史权重抽。
//
// 落盘：state/life.json（一份文件装所有笔记），原子写，只在真改动时写。
// 开关独立可关：enabled / collect（关掉不建文件、不写盘）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIFE_VERSION = 1;
export const LIFE_KINDS = ['watch', 'read', 'game', 'mood'];
export const DEFAULT_LIFE_STATE_FILE = fileURLToPath(new URL('../state/life.json', import.meta.url));

export const DEFAULT_LIFE_CONFIG = Object.freeze({
  enabled: true,
  collect: true,
  maxNotes: 500,            // 最多留这么多条（超出丢最旧的）
  weightDefault: 0.5,       // 笔记没给权重时的默认兴趣权重
  maxTextChars: 400,        // 单条正文上限（参考包也是 400）
  /** 安慰型兴趣：心情差时偏向这些。 */
  comfortInterests: Object.freeze(['听歌', '看番', '散步', '发呆', '吃点甜的']),
  /** 烧脑/创作型兴趣：心情好时偏向这些。 */
  focusInterests: Object.freeze(['推理', '烧脑', '写点东西', '学点新东西', '折腾代码', '创作']),
  moodThreshold: 0.2,       // 心情分绝对值超过这个数才「偏」
  stateFile: ''
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const boolOf = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
const charLen = (s) => Array.from(String(s ?? '')).length;
const round3 = (x) => Math.round(x * 1000) / 1000;

function clip(text, max = 400) {
  const arr = Array.from(String(text ?? ''));
  return arr.length > max ? arr.slice(0, Math.max(0, max - 1)).join('') + '…' : arr.join('');
}

/** 本地日期 'YYYY-MM-DD'（不用 toISOString，那是 UTC，跨时区会错一天）。 */
export function dateOf(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 毫秒时间戳容错：秒 / 毫秒 / ISO 字符串 / Date。返回毫秒或 0。 */
export function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

/** kind 归一：认中文和别名，认不出来归 mood（随手记本来就是心情/碎碎念）。 */
export function normalizeKind(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'mood';
  if (/(?:^|[^a-z])watch|video|anime|番|视频|看/.test(raw)) return 'watch';
  if (/(?:^|[^a-z])read|book|article|读|书|看文/.test(raw)) return 'read';
  if (/(?:^|[^a-z])game|play|游戏|打游戏/.test(raw)) return 'game';
  return 'mood';
}

/** 心情分：数字直接用（clamp -1..1），字符串按词表，对象认 valence/mood/score。 */
export function moodScore(mood) {
  if (mood == null) return 0;
  if (typeof mood === 'number') return Number.isFinite(mood) ? Math.min(1, Math.max(-1, mood)) : 0;
  if (isPlainObject(mood)) {
    const v = mood.valence ?? mood.mood ?? mood.score;
    return moodScore(v);
  }
  const t = String(mood).trim().toLowerCase();
  if (!t) return 0;
  const NEG = ['难过', '伤心', '烦', '累', 'emo', '生气', '委屈', '焦虑', '丧', '难受', 'sad', 'angry', 'tired', 'down'];
  const POS = ['开心', '高兴', '爽', '兴奋', '舒服', '快乐', '感动', '好耶', 'happy', 'great', 'good', 'excited'];
  if (NEG.some((k) => t.includes(k))) return -0.6;
  if (POS.some((k) => t.includes(k))) return 0.6;
  return 0;
}

/** FNV-1a 36 进制：拿来做稳定的笔记 id（同样的内容永远同一个 id，导入不会重复）。 */
export function stableId(seed) {
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'n_' + h.toString(36);
}

/**
 * 归一一条笔记（不落盘）。字段容错：title/name/desc；text/content/note/summary；
 * date/time/ts/createdAt；interest 可以是兴趣名，也可以是 0..1 的权重（此时兴趣留空）。
 * @param {object} input
 * @param {{ now?: number, config?: object }} [options]
 * @returns {object|null} 归一后的笔记，或 null（title/text 都空）
 */
export function normalizeLifeNote(input, options = {}) {
  if (!isPlainObject(input)) return null;
  const cfg = { ...DEFAULT_LIFE_CONFIG, ...(isPlainObject(options.config) ? options.config : {}) };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();

  const createdAt = toMillis(input.createdAt ?? input.ts ?? input.time ?? input.at ?? input.date ?? input.timestamp) || nowMs;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? '').trim())
    ? String(input.date).trim()
    : dateOf(createdAt);

  const title = clip(String(input.title ?? input.name ?? input.desc ?? input.headline ?? '').trim(), 80);
  const body = clip(String(input.text ?? input.content ?? input.note ?? input.summary ?? input.body ?? '').trim(), Math.max(20, Math.round(cfg.maxTextChars)));
  if (!title && !body) return null;

  let interest = '';
  let weight = cfg.weightDefault;
  const rawInterest = input.interest ?? input.topic ?? input.tag;
  if (typeof rawInterest === 'number' && Number.isFinite(rawInterest)) {
    weight = Math.min(1, Math.max(0, rawInterest));
  } else if (typeof rawInterest === 'string' && rawInterest.trim()) {
    interest = clip(rawInterest.trim(), 24);
  }
  if (input.weight !== undefined) {
    weight = clampNum(input.weight, 0, 1, weight);
  } else if (input.interestWeight !== undefined) {
    weight = clampNum(input.interestWeight, 0, 1, weight);
  }

  const kind = normalizeKind(input.kind);
  const id = String(input.id ?? '').trim() || stableId(date + '|' + kind + '|' + title + '|' + body);

  return {
    id,
    date,
    kind,
    title: title || clip(body, 40),
    text: body || title,
    interest,
    weight: round3(weight),
    createdAt
  };
}

/**
 * 解析外部 jsonl（两种格式混着也能吃）。
 * 格式 A（watched.jsonl）：{ ts, note, items: [{ desc }] } —— 每个 desc 出一条 watch 笔记；
 * 格式 B（notes.jsonl）：  { ts, kind, keep, text } —— 一条一条消化。
 * 字段容错：desc 可以是字符串；items 可以是字符串数组；本模块自己导出的 jsonl 也能再导回来。
 * @param {string|Array<object>} input 多行文本，或已经 parse 好的数组
 * @param {{ now?: number, config?: object }} [options]
 * @returns {{ notes: object[], rows: number, skipped: number, formats: { watched: number, notes: number, unknown: number } }}
 */
export function parseLifeJsonl(input, options = {}) {
  const cfg = { ...DEFAULT_LIFE_CONFIG, ...(isPlainObject(options.config) ? options.config : {}) };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  let rows = [];
  if (Array.isArray(input)) {
    rows = input;
  } else {
    rows = String(input ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'))
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  const notes = [];
  const formats = { watched: 0, notes: 0, unknown: 0 };
  let skipped = 0;

  const push = (note) => {
    if (!note) { skipped += 1; return; }
    notes.push(note);
  };

  for (const row of rows) {
    if (!isPlainObject(row)) { skipped += 1; formats.unknown += 1; continue; }
    const items = Array.isArray(row.items) ? row.items : [];
    const hasItems = items.length > 0 && (row.ts !== undefined || row.note !== undefined);
    if (hasItems) {
      formats.watched += 1;
      const noteText = String(row.note ?? row.summary ?? '').trim();
      for (const item of items) {
        const desc = typeof item === 'string' ? item : String(item?.desc ?? item?.title ?? item?.text ?? '').trim();
        if (charLen(desc) < 2) { skipped += 1; continue; }
        push(normalizeLifeNote({
          ts: row.ts ?? row.time ?? row.createdAt,
          kind: 'watch',
          title: desc,
          text: noteText,
          interest: row.interest ?? item?.interest,
          weight: row.weight
        }, { config: cfg, now: nowMs }));
      }
      continue;
    }

    // 普通 notes 行：直接归一；缺 title/text 但有 keep 的也算有内容
    const note = normalizeLifeNote(row, { config: cfg, now: nowMs });
    if (note) {
      formats.notes += 1;
      push(note);
    } else if (row.text !== undefined || row.note !== undefined || row.content !== undefined) {
      formats.unknown += 1;
      skipped += 1;
    } else {
      formats.unknown += 1;
      skipped += 1;
    }
  }

  return { notes, rows: rows.length, skipped, formats };
}

/** 按天分组：{ 'YYYY-MM-DD': [note...] }。 */
export function groupByDate(notes) {
  const out = {};
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || !note.date) continue;
    (out[note.date] ||= []).push(note);
  }
  return out;
}

/** 汇总兴趣权重：comfy 集合按历史权重累加（同一条笔记只算一次）。 */
function interestScores(notes) {
  const scores = new Map();
  for (const note of notes) {
    if (!note || !note.interest) continue;
    const prev = scores.get(note.interest) || 0;
    scores.set(note.interest, prev + Math.max(0.01, note.weight || 0.5));
  }
  return scores;
}

function pickWeighted(entries, rng) {
  const total = entries.reduce((sum, e) => sum + e.score, 0);
  if (total <= 0) return entries[Math.floor(rng() * entries.length) % entries.length];
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.score;
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1];
}

/**
 * 挑一个兴趣（纯函数，rng 可注入，测试传 () => 0 拿第一个）。
 * 心情差 → 安慰型；心情好 → 烧脑/创作；中间按历史权重抽。
 * @param {object[]} notes
 * @param {{ mood?: number|string|object, config?: object, rng?: () => number }} [options]
 * @returns {{ interest: string, kind: 'comfort'|'focus'|'neutral', mood: number, reason: string, source?: { noteId: string, title: string } }}
 */
export function pickInterest(notes, options = {}) {
  const cfg = { ...DEFAULT_LIFE_CONFIG, ...(isPlainObject(options.config) ? options.config : {}) };
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const mood = moodScore(options.mood);
  const list = (Array.isArray(notes) ? notes : []).filter(isPlainObject);
  const scores = interestScores(list);

  const comfortSet = new Set(cfg.comfortInterests.map((x) => String(x)));
  const focusSet = new Set(cfg.focusInterests.map((x) => String(x)));
  const classify = (name) => (comfortSet.has(name) ? 'comfort' : focusSet.has(name) ? 'focus' : 'neutral');

  let want = 'neutral';
  if (mood <= -Math.abs(cfg.moodThreshold)) want = 'comfort';
  else if (mood >= Math.abs(cfg.moodThreshold)) want = 'focus';

  const fromNotes = [];
  for (const [interest, score] of scores.entries()) {
    const kind = classify(interest);
    if (want !== 'neutral' && kind !== want) continue;
    const source = [...list].reverse().find((n) => n.interest === interest);
    fromNotes.push({
      interest,
      score: score + (want === 'neutral' ? 0 : 0.5),
      kind,
      source: source ? { noteId: source.id, title: source.title } : undefined
    });
  }

  let pool = fromNotes;
  let reason = want === 'neutral' ? '按历史兴趣权重' : (want === 'comfort' ? '心情一般，偏安慰型' : '心情不错，偏烧脑/创作');
  if (!pool.length) {
    const fallback = want === 'comfort' ? cfg.comfortInterests : want === 'focus' ? cfg.focusInterests : [...cfg.comfortInterests, ...cfg.focusInterests];
    pool = fallback.map((interest) => ({ interest: String(interest), score: 0.3, kind: classify(String(interest)) }));
    reason = (want === 'comfort' ? '心情一般，' : want === 'focus' ? '心情不错，' : '') + '暂时没记过，按默认清单';
  }
  if (!pool.length) {
    return { interest: want === 'focus' ? '发会儿呆' : '听歌', kind: want === 'focus' ? 'focus' : 'comfort', mood, reason: '兜底' };
  }

  const picked = pickWeighted(pool, rng);
  return {
    interest: picked.interest,
    kind: picked.kind,
    mood: round3(mood),
    reason,
    ...(picked.source ? { source: picked.source } : {})
  };
}

/**
 * 一天的汇总（纯函数）：条数、种类分布、标题、兴趣、一句人话。
 * @param {object[]} notes
 * @param {string} [date] 'YYYY-MM-DD'
 */
export function summarizeNotes(notes, date) {
  const day = date || dateOf(Date.now());
  const list = (Array.isArray(notes) ? notes : []).filter((n) => isPlainObject(n) && n.date === day);
  const byKind = { watch: 0, read: 0, game: 0, mood: 0 };
  const interests = [];
  for (const note of list) {
    if (byKind[note.kind] !== undefined) byKind[note.kind] += 1;
    if (note.interest && !interests.includes(note.interest)) interests.push(note.interest);
  }
  const titles = list.map((n) => n.title).filter(Boolean).slice(0, 8);
  const VERB = { watch: '看了', read: '读了', game: '玩了', mood: '记了' };
  const parts = LIFE_KINDS.filter((k) => byKind[k] > 0).map((k) => {
    const items = list.filter((n) => n.kind === k).map((n) => '《' + n.title + '》').slice(0, 3);
    return VERB[k] + items.join('、');
  });
  const text = list.length
    ? day + ' 记了 ' + list.length + ' 件事：' + parts.join('；') + '。'
    : day + ' 还没有记录。';
  return { date: day, n: list.length, byKind, interests, titles, text, notes: list };
}

/** 原子写（tmp + rename）。 */
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

/** 配置归一化：每个字段单独兜底。 */
export function normalizeLifeConfig(input = {}) {
  const raw = isPlainObject(input) ? input : {};
  const pick = (...keys) => {
    for (const key of keys) if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    return undefined;
  };
  const d = DEFAULT_LIFE_CONFIG;
  const arr = (value, dflt) => (Array.isArray(value) && value.length ? value.map((x) => String(x)).filter(Boolean) : [...dflt]);
  const stateFile = pick('stateFile', 'state_file', 'file');
  return {
    enabled: boolOf(raw.enabled, d.enabled),
    collect: boolOf(pick('collect', 'record'), d.collect),
    maxNotes: Math.round(clampNum(pick('maxNotes', 'max_notes'), 10, 5000, d.maxNotes)),
    weightDefault: clampNum(pick('weightDefault', 'weight_default'), 0, 1, d.weightDefault),
    maxTextChars: Math.round(clampNum(pick('maxTextChars', 'max_text_chars'), 50, 2000, d.maxTextChars)),
    comfortInterests: arr(pick('comfortInterests', 'comfort_interests'), d.comfortInterests),
    focusInterests: arr(pick('focusInterests', 'focus_interests'), d.focusInterests),
    moodThreshold: clampNum(pick('moodThreshold', 'mood_threshold'), 0.05, 1, d.moodThreshold),
    stateFile: typeof stateFile === 'string' && stateFile.trim() ? stateFile.trim() : ''
  };
}

/**
 * 创建生活层。
 * @param {{ stateFile?: string, config?: object, now?: () => number, rng?: () => number, flushEvery?: number }} [options]
 */
export function createLifeLoop(options = {}) {
  const cfg = normalizeLifeConfig({ ...(isPlainObject(options.config) ? options.config : {}), ...options });
  const file = options.stateFile
    ? path.resolve(String(options.stateFile))
    : (cfg.stateFile ? path.resolve(cfg.stateFile) : DEFAULT_LIFE_STATE_FILE);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const flushEvery = Math.max(1, Math.round(clampNum(options.flushEvery, 1, 1000, 5)));

  const state = { version: LIFE_VERSION, notes: [], updatedAt: 0 };
  const warnings = [];
  let loaded = false;
  let dirty = 0;

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
      const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.notes) ? raw.notes : []);
      state.notes = rows.map((row) => normalizeLifeNote(row, { config: cfg, now: now() })).filter(Boolean).slice(-cfg.maxNotes);
      state.updatedAt = Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0;
    } catch (error) {
      warnings.push('解析 ' + path.basename(file) + ' 失败，按空笔记继续：' + (error.message || error));
    }
  }

  function flush() {
    if (off() || cfg.collect === false) return false;
    if (!dirty) return false;
    try {
      state.updatedAt = now();
      writeFileAtomicSync(file, JSON.stringify({ version: LIFE_VERSION, notes: state.notes, updatedAt: state.updatedAt }, null, 2));
      dirty = 0;
      return true;
    } catch (error) {
      warnings.push('写 ' + path.basename(file) + ' 失败：' + (error.message || error));
      return false;
    }
  }

  function sorted() {
    return [...state.notes].sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  }

  return {
    config: cfg,
    stateFile: file,
    get enabled() { return cfg.enabled !== false; },
    /**
     * 记一条。title/text 至少给一个；interest 是兴趣名，weight 是 0..1 的兴趣权重。
     * @param {{kind?:string,title?:string,text?:string,interest?:string|number,weight?:number,date?:string,ts?:number,id?:string}} input
     * @returns {object|null} 落下的笔记，或 null（没内容/关掉了）
     */
    addNote(input = {}) {
      load();
      if (off() || cfg.collect === false) return null;
      const note = normalizeLifeNote({ ...input, createdAt: input.createdAt ?? input.ts ?? now() }, { config: cfg, now: now() });
      if (!note) return null;
      let id = note.id;
      let suffix = 2;
      while (state.notes.some((n) => n.id === id)) {
        id = note.id + '-' + suffix;
        suffix += 1;
      }
      const stored = { ...note, id };
      state.notes.push(stored);
      if (state.notes.length > cfg.maxNotes) state.notes = state.notes.slice(-cfg.maxNotes);
      dirty += 1;
      if (dirty >= flushEvery) flush();
      return { ...stored };
    },
    /** 删一条（按 id）。返回是否真删了。 */
    removeNote(id) {
      load();
      if (off() || cfg.collect === false) return false;
      const before = state.notes.length;
      state.notes = state.notes.filter((n) => n.id !== String(id ?? ''));
      if (state.notes.length === before) return false;
      dirty += 1;
      flush();
      return true;
    },
    /** 某天的笔记（默认今天，新的在前）。 */
    todayNotes(date) {
      load();
      if (off()) return [];
      const day = date || dateOf(now());
      return sorted().filter((n) => n.date === day).reverse();
    },
    /** 按条件取：{ date, kind, interest, limit }。 */
    list(filter = {}) {
      load();
      if (off()) return [];
      const f = isPlainObject(filter) ? filter : {};
      let rows = sorted();
      if (f.date) rows = rows.filter((n) => n.date === f.date);
      if (f.kind) rows = rows.filter((n) => n.kind === normalizeKind(f.kind));
      if (f.interest) rows = rows.filter((n) => n.interest === String(f.interest));
      const limit = Math.round(clampNum(f.limit, 0, 5000, 0));
      if (limit > 0) rows = rows.slice(-limit);
      return rows.map((n) => ({ ...n }));
    },
    /** 挑一个兴趣：心情差 → 安慰型（听歌/看番/散步），心情好 → 烧脑/创作。 */
    pickInterest(pickOptions = {}) {
      load();
      if (off()) return { interest: '', kind: 'neutral', mood: 0, reason: 'off' };
      return pickInterest(state.notes, { config: cfg, rng, ...pickOptions });
    },
    /** 一天的汇总。 */
    summarizeDay(date) {
      load();
      return summarizeNotes(state.notes, date || dateOf(now()));
    },
    /**
     * 从外部 jsonl 导入。两种格式（watched / notes）都能吃，字段容错，按 id 去重。
     * @param {string|object[]|{text?:string,path?:string}} input 文本、行数组，或 {path} 读文件
     * @returns {{ added:number, skipped:number, rows:number, formats:object }}
     */
    importJsonl(input) {
      load();
      if (off() || cfg.collect === false) return { added: 0, skipped: 0, rows: 0, formats: { watched: 0, notes: 0, unknown: 0 } };
      let text = input;
      if (isPlainObject(input)) {
        if (input.path) {
          try { text = fs.readFileSync(String(input.path), 'utf8'); } catch (error) {
            warnings.push('读导入文件失败：' + (error.message || error));
            return { added: 0, skipped: 0, rows: 0, formats: { watched: 0, notes: 0, unknown: 0 } };
          }
        } else if (input.text !== undefined) {
          text = input.text;
        }
      }
      const parsed = parseLifeJsonl(text, { config: cfg, now: now() });
      const seen = new Set(state.notes.map((n) => n.id));
      let added = 0;
      let duplicated = 0;
      for (const note of parsed.notes) {
        // 同一条笔记重复导入 → id 一样 → 直接跳过（幂等，反复导入不会把生活刷成一堆影子记录）
        if (seen.has(note.id)) { duplicated += 1; continue; }
        seen.add(note.id);
        state.notes.push({ ...note });
        added += 1;
      }
      if (added > 0) {
        state.notes.sort((a, b) => a.createdAt - b.createdAt);
        if (state.notes.length > cfg.maxNotes) state.notes = state.notes.slice(-cfg.maxNotes);
        dirty += 1;
        flush();
      }
      return { added, skipped: parsed.skipped, duplicated, rows: parsed.rows, formats: parsed.formats };
    },
    /** 全部笔记（副本）。 */
    allNotes() {
      load();
      return sorted().map((n) => ({ ...n }));
    },
    flush,
    clear() {
      load();
      if (off()) return false;
      state.notes = [];
      dirty = 1;
      return flush();
    },
    snapshot() {
      load();
      return {
        enabled: cfg.enabled !== false,
        collect: cfg.collect !== false,
        notes: state.notes.length,
        updatedAt: state.updatedAt,
        today: summarizeNotes(state.notes, dateOf(now()))
      };
    },
    warnings
  };
}
