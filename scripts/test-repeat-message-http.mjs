// 「群聊 +1」= `qq_repeat_message` / `POST /api/socialV2/repeat-message` 自检。
//
// 为什么它必须是**独立端点**而不是让模型自己抄原文：让模型手打一定会变形
// （"中秋快乐" → "中秋快乐呀"），那就不叫 +1 了。桥接取**原文**再原样发出去，
// 所以这里要钉住三件事：
//   ① 发出去的字与原文**完全一致**，且不带引用、不带 @（真 +1 就是光秃秃复读）；
//   ② 它只能复读**本会话里已经存在**的别人的话（私聊不行、自己的话不行、图片/语音不行）；
//   ③ 频率有两道闸（专属 repeatTimes + 共用 sendTimes），且**失败要回滚预占的额度**。
//
// 两层都不碰真实 QQ、不重启桥接：
//   一、端到端：用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，
//       配临时 config 与**假网关**，往控制台端口真打 HTTP；假网关把每次出站调用记进
//       h.calls.http ⇒「发了几条、发的是什么」都可断言。
//   二、静态接线：新工具要在 6 个地方同时登记，漏一个就是"控制台关了、模型仍收到 schema"
//       或者"控制台勾了、调用仍 403"（这两类坑都踩过），所以这里逐个 source 断言。
//
// ⚠️ 鉴权：最外层全局鉴权只认 `x-console-token` 或 `?token=`，**每个**用例都要带控制台令牌；
//    智能体调用再额外带 `x-agent-call: 1` + `x-agent-token`。少了控制台令牌会先吃 401，
//    把要断言的业务 403 全掩盖掉。
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
let pending = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}
function notePending(name) {
  pending += 1;
  console.log(`  ⏳ ${name}（待接线：端点返回 404，接线后本断言转为真断言）`);
}
/** 只有整段路由缺失（404 + not found 文案）才算待接线，业务 404 不算。 */
function endpointMissing(r) {
  return r.status === 404 && /not found/i.test(String(r.json?.error ?? ''));
}

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';
const OTHER_KEY = 'private:123';
const AGENT_PATH = '/api/socialV2/repeat-message';

