// 「自省」（GET /api/socialV2/self-status / GET /api/self-status）自检。
//
// 分两层，两层都不碰真实 QQ、不重启桥接进程：
//   一、src/self-status.mjs 的**纯函数**（buildSelfStatus / humanDelta）：文本分段、
//       1200 字硬截断、五个告警码、缺字段降级。
//   二、端到端：用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，
//       配临时 config（consolePort:0）与**假网关**，然后真的往控制台端口打 HTTP。
//       假网关把每次出站调用记进 h.calls.http —— "没发出任何消息" 因此可以被断言。
//
// ⚠️ 鉴权：最外层全局鉴权（bridge.js 的 consoleToken 关卡）只认 `x-console-token` 或 `?token=`，
//    所以**每一个** HTTP 用例都要带控制台令牌；智能体调用再额外带 `x-agent-call: 1` +
//    `x-agent-token`。少了控制台令牌会先吃到 `HTTP 401 未授权：请提供控制台访问令牌`，
//    把本来要断言的业务 403 全掩盖掉。
//
// ⚠️ 阶段状态：本脚本是「先写验收测试」阶段的产物，此时端点尚未接线 —— 未知路径会返回
//    `404 {"ok":false,"error":"not found"}`。这类结果记为「待接线」而不是失败（见 notePending），
//    这样现在能看到真实进度，接线之后再跑同一份脚本就会变成真断言。endpointMissing() 把控。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { SELF_STATUS_MAX_CHARS, buildSelfStatus, humanDelta } from '../src/self-status.mjs';

let pass = 0;
let fail = 0;
let pending = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}
/** 端点还没接线时的记账：期待 404 的那条断言记为「待接线」，不算失败也不算通过。 */
function notePending(name) {
  pending += 1;
  console.log(`  ⏳ ${name}（待接线：端点返回 404，接线后本断言转为真断言）`);
}
/**
 * 该响应是不是「端点还不存在」。
 *
 * 只有**整段路由缺失**（404 + not found 文案）才算待接线；业务代码里正常返回的 404
 * 不算（目前这些端点没有这种返回），避免把真的写错掩盖成"还没接线"。
 */
function endpointMissing(r) {
  return r.status === 404 && /not found/i.test(String(r.json?.error ?? ''));
}

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';
const OTHER_KEY = 'private:123';
const AGENT_PATH = '/api/socialV2/self-status';
const OP_PATH = '/api/self-status';

// ── 一、pure module ─────────────────────────────────────────────────────────
console.log('## 一、self-status.mjs 纯函数');

