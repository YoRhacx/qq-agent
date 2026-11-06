/**
 * 每日额度（双单位：人民币 + token）：决定「今天还能不能继续开口」。
 *
 * 为什么要把这件事从桥接里拎出来：额度判定会被两处用到 ——
 *   · 主动机会检查（scheduleProactiveCheckV2）要据此决定「还叫不叫醒自己」；
 *   · 唤醒提示词要据此告诉模型「今天该收敛了」。
 * 如果两处各写一遍阈值，迟早出现「提示词说没到、排程说超了」的互相打脸。
 *
 * 口径（与 SurfCore token-budget 对齐，但只取我们真的需要的那部分）：
 *   · 金额与 token 两个单位**各自独立**比较，谁先到阈值谁触发；两个都设了就取更紧的那个。
 *   · 默认 80% 提醒（只提醒，不拦），100% 拦截（主动机会不再排、提示词要求收敛）。
 *   · 「今天」= 本地自然日（零点切），不是滚动 24 小时：这样用户对账时不用心算。
 *
 * 本模块是纯函数 + 零 I/O：读账本、落盘、发消息都留给 bridge.js。
 */

export const BUDGET_VERSION = 1;
/** 默认提醒线；到线只在提示词/日志里提一句，不拦。 */
export const ALERT_RATIO = 0.8;
/** 默认拦截线；到线就不再主动开口。 */
export const STOP_RATIO = 1;

export const DEFAULT_BUDGET_CONFIG = Object.freeze({
  enabled: true,
  // 注入提示词：warn/stop 时给模型一句「今天省着点」
  inject: true,
  // 到 100% 时不再安排主动机会检查（被动回复不受影响）
  gateProactive: true,
  // 两个单位都可以留 null 表示不限；两个都为 null 等于关掉
  dailyCny: 8,
  dailyTokens: null,
  warnRatio: ALERT_RATIO,
  stopRatio: STOP_RATIO,
  promptMaxChars: 320
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

function normalizeCny(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10000) / 10000;
}

function normalizeTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** 解析金额输入：`¥8` / `8元` / `8` 都行；空串 = 不限；无法解析返回 undefined。 */
export function parseCnyText(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/[¥￥]/g, '')
    .replace(/(?:人民币|元|块|CNY|cny)/gi, '')
    .replace(/[,\s，]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  return normalizeCny(Number(cleaned));
}

/** 解析 token 输入：`8000000` / `8M` / `2万` / `1.5亿` 都行；空串 = 不限；无法解析返回 undefined。 */
export function parseTokenText(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/(?:tokens?|个)/gi, '')
    .replace(/[,\s，]/g, '')
    .toLowerCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(k|m|b|万|亿)?$/);
  if (!match) return undefined;
  const mult = match[2] === 'k' ? 1e3
    : match[2] === 'm' ? 1e6
      : match[2] === 'b' ? 1e9
        : match[2] === '万' ? 1e4
          : match[2] === '亿' ? 1e8
            : 1;
  const n = Number(match[1]) * mult;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 统一配置；字符串输入按「元」解释（历史写法 `tokenBudget: "8"`），非法阈值回落到默认。 */
export function normalizeBudgetConfig(input, fallback = DEFAULT_BUDGET_CONFIG) {
  const base = isPlainObject(fallback) ? fallback : DEFAULT_BUDGET_CONFIG;
  const raw = isPlainObject(input) ? input : {};
  const cnyRaw = raw.dailyCny !== undefined ? raw.dailyCny : (typeof input === 'string' || typeof input === 'number' ? input : base.dailyCny);
  const tokRaw = raw.dailyTokens !== undefined ? raw.dailyTokens : base.dailyTokens;
  const warn = Number(raw.warnRatio);
  const stop = Number(raw.stopRatio);
  const promptMax = Number(raw.promptMaxChars);
  return {
    version: BUDGET_VERSION,
    enabled: raw.enabled === undefined ? base.enabled !== false : raw.enabled !== false,
    inject: raw.inject === undefined ? base.inject !== false : raw.inject !== false,
    gateProactive: raw.gateProactive === undefined ? base.gateProactive !== false : raw.gateProactive !== false,
    dailyCny: typeof cnyRaw === 'number' ? normalizeCny(cnyRaw) : parseCnyText(cnyRaw) ?? null,
    dailyTokens: typeof tokRaw === 'number' ? normalizeTokens(tokRaw) : parseTokenText(tokRaw) ?? null,
    warnRatio: clamp(Number.isFinite(warn) && warn > 0 ? warn : base.warnRatio, 0.05, 0.99),
    stopRatio: clamp(Number.isFinite(stop) && stop > 0 ? stop : base.stopRatio, 0.5, 5),
    promptMaxChars: clamp(Number.isFinite(promptMax) && promptMax > 0 ? promptMax : base.promptMaxChars, 80, 2000)
  };
}

export function normalizeUsage(input) {
  const raw = isPlainObject(input) ? input : {};
  return {
    cost: Math.max(0, Number(raw.cost) || 0),
    tokens: Math.max(0, Number(raw.tokens) || 0)
  };
}

