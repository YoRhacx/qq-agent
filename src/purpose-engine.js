// 目的引擎（purpose engine）——纯函数：从记忆里提炼"心里惦记着的事"，并决定"现在轮到它了吗"。
//
// 为什么需要它：主动找话最容易退化成"定时复读一句在吗"。人主动开口前，心里其实先有件事
// （答应了没做、上次吵架还没圆、对方说过很难受、有个话题没聊完）。这个文件负责把这件事找出来，
// 带上"谁的事、多想要、多急、多冒险"，再用**硬闸门**挡住不该开口的时刻。
//
// 边界：零 import、零 I/O。读盘/发 QQ/写状态都在 bridge.js；这里只算。
//
// 两道最容易踩的坑（写成硬闸门，不做成"权重"）：
//   ① 对方刚说过话时不能"主动搭话" —— 那是插嘴，不是惦记；
//   ② 载体互斥 —— 在 QQ 里长出来的目的，不能拿去桌宠/B站那边发作（同一个人，两条载体，
//      各自有各自的对话史；串载体等于对着群里说的话在私聊里接茬）。

export const PURPOSE_VERSION = 1;

export const DEFAULT_PURPOSE_CONFIG = Object.freeze({
  enabled: true,
  inject: true,
  // 载体标识：一个目的只在自己生长出来的载体上使用。
  carrier: 'qq',
  maxItems: 2,
  // 静默时段（本地时间，HH:MM）。这段时间里不主动开口，但记忆照常沉淀。
  quietStart: '23:30',
  quietEnd: '08:30',
  // 两次主动开口的最小间隔、每天上限：宁少勿多。
  minGapMs: 150 * 60 * 1000,
  dailyMax: 4,
  // 同一个目的说过之后再等多久才重提。
  cooldownMs: 6 * 60 * 60 * 1000,
  // 对方最近说过话的这么久之内，不主动搭话（他在，会被当成插嘴/抢话）。
  activeChatMs: 15 * 60 * 1000,
  // 低于这个分就不值得开口（沉默比硬找话好）。
  minScore: 45,
  // 答应过的事过了这么久还没下文就算"该提了"。
  promiseOverdueMs: 24 * 60 * 60 * 1000,
  // 只取多久以内的记忆卡记录（太老的记不住，也不该被翻出来）。
  memoryWindowDays: 30,
  promptMaxChars: 600
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NEGATIVE_RE = /难受|难过|崩溃|哭|焦虑|烦|累死|好累|压力|失眠|生气|委屈|失望|孤独|emo/i;

export function normalizePurposeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const clock = (v, d) => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim());
    return m ? String(v).trim() : d;
  };
  return {
    enabled: src.enabled !== false,
    inject: src.inject !== false,
    carrier: String(src.carrier ?? DEFAULT_PURPOSE_CONFIG.carrier).trim() || 'qq',
    maxItems: num(src.maxItems, DEFAULT_PURPOSE_CONFIG.maxItems, 1, 4),
    quietStart: clock(src.quietStart, DEFAULT_PURPOSE_CONFIG.quietStart),
    quietEnd: clock(src.quietEnd, DEFAULT_PURPOSE_CONFIG.quietEnd),
    minGapMs: num(src.minGapMs, DEFAULT_PURPOSE_CONFIG.minGapMs, 30 * MINUTE, 24 * HOUR),
    dailyMax: num(src.dailyMax, DEFAULT_PURPOSE_CONFIG.dailyMax, 1, 20),
    cooldownMs: num(src.cooldownMs, DEFAULT_PURPOSE_CONFIG.cooldownMs, 30 * MINUTE, 7 * DAY),
    activeChatMs: num(src.activeChatMs, DEFAULT_PURPOSE_CONFIG.activeChatMs, 60 * 1000, 6 * HOUR),
    minScore: num(src.minScore, DEFAULT_PURPOSE_CONFIG.minScore, 0, 200),
    promiseOverdueMs: num(src.promiseOverdueMs, DEFAULT_PURPOSE_CONFIG.promiseOverdueMs, HOUR, 30 * DAY),
    memoryWindowDays: num(src.memoryWindowDays, DEFAULT_PURPOSE_CONFIG.memoryWindowDays, 1, 365),
    promptMaxChars: num(src.promptMaxChars, DEFAULT_PURPOSE_CONFIG.promptMaxChars, 120, 4000)
  };
}

function minutesOfClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? ''));
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 现在是否在静默时段。跨零点的时段（23:30–08:30）按"或"处理。 */
export function inQuietHours(now, config) {
  const cfg = normalizePurposeConfig(config);
  const start = minutesOfClock(cfg.quietStart);
  const end = minutesOfClock(cfg.quietEnd);
  if (start === end) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function two(n) {
  return String(n).padStart(2, '0');
}

function localDateKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}

function clampText(text, max = 60) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function ageOf(isoOrMs, now) {
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs ?? ''));
  if (!Number.isFinite(t) || t <= 0) return Infinity;
  return Math.max(0, now - t);
}

/**
 * 从记忆里提炼候选目的。
 * @param {{memories?: {pendingThoughts?: object[], activeTopics?: object[]}, memoryCard?: {records?: object[]},
 *          now?: number, config?: object}} input
 */
export function buildPurposeCandidates({ memories = {}, memoryCard = {}, now = Date.now(), config = {} } = {}) {
  const cfg = normalizePurposeConfig(config);
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const text = clampText(item.text);
    if (!text) return;
    const key = item.kind + ':' + text;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: item.id || key,
      text,
      kind: item.kind,
      owner: item.owner || '我',
      source: item.source || '',
      confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.5)),
      value: Math.min(100, Math.max(0, Number(item.value) || 0)),
      urgency: Math.min(100, Math.max(0, Number(item.urgency) || 0)),
      risk: Math.min(100, Math.max(0, Number(item.risk) || 0)),
      carrier: item.carrier || cfg.carrier,
      reason: item.reason || ''
    });
  };

  // 1) 记忆卡里的承诺：答应过的事是有分量的，越久没下文越该提。
  for (const r of Array.isArray(memoryCard?.records) ? memoryCard.records : []) {
    if (!r || !r.text) continue;
    const age = ageOf(r.createdAt, now);
    if (age > cfg.memoryWindowDays * DAY) continue;
    if (r.kind === 'promise') {
      const overdue = age >= cfg.promiseOverdueMs;
      push({
        id: 'promise:' + (r.id || r.text),
        text: r.text,
        kind: 'followup',
        owner: r.isOwner ? '主人' : '群友',
        source: 'memory-card:promise',
        confidence: 0.8,
        value: 75,
        urgency: Math.min(60, Math.round(age / DAY) * 10) + (overdue ? 15 : 0),
        risk: 10,
        reason: overdue ? '答应过的事还没下文' : '答应过的事'
      });
      continue;
    }
    // 2) 还没圆过去的别扭：只留三天内的，翻旧账比不哄更糟。
    if (r.kind === 'conflict' && age <= 3 * DAY) {
      push({
        id: 'conflict:' + (r.id || r.text),
        text: r.text,
        kind: 'repair',
        owner: r.isOwner ? '主人' : '群友',
        source: 'memory-card:conflict',
        confidence: 0.6,
        value: 70,
        urgency: Math.max(0, Math.round(30 - (age / DAY) * 10)),
        risk: 30,
        reason: '上次闹得不太好看'
      });
      continue;
    }
    // 3) 对方说过难受：两天内问一句，不追问细节。
    if (r.kind === 'emotion' && age <= 2 * DAY && NEGATIVE_RE.test(String(r.text))) {
      push({
        id: 'care:' + (r.id || r.text),
        text: r.text,
        kind: 'care',
        owner: r.isOwner ? '主人' : '群友',
        source: 'memory-card:emotion',
        confidence: 0.65,
        value: 60,
        urgency: Math.max(0, Math.round(35 - (age / DAY) * 10)),
        risk: 15,
        reason: '对方上次说很难受'
      });
    }
  }

  // 4) 她想说还没说的话：她自己的动机，最值得给一次机会。
  for (const t of Array.isArray(memories?.pendingThoughts) ? memories.pendingThoughts : []) {
    if (!t || !t.text) continue;
    if (t.expiresAt && Number(t.expiresAt) <= now) continue;
    push({
      id: 'thought:' + t.text,
      text: t.text,
      kind: 'share',
      owner: '我',
      source: 'memory:pendingThought',
      confidence: 0.7,
      value: 50,
      urgency: t.motivation ? 10 : 0,
      risk: 10,
      reason: '你自己记下的、想说还没说的'
    });
  }

  // 5) 聊到一半的话题：只在"两小时前还在聊、之后没声了"时算惦念；
  //    正在聊（几分钟前）时不该主动，交给对话本身。
  for (const topic of Array.isArray(memories?.activeTopics) ? memories.activeTopics : []) {
    if (!topic || !topic.text) continue;
    const quietFor = topic.lastMentionAt ? now - Number(topic.lastMentionAt) : Infinity;
    const bornAgo = topic.at ? now - Number(topic.at) : Infinity;
    if (!(quietFor >= 2 * HOUR && quietFor <= 2 * DAY)) continue;
    if (!(bornAgo >= HOUR)) continue;
    push({
      id: 'topic:' + topic.text,
      text: topic.text,
      kind: 'topic',
      owner: '我',
      source: 'memory:activeTopic',
      confidence: 0.5,
      value: 40 + (topic.pendingQuestion ? 15 : 0),
      urgency: Math.min(20, Math.round(quietFor / HOUR)),
      risk: topic.pendingQuestion ? 20 : 5,
      reason: topic.pendingQuestion ? '话题里还有个问题没问完' : '一个没聊完的话题'
    });
  }

  return out
    .map((c) => ({ ...c, score: Math.round(c.value * c.confidence + c.urgency - c.risk) }))
    .sort((a, b) => b.score - a.score || b.urgency - a.urgency);
}

