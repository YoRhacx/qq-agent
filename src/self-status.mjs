// 自省（self-status）：把「机器人自己现在的状态、花了多少钱、限流还剩多少」整理成一小段
// 给模型看的文本，让它在**说话之前**知道自己有多贵、还能说几句。
//
// 设计边界：
//   - **纯函数**：只吃普通数据（由 bridge.js 从 cfg / socialV2 状态 / tokens 摘要里取出），
//     不 import bridge.js、不读文件、不发网络请求 —— 这样它能单独测试，也不会把桥接的
//     内部状态耦合进一个"展示层"模块。
//   - 输出有硬上限（默认 1200 字）：它会进 prompt，每多一个字都是每轮都要付的输入 token。
//   - 缺字段一律降级省略，不抛错：自省工具本身不该成为新的故障点。

/** 文本硬上限（字）。超过就截断，避免自省成本反噬。 */
export const SELF_STATUS_MAX_CHARS = 1200;

/** 花费告警阈值（元）：超过就在建议里点名，提醒模型收着点。 */
export const SELF_STATUS_COST_WARN_YUAN = 3;

/** 把毫秒差说成人话：`3 分钟前` / `2 小时后`。 */
export function humanAgo(ms, now = Date.now()) {
  return humanDelta(Number(ms) - now);
}

