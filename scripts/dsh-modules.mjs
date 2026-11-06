// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

// DSH 桌面版把根依赖打进 resources/app.asar；在 Electron 里跑（哪怕
// ELECTRON_RUN_AS_NODE=1）时 fs 仍然认得 asar 虚拟目录，可以直接 import。
// 装成安装版（resources/app）时则是普通目录。两者都探一下。
function electronInstallModulesDirs() {
  const dirs = [];
  if (!process.execPath) return dirs;
  const resources = path.join(path.dirname(process.execPath), 'resources');
  for (const app of ['app.asar', 'app']) {
    for (const sub of ['dsh/node_modules', 'node_modules']) {
      dirs.push(path.join(resources, app, sub));
    }
  }
  return dirs;
}

// 只认「确实带 @deepseek-ai/dsh-persona」的 node_modules：js-yaml 在任何
// node_modules 里都可能命中，只凭它反查会拿到一个与本机 DSH 无关的旧目录
// （2026-10-18：反查到 D:\dsh-home\... 里没有 dsh-persona，schema 校验直接崩）。
function hasPersona(dir) {
  try {
    return fs.statSync(path.join(dir, '@deepseek-ai/dsh-persona')).isDirectory();
  } catch { return false; }
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir && hasPersona(dir)) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  for (const dir of electronInstallModulesDirs()) {
    if (hasPersona(dir)) return dir;
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules（要能读到 @deepseek-ai/dsh-persona）。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + '  桌面版通常是 <安装目录>/resources/app.asar/dsh/node_modules，且需用 DSH 自带的运行时执行：\n'
    + `    \$env:ELECTRON_RUN_AS_NODE='1'; & '<安装目录>/DeepSeek Harness.exe' <script>\n`
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}