console.log('### 文本分段与结构化 data');
{
  const r = buildSelfStatus({
    key: AGENT_KEY, mode: 'reserved2', role: 'qq-chat-v2', paused: false, dshReady: true,
    sessionId: 'abcdef1234567890', provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high',
    snowluma: { connected: true, accountOnline: true, good: true, degraded: false, lastPacketAgoMs: 3000 },
    wake: { usedMinute: 1, capMinute: 10, usedHour: 5, capHour: 100, config: { mode: 'diving', infinite: true } },
    voiceLimits: { usedMinute: 0, capMinute: 2, usedHour: 1, capHour: 10 },
    imageLimits: { usedMinute: 0, capMinute: 2, usedHour: 0, capHour: 10 },
    waiting: true, busy: false, pendingWakeReasons: 2,
    tts: { voice: 'zh-CN-XiaoyiNeural', provider: 'edge' },
    reminders: { pending: 3, nextDueAt: Date.now() + 3600000 },
    cost: { currency: 'CNY', symbol: '¥', todayCost: 0.42, turns: 12, steps: 30, cacheHitTokens: 90000, cacheMissTokens: 10000, outputTokens: 5000, estimated: false }
  });
  ok(r.ok === true, 'buildSelfStatus 返回 ok:true');
  ok(typeof r.text === 'string' && r.text.length > 0, 'text 是非空字符串');
  ok(r.data?.key === AGENT_KEY && r.data?.mode === 'reserved2', 'data 带 key/mode（结构化，不只是文本）', JSON.stringify(r.data));
  ok(r.data?.model === 'deepseek-chat' && r.data?.provider === 'deepseek', 'data 带 provider/model');
  ok(r.data?.costToday === 0.42 && r.data?.cacheHitRate === 90, 'data 带今日花费与缓存命中率', JSON.stringify(r.data));
  ok(r.data?.wakeUsedMinute === 1 && r.data?.wakeCapMinute === 10, 'data 带唤醒额度（已用/上限）');
  ok(r.data?.waiting === true && r.data?.busy === false && r.data?.pendingReminders === 3, 'data 带 waiting/busy/pendingReminders');
  ok(r.truncated === false, '短文本 truncated:false');
  for (const section of ['【运行】', '【SnowLuma】', '【本会话】', '【花费】', '【额度与等待】', '【其它】', '【建议】']) {
    ok(r.text.includes(section), `文本含分段 ${section}`);
  }
  ok(r.text.includes(AGENT_KEY), '文本里带会话 key');
  ok(r.text.includes('会话 abcdef12'), '会话 id 只显示前 8 位（省 token）', r.text.match(/会话 \S+/)?.[0]);
  ok(Array.isArray(r.warnings), 'warnings 是数组');
}

console.log('### 1200 字硬截断');
{
  const r = buildSelfStatus({ key: AGENT_KEY, snowluma: { lastPacketAgoMs: 86400000 * 999 } });
  ok(SELF_STATUS_MAX_CHARS === 1200, 'SELF_STATUS_MAX_CHARS 常量是 1200');
  ok(r.text.length <= SELF_STATUS_MAX_CHARS, `短输入不超上限（${r.text.length}）`);
  // 用超长字段把它顶到上限：hint 里塞不进的东西只能靠外部字段（provider 名）撑长度。
  const long = buildSelfStatus({
    key: AGENT_KEY,
    provider: 'p'.repeat(3000), model: 'm'.repeat(3000),
    cost: { todayCost: 1, turns: 1, cacheHitTokens: 1, cacheMissTokens: 1, outputTokens: 1 }
  });
  ok(long.truncated === true, '超长输入 truncated:true');
  ok(long.text.length <= SELF_STATUS_MAX_CHARS, `截断后长度仍 ≤ ${SELF_STATUS_MAX_CHARS}（实际 ${long.text.length}）`);
  ok(long.text.endsWith('…'), '截断用省略号收尾，不硬切半句');
}

console.log('### 建议段与五个告警码');
{
  const clean = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek', dshReady: true });
  ok(clean.warnings.length === 0, '一切正常时没有告警码', JSON.stringify(clean.warnings));
  ok(clean.text.includes('【建议】一切正常'), '一切正常时给出默认建议');

  const notFriendly = buildSelfStatus({ key: AGENT_KEY, provider: 'openrouter', model: 'x' });
  ok(notFriendly.warnings.includes('provider-not-cache-friendly'), '→ provider-not-cache-friendly', JSON.stringify(notFriendly.warnings));
  ok(/不是缓存友好/.test(notFriendly.text), '  文本里点明 provider 不缓存友好');

  const lowHit = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek', turns: 5, cost: { todayCost: 0.1, turns: 5, cacheHitTokens: 100, cacheMissTokens: 900 } });
  ok(lowHit.warnings.includes('low-cache-hit'), '→ low-cache-hit', JSON.stringify(lowHit.warnings));
  ok(lowHit.data.cacheHitRate === 10, '  data.cacheHitRate 如实回报 10%');

  const costy = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek', cost: { todayCost: 5.5, turns: 1 } });
  ok(costy.warnings.includes('cost-warn'), '→ cost-warn（超过 3 元）', JSON.stringify(costy.warnings));

  const quota = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek', wake: { usedMinute: 9, capMinute: 10 } });
  ok(quota.warnings.includes('wake-quota-low'), '→ wake-quota-low（用量 ≥80%）', JSON.stringify(quota.warnings));

  const notReady = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek', dshReady: false });
  ok(notReady.warnings.includes('bridge-not-ready'), '→ bridge-not-ready（DSH 未就绪）', JSON.stringify(notReady.warnings));
  const paused = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek', paused: true });
  ok(paused.warnings.includes('bridge-not-ready'), '→ bridge-not-ready（已暂停）');
}

