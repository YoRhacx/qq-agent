// ─────────────────────────────────────────────────────────────────────────────
// src/memory-profile.js — 「人物画像」：把同一个实体（人 / 群 / 项目 / 话题）散在
// 几十条记忆里的东西，压成一段第三人称印象。
//
// 移植自 D:\gjdxm\task\_yz\pkg\astrbot_plugin_memory_brain\profile.py。那版是
// 「拼提示词让模型写」，这一版是**纯启发式**：不调模型、不联网、不加依赖，
// 同样的输入永远得到同样的输出 —— 可测试、可复现、零 token。
//
// 与 memory-brain 的边界（别弄错，这条边界是硬约束）：
//   · 本模块**不写记忆库**。SQLite 只属于 src/memory-brain.js 和它唯一的使用者
//     bridge.js；这里只吃调用方传进来的只读快照 {memories:[…]}。
//   · 本模块只写自己的一份小 JSON（默认 state/memory-profile.json），
//     原子写（.part → rename）；开关关掉时连目录都不建。
//   · collectInputsFromMemoryBrain() 是唯一的适配器：用 brain.list() 翻页取记忆、
//     用 brain.db 的**只读 SELECT** 补实体名；拿不到实体名就当没有，不抛错。
//
// 给主控的调用节奏：每天定时一次（跟记忆卡衰减同一时段，比如 04:10），
// 每次最多 profile_max_per_run 个、同一个实体 profile_interval_days 天才更新。
// 出站前用 render() 取一小段塞进提示词。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

/** 画像 state 的结构版本，写进文件；将来做迁移时读它。 */
export const MEMORY_PROFILE_VERSION = 1;

/**
 * 出厂默认配置。**只读**：运行值来自 config.json 的 memoryProfile 块（主人手写），
 * 这里给的是「配置里没写时」的回落值。
 *
 * 下面三个是任务书里的参数名，两套写法都认（见 normalizeProfileConfig）：
 *   profile_min_degree  → minDegree
 *   profile_max_per_run → maxPerRun
 *   profile_interval_days → intervalDays
 */
export const DEFAULT_PROFILE_CONFIG = Object.freeze({
  enabled: true,
  statePath: 'state/memory-profile.json',
  // 一个实体至少出现在几条记忆里才值得给它写画像
  minDegree: 2,
  // 每天最多生成/更新几个画像（跨多次运行累计）
  maxPerRun: 5,
  // 同一个画像多少天更新一次（0 = 每次都允许更新）
  intervalDays: 7,
  // 画像长度：下限靠摘录记忆凑，上限硬裁
  minChars: 200,
  maxChars: 400,
  // 期望长度（在 minChars 与 maxChars 之间取一个舒服的点）
  targetChars: 260,
  // 一个实体最多参考几条记忆（按重要度、时间取）
  maxMemoriesPerEntity: 12,
  // 最多存多少个画像（超了先丢「出现次数少、更旧」的）
  maxProfiles: 200,
  // 实体名/摘录的长度上限
  maxNameChars: 24,
  maxSnippetChars: 52
});

const MS_PER_DAY = 86400000;
const NUM_MARKS = ['①', '②', '③', '④', '⑤'];
const TYPE_WORD = Object.freeze({ person: '人', group: '群', project: '项目', place: '地方', topic: '话题', thing: '东西' });
const KIND_WORD = Object.freeze({
  episode: '日常片段',
  fact: '具体的事实',
  preference: '喜好',
  relation: '人和人的关系',
  skill: '做过的事',
  reflection: '自己的回想',
  lesson: '经验'
});
const STOP_NAMES = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '这个', '那个', '什么',
  '一个', '今天', '昨天', '明天', '大家', '自己', '别人', '东西', '事情', '现在'
]);
const STOP_PHRASES = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '这个', '那个', '什么', '一个',
  '一起', '现在', '大家', '自己', '别人', '东西', '事情', '真的', '有点', '这样', '那样'
]);

// ── 基础小工具（本仓库的惯例：为了一个函数去 import 整个模块不值得，就地实现）────

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

