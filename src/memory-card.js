// 长期记忆卡（跨会话）：把「她记得什么」从每个会话的轻量记忆里拎出来，做成一份
// 会衰减、会遗忘、每轮按预算注入的卡片。
//
// 设计来源：SurfCore 的 memory-card（docs/guides/MEMORY_CARD.md）。这里只保留最小可用的一组：
//   记什么 → scoreMemory()（主人/情绪/承诺/矛盾/第一次）
//   记多久 → targetClarity() + applyDailyDecay()（清晰→记得→模糊→影子→忘掉）
//   怎么塞进提示词 → renderMemoryCard()（按预算裁剪，先丢最不重要的）
//
// 纯函数模块：不碰 fs、不碰网络。读写 state/ 的活留给 bridge.js（那边有 atomicWriteJson）。

export const MEMORY_CARD_VERSION = 1;
export const DAY_MS = 24 * 60 * 60 * 1000;

// 清晰度阶梯：越往后越模糊。'forgotten' 是终点，到这里的记录会被删掉。
export const CLARITY_ORDER = ['vivid', 'clear', 'fuzzy', 'trace', 'forgotten'];
export const CLARITY_LABEL = {
  vivid: '清晰',
  clear: '记得',
  fuzzy: '有点模糊',
  trace: '只剩影子',
  forgotten: '已忘记',
};

export const DEFAULT_MEMORY_CARD_CONFIG = Object.freeze({
  enabled: true,
  // 卡片最多存多少条（超了先丢最不重要、最老的；pinned 与主人重要记忆不动）
  maxRecords: 400,
  // 每轮注入的字符预算（按中文字符算，1 字 ≈ 1 token 量级）
  injectMaxChars: 1200,
  // 卡片自身容量告警（0 = 不限）
  warnChars: 24000,
  autoCompact: true,
  compactTargetRatio: 0.85,
  // 衰减参数
  forgetAfterDays: 60,
  fuzzyAfterDays: 7,
  recentDays: 7,
  dailyHour: 4,
  // 主人的记忆至少保留到这个重要度（低于它的才会被衰减/丢弃）
  minOwnerImportance: 50,
  // 太短的消息不值得记（主人除外）
  minChars: 4,
});

