// ─────────────────────────────────────────────────────────────────────────────
// src/memory-procedural.js — 「程序记忆 / 技能」：把「做过、而且做成了」的一串流程
// 抽成可复用的步骤（任务名 + 步骤 + 用过几次 + 成功率），下次遇到相似的事直接照着做。
//
// 移植自 D:\gjdxm\task\_yz\pkg\astrbot_plugin_memory_brain\procedural.py。那版让模型
// 输出 JSON {task, steps, entities}，这一版是**纯启发式**：不调模型、不联网、不加依赖。
//
// 两个来源：
//   ① 已经整理好的 skill 记忆：文本形如「任务名：1. 第一步；2. 第二步」
//      （跟 procedural.py 的 to_text() 同一个格式，所以老数据能直接吃进来）。
//   ② 「做过一串事 + 被认可」的流程：在时间窗口里，最后一条是认可词
//      （好了/搞定/谢谢/OK…），前面至少两条是动作，就把它们拼成技能。
//
// 与 memory-brain 的边界：不写记忆库；输入是只读快照 {memories:[…]}；
// 只写自己的 state JSON（默认 state/memory-procedural.json），原子写。
//
// 给主控的调用节奏：每 12 条消息（或每 30 分钟）跑一次 extract()；
// 出站前用 match(用户这句话) 取 1~2 条步骤塞进提示词；
// 用完之后（她判断这次照做成了没有）调 use({name, ok}) 记一笔成功率。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

/** 技能 state 的结构版本。 */
export const MEMORY_PROCEDURAL_VERSION = 1;

export const DEFAULT_PROCEDURAL_CONFIG = Object.freeze({
  enabled: true,
  statePath: 'state/memory-procedural.json',
  // 一条技能至少几步、最多几步、每步多少字
  minSteps: 2,
  maxSteps: 6,
  maxStepChars: 30,
  maxNameChars: 20,
  // 「流程」来源：往前看几条记忆、时间窗口多长
  windowSize: 6,
  windowMs: 10 * 60 * 1000,
  // 名字相似度到这个值就算同一条技能（合并，不重复记）
  mergeSimilarity: 0.86,
  // 命中相似任务的门槛与返回条数
  matchMinScore: 0.34,
  matchLimit: 3,
  // 最多存多少条技能
  maxSkills: 200
});

// 认可词：只在**短消息**里认，否则一句闲聊里的「谢谢」会把无关动作拼成技能
const APPROVAL_RE = /(好了|可以了|成功了|成了|过了|对了|收到|谢谢|多谢|辛苦了|弄好了|搞定了|完成了|没问题|OK|ok|Ok)/;
// 动作词：判断一条记忆像不像「做了一件事」
const ACTION_RE = /(帮|做|改|修|装|配|重启|部署|发|查|写|建|删|清理|整理|导出|导入|测试|跑|开|关|设置|安装|下载|上传|备份|迁移|连|调|试|弄|搞定|处理|修好|换成)/;

// ── 基础小工具 ───────────────────────────────────────────────────────────────

function intOf(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
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

function clip(text, max) {
  const s = oneLine(text, max + 200);
  return s.length > max ? s.slice(0, Math.max(1, max - 1)).trim() + '…' : s;
}

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

/** 相似度用的归一化：小写、去掉空白与标点，只留 CJK 和字母数字。 */
function normalizeForSim(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffa-z0-9]+/g, '');
}