/** 本地日期的 YYYY-MM-DD（跟 memory-card 的 todayKey 同一口径）。 */
function dayKey(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isoOf(ms) {
  return new Date(Number(ms) || 0).toISOString();
}

/** 时间既可以给毫秒数，也可以给 ISO 字符串；解析不出来时用 fallback。 */
function parseTime(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : fallback;
}

function oneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** 原子写：先写 .part-* 再 rename，进程半路挂掉也不会留下半截 JSON。 */
function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.part-' + process.pid.toString(36) + '-' + Date.now().toString(36);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能压根没建起来 */ }
    throw error;
  }
}

// ── 配置归一化 ───────────────────────────────────────────────────────────────

function pick(source, keys, fallback) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
}

/** 把 config.json 里的 memoryProfile 块归一成「一定能用」的形状；非法值回落默认。 */
export function normalizeProfileConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_PROFILE_CONFIG;
  return {
    enabled: src.enabled !== false,
    statePath: String(pick(src, ['statePath', 'stateFile', 'file'], d.statePath) || d.statePath),
    minDegree: intOf(pick(src, ['minDegree', 'profile_min_degree'], d.minDegree), d.minDegree, 1, 100),
    maxPerRun: intOf(pick(src, ['maxPerRun', 'profile_max_per_run'], d.maxPerRun), d.maxPerRun, 0, 200),
    intervalDays: intOf(pick(src, ['intervalDays', 'profile_interval_days'], d.intervalDays), d.intervalDays, 0, 3650),
    minChars: intOf(pick(src, ['minChars', 'profile_min_chars'], d.minChars), d.minChars, 40, 2000),
    maxChars: intOf(pick(src, ['maxChars', 'profile_max_chars'], d.maxChars), d.maxChars, 80, 4000),
    targetChars: intOf(pick(src, ['targetChars', 'profile_target_chars'], d.targetChars), d.targetChars, 60, 4000),
    maxMemoriesPerEntity: intOf(
      pick(src, ['maxMemoriesPerEntity', 'profile_max_memories'], d.maxMemoriesPerEntity),
      d.maxMemoriesPerEntity, 1, 200
    ),
    maxProfiles: intOf(pick(src, ['maxProfiles', 'profile_max_profiles'], d.maxProfiles), d.maxProfiles, 1, 5000),
    maxNameChars: intOf(pick(src, ['maxNameChars'], d.maxNameChars), d.maxNameChars, 4, 64),
    maxSnippetChars: intOf(pick(src, ['maxSnippetChars'], d.maxSnippetChars), d.maxSnippetChars, 12, 200)
  };
}

// ── 输入归一化 ───────────────────────────────────────────────────────────────

/** 实体名 → 稳定的键（去空白/标点、小写）。画像按它去重和查找。 */
export function profileEntityKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffa-z0-9]/g, '');
}

/**
 * 实体列表归一化：收字符串或 {name,type}；丢掉空名、停用词、超长的。
 * @returns {{name: string, type: string}[]}
 */
export function normalizeEntityList(raw, config = {}) {
  const cfg = normalizeProfileConfig(config);
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    let name = '';
    let type = 'thing';
    if (typeof item === 'string') {
      name = item;
    } else if (item && typeof item === 'object') {
      name = String(item.name ?? item.text ?? '');
      type = String(item.type ?? 'thing').toLowerCase();
    }
    name = oneLine(name, cfg.maxNameChars);
    if (!name || STOP_NAMES.has(name)) continue;
    const key = profileEntityKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!TYPE_WORD[type]) type = 'thing';
    out.push({ name, type });
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * 记忆快照归一化：接受 {memories:[…]} 或裸数组；坏条目直接丢，不抛。
 * @returns {{id:any, kind:string, text:string, entities:object[], createdAt:number, importance:number, valence:number}[]}
 */
