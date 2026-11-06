// 回归测试：qq_wait_for_messages 的长轮询必须能撑过 300 秒。
//
// 背景（这是本测试存在的唯一理由）：
//   Node 的全局 fetch 是 undici，它给每个请求的 headersTimeout / bodyTimeout 默认都是
//   **300000ms**，且无法从全局 fetch 的选项里改（undici 不作为公开模块导出，拿不到 Agent）。
//   桥接的 /api/socialV2/wait 是长轮询端点：请求发出去后服务端一直挂着不写响应，直到等到
//   消息或预算耗尽。于是规范里那句「沉睡前观察用 timeoutMs=300000」正好压在 300 秒那一刻，
//   客户端比服务端先放弃，抛出 **`TypeError: fetch failed`**（不是 AbortError，从文案上
//   完全看不出是超时）—— 现象就是「qq_wait_for_messages 持续 fetch failed，但读取/发送
//   全都正常」，看起来像端点坏了，其实服务端一直是好的。
//
//   实测对照（同端点、同 300000ms 预算）：
//     · 全局 fetch → 约 300 秒抛 `fetch failed`
//     · node:http  → HTTP 200、耗时 300264ms、timeout=true
//   故修复在客户端：src/mcp-snowluma-safe.js 里预算超过 UNDICI_SAFE_BUDGET_MS(280000)
//   的请求改走 agentApiRaw（node:http 直连）。
//
// 用法：
//   node scripts/test-wait-longpoll.mjs          # 快烟（15 秒），CI/自检用
//   node scripts/test-wait-longpoll.mjs --long   # 真·300 秒，验证 undici 绕行确实生效
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LONG = process.argv.includes('--long') || /^(1|true|yes)$/i.test(process.env.WAIT_LONG ?? '');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (label) => { pass += 1; console.log(`✅ ${label}`); };
const bad = (label) => { fail += 1; console.log(`❌ ${label}`); };
const skipped = (label) => { skip += 1; console.log(`⏭️  ${label}`); };

function pickSession() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    for (const [key, v] of Object.entries(st.conversations ?? {})) {
      if (v?.agentToken) return { key, token: v.agentToken };
    }
  } catch {}
  return null;
}

async function bridgeUp() {
  try {
    const res = await fetch('http://127.0.0.1:3100/api/status', { signal: AbortSignal.timeout(4000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));
const budgetMs = LONG ? 300000 : 15000;

if (!(await bridgeUp())) {
  skipped('桥接未在 127.0.0.1:3100 运行，跳过 qq_wait_for_messages 长轮询测试');
  console.log(`\n通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
  process.exit(0);
}

const session = pickSession();
if (!session) {
  skipped('state/social-v2.json 里没有带 agentToken 的会话，跳过');
  console.log(`\n通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
  process.exit(0);
}

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'wait-longpoll-test', version: '0.1.0' });

try {
  await client.connect(transport);
  ok('安全 MCP 连接成功');

  const tools = await client.listTools();
  if (tools.tools.some((t) => t.name === 'qq_wait_for_messages')) ok('qq_wait_for_messages 已注册');
  else bad('qq_wait_for_messages 未注册（工具开关关了？）');

  console.log(`\n—— 调用 qq_wait_for_messages(timeoutMs=${budgetMs}${LONG ? '，即规范里的"沉睡前观察"档' : ''}) ——`);
  const t0 = Date.now();
  // MCP SDK 的 Client 自带一个请求超时（默认 60 秒，SDK 常量 DEFAULT_REQUEST_TIMEOUT_MSEC），
  // 它和 undici 的 300 秒是**两层完全不同的**超时：不覆盖的话，300 秒档还没轮到服务端说话，
  // 本地先抛 `MCP error -32001: Request timed out`，看起来像"桥接坏了"其实是测试自己掐的。
  const res = await client.callTool(
    {
      name: 'qq_wait_for_messages',
      arguments: { key: session.key, token: session.token, timeoutMs: budgetMs }
    },
    undefined,
    { timeout: budgetMs + 60000 }
  );
  const elapsed = Date.now() - t0;
  const text = res.content?.[0]?.text ?? '';
  console.log(`   耗时 ${elapsed}ms，isError=${res.isError === true}`);
  console.log(`   返回 ${text.slice(0, 220)}`);

  if (res.isError) {
    bad(`等待被当成失败返回：${text.slice(0, 200)}`);
    // 300 秒这一档一旦走回全局 fetch，报错会正好是 fetch failed —— 让失败信息自解释。
    if (/fetch failed/i.test(text)) {
      console.log('   ↳ 这正是 undici 300 秒默认上限的症状；确认 agentApi 仍把长预算路由到 agentApiRaw。');
    }
  } else {
    ok('等待正常返回（没有 fetch failed）');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (parsed && typeof parsed === 'object') ok('返回体是合法 JSON');
    else bad('返回体不是合法 JSON');
    if (parsed && (parsed.timeout === true || parsed.arrived === true || parsed.paused === true)) {
      ok(`返回体带结束标记（timeout=${parsed.timeout} arrived=${parsed.arrived} paused=${parsed.paused}）`);
    } else {
      bad(`返回体缺少 timeout/arrived/paused 标记：${text.slice(0, 160)}`);
    }
    if (LONG) {
      // 关键断言：这一档必须真的熬过 undici 的 300 秒默认上限。
      if (elapsed >= 290000) ok(`真的撑过了 290 秒（${elapsed}ms）—— undici 绕行生效`);
      else bad(`只等了 ${elapsed}ms 就返回，长轮询预算没有生效（预期 ≥290000ms）`);
    }
  }
} catch (error) {
  bad(`测试自身抛错：${error?.message ?? error}`);
} finally {
  try { await client.close(); } catch {}
}

console.log(`\n通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
process.exit(fail === 0 ? 0 : 1);