async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        tools: { repeatMessage: true },
        ...(overrides.socialV2 ?? {})
      },
      ...(overrides.top ?? {})
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const tokens = {
    [AGENT_KEY]: h.getSocialV2State(AGENT_KEY).agentToken,
    [OTHER_KEY]: h.getSocialV2State(OTHER_KEY).agentToken
  };
  async function raw(method, pathname, { body, agentToken, consoleToken, agentCall } = {}) {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (agentCall) headers['x-agent-call'] = '1';
    if (agentToken !== undefined) headers['x-agent-token'] = agentToken;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  /** 往会话的 recentMessages 里塞一条"别人说的话"，返回它的本地 seq。 */
  function seed(key, text, { messageId = '5001', sender = '群友甲', userId = '8888', media = [], isSelf = false } = {}) {
    h.appendSocialV2Message(key, sender, text, text, false, false, messageId, media, userId);
    const st = h.getSocialV2State(key);
    const msg = st.recentMessages[st.recentMessages.length - 1];
    if (isSelf) msg.isSelf = true;
    return msg.seq;
  }
  return {
    h,
    port,
    tokens,
    seed,
    // AI 通道：控制台令牌 + agent 声明 + 会话令牌（与真实 MCP 进程的发法一致）。
    ai: (body, token = tokens[AGENT_KEY]) => raw('POST', AGENT_PATH, { body, agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    // 只带控制台令牌、不带会话令牌（模拟 MCP 漏传 token）。
    aiNoToken: (body) => raw('POST', AGENT_PATH, { body, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    // 管理端通道：只有控制台令牌，既不声明 agent 调用、也不带会话令牌
    // ⇒ 唯一能走到端点自己那层「必须携带 agent token」闸门的路径（证明它不是死代码）。
    consoleOnly: (body) => raw('POST', AGENT_PATH, { body, consoleToken: CONSOLE_TOKEN }),
    anon: (body) => raw('POST', AGENT_PATH, { body }),
    state: (key = AGENT_KEY) => h.getSocialV2State(key),
    sentCount: () => h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url)).length,
    lastMessage: () => {
      const calls = h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url));
      return calls[calls.length - 1] ?? null;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

async function withFixture(overrides, fn) {
  const f = await startFixture(overrides);
  try { return await fn(f); } finally { await f.stop(); }
}

console.log('## 一、端到端（真实 bridge.js + 假网关）');

// ── 正常路径：原文一字不差、不带引用/不 @ ────────────────────────────────────
await withFixture({}, async (f) => {
  console.log('### 正常路径');
  const seq = f.seed(AGENT_KEY, '中秋快乐');
  const before = f.sentCount();
  const r = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  if (endpointMissing(r)) {
    notePending('+1 复读成功并原样发出');
    return;
  }
  ok(r.status === 200 && r.json.ok === true, `返回 200/ok（HTTP ${r.status}）`, JSON.stringify(r.json).slice(0, 240));
  ok(r.json.repeated === '中秋快乐', `回报 repeated 是原文（${JSON.stringify(r.json.repeated)}）`);
  ok(r.json.fromSender === '群友甲', `回报 fromSender（${r.json.fromSender}）`);
  ok(r.json.sent === 1, `回报 sent=1（${r.json.sent}）`);
  ok(f.sentCount() === before + 1, '确实往网关发出了一条消息');
  const last = f.lastMessage();
  ok(last?.body?.group_id === 456, '发往正确的群（group_id=456）', JSON.stringify(last?.body));
  const segs = last?.body?.message ?? [];
  const textSeg = segs.find((s) => s.type === 'text');
  ok(textSeg?.data?.text === '中秋快乐', `交给网关的文字与原文完全一致（${JSON.stringify(textSeg?.data?.text)}）`);
  ok(!segs.some((s) => s.type === 'reply' || s.type === 'at'), '+1 不带引用、不带 @（真 +1 就是光秃秃复读一句）', JSON.stringify(segs));
  ok(segs.length === 1, `只发一条（段数 ${segs.length}）`);

  // 本地 seq 命中但桥接没记到真实 messageId：兜底路径也要能复读（+1 不需要引用 id）。
  const seqNoId = f.seed(AGENT_KEY, '新年快乐', { messageId: null });
  const r2 = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seqNoId });
  ok(r2.status === 200 && r2.json.repeated === '新年快乐', `没有 messageId 的本地消息也能复读（HTTP ${r2.status}：${r2.json.error ?? r2.json.repeated}）`);

  // 不存在的 ref：必须优雅 400，而不是 500（假网关也没有 getMessage）。
  const ghost = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: '999999' });
  ok(ghost.status === 400 && /找不到这条消息/.test(String(ghost.json.error ?? '')), `取不到的消息 ⇒ 400（HTTP ${ghost.status}：${ghost.json.error}）`);
});

// ── 不能 +1 的东西：私聊 / 图片 / 自己的话 / 敏感内容 / 超长 ────────────────
await withFixture({}, async (f) => {
  console.log('### 不能 +1 的东西');
  const before = f.sentCount();

  const priv = await f.ai({ key: OTHER_KEY, token: f.tokens[OTHER_KEY], messageId: 1 }, f.tokens[OTHER_KEY]);
  if (endpointMissing(priv)) notePending('私聊 +1 被拒');
  else ok(priv.status === 400 && /只在群聊/.test(String(priv.json.error ?? '')), `私聊 ⇒ 400（HTTP ${priv.status}：${priv.json.error}）`);

  const imgSeq = f.seed(AGENT_KEY, '', { media: [{ kind: 'image', url: 'https://public.invalid/a.png' }] });
  const img = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: imgSeq });
  ok(img.status === 400 && /没有可以复读的文字/.test(String(img.json.error ?? '')), `图片/表情消息 ⇒ 400（HTTP ${img.status}：${img.json.error}）`);

  const selfSeq = f.seed(AGENT_KEY, '我刚才说的话', { isSelf: true });
  const selfR = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: selfSeq });
  ok(selfR.status === 400 && /不能复读自己/.test(String(selfR.json.error ?? '')), `复读自己 ⇒ 400（HTTP ${selfR.status}：${selfR.json.error}）`);

  const secSeq = f.seed(AGENT_KEY, 'token=abcdef123456');
  const sec = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: secSeq });
  ok(sec.status === 403 && /敏感信息/.test(String(sec.json.error ?? '')), `敏感内容 ⇒ 403 不复制（HTTP ${sec.status}：${sec.json.error}）`);

  const badRef = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: 'abc' });
  ok(badRef.status === 400 && /非零整数/.test(String(badRef.json.error ?? '')), `ref 不是整数 ⇒ 400（HTTP ${badRef.status}：${badRef.json.error}）`);

  ok(f.sentCount() === before, '以上失败路径一个字都没发出去');
});