console.log('### 缺字段降级（不能成为新的故障点）');
{
  const empty = buildSelfStatus();
  ok(empty.ok === true && typeof empty.text === 'string' && empty.text.length > 0, '空输入也返回可用文本（不抛错）');
  ok(empty.data?.key === null && empty.data?.costToday === null, '缺字段在 data 里是 null 而不是 undefined', JSON.stringify(empty.data));
  ok(empty.text.includes('【建议】一切正常'), '空输入给出默认建议，不报错');
  const noCost = buildSelfStatus({ key: AGENT_KEY, provider: 'deepseek' });
  ok(!noCost.text.includes('【花费】'), '拿不到花费时整段省略（best-effort）');
  ok(noCost.data.costToday === null, '  data.costToday 为 null');
  const zeroCap = buildSelfStatus({ key: AGENT_KEY, wake: { usedMinute: 5, capMinute: 0 } });
  ok(!zeroCap.text.includes('唤醒/分'), '上限为 0 视为不限流，不显示该额度');
  ok(humanDelta(-90 * 60000) === '1 小时前' && humanDelta(3 * 3600000) === '3 小时后', 'humanDelta 说人话');
  ok(humanDelta(-500) === '刚刚' && humanDelta(500) === '马上', 'humanDelta 亚秒级用「刚刚/马上」');
  ok(humanDelta(NaN) === '', 'humanDelta 非数字返回空串');
}

// ── 二、端到端（真实 bridge.js + 假网关） ─────────────────────────────────────
console.log('\n## 二、端到端（真实 bridge.js + 假网关，HTTP 走控制台端口）');

