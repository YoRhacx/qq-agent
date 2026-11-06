#!/usr/bin/env node
// 接话冷却（socialV2.reply.minGapMs / minGapDirectedMs）自检 —— 主人 2026-10-12 的「2+1」里那个"2"。
//
// 为什么需要这个功能：实测（2026-10-11 晚）她在群里 21 点那一小时发了 21 条、群友只有 16 条，
// 接话 20 次里 12 次是拆成 2~3 条发的 —— 也就是"几乎每条都接、而且接得很快"。
// 提醒/定时那类固定时刻的唤醒不能延后（否则提醒会迟到），只有"被消息叫醒"的场合才走冷却。
//
// 断言分四层：①出厂默认值 ②纯函数 replyGapWaitMsV2 的判定 ③scheduleWakeV2 真的用了它
// ④控制台界面（主人明确要求"功能要有修改的界面"）与提示词两层。
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

try {
  const now = 1_800_000_000_000;
  const cfg = { minGapMs: 30000, minGapDirectedMs: 12000 };

  section('出厂默认与配置归位');
  ok(h.cfg?.socialV2?.reply?.minGapMs === 30000, '默认 reply.minGapMs = 30000（30 秒）');
  ok(h.cfg?.socialV2?.reply?.minGapDirectedMs === 12000, '默认 reply.minGapDirectedMs = 12000（12 秒）');
  ok(h.cfg?.socialV2?.wake?.softWakeCooldownMs === 180000, '默认 wake.softWakeCooldownMs = 180000（原来只写死在代码里读）');
  ok(h.cfg?.socialV2?.wake?.softWakePerHour === 6, '默认 wake.softWakePerHour = 6');
  const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  ok(/for \(const k of \['minGapMs', 'minGapDirectedMs'\]\)/.test(bridgeSrc),
    '控制台保存路径会把 reply.minGapMs / minGapDirectedMs 归一化成非负整数（上限 1 小时）');
  ok(/'softWakeCooldownMs', 'softWakePerHour'/.test(bridgeSrc),
    'wake 的数值归一名单里包含 softWakeCooldownMs / softWakePerHour（否则界面填了会被原样存成字符串）');

  section('纯函数 replyGapWaitMsV2：判定规则');
  ok(typeof h.replyGapWaitMsV2 === 'function', 'harness 导出了 replyGapWaitMsV2');
  ok(typeof h.isDirectedWakeReasonV2 === 'function', 'harness 导出了 isDirectedWakeReasonV2');

  const normal = h.replyGapWaitMsV2('anyMessage', now - 10000, cfg, now);
  ok(normal.waitMs === 20000, '普通消息：刚说过 10s → 还要等 20s（30s 冷却）');
  ok(normal.directed === false, '普通消息不算定向');
  const directed = h.replyGapWaitMsV2('atMention', now - 10000, cfg, now);
  ok(directed.waitMs === 2000, '@ 唤醒：刚说过 10s → 还要等 2s（12s 定向冷却）');
  ok(directed.directed === true, '@ 唤醒算定向');
  ok(h.replyGapWaitMsV2('atMention', now - 12000, cfg, now).waitMs === 0, '冷却走完（正好 12s）→ 不延后');
  ok(h.replyGapWaitMsV2('atMention', now - 60000, cfg, now).waitMs === 0, '冷却早走完 → 不延后');
  ok(h.replyGapWaitMsV2('atMention', 0, cfg, now).waitMs === 0, '还没说过话（lastAiReplyAt=0）→ 不延后');
  ok(h.replyGapWaitMsV2('atMention', 0, cfg, now).skipped === 'no-reply-yet', '未说过话的跳过原因可读');

  for (const reason of ['keyword:小鲸鱼', 'question', 'poke', 'speaker:某群友', 'nameMention', 'atMention']) {
    ok(h.isDirectedWakeReasonV2(reason) === true, `「${reason}」被识别为定向唤醒（用更短的冷却）`);
  }
  for (const reason of ['anyMessage', 'probability', 'replyCheck', 'proactiveCheck', 'bootstrap']) {
    ok(h.isDirectedWakeReasonV2(reason) === false, `「${reason}」不是定向唤醒`);
  }

  // 固定时刻的唤醒（提醒/定时/睡眠到期/首帧）绝不能因为"刚说过话"而迟到。
  for (const reason of ['reminder:打卡', 'schedule:早报', 'timeout', 'bootstrap']) {
    const r = h.replyGapWaitMsV2(reason, now - 1000, cfg, now);
    ok(r.waitMs === 0 && r.skipped === 'fixed-time', `固定时刻「${reason}」不延后（否则提醒会迟到）`);
  }

  const off = h.replyGapWaitMsV2('atMention', now - 1000, { minGapMs: 0, minGapDirectedMs: 0 }, now);
  ok(off.waitMs === 0 && off.skipped === 'disabled', '配置成 0 = 关闭冷却');
  ok(h.replyGapWaitMsV2('atMention', now - 1000, undefined, now).waitMs === 0, '完全没有 reply 配置时也不延后（缺省即关闭）');

  section('接线：scheduleWakeV2 真的把冷却算进定时器');
  ok(/const gap = replyGapWaitMsV2\(reason, st\.lastAiReplyAt, cfg\.socialV2\?\.reply\);/.test(bridgeSrc),
    'scheduleWakeV2 里调用了 replyGapWaitMsV2(reason, st.lastAiReplyAt, cfg.socialV2?.reply)');
  ok(/const batchMs = Math\.max\(jitteredBatchMs, gap\.waitMs\);/.test(bridgeSrc),
    '最终延迟 = max(合批窗口+抖动, 冷却剩余) —— 延后但不丢消息');

  h.setMode('reserved2');
  h.setReady(true);
  const key1 = 'group:456';
  const st1 = h.getSocialV2State(key1);
  st1.wakeConfig = { ...(st1.wakeConfig ?? {}), batchWindowMs: 8000 };
  st1.lastAiReplyAt = Date.now() - 2000;           // 刚说过话（2 秒前）
  h.scheduleWakeV2(key1, 'atMention');
  const t1 = h.getSocialV2State(key1).pendingWakeTimer;
  const d1 = typeof t1?._idleTimeout === 'number' ? t1._idleTimeout : -1;
  ok(d1 >= 9000, `刚说完话时被 @ → 定时器被抬到冷却剩余（实测 ${d1}ms，应 ≥10000 左右）`);

  const key2 = 'private:123';
  const st2 = h.getSocialV2State(key2);
  st2.wakeConfig = { ...(st2.wakeConfig ?? {}), batchWindowMs: 8000 };
  st2.lastAiReplyAt = Date.now() - 600000;         // 十分钟前说过话，冷却早过了
  h.scheduleWakeV2(key2, 'atMention');
  const t2 = h.getSocialV2State(key2).pendingWakeTimer;
  const d2 = typeof t2?._idleTimeout === 'number' ? t2._idleTimeout : -1;
  ok(d2 >= 8000 && d2 <= 16000, `冷却已过 → 只按合批窗口 + 抖动（实测 ${d2}ms，应在 8000~16000）`);

  section('控制台界面（主人要求：功能要有地方改，不能固定死）');
  const consoleHtml = fs.readFileSync(path.join(root, 'public/console.html'), 'utf8');
  for (const id of ['v2ReplyMinGapSec', 'v2ReplyMinGapDirectedSec', 'v2SoftWakeCooldownSec', 'v2SoftWakePerHour']) {
    ok(consoleHtml.includes(`id="${id}"`), `控制台有输入框 ${id}`);
    ok(new RegExp(`getElementById\\('${id}'\\)\\.value`).test(consoleHtml), `${id} 有读入（回显当前值）`);
  }
  ok(/minGapMs: Math\.round\(Number\(document\.getElementById\('v2ReplyMinGapSec'\)\.value\) \|\| 0\) \* 1000/.test(consoleHtml),
    '控制台保存时把"秒"换算成 minGapMs（毫秒）');
  ok(/minGapDirectedMs: Math\.round\(Number\(document\.getElementById\('v2ReplyMinGapDirectedSec'\)\.value\) \|\| 0\) \* 1000/.test(consoleHtml),
    '控制台保存时把"秒"换算成 minGapDirectedMs（毫秒）');
  ok(consoleHtml.includes('接话频率与冷却'), '控制台有「接话频率与冷却」分组（找不到地方改的问题就此解决）');

  section('提示词两层');
  const roleCard = fs.readFileSync(path.join(root, 'roles/小鲸鱼.md'), 'utf8');
  ok(roleCard.includes('## 二十七、指代与命名'), '人格层有 §二十七 指代与命名');
  ok(roleCard.includes('## 二十八、语癖'), '人格层有 §二十八 语癖');
  ok(roleCard.includes('一次只发一条'), '人格层写明了「一次只发一条，别拆条」');
  ok(roleCard.includes('嘿嘿') && roleCard.includes('啦'), '人格层写了语癖 嘿嘿 / 啦');
  ok(/第一次出现[\s\S]{0,40}(指示代词|全称)/.test(roleCard), '人格层写了"第一次出现用指示代词 + 全称"');
  ok(roleCard.includes('别复述对方刚发的东西'), '人格层写了「别复述对方刚发的东西」（主人 07:25 那条反馈）');

  const presetSrc = fs.readFileSync(path.join(root, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  for (const title of ['【别拆条：同一个意群不要拆开', '【指代与命名：第一次说清', '【语癖：偶尔用「嘿嘿」「啦」']) {
    ok(presetSrc.includes(title), `仿真层有「${title}…」`);
  }
  const patch = path.join(root, 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
  if (fs.existsSync(patch)) {
    const built = fs.readFileSync(patch, 'utf8');
    ok(built.includes('指代与命名') && built.includes('语癖') && built.includes('别拆条'),
      'preset patch 产物已重建（含三段新提示词）—— 别忘 node scripts/build-agent-preset-patches.mjs');
  } else {
    ok(false, 'preset patch 产物不存在：先跑 node scripts/build-agent-preset-patches.mjs');
  }
} finally {
  await h.close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
