#!/usr/bin/env node
// 把一处已经改好的工作树「安全地换成正在跑的那一份」（**幂等**）。
//
// 顺序：语法检查 → 依赖是否过期（lock 比 node_modules 新才重装）→ postinstall 补丁
//      → setup-dsh → 停掉旧桥接 → start.bat 拉起 → 轮询 /api/status 校验 dshReady。
//
// 为什么不用 taskkill 直接杀了事：重启最容易出的两个事故是
//   ① 旧进程没死透 → 双实例抢消息、互相覆盖 state（restart.bat 的注释里记着 04:54 那次）；
//   ② 起了但没连上 DSH → 日志一片"连接 DSH 事件流…"，人以为成功了。
// 所以这里「停」要等到端口真的释放，「起」要等到 /api/status 真的 ready。
//
// 用法：
//   node scripts/apply-update.mjs              # 全流程（会重启桥接！）
//   node scripts/apply-update.mjs --dry-run    # 只打印将要做什么
//   node scripts/apply-update.mjs --no-restart # 只做依赖/补丁/语法，不动正在跑的进程
//   node scripts/apply-update.mjs --json
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noRestart = args.includes('--no-restart');
const asJson = args.includes('--json');
const profileArg = (() => { const i = args.indexOf('--profile'); return i >= 0 ? args[i + 1] : null; })();

const log = (msg) => { if (!asJson) console.log(msg); };
const steps = [];
const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };

let cfg = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
} catch { cfg = {}; }
const port = cfg.consolePort ?? 3100;
const token = cfg.consoleToken ?? '';

function runNode(script, argv = []) {
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...argv], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 600000,
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

// ── 1. 语法检查（先做：语法错的时候重启只会得到一具尸体）──────────────────
const srcDir = path.join(ROOT, 'src');
const broken = [];
for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith('.js')) continue;
  const res = spawnSync(process.execPath, ['--check', path.join(srcDir, name)], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000,
  });
  if (res.status !== 0) broken.push(`${name}: ${(res.stderr ?? '').split('\n')[0]}`);
}
step('src 语法检查', broken.length === 0, broken.join(' | '));
if (broken.length) { log('语法不过就不重启，避免把能跑的进程换成一具尸体。'); process.exit(1); }

// ── 2. 依赖 ────────────────────────────────────────────────────────────────
const lock = path.join(ROOT, 'package-lock.json');
const installedMark = path.join(ROOT, 'node_modules', '.package-lock.json');
const stale = fs.existsSync(lock) && fs.existsSync(installedMark) && fs.statSync(lock).mtimeMs > fs.statSync(installedMark).mtimeMs + 1000;
if (stale) {
  if (dryRun) step('依赖', true, '过期（--dry-run 未执行 npm ci）');
  else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, ['ci'], { cwd: ROOT, stdio: 'inherit', timeout: 900000 });
    if (res.error && res.error.code === 'ENOENT') step('依赖', false, 'PATH 里没有 npm：先装 Node.js >=22.13.0 再更新');
    else step('依赖', res.status === 0, 'npm ci');
  }
} else step('依赖', true, '未过期，跳过');

// ── 3. 补丁 + DSH 接线 ─────────────────────────────────────────────────────
function detectProfile() {
  if (profileArg) return profileArg;
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  const dir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles');
  const found = [];
  try {
    for (const name of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, name, 'cordis.patch.yml'))) found.push(name);
  } catch { /* 忽略 */ }
  return found.includes('desktop') ? 'desktop' : (found[0] ?? 'web');
}
const profile = detectProfile();
if (dryRun) {
  step('SnowLuma SDK 补丁', true, '--dry-run 未执行');
  step('DSH 接线（setup-dsh）', true, `--dry-run 未执行（profile=${profile}）`);
} else {
  const patch = runNode('scripts/patch-snowluma-sdk.mjs');
  step('SnowLuma SDK 补丁', patch.ok, patch.ok ? '幂等' : patch.out.split('\n').slice(-2).join(' / '));
  const setup = runNode('scripts/setup-dsh.mjs', [profile]);
  step('DSH 接线（setup-dsh）', setup.ok, setup.ok ? `profile=${profile}` : setup.out.split('\n').slice(-2).join(' / '));
}

if (noRestart) {
  log('\n--no-restart：跳过重启。');
  process.exit(steps.every((s) => s.ok) ? 0 : 1);
}

// ── 4. 停旧实例（按端口 + 锁文件双路，等到端口真的空）──────────────────────
function portPids() {
  if (process.platform !== 'win32') return [];
  const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 30000 });
  const pids = new Set();
  for (const line of (res.stdout ?? '').split('\n')) {
    if (!/LISTENING/.test(line)) continue;
    if (!new RegExp(`[:.]${port}\s`).test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}
const lockFile = path.join(ROOT, 'state', 'bridge.lock');
const pids = new Set(portPids());
try {
  const raw = fs.readFileSync(lockFile, 'utf8').trim();
  if (/^\d+$/.test(raw)) pids.add(Number(raw));
} catch { /* 没有锁文件 */ }

if (dryRun) {
  step('停旧桥接', true, pids.size ? `--dry-run，将结束 PID ${[...pids].join('/')}` : '当前没有在跑');
} else if (!pids.size) {
  step('停旧桥接', true, '当前没有在跑');
} else {
  for (const pid of pids) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 30000 });
  // 等端口释放：进程退出和端口释放之间有一段（TIME_WAIT 不算占用）
  const deadline = Date.now() + 20000;
  let left = portPids();
  while (left.length && Date.now() < deadline) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    left = portPids();
  }
  if (!left.length) { try { fs.rmSync(lockFile); } catch { /* 已没 */ } }
  step('停旧桥接', left.length === 0, left.length ? `端口仍被 PID ${left.join('/')} 占用` : `结束 PID ${[...pids].join('/')}`);
  if (left.length) { log('端口没释放，不启动新实例（避免双实例）。请手动处理上面的 PID。'); process.exit(1); }
}

// ── 5. 拉起（start.bat 自带崩溃重启循环）──────────────────────────────────
if (dryRun) {
  step('启动新桥接', true, '--dry-run 未执行');
} else {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/c', 'start.bat'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref();
  } else {
    spawn('sh', ['-c', 'nohup node src/bridge.js >> state/bridge.log 2>&1 &'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  }
  step('启动新桥接', true, 'start.bat（新窗口）');
}

// ── 6. 轮询到真的 ready ───────────────────────────────────────────────────
async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
let status = null;
if (!dryRun) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    status = await probe();
    if (status?.dshReady === true) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
step('桥接端口就绪', dryRun ? true : Boolean(status),
  dryRun ? `--dry-run 未轮询（端口 ${port}）` : (status ? `端口 ${port}` : `端口 ${port} 90s 内无响应`));
step('DSH 就绪（dshReady）', dryRun ? true : status?.dshReady === true,
  dryRun ? '--dry-run 未校验' : (status ? `baseUrl=${status.dsh?.baseUrl ?? '?'} mode=${status.mode ?? '?'}` : '未取到 /api/status'));

if (asJson) console.log(JSON.stringify({ profile, port, steps }, null, 2));
const failed = steps.filter((s) => !s.ok).length;
if (!asJson) console.log(failed ? `\n${failed} 步失败。` : '\n更新已生效。');
process.exitCode = failed ? 1 : 0;
