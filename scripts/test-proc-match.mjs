#!/usr/bin/env node
// 启动器（D:\qq-bot\ensure-bot-env.mjs）的**进程识别**自检。
//
// 为什么要有这个文件：2026-10-12 实际踩到一次 —— 启动器按「命令行里有 `src\bridge.js`」找桥接，
// 而 D 盘上同构的第二个项目（B 站那套 `D:\bili-bot\bili-bridge\src\bridge.js`）命令行**同样**含它。
// 于是点一下桌面「QQ机器人」快捷方式，脚本把**另一个项目的桥接**杀掉（实测 PID 35204 被杀），
// 而 QQ 桥接自己反倒没换新、还报「3100 被别的进程占着」。
//
// 修法（本文件钉住）：
//   · 桥接以**端口归属**为准（QQ 桥接 = 监听 3100 的 node；B 站在 3200），命令行只做 sanity check；
//   · `looksLikeQqBridge()` 必须对 B 站命令行返回 false；
//   · MCP 必须锚定**本仓库绝对路径**，B 站的 `mcp-bili-safe.js` 一律不算。
//
// 用法：npm run test:proc-match    （也跑在 npm run test:audit 里）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');                    // D:\qq-bot\qq-bridge
const LAUNCHER = path.resolve(ROOT, '..', 'ensure-bot-env.mjs');   // D:\qq-bot\ensure-bot-env.mjs

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}${detail ? `（${detail}）` : ''}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? `（${detail}）` : ''}`); }
};

console.log('## 一、启动器可以被 import 而不执行检查');
ok(fs.existsSync(LAUNCHER), '启动器存在', LAUNCHER);
const mod = await import(`file:///${LAUNCHER.replace(/\\/g, '/')}`);
ok(typeof mod.looksLikeQqBridge === 'function', '导出了 looksLikeQqBridge');
ok(typeof mod.looksLikeLocalMcp === 'function', '导出了 looksLikeLocalMcp');

console.log('## 二、桥接识别：不碰同构的 B 站项目');
// 真实命令行（实测采自本机 Get-CimInstance）
const QQ_BRIDGE_CMD = 'node  src\\bridge.js';                                     // 相对路径（start-bridge.cmd 先 cd）
const QQ_BRIDGE_ABS = '"C:\\nodejs\\node.exe" D:\\qq-bot\\qq-bridge\\src\\bridge.js';
const BILI_BRIDGE_CMD = '"C:\\Users\\x\\node.exe" D:\\bili-bot\\bili-bridge\\src\\bridge.js';
const QQ_MCP_CMD = '"C:\\nodejs\\node.exe" D:\\qq-bot\\qq-bridge\\src\\mcp-snowluma-safe.js';
const BILI_MCP_CMD = '"C:\\nodejs\\node.exe" D:\\bili-bot\\bili-bridge\\src\\mcp-bili-safe.js';

ok(mod.looksLikeQqBridge(QQ_BRIDGE_CMD) === true, 'QQ 桥接（相对路径命令行）被认出来');
ok(mod.looksLikeQqBridge(QQ_BRIDGE_ABS) === true, 'QQ 桥接（绝对路径命令行）被认出来');
ok(mod.looksLikeQqBridge(BILI_BRIDGE_CMD) === false, '⚠️ B 站桥接**不**被当成 QQ 桥接（这就是那个 bug）');
ok(mod.looksLikeQqBridge(QQ_MCP_CMD) === false, 'MCP 进程不会被当成桥接');
ok(mod.looksLikeQqBridge('') === false, '空命令行 = false');
ok(mod.looksLikeQqBridge(undefined) === false, 'undefined = false（不抛错）');
ok(mod.looksLikeQqBridge('node D:\\other\\src\\bridge.js') === true,
  '普通同构项目仍会被认成桥接（靠端口归属兜底，命令行只做 sanity check）');

console.log('## 三、MCP 识别：必须锚定本仓库绝对路径');
ok(mod.looksLikeLocalMcp(QQ_MCP_CMD, ROOT) === true, 'QQ 侧 MCP 被认出来');
ok(mod.looksLikeLocalMcp(BILI_MCP_CMD, ROOT) === false, '⚠️ B 站 mcp-bili-safe.js **不**算本仓库 MCP');
ok(mod.looksLikeLocalMcp('node src\\mcp-host-server.js', ROOT) === false,
  '只有相对路径、不含本仓库绝对路径 = false（宁可漏认也不误杀）');
ok(mod.looksLikeLocalMcp(QQ_MCP_CMD.replace(/\\/g, '/'), ROOT) === true, '正斜杠路径也能认（跨平台容错）');
ok(mod.looksLikeLocalMcp(QQ_MCP_CMD, ROOT.toUpperCase()) === true, '大小写不敏感');
ok(mod.looksLikeLocalMcp('node D:\\qq-bot\\qq-bridge\\src\\bridge.js', ROOT) === false,
  '桥接入口不是 mcp-*，不算 MCP');
ok(mod.looksLikeLocalMcp(undefined, ROOT) === false, 'undefined = false（不抛错）');

console.log('## 四、启动器源码里不再有危险的旧写法');
const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
ok(!/\$_.CommandLine -match 'src\\\\\\\\bridge\\\\\.js'/.test(launcherSrc),
  'PowerShell 侧不再用「命令行含 src\\bridge.js」筛桥接');
ok(/portOwnerPid\(BRIDGE_PORT\)/.test(launcherSrc),
  '桥接改为按端口归属（portOwnerPid(BRIDGE_PORT)）识别');
ok(/looksLikeQqBridge/.test(launcherSrc) && /looksLikeLocalMcp/.test(launcherSrc),
  '两个纯函数都被真正调用（不是只导出）');
ok(/invokedDirectly/.test(launcherSrc),
  'main() 只在直接运行时执行（import 自检不会顺手改环境）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
