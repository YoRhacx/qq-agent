// 「工具开关」在三处名单之间的一致性自检。
//
// 为什么需要它：同一个开关在**四个地方**各写一遍，任何一处漏了都不会报错，
// 只会安静地变成一个「控制台看不见 / 保存了不生效 / 关了也拦不住」的工具：
//
//   ① src/mcp-snowluma-safe.js  TOOL_CONFIG_FLAGS   —— 模型侧能不能看到它（决定 schema 发不发）
//   ② public/console.html       data-v2-tool        —— 主人能不能在界面上改它
//   ③ src/bridge.js             toolFlags           —— 保存时把值归一化成 boolean、缺省回落出厂默认
//   ④ src/bridge.js             SOCIAL_V2_TOOL_DEFAULTS —— 出厂默认值
//
// 这三处不一致曾经真的发生过，而且没人发现：
//   · qq_listen_voice 的 flag（listenVoice）在 MCP 与出厂默认表里都有，**控制台没有勾选框**、
//     保存白名单里也没有 ⇒ 界面上根本改不了它。
//   · qq_watch_video 的 flag（watchVideo）在控制台有勾选框（所以"看起来能关"），
//     但**保存白名单里没有** ⇒ 保存时不会被归一化，出厂默认也回落不到。
// 这类漏项的症状都极其轻微（"就是关不掉而已"），所以必须靠断言钉住，而不是靠人记得。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

const mcpSrc = read('src/mcp-snowluma-safe.js');
const bridgeSrc = read('src/bridge.js');
const html = read('public/console.html');