function bigrams(text) {
  const s = normalizeForSim(text);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

/**
 * 中文友好的相似度：二元组 Dice 系数（0~1）。
 * 跟 memory-brain 的 textSimilarity 同一个思路，这里就地实现一份，
 * 免得为了一个纯函数去 import 整个带 node:sqlite 的记忆库模块。
 */
export function skillSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const gram of A) if (B.has(gram)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

function hashOf(text) {
  let h = 2166136261;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ── 配置 ─────────────────────────────────────────────────────────────────────

export function normalizeProceduralConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_PROCEDURAL_CONFIG;
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
    minSteps: num(['minSteps', 'procedural_min_steps'], d.minSteps, 1, 10),
    maxSteps: num(['maxSteps', 'procedural_max_steps'], d.maxSteps, 2, 20),
    maxStepChars: num(['maxStepChars'], d.maxStepChars, 4, 120),
    maxNameChars: num(['maxNameChars'], d.maxNameChars, 4, 60),
    windowSize: num(['windowSize'], d.windowSize, 1, 30),
    windowMs: num(['windowMs'], d.windowMs, 1000, 24 * 3600 * 1000),
    mergeSimilarity: clamp(Number(src.mergeSimilarity ?? d.mergeSimilarity), 0.3, 1),
    matchMinScore: clamp(Number(src.matchMinScore ?? src.procedural_match_min_score ?? d.matchMinScore), 0, 1),
    matchLimit: num(['matchLimit'], d.matchLimit, 1, 10),
    maxSkills: num(['maxSkills'], d.maxSkills, 1, 5000)
  };
}

// ── 文本解析（纯函数，可单测）────────────────────────────────────────────────

/** 去掉「主人：」这类发言人前缀。 */
function stripSpeaker(text) {
  return oneLine(text, 600).replace(/^[^：:]{1,12}[：:]\s*/, '').trim();
}

/** 「1. 重启；2. 检查端口」→ ['重启','检查端口'] */
function splitSteps(body) {
  return String(body ?? '')
    .split(/[；;]|(?=\d+\s*[.、)])/)
    .map((step) => step.replace(/^\s*\d+\s*[.、)]\s*/, '').trim())
    .filter((step) => step.length >= 2)
    .slice(0, 12);
}

/**
 * 解析一条 skill 记忆。格式跟 procedural.py 的 to_text() 一致：
 *   「任务名：1. 第一步；2. 第二步」
 * @returns {{name:string, steps:string[]}|null}
 */
export function parseSkillText(text) {
  const raw = oneLine(text, 600);
  const match = raw.match(/^(.{2,60}?)[：:]\s*(.+)$/);
  if (!match) return null;
  const name = clip(match[1].replace(/^[-•·\s]+/, '').trim(), 40);
  const steps = splitSteps(match[2]).map((step) => clip(step, 60));
  if (!name || steps.length < 2) return null;
  return { name, steps };
}

function isApproval(text) {
  const s = oneLine(text, 200);
  if (!s || s.length > 40) return false;
  return APPROVAL_RE.test(s);
}

function taskNameOf(text, cfg) {
  let s = stripSpeaker(text);
  s = s.replace(/^(帮我|帮忙|请你|请|麻烦你|麻烦|给我|替我|可以帮我|能不能|能帮我)/, '').trim();
  const first = s.split(/[，。；！？,;!?]/)[0].trim().replace(/^(一下|把|将)/, '').trim();
  if (first.length < 3) return '';
  return clip(first, cfg.maxNameChars);
}

function stepOf(text, cfg) {
  let s = stripSpeaker(text);
  s = s.replace(/^(帮我|帮忙|请你|请|麻烦你|麻烦|给我|替我)/, '').trim();
  return clip(s, cfg.maxStepChars);
}

function normalizeMemoryRows(input) {
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
      createdAt: parseTime(row.createdAt ?? row.created_at, 0),
      importance: clamp(Number(row.importance ?? 0.5), 0, 1)
    });
  }
  return out;
}

// ── 抽取（纯函数，可单测）───────────────────────────────────────────────────

/**
 * 从一批记忆里抽技能候选（还没落库）。两个来源见文件头。
 * @returns {{key:string, name:string, steps:string[], source:string, sourceIds:any[], createdAt:number}[]}
 */
