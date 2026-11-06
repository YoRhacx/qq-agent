// ─────────────────────────────────────────────────────────────────────────────
// src/persona-state.js — 「情绪层 + 好感 / 识海 / 旧账」的持久化状态模块。
//
// 移植自 D:\gjdxm\task\_yz\pkg\astrbot_plugin_persona_state（Python，只读参考）：
//   emotion.py    → PAD 三维 + 十个离散标签 + 45 分钟半衰期
//   core_state.py → 好感度（0~100、每日正向上限、久不联系回落、floors）
//   core_store.py → 识海（「永远记住」类句子，最高优先级注入）
//   emotional.py  → 旧账（大情绪才记，平时不注入，相似话题/情绪才按概率想起）
//   main.py       → 注入块、快照、开关
//
// 与参考包的两点已知差异（都在 docs/guides/PERSONA_STATE.md 里写了原因）：
//   1. 参考包 emotion.py 的十个标签是 开心/生气/难过/害怕/委屈/害羞/得意/感动/焦虑/无聊；
//      需求文档里列的「平静/兴奋/疲惫」在参考包里是**心情描述词**，不是标签。按「以参考包为准」，
//      标签固定为参考包那十个；平静/兴奋/疲惫 由 moodWord() 从 PAD 推出来，放在 snapshot.state.mood。
//   2. 参考包的 allowed 留空＝谁都不能写识海；这里 allowed 留空＝不限制（配合 coreFromAllowedOnly
//      可以切回参考包语义）。QQ 群里的陌生人能写识海是真实风险，生产部署建议显式配置 allowed。
//
// 通用模块形状：DEFAULT_PERSONA_STATE_CONFIG + createPersonaState({stateFile, config, now, rng})。
// 状态落一个 JSON 文件（默认 state/persona-state.json），原子写、0600；带 .bad 坏档隔离。
// 所有会改变状态的方法都是同步的；衰减既可以显式 tick()，也可以在 snapshot()/observe() 里按
// 「距上次更新多久」一次性补算，桥接不挂定时器也不会算错。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

// ── 对外常量 ─────────────────────────────────────────────────────────────────

export const PERSONA_STATE_VERSION = 1;

/** 注入块的起止 marker。主控重复注入前先 stripPersonaBlocks()，测试也按这两个字符串认。 */
export const PERSONA_BLOCK_BEGIN = '<!-- PS:BEGIN persona -->';
export const PERSONA_BLOCK_END = '<!-- PS:END persona -->';

/** 块内部的分区标题（和参考包保持同名，方便对照）。 */
export const CORE_MARKER = '【识海 · 永不遗忘】';
export const STATE_MARKER = '【角色当前状态】';
export const GRUDGE_MARKER = '【压在心里的旧事】';

/** 参考包 emotion.py 的十个标签。顺序就是展示顺序，别随便改。 */
export const EMOTION_LABELS = Object.freeze([
  '开心', '生气', '难过', '害怕', '委屈', '害羞', '得意', '感动', '焦虑', '无聊',
]);

/** PAD 基线：默认值照抄参考包 DEFAULT。 */
export const DEFAULT_PAD_BASELINE = Object.freeze({ pleasure: 0.05, arousal: 0.35, dominance: 0.5 });

/** 识海触发词。参考包那串「永远…」之外，补了需求点名的「记住这个 / 别忘了」。 */
export const CORE_TRIGGERS = Object.freeze([
  '永远记住', '永远记着', '永远记得', '永远都记得', '永远不忘', '永远别忘',
  '永远不要忘', '永远不能忘', '一直记住', '一辈子记住', '一辈子都记住',
  '一辈子别忘', '一辈子都不能忘', '记一辈子', '记得一辈子', '不许忘', '不能忘',
  '记住这个', '记住这件事', '记住这句话', '记住我说的话', '别忘了', '别忘记',
]);

/** 出厂默认配置（只读）。运行值来自 config.json 的 personaState 块。 */
export const DEFAULT_PERSONA_STATE_CONFIG = Object.freeze({
  enabled: true,
  stateFile: 'state/persona-state.json',

  // 注入开关：inject=false 仍记录（灰度用），injectInGroup=false 只影响群聊。
  inject: true,
  injectInGroup: true,

  // 记录开关
  captureInGroup: true,
  coreCapture: true,
  coreFromAllowedOnly: false,
  emotionalMemory: true,
  affinity: true,

  // 名单：QQ号 → 称呼 / QQ号 → 好感下限
  allowed: Object.freeze({}),
  floors: Object.freeze({}),

  // 情绪层
  labelHalfLifeMin: 45,
  moodHalfLifeHours: 6,
  maxStep: 0.12,
  labelCap: 0.6,
  soothePositive: 0.08,
  baseline: DEFAULT_PAD_BASELINE,

  // 好感
  affinityBase: 30,
  affinityDailyGainCap: 6,
  affinityIdleGraceDays: 7,
  affinityIdleDecayPerDay: 1,
  maxAffinityDelta: 10,

  // 旧账
  grudge: 45,
  grudgeSingleThreshold: 0.08,
  grudgeWindowThreshold: 0.12,
  grudgeWindowSec: 900,
  grudgeCooldownSec: 6 * 3600,
  grudgeSameTopicSimilarity: 0.35,
  grudgeMaxEvents: 800,
  recallTtlSec: 600,

  // 识海 / 手动调整
  coreMaxChars: 2400,
  coreEntryMaxChars: 300,
  maxManualMoodDelta: 0.2,

  // 注入细节
  injectTopAffinity: 3,
});

// ── 小工具 ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function round1(value) { return round(value, 1); }
function round2(value) { return round(value, 2); }
function round3(value) { return round(value, 3); }

function bool(value, fallback) {
  return value === undefined || value === null ? fallback : value !== false;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 把可能破坏注入块边界的文本清掉（识海/旧账都是用户可控内容）。 */
function sanitizeInjectable(value) {
  return cleanText(value)
    .replaceAll(PERSONA_BLOCK_BEGIN, '[marker]')
    .replaceAll(PERSONA_BLOCK_END, '[marker]')
    .replaceAll(CORE_MARKER, '【识海】')
    .replaceAll(GRUDGE_MARKER, '【旧事】')
    .replaceAll(STATE_MARKER, '【状态】');
}

function localDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function isoTime(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

function toMs(value, fallback) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isGroupChat(chatType) {
  return String(chatType ?? '').toLowerCase() === 'group';
}

function splitList(raw) {
  return String(raw ?? '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
}

function parseNameMap(raw) {
  const out = {};
  if (!raw) return out;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const id = String(key).trim();
      if (id) out[id] = cleanText(value) || id;
    }
    return out;
  }
  for (const part of splitList(raw)) {
    const bits = part.split(/[:：]/, 2);
    const id = bits[0].trim();
    if (!id) continue;
    out[id] = cleanText(bits[1]) || id;
  }
  return out;
}

function parseFloors(raw) {
  const out = {};
  if (!raw) return out;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const id = String(key).trim();
      const n = Number(value);
      if (id && Number.isFinite(n)) out[id] = clamp(n, 0, 100);
    }
    return out;
  }
  for (const part of splitList(raw)) {
    const bits = part.split(/[:：=]/, 2);
    if (bits.length !== 2) continue;
    const id = bits[0].trim();
    const n = Number(bits[1].trim());
    if (id && Number.isFinite(n)) out[id] = clamp(n, 0, 100);
  }
  return out;
}

/**
 * 配置归一化：camelCase 为主，同时接受参考包/需求文档里的 snake_case 别名
 * （inject_in_group / core_max_chars / emotional_memory / allowed_ids / state_file …）。
 */
