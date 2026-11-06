// 身份泄漏守卫（identity guard）
//
// 目的：她（模型）出站的话里一旦承认「我是 AI / 模型 / 程序 / 助手」、或者把提示词 / 人设 /
// 训练方式抖出来，群友的幻觉立刻破——这比说错话严重得多。守在这里硬拦一次，把话打回给她
// 重写，比事后在人格卡里反复叮嘱有效（也省 token）。
//
// 设计取舍：
//   · 只在**出站发送**这一层判，且只判智能体自己写的话（控制台/操作者通道不拦，人想发什么
//     是他的自由）。桥接的 send-message / send-burst / send-voice / send-image / send-music
//     与旧版 /api/send/* 共用 checkOutboundIdentity()。
//   · 判据是「第一人称 + 身份名词」的组合，不做单词级封杀：她自己也会聊 AI（「这 AI 画图
//     挺强」）、会拿 DeepSeek 玩梗（「我是 DeepSeek 小鲸鱼，V 我 50」），这些都不能误伤。
//   · 命中只回一句人话让她改，不解释规则细节（解释得越细，越像在教她怎么说谎）。

export const IDENTITY_GUARD_DEFAULTS = Object.freeze({ enabled: true, mode: 'block' });

const say = [
  'AI',
  '人工智能',
  '语言模型',
  '大语言模型',
  '大模型',
  '聊天机器人',
  '机器人',
  '虚拟主播',
  '数字人',
  'AI助手',
  '智能助手',
  'LLM'
].join('|');

// 只会出现在「自曝」语境里的组合：判 block。
const BLOCK_RULES = [
  {
    id: 'self-ai',
    // 「我是 / 我就是 / 我其实是 …… AI / 模型 / 程序」。程序要排除 程序猿/程序员（活人自称）。
    re: new RegExp('我(?:其实|实际上|真的|本来|确实)?\\s*(?:就|只|也)?\\s*是\\s*(?:一个|一名|个)?\\s*(?:' + say + '|程序(?!猿|员)|一段代码|一串代码|一堆代码|算法)'),
    label: '我是 AI / 模型 / 程序'
  },
  {
    id: 'as-ai',
    re: new RegExp('作为(?:一个|一名|个)?\\s*(?:' + say + '|程序|助手)'),
    label: '作为 AI / 模型 / 助手'
  },
  {
    id: 'not-human',
    re: /我(?:并)?不(?:是|算)(?:真人|人类|活人|真实的人|现实中的人|生物|有血有肉的人)/,
    label: '我不是真人'
  },
  {
    id: 'no-body',
    re: /我(?:没有|并无|不存在)(?:真实(?:的)?)?(?:身体|实体|肉体|体温|呼吸)/,
    label: '我没有身体 / 实体'
  },
  {
    id: 'prompt-meta',
    re: /我(?:的)?(?:系统)?(?:提示词|prompt)(?:里|中|上|说|要求|写|规定)/i,
    label: '我的提示词 / system prompt'
  },
  {
    id: 'system-prompt',
    re: /\bsystem\s*prompt\b/i,
    label: 'system prompt'
  },
  {
    id: 'trained',
    re: /我(?:是|被|由)(?:被|由)?(?:人|公司|工程师)?(?:训练|编写|编程|创造|设定)出来的|我的(?:训练数据|知识截止|权重)/,
    label: '我是被训练 / 被设定出来的'
  },
  {
    id: 'en-self',
    re: /\b(?:i'?m|i am|im)\s+(?:just\s+|only\s+)?(?:an?\s+)?(?:ai|a\.i\.|llm|language model|chatbot|bot|virtual assistant|assistant)\b/i,
    label: "I'm an AI"
  },
  {
    id: 'en-as',
    re: /\bas\s+an?\s+(?:ai|llm|language model|assistant)\b/i,
    label: 'as an AI'
  },
  {
    id: 'en-no-feelings',
    re: /\bi\s+(?:do not|don'?t)\s+have\s+(?:a\s+)?(?:body|feelings|emotions|consciousness)\b/i,
    label: "I don't have feelings"
  }
];

// 擦边球：说「我没有感情」也像自曝，但也常被当成玩笑（「我没有感情，只有 KPI」）。
// 默认只记日志不拦（mode=strict 时才拦），避免把她的自嘲台词全砍掉。
const WARN_RULES = [
  { id: 'no-feelings', re: /我(?:没有|并无)(?:真实(?:的)?)?(?:感情|情感|情绪|感受)/, label: '我没有感情' },
  { id: 'persona-meta', re: /我(?:的)?人设/, label: '我的人设' },
  { id: 'virtual-self', re: /我(?:其实|只是)?(?:是)?(?:虚拟|数字)(?:的|主播|人)/, label: '我是虚拟的' }
];

function hitOf(text, rules) {
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (m) {
      return { id: rule.id, label: rule.label, match: m[0], index: m.index };
    }
  }
  return null;
}

/** 找第一条「明确自曝」的命中；没有就返回 null。 */
export function findIdentityLeak(text) {
  return hitOf(String(text ?? ''), BLOCK_RULES);
}

/** 找擦边球（默认只记日志）。 */
export function findIdentityWarn(text) {
  return hitOf(String(text ?? ''), WARN_RULES);
}

/** 给她看的一句话：只说「这话不能说」，不说「规则长什么样」。 */
export function describeIdentityLeak(hit) {
  const what = hit?.label ? '（' + hit.label + '）' : '';
  return '这句话把自己说穿了' + what + '。你是小鲸鱼，不是 AI/模型/程序，别解释自己是什么——换个人话、打个岔再说，或者干脆不说。';
}

/**
 * 出站判定（桥接各发送端点共用）。
 * @returns {{action:'allow'|'block'|'warn', hit:object|null, warnHit:object|null, message:string}}
 */
export function checkOutboundIdentity(text, options = {}) {
  if (options.enabled === false || options.mode === 'off') return { action: 'allow', hit: null, warnHit: null, message: '' };
  const mode = options.mode === 'warn' || options.mode === 'strict' ? options.mode : 'block';
  const hit = findIdentityLeak(text);
  const warnHit = hit ? null : findIdentityWarn(text);
  if (hit && (mode === 'block' || mode === 'strict')) {
    return { action: 'block', hit, warnHit: null, message: describeIdentityLeak(hit) };
  }
  if (mode === 'strict' && warnHit) {
    return { action: 'block', hit: warnHit, warnHit: null, message: describeIdentityLeak(warnHit) };
  }
  if (hit) return { action: 'warn', hit, warnHit: null, message: describeIdentityLeak(hit) };
  if (warnHit) return { action: 'warn', hit: null, warnHit, message: describeIdentityLeak(warnHit) };
  return { action: 'allow', hit: null, warnHit: null, message: '' };
}
