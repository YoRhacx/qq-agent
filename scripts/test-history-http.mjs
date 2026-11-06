// 「历史检索」（/api/socialV2/history/search、/api/socialV2/history/stats）自检。
//
// 用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，配临时 config 与
// 假网关，直接调真实的 appendSocialV2Message / recordSentMessagesV2 归档，再打控制台端口的
// HTTP 检索 —— 全程不碰真实 QQ、不重启桥接进程，历史落在临时目录里（不污染 state/history）。
//
// 覆盖：
//   一、入站/出站归档后能搜到；多词 AND；messageId 去重；sinceMs/untilMs 过滤。
//   二、边界与鉴权：空 query / 超长 query / limit 上下限 / 坏 JSON / 非法 key /
//      AI 只能搜自己 key / 工具与总开关关闭时的 403 / stats 可用。
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

async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        tools: { searchHistory: true },
        history: { enabled: true },
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
    // 操作者通道：只带控制台令牌。
    search: (body) => raw('POST', '/api/socialV2/history/search', { body, consoleToken: CONSOLE_TOKEN }),
    stats: (key) => raw('GET', `/api/socialV2/history/stats?key=${encodeURIComponent(key)}`, { consoleToken: CONSOLE_TOKEN }),
    // 匿名：什么令牌都不带，应当被最外层全局鉴权拦下。
    anon: (body) => raw('POST', '/api/socialV2/history/search', { body }),
    // 智能体通道：控制台令牌（过全局鉴权）+ x-agent-call + 该会话自己的令牌。
    aiSearch: (body, token = tokens[AGENT_KEY]) => raw('POST', '/api/socialV2/history/search', { body, agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    aiStats: (key = AGENT_KEY, token = tokens[AGENT_KEY]) => raw('GET', `/api/socialV2/history/stats?key=${encodeURIComponent(key)}`, { agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

/** 归档是异步的（promise 链），检索要么轮询到命中、要么超时。 */
async function searchUntil(f, body, predicate = (r) => (r.json.hits?.length ?? 0) > 0, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await f.search(body);
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await sleep(25);
  }
}

console.log('## 一、归档后能检索到（入站 + 出站）');
{
  const f = await startFixture();
  try {
    // 入站：只有「非自己」的消息才进历史。
    // messageId 用**数字**：模块的 append() 只对可解析成有限数字（且 ≠ 0）的 messageId 去重
    // （src/history-archive.mjs:494-506，`Number(record.messageId)` + 扫尾部 64 条 / 16KB），
    // 真实 QQ 消息 id 就是数字，用字符串 id 去重不会生效。
    f.h.appendSocialV2Message(AGENT_KEY, '张三', '今晚吃火锅吧', '今晚吃火锅吧', false, false, 9001);
    f.h.appendSocialV2Message(AGENT_KEY, '张三', '明天要去爬山', '明天要去爬山', false, false, 9002);
    // 出站：文本发送只在一处记 dir:'out'
    f.h.recordSentMessagesV2(AGENT_KEY, ['好，那明早七点集合']);

    const hit = await searchUntil(f, { key: AGENT_KEY, query: '火锅' });
    ok(hit.status === 200 && hit.json.ok === true, `检索接口 200/ok（HTTP ${hit.status}）`, JSON.stringify(hit.json));
    ok((hit.json.hits?.length ?? 0) === 1, `入站消息能搜到（hits=${hit.json.hits?.length}）`, JSON.stringify(hit.json.hits));
    const blob = JSON.stringify(hit.json.hits ?? []);
    ok(/张三/.test(blob), '片段里带发送者（snippet 已含发送者信息）', blob);
    ok(/火锅/.test(blob), '片段里带命中内容');
    ok(hit.json.scanned > 0, `scanned 报告已检查行数（${hit.json.scanned}）`);
    ok(hit.json.truncated === false || hit.json.truncated === true, 'truncated 字段存在（布尔）');

    const multi = await searchUntil(f, { key: AGENT_KEY, query: '火锅 张三' }, (r) => (r.json.hits?.length ?? 0) > 0);
    ok((multi.json.hits?.length ?? 0) === 1, '多词是同一条内 AND（火锅 + 张三 命中）');
    const andMiss = await f.search({ key: AGENT_KEY, query: '火锅 李四' });
    ok((andMiss.json.hits?.length ?? 0) === 0, '多词 AND 缺一个词就不命中（火锅 + 李四 = 0）');

    const outbound = await searchUntil(f, { key: AGENT_KEY, query: '七点集合' }, (r) => (r.json.hits?.length ?? 0) > 0);
    ok((outbound.json.hits?.length ?? 0) === 1, '出站消息也归档了（dir:out 只记一处，没有重复两条）', JSON.stringify(outbound.json.hits));

    // messageId 去重：同一条消息重复 append（重放/补投）不会搜出两份
    f.h.appendSocialV2Message(AGENT_KEY, '张三', '今晚吃火锅吧', '今晚吃火锅吧', false, false, 9001);
    await sleep(120);
    const dedup = await f.search({ key: AGENT_KEY, query: '火锅' });
    ok((dedup.json.hits?.length ?? 0) === 1, `同一个 messageId 重复归档被去重（hits=${dedup.json.hits?.length}）`, JSON.stringify(dedup.json.hits));

    // 时间窗过滤
    const future = await f.search({ key: AGENT_KEY, query: '火锅', sinceMs: Date.now() + 60000 });
    ok((future.json.hits?.length ?? 0) === 0, 'sinceMs 在未来 → 0 命中');
    const past = await f.search({ key: AGENT_KEY, query: '火锅', untilMs: Date.now() - 60000 });
    ok((past.json.hits?.length ?? 0) === 0, 'untilMs 在过去 → 0 命中');
    const inWindow = await f.search({ key: AGENT_KEY, query: '火锅', sinceMs: Date.now() - 600000, untilMs: Date.now() + 60000 });
    ok((inWindow.json.hits?.length ?? 0) === 1, 'sinceMs/untilMs 覆盖现在 → 命中');

    // 另一个会话是隔离的（各会话一个 JSONL）
    const iso = await f.search({ key: OTHER_KEY, query: '火锅' });
    ok((iso.json.hits?.length ?? 0) === 0, '别的会话搜不到这个会话的历史（按 key 隔离）');

    const stats = await f.stats(AGENT_KEY);
    ok(stats.status === 200 && stats.json.ok === true && stats.json.key === AGENT_KEY, `stats 可用（HTTP ${stats.status}）`, JSON.stringify(stats.json));
    ok(stats.json.stats && typeof stats.json.stats === 'object', 'stats 带统计对象', JSON.stringify(stats.json.stats));

    // 落盘确实落在临时目录（不写进仓库 state/history）
    const stateDir = path.join(f.h.temp, 'state', 'history');
    const files = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    ok(files.length >= 1, `历史按会话落 JSONL 到临时目录（${files.join(', ')}）`);
  } finally {
    await f.stop();
  }
}

console.log('\n## 二、边界与鉴权');
{
  const f = await startFixture();
  try {
    const emptyQuery = await f.search({ key: AGENT_KEY, query: '  ' });
    ok(emptyQuery.status === 400 && /query 不能为空/.test(emptyQuery.json.error ?? ''), `空 query → 400（${emptyQuery.json.error}）`);
    const longQuery = await f.search({ key: AGENT_KEY, query: '词'.repeat(101) });
    ok(longQuery.status === 400 && /query 过长/.test(longQuery.json.error ?? ''), `query 超过 100 字 → 400（${longQuery.json.error}）`);
    const badLimit0 = await f.search({ key: AGENT_KEY, query: '火锅', limit: 0 });
    ok(badLimit0.status === 400 && /limit 必须是 1~50/.test(badLimit0.json.error ?? ''), `limit=0 → 400（${badLimit0.json.error}）`);
    const badLimit51 = await f.search({ key: AGENT_KEY, query: '火锅', limit: 51 });
    ok(badLimit51.status === 400, 'limit=51 超过上限 → 400');
    const okLimit = await f.search({ key: AGENT_KEY, query: '火锅', limit: 5 });
    ok(okLimit.status === 200, 'limit=5 合法');
    const badSince = await f.search({ key: AGENT_KEY, query: '火锅', sinceMs: 'abc' });
    ok(badSince.status === 400 && /sinceMs 必须是毫秒数/.test(badSince.json.error ?? ''), `sinceMs 非数字 → 400（${badSince.json.error}）`);

    const badJson = await f.search({ rawBody: '{"key":' });
    ok(badJson.status === 400, `坏 JSON 请求体 → 400（HTTP ${badJson.status}：${badJson.json.error}）`);
    const badKey = await f.search({ key: 'nope', query: 'x' });
    ok(badKey.status === 400 && /group:群号/.test(badKey.json.error ?? ''), '非法 key → 400');

    // 鉴权：AI 只能查自己那个 key
    const aiOk = await f.aiSearch({ key: AGENT_KEY, query: '任何' });
    ok(aiOk.status === 200, `AI 通道查自己的会话成功（HTTP ${aiOk.status}）`, JSON.stringify(aiOk.json));
    const cross = await f.aiSearch({ key: OTHER_KEY, query: '任何' }, f.tokens[AGENT_KEY]);
    ok(cross.status === 403 && /agent token 无效/.test(cross.json.error ?? ''), `AI 用别的会话 key → 403（${cross.json.error}）`);
    const noToken = await f.aiSearch({ key: AGENT_KEY, query: '任何' }, '');
    ok(noToken.status === 403, `AI 通道不带令牌 → 403（HTTP ${noToken.status}：${noToken.json.error}）`);
    const noAuth = await f.anon({ key: AGENT_KEY, query: '任何' });
    ok(noAuth.status === 401 || noAuth.status === 403, `什么都没带 → 未授权（HTTP ${noAuth.status}：${noAuth.json.error}）`);

    const statsCross = await f.aiStats(OTHER_KEY, f.tokens[AGENT_KEY]);
    ok(statsCross.status === 403, 'AI 查别的会话 stats → 403');
  } finally {
    await f.stop();
  }

  const fToolOff = await startFixture({ socialV2: { tools: { searchHistory: false } } });
  try {
    const off = await fToolOff.aiSearch({ key: AGENT_KEY, query: 'x' });
    ok(off.status === 403 && /工具未启用/.test(off.json.error ?? ''), `开关 searchHistory=false → AI 403（${off.json.error}）`);
    const opStill = await fToolOff.search({ key: AGENT_KEY, query: 'x' });
    ok(opStill.status === 200, '开关只管 AI 工具，操作者通道仍可用（只读）');
  } finally {
    await fToolOff.stop();
  }

  const fHistOff = await startFixture({ socialV2: { history: { enabled: false } } });
  try {
    const off = await fHistOff.aiSearch({ key: AGENT_KEY, query: 'x' });
    ok(off.status === 403 && /历史检索已关闭/.test(off.json.error ?? ''), `history.enabled=false → 403（${off.json.error}）`);
    const off2 = await fHistOff.aiStats(AGENT_KEY);
    ok(off2.status === 403 && /历史检索已关闭/.test(off2.json.error ?? ''), 'stats 同样受 history.enabled 控制');
  } finally {
    await fHistOff.stop();
  }
}

console.log(`\n== 历史检索自检：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''} ==`);
if (fail > 0) process.exitCode = 1;