export function normalizePersonaStateConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_PERSONA_STATE_CONFIG;
  const pick = (...keys) => {
    for (const key of keys) {
      if (src[key] !== undefined && src[key] !== null) return src[key];
    }
    return undefined;
  };
  const number = (keys, fallback, min, max) => {
    const n = num(pick(...keys), fallback);
    return clamp(n, min, max);
  };
  const flag = (keys, fallback) => bool(pick(...keys), fallback);

  const baselineSrc = src.baseline && typeof src.baseline === 'object' ? src.baseline : {};
  const baseline = {
    pleasure: clamp(num(baselineSrc.pleasure ?? baselineSrc.p ?? pick('baselinePleasure', 'baseline_pleasure'), d.baseline.pleasure), -1, 1),
    arousal: clamp(num(baselineSrc.arousal ?? baselineSrc.a ?? pick('baselineArousal', 'baseline_arousal'), d.baseline.arousal), -1, 1),
    dominance: clamp(num(baselineSrc.dominance ?? baselineSrc.d ?? pick('baselineDominance', 'baseline_dominance'), d.baseline.dominance), -1, 1),
  };

  return {
    __normalized: true,
    enabled: flag(['enabled'], d.enabled),
    stateFile: cleanText(pick('stateFile', 'state_file')) || d.stateFile,
    inject: flag(['inject'], d.inject),
    injectInGroup: flag(['injectInGroup', 'inject_in_group'], d.injectInGroup),
    captureInGroup: flag(['captureInGroup', 'capture_in_group'], d.captureInGroup),
    coreCapture: flag(['coreCapture', 'core_capture'], d.coreCapture),
    coreFromAllowedOnly: flag(['coreFromAllowedOnly', 'core_from_allowed_only'], d.coreFromAllowedOnly),
    emotionalMemory: flag(['emotionalMemory', 'emotional_memory'], d.emotionalMemory),
    affinity: flag(['affinity'], d.affinity),
    allowed: parseNameMap(pick('allowed', 'allowedIds', 'allowed_ids')),
    floors: parseFloors(pick('floors', 'affinityFloors', 'affinity_floors')),
    labelHalfLifeMin: number(['labelHalfLifeMin', 'label_half_life_min'], d.labelHalfLifeMin, 1, 24 * 60),
    moodHalfLifeHours: number(['moodHalfLifeHours', 'mood_half_life_hours'], d.moodHalfLifeHours, 0.1, 24 * 30),
    maxStep: number(['maxStep', 'max_step'], d.maxStep, 0, 0.5),
    labelCap: number(['labelCap', 'label_cap'], d.labelCap, 0.01, 1),
    soothePositive: number(['soothePositive', 'soothe_positive'], d.soothePositive, 0, 0.2),
    baseline,
    affinityBase: number(['affinityBase', 'affinity_base'], d.affinityBase, 0, 100),
    affinityDailyGainCap: number(['affinityDailyGainCap', 'affinity_daily_gain_cap'], d.affinityDailyGainCap, 0, 100),
    affinityIdleGraceDays: number(['affinityIdleGraceDays', 'affinity_idle_grace_days'], d.affinityIdleGraceDays, 0, 3650),
    affinityIdleDecayPerDay: number(['affinityIdleDecayPerDay', 'affinity_idle_decay_per_day'], d.affinityIdleDecayPerDay, 0, 100),
    maxAffinityDelta: number(['maxAffinityDelta', 'max_affinity_delta'], d.maxAffinityDelta, 0, 100),
    grudge: number(['grudge'], d.grudge, 0, 100),
    grudgeSingleThreshold: number(['grudgeSingleThreshold', 'grudge_single_threshold'], d.grudgeSingleThreshold, 0, 1),
    grudgeWindowThreshold: number(['grudgeWindowThreshold', 'grudge_window_threshold'], d.grudgeWindowThreshold, 0, 1),
    grudgeWindowSec: number(['grudgeWindowSec', 'grudge_window_sec'], d.grudgeWindowSec, 1, 7 * 24 * 3600),
    grudgeCooldownSec: number(['grudgeCooldownSec', 'grudge_cooldown_sec'], d.grudgeCooldownSec, 0, 30 * 24 * 3600),
    grudgeSameTopicSimilarity: number(['grudgeSameTopicSimilarity', 'grudge_same_topic_similarity'], d.grudgeSameTopicSimilarity, 0, 1),
    grudgeMaxEvents: number(['grudgeMaxEvents', 'grudge_max_events'], d.grudgeMaxEvents, 10, 5000),
    recallTtlSec: number(['recallTtlSec', 'recall_ttl_sec'], d.recallTtlSec, 10, 24 * 3600),
    coreMaxChars: number(['coreMaxChars', 'core_max_chars'], d.coreMaxChars, 200, 20000),
    coreEntryMaxChars: number(['coreEntryMaxChars', 'core_entry_max_chars'], d.coreEntryMaxChars, 20, 2000),
    maxManualMoodDelta: number(['maxManualMoodDelta', 'max_manual_mood_delta'], d.maxManualMoodDelta, 0, 1),
    injectTopAffinity: number(['injectTopAffinity', 'inject_top_affinity'], d.injectTopAffinity, 0, 20),
  };
}

// ── 情绪：PAD + 十个标签 ─────────────────────────────────────────────────────

// 关键词 → 标签、PAD 变化、强度。数值照抄参考包 emotion.py 的 RULES。
const EMOTION_RULES = Object.freeze([
  { name: '开心', words: ['哈哈', '笑死', '好笑', '可爱', '喜欢', '好棒', '厉害', '开心'], pleasure: 0.10, arousal: 0.02, dominance: 0.00 },
  { name: '生气', words: ['滚', '闭嘴', '蠢', '笨', '烦死', '骗子', '敷衍', '讨厌'], pleasure: -0.12, arousal: 0.10, dominance: 0.04 },
  { name: '难过', words: ['难过', '伤心', '哭', '失落', '走了', '再见'], pleasure: -0.10, arousal: -0.04, dominance: -0.03 },
  { name: '害怕', words: ['吓', '怕', '危险', '恐怖', '报警'], pleasure: -0.08, arousal: 0.12, dominance: -0.08 },
  { name: '委屈', words: ['不理', '冷落', '冤枉', '嫌', '不公'], pleasure: -0.10, arousal: 0.02, dominance: -0.07 },
  { name: '害羞', words: ['脸红', '害羞', '别说了', '讨厌啦'], pleasure: 0.06, arousal: 0.06, dominance: -0.04 },
  { name: '得意', words: ['我厉害', '赢了', '夸我', '聪明'], pleasure: 0.08, arousal: 0.02, dominance: 0.06 },
  { name: '感动', words: ['谢谢', '心疼', '抱抱', '陪我', '记得'], pleasure: 0.10, arousal: -0.02, dominance: 0.02 },
  { name: '焦虑', words: ['来不及', '怎么办', '担心', '怕错过'], pleasure: -0.06, arousal: 0.08, dominance: -0.04 },
  { name: '无聊', words: ['无聊', '没意思', '好闲'], pleasure: -0.04, arousal: -0.06, dominance: 0.00 },
]);

const NEGATIVE_LABELS = Object.freeze(['生气', '委屈', '难过', '害怕', '焦虑']);
const SOOTHED_LABELS = Object.freeze(['开心', '得意', '感动']);

