// 对话收束判定（conversation closure）——纯函数，不碰 fs、不看全局配置。
//
// 为什么需要它：reserved2 里她「什么时候说」由唤醒决定，但「什么时候该停」全靠模型自觉。
// 实际后果是两种：要么对方已经说了「晚安」她还在补一句，要么话题早就枯了但她每轮都硬接。
// 这里把「收尾信号」显式算出来，只有建议权（写进提示词），不替她做决定：
//   continue = 对方还有问题/话题没落地，该回；
//   linger   = 可以再等一条，别急着收，也别硬找话说；
//   close    = 聊完了，可以打住（要留尾巴就记 pendingThought，别在聊天里硬续）。
//
// 红线：对方最后一句是**提问**时永远不给 close —— 那是「有人还在等你说话」，
// 判成收尾会变成已读不回。宁可多回一句，也不能把问句当句号。

export const CLOSURE_VERSION = 1;

export const DEFAULT_CLOSURE_CONFIG = {
  enabled: true,
  inject: true,
  closeScore: 5,
  lingerScore: 3,
  idleMs: 5 * 60 * 1000,
  window: 12,
  farewellWeight: 4,
  shortAckWeight: 2,
  coolingWeight: 2,
  shrinkingWeight: 1
};

export const FAREWELL_RE = /晚安|睡了|睡觉|先睡|拜拜|再见|回头聊|下次聊|改天聊|先这样|我走了|我下了|下班了|去忙|忙去|干饭去|去吃饭/;
export const ACK_RE = /^(嗯+|哦+|好+|好的|行|行吧|收到|哈哈+|hh+|6+|牛|确实|可以|ok|👌|👍|草|笑死)$/i;
export const QUESTION_RE = /[?？]|(吗|呢|么|怎么|为什么|为啥|是不是|有没有|咋|如何|多少|哪[个儿里])[。！!…~～]*$/;

export function normalizeClosureConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: src.enabled !== false,
    inject: src.inject !== false,
    closeScore: num(src.closeScore, DEFAULT_CLOSURE_CONFIG.closeScore, 2, 20),
    lingerScore: num(src.lingerScore, DEFAULT_CLOSURE_CONFIG.lingerScore, 1, 19),
    idleMs: num(src.idleMs, DEFAULT_CLOSURE_CONFIG.idleMs, 30000, 24 * 3600 * 1000),
    window: num(src.window, DEFAULT_CLOSURE_CONFIG.window, 4, 40),
    farewellWeight: num(src.farewellWeight, DEFAULT_CLOSURE_CONFIG.farewellWeight, 0, 10),
    shortAckWeight: num(src.shortAckWeight, DEFAULT_CLOSURE_CONFIG.shortAckWeight, 0, 10),
    coolingWeight: num(src.coolingWeight, DEFAULT_CLOSURE_CONFIG.coolingWeight, 0, 10),
    shrinkingWeight: num(src.shrinkingWeight, DEFAULT_CLOSURE_CONFIG.shrinkingWeight, 0, 10)
  };
}

function textOf(msg) {
  return String(msg?.plain ?? msg?.text ?? '').trim();
}

// 入站消息记的是 time，她自己发的（recordSelfMessageV2 等路径）记的是 at —— 两种都认，
// 否则冷场信号在「最后一条是我说的」时永远算不出来。
function timeOf(msg) {
  return Number(msg?.time ?? msg?.at ?? 0) || 0;
}

function isQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return QUESTION_RE.test(t);
}

/**
 * 判定这段对话该不该收。
 * @param {{messages?: Array<{isSelf?:boolean,text?:string,plain?:string,time?:number}>, now?: number, config?: object}} input
 */
