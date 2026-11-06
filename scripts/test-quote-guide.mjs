#!/usr/bin/env node
// 引用口径 + @ 自检 —— 主人 m10890 的原话：
//   「qq机器人会主动引用别人的消息回复如图片里的那样，之前有一个攒了大量对话挑最新的回的机制
//     现在迭代更新为qq机器人自主选择最有意思最有梗的那条引用回复，同理面对两个人都在和自己聊天时，
//     引用回复具体信息（选择性不是每条都回）。同理qq机器人也要会新的@功能，知道吗？」
//
// ⚠️ 2026-10-13 修正（主人连着吐槽四次：「你怎么在群里句句引用」「不是你怎么又在每句都引用你是人机？」
//    「干嘛你还引用？」）。第一版把这个需求实现**过头了**：
//    quoteGuideV2 里只要 `unread >= 1` 就注入【该引用时就引用】，等于**群里有任何一条未读就催引用**，
//    再叠加唤醒提示里的【引用：主动挑一条】与工具描述里的「首选主动引用」——
//    实测群聊引用率从 0%（10-12）被推到 90%（10-13 13:16 起），每条短句都挂着引用条，最像人机。
//
//    现在的口径（本文件锁定的就是这个）：
//      · 引用**默认关闭**；只有两处必须引：① 两个人以上同时在跟她说话；② 她接的不是最新那一条。
//      · quoteGuideV2 只在「多人同时在找她」时注入；未读多/未读少两档**不再**催引用。
//      · 人格层、preset、工具描述都写「默认不引」，并且明确禁止句句引用。
//    主人原话里的「选择性不是每条都回」才是重点 —— 引用是**例外**，不是常态。
//
// 为什么引导放在桥接层而不是只写角色卡：这段判断依赖**运行时**信息（未读里有几条、几个不同的人
// 在 @ 她），静态角色卡算不出来；而且放桥接层改完即热生效，不用重建 preset、不用新建会话。
//
// 断言分五层：①quoteGuideV2 的分档与边界 ②@ 引导恒定存在且措辞克制
// ③buildWakePromptV2 真的把 quoteLine 拼进 base ④未读接口标出「在找我」与多人在找
// ⑤两层文本（角色卡 + preset）与控制台/工具描述同步。
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

const base = 1_800_000_000_000;
/** 造一条入站消息（形状照抄 appendSocialV2Message push 进 st.unread 的对象）。 */
const inbound = (seq, time, extra = {}) => ({
  seq, messageId: `m${seq}`, sender: `群友${seq}`, userId: String(1000 + seq),
  text: `消息${seq}`, plain: `消息${seq}`, tail: `消息${seq}`,
  quoteTargetIsSelf: false, isOwner: false, ownerLabel: '', isSelf: false,
  media: [], hasMedia: false, forwardIds: [], hasForward: false, time, ...extra,
});