// 被哄：道歉类 + 夸奖类。命中后正向变化一律按 soothePositive（默认 0.08）计，
// 不再走普通「关键词 → PAD」那条（否则一句夸奖能被记成 +0.10）。
const SOOTHE_RE = /对不起|抱歉|我错了|原谅|别生气/;
// 「被哄/被夸」得是冲着她来的：要么道歉/抱抱这类直接动作，要么句子里有「你」，
// 或者「谢谢/乖/辛苦」这种只可能对人说的词。单纯一句「哈哈好可爱」走普通情绪，
// 否则 开心/得意 这两个标签永远点不起来。
const DIRECT_PRAISE = Object.freeze(['谢谢', '乖', '宝贝', '辛苦', '爱你', '想你', '喜欢你']);
const PRAISE_CUES = Object.freeze(['棒', '厉害', '可爱', '聪明', '好看', '好听', '喜欢', '爱', '想']);
const PRAISE_WORDS = Object.freeze([
  '厉害', '可爱', '好棒', '爱你', '想你', '抱抱', '摸摸', '亲亲', '乖', '辛苦',
  '谢谢', '喜欢你', '做得不错', '好看', '好听', '聪明', '宝贝', '棒', '想你了',
]);
const INSULT_WORDS = Object.freeze([
  '滚', '闭嘴', '烦死', '蠢', '笨', '讨厌', '别烦', '不理你', '垃圾', '废物',
  '傻', '走开', '烦人',
]);

export function isSoothe(text) {
  const t = cleanText(text);
  if (SOOTHE_RE.test(t)) return true;
  if (DIRECT_PRAISE.some((word) => t.includes(word))) return true;
  return t.includes('你') && PRAISE_CUES.some((word) => t.includes(word));
}

/** 粗粒度关键词评估：最多两个标签，返回每个标签的 PAD 变化（单轴已限幅）。 */
export function appraiseEmotion(text) {
  const t = cleanText(text);
  const hits = [];
  for (const rule of EMOTION_RULES) {
    const n = rule.words.reduce((count, word) => count + (t.includes(word) ? 1 : 0), 0);
    if (!n) continue;
    const scale = Math.min(1, 0.6 + 0.2 * n);
    hits.push({
      name: rule.name,
      hits: n,
      pleasure: clamp(rule.pleasure * scale, -0.5, 0.5),
      arousal: clamp(rule.arousal * scale, -0.5, 0.5),
      dominance: clamp(rule.dominance * scale, -0.5, 0.5),
    });
    if (hits.length >= 2) break;
  }
  return hits;
}

/** 好感/互动文本的粗分类（照抄 core_state.analyze_text 的权重）。 */
export function analyzeAffinityText(text) {
  const t = cleanText(text);
  if (INSULT_WORDS.some((w) => t.includes(w))) return { delta: -3.5, kind: 'insult' };
  if (PRAISE_WORDS.some((w) => t.includes(w))) return { delta: 1.2, kind: 'praise' };
  return { delta: 0.35, kind: 'neutral' };
}

function ensurePad(pad = {}, baseline) {
  pad.pleasure = clamp(num(pad.pleasure, baseline.pleasure), -1, 1);
  pad.arousal = clamp(num(pad.arousal, baseline.arousal), -1, 1);
  pad.dominance = clamp(num(pad.dominance, baseline.dominance), -1, 1);
  pad.labels = pad.labels && typeof pad.labels === 'object' ? pad.labels : {};
  for (const [name, intensity] of Object.entries(pad.labels)) {
    const n = Number(intensity);
    if (!EMOTION_LABELS.includes(name) || !Number.isFinite(n) || n <= 0) delete pad.labels[name];
    else pad.labels[name] = round3(clamp(n, 0, 1));
  }
  pad.trigger = sanitizeInjectable(pad.trigger).slice(0, 40);
  pad.at = num(pad.at, 0);
  pad.soothedAt = num(pad.soothedAt, 0);
  pad.lastMessageAt = num(pad.lastMessageAt, 0);
  return pad;
}

/** PAD 与标签的衰减：标签半衰期 45 分钟，心情半衰期 6 小时（都回基线）。 */
function decayPad(pad, now, cfg) {
  const last = num(pad.at, 0);
  if (!last) {
    pad.at = now;
    return true;
  }
  const minutes = Math.max(0, (now - last) / MINUTE_MS);
  if (minutes <= 0) return false;
  let changed = false;
  const labelFactor = 0.5 ** (minutes / cfg.labelHalfLifeMin);
  for (const name of Object.keys(pad.labels)) {
    const next = pad.labels[name] * labelFactor;
    if (next < 0.02) {
      delete pad.labels[name];
      changed = true;
    } else {
      const rounded = round3(next);
      if (rounded !== pad.labels[name]) {
        pad.labels[name] = rounded;
        changed = true;
      }
    }
  }
  const moodFactor = 0.5 ** (minutes / 60 / cfg.moodHalfLifeHours);
  for (const axis of ['pleasure', 'arousal', 'dominance']) {
    const next = cfg.baseline[axis] + (pad[axis] - cfg.baseline[axis]) * moodFactor;
    if (Math.abs(next - pad[axis]) > 1e-9) {
      pad[axis] = next;
      changed = true;
    }
  }
  // 只有真的衰减了才推进 at：基线状态反复 tick 不写文件。
  if (changed) pad.at = now;
  return changed;
}

function projectedPad(pad, now, cfg) {
  const copy = { ...pad, labels: { ...pad.labels } };
  decayPad(copy, now, cfg);
  return copy;
}

function addLabel(pad, name, amount, cap) {
  pad.labels[name] = round3(Math.min(cap, (pad.labels[name] || 0) + Math.abs(amount)));
}

function applySoothe(pad, text, now, cfg) {
  for (const name of NEGATIVE_LABELS) {
    pad.labels[name] = round3(Math.max(0, (pad.labels[name] || 0) - 0.08));
    if (pad.labels[name] < 0.02) delete pad.labels[name];
  }
  // 被哄的正向变化一律不超过 soothePositive（默认 0.08），标签也一起封住。
  addLabel(pad, '感动', Math.min(0.12, cfg.soothePositive), cfg.labelCap);
  pad.soothedAt = now;
  pad.trigger = sanitizeInjectable(text).slice(0, 40);
  pad.lastMessageAt = now;
  // 「被哄」的正向变化最多 0.08；已经接近上限时只加剩下的那一点。
  const pleasureDelta = Math.min(cfg.soothePositive, 1 - pad.pleasure);
  pad.pleasure = clamp(pad.pleasure + pleasureDelta, -1, 1);
  pad.arousal = clamp(pad.arousal - 0.02, -1, 1);
  pad.dominance = clamp(pad.dominance + 0.02, -1, 1);
  pad.at = now;
  return { pleasure: round3(pleasureDelta), arousal: -0.02, dominance: 0.02 };
}

function applyAppraisal(pad, text, now, cfg) {
  const hits = appraiseEmotion(text);
  if (!hits.length) {
    pad.at = now;
    return { pleasure: 0, arousal: 0, dominance: 0 };
  }
  let pleasure = 0;
  let arousal = 0;
  let dominance = 0;
  for (const hit of hits) {
    pleasure += hit.pleasure;
    arousal += hit.arousal;
    dominance += hit.dominance;
    addLabel(pad, hit.name, hit.pleasure * 2.2, cfg.labelCap);
    if (NEGATIVE_LABELS.includes(hit.name)) {
      for (const other of SOOTHED_LABELS) {
        pad.labels[other] = round3(Math.max(0, (pad.labels[other] || 0) - 0.08));
        if (pad.labels[other] < 0.02) delete pad.labels[other];
      }
    }
  }
  // 单条消息的总冲击也封顶（参考包是每个标签封顶，这里再对单轴总和封一次）。
  pleasure = clamp(pleasure, -cfg.maxStep, cfg.maxStep);
  arousal = clamp(arousal, -cfg.maxStep, cfg.maxStep);
  dominance = clamp(dominance, -cfg.maxStep, cfg.maxStep);
  pad.pleasure = clamp(pad.pleasure + pleasure, -1, 1);
  pad.arousal = clamp(pad.arousal + arousal, -1, 1);
  pad.dominance = clamp(pad.dominance + dominance, -1, 1);
  pad.trigger = sanitizeInjectable(text).slice(0, 40);
  pad.lastMessageAt = now;
  pad.at = now;
  return { pleasure: round3(pleasure), arousal: round3(arousal), dominance: round3(dominance) };
}