export function normalizeInputMemories(input) {
  const rows = Array.isArray(input) ? input : Array.isArray(input?.memories) ? input.memories : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const text = oneLine(row.text, 800);
    if (!text) continue;
    out.push({
      id: row.id ?? out.length,
      kind: String(row.kind ?? 'episode'),
      text,
      entities: normalizeEntityList(row.entities),
      createdAt: parseTime(row.createdAt ?? row.created_at, 0),
      importance: clamp(Number(row.importance ?? 0.5), 0, 1),
      valence: clamp(Number(row.valence ?? 0), -1, 1)
    });
  }
  return out;
}

/** 按实体把记忆聚起来。degree = 不同记忆的条数，mentions = 出现次数（含同一条里重复）。 */
function groupEntities(memories) {
  const groups = new Map();
  for (const memory of memories) {
    const seen = new Set();
    for (const entity of memory.entities) {
      const key = profileEntityKey(entity.name);
      if (!key) continue;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: entity.name,
          type: entity.type,
          degree: 0,
          mentions: 0,
          memories: [],
          latestAt: 0,
          names: new Map()
        };
        groups.set(key, group);
      }
      group.mentions += 1;
      group.names.set(entity.name, (group.names.get(entity.name) || 0) + 1);
      if (entity.type !== 'thing' && group.type === 'thing') group.type = entity.type;
      if (!seen.has(key)) {
        seen.add(key);
        group.degree += 1;
        group.memories.push(memory);
        group.latestAt = Math.max(group.latestAt, memory.createdAt || 0);
      }
    }
  }
  // 显示名：出现次数最多的写法；并列时取更长的（更像全名）
  for (const group of groups.values()) {
    let best = group.name;
    let bestCount = -1;
    for (const [label, count] of group.names) {
      if (count > bestCount || (count === bestCount && label.length > best.length)) {
        best = label;
        bestCount = count;
      }
    }
    group.name = best;
  }
  return groups;
}

// ── 启发式：从记忆文本里抠「称呼 / 偏好 / 雷点」──────────────────────────────

function prefPattern() {
  return /(?:喜欢|爱吃|爱喝|偏爱|最爱|爱玩|爱看|爱听|想要|想吃|馋)(?:吃|喝|玩|看|听|买|做|上|用)?([^，。；！？、\s]{1,12})/g;
}

function dislikePattern() {
  return /(?:讨厌|不喜欢|反感|受不了|害怕|忌讳|忌口|雷点是?)(?:吃|喝|玩|看|听|买|做|上|用)?([^，。；！？、\s]{1,12})/g;
}

function addressPattern() {
  return /(?:也叫|又叫|外号(?:是|叫)?|昵称(?:是|叫)?|大家都叫(?:他|她)?|被叫作|被称为|叫他|叫她)([^，。；！？、\s]{1,10})/g;
}

function cleanPhrase(value) {
  let s = oneLine(value, 24);
  s = s.replace(/^[的地得]+/, '').replace(/[的了呢啊吧呀嘛哦]+$/, '').replace(/[，。；！？、]+$/, '').trim();
  if (!s || s.length > 16 || STOP_PHRASES.has(s)) return '';
  return s;
}

