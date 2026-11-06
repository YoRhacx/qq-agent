// 文学性的「尺子」（literary score）
//
// 为什么要有这个模块：主人问「怎么训练她的文学性」，答案是**不训练**——托管模型没有权重，
// 能改的只有送进去的上下文。但没有尺子就没法判断「改得更好还是更差」：人格卡加两句诗、
// 换一个风格块，到底是有画面了还是更 AI 了，全凭感觉。这里把「写得好」拆成五件可数的
// 事，再减掉一类可数的坏习惯，给 0~100 分。一条都不调模型，纯函数，毫秒级。
//
// 五件好事（各自 0~1，按权重加权）：
//   concreteness 具体性 —— 有没有可被看见的东西（猫、雨、锅、雪糕、拖鞋），而不是「情感/意义」这种空气名词
//   imagery      画面   —— 比喻、感官词、带量词的数字（三片肉、第七根、四百三十二步）
//   rhythm       节奏   —— 句长有起伏（长短句交替），而不是一路 20 字长句或一路四个字
//   texture      质感   —— 标点有变化、不自噬（三字重复）、不憋出 40 字不带标点的长句
//   voice        人味   —— 语气词、口语动词、第一/第二人称、问句感叹句
// 一类坏习惯：
//   slop         AI 腔 —— 仿佛/不禁/宛如/一丝/涌上心头/岁月的长河…，占比越高扣得越狠
//
// 有意**不做**的事：不判「好不好看」「合不合人设」。这两件只有主人能判。尺子只回答
// 「这段话里有没有具体的东西、有没有画面、读起来喘不喘得过气」。
//
// 用法：
//   import { scoreText } from './literary-score.js';
//   const r = scoreText('食堂的辣椒炒肉，肉三片，辣椒一盘。');
//   r.total → 0~100，r.band → '有画面' / '有味道' / '勉强' / '平' / '干瘪'，r.metrics.xxx
//
// 词表都在文件下半截，按「加词就能改分」的方式组织：想让它更看重画面，往 CONCRETE 里加词，
// 想让某类 AI 腔扣分更狠，往 SLOP_MARKERS 里加。改完跑 scripts/test-literary-score.mjs，
// 再跑 npm run eval:literary 看 40 条基准还分不分得开。

export const LITERARY_VERSION = 1;

export const DEFAULT_LITERARY_CONFIG = Object.freeze({
  // 五项权重（会归一化，不必凑成 1）
  weights: Object.freeze({ concreteness: 0.30, imagery: 0.22, rhythm: 0.16, texture: 0.12, voice: 0.20 }),
  // AI 腔对总分的最大折扣：slop=1 时留下 (1 - 0.8) = 20%
  slopPenalty: 0.85,
  // 分档（从高到低匹配）
  bands: Object.freeze([
    Object.freeze([70, '有画面']),
    Object.freeze([55, '有味道']),
    Object.freeze([40, '勉强']),
    Object.freeze([25, '平']),
    Object.freeze([0, '干瘪'])
  ]),
  // 各指标的「饱和度」拐点：密度到这个值时拿一半分
  knees: Object.freeze({ concreteness: 0.055, imagery: 6, voice: 1.1, slop: 3.0 })
});

const round1 = (x) => Math.round(x * 10) / 10;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 饱和函数：x 越大越接近 1，knee 处正好 0.5。 */
const sat = (x, knee) => (x <= 0 ? 0 : x / (x + knee));

/** 语句切分：先在句末标点/换行处切，再在逗号顿号处切（短句也算一句）。 */
const SENT_SPLIT_RE = /[。！？!?…~～\n]+/;
const CLAUSE_SPLIT_RE = /[，,、；;：:]+/;

/** 标点（用来算密度时分母剥掉，也用来算标点多样性）。 */
const PUNCT_RE = /[。，、；：！？…—～·,.!?;:~]/g;
const PUNCT_KINDS = ['。', '，', '、', '？', '！', '…', '—', '～', '；', '：'];

export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}

/** 去掉标点与空白后的长度，做密度分母。 */
export function bodyLength(text) {
  const s = String(text ?? '').replace(PUNCT_RE, '').replace(/\s/g, '');
  return charCount(s);
}

export function stripPunct(text) {
  return String(text ?? '').replace(PUNCT_RE, '').replace(/\s/g, '');
}