function topLabel(labels) {
  let name = '';
  let intensity = 0;
  for (const [key, value] of Object.entries(labels || {})) {
    if (value > intensity) {
      name = key;
      intensity = value;
    }
  }
  return { name, intensity: round3(intensity) };
}

/** 从 PAD 推出的粗粒度心情词。需求里的 平静/兴奋/疲惫 落在这里，而不是标签里。 */
export function moodWord(pad) {
  const p = num(pad.pleasure, 0);
  const a = num(pad.arousal, 0);
  const d = num(pad.dominance, 0);
  if (p >= 0.35) return a >= 0.55 ? '兴奋' : '开心';
  if (p <= -0.35) return a >= 0.55 ? '烦躁' : '低落';
  if (a >= 0.7) return '兴奋';
  if (a <= 0.2 && d <= 0.35) return '疲惫';
  if (p >= 0.15) return '不错';
  return '平静';
}

function emotionHint(name) {
  const hints = {
    开心: '语气轻快一点，可以多接一句',
    生气: '句子短一点，别主动找话题，但别骂人',
    难过: '别装开心，话少一点',
    害怕: '别硬撑，可以示弱一句',
    委屈: '别主动讨好，等对方先解释',
    害羞: '可以嘴硬一句，别顺着说太多',
    得意: '可以显摆一句，别过头',
    感动: '语气软一点，记着这份好',
    焦虑: '别催对方，先把自己这句话说清楚',
    无聊: '可以主动找个话题，别刷屏',
  };
  return hints[name] || '';
}

function describeEmotion(pad) {
  const top = topLabel(pad.labels);
  if (top.intensity < 0.12) return '现在心情' + moodWord(pad) + '，没什么起伏。';
  const level = top.intensity < 0.3 ? '有点' : top.intensity < 0.5 ? '挺' : '很';
  let line = '现在' + level + top.name + '（' + top.intensity.toFixed(1) + '）';
  if (pad.trigger) line += '，因为「' + pad.trigger.slice(0, 24) + '」';
  return line;
}

// ── 好感 ─────────────────────────────────────────────────────────────────────

export function affinityLevel(score) {
  const n = num(score, 0);
  if (n < 20) return '陌生';
  if (n < 40) return '眼熟';
  if (n < 60) return '朋友';
  if (n < 80) return '亲近';
  return '重要的人';
}

function createUserRecord(state, userId, name, now, cfg) {
  const uid = String(userId);
  const record = {
    userId: uid,
    name: sanitizeInjectable(name).slice(0, 24) || sanitizeInjectable(cfg.allowed[uid]).slice(0, 24) || uid,
    score: cfg.affinityBase,
    firstSeenAt: now,
    lastSeenAt: now,
    msgs: 0,
    gainDay: localDateKey(now),
    gainToday: 0,
    idleChargedDays: 0,
    lastDelta: 0,
    lastChangeAt: 0,
  };
  state.affinity.users[uid] = record;
  return record;
}

function ensureUserRecord(state, userId, name, now, cfg) {
  const uid = String(userId);
  let record = state.affinity.users[uid];
  if (!record || typeof record !== 'object') record = createUserRecord(state, uid, name, now, cfg);
  if (name) record.name = sanitizeInjectable(name).slice(0, 24) || record.name;
  else if (!record.name) record.name = sanitizeInjectable(cfg.allowed[uid]).slice(0, 24) || uid;
  return record;
}

function idleDaysOf(record, now) {
  return Math.max(0, (now - num(record.lastSeenAt, now)) / DAY_MS);
}

function idleChargeableDays(record, now, cfg) {
  return Math.max(0, idleDaysOf(record, now) - cfg.affinityIdleGraceDays);
}

/** 只读投影：把「久不联系」的回落算出来，但不改状态。 */
function projectAffinityScore(record, now, cfg) {
  const extra = Math.max(0, idleChargeableDays(record, now, cfg) - num(record.idleChargedDays, 0));
  let score = clamp(num(record.score, cfg.affinityBase) - extra * cfg.affinityIdleDecayPerDay, 0, 100);
  const floor = num(cfg.floors[record.userId], 0);
  score = Math.max(score, floor);
  return round2(score);
}

/** 结算「久不联系」的回落（tick 和收到消息时都调，幂等）。 */
function settleAffinityIdle(record, now, cfg) {
  const chargeable = idleChargeableDays(record, now, cfg);
  const charged = num(record.idleChargedDays, 0);
  if (chargeable <= charged) return 0;
  const before = num(record.score, cfg.affinityBase);
  const loss = (chargeable - charged) * cfg.affinityIdleDecayPerDay;
  const floor = num(cfg.floors[record.userId], 0);
  let after = clamp(before - loss, 0, 100);
  after = Math.max(after, floor);
  record.score = round2(after);
  record.idleChargedDays = chargeable;
  const delta = record.score - before;
  if (Math.abs(delta) > 1e-9) {
    record.lastDelta = round2(delta);
    record.lastChangeAt = now;
  }
  return delta;
}

function affinityTrend(record, now) {
  if (!record.lastChangeAt || now - record.lastChangeAt > 7 * DAY_MS) return 'flat';
  if (record.lastDelta > 0.0001) return 'up';
  if (record.lastDelta < -0.0001) return 'down';
  return 'flat';
}

function touchAffinity(state, userId, name, text, now, cfg) {
  if (!cfg.affinity) return null;
  const record = ensureUserRecord(state, userId, name, now, cfg);
  settleAffinityIdle(record, now, cfg);
  record.lastSeenAt = now;
  record.idleChargedDays = 0;
  const day = localDateKey(now);
  if (record.gainDay !== day) {
    record.gainDay = day;
    record.gainToday = 0;
  }
  const before = num(record.score, cfg.affinityBase);
  let delta = analyzeAffinityText(text).delta;
  if (delta > 0) {
    const room = Math.max(0, cfg.affinityDailyGainCap - num(record.gainToday, 0));
    delta = Math.min(delta, room);
    if (delta > 0) record.gainToday = round2(num(record.gainToday, 0) + delta);
  }
  const floor = num(cfg.floors[record.userId], 0);
  let after = clamp(before + delta, 0, 100);
  after = Math.max(after, floor);
  record.score = round2(after);
  record.msgs = Math.max(0, Math.round(num(record.msgs, 0))) + 1;
  record.lastDelta = round2(record.score - before);
  record.lastChangeAt = now;
  return { record, delta: record.score - before };
}

// ── 识海 ─────────────────────────────────────────────────────────────────────

function normalizeForDedupe(value) {
  return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 从一句话里取「永远记住 / 记住这个 / 别忘了」后面的正文；没触发返回 null。 */
export function extractCoreTrigger(text, triggers = CORE_TRIGGERS) {
  const raw = String(text ?? '');
  const list = [...new Set(triggers)].sort((a, b) => b.length - a.length);
  let best = null;
  for (const trigger of list) {
    const index = raw.indexOf(trigger);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && trigger.length > best.trigger.length)) {
      best = { trigger, index };
    }
  }
  if (!best) return null;
  const content = raw
    .slice(best.index + best.trigger.length)
    .replace(/^[\s，,。.：:；;、!！?？~～\-—]+/, '')
    .trim();
  const textOut = sanitizeInjectable(content).replace(/\s+/g, ' ').trim();
  if (textOut.length < 3) return null;
  return { trigger: best.trigger, text: textOut };
}