export function analyzeClosure({ messages = [], now = Date.now(), config = {} } = {}) {
  const cfg = normalizeClosureConfig(config);
  const all = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  const recent = all.slice(-cfg.window);
  const base = { action: 'continue', score: 0, openQuestion: false, signals: [], cfg };

  if (!cfg.enabled || recent.length === 0) return base;

  const theirs = recent.filter((m) => !m.isSelf);
  const last = recent[recent.length - 1];
  const lastThem = theirs[theirs.length - 1] || null;
  const lastThemText = lastThem ? textOf(lastThem) : '';
  const lastText = textOf(last);
  const lastTime = timeOf(last);
  const signals = [];
  let score = 0;

  // 1) 对方最后一句是问句：永远不收，这是「有人还在等你说话」
  const openQuestion = !last.isSelf && isQuestion(lastText);
  if (openQuestion) {
    return {
      action: 'continue',
      score: 0,
      openQuestion: true,
      signals: [{ id: 'open-question', weight: 0, label: '对方最后一句是提问，还没人回答' }],
      cfg
    };
  }

  // 2) 明确的告别/收摊：这一条单独就该收，不跟其他信号凑分。
  //    「晚安」之后再补一句是最典型的画蛇添足，凑阈值会让它恰好漏掉。
  if (lastThem && FAREWELL_RE.test(lastThemText)) {
    signals.push({ id: 'farewell', weight: cfg.farewellWeight, label: `对方说了「${lastThemText.slice(0, 12)}」` });
    return { action: 'close', score: cfg.farewellWeight, openQuestion: false, signals, cfg };
  }

  // 3) 短确认（嗯/好/6/哈哈）：话题已经落地，没有新信息
  if (lastThem && lastThemText.length <= 6 && ACK_RE.test(lastThemText)) {
    signals.push({ id: 'short-ack', weight: cfg.shortAckWeight, label: `对方只回了「${lastThemText}」` });
    score += cfg.shortAckWeight;
  }

  // 4) 冷场：最后一条已经过去 idleMs，一直没人再说
  const idle = lastTime > 0 ? Math.max(0, now - lastTime) : 0;
  if (idle >= cfg.idleMs && !openQuestion) {
    signals.push({ id: 'cooling', weight: cfg.coolingWeight, label: `已经 ${Math.round(idle / 60000)} 分钟没有新消息` });
    score += cfg.coolingWeight;
  }

  // 5) 对方话越说越短（最后三条长度递减且最后一条很短）：兴致在退
  const lastThree = theirs.slice(-3);
  if (lastThree.length === 3) {
    const lens = lastThree.map((m) => textOf(m).length);
    if (lens[0] > lens[1] && lens[1] > lens[2] && lens[2] <= 10 && lens[2] > 0) {
      signals.push({ id: 'shrinking', weight: cfg.shrinkingWeight, label: '对方越说越短' });
      score += cfg.shrinkingWeight;
    }
  }

  // 6) 她刚问了一句、对方还没答：这时收尾等于把问题吞了
  const awaitingAnswer = !!last.isSelf && isQuestion(lastText);
  if (awaitingAnswer) {
    signals.push({ id: 'awaiting-answer', weight: 0, label: '你刚问了一句，对方还没答' });
  }

  let action = 'continue';
  if (score >= cfg.closeScore && !awaitingAnswer) action = 'close';
  else if (score >= cfg.lingerScore || awaitingAnswer) action = score > 0 || awaitingAnswer ? 'linger' : 'continue';

  return { action, score, openQuestion, signals, cfg };
}

/** 把判定结果写成一行人话，塞进唤醒提示词。continue 时返回空串（不占提示词）。 */
export function buildClosureLine(result, config = {}) {
  const cfg = normalizeClosureConfig(config);
  if (!cfg.enabled || !cfg.inject) return '';
  const r = result || {};
  if (r.action === 'continue') {
    if (!r.openQuestion) return '';
    return '【对话收束】对方最后一句是提问，别当没看见——要回。';
  }
  const why = (r.signals || []).map((s) => s.label).filter(Boolean).slice(0, 3).join('；');
  if (r.action === 'close') {
    return [
      '【对话收束】这段已经到站了' + (why ? '（' + why + '）' : '') + '。',
      '- 不用再补一句“晚安/好梦/先这样”，也别硬找新话题；真要说，最多一句。',
      '- 想留个尾巴（还没说完的事、约好的下次），用 qq_memory_append 记一条 pendingThought，下次想起来再说。'
    ].join('\n');
  }
  return [
    '【对话收束】先别急着收' + (why ? '（' + why + '）' : '') + '：',
    '- 可以再等一条；对方问了/接了话就正常回，别为了“显得忙”自己找话。'
  ].join('\n');
}

/** 控制台/日志用的一行摘要。 */
export function describeClosure(result) {
  const r = result || {};
  const why = (r.signals || []).map((s) => s.id).join(',') || 'none';
  return `${r.action || 'continue'} score=${r.score || 0} signals=${why}`;
}