// ── 抽三份名单 ───────────────────────────────────────────────────────────
/** MCP 侧：tool → flag（决定模型手里有没有这个工具） */
function mcpFlagMap() {
  const block = /const TOOL_CONFIG_FLAGS = \{([\s\S]*?)\n\};/.exec(mcpSrc)?.[1] ?? '';
  const map = {};
  for (const m of block.matchAll(/^\s*(qq_[a-z_]+):\s*'([A-Za-z]+)'/gm)) map[m[1]] = m[2];
  return map;
}
/** 控制台：勾选框上的 data-v2-tool */
function consoleFlags() {
  return new Set([...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]));
}
/** 桥接：保存端点的归一化白名单 */
function bridgeWhitelist() {
  const block = /const toolFlags = \[([\s\S]*?)\]/.exec(bridgeSrc)?.[1] ?? '';
  return new Set([...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
}
/** 桥接：出厂默认表 */
function factoryDefaults() {
  const block = /const SOCIAL_V2_TOOL_DEFAULTS = Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(bridgeSrc)?.[1] ?? '';
  const defs = {};
  for (const m of block.matchAll(/^\s*([A-Za-z]+):\s*(true|false)/gm)) defs[m[1]] = m[2] === 'true';
  return defs;
}

const mcpMap = mcpFlagMap();
const mcpFlags = new Set(Object.values(mcpMap));
const ui = consoleFlags();
const wl = bridgeWhitelist();
const defaults = factoryDefaults();

console.log('## 名单规模');
ok(Object.keys(mcpMap).length > 40, 'MCP 侧登记了足够多的工具', `${Object.keys(mcpMap).length} 个工具 / ${mcpFlags.size} 个开关`);
ok(ui.size > 30, '控制台有足够多的勾选框', `${ui.size} 个`);
ok(wl.size > 30, '桥接有保存白名单', `${wl.size} 个`);

console.log('## ① MCP 能关的工具，控制台必须有勾选框');
// 否则：模型手里有它、主人却看不到这个开关，只能手改 config.json。
const noCheckbox = [...mcpFlags].filter((f) => !ui.has(f)).sort();
ok(noCheckbox.length === 0, '不存在「MCP 有开关、控制台没有勾选框」的项', noCheckbox.length ? `缺：${noCheckbox.join('、')}` : '全部覆盖');

console.log('## ② MCP 能关的工具，必须在保存白名单里');
// 否则：控制台保存时这个键不会被归一化成 boolean、也回落不到出厂默认，
// 「关闭」这个动作可能被静默忽略。
const notInWhitelist = [...mcpFlags].filter((f) => !wl.has(f)).sort();
ok(notInWhitelist.length === 0, '不存在「MCP 有开关、保存白名单没有」的项', notInWhitelist.length ? `缺：${notInWhitelist.join('、')}` : '全部覆盖');

console.log('## ③ 保存白名单里的每一项都要有出厂默认');
// 否则保存端点那句 `merged.tools[k] = SOCIAL_V2_TOOL_DEFAULTS[k] === true` 会算出 false，
// 把一个"没登记过"的开关静默关掉（这与"缺省即开"的口径相反）。
const noDefault = [...wl].filter((f) => !(f in defaults)).sort();
ok(noDefault.length === 0, '白名单里每项都有出厂默认值', noDefault.length ? `缺：${noDefault.join('、')}` : '全部覆盖');

console.log('## ④ 控制台勾选框不能指向 MCP 根本不认识的开关');
// 这种勾选框是纯装饰：勾了也没有任何工具受影响，但会让人以为"我关掉了它"。
// （sendGroup / sendPrivate / reply 是有意的例外：这三个工具跨模式共用，
//  不在 MCP 侧按 v2 开关注册，只在桥接调用期由 v2ToolEnabled 校验。）
const SHARED_MODE_FLAGS = new Set(['sendGroup', 'sendPrivate', 'reply']);
const ghost = [...ui].filter((f) => !mcpFlags.has(f) && !SHARED_MODE_FLAGS.has(f)).sort();
ok(ghost.length === 0, '不存在控制台有、MCP 却不认识的开关', ghost.length ? `幽灵开关：${ghost.join('、')}` : '全部有对应工具');

console.log('## ⑤ 跨模式共用的三个开关，桥接必须在调用期拦');
// 它们在 MCP 侧不注册过滤（用 v2 开关决定注册会误伤 chat/closed-agent 模式），
// 所以唯一的拦截点就是桥接；少一个，那个开关就是空的。
//
// ⚠️ 这三个走的是**间接**写法：`const flagMap = { sendGroup: …, sendPrivate: …, reply: … }`
// 之后 `v2ToolEnabled(flagMap[tool])`（见发送端点）。所以断言不能只搜字面量
// `v2ToolEnabled('sendGroup')` —— 那样会得到三个假红。这里认两种写法。
const indirectMap = /const flagMap = \{([^}]*)\}/.exec(bridgeSrc)?.[1] ?? '';
for (const flag of SHARED_MODE_FLAGS) {
  const literal = bridgeSrc.includes(`v2ToolEnabled('${flag}')`);
  const indirect = new RegExp(`\\b${flag}\\s*:`).test(indirectMap);
  ok(literal || indirect, `桥接调用期校验了 ${flag}`, literal ? '字面量' : (indirect ? '经 flagMap 间接校验' : ''));
}

console.log('## ⑥ 关掉工具后，桥接不能还能被直接打端点');
// 每个"有副作用"的 flag 至少要有一道桥接侧校验（v2ToolEnabled / sendImageToolEnabled 之类），
// 否则 MCP 清单里消失了、HTTP 端点却照样能用 —— 那就不是"关掉"，只是"藏起来"。
const CALL_TIME_GATES = [
  [/v2ToolEnabled\('sendImage'\)|sendImageToolEnabled\(/, 'sendImage'],
  [/v2ToolEnabled\('watchVideo'\)|tools\?\.watchVideo === false/, 'watchVideo'],
  [/v2ToolEnabled\('sendMusic'\)/, 'sendMusic'],
  [/v2ToolEnabled\('groupAdmin'\)/, 'groupAdmin'],
  [/v2ToolEnabled\('sendSticker'\)/, 'sendSticker'],
  [/v2ToolEnabled\('sendPoke'\)/, 'sendPoke'],
  [/v2ToolEnabled\('repeatMessage'\)/, 'repeatMessage'],
  // 读文件 / 点开卡片（主人 m09102）：两个都"只读"，但读的是**网络字节**（QQ 文件直链、
  // 卡片跳转），关掉开关就必须连端点一起拦 —— 否则 MCP 清单里消失了、HTTP 端点照样能拉文件。
  [/v2ToolEnabled\('readFile'\)/, 'readFile'],
  [/v2ToolEnabled\('openCard'\)/, 'openCard'],
  [/v2ToolEnabled\('getImages'\)/, 'getImages']
];
for (const [re, flag] of CALL_TIME_GATES) {
  const hit = re.test(bridgeSrc) || re.test(mcpSrc);
  ok(hit, `${flag} 在调用期还有一道校验（不只是从清单里消失）`);
}

console.log('## ⑦ config.example.json 的 tools 必须齐全');
// 控制台的读法是 `el.checked = (c.tools && c.tools[k] !== false)` —— **键缺失 = 显示勾选**。
// 于是 example 少一个"出厂默认 false"的键，新装用户会看到它**勾着**、实际却是关的，
// 方向正好相反，而且没有任何报错。2026-10-12 实测 example 缺 5 个键
// （watchVideo / listenVoice / status 方向无害，sendMusic / groupAdmin 方向相反）。
const example = JSON.parse(read('config.example.json'));
const exampleTools = example?.socialV2?.tools ?? {};
const missingInExample = Object.keys(defaults).filter((f) => !(f in exampleTools)).sort();
ok(missingInExample.length === 0,
  'config.example.json 的 socialV2.tools 覆盖全部出厂默认键',
  missingInExample.length ? `缺：${missingInExample.join('、')}` : `${Object.keys(exampleTools).length} 个键`);
const exampleMismatch = Object.keys(defaults)
  .filter((f) => f in exampleTools && exampleTools[f] !== defaults[f])
  .sort();
ok(exampleMismatch.length === 0,
  'example 里每个键的值都与出厂默认一致（不一致会让新装用户看到反的初始状态）',
  exampleMismatch.length
    ? exampleMismatch.map((f) => `${f}: example=${exampleTools[f]} 默认=${defaults[f]}`).join('；')
    : '全部一致');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