// ── 匹配小工具 ──────────────────────────────────────────────────────────────
/** 最长优先、不重叠地数词表命中，返回 {count, hits:[词...], chars:命中字符数}。 */
export function matchTerms(text, terms) {
  const s = String(text ?? '');
  const sorted = terms.slice().sort((a, b) => b.length - a.length);
  const hits = [];
  let chars = 0;
  let i = 0;
  while (i < s.length) {
    let found = '';
    for (const term of sorted) {
      if (term && s.startsWith(term, i)) { found = term; break; }
    }
    if (found) {
      hits.push(found);
      chars += charCount(found);
      i += found.length;
    } else {
      i += 1;
    }
  }
  return { count: hits.length, hits, chars };
}

/** 不重叠地数某个词出现几次。 */
export function countTerm(text, term) {
  return matchTerms(text, [term]).count;
}

// ── 词表 ────────────────────────────────────────────────────────────────────
// 具体名词：能被看见/摸到/吃到的。不是「所有名词」——抽象名词在 slop 那侧扣分。
export const CONCRETE = Object.freeze([
  '猫', '狗', '橘猫', '野狗', '金鱼', '鲸鱼', '麻雀', '鸽子', '蚊子', '苍蝇', '蟑螂', '蚂蚁',
  '雨', '雪', '风', '太阳', '月亮', '星星', '云', '雷', '雾', '霜', '冰',
  '水', '汤', '粥', '饭', '面', '面条', '泡面', '饺子', '包子', '馒头', '面包', '饼干', '雪糕',
  '糖', '辣椒', '肉', '鸡蛋', '番茄', '土豆', '韭菜', '蒜', '姜', '酱油', '醋', '盐',
  '锅', '锅盖', '碗', '筷', '筷子', '勺', '盘子', '菜刀', '案板', '微波炉', '电饭锅', '冰箱',
  '空调', '洗衣机', '拖把', '扫帚', '垃圾桶', '垃圾袋', '塑料袋', '纸箱', '快递盒',
  '桌', '桌子', '椅', '椅子', '凳', '沙发', '茶几', '床', '枕头', '被子', '门', '窗', '窗帘',
  '阳台', '楼道', '楼梯', '电梯', '床单', '插座', '充电器', '数据线', '充电宝', '遥控器',
  '电视', '路由器', '灯', '路灯', '台灯', '开关', '钟', '闹钟', '日历', '镜子', '梳子',
  '牙刷', '毛巾', '肥皂', '马桶', '浴缸',
  '手机', '屏幕', '键盘', '耳机', '书包', '纸', '笔', '书', '本子', '钱包', '钥匙', '身份证',
  '公交卡', '零钱', '硬币', '小票',
  '烟', '烟灰缸', '酒', '啤酒', '茶', '咖啡', '奶茶', '饮料', '保温杯', '杯子',
  '车', '地铁', '公交', '自行车', '电动车', '路', '马路', '红绿灯', '井盖', '公交站',
  '天桥', '斑马线', '路牙', '楼', '广场', '菜市场', '超市', '便利店', '小卖部', '食堂',
  '医院', '教室', '办公室', '工位', '打卡机', '快递', '外卖',
  '大学', '宿舍', '床铺', '课', '作业', '考试', '老师', '同学', '游戏', '教程', '火腿肠', '铃',
  '铃声', '朋友圈', '聊天记录', '作业本', '宿舍楼',
  '树', '草', '花', '叶子', '土', '石头', '沙子', '桂花', '槐花', '柳树', '梧桐', '麦子',
  '稻子', '玉米', '红薯', '南瓜', '冬瓜', '西瓜', '苹果', '梨', '橘子', '香蕉', '葡萄',
  '草莓', '荔枝', '柚子',
  '海', '沙滩', '浪', '船', '鱼', '虾', '螃蟹', '贝壳', '风铃', '伞', '雨伞', '雨衣',
  '水坑', '泥',
  '外套', '围巾', '帽子', '袜子', '鞋', '拖鞋', '球鞋', '口罩', '手套', '手指', '眼睛',
  '头发', '脸', '脚', '伤口', '药', '创可贴',
  '游戏机', '手柄', '球', '跑道', '操场', '麻将', '扑克', '棋盘'
]);