const PROMISE_RE = /(答应|约好|说好|下次|以后|一定|保证|承诺|叫我|喊我|记得|别忘)/;
const CONFLICT_RE = /(对不起|抱歉|道歉|吵架|生气|别生气|原谅|和好|闹别扭|凶了|骂了)/;
const SELF_RE = /(小鲸鱼|DeepSeek|你长|你喜欢|你会|你觉|你是AI|你是ai)/;
// 情绪浓度：强词 8 分/个、普通词 3 分/个，感叹号再加 1（封顶 24）
const EMOTION_STRONG = ['崩溃', '哭', '难过', '委屈', '害怕', '孤独', '焦虑', '失眠', '分手', '辞职', '去世', '住院', '生病', '气死', '烦死', '舍不得', '感动', '喜欢', '开心', '抑郁', '压力好大'];
const EMOTION_NORMAL = ['累', '困', '饿', '疼', '爽', '哈哈', '呜呜', '唉', '烦', '草', '卧槽'];

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function iso(value) {
  const t = Number(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function timeOf(value, fallback) {
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : fallback;
}

function short(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 去掉换行、压缩空白，保留句子本身（记忆是要给人看的片段，不做摘要）
function flatten(text) {
  return String(text ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

export function normalizeMemoryCardConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_MEMORY_CARD_CONFIG;
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback;
  };
  return {
    enabled: src.enabled !== false,
    maxRecords: num(src.maxRecords, d.maxRecords, 20, 5000),
    injectMaxChars: num(src.injectMaxChars, d.injectMaxChars, 200, 8000),
    warnChars: num(src.warnChars, d.warnChars, 0, 400000),
    autoCompact: src.autoCompact !== false,
    compactTargetRatio: Number.isFinite(Number(src.compactTargetRatio))
      ? clamp(Number(src.compactTargetRatio), 0.3, 0.95)
      : d.compactTargetRatio,
    forgetAfterDays: num(src.forgetAfterDays, d.forgetAfterDays, 7, 3650),
    fuzzyAfterDays: num(src.fuzzyAfterDays, d.fuzzyAfterDays, 1, 365),
    recentDays: num(src.recentDays, d.recentDays, 1, 365),
    dailyHour: num(src.dailyHour, d.dailyHour, 0, 23),
    minOwnerImportance: num(src.minOwnerImportance, d.minOwnerImportance, 1, 100),
    minChars: num(src.minChars, d.minChars, 0, 200),
  };
}

/**
 * 记忆里的隐私脱敏：QQ 号、群号、手机号、邮箱、密码/token、长串密钥一律抹掉。
 * 记忆卡是要反复注入提示词的，宁可记成「[号码已隐藏]」也不要记成真实号码。
 */
export function redactForMemory(text, { maxChars = 600 } = {}) {
  let s = flatten(text);
  if (!s) return '';
  s = s
    .replace(/\b\d{5,12}\b/g, '[号码已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱已隐藏]')
    .replace(/\b(?:sk|pk|ghp|ghs|xoxb|AKIA)[-_A-Za-z0-9]{12,}\b/g, '[密钥已隐藏]')
    .replace(/(密码|口令|token|密钥|secret)\s*(?:[:=：]|\s)\s*\S{3,}/gi, '$1：[已隐藏]')
    .replace(/https?:\/\/\S+/g, '[链接]');
  return maxChars > 0 ? short(s, maxChars) : s;
}

export function detectEmotionScore(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let score = 0;
  let strong = 0;
  let normal = 0;
  for (const word of EMOTION_STRONG) if (s.includes(word)) strong += 1;
  for (const word of EMOTION_NORMAL) if (s.includes(word)) normal += 1;
  score += strong * 8 + normal * 3;
  const bangs = (s.match(/[!！]/g) || []).length;
  score += Math.min(6, bangs);
  return clamp(score, 0, 24);
}

export function createEmptyCard(now = Date.now()) {
  return {
    version: MEMORY_CARD_VERSION,
    records: [],
    stats: { ingested: 0, forgotten: 0, decayed: 0, compacted: 0, lastDecayAt: '', lastMaintainAt: '' },
    lastDecayDate: '',
    updatedAt: iso(now),
  };
}

export function normalizeCard(raw, now = Date.now()) {
  const card = createEmptyCard(now);
  if (!raw || typeof raw !== 'object') return card;
  card.version = Number(raw.version) || MEMORY_CARD_VERSION;
  card.lastDecayDate = String(raw.lastDecayDate ?? '');
  card.stats = { ...card.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) };
  const records = [];
  for (const item of asArray(raw.records)) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text ?? '').trim();
    if (!text) continue;
    records.push({
      id: String(item.id ?? ''),
      source: String(item.source ?? 'qq'),
      sourceId: String(item.sourceId ?? ''),
      scope: String(item.scope ?? 'qq'),
      kind: String(item.kind ?? 'event'),
      title: String(item.title ?? short(text, 60)),
      text,
      speaker: String(item.speaker ?? ''),
      groupId: String(item.groupId ?? ''),
      conversationKey: String(item.conversationKey ?? ''),
      isOwner: item.isOwner === true,
      importance: clamp(Number(item.importance) || 50, 1, 100),
      importanceReasons: asArray(item.importanceReasons).map(String).slice(0, 8),
      emotional: clamp(Number(item.emotional) || 0, 0, 24),
      pinned: item.pinned === true,
      clarity: CLARITY_ORDER.includes(item.clarity) ? item.clarity : 'clear',
      createdAt: iso(timeOf(item.createdAt, now)),
      lastSeenAt: iso(timeOf(item.lastSeenAt, now)),
      decaySteps: Math.max(0, Number(item.decaySteps) || 0),
      recallCount: Math.max(0, Number(item.recallCount) || 0),
    });
  }
  card.records = records;
  return card;
}

