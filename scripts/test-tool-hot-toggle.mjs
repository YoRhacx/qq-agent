// 工具开关「真·热生效」端到端自检。
//
// 这个自检专门钉住一个以前做不到、而且做错了看不出来的行为：
//
//   改 config.json 里的工具开关 → **不重起 MCP 进程、不重起 DSH、不新建会话**，
//   模型那边的工具清单当场就变（关掉的消失、打开的回来）。
//
// 为什么必须端到端测：这件事横跨四个组件，任何一层断了症状都一样（"看起来没生效"）——
//   ① MCP server 启动时按活配置折算 enable/disable
//   ② SDK 的 tools/list 只列 enabled 的工具，且 disable()/enable() 会发 list_changed 通知
//   ③ MCP 客户端（DSH 用的也是这个）订阅了 list_changed 并重新拉清单
//   ④ 文件变更真的能被 server 收到（fs.watch + 轮询兜底）
// 前三条用纯函数测不了，第四条更是只有起真进程才谈得上。
//
// 所以这里用**真 stdio 子进程 + 真 MCP Client**（与 scripts/test-mcp-servers-stdio.mjs 同路子），
// 只把 config.json 和 state/ 换成临时目录里的一份 fixture，绝不碰用户那份真配置。
//
// ── 怎么把 server 的 ROOT 挪到临时目录（踩过的坑，别改成别的写法）─────────────
// server 里 ROOT = 自己所在文件目录的上一级，state/ 也跟着 ROOT。
//   · 不能用环境变量只覆盖 config 路径：那样 ROOT 还是真仓库，注册快照会被写进真 state/，
//     污染控制台的「工具注册对账」，自检反而制造了新的不一致。
//   · 不能靠复制 src/：会把 1.4MB 源码抄一份，还得同步 node_modules。
// 用的是 **Junction（Windows 目录联接）+ node --preserve-symlinks-main**：
// 临时目录里放 `src` 与 `node_modules` 两个指向真仓库的 Junction，再启动
// `<fixture>/src/mcp-snowluma-safe.js`。`--preserve-symlinks-main` 让**入口脚本**的
// `import.meta.url` 停在 fixture 路径上（实测：不加它 dirname 会被解析回真仓库），
// ROOT 于是落在 fixture，state/ 也跟着走；源码仍是同一份。
//
// ⚠️ 只加 `--preserve-symlinks-main`，**不要**再加 `--preserve-symlinks`：
// 后者会让 node_modules 里的包也保留联接路径，而 pnpm 的依赖是**平铺在同级**
// （sdk 在 `node_modules/.pnpm/@modelcontextprotocol+sdk@1.32.1_zod@4.6.5/node_modules/`，
// 它要的 `zod-to-json-schema` 在上一层），路径一"保留"就找不到了，实测报
// `ERR_MODULE_NOT_FOUND: Cannot find package 'zod-to-json-schema'`。
// 保留入口、放开其它，两边都对。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed += 1; console.log(`  ✅ ${label}`); }
  else { failed += 1; console.log(`  ❌ ${label}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 临时 fixture 根目录：只放 config.json + state/，src 与 node_modules 用 Junction 指回真仓库。 */
function createFixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-hot-tools-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'src'), path.join(dir, 'src'), 'junction');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

/** 写 config.json。用 tmp + rename，与桥接保存配置的方式一致（也顺带测 rename 能不能触发 watch）。 */
function writeFixtureConfig(dir, config) {
  const target = path.join(dir, 'config.json');
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

/** 等到 predicate 成立或超时，返回是否成功（用于等异步的 list_changed 生效）。 */
async function waitFor(predicate, { timeoutMs = 8000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

/**
 * 起一个 fixture MCP server + 客户端。
 * listChanged 的写法**照抄 DSH**（dsh-mcp-client：autoRefresh:false + 自己接 onChanged），
 * 这样它同时验证了「通知确实发出去了」和「客户端按通知重新拉清单能拿到新结果」。
 */
async function startFixtureServer(dir) {
  const transport = new StdioClientTransport({
    command: NODE,
    // --preserve-symlinks-main: 让**入口脚本**的 import.meta.url 停在 fixture 路径，
    // 于是 server 里的 ROOT = fixture（state/ 也跟着走），而 src 内部与 node_modules
    // 仍按真实路径解析 —— node_modules 必须按真路径走，否则 pnpm 的平铺依赖找不到
    // （见文件头 ERR_MODULE_NOT_FOUND 那段）。
    args: ['--preserve-symlinks-main', path.join(dir, 'src', 'mcp-snowluma-safe.js')],
    cwd: dir,
    stderr: 'pipe',
    // SDK 只继承白名单环境变量（DEFAULT_INHERITED_ENV_VARS），不带 ELECTRON_RUN_AS_NODE；
    // 在「用 Electron 当 node」的机器上子进程会启动成 GUI 而瞬间退出（-32000）。
    env: { ...process.env },
  });
  const stderrChunks = [];
  let listChangedCount = 0;
  const client = new Client(
    { name: 'hot-toggle-probe', version: '0.0.0' },
    {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => { listChangedCount += 1; },
        },
      },
    },
  );
  await client.connect(transport);
  const stderr = transport.stderr;
  if (stderr) stderr.on('data', (c) => stderrChunks.push(String(c)));
  return {
    client,
    stderrText: () => stderrChunks.join(''),
    listChanged: () => listChangedCount,
    close: async () => { try { await client.close(); } catch {} },
  };
}

async function toolNames(client) {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

const baseConfig = {
  // ownerQQ / allow 留空即可：本自检只关心工具清单，不真发消息
  allow: { groups: [], private: [] },
  socialV2: {
    enabled: true,
    tools: {},
    media: { enabled: true },
    voice: { enabled: true },
    sticker: { enabled: true },
  },
};

const fixture = createFixtureRoot();
let server = null;
try {
  writeFixtureConfig(fixture, baseConfig);
  server = await startFixtureServer(fixture);

  console.log('\n== 一、基线：工具都在清单里 ==');
  const initial = await toolNames(server.client);
  ok(initial.length > 40, `清单里有 ${initial.length} 个工具（全注册）`);
  ok(initial.includes('qq_send_image'), '基线含 qq_send_image（开关默认开）');
  ok(initial.includes('qq_send_music'), '基线含 qq_send_music');
  ok(initial.includes('qq_send_voice'), '基线含 qq_send_voice（父闸门 voice 默认开）');
  ok(fs.existsSync(path.join(fixture, 'state', `mcp-tools.${process.pid}.json`)) === false,
    'fixture 的 state/ 里没有写入（快照写的是子进程自己的 PID 文件，不污染真目录）');

  console.log('\n== 二、关掉一个开关 ⇒ 当场从清单消失（以前必须重起进程） ==');
  const before = server.listChanged();
  writeFixtureConfig(fixture, {
    ...baseConfig,
    socialV2: { ...baseConfig.socialV2, tools: { sendImage: false } },
  });
  const gone = await waitFor(async () => !(await toolNames(server.client)).includes('qq_send_image'));
  ok(gone, '关掉 sendImage 后 qq_send_image 从清单里消失（未重起进程）');
  const afterOff = await toolNames(server.client);
  ok(afterOff.length === initial.length - 1, `清单数量从 ${initial.length} 变成 ${afterOff.length}`);
  ok(afterOff.includes('qq_send_music'), '相邻的 qq_send_music 不受影响（只动被关的那个）');
  ok(server.listChanged() > before, 'server 发出了 tools/list_changed 通知（客户端收到并重拉）');

  console.log('\n== 三、被关掉的工具调用时报 disabled，而不是 not found ==');
  // 两种失败形态都要认：SDK 可能把 handler 抛的 McpError 作为 JSON-RPC 错误抛出，
  // 也可能折成 {isError:true} 的工具结果。只判一种的话，换个 SDK 版本就会假绿。
  let callError = '';
  let callIsError = false;
  try {
    const result = await server.client.callTool({
      name: 'qq_send_image',
      arguments: { key: 'group:1', url: 'https://x/y.png' },
    });
    callIsError = result?.isError === true;
    callError = (result?.content ?? []).map((c) => c?.text ?? '').join(' ');
  } catch (error) {
    callError = String(error?.message ?? error);
    callIsError = true;
  }
  ok(/disabled/i.test(callError), `调用被关掉的工具报 disabled（实际：${callError.slice(0, 90)}）`);
  ok(!/not found/i.test(callError), '不是 not found —— 工具仍在进程里，只是被禁用（对账靠这个区分）');
  ok(callIsError, '该调用被明确标记为失败，不会被当成"消息已发出"');

  console.log('\n== 四、再打开 ⇒ 当场回来（以前这一步"打开不生效"，只能靠重起） ==');
  const beforeOn = server.listChanged();
  writeFixtureConfig(fixture, baseConfig);
  const back = await waitFor(async () => (await toolNames(server.client)).includes('qq_send_image'));
  ok(back, '重新打开 sendImage 后 qq_send_image 回到清单（未重起进程、未新建会话）');
  ok(server.listChanged() > beforeOn, '打开同样发了 list_changed 通知');

  console.log('\n== 五、父闸门也热了（media / voice / sticker 整体开关） ==');
  writeFixtureConfig(fixture, {
    ...baseConfig,
    socialV2: { ...baseConfig.socialV2, media: { enabled: false } },
  });
  const mediaOff = await waitFor(async () => !(await toolNames(server.client)).includes('qq_send_image'));
  ok(mediaOff, 'media.enabled=false ⇒ qq_send_image 消失（父闸门以前写死在注册期）');
  writeFixtureConfig(fixture, {
    ...baseConfig,
    socialV2: { ...baseConfig.socialV2, voice: { enabled: false }, sticker: { enabled: false } },
  });
  const gateOff = await waitFor(async () => {
    const names = await toolNames(server.client);
    return !names.includes('qq_send_voice') && !names.includes('qq_send_sticker');
  });
  ok(gateOff, 'voice/sticker 父闸门关掉 ⇒ 对应工具一起消失');
  const gateNames = await toolNames(server.client);
  ok(gateNames.includes('qq_send_message'), '跨模式共用的 qq_send_message 不受 v2 父闸门影响（口径不变）');

  console.log('\n== 六、注册快照如实反映"此刻谁开着" ==');
  // 先把配置设成一个**明确**的状态再断言，别依赖上一步的残留：
  // 上一步最后写的是 `{...base.socialV2, voice:false, sticker:false}`，而展开 base 会把
  // media 重新打开（media:{enabled:true}）—— 靠"上一步应该是什么"来断言，是自检里最容易
  // 悄悄假绿的地方。这里显式重写一份：只关 sendImage、父闸门全开。
  writeFixtureConfig(fixture, {
    ...baseConfig,
    socialV2: { ...baseConfig.socialV2, tools: { sendImage: false } },
  });
  const snapshotDir = path.join(fixture, 'state');
  const readSnapshot = () => {
    const files = fs.readdirSync(snapshotDir).filter((f) => /^mcp-tools\.\d+\.json$/.test(f));
    if (files.length !== 1) return null;
    try { return JSON.parse(fs.readFileSync(path.join(snapshotDir, files[0]), 'utf8')); } catch { return null; }
  };
  const snapOk = await waitFor(() => {
    const s = readSnapshot();
    return Boolean(s) && s.disabled.includes('qq_send_image(sendImage)');
  });
  const snapFiles = fs.readdirSync(snapshotDir).filter((f) => /^mcp-tools\.\d+\.json$/.test(f));
  ok(snapFiles.length === 1, `fixture state/ 里始终只有 1 份注册快照（实际 ${snapFiles.length}）`);
  ok(snapOk, '快照在配置变化后跟着更新，disabled 里出现 qq_send_image(sendImage)');
  const snap = readSnapshot();
  if (snap) {
    ok(snap.hot === true, '快照带 hot:true 标记（表示这是热生效进程，不是启动快照）');
    ok(Array.isArray(snap.registered) && snap.registered.length > 40,
      `registered 是全量注册的 ${snap.registered?.length} 个工具`);
    ok(snap.registered.includes('qq_send_sticker'), 'sticker 工具仍在 registered 里（只是可能被 disable，不是没注册）');
    ok(snap.disabled.length >= 1 && snap.disabled.every((d) => /^qq_[a-z_]+(\([A-Za-z]+\))?$/.test(d)),
      `disabled 条目形状正确（${JSON.stringify(snap.disabled)}）`);
  } else {
    ok(false, '读到了注册快照');
  }
} catch (error) {
  failed += 1;
  console.log(`\n❌ 自检异常：${error?.stack ?? error}`);
  if (server) console.log(`--- server stderr ---\n${server.stderrText()}`);
} finally {
  if (server) await server.close();
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
}

console.log(`\n== 工具开关热生效自检：${passed} 通过 / ${failed} 失败 ==`);
process.exit(failed === 0 ? 0 : 1);
