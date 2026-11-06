// ─────────────────────────────────────────────────────────────────────────────
// src/memory-reflection.js — 「每日反思」：把当天记下的零散 episode 收拢成
// 一篇第一人称的小日记（今天发生了什么 / 我是怎么应对的 / 下次怎么更好）。
//
// 移植自 D:\gjdxm\task\_yz\pkg\astrbot_plugin_memory_brain\reflection.py。那版是
// 「拼提示词让模型写三句」，这一版是**纯启发式**：不调模型、不联网、不加依赖，
// 同样的输入永远得到同样的输出（可测试、零 token）。
//
// 与 memory-brain 的边界：
//   · 不写记忆库。输入是调用方给的只读快照 {memories:[…]}。
//   · 只写自己的一份小 JSON（默认 state/memory-reflection.json），原子写。
//   · 开关关掉时不建文件、不返回内容。
//
// 给主控的调用节奏：每天一次（建议 23:50 或次日 04:10，跟画像同一批定时），
// 把**当天**的记忆喂给 run()；同一天重复跑是幂等的（不会写第二条）。
// 出站前用 render() 取最近一两天的反思，塞进提示词。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

/** 反思 state 的结构版本。 */
export const MEMORY_REFLECTION_VERSION = 1;

export const DEFAULT_REFLECTION_CONFIG = Object.freeze({
  enabled: true,
  statePath: 'state/memory-reflection.json',
  // 保留最近多少天（任务书要求 30 天）
  keepDays: 30,
  // 摘要里最多点几件事
  maxHighlights: 3,
  // 摘要参考条数上限 / 每条摘录字数上限
  maxMemories: 8,
  maxHighlightChars: 40,
  // 一篇反思的字数上限
  maxChars: 400,
  // 当天记忆少于这个数就不写（0 = 只要有一条就写）
  minMemories: 1
});

const KIND_WORD = Object.freeze({
  episode: '日常来回',
  fact: '具体的事',
  preference: '喜好',
  relation: '人和人的关系',
  skill: '做过的事',
  reflection: '自己的想法',
  lesson: '经验'
});

// ── 基础小工具 ───────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

function intOf(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function dayKey(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isoOf(ms) {
  return new Date(Number(ms) || 0).toISOString();
}

function parseTime(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : fallback;
}

function oneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** 原子写：.part-* → rename。半路挂掉也不会留半截 JSON。 */
function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.part-' + process.pid.toString(36) + '-' + Date.now().toString(36);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 可能没建起来 */ }
    throw error;
  }
}

/** 去掉「主人：」这类发言人前缀，再裁到 max。 */
function snippetOf(text, max) {
  const s = oneLine(text, 400).replace(/^[^：:]{1,12}[：:]\s*/, '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1).trim() + '…' : s;
}

function byImportance(a, b) {
  return (b.importance - a.importance) || ((b.createdAt || 0) - (a.createdAt || 0));
}

// ── 配置与输入 ───────────────────────────────────────────────────────────────

export function normalizeReflectionConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_REFLECTION_CONFIG;
  const num = (keys, fallback, min, max) => {
    for (const key of keys) {
      const value = src[key];
      if (value !== undefined && value !== null) return intOf(value, fallback, min, max);
    }
    return fallback;
  };
  return {
    enabled: src.enabled !== false,
    statePath: String(src.statePath || src.stateFile || d.statePath),
    keepDays: num(['keepDays', 'reflection_keep_days'], d.keepDays, 1, 3650),
    maxHighlights: num(['maxHighlights', 'reflection_max_highlights'], d.maxHighlights, 0, 10),
    maxMemories: num(['maxMemories', 'reflection_max_memories'], d.maxMemories, 1, 100),
    maxHighlightChars: num(['maxHighlightChars'], d.maxHighlightChars, 8, 200),
    maxChars: num(['maxChars', 'reflection_max_chars'], d.maxChars, 80, 2000),
    minMemories: num(['minMemories', 'reflection_min_memories'], d.minMemories, 0, 100)
  };
}

function normalizeMemories(input) {
  const rows = Array.isArray(input) ? input : Array.isArray(input?.memories) ? input.memories : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const text = oneLine(row.text, 800);
    const createdAt = Number(row.createdAt ?? row.created_at) || 0;
    if (!text || !createdAt) continue;   // 没有时间的记忆归不到「哪一天」，直接不要
    out.push({
      id: row.id ?? out.length,
      kind: String(row.kind ?? 'episode'),
      text,
      createdAt,
      importance: clamp(Number(row.importance ?? 0.5), 0, 1),
      valence: clamp(Number(row.valence ?? 0), -1, 1)
    });
  }
  return out;
}

/** 只保留某一天（本地日历日）的记忆。 */
export function pickDayMemories(memories, day) {
  return (Array.isArray(memories) ? memories : []).filter((m) => m && m.createdAt && dayKey(m.createdAt) === day);
}