/**
 * 硬闸门 + 选一个目的。
 * @param {{candidates?: object[], state?: object, now?: number, config?: object}} input
 *        state: { lastFireAt, dailyDate, dailyCount, lastSelfAt, lastIncomingAt, carrier, tried }
 */
export function selectPurpose({ candidates = [], state = {}, now = Date.now(), config = {} } = {}) {
  const cfg = normalizePurposeConfig(config);
  const blocked = [];
  const list = Array.isArray(candidates) ? candidates : [];
  const st = state && typeof state === 'object' ? state : {};
  const tried = st.tried && typeof st.tried === 'object' ? st.tried : {};

  const base = { action: 'wait', purpose: null, score: 0, candidates: list.slice(0, 6), blocked, cfg };

  if (!cfg.enabled) return { ...base, blocked: ['disabled'] };
  if (inQuietHours(now, cfg)) return { ...base, blocked: ['quiet-hours'] };

  const lastFireAt = Number(st.lastFireAt) || 0;
  if (lastFireAt && now - lastFireAt < cfg.minGapMs) return { ...base, blocked: ['min-gap'] };

  const dailyDate = String(st.dailyDate ?? '');
  const dailyCount = Number(st.dailyCount) || 0;
  if (dailyDate === localDateKey(now) && dailyCount >= cfg.dailyMax) return { ...base, blocked: ['daily-max'] };

  const lastIncomingAt = Number(st.lastIncomingAt) || 0;
  if (lastIncomingAt && now - lastIncomingAt < cfg.activeChatMs) {
    return { ...base, blocked: ['conversation-active'] };
  }

  // 载体互斥：在别的载体上长出来的目的，这里不认。
  const carrierOk = list.filter((c) => (c?.carrier || cfg.carrier) === cfg.carrier);
  if (carrierOk.length < list.length) blocked.push('carrier-mismatch');

  // 冷却：刚提过的不再提。
  const cooled = carrierOk.filter((c) => {
    const last = Number(tried[c?.id] ?? 0);
    return !(last && now - last < cfg.cooldownMs);
  });
  if (cooled.length < carrierOk.length) blocked.push('cooldown');

  if (cooled.length === 0) return { ...base, candidates: carrierOk.slice(0, 6), blocked };
  const top = cooled[0];
  if (top.score < cfg.minScore) return { ...base, candidates: cooled.slice(0, 6), blocked: [...blocked, 'weak'] };

  return { ...base, action: 'speak', purpose: top, score: top.score, candidates: cooled.slice(0, 6), blocked };
}

