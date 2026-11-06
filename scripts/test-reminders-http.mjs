// 「到点提醒」（/api/socialV2/reminders）自检。
//
// 用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，配临时 config
// （consolePort:0，自己的 temp 目录）与**假网关**，然后真的往控制台端口打 HTTP ——
// 全程不碰真实 QQ、不重启桥接进程。
//
// 覆盖：
//   一、端点：add / 列表 / cancel / cancelAll；dueAt 毫秒、ISO 字符串、afterMs、repeat。
//   二、边界与鉴权：非法 key、过去时间、超 90 天、别的会话的 token、无令牌、无授权、工具关闭。
//   三、到点投递：唤醒被限流时**走 sendToQQ 直发兜底**（而不是把提醒丢掉），并标记已触发。
//   四、graceMs：迟到超过补发窗口的提醒**只标记、不发送**（防半夜补发）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}
function skipped(name, why) { skip += 1; console.log(`  ⏭️  ${name}（跳过：${why}）`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';
const OTHER_KEY = 'private:123';
const DAY_MS = 86400000;

/** 起一个「真实 bridge.js + 假网关 + 控制台端口」的夹具，并给出三种通道的 HTTP 帮手。 */
async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        tools: { reminders: true },
        wake: { maxWakePerMinute: 0, maxWakePerHour: 0 },
        ...(overrides.socialV2 ?? {})
      },
      ...(overrides.top ?? {})
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  // agentToken 是按会话（key）各自的，想测「拿别的会话的令牌」必须显式换 token。
  const tokens = {
    [AGENT_KEY]: h.getSocialV2State(AGENT_KEY).agentToken,
    [OTHER_KEY]: h.getSocialV2State(OTHER_KEY).agentToken
  };
  async function raw(method, pathname, { body, agentToken, consoleToken, agentCall, rawBody } = {}) {
    const headers = {};
    // 全局鉴权只认 x-console-token / ?token=（定时安全比较）：**所有**请求都要带；
    // 智能体调用再额外带 x-agent-call + x-agent-token —— 与真实 MCP 服务的发法一致，
    // 否则会先被最外层 401 拦掉，"越权 403" 这一层根本测不到。
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (agentCall) headers['x-agent-call'] = '1';
    if (agentToken !== undefined) headers['x-agent-token'] = agentToken;
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers,
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  return {
    h,
    port,
    tokens,
    op: (body) => raw('POST', '/api/socialV2/reminders', { body, consoleToken: CONSOLE_TOKEN }),
    opGet: (qs) => raw('GET', `/api/socialV2/reminders?${qs}`, { consoleToken: CONSOLE_TOKEN }),
    // 匿名：什么令牌都不带，应当被最外层全局鉴权拦下。
    anon: (body) => raw('POST', '/api/socialV2/reminders', { body }),
    ai: (body, token = tokens[AGENT_KEY]) => raw('POST', '/api/socialV2/reminders', { body, agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    // 注意：token 只放 x-agent-token 头。放进查询串会被外层全局鉴权当成控制台令牌而 401
    // （src/bridge.js 的全局鉴权优先读 `?token=`）——MCP 的 GET 工具也必须这么做。
    aiGet: (key = AGENT_KEY, token = tokens[AGENT_KEY]) => raw('GET', `/api/socialV2/reminders?key=${encodeURIComponent(key)}`, { agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    sentTexts: (key) => h.calls.sent.filter((c) => key.startsWith('group') ? c.kind === 'group' : c.kind === 'private').map((c) => c.text),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

/** 轮询等待 predicate 成立（异步落盘/投递用）。 */
async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(25);
  }
}

console.log('## 一、端点：add / 列表 / cancel / cancelAll');
{
  const f = await startFixture();
  try {
    const dueAt = Date.now() + 10 * 60000;
    const add = await f.op({ key: AGENT_KEY, action: 'add', text: '喝药', dueAt });
    ok(add.status === 200 && add.json.ok === true && add.json.action === 'add', `操作者 add 成功（HTTP ${add.status}）`, JSON.stringify(add.json));
    ok(add.json.item?.text === '喝药' && Math.abs(add.json.item.dueAt - dueAt) < 1500, '返回 item 带正确 text/dueAt', JSON.stringify(add.json.item));
    ok(typeof add.json.item?.dueText === 'string' && typeof add.json.item?.inText === 'string', '列表项带 dueText/inText（本地时间与「还有多久」）');
    const id = add.json.item.id;

    const list = await f.opGet(`key=${encodeURIComponent(AGENT_KEY)}`);
    ok(list.status === 200 && list.json.ok === true && list.json.count === 1, `GET 列出当前会话提醒（count=${list.json.count}）`, JSON.stringify(list.json));
    ok(list.json.key === AGENT_KEY && list.json.items[0]?.id === id, '列表带 key 且是刚加那条');
    ok(typeof list.json.stats?.total === 'number' || typeof list.json.stats?.pending === 'number', '列表带 store.stats()', JSON.stringify(list.json.stats));

    // 默认 action = add
    const noAction = await f.op({ key: AGENT_KEY, text: '默认动作', dueAt: Date.now() + 20 * 60000 });
    ok(noAction.status === 200 && noAction.json.action === 'add', 'action 缺省时按 add 处理');

    // ISO 字符串 / afterMs / repeat
    const iso = await f.op({ key: AGENT_KEY, text: 'ISO 时间', dueAt: new Date(Date.now() + 30 * 60000).toISOString() });
    ok(iso.status === 200 && iso.json.ok === true, `dueAt 支持 ISO 字符串（HTTP ${iso.status}）`, JSON.stringify(iso.json));
    const rel = await f.op({ key: AGENT_KEY, text: '相对时间', afterMs: 40 * 60000, repeat: 'daily' });
    ok(rel.status === 200 && rel.json.item?.repeat === 'daily', 'afterMs + repeat=daily 成功', JSON.stringify(rel.json.item));
    const badRepeat = await f.op({ key: AGENT_KEY, text: '坏 repeat', afterMs: 40 * 60000, repeat: 'hourly' });
    ok(badRepeat.status === 400 && /repeat/.test(badRepeat.json.error ?? ''), `非法 repeat 被拒（HTTP ${badRepeat.status}：${badRepeat.json.error}）`);

    // AI 通道：只能写自己那个 key
    const aiAdd = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], text: 'AI 自己设的', afterMs: 50 * 60000 });
    ok(aiAdd.status === 200 && aiAdd.json.ok === true, `AI 通道 add 自己的会话成功（HTTP ${aiAdd.status}）`, JSON.stringify(aiAdd.json));
    const aiList = await f.aiGet();
    ok(aiList.status === 200 && aiList.json.count >= 4, `AI 通道 GET 能列出（count=${aiList.json.count}）`, JSON.stringify(aiList.json));

    // cancel / cancelAll
    const cancel = await f.op({ key: AGENT_KEY, action: 'cancel', id });
    ok(cancel.status === 200 && cancel.json.action === 'cancel' && cancel.json.cancelled === 1, 'cancel 按 id 取消 1 条', JSON.stringify(cancel.json));
    const cancelAgain = await f.op({ key: AGENT_KEY, action: 'cancel', id });
    ok(cancelAgain.status === 200 && cancelAgain.json.cancelled === 0, '重复 cancel 同一 id 返回 0（不报错）');
    const noId = await f.op({ key: AGENT_KEY, action: 'cancel' });
    ok(noId.status === 400 && /需要 id/.test(noId.json.error ?? ''), 'cancel 缺 id → 400');
    const cancelAll = await f.op({ key: AGENT_KEY, action: 'cancelAll' });
    ok(cancelAll.status === 200 && cancelAll.json.cancelled >= 4, `cancelAll 清空（cancelled=${cancelAll.json.cancelled}）`);
    const empty = await f.opGet(`key=${encodeURIComponent(AGENT_KEY)}`);
    ok(empty.json.count === 0, 'cancelAll 之后列表为空');
    const badAction = await f.op({ key: AGENT_KEY, action: 'nuke' });
    ok(badAction.status === 400 && /action 只能/.test(badAction.json.error ?? ''), '非法 action → 400');
  } finally {
    await f.stop();
  }
}

console.log('\n## 二、边界与鉴权');
{
  const f = await startFixture();
  try {
    const badKey = await f.op({ key: 'nope', text: 'x', afterMs: 60000 });
    ok(badKey.status === 400 && /group:群号/.test(badKey.json.error ?? ''), `非法 key → 400（${badKey.json.error}）`);
    const past = await f.op({ key: AGENT_KEY, text: '过去的时间', dueAt: Date.now() - 60000 });
    ok(past.status === 400 && /太近/.test(past.json.error ?? ''), `过去的时间被拒（${past.json.error}）`);
    const far = await f.op({ key: AGENT_KEY, text: '太远', afterMs: 91 * DAY_MS });
    ok(far.status === 400 && /太远/.test(far.json.error ?? ''), `超过 90 天被拒（${far.json.error}）`);
    const noTime = await f.op({ key: AGENT_KEY, text: '没有时间' });
    ok(noTime.status === 400 && /缺少提醒时间/.test(noTime.json.error ?? ''), `缺少时间参数 → 400（${noTime.json.error}）`);
    const tooSoon = await f.op({ key: AGENT_KEY, text: '太近', afterMs: 10 });
    ok(tooSoon.status === 400 && /太近/.test(tooSoon.json.error ?? ''), 'afterMs < 1000 → 400');
    const emptyText = await f.op({ key: AGENT_KEY, text: '   ', afterMs: 60000 });
    ok(emptyText.status === 400 && /text 不能为空/.test(emptyText.json.error ?? ''), '空 text → 400');

    // 鉴权：AI 只能操作自己那个 key
    const crossKey = await f.ai({ key: OTHER_KEY, token: f.tokens[AGENT_KEY], text: '越权', afterMs: 60000 }, f.tokens[AGENT_KEY]);
    ok(crossKey.status === 403 && /agent token 无效/.test(crossKey.json.error ?? ''), `AI 用别的会话 key → 403（HTTP ${crossKey.status}：${crossKey.json.error}）`);
    const noToken = await f.ai({ key: AGENT_KEY, text: '没令牌', afterMs: 60000 }, '');
    ok(noToken.status === 403, `AI 通道不带令牌 → 403（HTTP ${noToken.status}：${noToken.json.error}）`);
    const noAuth = await f.anon({ key: AGENT_KEY, text: '没授权', afterMs: 60000 });
    ok(noAuth.status === 401 || noAuth.status === 403, `什么都没带 → 未授权（HTTP ${noAuth.status}：${noAuth.json.error}）`);
    const crossRead = await f.aiGet(OTHER_KEY, f.tokens[AGENT_KEY]);
    ok(crossRead.status === 403 && /agent token 无效/.test(crossRead.json.error ?? ''), `AI 读别的会话 → 403（HTTP ${crossRead.status}：${crossRead.json.error}）`);
    // 操作者可以查任意 key
    const opOther = await f.opGet(`key=${encodeURIComponent(OTHER_KEY)}`);
    ok(opOther.status === 200 && opOther.json.key === OTHER_KEY, '操作者可以查任意 key');
  } finally {
    await f.stop();
  }

  const f2 = await startFixture({ socialV2: { tools: { reminders: false } } });
  try {
    const off = await f2.ai({ key: AGENT_KEY, text: '工具关了', afterMs: 60000 });
    ok(off.status === 403 && /工具未启用/.test(off.json.error ?? ''), `开关 reminders=false → AI 通道 403（${off.json.error}）`);
    const opStill = await f2.op({ key: AGENT_KEY, text: '操作者仍可用', afterMs: 60000 });
    ok(opStill.status === 200, '开关只管 AI 工具，操作者通道仍可用');
  } finally {
    await f2.stop();
  }
}

console.log('\n## 三、到点投递：唤醒被限流时直发兜底（提醒不能丢）');
{
  // maxWakePerMinute=1 + 预置一次刚刚的唤醒 → 本次唤醒必然命中频率限制（skipReason='ratelimit'），
  // 而 ratelimit 是「自限性」跳过 → 允许退化为 sendToQQ('⏰ 提醒：…')。
  const f = await startFixture({ socialV2: { wake: { maxWakePerMinute: 1, maxWakePerHour: 10 } } });
  try {
    const add = await f.op({ key: AGENT_KEY, text: '到点喝水', afterMs: 1000 });
    ok(add.status === 200, '加一条 1 秒后到点的提醒', JSON.stringify(add.json));
    const id = add.json.item.id;
    const st = f.h.getSocialV2State(AGENT_KEY);
    st.wakeTimes.push(Date.now()); // 先占掉这一分钟的唯一唤醒额度
    ok(f.h.calls.sent.length === 0, '投递前没有任何真实发送记录');

    await sleep(1100);
    f.h.checkDueRemindersV2();
    const sent = await waitFor(() => f.h.calls.sent.length > 0 ? f.h.calls.sent : null, 3000);
    ok(!!sent, '唤醒被限流后仍然发出了提醒（走 sendToQQ 兜底）');
    ok(sent?.[0]?.kind === 'group' && sent?.[0]?.id === 456, `兜底发往正确会话（${JSON.stringify(sent?.[0])}）`);
    ok(/^⏰ 提醒：到点喝水$/.test(String(sent?.[0]?.text ?? '')), `兜底文本是「⏰ 提醒：<内容>」（${sent?.[0]?.text}）`);
    ok(f.h.wakeSkipReasonV2.get(AGENT_KEY) === 'ratelimit', `跳过原因是 ratelimit（${f.h.wakeSkipReasonV2.get(AGENT_KEY)}）`);
    ok(!f.h.calls.prompts.some((p) => String(p?.prompt ?? '').includes('到点喝水')), '没有走唤醒通道（被限流，不该投递提示词）');

    // 兜底发送成功 ≠ 已标触发：sendToQQ 走的是全局 sendChain（末尾还有 sleep(cfg.sendDelayMs)），
    // markFired 发生在这条链 resolve 之后，所以要等 done 出现，不能只看 calls.sent。
    const item = await waitFor(() => {
      const hit = f.h.remindersStore().list({ key: AGENT_KEY, includeDone: true }).find((x) => x.id === id);
      return hit?.done ? hit : null;
    }, 3000);
    ok(item?.done === true, '兜底成功后才 markFired（done=true）', JSON.stringify(item));
    const after = await f.opGet(`key=${encodeURIComponent(AGENT_KEY)}&includeDone=1`);
    ok(after.json.count === 1, '已触发的提醒仍能在 includeDone=1 列表里查到（可审计）');
    ok(after.json.items[0]?.firedAt > 0, 'firedAt 已写入');
  } finally {
    await f.stop();
  }
}

console.log('\n## 三之二、兜底发送**失败**时必须不 markFired（否则提醒永久丢失）');
{
  // 这一节钉的是一个真实竞态：兜底判定若读 `lastSendFailed` 那个「按 key 的共享槽」，
  // 同一会话上并发的另一次发送就会串味 —— 对方批次成功会把我们的失败读成成功
  // （markFired → 提醒永久丢失），反之会重发（重复提醒）。
  // 所以这里让「本批次真失败 + 同一 key 上另有一次成功发送」同时发生，断言提醒**没被标记**。
  const f = await startFixture({ socialV2: { wake: { maxWakePerMinute: 1, maxWakePerHour: 10 } } });
  const realSendGroup = f.h.bot.sendGroupMessage;
  try {
    const add = await f.op({ key: AGENT_KEY, text: '该吃药了', afterMs: 1000 });
    ok(add.status === 200, '加一条 1 秒后到点的提醒（失败路径）', JSON.stringify(add.json));
    const id = add.json.item.id;
    f.h.getSocialV2State(AGENT_KEY).wakeTimes.push(Date.now()); // 占掉唤醒额度 → 必然走直发兜底

    // 定向失败：只让**群发送**抛错（兜底发的是群），私聊照常成功 —— 模拟"就我这一批没出去"。
    f.h.bot.sendGroupMessage = async () => { throw new Error('fixture: group send down'); };

    await sleep(1100);
    f.h.checkDueRemindersV2();

    // 并发的另一次发送：同一 key、走 sendToQQ（会写共享槽并把它清掉）。
    // 旧实现下这次"成功"会把我们的失败抹掉 —— 这正是要钉住的竞态。
    await f.h.sendToQQ(AGENT_KEY, '同会话的另一次发送');

    const hit = f.h.remindersStore().list({ key: AGENT_KEY, includeDone: true }).find((x) => x.id === id);
    ok(hit && hit.done !== true, '兜底发送失败后**没有** markFired（提醒还在，等下一个 tick 重试）', JSON.stringify(hit));
    ok(!f.h.calls.sent.some((c) => String(c.text ?? '').includes('该吃药了')), '失败的那一批确实没进假网关（不是"发出去了只是没记账"）');

    // 先等"没发出去"这件事落定：失败的分支也排在 sendChain 上（末尾还有 sendDelayMs 的 sleep），
    // 这一批彻底结束前不要以为提醒空闲 —— 否则下一轮会和它并行。
    await sleep(1500);

    // 恢复后重试：下一个 tick 应该真的发出去并标记（证明"留着"不是死循环）。
    f.h.bot.sendGroupMessage = realSendGroup;
    const sentAfterRetry = () => f.h.calls.sent.some((c) => String(c.text ?? '').includes('该吃药了'));
    for (let i = 0; i < 10 && !sentAfterRetry(); i++) {
      f.h.checkDueRemindersV2();
      await sleep(800);
    }
    ok(sentAfterRetry(), '恢复后下一个 tick 重试成功发出（提醒没丢）');
    const fired = await waitFor(() => {
      const it = f.h.remindersStore().list({ key: AGENT_KEY, includeDone: true }).find((x) => x.id === id);
      return it?.done ? it : null;
    }, 3000);
    ok(fired?.done === true, '重试成功后才 markFired');
  } finally {
    f.h.bot.sendGroupMessage = realSendGroup;
    await f.stop();
  }
}

console.log('\n## 四、graceMs：迟到超过补发窗口只标记、不发送');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reminder-grace-'));
  const file = path.join(dir, 'reminders.json');
  const stale = Date.now() - 2 * 3600000; // 2 小时前就该提醒了
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    items: [{ id: 'stale-1', key: AGENT_KEY, text: '半夜的药', dueAt: stale, repeat: 'none', createdBy: 'operator', createdAt: stale - 60000 }]
  }, null, 2));
  const f = await startFixture({ socialV2: { reminders: { graceMs: 600000, file } } });
  try {
    const gate = await f.opGet(`key=${encodeURIComponent(AGENT_KEY)}&includeDone=1`);
    ok(gate.json.items?.length === 1 && gate.json.items[0].id === 'stale-1', '夹具确实从指定文件读到了那条过期提醒', JSON.stringify(gate.json));
    f.h.checkDueRemindersV2();
    const fired = await waitFor(() => {
      const hit = f.h.remindersStore().list({ key: AGENT_KEY, includeDone: true }).find((x) => x.id === 'stale-1');
      return hit?.done ? hit : null;
    }, 2000);
    ok(!!fired, '超过 graceMs 的提醒被直接标记已触发');
    ok(f.h.calls.sent.length === 0, '超窗提醒没有补发任何消息（防半夜补发）');
    ok(!f.h.calls.prompts.some((p) => String(p?.prompt ?? '').includes('半夜的药')), '也没有走唤醒通道');
  } finally {
    await f.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n== 到点提醒自检：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''} ==`);
if (fail > 0) process.exitCode = 1;