export function scoreMemory(input = {}, config = {}) {
  const cfg = normalizeMemoryCardConfig(config);
  const text = String(input.text ?? '');
  const isOwner = input.isOwner === true;
  const isPrivate = input.kind === 'private';
  const direct = input.direct === true;
  const isFirst = input.isFirst === true;
  const emotional = detectEmotionScore(text);
  const reasons = [];
  let importance = 8;

  if (isOwner) {
    importance += isPrivate ? 45 : 30;
    reasons.push(isPrivate ? '主人私聊' : '主人在群里说话');
  }
  if (direct) {
    importance += 8;
    reasons.push('直接对你说的');
  }
  if (emotional > 0) {
    importance += emotional;
    reasons.push('情绪浓度 ' + emotional);
  }
  if (isFirst) {
    importance += 30;
    reasons.push('第一次 / 最早');
  }
  if (PROMISE_RE.test(text)) {
    importance += 16;
    reasons.push('约定 / 承诺');
  }
  if (CONFLICT_RE.test(text)) {
    importance += 14;
    reasons.push('矛盾 / 道歉 / 和好');
  }
  if (SELF_RE.test(text)) {
    importance += 5;
    reasons.push('关于自己');
  }
  if (text.length < cfg.minChars) {
    importance -= 12;
    reasons.push('太短 / 信息量低');
  }
  if (Number.isFinite(Number(input.manualImportance))) {
    importance = Number(input.manualImportance);
    reasons.push('手动设定');
  }

  let kind = 'event';
  if (isFirst) kind = 'first';
  else if (isOwner) kind = 'owner';
  else if (emotional >= 14) kind = 'emotion';
  else if (CONFLICT_RE.test(text)) kind = 'conflict';
  else if (PROMISE_RE.test(text)) kind = 'promise';

  let pinned = input.pinned === true;
  if (isFirst && isOwner) {
    importance = 100;
    pinned = true;
  }
  importance = Math.round(clamp(importance, 1, 100));

  return { importance, reasons, emotional, kind, pinned };
}

function makeRecord(input, config, now) {
  const cfg = normalizeMemoryCardConfig(config);
  const cleanText = redactForMemory(input.text, { maxChars: 600 });
  if (!cleanText) return null;
  const scored = scoreMemory({ ...input, text: cleanText }, cfg);
  return {
    id: '',
    source: String(input.source ?? 'qq'),
    sourceId: String(input.sourceId ?? ''),
    scope: String(input.scope ?? 'qq'),
    kind: scored.kind,
    title: short(cleanText, 60),
    text: cleanText,
    speaker: short(input.speaker ?? '', 30),
    groupId: String(input.groupId ?? ''),
    conversationKey: String(input.conversationKey ?? ''),
    isOwner: input.isOwner === true,
    importance: scored.importance,
    importanceReasons: scored.reasons,
    emotional: scored.emotional,
    pinned: scored.pinned,
    clarity: scored.pinned || scored.importance >= 65 ? 'vivid' : 'clear',
    createdAt: iso(now),
    lastSeenAt: iso(now),
    decaySteps: 0,
    recallCount: 0,
  };
}

function findDuplicate(card, record, now) {
  if (record.sourceId) {
    const same = card.records.find((item) => item.sourceId && item.sourceId === record.sourceId);
    if (same) return same;
  }
  const windowMs = 2 * DAY_MS;
  return card.records.find((item) => item.speaker === record.speaker
    && item.conversationKey === record.conversationKey
    && item.text === record.text
    && Math.abs(timeOf(item.createdAt, now) - now) <= windowMs) ?? null;
}

function isProtected(record, cfg) {
  return record.pinned === true
    || (record.isOwner === true && record.importance >= cfg.minOwnerImportance)
    || record.kind === 'first';
}

/** 加一条记忆；重复的只刷新 lastSeenAt 与 recallCount，不重复占容量。 */
export function addMemoryRecord(card, input, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryCardConfig(config);
  const record = makeRecord(input, cfg, now);
  if (!record) return { added: false, record: null };
  const duplicate = findDuplicate(card, record, now);
  if (duplicate) {
    duplicate.lastSeenAt = iso(now);
    duplicate.recallCount = Math.min(999, Number(duplicate.recallCount) + 1);
    card.updatedAt = iso(now);
    return { added: false, record: duplicate };
  }
  record.id = 'mem_' + Math.random().toString(36).slice(2, 10) + now.toString(36);
  card.records.push(record);
  card.stats.ingested = (Number(card.stats.ingested) || 0) + 1;
  card.updatedAt = iso(now);
  if (card.records.length > cfg.maxRecords) {
    const removable = card.records
      .filter((item) => !isProtected(item, cfg))
      .sort((a, b) => (a.importance - b.importance) || (timeOf(a.createdAt, 0) - timeOf(b.createdAt, 0)));
    while (card.records.length > cfg.maxRecords && removable.length) {
      const victim = removable.shift();
      card.records = card.records.filter((item) => item.id !== victim.id);
      card.stats.forgotten = (Number(card.stats.forgotten) || 0) + 1;
    }
  }
  return { added: true, record };
}