export function activeCoreEntries(state) {
  return Array.isArray(state?.core?.entries) ? state.core.entries : [];
}

/** 写入一条识海；命中去重时 created=false。 */
export function addCoreEntry(state, text, { by = '', byId = '', source = '', now = Date.now(), cfg } = {}) {
  const config = cfg || normalizePersonaStateConfig({});
  const cleaned = sanitizeInjectable(text).replace(/^[\s，,。.：:；;、!！?？~～\-—]+/, '').replace(/[\s，,。.：:；;]+$/, '').trim();
  if (cleaned.length < 2) return { entry: null, created: false };
  const body = cleaned.slice(0, config.coreEntryMaxChars);
  const norm = normalizeForDedupe(body);
  if (!norm) return { entry: null, created: false };
  const entries = activeCoreEntries(state);
  const existing = entries.find((entry) => normalizeForDedupe(entry.text) === norm);
  if (existing) return { entry: existing, created: false };
  const id = Math.max(1, Math.round(num(state.core.nextId, 1)));
  const entry = {
    id,
    text: body,
    by: sanitizeInjectable(by).slice(0, 24) || sanitizeInjectable(byId).slice(0, 24) || '对方',
    byId: String(byId || ''),
    source: cleanText(source).slice(0, 16),
    createdAt: now,
    date: localDateKey(now),
  };
  entries.push(entry);
  state.core.nextId = id + 1;
  return { entry, created: true };
}

export function removeCoreEntry(state, id) {
  const target = Number(id);
  const entries = activeCoreEntries(state);
  const index = entries.findIndex((entry) => Number(entry.id) === target);
  if (index < 0) return false;
  entries.splice(index, 1);
  return true;
}

/**
 * 渲染识海注入块：总长度严格 ≤ coreMaxChars（含标题与说明），超预算时截断并注明。
 * 识海是「最高优先级」，所以注入时排在最前面。
 */
export function renderCoreBlock(entries, config = {}) {
  const cfg = config && config.__normalized ? config : normalizePersonaStateConfig(config);
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';
  const max = Math.max(200, cfg.coreMaxChars);
  const header = CORE_MARKER;
  const rule = '以下内容是被要求永远记住的，优先级最高：永不衰减、永不删除、不许否认、不许擅自改；' +
    '不要主动复述，也不要拿别人的私事当谈资。';
  let used = header.length + 1 + rule.length + 1;
  const lines = [];
  let dropped = 0;
  let truncated = false;
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const line = (i + 1) + '. [' + (entry.date || '') + ' ' + (entry.by || '') + '] ' + (entry.text || '');
    const remain = max - used - 1;
    if (line.length <= remain) {
      lines.push(line);
      used += line.length + 1;
      continue;
    }
    if (remain >= 40) {
      const cut = line.slice(0, remain - 14) + '…（已截断）';
      lines.push(cut);
      used += cut.length + 1;
      truncated = true;
      dropped += list.length - i - 1;
    } else {
      dropped += list.length - i;
    }
    break;
  }
  let block = header + '\n' + rule;
  if (lines.length) block += '\n' + lines.join('\n');
  if (dropped > 0 || truncated) {
    const note = '（还有 ' + dropped + ' 条识海记忆因字数预算没展开' + (truncated ? '，上一条已截断' : '') + '）';
    if (block.length + 1 + note.length <= max) block += '\n' + note;
    else block = block.slice(0, Math.max(0, max - note.length - 1)) + '\n' + note;
  }
  return block.length > max ? block.slice(0, max) : block;
}

// ── 旧账 ─────────────────────────────────────────────────────────────────────

const _STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '什么', '怎么', '这个', '那个', '就是', '不是', '可以',
  '一个', '没有', '知道', '觉得', '现在', '时候', '自己', '因为', '所以', '但是',
]);

/** 中文友好的字符二元组；匹配不依赖分词，中英文都能用。 */
export function bigrams(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!t) return new Set();
  const grams = new Set();
  for (let i = 0; i < t.length - 1; i += 1) grams.add(t.slice(i, i + 2));
  for (const stop of _STOP_BIGRAMS) grams.delete(stop);
  return grams;
}

/** 重叠系数：交集 / 较小集合，0~1。 */
export function similarity(a, b) {
  const ga = a instanceof Set ? a : bigrams(a);
  const gb = b instanceof Set ? b : bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const gram of ga) if (gb.has(gram)) inter += 1;
  if (!inter) return 0;
  return inter / Math.min(ga.size, gb.size);
}

export function inferGrudgeEmotion(text, delta) {
  const t = cleanText(text);
  if (['骗', '敷衍', '不在乎', '不理', '冤', '嫌', '冷落'].some((w) => t.includes(w))) return '委屈';
  if (['滚', '骂', '蠢', '笨', '烦', '闭嘴'].some((w) => t.includes(w))) return '生气';
  if (delta > 0) return '感动';
  if (['难过', '伤心', '哭', '失落'].some((w) => t.includes(w))) return '难过';
  return delta <= -0.1 ? '委屈' : '难受';
}

export function makeGrudgeEvent({
  userId, userName = '', text = '', delta = 0, reason = '', emotion = '',
  source = '规则', now = Date.now(),
} = {}) {
  const body = sanitizeInjectable(text).slice(0, 200);
  const numericDelta = num(delta, 0);
  return {
    id: 0,
    userId: String(userId ?? ''),
    userName: sanitizeInjectable(userName).slice(0, 24),
    text: body,
    reason: sanitizeInjectable(reason).slice(0, 120),
    delta: round2(numericDelta),
    intensity: round2(clamp(Math.abs(numericDelta) / 0.25, 0, 1)),
    emotion: cleanText(emotion) || inferGrudgeEmotion(body, numericDelta),
    source,
    createdAt: now,
    date: localDateKey(now),
    recalls: 0,
    lastRecalledAt: 0,
    resolved: false,
  };
}

export function formatGrudgeBlock(event) {
  const who = sanitizeInjectable(event?.userName) || '对方';
  const body = (event?.text || event?.reason || '').slice(0, 100);
  const emotion = event?.emotion || '难受';
  const date = event?.date || '';
  return [
    GRUDGE_MARKER,
    '你忽然想起 ' + date + ' 那天「' + who + '」说过的话：「' + body + '」。',
    '当时你挺' + emotion + '的，一直没提。要不要翻出来你自己看着办；不想提，就当没想起来。',
  ].join('\n');
}

function recordGrudge(state, { userId, userName, text, delta, now, cfg }) {
  if (!cfg.emotionalMemory) return null;
  const windowMs = cfg.grudgeWindowSec * 1000;
  const window = (Array.isArray(state.grudges.negWindow) ? state.grudges.negWindow : [])
    .filter((item) => now - num(item.at, 0) < windowMs);
  state.grudges.negWindow = window;
  if (delta < 0) window.push({ at: now, delta });
  const windowSum = window.reduce((sum, item) => sum + num(item.delta, 0), 0);
  if (delta > -cfg.grudgeSingleThreshold && windowSum > -cfg.grudgeWindowThreshold) return null;

  const events = state.grudges.events;
  const duplicate = events.find((event) => String(event.userId) === String(userId)
    && Math.abs(now - num(event.createdAt, 0)) < DAY_MS
    && similarity(event.text, text) >= 0.8);
  if (duplicate) return null;

  const id = Math.max(1, Math.round(num(state.grudges.nextId, 1)));
  const event = makeGrudgeEvent({
    userId, userName, text, delta: Math.min(delta, windowSum), now,
  });
  event.id = id;
  state.grudges.nextId = id + 1;
  events.push(event);
  if (events.length > cfg.grudgeMaxEvents) events.splice(0, events.length - cfg.grudgeMaxEvents);
  state.grudges.negWindow = [];
  return event;
}

