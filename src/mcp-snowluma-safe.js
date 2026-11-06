// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';
import { watchVideo } from './video-watch.js';
import { openCard } from './card-open.js';
import { errorText } from './error-text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 配置与状态**一律由 ROOT 推导**（ROOT = 本文件所在目录的上一级）。
//
// 自检要拿一份临时 config.json 起真 stdio server 时，用的是「给临时目录放一个到
// src/ 与 node_modules/ 的 Junction、再用 node --preserve-symlinks 起服务」的办法，
// 于是这里的 ROOT 自然落在临时目录、state/ 也跟着走 —— **绝不能**改用环境变量只换
// config 路径：那样 ROOT 还是真仓库，注册快照会被写进真 state/，污染控制台对账。
function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function configPath() {
  return path.join(ROOT, 'config.json');
}

// ⚠️ 这里**故意不再**留 `const cfg = loadConfig()` 那种"启动时读一次"的快照。
//
// 那个快照正是"工具开关改了不算数"的根源：注册期拿它决定注册哪些工具，于是
// 关掉一个工具要重起进程才从模型清单里消失、打开一个工具则永远不生效。
// 现在改成「全部注册 + 按活配置 enable/disable」（见下面的 desiredToolStates /
// applyToolStates），进程内没有任何长期存在的配置快照 —— 需要配置时一律现读。
function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

// ── 长请求必须绕开全局 fetch（undici 的 300 秒硬上限）────────────────────────
//
// 症状：`qq_wait_for_messages` 在"沉睡前观察"这一档**持续报 `fetch failed`**，
// 而同一时刻 `qq_bridge_status` 显示 SnowLuma 在线、心跳正常、读取/发送全都好用——
// 看起来像"等待接口坏了"，其实端点完全健康。
//
// 根因：Node 的全局 fetch 是 undici，它给**每个请求**的 headersTimeout / bodyTimeout
// 默认都是 **300000ms**，而且这个值没法从全局 fetch 的选项里改（undici 不作为公开模块
// 导出，拿不到 Agent）。桥接的 `/api/socialV2/wait` 是**长轮询**端点：请求发出去以后
// 服务端一直挂着不写响应，直到等到消息或预算耗尽。于是规范里那句
// 「沉睡前观察用 qq_wait_for_messages(timeoutMs=300000)」**正好压在 300 秒那一刻**：
// 客户端比服务端先放弃，抛出 `TypeError: fetch failed`（**不是 AbortError**，所以从
// 报错文案上完全看不出是超时，排查时极具误导性）。
//
// 实测对照（同一端点、同样 300000ms 预算、同一台机器）：
//   · 全局 fetch → 约 300 秒抛 `fetch failed`
//   · node:http  → `HTTP 200`、耗时 300264ms、`timeout=true` ← 服务端一直是好的
// 所以锅在客户端、就修在客户端：预算超过阈值的长请求改走 node:http 直连，
// 它没有那套默认上限。（服务端不必改：它的 requestTimeout/headersTimeout 实测不影响
// 长轮询响应，改服务端反而会削掉防慢连接的兜底。）
const UNDICI_SAFE_BUDGET_MS = 280000;

function agentApiBaseParts() {
  const u = new URL(agentApiBase());
  return {
    transport: u.protocol === 'https:' ? https : http,
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  };
}

// 与 agentApi 同样的鉴权头与错误语义，只是换成 node:http 直连。
function agentApiRaw(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const method = init.method || 'POST';
  const rawBody = init.body;
  const payloadText = rawBody == null
    ? null
    : (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(init.headers ?? {})
  };
  // 同 agentApi：这个头绝不能省略，否则"模型漏传会话令牌"会退化成控制台权限。
  headers['x-agent-call'] = '1';
  if (payloadText != null) headers['content-length'] = Buffer.byteLength(payloadText);

  const { transport, host, port } = agentApiBaseParts();
  return new Promise((resolve, reject) => {
    const req = transport.request({ transport, host, port, path, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(buf); } catch { body = null; }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(body?.error ? errorText(body.error) : `桥接 API HTTP ${status}`));
          return;
        }
        if (body && typeof body === 'object' && body.ok === false) {
          reject(new Error(body.error ? errorText(body.error) : '桥接 API 返回 ok:false（未说明原因）'));
          return;
        }
        resolve(body);
      });
    });
    // 兜底：只在这里把"整条连接一直没人说话"当异常。阈值给足余量（预算 + 1 分钟），
    // 因为长轮询期间服务端**本来就不说话**，卡太紧会把"它正在等消息"误判成"连接死了"。
    req.setTimeout(Math.max(10000, timeoutMs) + 60000, () => {
      req.destroy(new Error(`桥接 API 超过 ${Math.round((Math.max(10000, timeoutMs) + 60000) / 1000)}s 没有任何响应`));
    });
    req.on('error', (err) => reject(err));
    if (payloadText != null) req.write(payloadText);
    req.end();
  });
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  // 长请求交给 node:http（见上面 UNDICI_SAFE_BUDGET_MS 的说明）。
  if (timeoutMs > UNDICI_SAFE_BUDGET_MS) return agentApiRaw(path, { ...init, timeoutMs });
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error ? errorText(body.error) : `桥接 API HTTP ${res.status}`);
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(body.error ? errorText(body.error) : '桥接 API 返回 ok:false（未说明原因）');
  }
  return body;
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r3' });

// 兜底：handler 里任何漏掉的异常都变成模型能读的一句话，而不是 DSH 侧的 `Error: [object Object]`。
// 在注册处统一包一层，是因为工具很多（50+），逐个 try/catch 一定会漏；这里一处管住全部。
// 注意必须 return 注册句柄：热开关要拿它 enable/disable。
const registerToolSafely = server.tool.bind(server);
server.tool = (...args) => {
  const handler = args.pop();
  return registerToolSafely(...args, async (...callArgs) => {
    try {
      return await handler(...callArgs);
    } catch (error) {
      return { content: [{ type: 'text', text: `内部错误：${errorText(error)}` }], isError: true };
    }
  });
};