// 抽象名词：不是罪，但堆多了就是「空气话」。只在 slop 里按密度扣。
export const ABSTRACT = Object.freeze([
  '情感', '意义', '生命', '灵魂', '力量', '希望', '温暖', '世界', '时间', '命运', '成长',
  '回忆', '思念', '孤独', '温柔', '岁月', '人生', '梦想', '自由', '执念', '宁静', '感动',
  '幸福', '悲伤', '痛苦', '情绪', '感受', '存在', '永恒', '遥远', '沉默', '归宿', '缘分',
  '宿命', '信仰'
]);

// 画面：比喻的起手式。只数「像/好像/如同/活像/好比」这类**明喻**，
// 因为「仿佛/宛如」几乎只在 AI 腔里出现，放 SLOP_MARKERS 那边扣分。
export const SIMILE_MARKERS = Object.freeze(['像', '好像', '如同', '犹如', '好比', '活像', '似的', '一样']);

// 感官词：读起来有身体感的。
export const SENSE = Object.freeze([
  '听', '闻', '尝', '甜', '苦', '辣', '咸', '酸', '冷', '烫', '热', '疼', '痒', '麻', '亮',
  '暗', '响', '闷', '湿', '干', '糙', '滑', '软', '硬', '脆', '香', '臭', '腥', '吵', '硌',
  '哆嗦', '抖', '咕嘟', '咚', '啪', '唰', '呼噜', '嗡嗡', '叮', '哐', '吱'
]);

// 语气词：人味的第一层。
export const PARTICLES = Object.freeze([
  '啊', '吧', '呗', '嘛', '哦', '噢', '诶', '哎', '呀', '呢', '嗯', '唔', '哈', '嘿', '哼',
  '咋', '呐', '咯', '哇', '唉', '哟', '嘿嘿', '哈哈', '呜呜'
]);

// 口语动词/副词：书面语里不这么用。
export const ORAL = Object.freeze([
  '贼', '超', '整', '搞', '弄', '瞎', '愣', '硬是', '差点', '顶多', '大不了', '凑合',
  '糊弄', '磨蹭', '盯', '蹲', '趴', '躺', '踹', '扯', '拽', '抠', '塞', '馋', '饿', '困',
  '累', '烦', '乐', '溜', '赶', '抢', '刷', '敲', '泡', '扔', '按', '数', '攒', '抖'
]);

// AI 腔：出现即扣分，密度越高扣越狠。判断标准是「这句换成任何一段 AI 文案都成立」。
export const SLOP_MARKERS = Object.freeze([
  '仿佛', '宛如', '恍若', '不禁', '不由得', '忍不住', '一丝', '一抹', '一缕', '涌上心头',
  '泛起', '莫名', '深深地', '无尽', '令人', '心头一暖', '空气中弥漫', '眼神中', '嘴角勾起',
  '微微一笑', '岁月的长河', '灵魂深处', '静静地', '淡淡的', '轻轻地', '缓缓地', '说不出的',
  '难以言喻', '无法言说', '时光的', '命运的', '喧嚣', '洗礼', '绽放', '升华', '治愈',
  // 「正确的废话」：语法通顺、情绪饱满、但换成任何一段公众号文案都成立
  '重要的不是', '沿途的风景', '愿你我', '命运的安排', '成长的开始', '时光的长河',
  '再也回不去', '每一次相遇', '刻刀', '诉说'
]);

// 「含糊」词：说出来等于没说。具体性的反面，按密度扣分。
export const VAGUE = Object.freeze([
  '很多', '一些', '有点', '比较', '不错', '还行', '还可以', '不少', '各种', '什么的', '之类',
  '大概', '差不多', '感觉', '觉得', '确实', '应该', '其实', '基本上', '挺好的', '挺好',
  '挺好的吧', '一大堆', '好多', '各种各', '不算', '还算', '多少有点'
]);

// 带量词的数字（三片肉、第七根、四百三十二步）：具体性的强信号。
const MEASURE_RE = /[一二三四五六七八九十百千万两三0-9半几]+(?:个|根|只|条|步|分钟|小时|块|毛|天|年|次|遍|口|碗|杯|片|张|把|句|声|秒|袋|瓶|盒|支|包|趟|回)/g;