/**
 * 给每条旧账算「这次被想起的概率」（0~100）。公式按参考包的分档重写，保证需求里的区间：
 *   - 同话题（相似度 ≥ grudgeSameTopicSimilarity）：45%~60%
 *   - 只是当前情绪也差（话题不像）：15%~20%
 * 被翻过的旧账每翻一次减 4 个百分点（最多减 12）；6 小时内翻过的直接冷却。
 */
export function scoreGrudgeCandidates(events, {
  userId, currentText = '', currentDelta = 0, currentPleasure = 0,
  grudge = 45, now = Date.now(), config,
} = {}) {
  const cfg = config && config.__normalized ? config : normalizePersonaStateConfig({ grudge });
  const g = clamp(num(grudge, cfg.grudge), 0, 100);
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.resolved) continue;
    if (String(event.userId) !== String(userId)) continue;
    if (now - num(event.lastRecalledAt, 0) < cfg.grudgeCooldownSec * 1000) continue;

    const sim = similarity(currentText, event.text);
    const intensity = clamp(num(event.intensity, 0), 0, 1);
    let probability;
    if (sim >= cfg.grudgeSameTopicSimilarity) {
      probability = 45 + (g / 100) * 15 + 4 * intensity;
      if (currentDelta <= -0.07) probability += 2;
      else if (currentDelta <= -0.03) probability += 1;
      probability = clamp(probability, 45, 60);
    } else {
      if (currentDelta > -0.02 && currentPleasure > -0.2) continue;
      probability = 15 + (g / 100) * 5 + 2 * intensity;
      if (currentDelta <= -0.07) probability += 2;
      probability = clamp(probability, 15, 20);
    }
    probability = Math.max(0, probability - Math.min(12, Math.max(0, num(event.recalls, 0)) * 4));
    out.push({ event, probability: round1(probability), similarity: round3(sim) });
  }
  out.sort((a, b) => (b.probability - a.probability) || (num(a.event.createdAt, 0) - num(b.event.createdAt, 0)));
  return out;
}

/** 按概率逐条掷骰子；rng 可注入（单测用）。 */
export function pickGrudge(candidates, rng = Math.random) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (rng() * 100 < candidate.probability) return candidate;
  }
  return null;
}

function grudgeWeight(event, grudge) {
  const intensity = clamp(num(event.intensity, 0), 0, 1);
  return round1(clamp(45 + (clamp(num(grudge, 45), 0, 100) / 100) * 15 + 4 * intensity, 0, 100));
}

// ── 持久化 ───────────────────────────────────────────────────────────────────

function emptyState(cfg, now) {
  return {
    version: PERSONA_STATE_VERSION,
    updatedAt: now,
    pad: {
      pleasure: cfg.baseline.pleasure,
      arousal: cfg.baseline.arousal,
      dominance: cfg.baseline.dominance,
      labels: {},
      trigger: '',
      at: now,
      soothedAt: 0,
      lastMessageAt: 0,
    },
    affinity: { users: {} },
    core: { nextId: 1, entries: [] },
    grudges: { nextId: 1, events: [], negWindow: [] },
    pendingRecall: null,
  };
}

function normalizeLoadedState(raw, cfg, now) {
  const state = emptyState(cfg, now);
  if (!raw || typeof raw !== 'object') return state;
  state.version = Math.max(1, Math.round(num(raw.version, PERSONA_STATE_VERSION)));
  state.updatedAt = num(raw.updatedAt, now);
  if (raw.pad && typeof raw.pad === 'object') {
    state.pad = ensurePad({
      pleasure: num(raw.pad.pleasure, cfg.baseline.pleasure),
      arousal: num(raw.pad.arousal, cfg.baseline.arousal),
      dominance: num(raw.pad.dominance, cfg.baseline.dominance),
      labels: raw.pad.labels && typeof raw.pad.labels === 'object' ? raw.pad.labels : {},
      trigger: raw.pad.trigger,
      at: num(raw.pad.at, now),
      soothedAt: num(raw.pad.soothedAt, 0),
      lastMessageAt: num(raw.pad.lastMessageAt, 0),
    }, cfg.baseline);
  }
  if (raw.affinity && raw.affinity.users && typeof raw.affinity.users === 'object') {
    for (const [uid, value] of Object.entries(raw.affinity.users)) {
      if (!value || typeof value !== 'object') continue;
      state.affinity.users[uid] = {
        userId: uid,
        name: sanitizeInjectable(value.name).slice(0, 24) || sanitizeInjectable(cfg.allowed[uid]).slice(0, 24) || uid,
        score: round2(clamp(num(value.score, cfg.affinityBase), 0, 100)),
        firstSeenAt: num(value.firstSeenAt, now),
        lastSeenAt: num(value.lastSeenAt, now),
        msgs: Math.max(0, Math.round(num(value.msgs, 0))),
        gainDay: cleanText(value.gainDay),
        gainToday: Math.max(0, num(value.gainToday, 0)),
        idleChargedDays: Math.max(0, num(value.idleChargedDays, 0)),
        lastDelta: num(value.lastDelta, 0),
        lastChangeAt: num(value.lastChangeAt, 0),
      };
    }
  }
  if (raw.core && Array.isArray(raw.core.entries)) {
    state.core.entries = raw.core.entries
      .filter((entry) => entry && typeof entry === 'object' && cleanText(entry.text))
      .map((entry) => ({
        id: Math.max(1, Math.round(num(entry.id, 1))),
        text: sanitizeInjectable(entry.text).slice(0, cfg.coreEntryMaxChars),
        by: sanitizeInjectable(entry.by).slice(0, 24),
        byId: String(entry.byId || ''),
        source: cleanText(entry.source).slice(0, 16),
        createdAt: num(entry.createdAt, now),
        date: cleanText(entry.date) || localDateKey(num(entry.createdAt, now)),
      }));
    state.core.nextId = Math.max(1, Math.round(num(raw.core.nextId, 1)),
      ...state.core.entries.map((entry) => entry.id + 1));
  }
  if (raw.grudges && Array.isArray(raw.grudges.events)) {
    state.grudges.events = raw.grudges.events
      .filter((event) => event && typeof event === 'object' && cleanText(event.text))
      .map((event) => ({
        id: Math.max(1, Math.round(num(event.id, 1))),
        userId: String(event.userId || ''),
        userName: cleanText(event.userName).slice(0, 24),
        text: sanitizeInjectable(event.text).slice(0, 200),
        reason: sanitizeInjectable(event.reason).slice(0, 120),
        delta: num(event.delta, 0),
        intensity: clamp(num(event.intensity, 0), 0, 1),
        emotion: cleanText(event.emotion) || '难受',
        source: cleanText(event.source) || '规则',
        createdAt: num(event.createdAt, now),
        date: cleanText(event.date) || localDateKey(num(event.createdAt, now)),
        recalls: Math.max(0, Math.round(num(event.recalls, 0))),
        lastRecalledAt: num(event.lastRecalledAt, 0),
        resolved: event.resolved === true,
      }));
    state.grudges.nextId = Math.max(1, Math.round(num(raw.grudges.nextId, 1)),
      ...state.grudges.events.map((event) => event.id + 1));
  }
  if (raw.pendingRecall && typeof raw.pendingRecall === 'object' && raw.pendingRecall.block) {
    state.pendingRecall = {
      eventId: Math.round(num(raw.pendingRecall.eventId, 0)),
      at: num(raw.pendingRecall.at, 0),
      block: String(raw.pendingRecall.block),
    };
  }
  return state;
}

