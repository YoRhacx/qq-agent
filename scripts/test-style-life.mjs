// 表达层三件（src/style-guard.js / src/self-style.js / src/life-loop.js）自检：
// 全部在 os.tmpdir() 下的临时目录里跑，**绝不碰真实的 state/**，不联网、不发 QQ 消息、不改 bridge.js。
// 覆盖：
//   ① 语感统计口径（中位句长 / 无标点率 / 短句比 / 语气词 topN / 分条习惯 / 例子过滤）；
//   ② 注入块 marker 与三个开关（injectStyle / styleInGroup / minSamples 门槛）；
//   ③ 出站清洗九类改写（问候 / 结尾客套 / 整句客服腔 / 长段拆分 / 重复标点 / 括号 / 短句去句号）+ 兜底 + 代码块跳过；
//   ④ 自我语感统计与 drift（纯函数 + 窗口重算两条路）；
//   ⑤ 生活层笔记增删、按天汇总、心情差/好两路挑兴趣、jsonl 两种格式导入与幂等去重；
//   ⑥ 三个模块关掉时不建文件；损坏 JSON 降级不抛。
//
// 跑法：node scripts/test-style-life.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeStyle,
  buildStyleBlock,
  checkOutgoing,
  createStyleGuard,
  describeRatio,
  stripStyleBlock,
  STYLE_BEGIN,
  STYLE_END,
  DEFAULT_STYLE_GUARD_CONFIG
} from '../src/style-guard.js';
import {
  analyzeSelfStyle,
  buildSelfStyleBlock,
  createSelfStyle,
  detectDrift,
  isTsundere,
  tailOf,
  SELF_STYLE_BEGIN,
  SELF_STYLE_END
} from '../src/self-style.js';
import {
  createLifeLoop,
  dateOf,
  moodScore,
  normalizeKind,
  parseLifeJsonl,
  pickInterest,
  summarizeNotes
} from '../src/life-loop.js';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ✅ ' + name); }
  else { fail += 1; console.error('  ❌ ' + name); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-life-test-'));
const tmpFile = (tag) => path.join(dir, tag + '.json');
/** 三个反引号（代码块围栏）：本文件里不写字面围栏，避免和上面的 String.raw 打架。 */
const FENCE = String.fromCharCode(96, 96, 96);
/** 一天 12:00 的固定时钟：按本地时间构造，跨时区也不会把日期算错。 */
const T0 = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
const DAY0 = '2026-10-28';

// ── ① 语感统计口径 ─────────────────────────────────────────────────────────
console.log('## 1. 统计口径：中位句长 / 无标点率 / 短句比例');
{
  const rows = ['在吗', '你吃了吗', '我吃过了', '今天去哪玩', '公司加班', '知道了。'];
  const stats = analyzeStyle(rows);
  ok(stats.n === 6, '6 条消息都进了统计（实际 ' + stats.n + '）');
  ok(stats.medianLen === 4, '中位句长 = 4（实际 ' + stats.medianLen + '）');
  ok(stats.avgLen === 3.8, '平均句长 = 3.8（实际 ' + stats.avgLen + '）');
  ok(stats.noPunctRatio === 0.833, '无标点率 = 5/6 ≈ 0.833（实际 ' + stats.noPunctRatio + '）');
  ok(stats.shortRatio === 1, '全部不超过 5 字（实际 ' + stats.shortRatio + '）');
  const r = describeRatio(0.833);
  ok(r.pct === 83 && r.cheng === '八成', '比例说人话：0.833 → 八成 / 83%（实际 ' + r.cheng + ' / ' + r.pct + '%）');
}

console.log('## 2. 统计口径：语气词 topN / 例子过滤 / 无效样本');
{
  const rows = ['好呀', '走呗', '好呀', '行吧', '嗯嗯', '[图片]', '  ', '这', 'https://example.com/a'];
  const stats = analyzeStyle(rows, { exampleCount: 5 });
  ok(stats.particleCounts['呀'] === 2, '「呀」出现 2 条（实际 ' + stats.particleCounts['呀'] + '）');
  ok(stats.particles[0] === '呀', '语气词第一名是「呀」（实际 ' + stats.particles[0] + '）');
  ok(stats.particles.length <= 5, '默认只留 top5（实际 ' + stats.particles.length + '）');
  ok(!stats.examples.some((x) => x.includes('example.com')), '例子跳过链接');
  ok(!stats.examples.some((x) => x === '[图片]'), '例子跳过纯占位');
  ok(stats.n === 5, '纯占位 / 空白 / 单字不进统计（实际 n=' + stats.n + '）');
}

console.log('## 3. 统计口径：分条习惯（同一人 1 分钟内连发）');
{
  const rows = [
    { text: '在吗', from: 'u1', at: T0 },
    { text: '在的', from: 'u1', at: T0 + 20 * 1000 },
    { text: '等我', from: 'u1', at: T0 + 40 * 1000 },
    { text: '好嘞', from: 'u1', at: T0 + 60 * 1000 },
    { text: '我也来', from: 'u2', at: T0 + 10 * 60 * 1000 }
  ];
  const stats = analyzeStyle(rows, { burstGapMs: 60000 });
  ok(stats.burst && stats.burst.groups === 2, '两组连发（实际 ' + (stats.burst && stats.burst.groups) + '）');
  ok(stats.burst.avg === 2.5, '平均每轮 2.5 条（4 条 + 1 条，两组）（实际 ' + (stats.burst && stats.burst.avg) + '）');
  ok(stats.burst.max === 4, '最长一轮 4 条（实际 ' + (stats.burst && stats.burst.max) + '）');
  const none = analyzeStyle(['在吗', '吃了吗']);
  ok(none.burst === null, '没有时间戳/发送者时不算分条习惯');
}

// ── ② 注入块 ───────────────────────────────────────────────────────────────
console.log('## 4. 注入块：marker 与内容');
{
  const rows = ['在吗', '你吃了吗', '我吃过了', '今天去哪玩', '公司加班', '知道了。'];
  const block = buildStyleBlock(analyzeStyle(rows), { minSamples: 5 });
  ok(block.startsWith(STYLE_BEGIN) && block.endsWith(STYLE_END), '块以 STYLE:BEGIN 开头、STYLE:END 结尾');
  ok(block.includes('中位句长 4 字'), '写上中位句长（实际块：' + block.replace(/\n/g, ' ⏎ ').slice(0, 120) + '…）');
  ok(block.includes('不带句号'), '写上无标点率');
  ok(block.includes('像这群人一样说话'), '给出行动指令而不是干巴巴的统计');
  ok(stripStyleBlock('前文\n' + block + '\n后文').replace(/\s+/g, ' ').trim() === '前文 后文', 'stripStyleBlock 能剥掉整块（重复注入不叠加）');
}

console.log('## 5. 注入块：样本门槛');
{
  const few = analyzeStyle(['在吗', '吃了吗', '好呀']);
  ok(buildStyleBlock(few) === '', '样本 < 20 条默认不注入（返回空串）');
  ok(buildStyleBlock(few, { minSamples: 2 }) !== '', '把 minSamples 调低就注入（小群也没问题）');
}

console.log('## 6. 注入块：injectStyle / styleInGroup 开关');
{
  const rows = ['在吗', '吃了吗', '好呀', '走呗', '嗯嗯', '行吧'];
  const base = { minSamples: 3, sampleSize: 50, flushEvery: 1 };
  const everywhere = createStyleGuard({ stateFile: tmpFile('sw-guard-a'), config: { ...base, styleInGroup: false } });
  const groupOnly = createStyleGuard({ stateFile: tmpFile('sw-guard-b'), config: { ...base, styleInGroup: true } });
  const off = createStyleGuard({ stateFile: tmpFile('sw-guard-c'), config: { ...base, injectStyle: false } });
  for (const row of rows) { everywhere.observe(row); groupOnly.observe(row); off.observe(row); }
  ok(everywhere.buildStyleBlock({ isGroup: false }) !== '', 'styleInGroup=false 时私聊也注入');
  ok(groupOnly.buildStyleBlock({ isGroup: false }) === '', 'styleInGroup=true 时私聊不注入');
  ok(groupOnly.buildStyleBlock({ isGroup: true }) !== '', 'styleInGroup=true 时群聊照常注入');
  ok(off.buildStyleBlock({ isGroup: true }) === '', 'injectStyle=false 时一律不注入');
}

// ── ③ 出站清洗 ─────────────────────────────────────────────────────────────
console.log('## 7. 出站清洗：客服问候 / 结尾客套');
{
  const greet = checkOutgoing('您好，在吗');
  ok(greet.text === '在吗', '开头「您好，」被砍掉（实际「' + greet.text + '」）');
  ok(greet.changes.some((c) => c.type === 'greeting'), 'changes 里记了 greeting');
  ok(greet.blocked === false, '清洗不拦话：blocked 恒为 false（自曝归 identity-guard）');

  const tail = checkOutgoing('外面下雨了，记得带伞，有事叫我。');
  ok(tail.text === '外面下雨了，记得带伞', '结尾「有事叫我」整段砍掉（实际「' + tail.text + '」）');
  ok(tail.changes.some((c) => c.type === 'tail'), 'changes 里记了 tail');
  ok(!tail.text.includes('有事叫我'), '砍掉的客套不会换个说法留下');
}

console.log('## 8. 出站清洗：整句客服腔 / 长段拆分');
{
  const banned = checkOutgoing('明天多云。需要我帮你带伞吗？');
  ok(banned.text === '明天多云', '整句客服腔被删掉、剩下的话保留（实际「' + banned.text + '」）');
  ok(banned.changes.some((c) => c.type === 'banned'), 'changes 里记了 banned');

  const orphan = checkOutgoing('您好，很高兴为您服务！明天多云，记得带伞。希望对你有帮助！！');
  ok(orphan.text === '明天多云，记得带伞', '删掉客服腔后不会留下孤立的标点（实际「' + orphan.text + '」）');
  const emptied = checkOutgoing('您好，很高兴为您服务！希望对你有帮助！！');
  ok(
    emptied.text === DEFAULT_STYLE_GUARD_CONFIG.fallbackText && emptied.changes.some((c) => c.type === 'fallback'),
    '全删光只剩标点时兜底说「嗯」（实际「' + emptied.text + '」）'
  );

  const sentence = '今天下午三点开会，讨论下个月的排期和预算。';
  const long = sentence.repeat(5);
  ok(Array.from(long).length > 100, '构造的段落确实超过 100 字');
  const split = checkOutgoing(long);
  ok(split.changes.some((c) => c.type === 'split'), '长段落被拆成多行');
  ok(split.text.includes('\n'), '拆完带换行（实际换行数 ' + (split.text.split('\n').length - 1) + '）');
  ok(split.text.replace(/\s/g, '').length >= long.replace(/\s/g, '').length - 12, '拆分只加换行/去句号，不吞正文');
}

console.log('## 9. 出站清洗：重复标点 / 短句去句号 / 兜底 / 跳过');
{
  const punct = checkOutgoing('真的吗？？？？');
  ok(punct.text === '真的吗？', '连续问号压成一个（实际「' + punct.text + '」）');
  ok(punct.changes.some((c) => c.type === 'punct'), 'changes 里记了 punct');

  const period = checkOutgoing('好的。');
  ok(period.text === '好的', '短句结尾句号去掉（微信式）');
  ok(period.changes.some((c) => c.type === 'period'), 'changes 里记了 period');

  const bracketPair = checkOutgoing('好呀（笑）');
  ok(bracketPair.text === '好呀（笑）' && bracketPair.changes.length === 0, '配对的括号一个字都不动（不会被削成「好呀（笑」）');
  const bracketTail = checkOutgoing('好呀（笑）)');
  ok(bracketTail.text === '好呀（笑）' && bracketTail.changes.some((c) => c.type === 'bracket'), '句尾多出来的右括号被削掉');

  const empty = checkOutgoing('需要我帮你做点什么吗？');
  ok(empty.text === DEFAULT_STYLE_GUARD_CONFIG.fallbackText, '一句话都不剩时兜底说「嗯」（实际「' + empty.text + '」）');
  ok(empty.changes.some((c) => c.type === 'fallback'), 'changes 里记了 fallback');

  const code = checkOutgoing('跑这个：' + FENCE + 'npm test' + FENCE);
  ok(code.skipped === 'codeblock' && code.changes.length === 0, '带代码块的消息整条跳过清洗');
  const disabled = checkOutgoing('您好，在吗', { enabled: false });
  ok(disabled.text === '您好，在吗' && disabled.skipped === 'disabled', 'cleanOutgoing 关掉时原文不动');
  const offGuard = createStyleGuard({ stateFile: tmpFile('sw-guard-d'), config: { cleanOutgoing: false } });
  ok(offGuard.checkOutgoing('您好，在吗').skipped === 'disabled', '实例关掉清洗时同样原样返回');
}

// ── ④ 自我语感 ─────────────────────────────────────────────────────────────
console.log('## 10. 自我语感：参数统计');
{
  const rows = ['才不是呢', '哼，才不是', '好耶', '在看什么', '今天好累啊'];
  const p = analyzeSelfStyle(rows);
  ok(p.n === 5, '5 条都进了自画像（实际 ' + p.n + '）');
  ok(p.medianLen === 4, '中位句长 4（实际 ' + p.medianLen + '）');
  ok(p.tails.length === 5 && p.tails.some((t) => t.word === '呢'), '尾词表包含「呢」');
  ok(p.tsundereRatio === 0.4, '傲娇句式占比 2/5 = 0.4（实际 ' + p.tsundereRatio + '）');
  ok(isTsundere('哼') && !isTsundere('今天天气不错'), 'isTsundere 能认出「哼」、不冤枉普通句');
  ok(tailOf('好耶！') === '耶', 'tailOf 去掉标点取最后一个字');
  ok(analyzeSelfStyle(['' + FENCE + 'js', 'const a = 1']).n === 0, '代码类消息不进语感统计');
}

console.log('## 11. 自我语感：drift 判定（纯函数）');
{
  const prev = { n: 40, medianLen: 6, avgLen: 8, shortRatio: 0.5, noPunctRatio: 0.5, emojiDensity: 0.1, kaomojiDensity: 0.05, tsundereRatio: 0.1 };
  const next = { ...prev, medianLen: 12 };
  const hits = detectDrift(prev, next, { threshold: 0.3 });
  ok(hits.length === 1 && hits[0].metric === 'medianLen', '句长 6 → 12（+100%）记一条 drift');
  ok(hits[0].from === 6 && hits[0].to === 12, 'drift 记下 from/to 原值');
  ok(detectDrift(prev, { ...prev, medianLen: 7 }, { threshold: 0.3 }).length === 0, '6 → 7 不算漂（阈值 30%）');
  ok(detectDrift({ ...prev, n: 3 }, next).length === 0, '样本不足 minSamples 时不判 drift');
  const tiny = detectDrift({ ...prev, emojiDensity: 0.03 }, { ...prev, emojiDensity: 0.06 }, { threshold: 0.3 });
  ok(tiny.length === 0, '比例类从 3% 翻到 6% 被绝对下限挡住（不然天天报 drift）');
}

console.log('## 12. 自我语感：窗口重算 / 注入 / 关掉不建文件');
{
  const file = tmpFile('self-style-a');
  const clock = { t: T0 };
  const store = createSelfStyle({
    stateFile: file,
    now: () => clock.t,
    flushEvery: 1,
    config: { minSamples: 5, windowEvery: 0, sampleSize: 50, drift: { enabled: true, threshold: 0.3, minSamples: 5 } }
  });
  for (let i = 0; i < 5; i += 1) store.observe('好吧');
  const first = store.refresh();
  ok(first.n === 5 && first.medianLen === 2, '第一次窗口：5 条短句，中位 2 字');
  clock.t += 24 * 60 * 60 * 1000;
  for (let i = 0; i < 5; i += 1) store.observe('今天想把那本讲睡眠的书读完');
  const second = store.refresh();
  ok(second.medianLen > first.medianLen, '第二次窗口中位句长变大（' + first.medianLen + ' → ' + second.medianLen + '）');
  ok(store.driftLog().length >= 1 && store.driftLog().some((d) => d.metric === 'medianLen'), '参数突变记了 drift');
  const block = store.buildSelfStyleBlock();
  ok(block.startsWith(SELF_STYLE_BEGIN) && block.endsWith(SELF_STYLE_END), '自画像注入块带 marker');
  ok(block.includes('说话'), '注入块是一句「我最近的说话手感」');

  const offFile = tmpFile('self-style-off');
  const off = createSelfStyle({ stateFile: offFile, config: { enabled: false }, flushEvery: 1 });
  ok(off.observe('这句话不该被记') === false, 'enabled=false 时 observe 直接拒绝');
  ok(off.buildSelfStyleBlock() === '', 'enabled=false 时不注入');
  ok(!fs.existsSync(offFile), 'enabled=false 时不建状态文件');
}

// ── ⑤ 生活层 ───────────────────────────────────────────────────────────────
console.log('## 13. 生活层：笔记增删与持久化');
{
  const file = tmpFile('life-a');
  const clock = { t: T0 };
  const life = createLifeLoop({ stateFile: file, now: () => clock.t, flushEvery: 1 });
  const a = life.addNote({ kind: 'watch', title: '葬送的芙莉莲', text: '看到第十二集', interest: '看番', weight: 0.8 });
  ok(a && a.kind === 'watch' && a.date === DAY0, 'watch 笔记落在今天（' + (a && a.date) + '）');
  ok(a.weight === 0.8 && a.interest === '看番', '兴趣权重 0.8 / 兴趣「看番」都存住了');
  const b = life.addNote({ text: '今天有点累，想早点睡' });
  ok(b.kind === 'mood', '不给 kind 的随手记归 mood');
  ok(life.todayNotes().length === 2, 'todayNotes 取到今天两条（实际 ' + life.todayNotes().length + '）');
  ok(life.todayNotes().some((n) => n.title === '葬送的芙莉莲'), 'todayNotes 里有那条番');

  const again = createLifeLoop({ stateFile: file, now: () => clock.t, flushEvery: 1 });
  ok(again.allNotes().length === 2, '新实例重启能读回两条（落盘成功）');
  ok(again.removeNote(a.id) === true, 'removeNote 按 id 删掉一条');
  ok(again.allNotes().length === 1, '删完只剩一条');
  ok(again.removeNote('n_not_exist') === false, '删不存在的 id 返回 false');
}

console.log('## 14. 生活层：挑兴趣（心情差 / 心情好两路）');
{
  const notes = [
    { id: 'n1', date: DAY0, kind: 'watch', title: '那部番', text: '', interest: '看番', weight: 0.9, createdAt: T0 },
    { id: 'n2', date: DAY0, kind: 'read', title: '推理小说', text: '', interest: '推理', weight: 0.9, createdAt: T0 }
  ];
  const sad = pickInterest(notes, { mood: '难过', rng: () => 0 });
  ok(sad.kind === 'comfort' && sad.interest === '看番', '心情差 → 安慰型（听歌/看番/散步），实际「' + sad.interest + '」');
  ok(sad.mood <= -0.2, '心情分是负的（实际 ' + sad.mood + '）');
  const glad = pickInterest(notes, { mood: '开心', rng: () => 0 });
  ok(glad.kind === 'focus' && glad.interest === '推理', '心情好 → 烧脑/创作，实际「' + glad.interest + '」');
  const neutral = pickInterest(notes, { mood: 0, rng: () => 0 });
  ok(neutral.kind === 'comfort' || neutral.kind === 'focus', '心情一般时不硬拗方向，按历史权重抽');
  const empty = pickInterest([], { mood: '难过', rng: () => 0 });
  ok(empty.interest === '听歌' || empty.interest === '看番', '没记过笔记时按默认清单兜底（实际「' + empty.interest + '」）');
  ok(moodScore('今天有点难过') < 0 && moodScore('好开心') > 0, '心情词表能评分');
}

console.log('## 15. 生活层：一天汇总');
{
  const notes = [
    { id: 'n1', date: DAY0, kind: 'watch', title: '芙莉莲', text: '', interest: '看番', weight: 0.5, createdAt: T0 },
    { id: 'n2', date: DAY0, kind: 'mood', title: '有点累', text: '', interest: '', weight: 0.5, createdAt: T0 }
  ];
  const day = summarizeNotes(notes, DAY0);
  ok(day.n === 2, '当天 2 条');
  ok(day.byKind.watch === 1 && day.byKind.mood === 1, '按种类计数正确');
  ok(day.text.includes('看了《芙莉莲》') && day.text.includes('记了《有点累》'), '汇总能说成人话（实际：' + day.text + '）');
  const none = summarizeNotes(notes, '2026-10-01');
  ok(none.n === 0 && none.text.includes('还没有记录'), '没记录的那天说「还没有记录」');
  ok(dateOf(new Date(2026, 0, 2, 23, 0, 0)) === '2026-01-02', 'dateOf 按本地时间给 YYYY-MM-DD（不跨时区错天）');
}

console.log('## 16. 生活层：jsonl 导入（watched + notes 两种格式）');
{
  const jsonl = [
    '{"ts":1719849600000,"note":"刷到合集","items":[{"desc":"手工木工视频"},{"desc":"街头美食"}]}',
    '{"ts":1719849601,"kind":"read","text":"读到一段关于睡眠的话"}',
    'not json at all',
    '{"desc":"只有描述的一行"}'
  ].join('\n');
  const parsed = parseLifeJsonl(jsonl, { now: T0 });
  ok(parsed.notes.length === 4, '两行共解析出 4 条笔记（实际 ' + parsed.notes.length + '）');
  ok(parsed.formats.watched === 1, '认出了 watched 格式那一行');
  ok(parsed.notes.filter((n) => n.kind === 'watch').length === 2, 'items 里每个 desc 各自成一条 watch 笔记');
  ok(parsed.notes.some((n) => n.kind === 'read' && n.text.includes('睡眠')), 'notes 格式的 read 行也吃下了');
  ok(parsed.notes.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.date)), '秒/毫秒时间戳都归一成日期');

  const file = tmpFile('life-import');
  const life = createLifeLoop({ stateFile: file, now: () => T0, flushEvery: 1 });
  const first = life.importJsonl(jsonl);
  ok(first.added === 4, '第一次导入加 4 条（实际 ' + first.added + '）');
  const second = life.importJsonl(jsonl);
  ok(second.added === 0 && second.duplicated === 4, '同内容再导一次是幂等的（added=' + second.added + ', dup=' + second.duplicated + '）');
  ok(life.allNotes().length === 4, '文件里还是 4 条，没有影子记录');
  ok(parsed.skipped >= 0, '解析统计里 skipped 是数字（容错不抛）');
}