try {
  const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

  section('quoteGuideV2：只在群聊给');
  ok(typeof h.quoteGuideV2 === 'function', 'harness 导出了 quoteGuideV2');
  const groupSt = h.getSocialV2State('group:2000000001');
  groupSt.unread = [];
  ok(h.quoteGuideV2('group:2000000001', groupSt).includes('@'), '群聊里即使没有未读也给 @ 用法说明');
  ok(h.quoteGuideV2('private:123', groupSt) === '', '私聊一律返回空串（一对一引用没有信息量，只会啰嗦）');
  ok(h.quoteGuideV2('group:2000000001', null).includes('@'), '状态为 null 也不抛错（仍给群聊 @ 说明）');

  section('分档一：两个以上的人在找她 → 分开回、各自引用');
  const two = h.getSocialV2State('group:2000000001');
  two.unread = [
    inbound(1, base + 1000, { sender: '阿甲', userId: '11', plain: '鲸鱼这个怎么样', text: '鲸鱼这个怎么样' }),
    inbound(2, base + 2000, { sender: '阿乙', userId: '22', plain: '鲸鱼在吗', text: '鲸鱼在吗' }),
  ];
  const twoLine = h.quoteGuideV2('group:2000000001', two);
  ok(twoLine.includes('【多人在找你】'), '两个人同时找她 → 注入【多人在找你】');
  ok(twoLine.includes('2 个人同时在跟你说话'), '写明了有几个人在找她（2）');
  ok(twoLine.includes('阿甲') && twoLine.includes('阿乙'), '把两个人的名字都列出来（便于分别引用）');
  ok(twoLine.includes('分两条、各自引用'), '要求分两条各自引用，而不是一条消息应付两个人');
  ok(!twoLine.includes('【挑一条引用】'), '这一档不再叠加【挑一条引用】（分档互斥，避免自相矛盾的引导）');

  section('分档二：一个人找她 + 未读 ≥3 → 不催引用（2026-10-13 收窄）');
  const many = h.getSocialV2State('group:2000000001');
  many.unread = [
    inbound(1, base + 1000), inbound(2, base + 2000), inbound(3, base + 3000),
    inbound(4, base + 4000, { sender: '阿甲', userId: '11', plain: '鲸鱼在吗', text: '鲸鱼在吗' }),
  ];
  const manyLine = h.quoteGuideV2('group:2000000001', many);
  ok(!manyLine.includes('【挑一条引用】'), '未读 ≥3 但只有一个人在找她 → **不再**注入【挑一条引用】（这就是句句引用的源头）');
  ok(!manyLine.includes('【多人在找你】'), '只有一个在找她时不提「多人在找你」');
  ok(manyLine.includes('【@ 怎么用】'), '即使不催引用，@ 的用法说明照给');

  section('分档三：未读很少 → 同样不催引用');
  const few = h.getSocialV2State('group:2000000001');
  few.unread = [inbound(1, base + 1000)];
  const fewLine = h.quoteGuideV2('group:2000000001', few);
  ok(!fewLine.includes('【该引用时就引用】'), '未读只有 1 条 → **不再**给「该引用时就引用」（以前这里让群里每条未读都催引用）');
  ok(!fewLine.includes('【挑一条引用】') && !fewLine.includes('【多人在找你】'), '轻档不叠加前两档');
  const empty = h.getSocialV2State('group:2000000001');
  empty.unread = [];
  ok(!h.quoteGuideV2('group:2000000001', empty).includes('【该引用时就引用】'), '一条未读都没有时不硬教引用');

  section('计数口径：自己发的、拍一拍、引用她的都要正确对待');
  const edge = h.getSocialV2State('group:2000000001');
  edge.unread = [
    inbound(1, base + 1000, { sender: '阿甲', userId: '11', plain: '鲸鱼在吗', text: '鲸鱼在吗' }),
    inbound(2, base + 2000, { sender: '阿乙', userId: '22', plain: '乙', text: '乙', quoteTargetIsSelf: true }),
    inbound(3, base + 3000, { sender: '阿甲', userId: '11', isSelf: true, plain: '鲸鱼在吗', text: '鲸鱼在吗' }),
    inbound(4, base + 4000, { sender: '阿丙', userId: '33', kind: 'poke' }),
  ];
  const edgeLine = h.quoteGuideV2('group:2000000001', edge);
  ok(edgeLine.includes('2 个人同时在跟你说话'), '同一人多次只算一个人；自己发的与拍一拍不计入（仍是 2 人）');

  section('@ 引导：恒定存在，且措辞是"点名不是标点"');
  ok(edgeLine.includes('【@ 怎么用】'), '每一档都带【@ 怎么用】');
  ok(edgeLine.includes('atUserId'), '写明参数名 atUserId');
  ok(edgeLine.includes('最多 @ 一个人'), '明确限制一条消息最多 @ 一个人（防刷屏）');
  ok(edgeLine.includes('别每条都 @'), '明确禁止每条都 @');

  section('接线：buildWakePromptV2 真的把 quoteLine 拼进 base');
  const gst = h.getSocialV2State('group:2000000001');
  gst.wakeConfig = { mode: 'diving', infinite: true, batchWindowMs: 8000, confirmedBy: 'test', triggers: { atMention: true, nameMention: true, speakerIds: [], keywords: [], question: true, poke: true, anyMessage: false, probability: 0.12 } };
  gst.lastAiReplyAt = 0;
  gst.unread = [
    inbound(1, base + 1000, { sender: '阿甲', userId: '11', plain: '鲸鱼这个怎么样', text: '鲸鱼这个怎么样' }),
    inbound(2, base + 2000, { sender: '阿乙', userId: '22', plain: '鲸鱼在吗', text: '鲸鱼在吗' }),
  ];
  gst.recentMessages = [...gst.unread];
  const prompt = String(h.buildWakePromptV2('group:2000000001', 'probability') ?? '');
  ok(prompt.includes('【多人在找你】'), '概率唤醒的群聊提示词里带上了【多人在找你】');
  ok(prompt.includes('【@ 怎么用】'), '提示词里带上了 @ 用法');
  const atPrompt = String(h.buildWakePromptV2('group:2000000001', 'atMention') ?? '');
  ok(atPrompt.includes('【@ 怎么用】'), '被 @ 叫起来时也给 @ 用法（她正要回话）');
  const privateSt = h.getSocialV2State('private:123');
  privateSt.unread = [...gst.unread];
  privateSt.recentMessages = [...gst.unread];
  const privatePrompt = String(h.buildWakePromptV2('private:123', 'private') ?? '');
  ok(!privatePrompt.includes('【多人在找你】') && !privatePrompt.includes('【@ 怎么用】'),
    '私聊提示词里一个字都不提引用/@（一对一没有信息量）');

  section('接线守卫：源码里的调用点存在（防纯函数变死代码）');
  ok(/const quoteLine = quoteGuideV2\(key, st\);/.test(bridgeSrc), 'buildWakePromptV2 里真的调用了 quoteGuideV2');
  ok(/statusLine \+ backlogLine \+ quoteLine \+ wakeLine/.test(bridgeSrc), 'quoteLine 被拼进 base（在 wakeLine 之前）');
  // ★ 2026-10-13 收窄：默认唤醒分支必须写「默认不引」，不能再是「主动挑一条」。
  ok(bridgeSrc.includes('【引用：默认不引】'), '默认唤醒分支的引用口径是「默认不引」（只有多人/非最新才引）');
  ok(!/lines\.push\(`【挑一条引用】/.test(bridgeSrc), '【挑一条引用】不再作为注入项存在（只允许出现在注释里）');
  ok(!/lines\.push\('【该引用时就引用】/.test(bridgeSrc), '【该引用时就引用】不再作为注入项存在');
  ok(bridgeSrc.includes('接最新那条') , '积压/唤醒分支写明了「接最新那条就不用引用」');

  section('未读接口：标出"在找我"与多人在找');
  ok(/directedToMe/.test(bridgeSrc) && /multiAsker/.test(bridgeSrc),
    'GET /api/socialV2/unread 给每条未读补 directedToMe 并在顶层给 multiAsker');
  ok(/replyHint/.test(bridgeSrc), '在找我的那条附带 replyHint（告诉模型用 qq_reply 引用它）');

  section('两层文本（角色卡 + 仿真层 preset）');
  const roleCard = fs.readFileSync(path.join(root, 'roles/小鲸鱼.md'), 'utf8');
  ok(!roleCard.includes('主动引用'), '人格层**删掉了**「主动引用」（那是句句引用的源头）');
  ok(/不要引用|不引/.test(roleCard), '人格层写了「默认不引」的硬规矩');
  ok(roleCard.includes('句句引用是最像人机的表现'), '人格层点明了「句句引用最像人机」');
  ok(roleCard.includes('两个人同时找你，分开回、各自引用'), '人格层写了「两个人同时找你，分开回、各自引用」');
  ok(roleCard.includes('@ 是点名，不是标点'), '人格层写了「@ 是点名，不是标点」');
  const presetSrc = fs.readFileSync(path.join(root, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  ok(!presetSrc.includes('主动引用'), '仿真层（preset）**删掉了**「主动引用」');
  ok(presetSrc.includes('句句引用是最像人机的表现'), '仿真层点明了「句句引用最像人机」');
  ok(presetSrc.includes('分开回、各自引用'), '仿真层写了「分开回、各自引用」');
  ok(presetSrc.includes('@ 是点名，不是标点'), '仿真层写了「@ 是点名，不是标点」');

  section('工具描述：群聊默认不引（不再劝她主动引用）');
  const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  ok(mcpSrc.includes('群聊里**默认不引用**'), 'qq_send_message 描述改成「群聊里默认不引用」');
  ok(!mcpSrc.includes('优先主动引用'), 'qq_reply/send_message 描述里**不再**出现「优先主动引用」');
  ok(!mcpSrc.includes('这是**群聊里首选的回复方式**'), 'qq_reply 不再是「群聊里首选的回复方式」（引用是例外，不是默认）');
  ok(mcpSrc.includes('有两个人以上同时在跟你说话时**必须**引用'), 'qq_reply 描述写明了多人同时说话必须引用');
} finally {
  await h.close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
