// 唤醒延迟（合批窗口 + 拟人化抖动）的自检。
// 背景：主人要求「不要有应就回，@ 了也别马上就回，可以装死一小会」。固定窗口意味着
// 「每次都在第 N 秒开口」，本身也是机器味；所以被消息叫醒的场合要散开。
// 但固定时刻的唤醒（提醒/定时/睡眠到期/首帧）绝不能抖，否则提醒会迟到 —— 这两条边
// 都在这里钉住。跑法：node scripts/test-wake-jitter.mjs（也可 pnpm test:wake-jitter）

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let passed = 0;
let failed = 0;
function ok(msg) { passed++; console.log(`✅ ${msg}`); }
function bad(msg) { failed++; console.log(`❌ ${msg}`); }
function check(fn, msg) {
  try { fn(); ok(msg); } catch (error) { bad(`${msg} —— ${error.message}`); }
}

// 固定 random 便于确定性断言：0 -> 抖 0；0.5 -> 抖一半窗口；0.999… -> 贴近窗口上限。
const zero = () => 0;
const half = () => 0.5;
const almostOne = () => 0.999999;

async function main() {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false } } } });
  try {
    const delay = h.wakeDelayMsV2;
    if (typeof delay !== 'function') { bad('harness 没有导出 wakeDelayMsV2'); return; }

    // —— 被消息叫醒：必须抖 ——
    for (const reason of ['private', 'atMention', 'question', 'speaker', 'nameMention', 'keyword', 'anyMessage', 'poke', 'replyCheck', 'proactiveCheck']) {
      const r = delay(reason, 8000, half);
      check(() => assert.equal(r.jittered, true), `${reason}：窗口 8000 会抖动`);
      check(() => assert.equal(r.baseBatchMs, 8000), `${reason}：窗口原样保留（8000）`);
      check(() => assert.equal(r.batchMs, 8000 + 4000), `${reason}：random=0.5 → 实际 12 秒`);
    }

    // —— 抖动落在 [0, 窗口) ——
    check(() => assert.equal(delay('private', 8000, zero).batchMs, 8000), 'random=0 → 不加抖动（等于窗口下限）');
    check(() => assert.equal(delay('private', 8000, almostOne).jitterMs, 7999), 'random→1 → 抖动 7999ms（严格小于窗口）');
    check(() => {
      const seen = new Set();
      for (let i = 0; i < 200; i++) {
        const d = delay('atMention', 8000);
        assert.ok(d.jitterMs >= 0 && d.jitterMs < 8000, `抖动越界：${d.jitterMs}`);
        assert.ok(d.batchMs >= 8000 && d.batchMs < 16000, `总延迟越界：${d.batchMs}`);
        seen.add(d.jitterMs);
      }
      assert.ok(seen.size > 50, `真随机下 200 次应该出现很多不同值，实际只有 ${seen.size} 种`);
    }, '真随机：200 次都落在 [8000, 16000) 且取值分散');

    // —— 固定时刻的唤醒：一律不准抖 ——
    for (const reason of ['bootstrap', 'timeout', 'reminder:r-123', 'schedule:goodnight']) {
      const r = delay(reason, 30000, half);
      check(() => assert.equal(r.jittered, false), `${reason}：不准抖动`);
      check(() => assert.equal(r.jitterMs, 0), `${reason}：抖动为 0`);
      check(() => assert.equal(r.batchMs, 30000), `${reason}：延迟严格等于窗口`);
    }

    // —— 小窗口保持历史行为（老部署 batchWindowMs=2000 完全不变）——
    check(() => assert.equal(delay('atMention', 2000, half).batchMs, 2000), '窗口 2000 < 4000：不抖，延迟 2000');
    check(() => assert.equal(delay('atMention', 2000, half).jittered, false), '窗口 2000：jittered=false');
    check(() => assert.equal(delay('atMention', 3999, half).batchMs, 3999), '窗口 3999：仍在阈值下，不抖');
    check(() => assert.equal(delay('atMention', 4000, half).batchMs, 6000), '窗口 4000：正好到阈值，开始抖');

    // —— 脏输入兜底 ——
    check(() => assert.equal(delay('atMention', undefined, zero).baseBatchMs, 8000), '窗口缺省 → 8000');
    check(() => assert.equal(delay('atMention', 0, zero).baseBatchMs, 8000), '窗口 0 → 沿用老语义回落到 8000（0 是假值；接口本身也拒绝 <1000）');
    check(() => assert.equal(delay('atMention', -5, zero).baseBatchMs, 1000), '窗口负数 → 抬到 1000');
    check(() => assert.equal(delay('atMention', 'abc', zero).baseBatchMs, 8000), '窗口非数字 → 8000');
    check(() => assert.equal(delay(undefined, 2000, half).batchMs, 2000), 'reason 缺失 → 当成普通唤醒但不抖（窗口过小）');
    check(() => assert.equal(delay('', 8000, half).jittered, true), 'reason 空串 → 按普通消息唤醒处理（会抖）');

    // —— 接线守卫：scheduleWakeV2 必须真的用这个纯函数，别让它变成死代码 ——
    const source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
    check(() => assert.match(source, /const \{ baseBatchMs, jitterMs, batchMs: jitteredBatchMs \} = wakeDelayMsV2\(reason, st\.wakeConfig\?\.batchWindowMs\);/),
      'scheduleWakeV2 用的是 wakeDelayMsV2(reason, st.wakeConfig?.batchWindowMs)（解构出来叫 jitteredBatchMs，'
      + '因为后面还要跟接话冷却取 max，见 src/bridge.js 的 replyGapWaitMsV2）');
    const schedIdx = source.indexOf('function scheduleWakeV2(');
    const useIdx = source.indexOf('wakeDelayMsV2(reason, st.wakeConfig?.batchWindowMs)');
    check(() => assert.ok(schedIdx > 0 && useIdx > schedIdx), '调用点在 scheduleWakeV2 之后（同一个函数体内）');
  } finally {
    await h.close?.();
  }

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

test('唤醒延迟：窗口 + 拟人化抖动', main);
