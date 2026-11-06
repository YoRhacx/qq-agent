// DSH 端点自愈的**桥接层**回归（m00138「根治」）：
//   config 里的 dsh.baseUrl 是手写的、会随 DSH 重启失效（桌面版 --port 0 每次换端口）。
//   src/dsh-discovery.js 负责"找到 DSH"，本文件负责"桥接真的切过去、并且不乱切"。
//
// 为什么必须单独钉住：
//   端口一变，症状是控制台每 3 秒一行「连接 DSH 事件流…」、dshReady 永远 false，
//   而**不抛任何错**（WS 连不上时生成器只是正常 return，catch 不触发）—— 属于
//   「沉默型故障」，只能靠断言，不能靠"看着挺正常"。
//
// 这里不给真的网络：discoverDshEndpoint 由调用方注入桩，只验接线与状态机。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error?.message ?? error)); }
};

// 可编程的发现桩：默认"什么都没找到"，测试里改 state.result / state.error。
const state = { calls: 0, lastOpts: null, result: null, error: null };
const stub = async (opts) => {
  state.calls += 1;
  state.lastOpts = opts;
  if (state.error) throw state.error;
  return state.result;
};

// ── 1. 总闸：followDiscoveredEndpoint=false 时一次都不发现 ──
await test('followDiscoveredEndpoint=false 时完全不触发发现', async () => {
  state.calls = 0;
  const h = await bridgeHarness({
    config: { dsh: { baseUrl: 'http://127.0.0.1:19387', followDiscoveredEndpoint: false } },
    globals: { discoverDshEndpoint: stub },
  });
  try {
    // main() 启动时就会 force 调一次；总闸关着必须直接返回 false 且不调发现。
    assert.equal(await h.ensureDshEndpoint({ reason: '测试', force: true }), false);
    assert.equal(state.calls, 0, '总闸关着还去调 discoverDshEndpoint 了');
    assert.equal(h.api.baseUrl, 'http://127.0.0.1:19387');
  } finally { await h.close(); }
});

// ── 2. 找到新端点 → 真的切过去，并把来源/鉴权记进状态 ──
await test('发现到新端点后桥接切换到它（并记录 source/authOk）', async () => {
  state.calls = 0; state.result = null; state.error = null;
  const h = await bridgeHarness({
    config: { dsh: { baseUrl: 'http://127.0.0.1:19387' } },
    globals: { discoverDshEndpoint: stub },
  });
  try {
    // harness 的 main() 在 return 处提前退出（vm 里不跑真正的主循环），所以启动时不探测。
    const baseline = state.calls;
    assert.equal(h.api.baseUrl, 'http://127.0.0.1:19387', '没有候选时不该动 baseUrl');
    // 先来一次"没找到"：状态里要留下原因，否则控制台看到 dshReady:false 也无从判断。
    assert.equal(await h.ensureDshEndpoint({ force: true }), false);
    assert.equal(h.dshEndpoint.lastError, '候选中没有 DSH');
    const afterMiss = state.calls;

    state.result = { baseUrl: 'http://127.0.0.1:51144', source: 'listen:DeepSeek Harness.exe', authOk: true };
    const changed = await h.ensureDshEndpoint({ reason: '启动后仍未就绪', force: true });
    assert.equal(changed, true, '发现到新端点必须返回 true');
    assert.equal(h.api.baseUrl, 'http://127.0.0.1:51144', 'api.baseUrl 必须真的切到新端点');
    assert.equal(h.dshEndpoint.baseUrl, 'http://127.0.0.1:51144');
    assert.equal(h.dshEndpoint.source, 'listen:DeepSeek Harness.exe', '来源要能回答"这个端点是哪来的"');
    assert.equal(h.dshEndpoint.authOk, true);
    assert.equal(h.dshEndpoint.lastError, '');
    assert.equal(state.calls, afterMiss + 1);
    // 发现桩必须收到"当前端点 / 缓存文件 / 取 Cookie 的回调"，否则缓存复用与复验都会失灵。
    assert.equal(state.lastOpts.current, 'http://127.0.0.1:19387');
    assert.match(String(state.lastOpts.stateFile), /dsh-endpoint\.json$/);
    assert.equal(typeof state.lastOpts.cookieFor, 'function');
  } finally { await h.close(); }
});

// ── 3. 端点没变 → 返回 false，不重复"切换"（避免日志刷屏与无效失效鉴权）──
await test('发现到的端点与当前一致时不切换', async () => {
  state.calls = 0; state.result = null; state.error = null;
  const h = await bridgeHarness({
    config: { dsh: { baseUrl: 'http://127.0.0.1:19387' } },
    globals: { discoverDshEndpoint: stub },
  });
  try {
    state.result = { baseUrl: 'http://127.0.0.1:51144', source: 'cache', authOk: true };
    assert.equal(await h.ensureDshEndpoint({ force: true }), true);
    assert.equal(await h.ensureDshEndpoint({ force: true }), false, '端点没变还返回 true 会导致每次心跳都打切换日志');
    assert.equal(h.api.baseUrl, 'http://127.0.0.1:51144');
  } finally { await h.close(); }
});

// ── 4. 节流：非 force 的调用 10 秒内不重复探测（netstat 不能当心跳）──
await test('非 force 调用在节流窗口内不再探测', async () => {
  state.calls = 0; state.result = null; state.error = null;
  const h = await bridgeHarness({
    config: { dsh: { baseUrl: 'http://127.0.0.1:19387' } },
    globals: { discoverDshEndpoint: stub },
  });
  try {
    // 先 force 一次，把 lastAttemptAt 推到"刚刚"，于是后续非 force 调用必然落在节流窗口内。
    await h.ensureDshEndpoint({ force: true });
    const afterForce = state.calls;
    assert.equal(await h.ensureDshEndpoint({ reason: '心跳' }), false);
    assert.equal(state.calls, afterForce, '10 秒内又探测了一次（netstat 不能当心跳跑）');
    // force 必须绕过节流（启动 / 就绪后失联要走这条路）。
    await h.ensureDshEndpoint({ force: true });
    assert.equal(state.calls, afterForce + 1, 'force 没有绕过节流');
  } finally { await h.close(); }
});

// ── 5. 发现过程抛错 → 不崩、记下原因（不能让一次 netstat 失败把桥接带走）──
await test('发现抛错时只记 lastError，不抛出', async () => {
  state.calls = 0; state.result = null; state.error = new Error('netstat 不可用');
  const h = await bridgeHarness({
    config: { dsh: { baseUrl: 'http://127.0.0.1:19387' } },
    globals: { discoverDshEndpoint: stub },
  });
  try {
    assert.equal(await h.ensureDshEndpoint({ force: true }), false);
    assert.equal(h.api.baseUrl, 'http://127.0.0.1:19387', '发现失败不得改动当前端点');
    assert.match(h.dshEndpoint.lastError, /netstat 不可用/);
  } finally { await h.close(); }
});

console.log(`结果：${failures === 0 ? '全部通过' : failures + ' 失败'}`);
if (failures) process.exit(1);