function collectPhrases(memories, patternFactory, limit) {
  const out = [];
  const seen = new Set();
  for (const memory of memories) {
    for (const match of memory.text.matchAll(patternFactory())) {
      const value = cleanPhrase(match[1]);
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      let contains = false;
      for (const prev of out) {
        if (prev.includes(value) || value.includes(prev)) { contains = true; break; }
      }
      if (contains) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 摘录：去掉「主人：」这种发言人前缀，裁到 maxSnippetChars。 */
function snippetOf(text, maxChars) {
  const s = oneLine(text, 400).replace(/^[^：:]{1,12}[：:]\s*/, '').trim();
  return s.length > maxChars ? s.slice(0, maxChars - 1).trim() + '…' : s;
}

function byImportance(a, b) {
  return (b.importance - a.importance) || ((b.createdAt || 0) - (a.createdAt || 0));
}

function clampProfileText(text, cfg) {
  const s = String(text ?? '').trim();
  if (s.length <= cfg.maxChars) return s;
  const cut = s.slice(0, cfg.maxChars - 1);
  const at = cut.lastIndexOf('。');
  if (at >= cfg.minChars) return cut.slice(0, at + 1);
  return cut.trim() + '…';
}

// ── 画像正文（纯函数，可单测）────────────────────────────────────────────────

/**
 * 生成一段第三人称画像。200~400 字靠「必需的判断句 + 记忆摘录」凑，
 * 事实不够时不注水（返回会短于 minChars），文档里写清了这一点。
 *
 * @param {{name:string,type:string,degree:number,memories:object[]}} group
 * @param {object} config
 * @returns {string}
 */
export function buildProfileText(group, config = {}) {
  const cfg = normalizeProfileConfig(config);
  const name = String(group?.name ?? '').trim();
  if (!name) return '';
  const memories = (Array.isArray(group.memories) ? group.memories : [])
    .slice()
    .sort(byImportance)
    .slice(0, cfg.maxMemoriesPerEntity);
  if (!memories.length) return '';
  const typeWord = TYPE_WORD[group.type] || '东西';

  const parts = [];
  parts.push('「' + name + '」是她记得比较清楚的' + typeWord + '之一，前后在 ' + Math.max(1, Number(group.degree) || memories.length) + ' 件事里被提到。');

  const kindCount = new Map();
  for (const memory of memories) kindCount.set(memory.kind, (kindCount.get(memory.kind) || 0) + 1);
  let topKind = '';
  let topCount = 0;
  for (const [kind, count] of kindCount) {
    if (count > topCount) { topKind = kind; topCount = count; }
  }
  if (topCount >= 2) parts.push('记下的大多是' + (KIND_WORD[topKind] || '日常片段') + '。');

  const forms = collectPhrases(memories, addressPattern, 2);
  if (forms.length) parts.push('有时候也会被叫作「' + forms.join('」「') + '」。');

  const liked = collectPhrases(memories, prefPattern, 3);
  if (liked.length) parts.push('她记得' + name + '喜欢' + liked.join('、') + '。');

  const disliked = collectPhrases(memories, dislikePattern, 3);
  if (disliked.length) parts.push('还有一点：' + name + '不太喜欢' + disliked.join('、') + '。');

  const stamps = memories.map((m) => m.createdAt).filter((t) => Number.isFinite(t) && t > 0);
  if (stamps.length) {
    const first = Math.min(...stamps);
    const last = Math.max(...stamps);
    if (dayKey(first) === dayKey(last)) {
      parts.push('关于' + name + '的记忆都集中在 ' + dayKey(first) + '。');
    } else {
      parts.push('最早的一条记忆是 ' + dayKey(first) + '，最近一次是 ' + dayKey(last) + '。');
    }
  }

  let text = parts.join('');

  // 记忆摘录：一条一条加，直到够 targetChars（或没得加）
  const target = Math.max(cfg.minChars, Math.min(cfg.targetChars, cfg.maxChars - 8));
  const snippets = [];
  const seenSnippets = new Set();
  for (const memory of memories) {
    const s = snippetOf(memory.text, cfg.maxSnippetChars);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seenSnippets.has(key)) continue;
    let dup = false;
    for (const prev of snippets) if (prev.includes(s) || s.includes(prev)) { dup = true; break; }
    if (dup) continue;
    seenSnippets.add(key);
    snippets.push(s);
  }
  let used = 0;
  let block = '';
  while (used < snippets.length && used < NUM_MARKS.length && text.length + block.length < target) {
    block += NUM_MARKS[used] + snippets[used] + ' ';
    used += 1;
  }
  if (used > 0) text += '印象里的几件事：' + block.trim();

  return clampProfileText(text, cfg);
}

// ── 只读适配器：从记忆大脑取快照 ─────────────────────────────────────────────

function attachEntityNames(brain, memories) {
  const db = brain?.db;
  if (!db || typeof db.prepare !== 'function' || !memories.length) return;
  const byId = new Map(memories.map((m) => [Number(m.id), m]));
  const ids = memories.map((m) => Number(m.id)).filter((id) => Number.isFinite(id));
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const marks = chunk.map(() => '?').join(',');
    let rows = [];
    try {
      // 只读 SELECT：绝不写库。拿不到（库结构变了/表不存在）就当没有实体名。
      rows = db.prepare(
        'SELECT me.memory_id AS mid, e.name AS name, e.type AS type ' +
        'FROM memory_entities me JOIN entities e ON e.id = me.entity_id ' +
        'WHERE me.memory_id IN (' + marks + ')'
      ).all(...chunk);
    } catch {
      continue;
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      const memory = byId.get(Number(row?.mid));
      if (!memory) continue;
      if (memory.entities.length >= 12) continue;
      memory.entities.push({ name: String(row?.name ?? ''), type: String(row?.type ?? 'thing') });
    }
  }
}

/**
 * 从记忆大脑取一份**只读**快照：{memories:[{id,kind,text,entities,createdAt,importance,…}]}。
 *
 * 只做两件事：brain.list({status}) 翻页取记忆；brain.db 上跑只读 SELECT 补实体名。
 * 任何一步失败都降级（少实体名 / 少几条），绝不抛、绝不写库。
 *
 * @param {object} brain openMemoryBrain() 的返回值（需要有 list()）
 * @param {{limit?:number,status?:string,since?:number,until?:number}} [options]
 */
export function collectInputsFromMemoryBrain(brain, options = {}) {
  if (!brain || typeof brain.list !== 'function') {
    throw new Error('collectInputsFromMemoryBrain: 需要一个带 list() 的记忆库对象（openMemoryBrain 的返回值）');
  }
  const limit = intOf(options.limit, 500, 1, 5000);
  const status = ['active', 'archived', 'merged'].includes(options.status) ? options.status : 'active';
  const since = Number.isFinite(Number(options.since)) ? Number(options.since) : 0;
  const until = Number.isFinite(Number(options.until)) ? Number(options.until) : Infinity;
  const memories = [];
  let offset = 0;
  let total = 0;
  let guard = 0;
  while (memories.length < limit && guard < 100) {
    guard += 1;
    const pageSize = Math.min(500, limit - memories.length);
    let page = null;
    try {
      page = brain.list({ status, limit: pageSize, offset });
    } catch {
      break;
    }
    const items = Array.isArray(page?.items) ? page.items : [];
    total = Number(page?.total) || total;
    if (!items.length) break;
    for (const item of items) {
      const createdAt = Number(item?.createdAt ?? item?.created_at) || 0;
      if (createdAt && (createdAt < since || createdAt > until)) continue;
      memories.push({
        id: item?.id ?? memories.length,
        kind: String(item?.kind ?? 'episode'),
        text: String(item?.text ?? ''),
        entities: [],
        createdAt,
        importance: Number(item?.importance ?? 0.5),
        valence: Number(item?.valence ?? 0),
        visibility: String(item?.visibility ?? 'private')
      });
      if (memories.length >= limit) break;
    }
    offset += items.length;
    if (total && offset >= total) break;
  }
  attachEntityNames(brain, memories);
  return { memories, total: total || memories.length, fetchedAt: Date.now(), source: 'memory-brain' };
}

// ── 状态文件 ─────────────────────────────────────────────────────────────────

function emptyState() {
  return { version: MEMORY_PROFILE_VERSION, day: '', dayCount: 0, profiles: [], stats: { generated: 0, refreshed: 0, pruned: 0 }, updatedAt: '' };
}

function normalizeProfileRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entityId = String(raw.entityId ?? '').trim();
  const name = oneLine(raw.name, 24);
  const profile = oneLine(raw.profile, 4000);
  if (!entityId || !name || !profile) return null;
  const degree = Math.max(1, Math.round(Number(raw.degree) || 1));
  return {
    entityId,
    name,
    degree,
    profile,
    firstAt: String(raw.firstAt ?? raw.updatedAt ?? ''),
    updatedAt: String(raw.updatedAt ?? '')
  };
}