// ── 工具开关：全部注册 + 按活配置 enable/disable（真·热生效） ────────────────
//
// 为什么必须在注册期就生效（而不是只在校验期）：每个工具的描述 + 参数 schema 都会随
// system prompt 在**每一次**请求里重发（实测 49 个工具约 10k token）。只在校验时 403 的话，
// 被关掉的工具依然占着上下文、依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 旧实现是"注册期直接跳过"：开关关闭 ⇒ 那个 server.tool(...) 根本不执行。省 token 的目的
// 达到了，但代价是**注册状态被钉死在进程启动那一刻** —— 改开关必须让 MCP 进程重起一次，
// 而"重起"这件事用户看不见、容易忘，控制台显示的和模型实际拿到的因此长期可以不一致。
//
// 新实现：**全部无条件注册**，注册完拿住 SDK 返回的句柄，再按 config.json 折算
// enable()/disable()。SDK 的 tools/list 只列 `enabled` 的工具（省 token 的效果原样保住），
// 而 disable()/enable() 会自动发 notifications/tools/list_changed，DSH 收到后重新拉清单，
// 于是**改完当场生效**：不用重起 MCP，更不用重启 DSH。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  qq_send_image: 'sendImage',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_repeat_message: 'repeatMessage',
  qq_get_message_images: 'getImages',
  qq_read_file: 'readFile',
  qq_open_card: 'openCard',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  qq_watch_video: 'watchVideo',
  qq_listen_voice: 'listenVoice',
  qq_set_reminder: 'reminders',
  qq_list_reminders: 'reminders',
  qq_search_history: 'searchHistory',
  qq_bridge_status: 'status',
  qq_send_music: 'sendMusic',
  qq_group_admin: 'groupAdmin',
  qq_list_requests: 'groupAdmin',
};
// 父闸门：这些工具除了自己的开关，还要看所属子系统是否整体启用
// （如 `socialV2.sticker.enabled === false` 时，表情相关的工具一律不可用）。
// 以前这些闸门写成 `if (...) { server.tool(...) }`，闸门一变就必须重启进程 ——
// 而且闸门关掉时那个工具**既不在 registered 也不在 disabled**，控制台对账时最容易漏报。
// 现在全部无条件注册、由下面的折算统一 enable/disable，于是父闸门也跟着热了。
const TOOL_PARENT_GATES = {
  qq_list_stickers: 'sticker',
  qq_get_sticker_image: 'sticker',
  qq_send_sticker: 'sticker',
  qq_collect_sticker: 'sticker',
  qq_sticker_note: 'sticker',
  qq_set_sticker_remark: 'sticker',
  qq_send_voice: 'voice',
  qq_list_voices: 'voice',
  qq_send_image: 'media'
};

function parentGateOpen(section, c) {
  return c?.socialV2?.[section]?.enabled !== false;
}

// 句柄表：tool 名 → SDK 的 registeredTool（带 enable() / disable()）。
//
// 注意这里**不再丢弃 server.tool(...) 的返回值** —— 拿到句柄才谈得上运行期开关。
// 旧写法是「开关关闭 ⇒ 注册期直接 return undefined（工具压根不存在）」，代价是
// 只有重启进程才能改；现在改成「全部注册，然后按 config.json 折算 enable/disable」。
//
// 这不是白注册：SDK 的 tools/list 处理器会 `filter(([, tool]) => tool.enabled)`
// （@modelcontextprotocol/sdk 1.32.1 dist/esm/server/mcp.js:107-139），被 disable 的工具
// 不进清单 ⇒ 省 token 的效果原样保住；tools/call 也会拒绝 disabled 的工具。
// 而且 disable()/enable() 内部**无条件**调 sendToolListChanged()（同文件 :688-690），
// DSH 侧订阅了 notifications/tools/list_changed 并重新拉 tools/list，于是当场生效。
const toolHandles = new Map();
// 全部注册过的工具名（快照用）。与 toolHandles 分开是因为两者语义不同：
// registered = 「进程里存在这个工具」，toolHandles = 「这个工具能被热开关」。
const registeredNames = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const handle = registerTool(name, ...rest);
    registeredNames.push(name);
    // ⚠️ **必须校验形状**，不能只判 truthy：自检用的桩 McpServer 里
    // `tool()` 写的是 `tools.set(...)`，而 Map.set 返回的是 Map 自身（truthy 但没有
    // enable/disable）—— 只看 truthy 的话，折算时会 `handle.enable is not a function`
    // 把整个 MCP server 打挂，症状是"她所有 QQ 工具一起消失"。
    if (handle && typeof handle.enable === 'function' && typeof handle.disable === 'function') {
      toolHandles.set(name, handle);
    }
    return handle;
  };
}

// 把「活的 config.json」折算成每个工具此刻该开还是该关。
// 每次现读盘（loadConfig），**不用启动时那份快照** —— 那正是旧实现"改了不算数"的根源。
function desiredToolStates(c = loadConfig()) {
  const states = new Map();
  for (const name of toolHandles.keys()) {
    const flag = TOOL_CONFIG_FLAGS[name];
    // 没登记 flag 的（qq_send_message / qq_reply 这类跨模式共用的）不看 v2 开关，
    // 是否允许由桥接在调用期判定 —— 与旧实现口径一致。
    const flagOn = !flag || c?.socialV2?.tools?.[flag] !== false;
    const section = TOOL_PARENT_GATES[name];
    states.set(name, flagOn && (!section || parentGateOpen(section, c)));
  }
  return states;
}

/** 按当前 config.json 同步每个工具的 enable/disable，返回本次真正变了的那些。 */
function applyToolStates({ reason = 'config' } = {}) {
  const states = desiredToolStates();
  const changed = [];
  for (const [name, want] of states) {
    const handle = toolHandles.get(name);
    if (!handle) continue;
    if (handle.enabled !== want) {
      if (want) handle.enable();
      else handle.disable();
      changed.push(`${want ? '开' : '关'} ${name}`);
    }
  }
  if (changed.length) {
    // 走 stderr：stdio MCP 的 stdout 是协议通道，往里写一个字都会污染 JSON-RPC。
    console.error(`[mcp-snowluma-safe] 工具开关已同步（${reason}）：${changed.join('、')}`);
  }
  return { states, changed };
}

// config.json 一变就重新折算。桥接保存配置是原子写（先写 .tmp 再 rename），
// fs.watch 在 Windows 上能收到 rename 事件；再加一条低频轮询兜底 ——
// 某些编辑器/工具"先删后建"式的保存会丢 watch 事件。
let toolStateSyncTimer = null;
function scheduleToolStateSync(reason) {
  if (toolStateSyncTimer) return;
  try {
    toolStateSyncTimer = setTimeout(() => {
      toolStateSyncTimer = null;
      try {
        applyToolStates({ reason });
        writeRegisteredToolsSnapshot();
      } catch (error) {
        console.error(`[mcp-snowluma-safe] 工具开关同步失败：${errorText(error)}`);
      }
    }, 120);
    if (typeof toolStateSyncTimer?.unref === 'function') toolStateSyncTimer.unref();
  } catch {
    // 拿不到定时器（如被塞进受限 VM 跑自检）就退化成"下次轮询再说"，绝不能因此崩掉。
    toolStateSyncTimer = null;
  }
}

let configMtimeMs = 0;
function pollConfigChange() {
  try {
    const m = fs.statSync(configPath()).mtimeMs;
    if (m !== configMtimeMs) {
      configMtimeMs = m;
      scheduleToolStateSync('config.json 变化（轮询）');
    }
  } catch {
    // 读不到 config.json（正在被重写/被删）不算错误，下一拍再看。
  }
}