console.log('## 17. 生活层：关掉不建文件 / 损坏 JSON 降级');
{
  const offFile = tmpFile('life-off');
  const off = createLifeLoop({ stateFile: offFile, config: { enabled: false }, flushEvery: 1 });
  ok(off.addNote({ title: '不该记' }) === null, 'enabled=false 时 addNote 返回 null');
  ok(off.pickInterest({ mood: '开心' }).reason === 'off', 'enabled=false 时挑兴趣返回 off');
  ok(!fs.existsSync(offFile), 'enabled=false 时不建 state 文件');

  const broken = tmpFile('life-broken');
  fs.writeFileSync(broken, '{ 这不是 JSON');
  const recovered = createLifeLoop({ stateFile: broken, now: () => T0, flushEvery: 1 });
  ok(recovered.allNotes().length === 0, '损坏的 JSON 当空库继续，不抛');
  ok(recovered.warnings.length >= 1, '坏文件记一条 warning，便于排查');
  ok(recovered.addNote({ title: '修复后照常写' }) !== null, '坏文件之后仍能正常写');
  ok(normalizeKind('视频') === 'watch' && normalizeKind('游戏') === 'game' && normalizeKind('') === 'mood', 'kind 中英别名归一');
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
console.log('临时目录：' + dir);
if (fail) {
  console.error('用例有失败，保留临时目录便于排查。');
  process.exitCode = 1;
} else {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
}