function normalizeProfileState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.version = Number(raw.version) || MEMORY_PROFILE_VERSION;
  state.day = String(raw.day ?? '');
  state.dayCount = Math.max(0, Math.round(Number(raw.dayCount) || 0));
  state.updatedAt = String(raw.updatedAt ?? '');
  state.stats = { ...state.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) };
  for (const item of Array.isArray(raw.profiles) ? raw.profiles : []) {
    const record = normalizeProfileRecord(item);
    if (record) state.profiles.push(record);
  }
  return state;
}

/**
 * 创建画像生成器。
 *
 * @param {{statePath?: string, config?: object, now?: () => number}} [options]
 *   statePath  状态文件路径（测试传临时目录；默认 state/memory-profile.json）
 *   config     config.json 的 memoryProfile 块（也可以直接平铺传）
 *   now        取当前时间的函数（测试注入假时钟；默认 Date.now）
 */
export function createProfileBuilder(options = {}) {
  const rawConfig = options.config && typeof options.config === 'object' ? options.config : options;
  const cfg = normalizeProfileConfig(rawConfig);
  const statePath = path.resolve(String(options.statePath || cfg.statePath || DEFAULT_PROFILE_CONFIG.statePath));
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
      if (error?.code === 'ENOENT') return;   // 没有文件 = 空状态，而且**不主动创建**
      warnings.push('读画像状态失败：' + (error?.message ?? error));
      return;
    }
    try {
      const parsed = normalizeProfileState(JSON.parse(text));
      state.version = parsed.version;
      state.day = parsed.day;
      state.dayCount = parsed.dayCount;
      state.profiles = parsed.profiles;
      state.stats = parsed.stats;
      state.updatedAt = parsed.updatedAt;
    } catch (error) {
      warnings.push('画像状态不是合法 JSON（已忽略，按空状态继续）：' + (error?.message ?? error));
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
      warnings.push('写画像状态失败：' + (error?.message ?? error));
      return false;
    }
  }

  function trimProfiles() {
    if (state.profiles.length <= cfg.maxProfiles) return 0;
    state.profiles.sort((a, b) => (b.degree - a.degree) || (parseTime(b.updatedAt, 0) - parseTime(a.updatedAt, 0)));
    const dropped = state.profiles.length - cfg.maxProfiles;
    state.profiles = state.profiles.slice(0, cfg.maxProfiles);
    state.stats.pruned = (Number(state.stats.pruned) || 0) + dropped;
    return dropped;
  }

  /**
   * 跑一轮：聚合 → 阈值过滤 → 限额 → 生成/更新 → 落盘。
   * 同一天重复跑是幂等的（当天更新过的画像不会再写一遍）。
   */
  function build(input = {}, opts = {}) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const day = dayKey(now);
    if (!cfg.enabled) {
      return { ok: true, enabled: false, day, created: [], updated: [], skipped: [], changed: false, remaining: 0, total: 0, reason: 'disabled' };
    }
    load();
    if (state.day !== day) {
      state.day = day;
      state.dayCount = 0;
    }
    const memories = normalizeInputMemories(input);
    const groups = groupEntities(memories);
    const existing = new Map(state.profiles.map((p) => [p.entityId, p]));
    const order = Array.from(groups.values())
      .filter((group) => group.degree >= cfg.minDegree)
      .sort((a, b) => (b.degree - a.degree) || (b.latestAt - a.latestAt) || a.key.localeCompare(b.key));

    const created = [];
    const updated = [];
    const skipped = [];
    let remaining = Math.max(0, cfg.maxPerRun - Math.max(0, state.dayCount));

    for (const group of order) {
      if (remaining <= 0) {
        skipped.push({ entityId: group.key, name: group.name, degree: group.degree, reason: 'budget' });
        continue;
      }
      const prev = existing.get(group.key);
      if (prev) {
        const prevAt = parseTime(prev.updatedAt, 0);
        if (!opts.force && prevAt > 0 && dayKey(prevAt) === day) {
          skipped.push({ entityId: group.key, name: group.name, degree: group.degree, reason: 'today' });
          continue;
        }
        const ageDays = prevAt > 0 ? (now - prevAt) / MS_PER_DAY : Number.POSITIVE_INFINITY;
        if (!opts.force && ageDays < cfg.intervalDays) {
          skipped.push({ entityId: group.key, name: group.name, degree: group.degree, reason: 'interval' });
          continue;
        }
      }
      const profile = buildProfileText(group, cfg);
      if (!profile) {
        skipped.push({ entityId: group.key, name: group.name, degree: group.degree, reason: 'empty' });
        continue;
      }
      const record = {
        entityId: group.key,
        name: group.name,
        degree: group.degree,
        profile,
        firstAt: prev?.firstAt || isoOf(now),
        updatedAt: isoOf(now)
      };
      if (prev) {
        Object.assign(prev, record);
        updated.push({ ...prev });
        state.stats.refreshed = (Number(state.stats.refreshed) || 0) + 1;
      } else {
        state.profiles.push(record);
        existing.set(record.entityId, record);
        created.push({ ...record });
        state.stats.generated = (Number(state.stats.generated) || 0) + 1;
      }
      state.dayCount += 1;
      remaining -= 1;
      dirty = true;
    }

    trimProfiles();
    const written = save();
    return {
      ok: true,
      enabled: true,
      day,
      created,
      updated,
      skipped,
      changed: created.length + updated.length > 0,
      remaining: Math.max(0, cfg.maxPerRun - Math.max(0, state.dayCount)),
      total: state.profiles.length,
      written
    };
  }

  /** 全部画像（按 degree、更新时间排）。返回副本，外部改不到内部状态。 */
  function list() {
    if (!cfg.enabled) return [];
    load();
    return state.profiles
      .slice()
      .sort((a, b) => (b.degree - a.degree) || (parseTime(b.updatedAt, 0) - parseTime(a.updatedAt, 0)))
      .map((item) => ({ ...item }));
  }

  /** 按 entityId / 名字取一个画像；没有返回 null。 */
  function get(key) {
    if (!cfg.enabled) return null;
    load();
    const probe = String(key ?? '').trim();
    if (!probe) return null;
    const byKey = profileEntityKey(probe);
    const found = state.profiles.find((item) => item.entityId === probe || item.entityId === byKey || profileEntityKey(item.name) === byKey);
    return found ? { ...found } : null;
  }

  /**
   * 出站注入用：按名字挑画像，拼成一小段（带预算）。
   * 没有画像时返回空串 —— 调用方不用判断开关。
   */
  function render(opts = {}) {
    if (!cfg.enabled) return '';
    load();
    const maxChars = intOf(opts.maxChars, 400, 40, 4000);
    const names = Array.isArray(opts.names) ? opts.names.map((n) => profileEntityKey(n)) : [];
    let items = state.profiles.slice().sort((a, b) => (b.degree - a.degree) || (parseTime(b.updatedAt, 0) - parseTime(a.updatedAt, 0)));
    if (names.length) items = items.filter((item) => names.includes(item.entityId) || names.includes(profileEntityKey(item.name)));
    if (!items.length) return '';
    const lines = ['【人物印象】'];
    let budget = maxChars;
    for (const item of items) {
      const body = item.profile.length > 140 ? item.profile.slice(0, 139) + '…' : item.profile;
      const line = '- ' + item.name + '：' + body;
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
      day: state.day,
      dayCount: state.dayCount,
      remaining: Math.max(0, cfg.maxPerRun - Math.max(0, state.dayCount)),
      total: state.profiles.length,
      minDegree: cfg.minDegree,
      maxPerRun: cfg.maxPerRun,
      intervalDays: cfg.intervalDays,
      updatedAt: state.updatedAt,
      stats: { ...state.stats },
      warnings: warnings.slice()
    };
  }

  return { statePath, config: cfg, build, list, get, render, status };
}

export default createProfileBuilder;