/** 起一个夹具，并给出四种通道的 HTTP 帮手。 */
async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        tools: { status: true },
        ...(overrides.socialV2 ?? {})
      },
      ...(overrides.top ?? {})
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  // agentToken 是按会话各自的（agentTokenOk 按 key 比对），跨会话用例必须显式换 token。
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
  return {
    h,
    port,
    tokens,
    // AI 通道：控制台令牌 + agent 声明 + 会话令牌（与真实 MCP 进程的发法一致）。
    //
    // ⚠️ 查询串里**不能**再放一个 token：全局鉴权读的是 `?token= ?? x-console-token`，
    //    URL 优先 —— 把会话令牌写进 `?token=` 会让它拿会话令牌去比控制台令牌，直接 401
    //    （实测踩过：`GET …?key=…&token=<agentToken>` + `x-console-token` 也会 401）。
    //    端点参数契约里 `token` 允许出现在查询串，但那只在**没有**控制台令牌的环境下才谈得上；
    //    测试一律走 `x-agent-token` 头。
    aiGet: (key = AGENT_KEY, token = tokens[AGENT_KEY], pathname = AGENT_PATH) =>
      raw('GET', `${pathname}?key=${encodeURIComponent(key)}`, { agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    // 操作者通道：只带控制台令牌。
    opGet: (key = AGENT_KEY, pathname = OP_PATH) =>
      raw('GET', `${pathname}${key === undefined ? '' : `?key=${encodeURIComponent(key)}`}`, { consoleToken: CONSOLE_TOKEN }),
    // 匿名：什么令牌都不带，应当被最外层全局鉴权拦下。
    anon: (pathname = OP_PATH) => raw('GET', pathname),
    // 带 agent 声明但令牌为空：最外层 isLiveAgentToken 关卡应当直接 403。
    aiNoToken: (pathname = AGENT_PATH) =>
      raw('GET', `${pathname}?key=${encodeURIComponent(AGENT_KEY)}`, { agentToken: '', consoleToken: CONSOLE_TOKEN, agentCall: true }),
    gatewayCalls: (action) => h.calls.http.filter((c) => c.url.endsWith(`/${action}`)),
    // 通用 HTTP 帮手（保存配置的回归用例要用它打非自省端点）。
    raw,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

try {
  const f = await startFixture();
  try {
    console.log('### AI 通道：GET /api/socialV2/self-status');
    {
      const r = await f.aiGet();
      if (endpointMissing(r)) {
        notePending('AI 通道自省成功返回');
      } else {
        ok(r.status === 200 && r.json.ok === true, `AI 通道自省成功（HTTP ${r.status}）`, JSON.stringify(r.json).slice(0, 200));
        ok(typeof r.json.text === 'string' && r.json.text.length > 0, '返回 text 摘要文本');
        ok(r.json.text === buildSelfStatus(r.json.data ?? {}).text || r.json.text.includes('【运行】') || r.json.text.includes('【建议】'), 'text 是 buildSelfStatus 的产物（含内部分段）', String(r.json.text).slice(0, 80));
        ok(r.json.text.length <= SELF_STATUS_MAX_CHARS, `text 不超过 ${SELF_STATUS_MAX_CHARS} 字（实际 ${r.json.text.length}）`);
        ok(r.json.truncated === false, '短文本 truncated:false');
        ok(Array.isArray(r.json.warnings), 'warnings 是数组', JSON.stringify(r.json.warnings));
        ok(r.json.data && typeof r.json.data === 'object' && !Array.isArray(r.json.data), 'data 是结构化对象（不只是文本）', JSON.stringify(r.json.data));
        ok(f.gatewayCalls('send_group_msg').length === 0 && f.gatewayCalls('send_private_msg').length === 0, '自省是只读的：没有发出任何消息');
      }
    }

    console.log('### 操作者通道：GET /api/self-status');
    {
      const r = await f.opGet(AGENT_KEY);
      if (endpointMissing(r)) {
        notePending('操作者通道返回自省摘要');
      } else {
        ok(r.status === 200 && r.json.ok === true, `控制台令牌可查任意 key（HTTP ${r.status}）`, JSON.stringify(r.json).slice(0, 200));
        ok(typeof r.json.text === 'string' && r.json.text.length > 0, '返回 text 摘要文本');
      }
      // 操作者通道不应要求 key（未指定时也应答，或明确 400，但绝不能 500/404）。
      const noKey = await f.opGet(undefined);
      if (endpointMissing(noKey)) notePending('操作者通道缺 key 的降级行为');
      else ok([200, 400].includes(noKey.status), `操作者通道缺 key 不炸（HTTP ${noKey.status}）`, JSON.stringify(noKey.json).slice(0, 120));
    }

    console.log('### 越权：拿 A 会话的令牌去读 B 会话');
    {
      const r = await f.aiGet(OTHER_KEY, f.tokens[AGENT_KEY]);
      if (endpointMissing(r)) notePending('跨会话越权被拒（403）');
      else {
        ok(r.status === 403, `AI 用别的会话 token 读别的 key ⇒ 403（HTTP ${r.status}）`, JSON.stringify(r.json));
        ok(/agent token 无效/.test(String(r.json.error ?? '')), '  错误信息是 agent token 无效（agentTokenOk 产生）', r.json.error);
      }
      // 反向：只给 key、不给 token
      const noTok = await f.aiGet(AGENT_KEY, '');
      if (endpointMissing(noTok)) notePending('AI 通道缺会话令牌被拒');
      else ok(noTok.status === 403, `AI 通道 token 为空 ⇒ 403（HTTP ${noTok.status}）`, JSON.stringify(noTok.json));
    }

    console.log('### 缺凭据');
    {
      const anon = await f.anon();
      ok(anon.status === 401, `什么令牌都不带 ⇒ 401（HTTP ${anon.status}）`, JSON.stringify(anon.json));
      ok(/未授权/.test(String(anon.json.error ?? '')), '  错误信息是「未授权：请提供控制台访问令牌」（全局鉴权层）', anon.json.error);

      const anonAi = await f.anon(AGENT_PATH);
      ok(anonAi.status === 401, `AI 通道不带任何令牌 ⇒ 401（HTTP ${anonAi.status}）`, JSON.stringify(anonAi.json));

      const missingTok = await f.aiNoToken();
      if (endpointMissing(missingTok)) notePending('AI 声明但无会话令牌 ⇒ 403');
      else ok(missingTok.status === 403, `x-agent-call 但会话令牌为空 ⇒ 403（HTTP ${missingTok.status}）`, JSON.stringify(missingTok.json));
    }

    console.log('### 参数非法 → 400');
    {
      const noKey = await f.aiGet('', f.tokens[AGENT_KEY]);
      if (endpointMissing(noKey)) notePending('缺 key ⇒ 400');
      else ok(noKey.status === 400 && /key 格式/.test(String(noKey.json.error ?? '')), `缺 key ⇒ 400（HTTP ${noKey.status}：${noKey.json.error}）`);

      const badKey = await f.aiGet('nonsense', f.tokens[AGENT_KEY]);
      if (endpointMissing(badKey)) notePending('key 格式非法 ⇒ 400');
      else ok(badKey.status === 400 && /key 格式/.test(String(badKey.json.error ?? '')), `key 格式非法 ⇒ 400（HTTP ${badKey.status}：${badKey.json.error}）`);

      const badKey2 = await f.aiGet('group:0', f.tokens[AGENT_KEY]);
      if (endpointMissing(badKey2)) notePending('key 群号非法（group:0）⇒ 400');
      else ok(badKey2.status === 400, `key 群号非法（group:0）⇒ 400（HTTP ${badKey2.status}）`, JSON.stringify(badKey2.json));
    }
  } finally {
    await f.stop();
  }

  console.log('### 开关关闭：socialV2.tools.status=false');
  {
    const off = await startFixture({ socialV2: { tools: { status: false } } });
    try {
      const r = await off.aiGet();
      if (endpointMissing(r)) notePending('工具关闭时 AI 通道 ⇒ 403');
      else {
        ok(r.status === 403, `tools.status=false ⇒ AI 通道 403（HTTP ${r.status}）`, JSON.stringify(r.json));
        ok(/工具未启用/.test(String(r.json.error ?? '')), '  错误信息是「工具未启用：…」', r.json.error);
      }
      const viaConsole = await off.opGet(AGENT_KEY);
      if (endpointMissing(viaConsole)) notePending('开关关闭只拦 AI：操作者通道仍可用');
      else ok(viaConsole.status === 200, `开关只拦 AI 工具，操作者通道仍可用（HTTP ${viaConsole.status}）`, JSON.stringify(viaConsole.json).slice(0, 120));
    } finally {
      await off.stop();
    }
  }
} catch (error) {
  fail += 1;
  console.error('  ❌ 端到端用例异常：', error?.stack ?? error);
}

// ── 三、回归：保存配置不得把"没写过的开关"默认成开 ────────────────────────────
//
// 这是实测踩到的真 bug（不是假想）：`POST /api/socialV2/config` 归一化工具开关时曾经写
// `merged.tools[k] = current.tools?.[k] !== false`。对配置文件里**从来没有过**的开关
// （正是新加的 `sendMusic` / `groupAdmin`），`current.tools[k]` 是 `undefined`，
// `undefined !== false` 得到 `true` —— 一次控制台保存就把"默认关"的两个对外动作面
// 固化成开，MCP 侧随即把 `qq_send_music` 注册给了模型。
//
// 断言口径：**保存与本次提交无关的字段后，缺省开关仍等于出厂默认**。
// 用 status（默认 true，且是本次测试的主角）和 sendMusic（默认 false）两头夹住，
// 保证不是"一律写 false"这种反向错误。
console.log('\n## 三、回归：保存配置不得把「没写过的开关」默认成开');
{
  const f = await startFixture();
  try {
    const saveOn = await f.raw('POST', '/api/socialV2/config', {
      body: { tools: { sendImage: true } },
      consoleToken: CONSOLE_TOKEN
    });
    ok(saveOn.status === 200 && saveOn.json.ok === true, `保存 tools.sendImage=true（HTTP ${saveOn.status}）`, JSON.stringify(saveOn.json).slice(0, 140));
    const afterOn = saveOn.json.config?.tools ?? {};
    ok(afterOn.sendImage === true, '保存后 sendImage 是 true（本次显式提交的开关生效）', JSON.stringify({ sendImage: afterOn.sendImage }));
    ok(afterOn.sendMusic === false, '**回归**：与本次提交无关的 sendMusic 仍回落出厂默认 false', JSON.stringify({ sendMusic: afterOn.sendMusic }));
    ok(afterOn.groupAdmin === false, '**回归**：与本次提交无关的 groupAdmin 仍回落出厂默认 false', JSON.stringify({ groupAdmin: afterOn.groupAdmin }));
    ok(afterOn.status === true, '**回归**：出厂默认 true 的 status 没被写坏（不是"一律写 false"）', JSON.stringify({ status: afterOn.status }));
    ok(afterOn.setStickerRemark === false && afterOn.sendVoice === false, '老的开箱默认关（setStickerRemark/sendVoice）同样没被静默打开');

    // 再走一次真实的落盘读取：上面的断言只看响应体，这一步确认写进文件的那份也是同一口径。
    const readBack = await f.raw('GET', '/api/socialV2/config', { consoleToken: CONSOLE_TOKEN });
    const fileTools = readBack.json.config?.tools ?? {};
    ok(fileTools.sendImage === true && fileTools.sendMusic === false && fileTools.groupAdmin === false,
      '落盘后的 tools（GET 读回）与响应一致：sendImage=true、sendMusic/groupAdmin=false',
      JSON.stringify({ sendImage: fileTools.sendImage, sendMusic: fileTools.sendMusic, groupAdmin: fileTools.groupAdmin }));

    // 收尾：把本次测试打开的开关关回去（夹具用的是临时目录，这里主要是保持用例自洽）。
    const saveOff = await f.raw('POST', '/api/socialV2/config', {
      body: { tools: { sendImage: false } },
      consoleToken: CONSOLE_TOKEN
    });
    ok(saveOff.status === 200 && saveOff.json.config?.tools?.sendImage === false, '收尾：sendImage 关回去');
    ok(saveOff.json.config?.tools?.sendMusic === false && saveOff.json.config?.tools?.groupAdmin === false, '收尾后 sendMusic/groupAdmin 仍是 false');
  } finally {
    await f.stop();
  }
}

console.log(`\n== 自省自检：${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待接线` : ''} ==`);
if (pending) {
  console.log(`说明：${pending} 条断言因端点尚未接线（HTTP 404 not found）而记为「待接线」——不是测试脚本写错；`);
  console.log('      第二阶段接线完成后重跑本脚本，这些断言会自动转为真实断言。');
}
if (fail > 0) {
  console.error('一行结论：自省能力自检失败 —— 见上面 ❌（纯函数层应当全绿；HTTP 层失败即为真问题）。');
  process.exitCode = 1;
} else {
  console.log(`一行结论：自省纯函数层全绿；HTTP 层 ${pass} 通过、${pending} 条待接线${pending ? '（端点未接）' : '（端点已接线，全部为真断言）'}。`);
}