export function extractSkillsFromMemories(memories, config = {}, now = Date.now()) {
  const cfg = normalizeProceduralConfig(config);
  const rows = normalizeMemoryRows(memories).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const found = [];

  const push = (candidate) => {
    const key = normalizeForSim(candidate.name);
    if (!key) return;
    for (const item of found) {
      if (item.key === key || skillSimilarity(item.name, candidate.name) >= cfg.mergeSimilarity) {
        if (candidate.steps.length > item.steps.length) item.steps = candidate.steps.slice(0, cfg.maxSteps);
        item.sourceIds = Array.from(new Set([...item.sourceIds, ...candidate.sourceIds])).slice(0, 8);
        return;
      }
    }
    found.push({
      key,
      name: clip(candidate.name, cfg.maxNameChars),
      steps: candidate.steps.slice(0, cfg.maxSteps),
      source: candidate.source,
      sourceIds: candidate.sourceIds.slice(0, 8),
      createdAt: now
    });
  };

  // 来源①：已经整理好的 skill 记忆
  for (const row of rows) {
    if (row.kind !== 'skill') continue;
    const parsed = parseSkillText(row.text);
    if (!parsed) continue;
    push({ name: parsed.name, steps: parsed.steps, source: 'skill-memory', sourceIds: [row.id] });
  }

  // 来源②：一串动作 + 最后被认可
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind === 'skill' || !isApproval(row.text)) continue;
    const window = [];
    for (let j = i - 1; j >= 0 && window.length < cfg.windowSize; j -= 1) {
      const prev = rows[j];
      if (row.createdAt && prev.createdAt && row.createdAt - prev.createdAt > cfg.windowMs) break;
      window.unshift(prev);
    }
    const actions = window.filter((item) => item.kind !== 'reflection' && !isApproval(item.text) && ACTION_RE.test(item.text));
    if (actions.length < cfg.minSteps) continue;
    const steps = [];
    for (const action of actions) {
      const step = stepOf(action.text, cfg);
      if (!step) continue;
      if (steps.some((prev) => prev === step || prev.includes(step) || step.includes(prev))) continue;
      steps.push(step);
      if (steps.length >= cfg.maxSteps) break;
    }
    if (steps.length < cfg.minSteps) continue;
    const name = taskNameOf(actions[0].text, cfg);
    if (!name) continue;
    push({ name, steps, source: 'flow', sourceIds: actions.map((item) => item.id).concat(row.id) });
  }

  return found;
}

// ── 状态文件 ─────────────────────────────────────────────────────────────────

function emptyState() {
  return { version: MEMORY_PROCEDURAL_VERSION, skills: [], updatedAt: '' };
}

function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = oneLine(raw.name, 60);
  if (!name) return null;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((step) => oneLine(step, 120)).filter(Boolean).slice(0, 20);
  if (steps.length < 1) return null;
  const key = normalizeForSim(name);
  return {
    id: String(raw.id || 'sk_' + hashOf(key)),
    name,
    steps,
    uses: Math.max(0, Math.round(Number(raw.uses) || 0)),
    successes: Math.max(0, Math.round(Number(raw.successes) || 0)),
    failures: Math.max(0, Math.round(Number(raw.failures) || 0)),
    seen: Math.max(1, Math.round(Number(raw.seen) || 1)),
    source: String(raw.source ?? 'unknown'),
    sourceIds: (Array.isArray(raw.sourceIds) ? raw.sourceIds : []).slice(0, 8),
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? '')
  };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.version = Number(raw.version) || MEMORY_PROCEDURAL_VERSION;
  state.updatedAt = String(raw.updatedAt ?? '');
  for (const item of Array.isArray(raw.skills) ? raw.skills : []) {
    const record = normalizeSkill(item);
    if (record) state.skills.push(record);
  }
  return state;
}

/** 对外暴露的形状：去掉内部字段，补上 successRate。 */
function viewOf(skill) {
  return {
    id: skill.id,
    name: skill.name,
    steps: skill.steps.slice(),
    uses: skill.uses,
    successes: skill.successes,
    failures: skill.failures,
    successRate: skill.uses > 0 ? Number((skill.successes / skill.uses).toFixed(2)) : null,
    seen: skill.seen,
    source: skill.source,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt
  };
}

/** 名字/步骤跟任务描述的匹配分（0~1）：名字占 6 成，步骤占 3.5 成，用过且成功加成。 */
export function skillScore(query, skill) {
  const q = String(query ?? '').trim();
  if (!q) return 0;
  const nameSim = skillSimilarity(q, skill?.name);
  const stepSim = skillSimilarity(q, Array.isArray(skill?.steps) ? skill.steps.join(' ') : '');
  const usage = Math.min(0.08, (Number(skill?.uses) || 0) * 0.02);
  const rate = Number.isFinite(Number(skill?.uses)) && skill.uses > 0
    ? ((skill.successes || 0) / skill.uses) * 0.05
    : 0;
  return clamp(nameSim * 0.6 + stepSim * 0.35 + usage + rate, 0, 1);
}

