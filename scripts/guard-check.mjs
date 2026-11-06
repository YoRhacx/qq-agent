#!/usr/bin/env node
// guard-check.mjs — 仓库规矩体检（离线、只读、秒级）。
//
// 存在的理由：这个仓库有几类错误**测试抓不到**（见 PITFALLS.md）——
//   · 重复 import：审计夹具会剥掉顶层 import，测试全绿而进程起不来（P-001）；
//   · 新模块没注入 vm 上下文：跑到真实 bridge.js 的用例才炸（P-002）；
//   · 文档/脚本清单滞后：下一个人以为模块不存在（FOLDER_MAP 那三处）；
//   · 硬编码 DSH 端口：端口一变就静默重连（P-006）。
//
// 用法：npm run guard:check（退出码 1 = 有必须修的项）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let errors = 0;
let warns = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (msg, hint = '') => { errors += 1; console.log(`  ❌ ${msg}${hint ? `\n     → ${hint}` : ''}`); };
const warn = (msg) => { warns += 1; console.log(`  ⚠️  ${msg}`); };
const section = (t) => console.log(`\n${t}`);

/** 去掉行注释与块注释（保留行结构，方便报行号）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ── 1. 契约文件 ─────────────────────────────────────────────────────────────
section('契约文件');
for (const [file, label] of [['AGENTS.md', '给下一个人的规矩'], ['PITFALLS.md', '踩坑索引'], ['docs/cases/README.md', '案例复盘索引']]) {
  if (!exists(file)) { bad(`缺少 ${file}（${label}）`); continue; }
  const text = read(file);
  if (text.trim().length < 200) bad(`${file} 太短，像是占位符`);
  else ok(`${file}（${text.split('\n').length} 行）`);
}

// ── 2. src/bridge.js 的顶层 import ──────────────────────────────────────────
section('src/bridge.js 顶层 import');
const bridgePath = path.join(ROOT, 'src/bridge.js');
const bridgeRaw = fs.readFileSync(bridgePath, 'utf8');
const importRe = /^import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"];?\s*$/gm;
const seen = new Map(); // 标识符 -> 次数
const importedFiles = new Set();
for (const m of bridgeRaw.matchAll(importRe)) {
  const [, clause = '', spec] = m;
  if (spec.startsWith('.')) importedFiles.add(spec);
  const names = [];
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.push(t.split(/\s+as\s+/).pop().trim());
    }
  }
  const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (ns) names.push(ns[1]);
  const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, '')
    .replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
  names.push(...def);
  for (const n of names) if (/^[A-Za-z_$][\w$]*$/.test(n)) seen.set(n, (seen.get(n) ?? 0) + 1);
}
const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
if (dup.length) bad(`重复声明的 import 标识符：${dup.join(', ')}`, '删掉重复那行；测试与 audit 抓不到（P-001），改完必须重启一次');
else ok(`${seen.size} 个 import 标识符，无重复`);

// ── 3. 每个 relative import 的文件都在 ──────────────────────────────────────
const missing = [...importedFiles].filter((spec) => !fs.existsSync(path.resolve(path.dirname(bridgePath), spec)));
if (missing.length) bad(`bridge.js 引用了不存在的文件：${missing.join(', ')}`);
else ok(`${importedFiles.size} 个本地依赖文件都存在`);

// ── 4. src 模块必须被执行夹具注入（否则审计里是 ReferenceError/500）────────
section('审计夹具注入');
const harness = read('scripts/audit-bridge-harness.mjs');
const srcModules = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js') && f !== 'bridge.js');
const notInjected = [];
for (const spec of importedFiles) {
  if (!spec.startsWith('./')) continue;
  const file = spec.slice(2);
  if (!file.endsWith('.js')) continue;
  if (!srcModules.includes(file)) continue;
  // 夹具里会写 `import * as x from '../src/<file>'` 或直接 `../src/<file>`
  if (!harness.includes(`src/${file}`)) notInjected.push(file);
}
if (notInjected.length) bad(`未被审计夹具注入：${notInjected.join(', ')}`, "在 scripts/audit-bridge-harness.mjs 加 import * as x + ...x（漏注入的报错形态很隐蔽，P-002）");
else ok(`bridge.js 引用的 ${srcModules.length} 个 src 模块都在夹具注入表里`);

// ── 5. src/ 里不许硬编码 DSH 端口 ───────────────────────────────────────────
section('DSH 端点');
const PORT_BAN = /\b(19387|3080)\b/;
const offenders = [];
for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js'))) {
  if (f === 'dsh-discovery.js') continue; // 这里就是候选列表白名单
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
  code.split(/\r?\n/).forEach((line, i) => {
    if (!PORT_BAN.test(line)) return;
    // 「默认值」不算硬编码：构造函数默认参数、config 兜底、CLI 用法示例都会被真发现逻辑
    // 覆盖（dsh-client.js:307 的 `?? 'http://127.0.0.1:3080'`、bridge.js:866 的 config 默认项）。
    // 真正危险的是**直接拿去连**的字面量。
    if (/\?\?|\|\||兜底|默认|fallback|LEGACY/i.test(line)) return;
    if (/^\s*baseUrl\s*:\s*'http:\/\/127\.0\.0\.1:\d+'/.test(line)) return;
    offenders.push(`src/${f}:${i + 1}`);
  });
}
if (offenders.length) bad(`硬编码 DSH 端口：${offenders.join(', ')}`, 'DSH 桌面版每次重启换端口（P-006）；走 discoverDshEndpoint / ensureDshEndpoint');
else ok('src/ 无硬编码 DSH 端口（dsh-discovery.js 的候选列表除外）');

// ── 6. 文档：FOLDER_MAP 覆盖每个新文件 ──────────────────────────────────────
section('文档覆盖');
const folderMap = exists('docs/FOLDER_MAP.md') ? read('docs/FOLDER_MAP.md') : '';
const undocumented = srcModules.filter((f) => !folderMap.includes(f));
if (undocumented.length) bad(`docs/FOLDER_MAP.md 未提及：${undocumented.join(', ')}`, 'FOLDER_MAP 是仓库地图，新模块不写等于不存在');
else ok(`${srcModules.length} 个 src 模块都在 FOLDER_MAP 里`);

const guidesDir = path.join(ROOT, 'docs/guides');
const docsIndex = exists('docs/README.md') ? read('docs/README.md') : '';
if (fs.existsSync(guidesDir)) {
  const guides = fs.readdirSync(guidesDir).filter((f) => f.endsWith('.md'));
  const unindexed = guides.filter((f) => !docsIndex.includes(f));
  if (unindexed.length) bad(`docs/README.md 未索引：${unindexed.join(', ')}`);
  else ok(`${guides.length} 篇 guide 都在 docs/README.md 索引里`);
}

// ── 7. 脚本清单数量与实际一致（FOLDER_MAP 的统计句）────────────────────────
section('统计口径');
const scriptsDir = path.join(ROOT, 'scripts');
const count = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(ext)).length;
const mjsCount = count(scriptsDir, '.mjs');
const jsonCount = count(scriptsDir, '.json');
const declared = folderMap.match(/脚本共\s*(\d+)\s*个文件（(\d+)\s*个\s*`?\.mjs`?\s*\+\s*(\d+)\s*个 JSON/);
if (!declared) warn('FOLDER_MAP 里找不到「脚本共 N 个文件（M 个 .mjs + K 个 JSON）」统计句');
else {
  const [, n, m, k] = declared.map(Number);
  if (n !== mjsCount + jsonCount || m !== mjsCount || k !== jsonCount) {
    bad(`FOLDER_MAP 统计 ${n}（${m} .mjs + ${k} JSON）≠ 实际 ${mjsCount + jsonCount}（${mjsCount} + ${jsonCount}）`, '新增脚本后同步那句话');
  } else ok(`脚本统计一致：${n} 个（${m} .mjs + ${k} JSON）`);
}

// ── 8. 新测试要注册进 test:audit（否则等于没跑）────────────────────────────
section('测试注册');
const auditList = exists('scripts/test-audit.mjs') ? read('scripts/test-audit.mjs') : '';
const tests = fs.readdirSync(scriptsDir).filter((f) => /^test-.*\.mjs$/.test(f));
// 手工/e2e/需要真实环境的脚本可以在 FOLDER_MAP 里标「不进 audit」，这里只报未注册的
const unregistered = tests.filter((f) => !auditList.includes(f) && !folderMap.includes(f));
if (unregistered.length) warn(`${unregistered.length} 个测试既不在 test:audit、也不在 FOLDER_MAP 里：${unregistered.slice(0, 8).join(', ')}${unregistered.length > 8 ? ' …' : ''}`);
else ok(`${tests.length} 个测试都有归属（audit 清单或 FOLDER_MAP 说明）`);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n${errors === 0 ? '✅ guard:check 通过' : `❌ guard:check 失败：${errors} 项`}${warns ? `（另有 ${warns} 条提醒）` : ''}`);
process.exitCode = errors === 0 ? 0 : 1;
