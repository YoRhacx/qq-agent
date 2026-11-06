#!/usr/bin/env node
// 积压兜底（方案 B）自检 —— 主人 m07680 的原话：
//   「方案b吧，频率适中（思想还是一样不是每条都回但不能一条不回，如果只有被拍一拍和被@才回
//     这个机器人还有什么意义）但是如果攒了几条没回的信息挑最近的那一条回就好！」
//
// 为什么光改概率不够（这段数学是这套设计的存在理由，别删）：
//   纯「每条消息掷 p」的累积命中率是 1-(1-p)^n。p=0.12 时 5 条消息至少中一次只有
//   1-0.88^5 ≈ 47%，不到一半；孤零零一条消息（n=1）更是 88% 概率永远不回 —— 因为
//   之后没有新消息，evaluateWakeTriggerV2 再也不会被调用，这条路永远不会补唤醒，
//   只能等 proactiveCheck（间隔 30~90 分钟、群聊概率还要乘 0.5）来兜。
//   所以「不能一条不回」必须有独立的确定性兜底：攒够 backlogWakeAfter 条就不再掷骰子。
//
// 断言分五层：①出厂默认与配置归一化 ②纯函数 backlogUnansweredV2 的计数口径
// ③evaluateWakeTriggerV2 的触发顺序与软闸门 ④提示词两层（群聊才给、只挑最近一条）
// ⑤控制台界面（主人 m02235 的硬要求「功能要有修改的界面」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
};
const section = (t) => console.log(`\n## ${t}`);

const h = await bridgeHarness({
  config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false } } },
});

/** 造一条入站消息（形状照抄 src/bridge.js appendSocialV2Message 里 push 进 st.unread 的那个对象）。 */
const inbound = (seq, time, extra = {}) => ({
  seq, messageId: `m${seq}`, sender: `群友${seq}`, userId: String(1000 + seq),
  text: `消息${seq}`, plain: `消息${seq}`, tail: `消息${seq}`,
  quoteTargetIsSelf: false, isOwner: false, ownerLabel: '', isSelf: false,
  media: [], hasMedia: false, forwardIds: [], hasForward: false, time, ...extra,
});