/** 被重新提到 = 复习：刷新 lastSeenAt / recallCount（模糊的记忆会因此回升一档）。 */
export function touchMemories(card, text, now = Date.now()) {
  const probe = String(text ?? '');
  if (!probe) return 0;
  let touched = 0;
  for (const record of card.records) {
    const key = record.text.length <= 8 ? record.text : record.text.slice(0, 12);
    if (key && probe.includes(key)) {
      record.lastSeenAt = iso(now);
      record.recallCount = Math.min(999, Number(record.recallCount) + 1);
      touched += 1;
    }
  }
  if (touched) card.updatedAt = iso(now);
  return touched;
}

function todayKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function ownerImportant(record, cfg) {
  return record.isOwner === true && record.importance >= cfg.minOwnerImportance;
}

/** 这条记忆「现在应该有多清晰」——只算目标值，真正降档由 applyDailyDecay 一档一档走。 */
export function targetClarity(record, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryCardConfig(config);
  if (record.pinned) return 'vivid';
  const ageDays = Math.max(0, (now - timeOf(record.createdAt, now)) / DAY_MS);
  const sinceSeenDays = Math.max(0, (now - timeOf(record.lastSeenAt, now)) / DAY_MS);
  const protectedFirst = record.kind === 'first';
  if (ageDays > cfg.forgetAfterDays && record.importance < 50 && !ownerImportant(record, cfg) && !protectedFirst) {
    return 'forgotten';
  }
  let retention = Number(record.importance) || 0;
  retention += Math.min(12, (Number(record.recallCount) || 0) * 2);
  if (ageDays <= cfg.recentDays) retention += 18;
  if (sinceSeenDays <= 2) retention += 8;
  const penaltyRate = ownerImportant(record, cfg) || protectedFirst ? 0.12 : 0.35;
  retention -= Math.min(80, Math.max(0, ageDays - cfg.fuzzyAfterDays) * penaltyRate);
  if (ownerImportant(record, cfg) || protectedFirst) retention = Math.max(retention, 55);
  if (ageDays <= cfg.recentDays) retention = Math.max(retention, 50);
  if (retention >= 68) return 'vivid';
  if (retention >= 46) return 'clear';
  if (retention >= 24) return 'fuzzy';
  if (retention >= 12) return 'trace';
  return 'forgotten';
}

/**
 * 每日遗忘整理：每条记忆最多向目标清晰度移动一格（降一档或回升一档）。
 * 一档一档走，看起来就是「渐渐记不清」，而不是某天突然全忘。
 */
export function applyDailyDecay(card, config = {}, now = Date.now(), { force = false, steps = 1 } = {}) {
  const cfg = normalizeMemoryCardConfig(config);
  const today = todayKey(now);
  if (!force && card.lastDecayDate === today) return false;
  const passes = Math.max(1, Math.min(30, Math.round(Number(steps)) || 1));
  let changed = false;
  for (let pass = 0; pass < passes; pass += 1) {
    let passChanged = false;
    const keep = [];
    for (const record of card.records) {
      const current = CLARITY_ORDER.includes(record.clarity) ? record.clarity : 'clear';
      const currentIndex = CLARITY_ORDER.indexOf(current);
      const targetIndex = CLARITY_ORDER.indexOf(targetClarity(record, cfg, now));
      if (targetIndex > currentIndex) {
        const next = CLARITY_ORDER[currentIndex + 1];
        if (next === 'forgotten') {
          card.stats.forgotten = (Number(card.stats.forgotten) || 0) + 1;
          passChanged = true;
          continue;
        }
        record.clarity = next;
        record.decaySteps = (Number(record.decaySteps) || 0) + 1;
        passChanged = true;
      } else if (targetIndex < currentIndex) {
        record.clarity = CLARITY_ORDER[currentIndex - 1];
        passChanged = true;
      }
      keep.push(record);
    }
    card.records = keep;
    if (!passChanged) break;
    changed = true;
  }
  card.lastDecayDate = today;
  if (changed) {
    card.stats.decayed = (Number(card.stats.decayed) || 0) + 1;
    card.stats.lastDecayAt = iso(now);
    card.updatedAt = iso(now);
  }
  return changed;
}