// ── 凭据 / 开关 / key ────────────────────────────────────────────────────────
await withFixture({}, async (f) => {
  console.log('### 凭据与开关');
  const anon = await f.anon({ key: AGENT_KEY, messageId: 1 });
  ok(anon.status === 401, `没有控制台令牌 ⇒ 401（HTTP ${anon.status}）`, JSON.stringify(anon.json));

  // 注意：`x-agent-call: 1` 会被**全局**智能体关卡（src/bridge.js:5037-5042）先拦下，
  // 令牌缺失/不认识的错误消息是通用那句，还没轮到端点自己那层校验。
  const noAgent = await f.aiNoToken({ key: AGENT_KEY, messageId: 1 });
  ok(noAgent.status === 403 && /智能体调用必须携带有效的会话令牌/.test(String(noAgent.json.error ?? '')), `声明 agent 调用但没带令牌 ⇒ 全局关卡 403（HTTP ${noAgent.status}：${noAgent.json.error}）`);

  // 管理端通道（不带 x-agent-call）才走到端点自己的令牌闸门 —— 这一层不能是死代码。
  const consoleOnly = await f.consoleOnly({ key: AGENT_KEY, messageId: 1 });
  ok(consoleOnly.status === 403 && /\+1 必须携带 agent token/.test(String(consoleOnly.json.error ?? '')), `端点自己的令牌闸门仍在（HTTP ${consoleOnly.status}：${consoleOnly.json.error}）`);

  const wrongAgent = await f.ai({ key: AGENT_KEY, messageId: 1 }, 'deadbeefdeadbeefdeadbeefdeadbeef');
  ok(wrongAgent.status === 403 && /智能体调用必须携带有效的会话令牌|agent token 无效/.test(String(wrongAgent.json.error ?? '')), `令牌不认识 ⇒ 403（HTTP ${wrongAgent.status}：${wrongAgent.json.error}）`);

  const cross = await f.ai({ key: AGENT_KEY, messageId: 1 }, f.tokens[OTHER_KEY]);
  ok(cross.status === 403 && /agent token 无效/.test(String(cross.json.error ?? '')), `拿 A 会话令牌操作 B 会话 ⇒ 403（HTTP ${cross.status}：${cross.json.error}）`);

  const noKey = await f.ai({ messageId: 1 });
  ok(noKey.status === 400 && /key 不能为空/.test(String(noKey.json.error ?? '')), `缺 key ⇒ 400（HTTP ${noKey.status}：${noKey.json.error}）`);
});

await withFixture({ socialV2: { tools: { repeatMessage: false } } }, async (f) => {
  console.log('### 开关关闭：socialV2.tools.repeatMessage=false');
  const seq = f.seed(AGENT_KEY, '中秋快乐');
  const r = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  ok(r.status === 403 && /工具未启用：qq_repeat_message/.test(String(r.json.error ?? '')), `tools.repeatMessage=false ⇒ AI 403（HTTP ${r.status}：${r.json.error}）`);
  ok(f.sentCount() === 0, '开关关掉后没有发出任何消息');
});

// ── 频率：专属闸门 + 共用闸门 + 失败回滚 ────────────────────────────────────
await withFixture({ socialV2: { repeat: { maxPerHour: 2 } } }, async (f) => {
  console.log('### 频率上限 socialV2.repeat.maxPerHour=2');
  const seq = f.seed(AGENT_KEY, '中秋快乐');
  // 先来两次失败：它们**不该**吃掉配额（预占额度必须回滚）。
  await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: 'abc' });
  await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: '999999' });
  const first = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  const second = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  ok(first.status === 200 && second.status === 200, `失败不占配额：两次成功（${first.status}/${second.status}）`, JSON.stringify([first.json, second.json]).slice(0, 240));
  const third = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  ok(third.status === 429 && /1 小时最多 2 次/.test(String(third.json.error ?? '')), `第三次 ⇒ 429（HTTP ${third.status}：${third.json.error}）`);
  ok(f.sentCount() === 2, `只发出 2 条（实际 ${f.sentCount()}）`);
  ok(f.state().repeatTimes.length === 2, `repeatTimes 恰好 2 条（实际 ${f.state().repeatTimes.length}）——失败的两次没有留下幽灵额度`);
});

