// 「主人私聊是唯一允许谈后台/工具的会话」这条边界的自检。
// 背景：主人要求「不要让她把 DSH 后台/调工具的事说出来 —— 但对管理员（也就是主人自己）
// 的私聊可以」。规则本身写在角色卡 §二十二 与 preset 里，属于提示词；但**她怎么知道
// 『当前这条私聊是不是主人自己的』**不该靠她猜 QQ 号，所以唤醒提示词里显式点名
// （src/bridge.js 的 buildWakePromptV2 里的 ownerLine）。
// 这里钉三件事：① 主人私聊有这行；② 群里没有；③ 别人的私聊也没有；④ 没配 ownerQQ 时谁都没有。
// 跑法：node scripts/test-owner-private-scope.mjs

import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 1000000001;
const OTHER = 3000000001;
const GROUP = 2000000001;
const MARK = '【会话身份】';

let passed = 0;
let failed = 0;
function ok(msg) { passed++; console.log(`✅ ${msg}`); }
function bad(msg) { failed++; console.log(`❌ ${msg}`); }
function check(fn, msg) {
  try { fn(); ok(msg); } catch (error) { bad(`${msg} —— ${error.message}`); }
}

/** 取一条唤醒提示词（buildWakePromptV2 是纯拼接，不发送、不落盘）。 */
function promptFor(h, key, reason) {
  const build = h.buildWakePromptV2;
  if (typeof build !== 'function') throw new Error('harness 没有导出 buildWakePromptV2');
  return String(build(key, reason) ?? '');
}

async function main() {
  // —— 配了 ownerQQ 的正常情况 ——
  const h = await bridgeHarness({
    config: {
      ownerQQ: OWNER,
      socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false } },
    },
  });
  try {
    const ownerPrompt = promptFor(h, `private:${OWNER}`, 'private');
    check(() => assert.ok(ownerPrompt.includes(MARK)), '主人私聊的唤醒提示词里有【会话身份】');
    check(
      () => assert.ok(ownerPrompt.includes('只有在这条会话里')),
      '主人私聊：明确写着「只有在这条会话里」可以坦白后台/工具',
    );
    check(
      () => assert.ok(ownerPrompt.includes('我背后是 DSH')),
      '主人私聊：给了可坦白的样例说法（我背后是 DSH）',
    );
    check(
      () => assert.ok(ownerPrompt.includes('§二十二')),
      '主人私聊：指回角色卡 §二十二 第 7 条，规则只有一份来源',
    );
    check(
      () => assert.ok(ownerPrompt.includes('一个都不许出现')),
      '主人私聊：同一行里重申「群里/别人私聊一个字都不许提」',
    );

    // 群聊：绝不能出现这行
    for (const reason of ['atMention', 'question', 'anyMessage', 'proactiveCheck']) {
      const groupPrompt = promptFor(h, `group:${GROUP}`, reason);
      check(() => assert.ok(!groupPrompt.includes(MARK)), `群聊（${reason}）：没有【会话身份】这行`);
      check(
        () => assert.ok(!groupPrompt.includes('我背后是 DSH')),
        `群聊（${reason}）：不会告诉她可以坦白后台`,
      );
    }

    // 别人的私聊：同样绝不能出现
    const otherPrompt = promptFor(h, `private:${OTHER}`, 'private');
    check(() => assert.ok(!otherPrompt.includes(MARK)), '其他人的私聊：没有【会话身份】这行');
    check(() => assert.ok(!otherPrompt.includes('我背后是 DSH')), '其他人的私聊：不会告诉她可以坦白后台');

    // 提示词本身没坏：该有的段落还在（防止我把 base 拼串写错）
    check(() => assert.ok(ownerPrompt.includes('【会话令牌】')), '提示词仍带【会话令牌】');
    check(() => assert.ok(ownerPrompt.includes('【首回复节奏】')), '提示词仍带【首回复节奏】');
    check(() => assert.ok(ownerPrompt.includes('【沉睡前强制等待】')), '提示词仍带【沉睡前强制等待】');
  } finally {
    try { await h.dispose?.(); } catch { /* 忽略 */ }
  }

  // —— 没配 ownerQQ：谁都不该拿到这行（fail-closed，不能人人都算主人）——
  const h2 = await bridgeHarness({
    config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false } } },
  });
  try {
    const p = promptFor(h2, `private:${OWNER}`, 'private');
    check(() => assert.ok(!p.includes(MARK)), '未配置 ownerQQ 时，即使 QQ 号对得上也没有【会话身份】这行');
  } finally {
    try { await h2.dispose?.(); } catch { /* 忽略 */ }
  }

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`❌ 测试自身抛错：${error?.message ?? error}`);
  process.exit(1);
});