// 把「本次进程实际注册了哪些工具、此刻哪些是开的」落盘，让控制台能看见。
//
// 为什么需要：MCP 进程与桥接进程是**两个进程**，各自读 config.json。桥接的 cfg 是活的
// （保存即生效），MCP 侧现在也热了（见上面的 applyToolStates），但两边仍然可能错位 ——
// 比如 config.json 刚被改、watch 事件还没到、或者有人手工改了文件却没触发同步。
// 控制台光看 config.json 一个字都看不出这种错位，只能靠这份注册快照对账。
//
// 文件名带 PID（`state/mcp-tools.<pid>.json`）而不是共用一份：同时可能存在不止一个
// MCP 进程（DSH 重启期的交叠、或手工起的探针），共用一份会互相覆盖 —— 一个刚起就退出的
// 探针能把在跑的那个进程的快照盖掉，控制台随即显示"注册状态未知"。桥接侧会挑
// 「活着且最新」的那一份（见 bridge.js 的 GET /api/socialV2/tools）。
//
// 字段含义（与 src/mcp-tool-registry.js 的 reconcileToolRegistry 对齐）：
//   · registered 进程内**存在**这个工具（全部注册后，正常应等于 toolHandles 的键）
//   · disabled   此刻被 disable 的那些（形如 `qq_x(flag)`，兼容旧格式）
function writeRegisteredToolsSnapshot() {
  try {
    const stateDir = path.join(ROOT, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const target = path.join(stateDir, `mcp-tools.${process.pid}.json`);
    // registered 用 registeredNames 而不是 toolHandles.keys()：前者是「进程里存在这些工具」，
    // 后者是「这些工具能被热开关」。正常情况下两者相同，但句柄形状不对时（自检桩、
    // SDK 换 API）toolHandles 会少几个 —— 那时候更应该如实报出"注册了但没有开关句柄"，
    // 而不是把它们从清单里藏起来。
    const registered = registeredNames.slice();
    const disabled = registered.filter((name) => toolHandles.get(name)?.enabled === false)
      .map((name) => (TOOL_CONFIG_FLAGS[name] ? `${name}(${TOOL_CONFIG_FLAGS[name]})` : name));
    const payload = {
      at: new Date().toISOString(),
      pid: process.pid,
      server: 'snowluma-safe',
      // 热生效：进程不再吃启动快照，这里报的是**每次折算时现读的活配置**。
      hot: true,
      // tool → 开关名。控制台靠它把「活的 config.json 开关」和「本次进程真正注册了什么」对上。
      flags: { ...TOOL_CONFIG_FLAGS },
      registered,
      disabled
    };
    // 原子写：先写临时文件再 rename，避免控制台读到写了一半的 JSON。
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, target);
    pruneDeadSnapshots(stateDir, target);
  } catch {
    // 落盘失败不影响 MCP 本身（只是控制台少一份对账数据），静默即可。
  }
}