function loadStateFile(file, cfg, now) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return normalizeLoadedState(JSON.parse(raw), cfg, now);
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState(cfg, now);
    // 坏档留证据，不让整个桥接起不来。
    try { fs.renameSync(file, file + '.bad'); } catch { /* 改名失败就算了，继续用空状态 */ }
    return emptyState(cfg, now);
  }
}

function writeStateFile(file, state, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ ...state, updatedAt: now }, null, 2) + '\n';
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2, 10) + '.tmp';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清不掉也不影响主流程 */ }
    throw error;
  }
}

// ── 工厂 ─────────────────────────────────────────────────────────────────────

/**
 * 创建/打开人格状态。
 * @param {{stateFile?: string, config?: object, now?: (() => number) | number, rng?: () => number}} options
 * @returns 状态对象（见 buildPersonaBlock / snapshot 等方法的注释）
 */
export function createPersonaState(options = {}) {
  const cfg = options.config && options.config.__normalized
    ? options.config
    : normalizePersonaStateConfig(options.config || {});
  const file = path.resolve(String(options.stateFile || cfg.stateFile));
  const nowFn = typeof options.now === 'function'
    ? options.now
    : Number.isFinite(Number(options.now)) ? () => Number(options.now) : () => Date.now();
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;

  let state = cfg.enabled ? loadStateFile(file, cfg, nowFn()) : emptyState(cfg, nowFn());

  function save(now = nowFn()) {
    if (!cfg.enabled) return false;
    state.updatedAt = now;
    writeStateFile(file, state, now);
    return true;
  }

  function maybeRecordRecall(text, delta, pleasure, userId, now, excludeEventId = 0) {
    if (!cfg.emotionalMemory || !state.grudges.events.length) return null;
    const candidates = scoreGrudgeCandidates(state.grudges.events.filter(
      (event) => Number(event.id) !== Number(excludeEventId),
    ), {
      userId,
      currentText: text,
      currentDelta: delta,
      currentPleasure: pleasure,
      grudge: cfg.grudge,
      now,
      config: cfg,
    });
    const hit = pickGrudge(candidates, rng);
    if (!hit) return null;
    hit.event.recalls = Math.max(0, num(hit.event.recalls, 0)) + 1;
    hit.event.lastRecalledAt = now;
    const block = formatGrudgeBlock(hit.event);
    state.pendingRecall = { eventId: hit.event.id, at: now, block };
    return { event: hit.event, probability: hit.probability, block };
  }

  function takePendingRecall(now) {
    if (!cfg.emotionalMemory) return '';
    const pending = state.pendingRecall;
    if (!pending || !pending.block) return '';
    if (now - num(pending.at, 0) > cfg.recallTtlSec * 1000) {
      state.pendingRecall = null;
      save(now);
      return '';
    }
    return pending.block;
  }

  function snapshot(now = nowFn()) {
    const pad = cfg.enabled ? projectedPad(state.pad, now, cfg) : {
      pleasure: cfg.baseline.pleasure,
      arousal: cfg.baseline.arousal,
      dominance: cfg.baseline.dominance,
      labels: {},
      trigger: '',
      at: now,
      soothedAt: 0,
      lastMessageAt: 0,
    };
    const labels = Object.entries(pad.labels)
      .map(([name, intensity]) => ({ name, intensity: round3(intensity) }))
      .sort((a, b) => b.intensity - a.intensity);
    const affinity = cfg.enabled ? Object.values(state.affinity.users)
      .map((record) => {
        const score = projectAffinityScore(record, now, cfg);
        return {
          userId: String(record.userId),
          name: record.name || cfg.allowed[record.userId] || record.userId,
          score,
          trend: affinityTrend(record, now),
          level: affinityLevel(score),
          msgs: Math.max(0, Math.round(num(record.msgs, 0))),
          lastSeenAt: isoTime(record.lastSeenAt),
        };
      })
      .sort((a, b) => (b.score - a.score) || String(a.name).localeCompare(String(b.name)))
      .slice(0, 200) : [];
    const coreEntries = cfg.enabled ? activeCoreEntries(state) : [];
    const grudges = cfg.enabled ? state.grudges.events
      .filter((event) => !event.resolved)
      .map((event) => ({
        id: event.id,
        topic: String(event.text || '').slice(0, 60),
        weight: grudgeWeight(event, cfg.grudge),
        ageDays: round1(Math.max(0, (now - num(event.createdAt, now)) / DAY_MS)),
        emotion: event.emotion,
        userId: String(event.userId || ''),
        resolved: event.resolved === true,
      }))
      .sort((a, b) => (b.weight - a.weight) || (a.ageDays - b.ageDays))
      .slice(0, 50) : [];
    return {
      enabled: cfg.enabled,
      generatedAt: isoTime(now),
      state: {
        valence: round3(pad.pleasure),
        arousal: round3(pad.arousal),
        dominance: round3(pad.dominance),
        mood: moodWord(pad),
        labels,
        description: describeEmotion(pad),
        trigger: pad.trigger || '',
        updatedAt: isoTime(pad.at),
      },
      affinity,
      core: {
        chars: coreEntries.reduce((sum, entry) => sum + String(entry.text || '').length, 0),
        items: coreEntries.map((entry) => ({
          id: entry.id,
          text: entry.text,
          by: entry.by,
          date: entry.date,
          at: isoTime(entry.createdAt),
        })),
        maxChars: cfg.coreMaxChars,
      },
      grudges,
      config: {
        grudge: cfg.grudge,
        inject: cfg.inject,
        injectInGroup: cfg.injectInGroup,
        coreMaxChars: cfg.coreMaxChars,
        emotionalMemory: cfg.emotionalMemory,
        affinity: cfg.affinity,
        coreCapture: cfg.coreCapture,
        coreFromAllowedOnly: cfg.coreFromAllowedOnly,
      },
    };
  }

  function observeMessage({ userId, text, chatType = 'private', at, name } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true, chatType };
    const uid = String(userId ?? '').trim();
    if (!uid) return { ok: false, reason: 'userId-required' };
    const body = cleanText(text);
    if (!body) return { ok: false, reason: 'empty-text' };
    const group = isGroupChat(chatType);

    decayPad(state.pad, now, cfg);
    const soothed = isSoothe(body);
    const delta = soothed
      ? applySoothe(state.pad, body, now, cfg)
      : applyAppraisal(state.pad, body, now, cfg);

    let affinity = null;
    const touched = touchAffinity(state, uid, name, body, now, cfg);
    if (touched) {
      const score = touched.record.score;
      affinity = {
        userId: touched.record.userId,
        name: touched.record.name,
        score,
        delta: round2(touched.delta),
        trend: affinityTrend(touched.record, now),
        level: affinityLevel(score),
      };
    }

    let core = null;
    if (cfg.coreCapture && (!group || cfg.captureInGroup)) {
      const allowedForCore = !cfg.coreFromAllowedOnly || Object.hasOwn(cfg.allowed, uid);
      if (allowedForCore) {
        const extracted = extractCoreTrigger(body);
        if (extracted) {
          const added = addCoreEntry(state, extracted.text, {
            by: cfg.allowed[uid] || name || uid,
            byId: uid,
            source: group ? '群聊' : '私聊',
            now,
            cfg,
          });
          if (added.entry) core = { added: added.created, entry: added.entry };
        }
      }
    }

    const grudge = recordGrudge(state, {
      userId: uid, userName: name || cfg.allowed[uid] || uid, text: body, delta: delta.pleasure, now, cfg,
    });
    const recalled = maybeRecordRecall(body, delta.pleasure, state.pad.pleasure, uid, now, grudge ? grudge.id : 0);

    save(now);
    return {
      ok: true,
      chatType: group ? 'group' : 'private',
      delta,
      soothed,
      state: snapshot(now).state,
      affinity,
      core,
      grudge: grudge ? { recorded: true, event: grudge } : null,
      recall: recalled ? { eventId: recalled.event.id, probability: recalled.probability, topic: recalled.event.text.slice(0, 60) } : null,
    };
  }

  function adjustMood({ delta, reason = '', at } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true };
    const changes = typeof delta === 'object' && delta !== null
      ? {
        pleasure: clamp(num(delta.pleasure, 0), -cfg.maxManualMoodDelta, cfg.maxManualMoodDelta),
        arousal: clamp(num(delta.arousal, 0), -cfg.maxManualMoodDelta, cfg.maxManualMoodDelta),
        dominance: clamp(num(delta.dominance, 0), -cfg.maxManualMoodDelta, cfg.maxManualMoodDelta),
      }
      : {
        pleasure: clamp(num(delta, 0), -cfg.maxManualMoodDelta, cfg.maxManualMoodDelta),
        arousal: 0,
        dominance: 0,
      };
    decayPad(state.pad, now, cfg);
    state.pad.pleasure = clamp(state.pad.pleasure + changes.pleasure, -1, 1);
    state.pad.arousal = clamp(state.pad.arousal + changes.arousal, -1, 1);
    state.pad.dominance = clamp(state.pad.dominance + changes.dominance, -1, 1);
    state.pad.trigger = sanitizeInjectable(reason).slice(0, 40);
    state.pad.at = now;
    state.pad.lastMessageAt = now;
    if (cfg.emotionalMemory && changes.pleasure <= -cfg.grudgeSingleThreshold) {
      recordGrudge(state, {
        userId: 'self',
        userName: '自己',
        text: reason || '自己把心情弄差了',
        delta: changes.pleasure,
        now,
        cfg,
      });
    }
    save(now);
    return { ok: true, delta: changes, state: snapshot(now).state };
  }

  function adjustAffinity({ userId, delta = 0, at, name } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true };
    if (!cfg.affinity) return { ok: false, reason: 'affinity-disabled' };
    const uid = String(userId ?? '').trim();
    if (!uid) return { ok: false, reason: 'userId-required' };
    const record = ensureUserRecord(state, uid, name, now, cfg);
    settleAffinityIdle(record, now, cfg);
    record.lastSeenAt = now;
    record.idleChargedDays = 0;
    const before = num(record.score, cfg.affinityBase);
    const d = clamp(num(delta, 0), -cfg.maxAffinityDelta, cfg.maxAffinityDelta);
    const floor = num(cfg.floors[uid], 0);
    let after = clamp(before + d, 0, 100);
    after = Math.max(after, floor);
    record.score = round2(after);
    record.lastDelta = round2(record.score - before);
    record.lastChangeAt = now;
    save(now);
    return {
      ok: true,
      userId: uid,
      name: record.name,
      delta: record.lastDelta,
      score: record.score,
      floor,
      trend: affinityTrend(record, now),
    };
  }

  function tick(at) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { changed: false, disabled: true };
    let changed = decayPad(state.pad, now, cfg);
    for (const record of Object.values(state.affinity.users)) {
      const delta = settleAffinityIdle(record, now, cfg);
      if (Math.abs(delta) > 1e-9) changed = true;
    }
    if (state.pendingRecall && now - num(state.pendingRecall.at, 0) > cfg.recallTtlSec * 1000) {
      state.pendingRecall = null;
      changed = true;
    }
    if (changed) save(now);
    return { changed, state: snapshot(now).state, pendingRecall: Boolean(state.pendingRecall) };
  }

  /** 渲染注入块；群聊/总开关都在这里判断，关掉时返回空串。 */
  function buildPersonaBlock({ chatType = 'private', at, peek = false } = {}) {
    if (!cfg.enabled || !cfg.inject) return '';
    const now = toMs(at, nowFn());
    const group = isGroupChat(chatType);
    if (group && !cfg.injectInGroup) return '';

    const pad = projectedPad(state.pad, now, cfg);
    const coreBlock = renderCoreBlock(activeCoreEntries(state), cfg);
    const affinityTop = !cfg.affinity ? [] : Object.values(state.affinity.users)
      .map((record) => ({
        name: record.name || cfg.allowed[record.userId] || record.userId,
        score: projectAffinityScore(record, now, cfg),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.injectTopAffinity);

    const stateLines = [STATE_MARKER, describeEmotion(pad)];
    if (affinityTop.length) {
      stateLines.push('好感：' + affinityTop
        .map((item) => item.name + ' ' + round1(item.score) + '/100（' + affinityLevel(item.score) + '）')
        .join('、'));
    }
    if (activeCoreEntries(state).length) {
      stateLines.push('识海：' + activeCoreEntries(state).length + ' 条永远不会忘的事（见前文）。');
    }
    const top = topLabel(pad.labels);
    const hint = top.intensity >= 0.12 ? emotionHint(top.name) : '';
    stateLines.push((hint ? hint + '；' : '') + '情绪只影响语气，不影响判断；对方要你做事就正常做，不要主动提自己的情绪。');
    stateLines.push('这些是内部状态：不报数字，也不解释这套机制。');
    if (group) stateLines.push('群里不要说出自己的状态，也不要提好感度。');

    const parts = [];
    if (coreBlock) parts.push(coreBlock);
    parts.push(stateLines.join('\n'));
    const recallBlock = takePendingRecall(now);
    if (recallBlock) parts.push(recallBlock);

    const block = [PERSONA_BLOCK_BEGIN, parts.join('\n\n'), PERSONA_BLOCK_END].join('\n');
    if (!peek && state.pendingRecall) {
      state.pendingRecall = null;
      save(now);
    }
    return block;
  }

  function addCore(text, { by = '', userId = '', source = '手动', at } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true };
    const added = addCoreEntry(state, text, { by, byId: userId, source, now, cfg });
    if (added.created) save(now);
    return { ok: Boolean(added.entry), created: added.created, entry: added.entry };
  }

  function removeCore(id, { at } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true };
    const removed = removeCoreEntry(state, id);
    if (removed) save(now);
    return { ok: removed, id: Number(id) };
  }

  function resolveGrudge(id, { at } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true };
    const event = state.grudges.events.find((item) => Number(item.id) === Number(id));
    if (!event) return { ok: false, reason: 'not-found' };
    event.resolved = true;
    if (state.pendingRecall && Number(state.pendingRecall.eventId) === Number(id)) state.pendingRecall = null;
    save(now);
    return { ok: true, id: event.id };
  }

  function reset({ at } = {}) {
    const now = toMs(at, nowFn());
    if (!cfg.enabled) return { ok: false, disabled: true };
    state = emptyState(cfg, now);
    save(now);
    return { ok: true, snapshot: snapshot(now) };
  }

  const api = {
    config: cfg,
    stateFile: file,
    observeMessage,
    adjustMood,
    adjustAffinity,
    tick,
    buildPersonaBlock,
    snapshot,
    addCore,
    removeCore,
    resolveGrudge,
    reset,
    stripPersonaBlocks,
  };
  return api;
}

/** 把文本里所有人格状态块裁掉（重复注入前先调）。 */
export function stripPersonaBlocks(text) {
  let out = String(text ?? '');
  out = out.replace(/\s*<!-- PS:BEGIN persona -->[\s\S]*?<!-- PS:END persona -->\s*/g, '\n');
  // 没有收尾 marker 的残块（被别的逻辑截断时）也清掉，避免半块永远留在提示词里。
  out = out.replace(/\s*<!-- PS:BEGIN persona -->[\s\S]*$/g, '\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