// ── 正文（纯函数，可单测）────────────────────────────────────────────────────

/**
 * 把一天的记忆写成一篇小日记。全部是模板句 + 当天真实的数据（条数、种类、
 * 情绪计数、摘录），不编造没发生的事；记忆不够时句子会少，不注水。
 *
 * @param {object[]} memories 已经过滤成「当天」的记忆（normalize 过的）
 * @param {object} config
 * @returns {{summary:string, highlights:string[]}}
 */
export function buildReflectionText(memories, config = {}) {
  const cfg = normalizeReflectionConfig(config);
  const rows = (Array.isArray(memories) ? memories : []).slice().sort(byImportance);
  if (!rows.length) return { summary: '', highlights: [] };

  // 亮点：按重要度挑前几条，互相包含的只留一条
  const highlights = [];
  const seen = new Set();
  for (const row of rows) {
    const text = snippetOf(row.text, cfg.maxHighlightChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    let dup = false;
    for (const prev of highlights) if (prev.includes(text) || text.includes(prev)) { dup = true; break; }
    if (dup) continue;
    seen.add(key);
    highlights.push(text);
    if (highlights.length >= cfg.maxHighlights) break;
  }

  const count = rows.length;
  const head = '今天一共记下 ' + count + ' 件事' +
    (highlights.length ? '，最要紧的是：' + highlights.join('；') : '') + '。';

  // 情绪：数一数偏负面的有几条（不猜语气，只数标记）
  const negative = rows.filter((row) => row.valence <= -0.25).length;
  const positive = rows.filter((row) => row.valence >= 0.25).length;
  let moodLine;
  if (negative > positive) {
    moodLine = '这一天整体不太轻松，有 ' + negative + ' 件事带着情绪，回头看还能想起当时的语气。';
  } else if (positive > negative) {
    moodLine = '这一天整体是轻快的，有 ' + positive + ' 件事让人心里发暖。';
  } else {
    moodLine = '这一天说不上好也说不上坏，多是日常的来来回回。';
  }

  // 怎么应对：按种类说一句实话（今天主要在处理什么）
  const kindCount = new Map();
  for (const row of rows) kindCount.set(row.kind, (kindCount.get(row.kind) || 0) + 1);
  let topKind = 'episode';
  let topCount = 0;
  for (const [kind, n] of kindCount) if (n > topCount) { topKind = kind; topCount = n; }
  const important = rows.filter((row) => row.importance >= 0.6).length;
  const howLine = '回想起来，今天记下的多是' + (KIND_WORD[topKind] || '日常来回') +
    (important > 0 ? '，其中 ' + important + ' 件算得上要紧。' : '，没有特别要紧的事。');

  // 下次怎么更好：有 lesson 就用自己写下的，没有就给一句按情绪选的
  const lessons = rows.filter((row) => row.kind === 'lesson')
    .map((row) => snippetOf(row.text, cfg.maxHighlightChars))
    .filter(Boolean)
    .slice(0, 2);
  const nextLine = lessons.length
    ? '下次可以照着自己写下的来：' + lessons.join('；') + '。'
    : negative > positive
      ? '下次再碰到那种时候，先接住情绪，别急着解释。'
      : '下次还是照今天这样，先听完，再开口。';

  let summary = [head, moodLine, howLine, nextLine].join('');
  if (summary.length > cfg.maxChars) {
    const cut = summary.slice(0, cfg.maxChars - 1);
    const at = cut.lastIndexOf('。');
    summary = at > 80 ? cut.slice(0, at + 1) : cut.trim() + '…';
  }
  return { summary, highlights };
}

// ── 状态文件 ─────────────────────────────────────────────────────────────────

function emptyState() {
  return { version: MEMORY_REFLECTION_VERSION, items: [], updatedAt: '' };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = String(raw.date ?? '').trim();
  const summary = oneLine(raw.summary, 4000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !summary) return null;
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : [])
    .map((item) => oneLine(item, 200))
    .filter(Boolean)
    .slice(0, 10);
  return {
    date,
    summary,
    highlights,
    createdAt: String(raw.createdAt ?? ''),
    memoryCount: Math.max(0, Math.round(Number(raw.memoryCount) || 0))
  };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.version = Number(raw.version) || MEMORY_REFLECTION_VERSION;
  state.updatedAt = String(raw.updatedAt ?? '');
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const record = normalizeItem(item);
    if (record) state.items.push(record);
  }
  state.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return state;
}

/**
 * 创建反思写入器。
 *
 * @param {{statePath?: string, config?: object, now?: () => number}} [options]
 */