/** 把「+ms 表示未来、-ms 表示过去」的差值说成人话。 */
export function humanDelta(deltaMs) {
  if (!Number.isFinite(deltaMs)) return '';
  const abs = Math.abs(deltaMs);
  const past = deltaMs < 0;
  const units = [
    [86400000, '天'],
    [3600000, '小时'],
    [60000, '分钟'],
    [1000, '秒']
  ];
  for (const [unit, label] of units) {
    if (abs >= unit) {
      const n = Math.floor(abs / unit);
      return past ? `${n} ${label}前` : `${n} ${label}后`;
    }
  }
  return past ? '刚刚' : '马上';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (part, total) => {
  const p = num(part);
  const t = num(total);
  if (p == null || !t) return null;
  return Math.round((p / t) * 100);
};

/** 限流段的「已用/上限」写法；上限为 0 视为不限流，不显示。 */
function limitBit(label, used, cap) {
  const c = num(cap);
  const u = num(used) ?? 0;
  if (c == null || c <= 0) return null;
  const left = Math.max(0, c - u);
  return `${label} ${u}/${c}（剩 ${left}）`;
}

/**
 * 组装自省摘要。
 *
 * @param {object} input 全部字段可选：
 *   { key, mode, role, paused, dshReady, sessionId, provider, model, reasoningEffort,
 *     snowluma:{connected,accountOnline,good,degraded,lastPacketAgoMs},
 *     wake:{usedMinute,capMinute,usedHour,capHour,config:{mode,infinite,sleepUntil}},
 *     voiceLimits:{usedMinute,capMinute,usedHour,capHour},
 *     imageLimits:{usedMinute,capMinute,usedHour,capHour},
 *     waiting:boolean, busy:boolean, pendingWakeReasons:number,
 *     tts:{voice,provider}, reminders:{pending,nextDueAt},
 *     cost:{currency,symbol,todayCost,turns,steps,cacheHitTokens,cacheMissTokens,outputTokens,estimated},
 *     now }
 * @returns {{ok:true,text:string,data:object,warnings:string[],truncated:boolean}}
 */
export function buildSelfStatus(input = {}) {
  const now = num(input.now) ?? Date.now();
  const warnings = [];
  const lines = [];

  // ── 运行面 ────────────────────────────────────────────────────────────
  const runBit = [];
  if (input.mode) runBit.push(`模式 ${input.mode}`);
  if (input.role) runBit.push(`角色 ${input.role}`);
  if (input.dshReady !== undefined) runBit.push(`DSH ${input.dshReady ? '就绪' : '未就绪'}`);
  if (input.paused !== undefined) runBit.push(input.paused ? '⚠ 已暂停' : '未暂停');
  if (runBit.length) lines.push(`【运行】${runBit.join(' ｜ ')}`);

  const sl = input.snowluma ?? {};
  const slBit = [];
  if (sl.connected !== undefined) slBit.push(sl.connected ? '已连接' : '⚠ 未连接');
  if (sl.accountOnline !== undefined) slBit.push(sl.accountOnline ? '账号在线' : '⚠ 账号离线');
  if (sl.degraded) slBit.push('⚠ 降级');
  if (num(sl.lastPacketAgoMs) != null) slBit.push(`上次心跳 ${humanDelta(-num(sl.lastPacketAgoMs))}`);
  if (slBit.length) lines.push(`【SnowLuma】${slBit.join(' ｜ ')}`);

  // ── 本会话 / 模型 ─────────────────────────────────────────────────────
  const sesBit = [];
  if (input.key) sesBit.push(input.key);
  if (input.sessionId) sesBit.push(`会话 ${String(input.sessionId).slice(0, 8)}`);
  if (input.provider || input.model) sesBit.push(`模型 ${[input.provider, input.model].filter(Boolean).join('/')}${input.reasoningEffort ? `（${input.reasoningEffort}）` : ''}`);
  if (sesBit.length) lines.push(`【本会话】${sesBit.join(' ｜ ')}`);

  // ── 花费 ──────────────────────────────────────────────────────────────
  const c = input.cost ?? {};
  const sym = String(c.symbol ?? '¥');
  const costBit = [];
  if (num(c.todayCost) != null) costBit.push(`今天 ${sym}${num(c.todayCost).toFixed(2)}${c.estimated ? '（估）' : ''}`);
  if (num(c.turns) != null) costBit.push(`${num(c.turns)} 轮${num(c.steps) != null ? ` / ${num(c.steps)} 步` : ''}`);
  const hit = num(c.cacheHitTokens);
  const miss = num(c.cacheMissTokens);
  const hitRate = pct(hit, (hit ?? 0) + (miss ?? 0));
  if (hitRate != null) costBit.push(`缓存命中 ${hitRate}%`);
  if (miss != null) costBit.push(`miss ${(miss / 1000).toFixed(0)}K`);
  if (hit != null) costBit.push(`hit ${(hit / 1000).toFixed(0)}K`);
  if (num(c.outputTokens) != null) costBit.push(`输出 ${(num(c.outputTokens) / 1000).toFixed(0)}K`);
  if (costBit.length) lines.push(`【花费】${costBit.join(' ｜ ')}`);

  // ── 限流 / 等待 ───────────────────────────────────────────────────────
  const w = input.wake ?? {};
  const limBit = [
    limitBit('唤醒/分', w.usedMinute, w.capMinute),
    limitBit('唤醒/时', w.usedHour, w.capHour),
    limitBit('语音/分', input.voiceLimits?.usedMinute, input.voiceLimits?.capMinute),
    limitBit('语音/时', input.voiceLimits?.usedHour, input.voiceLimits?.capHour),
    limitBit('图片/分', input.imageLimits?.usedMinute, input.imageLimits?.capMinute),
    limitBit('图片/时', input.imageLimits?.usedHour, input.imageLimits?.capHour)
  ].filter(Boolean);
  const wc = w.config ?? {};
  if (wc.mode || wc.infinite !== undefined) {
    const modeText = wc.mode === 'active' ? '活跃' : '潜水';
    const timeText = wc.infinite ? '无限期' : (wc.sleepUntil ? `至 ${new Date(wc.sleepUntil).toLocaleString('zh-CN', { hour12: false })}` : '未设时间');
    limBit.unshift(`当前唤醒配置 ${modeText}/${timeText}`);
  }
  if (input.waiting) limBit.push('正有一个等待工具在挂');
  if (input.busy) limBit.push('⚠ 有回合在进行中');
  if (num(input.pendingWakeReasons) > 0) limBit.push(`暂存唤醒 ${num(input.pendingWakeReasons)} 条`);
  if (limBit.length) lines.push(`【额度与等待】${limBit.join(' ｜ ')}`);

  // ── 多模态默认值 / 提醒 ───────────────────────────────────────────────
  const tts = input.tts ?? {};
  const misc = [];
  if (tts.voice) misc.push(`默认音色 ${tts.voice}${tts.provider ? `（${tts.provider}）` : ''}`);
  const rem = input.reminders ?? {};
  if (num(rem.pending) != null) {
    const next = num(rem.nextDueAt);
    misc.push(`待触发提醒 ${num(rem.pending)} 条${next ? `（最近 ${humanDelta(next - now)}）` : ''}`);
  }
  if (misc.length) lines.push(`【其它】${misc.join(' ｜ ')}`);

  // ── 建议（这是这个工具真正的用处） ────────────────────────────────────
  const tips = [];
  const modelText = `${input.provider ?? ''}/${input.model ?? ''}`;
  if (input.provider && !/qodercn|deepseek/i.test(String(input.provider))) {
    tips.push(`⚠ 当前 provider 是 ${input.provider}，不是缓存友好的 qodercn/deepseek 通道：这一轮尽量短、少调工具`);
    warnings.push('provider-not-cache-friendly');
  }
  if (hitRate != null && hitRate < 50 && (num(c.turns) ?? 0) >= 3) {
    tips.push(`缓存命中只有 ${hitRate}%，重复读大文件/长上下文会很贵：能靠已有信息回答就别再翻`);
    warnings.push('low-cache-hit');
  }
  if (num(c.todayCost) != null && num(c.todayCost) >= SELF_STATUS_COST_WARN_YUAN) {
    tips.push(`今天已经花了 ${sym}${num(c.todayCost).toFixed(2)}：非必要的联网/长回复先忍一忍`);
    warnings.push('cost-warn');
  }
  const capMinute = num(w.capMinute);
  const usedMinute = num(w.usedMinute) ?? 0;
  if (capMinute != null && capMinute > 0 && usedMinute / capMinute >= 0.8) {
    tips.push(`唤醒额度只剩 ${Math.max(0, capMinute - usedMinute)} 次/分：这轮别再多说，挑重点回`);
    warnings.push('wake-quota-low');
  }
  if (input.paused || input.dshReady === false) {
    tips.push('⚠ DSH 未就绪或已暂停：现在发不出消息，先别承诺回复');
    warnings.push('bridge-not-ready');
  }
  if (num(rem.pending) === 0 && input.remindersExplicit === true) tips.push('当前没有待触发提醒');
  if (tips.length) lines.push(`【建议】${tips.join('；')}`);
  else lines.push('【建议】一切正常，按角色正常说话即可');

  const raw = lines.join('\n');
  const truncated = raw.length > SELF_STATUS_MAX_CHARS;
  const text = truncated ? `${raw.slice(0, SELF_STATUS_MAX_CHARS - 1)}…` : raw;

  return {
    ok: true,
    text,
    truncated,
    warnings,
    data: {
      key: input.key ?? null,
      mode: input.mode ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      costToday: num(c.todayCost),
      cacheHitRate: hitRate,
      wakeUsedMinute: usedMinute,
      wakeCapMinute: capMinute,
      waiting: Boolean(input.waiting),
      busy: Boolean(input.busy),
      pendingReminders: num(rem.pending)
    }
  };
}

export default buildSelfStatus;
