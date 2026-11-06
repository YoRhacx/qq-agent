#!/usr/bin/env node
// 一键把工作树准备到「能跑」的状态（**幂等**：跑几次结果都一样）。
//
// 它做什么：① 检查 Node 版本、依赖是否就位（缺了才装）② 跑 postinstall 补丁
// （SnowLuma SDK）③ 按 DSH profile 跑 setup-dsh ④ 对 src/ 做一次语法检查
// ⑤ 打印当前运行状态（桥接端口 / DSH 端点 / dshReady）。
//
// 为什么需要它：新机器上「克隆 → npm install → 忘了 setup-dsh → 起桥接」是最常见的
// 起不来路径（P-015：profile 名写死 web 就埋在这里）。
//
// 用法：
//   node scripts/bootstrap.mjs                 # 缺什么补什么
//   node scripts/bootstrap.mjs --check         # 只体检，不改任何东西
//   node scripts/bootstrap.mjs --json          # 机读
//   node scripts/bootstrap.mjs --profile desktop
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const asJson = args.includes('--json');
const profileArg = (() => {
  const i = args.indexOf('--profile');
  return i >= 0 ? args[i + 1] : null;
})();

const results = [];
function record(step, ok, detail, skip = false) {
  results.push({ step, ok, skip, detail });
  if (!asJson) {
    const mark = skip ? '⏭' : ok ? '✅' : '❌';
    console.log(`${mark} ${step}${detail ? ` — ${detail}` : ''}`);
  }
}

// 本仓库的 node 可能不是系统 node，而是 ELECTRON_RUN_AS_NODE=1 的 Harness 可执行文件，
// 所以子进程必须用 process.execPath + 继承环境，不能硬写 'node'。
function runNode(script, argv = []) {
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 300000,
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

// ── 1. Node 版本 ────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const required = String(pkg.engines?.node ?? '>=22').replace(/^>=?/, '');
const current = process.versions.node;
const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
record('Node 版本', cmp(current, required) >= 0, `当前 ${current}，要求 ${pkg.engines?.node ?? required}`);

// ── 2. 依赖 ────────────────────────────────────────────────────────────────
const lock = path.join(ROOT, 'package-lock.json');
const installedMark = path.join(ROOT, 'node_modules', '.package-lock.json');
const missingDeps = !fs.existsSync(path.join(ROOT, 'node_modules'));
const staleDeps = !missingDeps && fs.existsSync(lock) && fs.existsSync(installedMark)
  && fs.statSync(lock).mtimeMs > fs.statSync(installedMark).mtimeMs + 1000;
if (missingDeps || staleDeps) {
  if (checkOnly) {
    record('依赖', false, missingDeps ? 'node_modules 不存在（需要 npm ci）' : 'package-lock 比 node_modules 新（需要 npm ci）');
  } else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, [fs.existsSync(lock) ? 'ci' : 'install'], { cwd: ROOT, stdio: 'inherit', timeout: 900000 });
    // 这台机器上可能根本没有独立 node/npm（全靠 DSH 自带的 node 跑脚本）。
    // 那种情况下 npm 是 ENOENT —— 别抛栈，直接说清楚该怎么办。
    if (res.error && res.error.code === 'ENOENT') {
      record('依赖', false, 'PATH 里没有 npm：先装 Node.js >=22.13.0，再用 npm run bootstrap');
    } else {
      record('依赖', res.status === 0, fs.existsSync(lock) ? 'npm ci' : 'npm install');
    }
  }
} else {
  record('依赖', true, '已就位');
}

// ── 3. postinstall 补丁（SnowLuma SDK）─────────────────────────────────────
if (checkOnly) {
  record('SnowLuma SDK 补丁', true, '未执行（--check）', true);
} else {
  const patch = runNode('scripts/patch-snowluma-sdk.mjs');
  record('SnowLuma SDK 补丁', patch.ok, patch.ok ? '已完成（幂等）' : patch.out.split('\n').slice(-3).join(' / '));
}

// ── 4. DSH 侧接线（profile 名不写死）───────────────────────────────────────
function detectProfile() {
  if (profileArg) return profileArg;
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  const dir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles');
  const candidates = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, name, 'cordis.patch.yml'))) candidates.push(name);
    }
  } catch { /* 没有 profiles 目录：交给 setup-dsh 自己报 */ }
  return candidates.includes('desktop') ? 'desktop' : (candidates[0] ?? 'web');
}
const profile = detectProfile();
if (checkOnly) {
  record('DSH 接线（setup-dsh）', true, `profile=${profile}，未执行（--check）`, true);
} else {
  const setup = runNode('scripts/setup-dsh.mjs', [profile]);
  record('DSH 接线（setup-dsh）', setup.ok, setup.ok ? `profile=${profile}` : setup.out.split('\n').slice(-3).join(' / '));
}

// ── 5. src 语法检查 ────────────────────────────────────────────────────────
const srcDir = path.join(ROOT, 'src');
const broken = [];
let checked = 0;
for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith('.js')) continue;
  checked += 1;
  const res = spawnSync(process.execPath, ['--check', path.join(srcDir, name)], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000,
  });
  if (res.status !== 0) broken.push(`${name}: ${(res.stderr ?? '').split('\n')[0]}`);
}
record('src 语法检查', broken.length === 0, broken.length ? broken.join(' | ') : `${checked} 个文件`);

// ── 6. 运行状态（不启动、不改动）───────────────────────────────────────────
let cfg = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
} catch { cfg = {}; }
const port = cfg.consolePort ?? 3100;
const token = cfg.consoleToken ?? '';
let alive = false;
let status = null;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/status?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(3000) });
  status = await res.json();
  alive = true;
} catch { /* 没在跑 */ }
record('桥接运行中', alive, alive ? `端口 ${port}` : `端口 ${port} 无响应（用 start.bat 启动）`, !alive);
if (alive) record('DSH 就绪', status?.dshReady === true, `baseUrl=${status?.dsh?.baseUrl ?? '?'} mode=${status?.mode ?? '?'}`, !status?.dshReady);

if (asJson) console.log(JSON.stringify({ profile, results }, null, 2));
const failed = results.filter((r) => !r.ok && !r.skip).length;
if (!asJson) console.log(failed ? `\n${failed} 项需要处理。` : '\n全部就绪。');
process.exitCode = failed ? 1 : 0;