export function createReflectionWriter(options = {}) {
  const rawConfig = options.config && typeof options.config === 'object' ? options.config : options;
  const cfg = normalizeReflectionConfig(rawConfig);
  const statePath = path.resolve(String(options.statePath || cfg.statePath || DEFAULT_REFLECTION_CONFIG.statePath));
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  const state = emptyState();
  const warnings = [];
  let loaded = false;
  let dirty = false;

  function load() {
    if (loaded) return;
    loaded = true;
    let text = '';
    try {
      text = fs.readFileSync(statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      warnings.push('读反思状态失败：' + (error?.message ?? error));
      return;
    }
    try {
      const parsed = normalizeState(JSON.parse(text));
      state.version = parsed.version;
      state.items = parsed.items;
      state.updatedAt = parsed.updatedAt;
    } catch (error) {
      warnings.push('反思状态不是合法 JSON（已忽略，按空状态继续）：' + (error?.message ?? error));
    }
  }

  function save() {
    if (!cfg.enabled || !dirty) return false;
    state.updatedAt = isoOf(nowFn());
    try {
      atomicWriteJson(statePath, state);
      dirty = false;
      return true;
    } catch (error) {
      warnings.push('写反思状态失败：' + (error?.message ?? error));
      return false;
    }
  }

  function prune() {
    if (state.items.length <= cfg.keepDays) return 0;
    state.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const dropped = state.items.length - cfg.keepDays;
    state.items = state.items.slice(state.items.length - cfg.keepDays);
    return dropped;
  }

  /**
   * 跑一天的反思：只取当天记忆 → 写一条 → 裁剪到 keepDays。
   * 同一天重复调用返回已有那条（created:false），不会写第二条。
   */
  function run(input = {}, opts = {}) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const date = dayKey(now);
    if (!cfg.enabled) {
      return { ok: true, enabled: false, created: false, date, summary: '', highlights: [], reason: 'disabled' };
    }
    load();
    const memories = normalizeMemories(input);
    const today = pickDayMemories(memories, date);
    const existing = state.items.find((item) => item.date === date);

    if (existing && !opts.force) {
      return {
        ok: true, enabled: true, created: false, date,
        summary: existing.summary, highlights: existing.highlights.slice(),
        chars: existing.summary.length, memoryCount: existing.memoryCount, reason: 'already'
      };
    }
    if (today.length < cfg.minMemories) {
      return { ok: true, enabled: true, created: false, date, summary: '', highlights: [], reason: 'empty', memoryCount: today.length };
    }

    const { summary, highlights } = buildReflectionText(today, cfg);
    if (!summary) {
      return { ok: true, enabled: true, created: false, date, summary: '', highlights: [], reason: 'empty', memoryCount: today.length };
    }
    const record = { date, summary, highlights, createdAt: isoOf(now), memoryCount: today.length };
    if (existing) {
      Object.assign(existing, record);
    } else {
      state.items.push(record);
    }
    const dropped = prune();
    dirty = true;
    const written = save();
    return {
      ok: true, enabled: true, created: true, date,
      summary, highlights: highlights.slice(), chars: summary.length,
      memoryCount: today.length, dropped, written, replaced: Boolean(existing)
    };
  }

  /** 最近 n 天（新的在前）。 */
  function list(opts = {}) {
    if (!cfg.enabled) return [];
    load();
    const limit = intOf(opts.limit, cfg.keepDays, 1, cfg.keepDays);
    return state.items.slice(-limit).reverse().map((item) => ({ ...item, highlights: item.highlights.slice() }));
  }

  /** 取某一天（YYYY-MM-DD）；没有返回 null。 */
  function get(date) {
    if (!cfg.enabled) return null;
    load();
    const key = String(date ?? '').trim();
    const found = state.items.find((item) => item.date === key);
    return found ? { ...found, highlights: found.highlights.slice() } : null;
  }

  /** 出站注入用：最近几天各取一句（带预算）；没有内容返回空串。 */
  function render(opts = {}) {
    if (!cfg.enabled) return '';
    load();
    const days = intOf(opts.days, 3, 1, cfg.keepDays);
    const maxChars = intOf(opts.maxChars, 500, 40, 4000);
    const items = state.items.slice(-days).reverse();
    if (!items.length) return '';
    const lines = ['【最近的回想】'];
    let budget = maxChars;
    for (const item of items) {
      const body = item.summary.length > 180 ? item.summary.slice(0, 179) + '…' : item.summary;
      const line = '- ' + item.date + '：' + body;
      if (line.length + 1 > budget) break;
      lines.push(line);
      budget -= line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** 只读状态，给控制台/自检看。 */
  function status() {
    load();
    return {
      enabled: cfg.enabled,
      statePath,
      keepDays: cfg.keepDays,
      total: state.items.length,
      latest: state.items.length ? state.items[state.items.length - 1].date : '',
      updatedAt: state.updatedAt,
      warnings: warnings.slice()
    };
  }

  return { statePath, config: cfg, run, list, get, render, status };
}

export default createReflectionWriter;