try {
  section('出厂默认与配置归一化');
  ok(h.cfg?.socialV2?.wake?.backlogWakeAfter === 3, '默认 wake.backlogWakeAfter = 3（出厂兜底阈值）');
  ok(h.cfg?.socialV2?.wake?.recommendedProbability === 0.12, '默认 wake.recommendedProbability = 0.12（方案 B 的"适中频率"）');
  const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  ok(/'softWakePerHour', 'backlogWakeAfter'\]/.test(bridgeSrc),
    'wake 的数值归一名单里包含 backlogWakeAfter（否则控制台填了会被存成字符串）');

  section('纯函数 backlogUnansweredV2：计数口径');
  ok(typeof h.backlogUnansweredV2 === 'function', 'harness 导出了 backlogUnansweredV2');
  const key = 'group:2000000001';
  const st = h.getSocialV2State(key);
  const base = 1_800_000_000_000;
  st.lastAiReplyAt = base;
  st.unread = [
    inbound(1, base - 60000),          // 她上次开口**之前**的 → 不算
    inbound(2, base + 1000),           // 算
    inbound(3, base + 2000, { isSelf: true }),  // 自己发的 → 不算
    inbound(4, base + 3000, { kind: 'poke' }),  // 拍一拍 → 不算（它自己就是定向触发）
    inbound(5, base + 4000),           // 算
  ];
  ok(h.backlogUnansweredV2(st) === 2, '只数"她上次开口之后 + 别人发的 + 非拍一拍"：得到 2 条');
  st.lastAiReplyAt = 0;
  ok(h.backlogUnansweredV2(st) === 3, '她还没开过口（lastAiReplyAt=0）时，全部非自己非拍一拍都算：3 条');
  ok(h.backlogUnansweredV2(null) === 0, '没有状态时返回 0（不抛错）');
  ok(h.backlogUnansweredV2({ unread: null }) === 0, 'unread 不是数组时返回 0');

  section('evaluateWakeTriggerV2：积压兜底真的会触发');
  ok(typeof h.evaluateWakeTriggerV2 === 'function', 'harness 导出了 evaluateWakeTriggerV2');
  const makeState = ({ unanswered, probability = 0, anyMessage = false }) => {
    const s = h.getSocialV2State('group:2000000001');
    s.wakeConfig = {
      mode: 'diving', infinite: true, batchWindowMs: 8000, confirmedBy: 'test',
      triggers: { atMention: true, nameMention: true, speakerIds: [], keywords: [], question: true, poke: true, anyMessage, probability },
    };
    s.lastAiReplyAt = 0;
    s.softWakeTimes = [];
    s.unread = [];
    for (let i = 1; i <= unanswered; i += 1) s.unread.push(inbound(i, base + i * 1000));
    return s;
  };
  const evaluate = (s) => h.evaluateWakeTriggerV2('group:2000000001', s, { message: [], user_id: '999', sender: { nickname: '群友' } }, 'group', '普通闲聊', '普通闲聊', false);

  ok(evaluate(makeState({ unanswered: 3 })) === 'backlog', '攒够 3 条（阈值 3）→ 直接返回 backlog，不再掷骰子');
  ok(evaluate(makeState({ unanswered: 5 })) === 'backlog', '攒了 5 条 → 还是 backlog');
  ok(evaluate(makeState({ unanswered: 2 })) === null, '只攒了 2 条、概率又为 0 → 不唤醒（回到 null）');
  ok(evaluate(makeState({ unanswered: 3, probability: 1 })) === 'backlog',
    '概率掷中与积压同时成立时，原因取 backlog（提示词才会给「只挑最近一条」的引导）');
  ok(evaluate(makeState({ unanswered: 2, probability: 1 })) === 'probability',
    '攒不够时仍由概率决定要不要早插一句');
  ok(evaluate(makeState({ unanswered: 3, anyMessage: true })) === 'anyMessage',
    'anyMessage（活跃模式）优先级高于积压：活跃模式本来就是每条都看');

  // 软闸门照旧生效：积压 ≠ 话痨，刚说过话/额度用完照样挡住（消息进未读，下一轮再看）。
  const cooled = makeState({ unanswered: 3 });
  cooled.lastAiReplyAt = Date.now() - 1000; // 1 秒前刚说过话，冷却 180s
  cooled.unread = [inbound(1, Date.now() - 500), inbound(2, Date.now() - 400), inbound(3, Date.now() - 300)];
  ok(evaluate(cooled) === null, '积压够了但刚说过话（软闸门冷却中）→ 这次不醒，消息不丢');
  ok(/冷却剩余/.test(String(cooled.softWakeSkipReason ?? '')), '被软闸门挡下时写了可读的 softWakeSkipReason');

  const exhausted = makeState({ unanswered: 3 });
  exhausted.softWakeTimes = [Date.now(), Date.now() - 1000, Date.now() - 2000, Date.now() - 3000, Date.now() - 4000, Date.now() - 5000];
  ok(evaluate(exhausted) === null, '积压够了但这一小时普通消息额度已满（6/6）→ 这次不醒');
  ok(/额度已满/.test(String(exhausted.softWakeSkipReason ?? '')), '额度满时也写了可读原因');

  ok(h.evaluateWakeTriggerV2('private:123', makeState({ unanswered: 0 }), {}, 'private', '在吗', '在吗', false) === 'private',
    '私聊不走这一套，永远是 private（积压只针对群聊）');

  section('接线：源码里真的挂上了兜底分支');
  ok(/if \(backlogAfter > 0 && backlogUnansweredV2\(st\) >= backlogAfter && softWakeGateV2\(st, kind\) === 'ok'\) return 'backlog';/.test(bridgeSrc),
    'evaluateWakeTriggerV2 里有积压分支，且仍然过 softWakeGateV2');
  ok(/const backlogAfter = Math\.max\(0, Math\.round\(Number\(cfg\.socialV2\?\.wake\?\.backlogWakeAfter\) \|\| 0\)\);/.test(bridgeSrc),
    '阈值每次从活配置读取（backlogWakeAfter = 0 即关闭兜底）');
  ok(bridgeSrc.indexOf('>= backlogAfter') < bridgeSrc.indexOf("return 'probability';"),
    '积压分支写在概率分支之前（攒够时原因必须是 backlog）');
  ok(h.wakePriorityV2('backlog') === 55 && h.wakePriorityV2('backlog') > h.wakePriorityV2('anyMessage'),
    'backlog 的唤醒优先级（55）高于 anyMessage（50）、低于 keyword（60）');
  ok(h.isDirectedWakeReasonV2('backlog') === false,
    '积压不算"被点名"：走普通消息的接话冷却（否则会像被 @ 一样抢着回）');

  section('提示词两层：挑一条接住（2026-10-13 收窄：不再一律要求引用）');
  const gst = h.getSocialV2State('group:2000000001');
  gst.wakeConfig = { mode: 'diving', infinite: true, batchWindowMs: 8000, confirmedBy: 'test', triggers: { atMention: true, nameMention: true, speakerIds: [], keywords: [], question: true, poke: true, anyMessage: false, probability: 0.12 } };
  gst.lastAiReplyAt = 0;
  gst.unread = [inbound(1, base + 1000), inbound(2, base + 2000), inbound(3, base + 3000)];
  gst.recentMessages = [...gst.unread];
  const backlogPrompt = String(h.buildWakePromptV2('group:2000000001', 'backlog') ?? '');
  ok(backlogPrompt.includes('攒了 3 条'), 'backlog 唤醒的提示词里写明了攒了几条（3 条）');
  ok(backlogPrompt.includes('挑最有意思、最有梗、最值得接的那一条'), 'backlog 提示词教她挑最有梗的那一条（不再是最新那条）');
  // ★ 2026-10-13：以前这里断言必须出现「引用它回一句」。实测那正是**句句引用**的源头之一
  // （主人吐槽四次），现在改成：挑一条**接住**，「接最新那条就不用引用」。
  ok(!backlogPrompt.includes('引用它回一句'), 'backlog 提示词**不再**无条件下令「引用它回一句」（句句引用的源头）');
  ok(backlogPrompt.includes('接最新那条就不用引用'), 'backlog 提示词写明了「接最新那条就不用引用」');
  ok(backlogPrompt.includes('不要逐条补答'), 'backlog 提示词里明确禁止逐条补答');
  ok(backlogPrompt.includes('安静收尾'), 'backlog 提示词给了退路（挑不出想接的就安静收尾）');

  const probPrompt = String(h.buildWakePromptV2('group:2000000001', 'probability') ?? '');
  ok(probPrompt.includes('【攒了几条】'), '概率唤醒 + 未读 ≥2 时，也顺带给出【攒了几条】引导');
  const atPrompt = String(h.buildWakePromptV2('group:2000000001', 'atMention') ?? '');
  ok(!atPrompt.includes('【攒了几条】'), '被 @ 叫起来时不教她"只回最近一条"（该回的是点名的人）');
  const privateSt = h.getSocialV2State('private:123');
  privateSt.unread = [inbound(1, base + 1000), inbound(2, base + 2000), inbound(3, base + 3000)];
  privateSt.recentMessages = [...privateSt.unread];
  const privatePrompt = String(h.buildWakePromptV2('private:123', 'private') ?? '');
  ok(!privatePrompt.includes('【攒了几条】'), '私聊不给积压引导（私聊本来就该认真回）');

  const roleCard = fs.readFileSync(path.join(root, 'roles/小鲸鱼.md'), 'utf8');
  // ★ 2026-10-13：原断言要求「引用着回」，那是句句引用的源头之一（主人吐槽四次），已收窄为「挑一条接住」。
  ok(roleCard.includes('挑最有意思的那一条接住'), '人格层（roles/小鲸鱼.md）写了「攒了几条没回，挑最有意思的那一条接住」');
  ok(!roleCard.includes('引用着回'), '人格层不再无条件下令「引用着回」');
  ok(/攒着的那几条里如果[\s\S]{0,60}@你/.test(roleCard), '人格层保留了例外：攒着的消息里有 @你/叫你名字的优先');
  const presetSrc = fs.readFileSync(path.join(root, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  ok(presetSrc.includes('挑最有意思的那条接住'), '仿真层（preset）也写了同一条规矩');
  ok(!presetSrc.includes('引用着回'), '仿真层不再无条件下令「引用着回」');

  section('控制台界面（主人要求：功能要有地方改，不能固定死）');
  const consoleHtml = fs.readFileSync(path.join(root, 'public/console.html'), 'utf8');
  ok(consoleHtml.includes('id="v2BacklogWakeAfter"'), '控制台有输入框 v2BacklogWakeAfter');
  ok(/getElementById\('v2BacklogWakeAfter'\)\.value/.test(consoleHtml), 'v2BacklogWakeAfter 有读入（回显当前值）');
  ok(/backlogWakeAfter: Math\.round\(Number\(document\.getElementById\('v2BacklogWakeAfter'\)\.value\) \|\| 0\)/.test(consoleHtml),
    '控制台保存时把「攒够几条必醒」写回 wake.backlogWakeAfter');
  ok(consoleHtml.includes('接话频率与冷却'), '输入框落在「接话频率与冷却」分组里（和冷却/额度在一起）');

  section('示例配置（新装的人不该看不到这个开关）');
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  ok(example.socialV2?.wake?.backlogWakeAfter === 3, 'config.example.json 里有 wake.backlogWakeAfter = 3');
  ok(example.socialV2?.wake?.recommendedProbability === 0.12, 'config.example.json 的推荐概率与代码出厂默认对齐（0.12）');
  ok(example.socialV2?.wake?.softWakeCooldownMs === 180000 && example.socialV2?.wake?.softWakePerHour === 6,
    'config.example.json 补上了 softWakeCooldownMs / softWakePerHour（原来只写在代码里）');
  const live = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  ok(live.socialV2?.wake?.backlogWakeAfter === 3, '现网 config.json 也已写入 backlogWakeAfter = 3');
} finally {
  await h.close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