// ── 五项指标 ────────────────────────────────────────────────────────────────
function sentenceLengths(text) {
  const raw = String(text ?? '');
  let parts = raw.split(SENT_SPLIT_RE).map((s) => stripPunct(s)).filter((s) => s.length > 0);
  if (parts.length <= 1) {
    parts = raw.split(CLAUSE_SPLIT_RE).map((s) => stripPunct(s)).filter((s) => s.length > 0);
  }
  return parts.map((s) => charCount(s));
}

function meanSd(nums) {
  if (!nums.length) return { mean: 0, sd: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const varr = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nums.length;
  return { mean, sd: Math.sqrt(varr) };
}

export function metricConcreteness(text, cfg = DEFAULT_LITERARY_CONFIG) {
  const body = bodyLength(text);
  const m = matchTerms(text, CONCRETE);
  const density = body > 0 ? m.chars / body : 0;
  return {
    score: clamp01(sat(density, cfg.knees.concreteness)),
    density: round1(density * 1000) / 1000,
    hits: m.hits,
    chars: m.chars,
    body
  };
}

export function metricImagery(text, cfg = DEFAULT_LITERARY_CONFIG) {
  const body = bodyLength(text);
  const similes = matchTerms(text, SIMILE_MARKERS).hits;
  const senses = matchTerms(text, SENSE).hits;
  const measures = String(text ?? '').match(MEASURE_RE) || [];
  // 比喻权重最高，量词数字次之，感官词再次（感官词很常见，容易虚高）
  const points = similes.length * 2 + measures.length * 1.5 + senses.length * 0.8;
  const per100 = body > 0 ? (points / body) * 100 : 0;
  return {
    score: clamp01(sat(per100, cfg.knees.imagery)),
    per100: round1(per100),
    similes,
    measures,
    senses
  };
}

export function metricRhythm(text) {
  const lens = sentenceLengths(text);
  if (!lens.length) return { score: 0, sentences: 0, mean: 0, sd: 0, cv: 0, lens };
  const { mean, sd } = meanSd(lens);
  const cv = mean > 0 ? sd / mean : 0;
  // 理想句长 6~20 字（QQ 语境的短句）；越往外越差
  let meanScore;
  if (mean >= 6 && mean <= 20) meanScore = 1;
  else if (mean < 6) meanScore = clamp01((mean - 2) / 4);
  else meanScore = clamp01(1 - (mean - 20) / 20);
  const cvScore = clamp01(cv / 0.55);
  const score = clamp01(0.55 * meanScore + 0.45 * cvScore);
  return { score, sentences: lens.length, mean: round1(mean), sd: round1(sd), cv: round1(cv * 100) / 100, lens };
}

export function metricTexture(text) {
  const raw = String(text ?? '');
  const kinds = PUNCT_KINDS.filter((p) => raw.includes(p)).length;
  const variety = clamp01(kinds / 4);
  // 自噬：连续三字重复（「静静静」「地地地」）
  const body = stripPunct(raw);
  const arr = Array.from(body);
  const grams = [];
  for (let i = 0; i + 3 <= arr.length; i++) grams.push(arr.slice(i, i + 3).join(''));
  const uniq = new Set(grams).size;
  const rep = grams.length >= 4 ? 1 - uniq / grams.length : 0;
  // 憋气：最长一段不带标点/空白的长度
  const runs = raw.split(/[。，、；：！？…—～\s]+/).map((s) => charCount(s));
  const longest = runs.length ? Math.max(...runs) : 0;
  const runScore = longest <= 16 ? 1 : clamp01(1 - (longest - 16) / 24);
  const score = clamp01(0.45 * variety + 0.30 * (1 - clamp01(rep * 2.5)) + 0.25 * runScore);
  return { score, kinds, variety: round1(variety * 100) / 100, repeated: round1(rep * 100) / 100, longest };
}

export function metricVoice(text, cfg = DEFAULT_LITERARY_CONFIG) {
  const raw = String(text ?? '');
  const sents = Math.max(1, sentenceLengths(raw).length);
  const particles = matchTerms(raw, PARTICLES).count;
  const oral = matchTerms(raw, ORAL).count;
  const person = (raw.match(/[我咱]/g) || []).length + (raw.match(/[你您]/g) || []).length;
  const ask = (raw.match(/[？?]/g) || []).length;
  const bang = (raw.match(/[！!]/g) || []).length;
  const points = particles * 1.2 + oral * 0.6 + person * 0.5 + ask * 0.8 + bang * 0.6;
  const per = points / sents;
  return {
    score: clamp01(sat(per, cfg.knees.voice)),
    perSentence: round1(per),
    particles,
    oral,
    person,
    ask,
    bang,
    sentences: sents
  };
}

export function metricSlop(text, cfg = DEFAULT_LITERARY_CONFIG) {
  const raw = String(text ?? '');
  const body = bodyLength(text);
  const hits = matchTerms(raw, SLOP_MARKERS).hits;
  const per100 = body > 0 ? (hits.length / body) * 100 : 0;
  const abs = matchTerms(raw, ABSTRACT);
  const absDensity = body > 0 ? abs.chars / body : 0;
  const lens = sentenceLengths(raw);
  const long = lens.filter((n) => n > 32).length;
  const longRatio = lens.length ? long / lens.length : 0;
  const vague = matchTerms(raw, VAGUE).hits;
  const vaguePer100 = body > 0 ? (vague.length / body) * 100 : 0;
  const vagueScore = sat(vaguePer100, 2.5);
  const score = clamp01(
    sat(per100, cfg.knees.slop) * 0.62 + vagueScore * 0.22 + clamp01(absDensity / 0.18) * 0.10 + longRatio * 0.06
  );
  return {
    score,
    hits,
    per100: round1(per100),
    vague,
    vaguePer100: round1(vaguePer100),
    abstractHits: abs.hits,
    abstractDensity: round1(absDensity * 1000) / 1000,
    longSentences: long
  };
}

// ── 总分 ────────────────────────────────────────────────────────────────────
export function bandOf(total, cfg = DEFAULT_LITERARY_CONFIG) {
  for (const [threshold, name] of cfg.bands) if (total >= threshold) return name;
  return '干瘪';
}

/**
 * 给一段文本打分。
 * @returns {{version:number, chars:number, total:number, band:string, metrics:object, notes:string[]}}
 */
export function scoreText(text, options = {}) {
  const cfg = options.config ?? DEFAULT_LITERARY_CONFIG;
  const raw = String(text ?? '');
  const chars = charCount(raw);
  const metrics = {
    concreteness: metricConcreteness(raw, cfg),
    imagery: metricImagery(raw, cfg),
    rhythm: metricRhythm(raw),
    texture: metricTexture(raw),
    voice: metricVoice(raw, cfg),
    slop: metricSlop(raw, cfg)
  };
  const w = cfg.weights;
  const totalW = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const base = Object.entries(w).reduce((sum, [key, weight]) => sum + metrics[key].score * weight, 0) / totalW;
  const penalty = clamp01(cfg.slopPenalty) * metrics.slop.score;
  const total = chars === 0 ? 0 : round1(clamp01(base * (1 - penalty)) * 100);

  const notes = [];
  if (chars === 0) notes.push('空文本');
  if (metrics.slop.hits.length) notes.push('AI 腔：' + metrics.slop.hits.slice(0, 6).join('、'));
  if (metrics.concreteness.density < 0.03 && chars >= 10) notes.push('几乎没有具体的东西（密度 ' + metrics.concreteness.density + '）');
  if (metrics.imagery.per100 < 3 && chars >= 10) notes.push('没有画面（比喻/感官/量词数字都少）');
  if (metrics.rhythm.sentences >= 2 && metrics.rhythm.cv < 0.25) notes.push('句长太齐（cv ' + metrics.rhythm.cv + '）');
  if (metrics.texture.longest > 24) notes.push('有 ' + metrics.texture.longest + ' 字不带标点，读着憋气');
  if (metrics.voice.perSentence < 0.8 && chars >= 10) notes.push('没有说话的口气（语气词/口语词都少）');

  return { version: LITERARY_VERSION, chars, total, band: bandOf(total, cfg), metrics, notes };
}

/** 批量打分（评估集用）。 */
export function scoreBatch(items, options = {}) {
  return (items ?? []).map((item) => ({ ...item, score: scoreText(item?.text ?? '', options) }));
}

export default { scoreText, scoreBatch, bandOf };