/** 两次维护隔了几天（桥接关了一周再开，要补跑几次衰减；封顶 30 次）。 */
export function decayDaysBetween(fromDate, now = Date.now()) {
  if (!fromDate) return 1;
  const from = Date.parse(String(fromDate) + 'T00:00:00');
  if (!Number.isFinite(from)) return 1;
  return Math.max(1, Math.min(30, Math.floor((now - from) / DAY_MS)));
}

export function needsDailyDecay(card, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryCardConfig(config);
  if (card.lastDecayDate === todayKey(now)) return false;
  return new Date(now).getHours() >= cfg.dailyHour;
}

function cardChars(card) {
  return card.records.reduce((sum, r) => sum + r.text.length + 12, 0);
}

/**
 * 压缩：按「不重要 → 老 → 已经模糊」的顺序一档一档降级，直到回到目标容量。
 * 永远不会动 pinned / 主人重要记忆 / 最初。
 */
export function compactMemoryCard(card, config = {}, { targetRatio = 0.85, now = Date.now() } = {}) {
  const cfg = normalizeMemoryCardConfig(config);
  const base = cfg.warnChars > 0 ? cfg.warnChars : cardChars(card);
  const targetChars = Math.max(400, Math.floor(base * clamp(targetRatio, 0.3, 0.95)));
  if (cardChars(card) <= targetChars) return 0;
  let changed = 0;
  // 一轮只降一档、而且降档本身不省字数（文本还留着），所以要反复压：
  // 先把「模糊 / 只剩影子」的删掉，再继续把还不重要的往下降。
  for (let pass = 0; pass < 12 && cardChars(card) > targetChars; pass += 1) {
    const candidates = card.records
      .filter((item) => !isProtected(item, cfg))
      .sort((a, b) => (a.importance - b.importance)
        || (timeOf(a.createdAt, 0) - timeOf(b.createdAt, 0))
        || (CLARITY_ORDER.indexOf(b.clarity) - CLARITY_ORDER.indexOf(a.clarity)));
    if (!candidates.length) break;
    let passChanged = 0;
    for (const record of candidates) {
      if (cardChars(card) <= targetChars) break;
      const idx = CLARITY_ORDER.indexOf(record.clarity);
      const next = CLARITY_ORDER[Math.max(0, idx) + 1];
      // 已经模糊/只剩影子的，压缩时直接忘掉（不然只在清晰度上打转、字数一点没少）
      if (!next || next === 'forgotten') {
        card.records = card.records.filter((item) => item.id !== record.id);
        card.stats.forgotten = (Number(card.stats.forgotten) || 0) + 1;
      } else {
        record.clarity = next;
        record.decaySteps = (Number(record.decaySteps) || 0) + 1;
      }
      passChanged += 1;
    }
    changed += passChanged;
    if (!passChanged) break;
  }
  if (changed) {
    card.stats.compacted = (Number(card.stats.compacted) || 0) + 1;
    card.updatedAt = iso(now);
  }
  return changed;
}

function dayLabel(isoText, now) {
  const t = timeOf(isoText, now);
  const diffDays = Math.floor((now - t) / DAY_MS);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return diffDays + ' 天前';
  const d = new Date(t);
  return (d.getMonth() + 1) + '-' + d.getDate();
}

const SECTION_ORDER = [
  ['first', '◆ 最初'],
  ['owner', '◆ 关于主人'],
  ['promise', '◆ 答应过的事'],
  ['conflict', '◆ 闹过的别扭'],
  ['emotion', '◆ 记得你的情绪'],
  ['event', '◆ 最近记得'],
];