await withFixture({ socialV2: { repeat: { maxPerHour: 0 }, send: { maxSendPerMinute: 1, maxSendPerHour: 0 } } }, async (f) => {
  console.log('### maxPerHour=0（不单独限）但仍共用 sendTimes 限频');
  const seq = f.seed(AGENT_KEY, '中秋快乐');
  const a = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  const b = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  const c = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  ok(a.status === 200 && b.status === 429 && c.status === 429, `maxSendPerMinute=1 时第二次起 429（${a.status}/${b.status}/${c.status}）`, JSON.stringify([b.json, c.json]).slice(0, 240));
  ok(/发送频率超限/.test(String(b.json.error ?? '')), `错误信息是发送频率超限（${b.json.error}）`);
});

// ── 超长：maxMessageChars 是复读的长度上限 ──────────────────────────────────
await withFixture({ socialV2: { send: { maxMessageChars: 10, maxSendPerMinute: 0, maxSendPerHour: 0 } } }, async (f) => {
  console.log('### 超长消息');
  const seq = f.seed(AGENT_KEY, '一二三四五六七八九十十一十二');
  const r = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], messageId: seq });
  ok(r.status === 400 && /太长/.test(String(r.json.error ?? '')), `超过 maxMessageChars ⇒ 400（HTTP ${r.status}：${r.json.error}）`);
  ok(f.sentCount() === 0, '超长没有发出去');
});

console.log('\n## 二、静态接线（新工具要在 6 个地方同时登记，漏一个就是坑）');
{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const bridge = read('../src/bridge.js');
  const mcp = read('../src/mcp-snowluma-safe.js');
  const consoleHtml = read('../public/console.html');
  const example = JSON.parse(read('../config.example.json'));

  ok(/^const SOCIAL_V2_TOOL_DEFAULTS = Object\.freeze\(\{[\s\S]*?repeatMessage: true,/m.test(bridge), 'bridge.js 出厂默认表里有 repeatMessage: true');
  ok(/const toolFlags = \[[^\]]*'repeatMessage'[^\]]*\]/.test(bridge), 'bridge.js 配置 API 的 toolFlags 白名单里有 repeatMessage（漏了会被控制台保存吃掉）');
  ok(/repeatMessage: 'qq_repeat_message'/.test(bridge), 'bridge.js 的 toolMap（enabledTools 用）里有 qq_repeat_message');
  ok(/qq_repeat_message: 'repeatMessage',/.test(mcp), 'mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS 登记了 qq_repeat_message（否则关掉开关模型仍会收到 schema）');
  ok(/server\.tool\(\s*'qq_repeat_message'/.test(mcp), 'MCP 侧真的注册了 qq_repeat_message 工具');
  ok(/data-v2-tool="repeatMessage"/.test(consoleHtml), '控制台有 repeatMessage 勾选框');
  ok(example.socialV2?.tools?.repeatMessage === true, 'config.example.json 的 socialV2.tools.repeatMessage 是 true');
  ok(example.socialV2?.repeat?.maxPerHour === 12, 'config.example.json 有 socialV2.repeat.maxPerHour=12');
  ok(/agentApi\('\/api\/socialV2\/repeat-message'/.test(mcp), 'MCP 工具打的是 POST /api/socialV2/repeat-message');
  // 文档里也要有它，否则下一个人不知道这个能力的边界（+1 只允许群聊、不改一字）。
  const caps = read('../docs/guides/NEW_CAPABILITIES.md');
  ok(caps.includes('qq_repeat_message'), 'docs/guides/NEW_CAPABILITIES.md 记录了 qq_repeat_message');
}

console.log(`\n结果：${pass} 通过，${fail} 失败${pending ? `，${pending} 待接线` : ''}`);
if (fail > 0) process.exitCode = 1;