export function ratioOf(used, limit) {
  const l = Number(limit);
  if (!Number.isFinite(l) || l <= 0) return null;
  return Math.max(0, Number(used) || 0) / l;
}

export function formatCny(value) {
  const n = Math.max(0, Number(value) || 0);
  return '¥' + n.toFixed(2);
}

export function formatTokens(value) {
  return String(Math.max(0, Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 额度判定。
 * @returns {{level:'off'|'ok'|'warn'|'stop', blocked:boolean, ratios:{cny:number|null,tokens:number|null},
 *            hits:Array<{unit,used,limit,ratio,percent}>, cfg, usage}}
 */
export function evaluateBudget(usage, config = DEFAULT_BUDGET_CONFIG) {
  const cfg = normalizeBudgetConfig(config);
  const used = normalizeUsage(usage);
  const ratios = {
    cny: ratioOf(used.cost, cfg.dailyCny),
    tokens: ratioOf(used.tokens, cfg.dailyTokens)
  };
  const active = [ratios.cny, ratios.tokens].filter((r) => r != null);
  if (!cfg.enabled || !active.length) {
    return { level: 'off', blocked: false, ratios, hits: [], cfg, usage: used };
  }
  const hits = [];
  for (const unit of ['cny', 'tokens']) {
    const limit = unit === 'cny' ? cfg.dailyCny : cfg.dailyTokens;
    const ratio = ratios[unit];
    if (ratio == null) continue;
    if (ratio >= cfg.warnRatio) {
      hits.push({
        unit,
        used: unit === 'cny' ? used.cost : used.tokens,
        limit,
        ratio,
        percent: Math.round(ratio * 1000) / 10
      });
    }
  }
  hits.sort((a, b) => b.ratio - a.ratio);
  const worst = active.length ? Math.max(...active) : 0;
  const level = worst >= cfg.stopRatio ? 'stop' : worst >= cfg.warnRatio ? 'warn' : 'ok';
  return { level, blocked: level === 'stop', ratios, hits, cfg, usage: used };
}

function describeHit(hit) {
  const used = hit.unit === 'cny' ? formatCny(hit.used) : formatTokens(hit.used) + ' token';
  const limit = hit.unit === 'cny' ? formatCny(hit.limit) : formatTokens(hit.limit) + ' token';
  return used + ' / ' + limit + '（' + hit.percent + '%）';
}

/** 一行给人看的状态，日志/端点/控制台共用。 */
export function describeBudget(result) {
  if (!result || result.level === 'off') return 'budget off';
  if (!result.hits.length) {
    const parts = [];
    if (result.ratios.cny != null) parts.push(formatCny(result.usage.cost) + ' / ' + formatCny(result.cfg.dailyCny));
    if (result.ratios.tokens != null) parts.push(formatTokens(result.usage.tokens) + ' / ' + formatTokens(result.cfg.dailyTokens) + ' token');
    return 'budget ok（' + parts.join('；') + '）';
  }
  return 'budget ' + result.level + '（' + result.hits.map(describeHit).join('；') + '）';
}

/**
 * 提示词里那段话。ok/off 时返回空串（不占预算）；
 * warn 只提醒收敛，stop 才明确要求「非必要不开口」。
 */
export function buildBudgetLine(result, config = DEFAULT_BUDGET_CONFIG) {
  const cfg = normalizeBudgetConfig(config);
  if (!cfg.inject || !result || result.level === 'off' || result.level === 'ok') return '';
  const detail = result.hits.length ? result.hits.map(describeHit).join('；') : '';
  const lines = [];
  if (result.level === 'stop') {
    lines.push('【今天的额度用完了】' + detail + '。');
    lines.push('非必要不要再开口：主人直接问你才回，能一句说完就别两句；别主动找人闲聊、别翻旧话题。');
  } else {
    lines.push('【今天额度快到了】' + detail + '。');
    lines.push('省着点：回复短一点，别主动挑话头，能不提的就不提。');
  }
  let text = lines.join('\n');
  if (text.length > cfg.promptMaxChars) text = text.slice(0, cfg.promptMaxChars - 1) + '…';
  return text;
}

/** 本地自然日 key（YYYY-MM-DD），跨零点自动换天。 */
export function dayKeyOf(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 本地当天零点的时间戳。 */
export function localDayStart(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 把 token 账本的逐桶序列折成「今天用了多少」。
 * 桶按 bucketMs 对齐，跨零点那一桶（起点在昨天）整桶不算 —— 宁可少算一点，
 * 也不要把昨天的花费记到今天头上（额度是护栏，不是财务对账）。
 */
export function sumSeriesSince(buckets, since) {
  const from = Number(since) || 0;
  let cost = 0;
  let tokens = 0;
  for (const b of Array.isArray(buckets) ? buckets : []) {
    if (!b || Number(b.t) < from) continue;
    cost += Number(b.cost) || 0;
    tokens += Number(b.tokens) || 0;
  }
  return { cost, tokens };
}

/** 80% 提醒每天只提一次：今天提过就不再提（跨天自动重置）。 */
export function shouldAlert(result, alertDay, now = Date.now()) {
  if (!result || result.level === 'off' || result.level === 'ok') return false;
  return String(alertDay || '') !== dayKeyOf(now);
}