const KIND_LABEL = {
  followup: '答应了还没做的事',
  repair: '还没圆过去的小别扭',
  care: '对方上次不太好受',
  share: '你想说还没说的',
  topic: '没聊完的话题'
};

/** 把选中的目的写成提示词里的一小段。只在她"该主动"的时候出现，且措辞是提醒不是命令。 */
export function buildPurposeLine(selection, config = {}) {
  const cfg = normalizePurposeConfig(config);
  if (!cfg.enabled || !cfg.inject) return '';
  const sel = selection && typeof selection === 'object' ? selection : {};
  const items = [];
  if (sel.purpose) items.push(sel.purpose);
  for (const c of Array.isArray(sel.candidates) ? sel.candidates : []) {
    if (items.length >= cfg.maxItems) break;
    if (!c) continue;
    if (sel.purpose && c.id === sel.purpose.id) continue;
    if (items.some((x) => x.id === c.id)) continue;
    if (c.score < cfg.minScore) continue;
    items.push(c);
  }
  if (items.length === 0) return '';
  const lines = items.map((c) => '- ' + c.text + (KIND_LABEL[c.kind] ? '（' + KIND_LABEL[c.kind] + '）' : ''));
  let out = '【心里惦记的事】\n' + lines.join('\n') + '\n- 想提就提，不想提就放着；别为了"显得关心"硬找话，也别把惦记说成查岗。';
  if (out.length > cfg.promptMaxChars) out = out.slice(0, cfg.promptMaxChars - 1) + '…';
  return out;
}

/** 记一次"提过"：写进 state（bridge.js 负责落盘）。 */
export function markPurposeFired(state, purpose, now = Date.now()) {
  const st = state && typeof state === 'object' ? state : {};
  const dateKey = localDateKey(now);
  const sameDay = st.dailyDate === dateKey;
  st.lastFireAt = now;
  st.dailyCount = (sameDay ? Number(st.dailyCount) || 0 : 0) + 1;
  st.dailyDate = dateKey;
  if (purpose && purpose.id) {
    st.tried = st.tried && typeof st.tried === 'object' ? st.tried : {};
    st.tried[purpose.id] = now;
  }
  return st;
}

/** 目的已经了结（比如承诺兑现了）：记进 resolved，永不再提。 */
export function resolvePurpose(state, id) {
  const st = state && typeof state === 'object' ? state : {};
  if (st.tried && id && st.tried[id]) delete st.tried[id];
  st.resolved = Array.isArray(st.resolved) ? st.resolved : [];
  if (id && !st.resolved.includes(id)) st.resolved.push(id);
  return st;
}

/** 控制台/日志的一行摘要。 */
export function describePurpose(selection) {
  const sel = selection && typeof selection === 'object' ? selection : {};
  if (sel.action === 'speak' && sel.purpose) {
    return 'speak ' + sel.purpose.kind + ' score=' + sel.score + ' id=' + sel.purpose.id;
  }
  return 'wait ' + ((sel.blocked || []).join(',') || 'no-candidate');
}

/** state 归一化（读盘后调一次，防止手改坏了）。 */
export function normalizePurposeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const tried = {};
  if (src.tried && typeof src.tried === 'object') {
    for (const [k, v] of Object.entries(src.tried)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) tried[k] = n;
    }
  }
  return {
    version: PURPOSE_VERSION,
    carrier: String(src.carrier ?? 'qq'),
    lastFireAt: Number(src.lastFireAt) || 0,
    dailyDate: String(src.dailyDate ?? ''),
    dailyCount: Number(src.dailyCount) || 0,
    tried,
    resolved: Array.isArray(src.resolved) ? src.resolved.filter((x) => typeof x === 'string').slice(-200) : []
  };
}