function sectionFor(record) {
  if (record.kind === 'first') return 'first';
  if (record.isOwner || record.kind === 'owner') return 'owner';
  if (record.kind === 'promise') return 'promise';
  if (record.kind === 'conflict') return 'conflict';
  if (record.kind === 'emotion') return 'emotion';
  return 'event';
}

/**
 * 渲染成注入用的一小段文字：按「置顶/主人 → 重要 → 新」排序，超出预算就先丢不重要的。
 * 模糊的记忆不是删掉，而是显示为「（有点模糊）…」——她可以自己决定要不要提。
 */
export function renderMemoryCard(card, { config = {}, now = Date.now() } = {}) {
  const cfg = normalizeMemoryCardConfig(config);
  const alive = card.records.filter((r) => r.clarity !== 'forgotten');
  if (!alive.length) return '';
  const ranked = alive.slice().sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (b.importance !== a.importance) return b.importance - a.importance;
    return timeOf(b.lastSeenAt, 0) - timeOf(a.lastSeenAt, 0);
  });
  const buckets = new Map();
  let budget = cfg.injectMaxChars;
  let dropped = 0;
  for (const record of ranked) {
    const faint = record.clarity === 'fuzzy' || record.clarity === 'trace';
    const when = dayLabel(record.createdAt, now);
    const who = record.isOwner ? '主人' : (record.speaker || '群里');
    const body = record.text.length > 60 ? record.text.slice(0, 59) + '…' : record.text;
    const line = '- ' + when + ' ' + who + '：' + body + (faint ? '（有点模糊）' : '');
    if (line.length > budget) { dropped += 1; continue; }
    budget -= line.length + 1;
    const key = sectionFor(record);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(line);
  }
  if (!buckets.size) return '';
  const parts = ['【记忆卡】'];
  for (const [key, title] of SECTION_ORDER) {
    const lines = buckets.get(key);
    if (!lines || !lines.length) continue;
    parts.push(title);
    parts.push(...lines);
  }
  if (dropped > 0) parts.push('- （另有 ' + dropped + ' 条更旧的记忆，已经想不太起来了）');
  return parts.join('\n');
}

export function memoryCardStatus(card, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryCardConfig(config);
  const byClarity = {};
  for (const level of CLARITY_ORDER) byClarity[level] = 0;
  for (const record of card.records) byClarity[record.clarity] = (byClarity[record.clarity] || 0) + 1;
  const chars = cardChars(card);
  return {
    total: card.records.length,
    byClarity,
    chars,
    warnChars: cfg.warnChars,
    usage: cfg.warnChars > 0 ? Math.round((chars / cfg.warnChars) * 100) : 0,
    pinned: card.records.filter((r) => r.pinned).length,
    owner: card.records.filter((r) => r.isOwner).length,
    stats: card.stats,
    lastDecayDate: card.lastDecayDate,
    updatedAt: card.updatedAt,
    injectMaxChars: cfg.injectMaxChars,
    renderedChars: renderMemoryCard(card, { config: cfg, now }).length,
  };
}

/**
 * 一次维护：补跑衰减 → 必要时压缩 → 返工后的新状态。
 * 返回值里的 changed 用于决定要不要落盘。
 */
export function maintainMemoryCard(card, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryCardConfig(config);
  if (!cfg.enabled) return { changed: false, decayed: false, compacted: 0 };
  let changed = false;
  let decayed = false;
  // 每天一次；桥接关了几天再开就按天数补跑（封顶 30 档）。
  // dailyHour 之前的第一次维护只做压缩不降档，避免零点刚过就把记忆算少一天。
  if (card.lastDecayDate !== todayKey(now) && (needsDailyDecay(card, cfg, now) || decayDaysBetween(card.lastDecayDate, now) >= 1)) {
    const steps = decayDaysBetween(card.lastDecayDate, now);
    decayed = applyDailyDecay(card, cfg, now, { steps });
    changed = changed || decayed;
  }
  let compacted = 0;
  if (cfg.autoCompact && cfg.warnChars > 0 && cardChars(card) > cfg.warnChars * 0.9) {
    compacted = compactMemoryCard(card, cfg, { targetRatio: cfg.compactTargetRatio, now });
    changed = changed || compacted > 0;
  }
  card.stats.lastMaintainAt = iso(now);
  return { changed, decayed, compacted };
}