/**
 * 创建程序记忆（技能）库。
 *
 * @param {{statePath?: string, config?: object, now?: () => number}} [options]
 */
export function createProceduralStore(options = {}) {
  const rawConfig = options.config && typeof options.config === 'object' ? options.config : options;
  const cfg = normalizeProceduralConfig(rawConfig);
  const statePath = path.resolve(String(options.statePath || cfg.statePath || DEFAULT_PROCEDURAL_CONFIG.statePath));
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
      warnings.push('读技能状态失败：' + (error?.message ?? error));
      return;
    }
    try {
      const parsed = normalizeState(JSON.parse(text));
      state.version = parsed.version;
      state.skills = parsed.skills;
      state.updatedAt = parsed.updatedAt;
    } catch (error) {
      warnings.push('技能状态不是合法 JSON（已忽略，按空状态继续）：' + (error?.message ?? error));
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
      warnings.push('写技能状态失败：' + (error?.message ?? error));
      return false;
    }
  }

  function findSkill(nameOrId) {
    const probe = String(nameOrId ?? '').trim();
    if (!probe) return null;
    const key = normalizeForSim(probe);
    const exact = state.skills.find((skill) => skill.id === probe || normalizeForSim(skill.name) === key);
    if (exact) return exact;
    let best = null;
    let bestScore = 0;
    for (const skill of state.skills) {
      const score = skillSimilarity(probe, skill.name);
      if (score > bestScore) { best = skill; bestScore = score; }
    }
    return bestScore >= 0.8 ? best : null;
  }

  function trimSkills() {
    if (state.skills.length <= cfg.maxSkills) return 0;
    state.skills.sort((a, b) => (b.uses - a.uses) || (parseTime(b.updatedAt, 0) - parseTime(a.updatedAt, 0)));
    const dropped = state.skills.length - cfg.maxSkills;
    state.skills = state.skills.slice(0, cfg.maxSkills);
    return dropped;
  }

  /** 从记忆快照里抽技能并落库；重复跑不会重复记（同名/相似名字合并）。 */
  function extract(input = {}, opts = {}) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    if (!cfg.enabled) {
      return { ok: true, enabled: false, added: [], merged: [], total: 0, written: false, reason: 'disabled' };
    }
    load();
    const candidates = extractSkillsFromMemories(input, cfg, now);
    const added = [];
    const merged = [];
    for (const candidate of candidates) {
      const key = candidate.key;
      const existing = state.skills.find(
        (skill) => normalizeForSim(skill.name) === key || skillSimilarity(skill.name, candidate.name) >= cfg.mergeSimilarity
      );
      if (existing) {
        let touched = false;
        const newSources = candidate.sourceIds.filter((id) => !existing.sourceIds.includes(id));
        if (newSources.length) {
          existing.sourceIds = [...existing.sourceIds, ...newSources].slice(0, 8);
          existing.seen = (Number(existing.seen) || 1) + 1;
          touched = true;
        }
        if (candidate.steps.length > existing.steps.length) {
          existing.steps = candidate.steps.slice();
          touched = true;
        }
        if (touched) {
          existing.updatedAt = isoOf(now);
          merged.push(viewOf(existing));
          dirty = true;
        }
      } else {
        const record = normalizeSkill({
          id: 'sk_' + hashOf(key),
          name: candidate.name,
          steps: candidate.steps,
          source: candidate.source,
          sourceIds: candidate.sourceIds,
          createdAt: isoOf(now),
          updatedAt: isoOf(now)
        });
        if (!record) continue;
        state.skills.push(record);
        added.push(viewOf(record));
        dirty = true;
      }
    }
    trimSkills();
    const written = save();
    return {
      ok: true,
      enabled: true,
      added,
      merged,
      total: state.skills.length,
      changed: added.length + merged.length > 0,
      written
    };
  }

  /** 命中相似任务时返回可复用步骤（按分数排）。 */
  function match(query, opts = {}) {
    if (!cfg.enabled) return [];
    load();
    const text = typeof query === 'string' ? query : String(query?.text ?? query?.task ?? '');
    const q = text.trim();
    if (!q) return [];
    const limit = intOf(opts.limit, cfg.matchLimit, 1, 20);
    const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : cfg.matchMinScore;
    return state.skills
      .map((skill) => ({ ...viewOf(skill), score: Number(skillScore(q, skill).toFixed(3)) }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => (b.score - a.score) || (b.uses - a.uses))
      .slice(0, limit);
  }

  /**
   * 记一次使用：use({name, ok})。ok=true 记成功，ok=false 记失败，
   * 不传 ok 只算「用过」（成功率按 successes/uses 算）。
   */
  function use(input = {}, opts = {}) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    if (!cfg.enabled) return { ok: false, enabled: false, found: false, reason: 'disabled' };
    load();
    const payload = typeof input === 'string' ? { name: input } : (input && typeof input === 'object' ? input : {});
    const name = String(payload.name ?? payload.id ?? payload.task ?? '').trim();
    if (!name) return { ok: false, enabled: true, found: false, reason: 'empty' };
    const skill = findSkill(name);
    if (!skill) return { ok: false, enabled: true, found: false, reason: 'not-found', name };
    const ok = payload.ok !== undefined ? payload.ok : opts.ok;
    skill.uses += 1;
    if (ok === true) skill.successes += 1;
    else if (ok === false) skill.failures += 1;
    skill.updatedAt = isoOf(now);
    dirty = true;
    const written = save();
    return {
      ok: true,
      enabled: true,
      found: true,
      name: skill.name,
      uses: skill.uses,
      successes: skill.successes,
      failures: skill.failures,
      successRate: skill.uses > 0 ? Number((skill.successes / skill.uses).toFixed(2)) : null,
      written
    };
  }

  /** 全部技能（用过的、新的在前）。 */
  function list(opts = {}) {
    if (!cfg.enabled) return [];
    load();
    const limit = intOf(opts.limit, cfg.maxSkills, 1, cfg.maxSkills);
    return state.skills
      .slice()
      .sort((a, b) => (b.uses - a.uses) || (parseTime(b.updatedAt, 0) - parseTime(a.updatedAt, 0)))
      .slice(0, limit)
      .map((skill) => viewOf(skill));
  }

  /** 按名字/ID 取一条技能；没有返回 null。 */
  function get(name) {
    if (!cfg.enabled) return null;
    load();
    const skill = findSkill(name);
    return skill ? viewOf(skill) : null;
  }

  /** 出站注入用：有 query 就按相似度取，没有 query 就取最常用的几条。 */
  function render(opts = {}) {
    if (!cfg.enabled) return '';
    load();
    const maxChars = intOf(opts.maxChars, 400, 40, 4000);
    const limit = intOf(opts.limit, 2, 1, 10);
    const query = String(opts.query ?? opts.text ?? '').trim();
    const items = query ? match(query, { limit }) : list({ limit });
    if (!items.length) return '';
    const lines = ['【这样做过】'];
    let budget = maxChars;
    for (const item of items) {
      const steps = item.steps.map((step, index) => (index + 1) + '. ' + step).join('；');
      const line = '- ' + item.name + '（用过 ' + item.uses + ' 次）:' + steps;
      if (line.length + 1 > budget) break;
      lines.push(line);
      budget -= line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** 只读状态，给控制台/自检看。 */
  function status() {
    load();
    const totalUses = state.skills.reduce((sum, skill) => sum + skill.uses, 0);
    const totalSuccess = state.skills.reduce((sum, skill) => sum + skill.successes, 0);
    return {
      enabled: cfg.enabled,
      statePath,
      total: state.skills.length,
      uses: totalUses,
      successes: totalSuccess,
      successRate: totalUses > 0 ? Number((totalSuccess / totalUses).toFixed(2)) : null,
      updatedAt: state.updatedAt,
      warnings: warnings.slice()
    };
  }

  return { statePath, config: cfg, extract, match, use, list, get, render, status };
}

export default createProceduralStore;