// 顺手清掉「写出它的进程已经不在」的快照，免得 state/ 越积越多。
// 只认自己这个命名模式的文件，绝不碰 state/ 里别的任何东西。
function pruneDeadSnapshots(stateDir, keepFile) {
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { return; }
  for (const name of names) {
    const m = /^mcp-tools\.(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(stateDir, name);
    if (file === keepFile) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = error?.code === 'EPERM'; }
    if (!alive) { try { fs.rmSync(file, { force: true }); } catch {} }
  }
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      // 这里绝不能空吞：原来 get_status 一失败就留下 `online: undefined, good: undefined`，
      // 模型看到的样子和「机器人离线」完全一样，于是会把「网关查询失败」误报成「我掉线了」。
      // 失败就把原因原样带出去。
      let statusError;
      try { status = await onebot('get_status'); }
      catch (error) { statusError = String(errorText(error)); }
      const payload = { ...login, online: status.online, good: status.good };
      if (statusError) payload.statusError = statusError;
      return { content: [{ type: 'text', text: serializeModelData(payload) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${errorText(error)}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${errorText(error)}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${errorText(error)}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。用于**需要点明"我在回哪条"**的场合，不是群聊的默认回复方式（默认用 qq_send_message 直接说；群里句句引用最像人机）。replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。用法：① 有两个人以上同时在跟你说话时**必须**引用，分两条各自引用，别混着回；② 你要接的**不是最新那一条**时引用一下，别人才知道你在接谁。接最新那条、且只有一个人在跟你说话时——不引，直接发。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('顺便 @ 某个人（群成员 QQ 号）。只在要点名时用——他很久没理你、或你回的是很早的一条怕他没看见；一条消息最多 @ 一个人，别滥用'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, atUserId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, atUserId: atUserId ?? null, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。群聊里**默认不引用**——直接把话接上就行，句句引用最像人机。只有这两种情况才填 replyToMessageId：① 有两个人以上同时在跟你说话（必须引，免得答错人）；② 你要接的不是最新那一条（引一下别人才知道你在接谁）。接最新那条、且只有一个人在跟你说话时不引。私聊一般不引，除非你要连发好几条、需要点明在回应哪句。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数）。群聊里推荐主动填：挑你真正在回的那一条引用上'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('顺便 @ 某个人（群成员 QQ 号，正整数）。@ 是点名不是标点：只在他很久没理你、你回的是很早的一条怕他没看见、或你专门找某个人说话时用；一条消息最多 @ 一个人，别每条都挂'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_poke',
  '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
  },
  async ({ key, token, targetUserId }) => {
    try {
      const data = await agentApi('/api/socialV2/send-poke', {
        method: 'POST',
        body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `拍一拍失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_repeat_message',
  '群聊「+1」：把本会话里某条**别人**的消息**原样**再发一遍（复读，不引用、不 @、不改一个字）。用在：有人发节日祝福（"中秋快乐""新年快乐"）、群里在刷同一个梗/接龙、或者遇到一个不好回又有意思的梗——跟着复读一遍就是最像真人的回应，比硬答一句强。不要手打原文（一定会变形），直接传消息的 messageId 或本地 seq；桥接会把原文取出来发出去，所以你不需要（也不应该）自己抄。只在群聊可用；私聊没有"+1"这回事。节制使用：同一话题最多跟一次，已经有好几个人 +1 了就别再加，正事/吵架/有人难受时不跟。一小时有次数上限，超了会返回 429。',
  {
    key: z.string().describe('会话 key，格式 group:群号（只支持群聊）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要复读的那条消息：用 qq_get_recent_messages / qq_get_unread_messages 返回的 messageId 或本地 seq 都可以')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/socialV2/repeat-message', {
        method: 'POST',
        body: JSON.stringify({ key, messageId: messageId != null ? String(messageId) : '' }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `+1 失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你**在群里亲眼见过、而且反复出现过**的陌生词/黑话/梗提交给管理员筛选。注意（主人交代过的硬要求）：只提交**群聊**里出现过的词，而且至少在不同消息里出现过 2 次以上（黑话提取时会给一份`本地词频统计`，以它为准）；只在主人私聊里出现的梗、主人顺口教你的一句、或你自己觉得好玩的词都**不算群黑话，不要提交**。提交后进入候选库（状态 candidate），管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆；桥接会用群聊窗口复核这个词的出现次数，太少会在返回里给一句 warning（不拦截，但别当耳旁风）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
server.tool(
  'qq_get_message_images',
  '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
  },
  async ({ key, messageId, token }) => {
    try {
      const q = new URLSearchParams({ key, messageId: String(messageId) });
      const data = await agentApi(`/api/images/message?${q.toString()}`, {
        headers: token ? { 'x-agent-token': token } : {},
        timeoutMs: 180000
      });
      const images = Array.isArray(data?.images) ? data.images : [];
      if (!images.length) {
        return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
      }
      const content = [];
      const textParts = [];
      for (const img of images) {
        if (img?.data && img?.mimeType) {
          textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
          content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
        } else {
          textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
        }
      }
      if (textParts.length) {
        content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
      }
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取图片失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 「听」语音转写工具（二代仿真模式） ────────────────────────────────────
server.tool(
  'qq_listen_voice',
  '把一条 QQ 语音消息转成文字（用 QQ 客户端自带的语音转文字）。收到的语音桥接已经自动尝试转过一次，所以一般不用调；只有当你看到消息文本里写着「拿不到 QQ 转写」，或者想重听某条更早的语音时，用这个工具按 messageId / 本地 seq 补取。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('要转写的语音消息 id（来自 qq_get_unread_messages / qq_get_recent_messages，也可用本地 seq）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
  },
  async ({ key, messageId, token }) => {
    try {
      const q = new URLSearchParams({ key, messageId: String(messageId) });
      const data = await agentApi(`/api/voice/transcript?${q.toString()}`, {
        headers: token ? { 'x-agent-token': token } : {},
        timeoutMs: 60000
      });
      const text = String(data?.text ?? '').trim();
      if (!text) {
        return { content: [{ type: 'text', text: `没能拿到消息 ${messageId} 的语音转写：${data?.note || '网关没有返回文字'}` }] };
      }
      return { content: [{ type: 'text', text: `消息 ${messageId}（${data?.sender || '未知'}）的语音内容是：\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `语音转写失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
server.tool(
  'qq_list_stickers',
  '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
    count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
    refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
  },
  async ({ key, token, query, count, refresh }) => {
    try {
      // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
      // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
      // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
      const data = await agentApi('/api/socialV2/sticker-list', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取表情列表失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_sticker_image',
  '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
  },
  async ({ key, token, stickerId }) => {
    try {
      const q = new URLSearchParams({ key, stickerId: String(stickerId) });
      const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
      if (!data?.image?.data || !data?.image?.mimeType) {
        return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
      }
      const content = [
        { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
        { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
      ];
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取表情图片失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_sticker',
  '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('顺便 @ 某个人（群成员 QQ 号，正整数）。@ 是点名不是标点，一条消息最多 @ 一个人；私聊不可用')
  },
  async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
    try {
      const data = await agentApi('/api/socialV2/send-sticker', {
        method: 'POST',
        body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送表情失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_collect_sticker',
  '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
    remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
  },
  async ({ key, token, messageId, remark }) => {
    try {
      const data = await agentApi('/api/socialV2/collect-sticker', {
        method: 'POST',
        body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `收藏表情失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_voice',
  '在指定会话发一条 QQ 语音。两种用法二选一：① 【开口说话·最常用】传 text：桥接用免费 edge TTS 现场把你写的这句话合成语音条（可选 ttsVoice 换音色，默认晓伊女声；太长会被截断，上限见 qq_list_voices 的 tts.maxChars）；② 传 voice：把语音库（qq-bridge/audio/）里准备好的音频当语音条发出去，voice 用 qq_list_voices 返回的 name（可带子目录/可省略扩展名）。注意：① 只能发语音库里的文件（TTS 产物本身就落在语音库内），不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用——闲聊里偶尔发一条，平时还是打字（人设里对语音有更细的规矩）；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().optional().describe('要说的话：桥接现场用 edge TTS 合成成语音条（推荐用法，与 voice 二选一）'),
    voice: z.string().optional().describe('或：语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）；与 text 二选一'),
    ttsVoice: z.string().optional().describe('可选：TTS 音色（ShortName 或中文别名，如 晓伊/东北话），默认用配置里的音色'),
    label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
    verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
    readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
  },
  async ({ key, token, text, voice, ttsVoice, label, verify, readback }) => {
    try {
      const data = await agentApi('/api/socialV2/send-voice', {
        method: 'POST',
        body: JSON.stringify({
          key,
          text: text ? String(text) : '',
          voice: voice ? String(voice) : '',
          ttsVoice: ttsVoice ? String(ttsVoice) : '',
          label: label || '',
          verify: verify !== false,
          readback: readback === true,
          token
        }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送语音失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_voices',
  '查看发语音的能力：① tts（文字转语音，免费 edge TTS）：能用哪些音色、默认音色、单条字数上限 —— 想说话就用 qq_send_voice 传 text；② 语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小，想发这些就传 voice=返回的 name。返回里的 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音（想说话就走 tts）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
  },
  async ({ key, token, probe }) => {
    try {
      const q = new URLSearchParams({ key });
      if (probe === false) q.set('probe', '0');
      const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取语音库失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_image',
  '在指定会话发一张图片（可附一句话）。图片只能来自两个地方：① 图片库（qq-bridge 的 media/images/ 目录）：传 file=库内文件名，可带子目录、可省略扩展名；② 公网图片 URL：传 url，桥接会自己带 SSRF 校验去抓（限制字节数，且必须真的是 PNG/JPEG/GIF/WebP），内网/本机地址一律拒绝。'
  + '硬边界：不能发任意本地路径（库外文件一律拒绝，包括看得到的绝对路径）、不能发 base64/data: 串、不能发 QQ 群文件（网关不支持文件上传）。'
  + 'text 是随图说明，会和图片放在同一条消息里（文字在前），最长 500 字；想说更多就分开用 qq_send_message 发。'
  + '传 dryRun=true 时只校验不发送，返回 {ok, file, bytes, detail} —— 不确定这张图能不能发（太大/不是图片/库外）时先用它探一下，不要硬发。'
  + '受频率上限约束（默认每分钟 2 张、每小时 10 张），超限会被拒。图片发出去无法撤回，且群聊内容不可信：只在真的需要配图时才发，别刷图、别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    file: z.string().optional().describe('图片库（qq-bridge/media/images/）里的文件名，可带子目录、可省略扩展名；与 url 二选一'),
    url: z.string().optional().describe('公网图片 http(s) URL（桥接会自己抓取并校验大小与格式；内网地址会被拒）；与 file 二选一'),
    text: z.string().optional().describe('可选：随图说一句（会和图片同一条消息，文字在前，最长 500 字）'),
    dryRun: z.boolean().optional().describe('只校验不发送（默认 false）。返回 file/bytes/detail，用于确认能不能发')
  },
  async ({ key, token, file, url, text, dryRun }) => {
    try {
      const data = await agentApi('/api/socialV2/send-image', {
        method: 'POST',
        body: JSON.stringify({
          key,
          file: file ? String(file) : '',
          url: url ? String(url) : '',
          text: text ? String(text) : '',
          dryRun: dryRun === true,
          token
        }),
        headers: { 'x-agent-token': token },
        // URL 来源要在桥接里下载 + 校验（最大 5MB），给足预算。
        timeoutMs: 180000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送图片失败：${errorText(error)}` }], isError: true };
    }
  }
);

// 自省工具。它与 qq_social_state 的分工：state 讲「这个会话的社交现场」（未读、唤醒配置、
// 上次发言），status 讲「**我自己**现在是什么状态」—— 在哪个模式、用的哪个模型、今天花了
// 多少钱、缓存命中率、还能被唤醒几次、有没有在等消息、有没有挂着的提醒。
// 它是纯读的：不发消息、不写状态、不占发送额度。
server.tool(
  'qq_bridge_status',
  '查看**你自己此刻的运行状态**（只读，不发任何消息）：当前模式与角色、用的模型/provider、今天的花费与缓存命中率、唤醒额度还剩多少、是否正在等对方消息、挂了几条提醒、SnowLuma 网关是否健康，最后给出「建议」段。'
  + '用它来回答"你现在什么状态/今天花了多少/缓存怎么样/还能不能撑住"这类问题，而不是凭印象编。'
  + '注意两点：① 花费是 best-effort——拿不到账本时会**整段省略**，不要把它当成"没花钱"；② 缓存命中率低不一定是你写错了提示词，也可能是 provider 侧缓存策略（若 provider 不在 qodercn/deepseek 之列，会给出 provider-not-cache-friendly 告警）。'
  + '返回 text（可直接念给人的中文摘要，≤1200 字）+ data（结构化字段，供你自己判断）。'
  + '只能看**本会话自己**的状态；想看别的会话请用别的会话的令牌。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      // 只把 key 放查询串：最外层全局鉴权会优先读 `?token=`（当成控制台令牌），
      // 会话令牌一旦进查询串就会被 401 拦掉 —— 令牌一律只走 x-agent-token 头。
      const q = new URLSearchParams({ key });
      const data = await agentApi(`/api/socialV2/self-status?${q.toString()}`, {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查看状态失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_music',
  '在指定会话发一张**音乐卡片**。二选一：'
  + '① 平台卡：type 写平台名（qq / 163 / kugou / kuwo / migu / bilibili）+ id（平台上的歌曲/歌单 id，字符串）。'
  + '② 自定义卡：type 写 custom，并同时给 url（点击卡片跳去哪）、audio（音频直链 http(s)）、title（卡片标题，≤60 字）；可选 image（封面）、singer（歌手，会写进卡片说明）。'
  + 'text 是随卡说的一句话（会和卡片同一条消息）。'
  + '传 dryRun=true 只校验不发送，返回 {ok,dryRun,kind,thirdPartySign,detail} —— 平台卡能不能发、会不会被限流，先用它探一下。'
  + '**重要**：平台卡要经 SnowLuma 侧的 musicSignUrl（默认 https://ss.xingzhige.com/music_card/card）第三方签名服务换取卡片，也就是点歌这件事会把歌曲 id 交给第三方；不想有任何第三方参与就用 type:"custom" 自己给直链。'
  + '受频率上限约束（默认每分钟 2 张、每小时 10 张），超限返回 429。卡片发出去无法撤回，别刷卡片。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    type: z.string().describe('平台名（qq/163/kugou/kuwo/migu/bilibili）或 custom'),
    id: z.string().optional().describe('平台卡必填：平台上的歌曲/歌单 id'),
    url: z.string().optional().describe('自定义卡必填：卡片跳转链接（http(s)）'),
    audio: z.string().optional().describe('自定义卡必填：音频直链（http(s)）'),
    title: z.string().optional().describe('自定义卡必填：卡片标题（≤60 字）'),
    image: z.string().optional().describe('自定义卡可选：封面图 http(s) 链接'),
    singer: z.string().optional().describe('自定义卡可选：歌手（写进卡片说明）'),
    text: z.string().optional().describe('可选：随卡说一句（与卡片同一条消息）'),
    dryRun: z.boolean().optional().describe('只校验不发送（默认 false）')
  },
  async ({ key, token, type, id, url, audio, title, image, singer, text, dryRun }) => {
    try {
      const data = await agentApi('/api/socialV2/send-music', {
        method: 'POST',
        body: JSON.stringify({
          key,
          token,
          type: String(type ?? ''),
          ...(id === undefined ? {} : { id: String(id) }),
          ...(url === undefined ? {} : { url: String(url) }),
          ...(audio === undefined ? {} : { audio: String(audio) }),
          ...(title === undefined ? {} : { title: String(title) }),
          ...(image === undefined ? {} : { image: String(image) }),
          ...(singer === undefined ? {} : { singer: String(singer) }),
          ...(text === undefined ? {} : { text: String(text) }),
          dryRun: dryRun === true
        }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送音乐卡片失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 群管理（默认关闭）───────────────────────────────────────────────────
//
// 为什么单独一个工具而不是塞进 qq_send_message：这些动作**作用在别人身上**（禁言、踢人、
// 处理进群申请），发出去就撤不回，跟"说一句话"不是一个量级。所以它有自己的开关
// （socialV2.tools.groupAdmin，默认 false）和一条独立的审批通道。
//
// 它只映射 SnowLuma 真 support 的 6 个 action（见 src/group-admin.js 的 GROUP_ADMIN_ACTIONS）：
//   kick→set_group_kick、ban/unban→set_group_ban、deleteMsg→delete_msg、
//   approveFriend→set_friend_add_request、approveGroup→set_group_add_request。
// **不提供** set_group_card / set_group_leave / set_group_name / set_group_whole_ban /
// get_group_info / get_friend_list —— SnowLuma 客户端不收这些请求，写了也是白写。
//
// allowDangerous 故意**不作为参数暴露**：给了模型就等于给了它自己批高危操作的权力。
// AI 通道只走审批（owner 在私聊里回"通过"才真执行）；操作者通道要走 /api/group-admin。
server.tool(
  'qq_group_admin',
  '在**本会话所在的群**执行一次群管理动作（默认关闭；只能在群会话里用，且只能管自己这个群）。'
  + 'op 取值：deleteMsg（撤回一条消息，需 messageId）、ban（禁言，需 userId + durationSec，**时长由你自己按语境选**，不需要任何人批准）、unban（解除禁言，需 userId）、'
  + 'approveFriend / approveGroup（批准或拒绝一条好友/入群申请，需 flag + approve）。'
  + 'dryRun=true 只校验不执行，返回 {ok,dryRun,op,action,params,risk,summary}，用它先确认参数对不对。'
  + '两条硬规矩：① **kick（移出群）是高危操作**，AI 调它只会得到"需要审批"——真正的执行要等管理员在私聊里回"通过"，所以别把"已提交审批"说成"已经踢了"；'
  + '② **ban 你可以自主决定**（不用先问管理员、也不用带 confirm），时长 1 秒 ~ 2592000 秒（30 天），到点用 unban 解除；禁言是能撤回的轻措施，但别拿它当常规手段——先说过、再考虑禁言，且选一个与行为相称的时长（吵两句就几十秒~几分钟，刷屏/发广告才用小时级）。'
  + 'flag 不能猜：先用 qq_list_requests 取（它同时列出挂起中的审批）。'
  + '返回里的 summary 是给人看的一句话，action 是实际发往网关的动作名。',
  {
    key: z.string().describe('会话 key，格式 group:群号（群管理只在群会话里可用）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    op: z.enum(['kick', 'ban', 'unban', 'deleteMsg', 'approveFriend', 'approveGroup']).describe('要执行的动作'),
    userId: z.string().optional().describe('kick / ban / unban 必填：目标群成员 QQ 号'),
    durationSec: z.number().optional().describe('ban 必填：禁言秒数（正整数，≤2592000 = 30 天）'),
    messageId: z.union([z.number(), z.string()]).optional().describe('deleteMsg 必填：要撤回的消息 id（可用你收到的那条消息的 messageId，可为负）'),
    flag: z.string().optional().describe('approveFriend / approveGroup 必填：申请事件里的 flag，用 qq_list_requests 取，必须原样回传'),
    approve: z.boolean().optional().describe('approveFriend / approveGroup 必填：true=批准，false=拒绝'),
    subType: z.enum(['add', 'invite']).optional().describe('approveGroup 可选：add（主动申请）或 invite（被邀请），默认 add'),
    remark: z.string().optional().describe('approveFriend 可选：给好友加的备注（≤30 字）'),
    reason: z.string().optional().describe('approveGroup / 拒绝时可选：理由（≤60 字）'),
    confirm: z.boolean().optional().describe('ban 必填：显式确认这次禁言（没有它会被拒）'),
    dryRun: z.boolean().optional().describe('只校验不执行（默认 false）')
  },
  async ({ key, token, op, userId, durationSec, messageId, flag, approve, subType, remark, reason, confirm, dryRun }) => {
    try {
      const data = await agentApi('/api/socialV2/group-admin', {
        method: 'POST',
        body: JSON.stringify({
          key,
          token,
          op: String(op ?? ''),
          ...(userId === undefined ? {} : { userId: String(userId) }),
          ...(durationSec === undefined ? {} : { durationSec: Number(durationSec) }),
          ...(messageId === undefined ? {} : { messageId: String(messageId) }),
          ...(flag === undefined ? {} : { flag: String(flag) }),
          ...(approve === undefined ? {} : { approve: approve === true }),
          ...(subType === undefined ? {} : { subType: String(subType) }),
          ...(remark === undefined ? {} : { remark: String(remark) }),
          ...(reason === undefined ? {} : { reason: String(reason) }),
          ...(confirm === undefined ? {} : { confirm: confirm === true }),
          dryRun: dryRun === true
        }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      // "需要审批"不是失败：把它说清楚，免得模型当成"操作被拒"而去重试或向群里道歉。
      const msg = String(errorText(error));
      const hint = /审批|放行|allowDangerous|needApproval/.test(msg)
        ? '（这是**正常的审批流**：已提交给管理员，等他在私聊回「通过」才真的执行；不要重复调用。）'
        : '';
      return { content: [{ type: 'text', text: `群管理动作未执行：${msg}${hint}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_requests',
  '列出本会话**待处理的好友申请 / 入群申请**，同时列出**挂起中的群管理审批**（你发过但还没被管理员批准的高危动作，比如踢人）。'
  + '只读，不发消息、不改状态。'
  + '为什么要用它：approveFriend / approveGroup 需要申请事件里的 flag，这个 flag 只能从这里拿到（猜不出来）——拿到后原样传给 qq_group_admin。'
  + '返回 requests（含 flag/type/subType/userId/comment/at）、requestsCount、approvals、approvalsCount。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const q = new URLSearchParams({ key });
      const data = await agentApi(`/api/socialV2/group-requests?${q.toString()}`, {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查看待处理申请失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_reminder',
  '设一个「到点提醒」：到时间后桥接会把你唤醒一次，并在提示词里告诉你该提醒什么，你再用自己的语气说出来（像人自己想起来，不是闹钟播报）。'
  + '时间二选一：afterMs（从现在起多少毫秒后，≥1000）或 dueAt（毫秒时间戳，或 ISO 字符串如 2026-05-01T08:30:00+08:00）。'
  + 'repeat 可选 none（默认）/ daily / weekly。text 最长 200 字；每个会话最多同时挂 50 条，最多排到 90 天以内。'
  + '注意：它是「到点叫你来说」，不是静音闹钟——如果你到点后判定不该打扰，也可以只用一句很轻的话带过或安静收尾。设错了用 qq_list_reminders 查 id 再取消。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('要提醒的事，1~200 字（只能是当前会话自己的事，别的会话收不到）'),
    afterMs: z.number().optional().describe('从现在起多少毫秒后提醒（≥1000）；与 dueAt 二选一'),
    dueAt: z.union([z.number(), z.string()]).optional().describe('绝对时间：毫秒时间戳，或 ISO 字符串（如 2026-05-01T08:30:00+08:00）；与 afterMs 二选一'),
    repeat: z.enum(['none', 'daily', 'weekly']).optional().describe('重复方式，默认 none（只提醒一次）')
  },
  async ({ key, token, text, afterMs, dueAt, repeat }) => {
    try {
      const data = await agentApi('/api/socialV2/reminders', {
        method: 'POST',
        body: JSON.stringify({
          key,
          token,
          action: 'add',
          text: String(text ?? ''),
          afterMs,
          dueAt,
          repeat: repeat ? String(repeat) : 'none'
        }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置提醒失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_reminders',
  '查看当前会话还没触发的提醒（含 id、内容、到点时间 dueText、还有多久 inText），也可以顺手取消：传 cancelId 取消某一条，传 cancelAll=true 清空本会话的全部提醒。'
  + '只能看到/操作本会话（你手上这个 key）的提醒。取消 id 从本工具的返回里取。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    cancelId: z.string().optional().describe('可选：取消这一条提醒（id 来自本工具返回）'),
    cancelAll: z.boolean().optional().describe('可选：清空本会话的全部提醒（默认 false）')
  },
  async ({ key, token, cancelId, cancelAll }) => {
    try {
      if (cancelAll === true || (cancelId && String(cancelId).trim())) {
        const data = await agentApi('/api/socialV2/reminders', {
          method: 'POST',
          body: JSON.stringify({
            key,
            token,
            action: cancelAll === true ? 'cancelAll' : 'cancel',
            id: cancelId ? String(cancelId).trim() : undefined
          }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      // 只把 key 放查询串：控制台全局鉴权会优先读 `?token=`（把它当控制台令牌），
      // 若把会话令牌塞进查询串，会在最外层被 401 拦掉。会话令牌一律只走 x-agent-token 头。
      const q = new URLSearchParams({ key });
      const data = await agentApi(`/api/socialV2/reminders?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查看提醒失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_search_history',
  '在**当前这个会话**的历史归档里检索片段（本会话的收发记录，出站和入站的文字都在；图片/语音只留一条文字描述）。'
  + '只能查本会话历史，拿不到别的群/别人的会话；返回的是**命中片段（snippet）而不是完整对话**，一条命中只保证那一小段相关，别当成原话引用。'
  + 'query 必填、≤100 字；多个词用空格分隔表示「都要出现」（AND）。可选 sinceMs / untilMs（毫秒）限制时间范围，limit ≤50（默认 20）。'
  + '返回里的 scanned 是本次实际检查的行数，truncated=true 表示这次检索被体积/时间上限截断、结果可能不全。'
  + '不确定「上次谁说过什么/这件事多久以前提过」时用它；想读完整上下文还是用 qq_get_recent_messages / qq_get_unread_messages。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('检索词，≤100 字；多个词用空格分隔表示 AND'),
    sinceMs: z.number().optional().describe('可选：只看这个毫秒时间戳之后的消息'),
    untilMs: z.number().optional().describe('可选：只看这个毫秒时间戳之前的消息'),
    limit: z.number().optional().describe('可选：最多返回多少条命中（1~50，默认 20）')
  },
  async ({ key, token, query, sinceMs, untilMs, limit }) => {
    try {
      const data = await agentApi('/api/socialV2/history/search', {
        method: 'POST',
        body: JSON.stringify({
          key,
          token,
          query: String(query ?? ''),
          sinceMs,
          untilMs,
          limit
        }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `检索历史失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_self_image',
  '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const q = new URLSearchParams({ key });
      const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
      if (!data?.image?.data || !data?.image?.mimeType) {
        return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
      }
      return {
        content: [
          { type: 'text', text: '这是你的默认 Q 版形象：' },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取形象图片失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_sticker_note',
  '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
    note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
    tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
    usage: z.string().optional().describe('可选用法说明，最多 200 字')
  },
  async ({ key, token, stickerId, note, tags, usage }) => {
    try {
      const payload = { key, stickerId: String(stickerId) };
      if (note !== undefined && note !== null) payload.note = String(note);
      if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
      if (usage !== undefined && usage !== null) payload.usage = String(usage);
      const data = await agentApi('/api/socialV2/sticker-note', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记录表情备注失败：${errorText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_sticker_remark',
  '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
    remark: z.string().describe('新的表情备注，最多 50 字')
  },
  async ({ key, token, stickerId, remark }) => {
    try {
      const data = await agentApi('/api/socialV2/sticker-remark', {
        method: 'POST',
        body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `修改表情备注失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
server.tool(
  'qq_get_forward_msg',
  '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
  },
  async ({ key, token, id }) => {
    try {
      const q = new URLSearchParams({ key, id: String(id) });
      const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
        headers: { 'x-agent-token': token },
        timeoutMs: 120000
      });
      const content = [{ type: 'text', text: serializeModelData(data) }];
      // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
      const images = [];
      const seen = new Set();
      const collectMedia = (msgs) => {
        if (!Array.isArray(msgs)) return;
        for (const m of msgs) {
          if (!m || typeof m !== 'object') continue;
          for (const media of Array.isArray(m.media) ? m.media : []) {
            if (!media || typeof media !== 'object') continue;
            const keyId = media.url || media.file || media.faceId || '';
            if (!keyId || seen.has(keyId)) continue;
            seen.add(keyId);
            images.push(media);
          }
        }
      };
      collectMedia(data?.messages);
      if (Array.isArray(data?.nestedPreviews)) {
        for (const np of data.nestedPreviews) collectMedia(np?.messages);
      }
      const MAX_IMAGES = 5;
      const imageTexts = [];
      if (images.length) {
        try {
          const mediaRes = await agentApi('/api/socialV2/forward-media', {
            method: 'POST',
            body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
            headers: { 'x-agent-token': token },
            timeoutMs: 180000
          });
          const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
          for (const img of mediaImages) {
            if (img?.data && img?.mimeType) {
              content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
              imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
            } else {
              imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
            }
          }
        } catch (error) {
          imageTexts.push(`[转发内图片（批量获取失败：${errorText(error)}）]`);
        }
      }
      if (imageTexts.length) {
        content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
      }
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `查看合并转发失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 看视频（B 站）─────────────────────────────────────────────────────────
const expandShortLink = async (input) => {
  const s = String(input ?? '').trim();
  if (!/^https?:\/\/b23\.tv\/\S+/i.test(s)) return s;
  try {
    const res = await fetch(s, {
      redirect: 'follow',
      // 短链服务慢/挂着不能把整轮工具调用拖死：和 agentApi 一样给硬超时。
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }
    });
    return res.url || s;
  } catch {
    return s;
  }
};

server.tool(
  'qq_watch_video',
  '“看”一个视频（B 站）：给 BV 号、av 号、b23.tv 短链或完整链接，返回标题、UP、时长、简介、弹幕高频词与字幕节选，并把视频关键帧作为图片一起返回——你可以真的看到画面内容。默认会把全片（含片头片尾）均匀采样后**拼成一张联系表**给你，所以你是"从头到尾扫了一遍"，不是只看开头。当群里有人发了 BV 号/视频链接、或聊到某个视频时，先看再说，别凭空猜内容。',
  {
    url: z.string().describe('BV 号（如 BV1GJ411x7h7）、av 号、b23.tv 短链或 B 站视频链接'),
    frames: z.number().optional().describe('采样几个时间点，默认 8，最多 24（越多越能看全片；默认拼成一张图，所以加量几乎不加成本）'),
    layout: z.enum(['sheet', 'list']).optional().describe('sheet=拼成一张联系表（默认，覆盖全片且只占一份图像成本）；list=逐张返回（每张更清楚，但很费额度）')
  },
  async ({ url, frames, layout }) => {
    try {
      // 第二道闸门（与桥接其它工具一致的做法）：调用期现读配置再判一次。
      //
      // 为什么注册期那道不够：MCP 侧的热开关只保证「config.json 一变就同步清单」，
      // 但它**读的是自己进程里的那份盘**。配置被手改、或同步恰好还没跑完时，
      // 模型手上可能还留着这个工具；没有这道校验，它就会真的打出去。
      // 注意用 getConfig()（每次现读）而不是启动快照。
      if (getConfig()?.socialV2?.tools?.watchVideo === false) {
        return { content: [{ type: 'text', text: '工具未启用：qq_watch_video' }], isError: true };
      }
      const target = await expandShortLink(url);
      const result = await watchVideo(target, {
        frames: Math.max(1, Math.min(24, Number(frames) || 8)),
        layout: layout === 'list' ? 'list' : 'sheet',
        outDir: path.join(ROOT, 'state', 'videos')
      });
      if (!result.ok) {
        return { content: [{ type: 'text', text: `看视频失败：${result.error}` }], isError: true };
      }
      const content = [{ type: 'text', text: result.report }];
      for (const file of result.frames) {
        try {
          const buf = fs.readFileSync(file);
          if (buf.length > 3_000_000) continue; // 太大就不塞进上下文了
          content.push({ type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') });
        } catch {}
      }
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `看视频失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 「读文件」工具（二代仿真模式） ────────────────────────────────────────
// 群聊/私聊里发的 txt 等文本文件：桥接收消息时只留了文件名 + 下载直链（不下载字节），
// 模型看到「[文件 xxx.txt（可以直接读，用 qq_read_file）]」再按需调这个工具取正文。
server.tool(
  'qq_read_file',
  '读取群聊/私聊里发过的**文本文件**（txt/md/json/csv/log 等）的内容。消息文本里出现「[文件 xxx.txt（可以直接读，用 qq_read_file）]」时就调它；非文本文件（图片/压缩包/音频/视频/二进制）读不了，会明确告诉你。文件很大会只返回前面一段并注明被截断。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('那条文件消息的 id（来自 qq_get_unread_messages / qq_get_recent_messages，也可用本地 seq）'),
    maxChars: z.number().optional().describe('最多读多少字符，默认 20000（超出会截断并注明）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
  },
  async ({ key, messageId, maxChars, token }) => {
    try {
      if (getConfig()?.socialV2?.tools?.readFile === false) {
        return { content: [{ type: 'text', text: '工具未启用：qq_read_file' }], isError: true };
      }
      const q = new URLSearchParams({ key, messageId: String(messageId) });
      if (Number.isFinite(Number(maxChars)) && Number(maxChars) > 0) q.set('maxChars', String(Math.round(Number(maxChars))));
      const data = await agentApi(`/api/files/message?${q.toString()}`, {
        headers: token ? { 'x-agent-token': token } : {},
        timeoutMs: 180000
      });
      const name = String(data?.name ?? '').trim();
      const text = String(data?.text ?? '');
      if (!text) {
        return { content: [{ type: 'text', text: `没能读到文件内容${name ? `（${name}）` : ''}：${data?.note || '未找到文件'}` }] };
      }
      const head = [
        `文件：${name || '(未命名)'}${data?.size ? ` ｜ ${data.size} 字节` : ''}${data?.encoding ? ` ｜ 编码 ${data.encoding}` : ''}`,
        data?.note ? `（${data.note}）` : ''
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: `${head}\n────────\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读文件失败：${errorText(error)}` }], isError: true };
    }
  }
);

// ── 「点开卡片」工具（二代仿真模式） ──────────────────────────────────────
// 群友发的网易云音乐卡 / B 站视频卡 / 其它分享卡。桥接把卡片解析成标题+链接存着，
// 这里负责真正"点开"：音乐取歌名/歌手/专辑/歌词，B 站视频走 watchVideo（带画面）。
server.tool(
  'qq_open_card',
  '点开群友分享的卡片（网易云音乐 / B 站视频 / 图文链接等），把里面的**实际内容**取出来——音乐会给歌名/歌手/专辑/歌词，B 站视频会给标题/简介/弹幕/关键帧画面。当消息文本里出现「[卡片·…]」或「[卡片消息]」时用它，别只念标题。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('那条卡片消息的 id（来自 qq_get_unread_messages / qq_get_recent_messages，也可用本地 seq）'),
    frames: z.number().optional().describe('B 站视频采样几个时间点，默认 8，最多 24（默认拼成一张联系表，加量几乎不加成本）'),
    layout: z.enum(['sheet', 'list']).optional().describe('sheet=拼成一张联系表（默认）；list=逐张返回（更清楚但很费额度）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
  },
  async ({ key, messageId, frames, layout, token }) => {
    try {
      if (getConfig()?.socialV2?.tools?.openCard === false) {
        return { content: [{ type: 'text', text: '工具未启用：qq_open_card' }], isError: true };
      }
      const q = new URLSearchParams({ key, messageId: String(messageId) });
      const data = await agentApi(`/api/cards/message?${q.toString()}`, {
        headers: token ? { 'x-agent-token': token } : {},
        timeoutMs: 60000
      });
      const card = data?.card ?? null;
      if (!card) {
        return { content: [{ type: 'text', text: `没能点开这张卡片：${data?.note || '这条消息里没有卡片'}` }] };
      }
      const result = await openCard(card, {
        frames: Math.max(1, Math.min(24, Number(frames) || 8)),
        layout: layout === 'list' ? 'list' : 'sheet',
        outDir: path.join(ROOT, 'state', 'videos')
      });
      const content = [{ type: 'text', text: result.report || `【卡片】${card.title || ''}` }];
      for (const file of result.frames ?? []) {
        try {
          const buf = fs.readFileSync(file);
          if (buf.length > 3_000_000) continue;
          content.push({ type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') });
        } catch {}
      }
      if (!result.ok) content.push({ type: 'text', text: `（点开时出错：${result.error}）` });
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `点开卡片失败：${errorText(error)}` }], isError: true };
    }
  }
);

// 所有 server.tool(...) 都已执行完，句柄表此刻才是完整的。
//
// 关键顺序（曾经写错会静默失效）：**先 applyToolStates() 再 connect()**。
// SDK 的 disable()/enable() 内部会调 sendToolListChanged()，而它开头是
// `if (this.isConnected())` —— 没连上时通知发不出去。所以：
//   1. connect 之前先把初始状态折算好（此刻的 disable 只为定状态，通知丢了无所谓，
//      因为客户端本来就是连上后先 tools/list 一次）；
//   2. connect 之后再折算一遍并发通知 —— 覆盖"第一条 tools/list 已经发出、config 却
//      在这期间变了"的窄窗口；
//   3. 之后靠 fs.watch + 轮询持续同步。
applyToolStates({ reason: '启动时按活配置折算' });
writeRegisteredToolsSnapshot();
// 心跳：控制台要靠这份快照判断「注册清单是不是活的」。
// 只靠 PID 存活判断有个坑 —— PID 会被系统回收，一个恰好复用了旧号的新进程会让
// 一份过期清单看起来仍然有效。所以定期重写，控制台再用 at 的年龄兜底。
//
// 外面套 try/catch 是有意的：心跳只是给控制台看的观测数据，**绝不能**因为拿不到定时器
// 就把整个 MCP server 拖崩（那等于她所有 QQ 工具一起消失）。真崩了也只是快照变旧、
// 控制台显示"注册状态未知"，属安全降级。unref() 保证它不阻止进程退出。
try {
  setInterval(writeRegisteredToolsSnapshot, 60_000).unref();
} catch {}

await server.connect(new StdioServerTransport());

// 连上之后立刻再折算一遍：把"注册期到 connect 之间"的配置变化补发一次通知。
applyToolStates({ reason: '连接就绪' });

// config.json 变化 → 当场同步工具开关（真·热生效，不用重启 MCP、更不用重启 DSH）。
//
// fs.watch 的具体行为在 Windows 上依赖保存方式（桥接是原子的 tmp+rename，能收到 rename），
// 所以**不能只靠它**：下面两条一起上 ——
//   · watch：正常情况毫秒级响应
//   · 轮询（5 秒）：watch 丢事件时的兜底，最多晚 5 秒
// 两条都只做「读 mtime → 变了就折算」，代价可以忽略。
try {
  fs.watch(configPath(), { persistent: false }, () => {
    scheduleToolStateSync('config.json 变化（watch）');
  });
} catch (error) {
  console.error(`[mcp-snowluma-safe] 监听 config.json 失败（退化为轮询）：${errorText(error)}`);
}
try {
  pollConfigChange(); // 先记一次基准 mtime，免得刚启动就误判成"变化"
  setInterval(pollConfigChange, 5_000).unref();
} catch {}
