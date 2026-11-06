// 「工具开关 ↔ MCP 实际注册」对账自检。
//
// 背景（这个问题肉眼看不出来，所以必须钉住）：
//   MCP 进程与桥接是**两个进程**，各读 config.json。控制台里那个勾只说明"配置想让它怎样"，
//   说明不了"模型手里实际有什么"。历史上 MCP 侧还在启动时读一次配置，于是：
//     · 关掉 → 桥接立刻 403，但模型那边工具还在（schema 照发、白烧 token）
//     · 打开 → 打开不生效（注册期已跳过，进程内根本没这个工具）
//   现在 MCP 侧改成了热生效（全部注册 + 按活配置 enable/disable，见 mcp-snowluma-safe.js
//   的 applyToolStates），错位只会出现在"刚保存、还没同步完"这一瞬；但**旧进程仍可能存在**
//   （快照没有 hot 字段），所以两代语义都要认。
//
// 本测试锁住四件事：
//   ① 两代快照的可用性口径（旧：registered 即可用；热：registered 且不在 disabled 里）
//   ② 四种 state 的判定（ok / on-not-registered / off-still-registered / unknown）
//   ③ 「快照不可信时绝不下结论」—— 不能拿过期清单让人去重启 DSH
//   ④ flags 里一个开关管多个工具时（memory 管 4 个）不会漏判
import {
  SNAPSHOT_HEARTBEAT_MS,
  SNAPSHOT_MAX_AGE_MS,
  describeToolRegistry,
  pickLiveSnapshot,
  reconcileToolRegistry,
  snapshotUsable
} from '../src/mcp-tool-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}

const FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_send_image: 'sendImage',
  qq_set_sticker_remark: 'setStickerRemark'
};

console.log('## 一、四种 state 的判定');
{
  const { items, mismatch } = reconcileToolRegistry({
    registered: ['qq_get_prompt', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear'],
    disabled: ['qq_set_sticker_remark(setStickerRemark)'],
    flags: FLAGS,
    tools: { getPrompt: true, memory: true, sendImage: true, setStickerRemark: false }
  });
  const by = Object.fromEntries(items.map((it) => [it.tool, it]));
  ok(by.qq_get_prompt.state === 'ok', '开着且已注册 ⇒ ok', by.qq_get_prompt.state);
  ok(by.qq_send_image.state === 'on-not-registered', '开着但没注册 ⇒ on-not-registered（打开不生效）', by.qq_send_image.state);
  ok(by.qq_set_sticker_remark.state === 'ok', '关着且未注册 ⇒ ok（这是期望状态）', by.qq_set_sticker_remark.state);
  ok(mismatch.length === 1 && mismatch[0] === 'qq_send_image', 'mismatch 只列真正错位的那个', JSON.stringify(mismatch));

  // 「关了但还在」：开关 false，快照却在 registered 里
  const r2 = reconcileToolRegistry({
    registered: ['qq_set_sticker_remark'],
    disabled: [],
    flags: FLAGS,
    tools: { setStickerRemark: false }
  });
  const it2 = r2.items.find((x) => x.tool === 'qq_set_sticker_remark');
  ok(it2.state === 'off-still-registered', '关着但已注册 ⇒ off-still-registered（模型手上还留着）', it2.state);
  ok(r2.mismatch.includes('qq_set_sticker_remark'), '它进 mismatch');
}

console.log('## 二、开关缺省即「开」（与 bridge 的 `!== false` 口径一致）');
{
  // tools 里没有这个键，绝不能当成「关」
  const { items } = reconcileToolRegistry({
    registered: ['qq_get_prompt'],
    disabled: [],
    flags: { qq_get_prompt: 'getPrompt', qq_send_image: 'sendImage' },
    tools: {}
  });
  const by = Object.fromEntries(items.map((it) => [it.tool, it]));
  ok(by.qq_get_prompt.enabled === true, '未配置的开关视为开（避免"默认全关"的误判）');
  ok(by.qq_send_image.enabled === true && by.qq_send_image.state === 'on-not-registered', '未配置且未注册 ⇒ 仍报"开着但未注册"（属真错位）', by.qq_send_image.state);
}

console.log('## 三、快照不可信时一律 unknown，绝不下结论');
{
  const { items, mismatch } = reconcileToolRegistry({
    registered: [],
    disabled: [],
    flags: FLAGS,
    tools: { getPrompt: true, memory: true, sendImage: true, setStickerRemark: false },
    snapshotUsable: false
  });
  ok(items.every((it) => it.state === 'unknown'), '全部 unknown', JSON.stringify(items.map((it) => it.state)));
  ok(mismatch.length === 0, 'mismatch 为空 —— 不能拿一份过期清单让人去重启 DSH', JSON.stringify(mismatch));

  // 空快照（文件还没生成）也一样
  const r2 = reconcileToolRegistry({ registered: [], disabled: [], flags: FLAGS, tools: {}, snapshotUsable: false });
  ok(r2.items.every((it) => it.state === 'unknown') && r2.mismatch.length === 0, '完全空的快照也走 unknown 分支');
}

console.log('## 四、snapshotUsable：新鲜度 + 进程存活，两个条件缺一不可');
{
  const now = Date.parse('2026-10-12T04:00:00.000Z');
  const fresh = { at: '2026-10-12T03:59:30.000Z', pid: 4242 };
  ok(snapshotUsable(fresh, now, () => true) === true, '新鲜 + 进程活着 ⇒ 可信');
  ok(snapshotUsable(fresh, now, () => false) === false, '进程已死 ⇒ 不可信（DSH 早已用新代码重拉）');

  // PID 被系统回收的场景：进程"活着"（号被复用），但心跳早停了
  const stale = { at: '2026-10-12T03:00:00.000Z', pid: 4242 };
  ok(snapshotUsable(stale, now, () => true) === false, '心跳过期 ⇒ 不可信，即使 PID 探测"活着"（PID 会被回收）');

  ok(snapshotUsable(null, now, () => true) === false, 'null 快照 ⇒ 不可信');
  ok(snapshotUsable({ at: 'not-a-date', pid: 1 }, now, () => true) === false, 'at 不是合法时间 ⇒ 不可信');
  ok(snapshotUsable({ at: fresh.at, pid: 0 }, now, () => true) === false, 'pid 非法 ⇒ 不可信');
  ok(snapshotUsable({ at: fresh.at, pid: -1 }, now, () => true) === false, 'pid 为负 ⇒ 不可信');

  // 边界：正好卡在阈值上算过期（>= 即不可信），差 1ms 算新鲜
  const edge = { at: new Date(now - SNAPSHOT_MAX_AGE_MS).toISOString(), pid: 4242 };
  ok(snapshotUsable(edge, now, () => true) === false, '年龄正好等于阈值 ⇒ 不可信（边界从严）');
  const justInside = { at: new Date(now - SNAPSHOT_MAX_AGE_MS + 1).toISOString(), pid: 4242 };
  ok(snapshotUsable(justInside, now, () => true) === true, '年龄差 1ms 到阈值 ⇒ 仍可信');
  ok(SNAPSHOT_MAX_AGE_MS === SNAPSHOT_HEARTBEAT_MS * 3, '阈值 = 心跳 × 3（与 MCP 侧的 setInterval 对齐）');
}

console.log('## 五、一个开关管多个工具（memory 管 4 个）');
{
  // 只注册了 4 个里的 1 个：整体应报「有错位」，且 mismatch 列出缺的那 3 个
  const { items, mismatch } = reconcileToolRegistry({
    registered: ['qq_memory_append'],
    disabled: ['qq_memory_query(memory)', 'qq_memory_remove(memory)', 'qq_memory_clear(memory)'],
    flags: { qq_memory_append: 'memory', qq_memory_query: 'memory', qq_memory_remove: 'memory', qq_memory_clear: 'memory' },
    tools: { memory: true }
  });
  ok(items.length === 4, '四个工具都在 items 里', String(items.length));
  ok(items.filter((it) => it.state === 'ok').length === 1, '已注册的那个是 ok');
  ok(mismatch.length === 3, '其余三个进 mismatch（不能只看第一个就下结论）', JSON.stringify(mismatch));
  ok(items.every((it) => it.flag === 'memory'), '四个共享同一个 flag，供控制台按 flag 归组');
}

console.log('## 六、disabled 条目的解析（形如 `qq_x(flag)`）');
{
  const { items } = reconcileToolRegistry({
    registered: [],
    disabled: ['qq_set_sticker_remark(setStickerRemark)'],
    flags: { qq_set_sticker_remark: 'setStickerRemark' },
    tools: { setStickerRemark: false }
  });
  const it = items[0];
  ok(it.state === 'ok', '能从 `name(flag)` 里剥出工具名并判为 ok（关且未注册）', it.state);
  ok(it.registered === false, 'disabled 里的工具 registered 为 false');
  ok(it.deliberatelyDisabled === true, '带出 deliberatelyDisabled（解释"为什么没注册"）');
}

console.log('## 六之二、两代快照的可用性口径（这是热生效改造的关键分歧点）');
{
  const flags = { qq_send_image: 'sendImage' };
  // 旧进程（无 hot）：注册就是在用。
  const legacy = reconcileToolRegistry({ registered: [], disabled: [], flags, tools: { sendImage: true } });
  ok(legacy.items[0].available === false, '旧快照：没注册 ⇒ 不可用');
  const legacyOff = reconcileToolRegistry({ registered: ['qq_send_image'], disabled: [], flags, tools: { sendImage: false }, hot: false });
  ok(legacyOff.items[0].state === 'off-still-registered', '旧快照：关了却还在 ⇒ off-still-registered', legacyOff.items[0].state);

  // 热进程（hot:true）：全部注册，可用性还要看 disabled。
  const hotOn = reconcileToolRegistry({ registered: ['qq_send_image'], disabled: [], flags, tools: { sendImage: true }, hot: true });
  ok(hotOn.items[0].available === true && hotOn.items[0].state === 'ok', '热快照：注册且未 disable ⇒ 可用', hotOn.items[0].state);
  const hotOff = reconcileToolRegistry({
    registered: ['qq_send_image'],
    disabled: ['qq_send_image(sendImage)'],
    flags, tools: { sendImage: false }, hot: true
  });
  // ← 这一条是本次改造最容易写错的地方：热进程里 disabled 的工具**仍然在 registered 里**，
  //   只看 registered 会把"已经关掉的工具"误报成"关了却还在"（一屏假黄），
  //   或者反过来漏掉真错位。
  ok(hotOff.items[0].registered === true, '热快照：被关的工具仍在 registered 里（全注册）');
  ok(hotOff.items[0].available === false, '热快照：但在 disabled 里 ⇒ 模型看不到');
  ok(hotOff.items[0].state === 'ok', '于是「关着且模型看不到」= 一致，不该报错位', hotOff.items[0].state);
  ok(hotOff.mismatch.length === 0, '热快照下不产生假报警', JSON.stringify(hotOff.mismatch));

  // 热进程里"开着却没注册"仍要报 —— 全注册后这不该发生，真发生了就是有工具漏注册。
  const hotMissing = reconcileToolRegistry({ registered: [], disabled: [], flags, tools: { sendImage: true }, hot: true });
  ok(hotMissing.items[0].state === 'on-not-registered', '热快照：开着却没注册 ⇒ 照样报错位', hotMissing.items[0].state);
  ok(hotMissing.items[0].deliberatelyDisabled === false, '它不是被开关关掉的，是真的漏注册');
}

console.log('## 六之三、没注册的工具必须报出来，不能被吞成 unknown');
{
  // 历史场景：qq_send_image 曾套着 `if (cfg.socialV2?.media?.enabled !== false) { server.tool(...) }`，
  // 父闸门关掉时那行根本不执行 ⇒ 既不在 registered 也不在 disabled。当时的实现只把
  // 「出现在 disabled 里」当已知，于是这类工具被误判成 unknown，**最该报警的错位反而被吞掉**。
  // 现在父闸门已经拆了（见 mcp-snowluma-safe.js 的 TOOL_PARENT_GATES），但这条断言仍然要留着：
  // 只要快照可信，它就是穷举的，「不在 registered 里」本身就是没注册的确证。
  const { items, mismatch } = reconcileToolRegistry({
    registered: [],
    disabled: [],   // ← 空：不是被开关关的，是真没注册
    flags: { qq_send_image: 'sendImage' },
    tools: { sendImage: true }
  });
  const it = items[0];
  ok(it.state === 'on-not-registered', '开着却没注册 ⇒ on-not-registered（关键回归）', it.state);
  ok(it.deliberatelyDisabled === false, '它不是被开关关掉的', String(it.deliberatelyDisabled));
  ok(mismatch.includes('qq_send_image'), '进 mismatch');
}

console.log('## 七、describeToolRegistry 的四种文案');
{
  const t1 = describeToolRegistry({ snapshot: null, staleSnapshot: true, mismatch: [] });
  ok(t1.includes('还没有 MCP 注册快照'), '没快照时的文案');
  const t2 = describeToolRegistry({ snapshot: { at: 'x', pid: 9 }, staleSnapshot: true, mismatch: ['a'] });
  ok(t2.includes('已过期') && t2.includes('PID 9'), '过期时不报 mismatch（免得误导）', t2);
  const t3 = describeToolRegistry({ snapshot: { at: 'x', pid: 9 }, staleSnapshot: false, mismatch: ['qq_send_image'] });
  ok(t3.includes('qq_send_image'), '有错位时点名工具（旧进程分支）', t3);
  ok(/重起/.test(t3), '给出的动作是"让 MCP 重起"，不是笼统的"重启 DSH"', t3);
  // 实测（2026-10-12）：只结束 mcp-snowluma-safe.js 进程、DSH 约 0.5~2 秒重拉，
  // 工具清单就对齐了。文案若写成"必须重启 DSH"，会让人白白掐掉所有会话。
  ok(!/必须重启 ?DSH|重启一次 ?DSH ?才/.test(t3), '**不能**说成"必须重启 DSH"（那会让人白掐掉所有会话）', t3);
  ok(/桌面|快捷方式/.test(t3), '顺带指出最省事的做法', t3);

  // 热生效进程（快照带 hot:true）不该再让人去重起任何东西 —— 它只是"刚保存、还没同步完"。
  const t3hot = describeToolRegistry({ snapshot: { at: 'x', pid: 9, hot: true }, staleSnapshot: false, mismatch: ['qq_send_image'] });
  ok(t3hot.includes('qq_send_image'), '有错位时点名工具（热生效分支）', t3hot);
  ok(/热生效|同步/.test(t3hot), '热生效进程说明"正在同步"，而不是让人去重起', t3hot);
  ok(!/重起|重启/.test(t3hot), '热生效分支**不许**出现"重起/重启"（那是旧进程才需要的动作）', t3hot);

  const t4 = describeToolRegistry({ snapshot: { at: 'x', pid: 9 }, staleSnapshot: false, mismatch: [] });
  ok(t4.includes('一致'), '一致时的文案', t4);
  const t4hot = describeToolRegistry({ snapshot: { at: 'x', pid: 9, hot: true }, staleSnapshot: false, mismatch: [] });
  ok(t4hot.includes('热生效'), '热生效且一致时点明"热生效"', t4hot);
}

console.log('## 八、健壮性：字段类型不对不能抛');
{
  const weird = [
    { registered: 'nope', disabled: 42, flags: null, tools: null },
    { registered: null, disabled: null, flags: undefined, tools: undefined },
    {}
  ];
  let threw = null;
  const results = [];
  for (const w of weird) {
    try { results.push(reconcileToolRegistry(w)); } catch (e) { threw = e; }
  }
  ok(!threw, '字段类型乱给也不抛', threw?.message ?? '');
  ok(results.every((r) => Array.isArray(r.items) && Array.isArray(r.mismatch)), '始终返回 items/mismatch 数组');
  ok(results.every((r) => r.items.length === 0), '没有 flags 就没有 items（不是编出一堆假工具）');
}

console.log('## 九、多份快照（每 PID 一份）里挑出有效的那份');
{
  const now = Date.parse('2026-10-12T04:00:00.000Z');
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const live = (pids) => (pid) => pids.includes(pid);

  // 场景：一个刚起就退出的探针写出了「更新」的一份，真正在服务的是老一点的那个。
  // 简单取 mtime/at 最大会把探针那份当权威 —— 必须靠存活筛掉它。
  const probe = { at: iso(1_000), pid: 9001, registered: ['qq_status'] };
  const serving = { at: iso(30_000), pid: 9002, registered: ['qq_status', 'qq_get_prompt'] };
  const picked = pickLiveSnapshot([probe, serving], now, live([9002]));
  ok(picked?.pid === 9002, '死掉的探针（虽然更新）被筛掉，取真正在跑的那个', String(picked?.pid));
  ok(picked.registered.length === 2, '取到的是服务进程的完整清单', JSON.stringify(picked?.registered));

  // 两个都活着：取 at 最新的
  const older = { at: iso(50_000), pid: 9003, registered: ['a'] };
  const newer = { at: iso(5_000), pid: 9004, registered: ['a', 'b'] };
  ok(pickLiveSnapshot([older, newer], now, live([9003, 9004]))?.pid === 9004, '都活着时取最新的一份');

  // 都不可信 ⇒ null（调用方据此显示"未知"，而不是拿过期数据下结论）
  const dead = { at: iso(1_000), pid: 9005 };
  ok(pickLiveSnapshot([dead], now, live([])) === null, '进程已死 ⇒ null');
  const stale = { at: iso(SNAPSHOT_MAX_AGE_MS + 1), pid: 9006 };
  ok(pickLiveSnapshot([stale], now, live([9006])) === null, '心跳过期 ⇒ null');
  ok(pickLiveSnapshot([], now, live([])) === null, '空数组 ⇒ null');
  ok(pickLiveSnapshot(null, now, live([])) === null, 'null 输入 ⇒ null（不抛）');
  ok(pickLiveSnapshot([{ at: 'garbage', pid: 1 }], now, live([1])) === null, 'at 非法 ⇒ null');
}

console.log('## 十、端到端：GET /api/socialV2/tools（真实 bridge.js + 假网关）');
{
  const CONSOLE_TOKEN = 'fixture-console-token'; // 与 audit-bridge-harness 的 config.consoleToken 一致
  const h = await bridgeHarness({
    config: {
      socialV2: {
        // 故意造出「开关和注册不一致」：开关全开，但快照里只注册了一部分。
        tools: { getPrompt: true, sendImage: true, setStickerRemark: false }
      }
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = async (headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/tools`, { headers });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // 夹具 temp 目录是新建的 ⇒ 默认没有快照，先测「没有快照」这一支。
  const stateDir = path.join(h.temp, 'state');
  ok(!fs.existsSync(stateDir) || !fs.readdirSync(stateDir).some((f) => /^mcp-tools\./.test(f)),
    '前置：夹具里确实没有快照文件（否则下面的断言测的不是无快照分支）');

  const noToken = await call();
  ok(noToken.status === 401, '不带控制台令牌 ⇒ 401（全局鉴权）', String(noToken.status));

  const agentOnly = await call({ 'x-console-token': CONSOLE_TOKEN, 'x-agent-call': '1', 'x-agent-token': 'x' });
  ok(agentOnly.status === 403, '带 agent token ⇒ 403（该接口仅控制台可用，AI 不能拿它对账）', String(agentOnly.status));

  const okRes = await call({ 'x-console-token': CONSOLE_TOKEN });
  ok(okRes.status === 200, '控制台通道 ⇒ 200', `${okRes.status} ${JSON.stringify(okRes.json).slice(0, 120)}`);
  ok(okRes.json?.ok === true, 'ok:true');
  ok(typeof okRes.json?.summary === 'string' && okRes.json.summary.length > 0, 'summary 是给人看的一句话', okRes.json?.summary);
  ok(Array.isArray(okRes.json?.items), 'items 是数组');
  ok(Array.isArray(okRes.json?.mismatch), 'mismatch 是数组');
  ok(okRes.json?.snapshot === null && okRes.json?.staleSnapshot === true, '没有快照时 snapshot:null + staleSnapshot:true');
  ok(okRes.json.mismatch.length === 0, '没有快照时 mismatch 为空（绝不下结论）', JSON.stringify(okRes.json.mismatch));
  ok(/还没有 MCP 注册快照/.test(okRes.json.summary), 'summary 说明"还没有快照"而不是报错', okRes.json.summary);

  // 再放入一份**活着的**快照：故意让开关与注册错位，验证端点真的会比出来。
  const flags = { qq_get_prompt: 'getPrompt', qq_send_image: 'sendImage' };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `mcp-tools.${process.pid}.json`), JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid, // 用自己当"MCP 进程"，保证进程存活判定为真
    server: 'snowluma-safe',
    flags,
    registered: ['qq_get_prompt'], // 只注册了 getPrompt
    disabled: []
  }));
  const withSnap = await call({ 'x-console-token': CONSOLE_TOKEN });
  ok(withSnap.status === 200, '放入快照后仍是 200', String(withSnap.status));
  ok(withSnap.json?.snapshot?.pid === process.pid, '端点选中了这份快照', JSON.stringify(withSnap.json?.snapshot));
  // 夹具 config 里 getPrompt=true（已注册 → ok）、sendImage=true（未注册 → 错位）
  ok(withSnap.json.items.some((it) => it.tool === 'qq_get_prompt' && it.state === 'ok'), 'getPrompt：开且已注册 ⇒ ok');
  ok(withSnap.json.items.some((it) => it.tool === 'qq_send_image' && it.state === 'on-not-registered'),
    'sendImage：开但未注册 ⇒ 报错位（这是控制台要标黄的那条）',
    JSON.stringify(withSnap.json.items.filter((it) => it.tool === 'qq_send_image')));
  ok(withSnap.json.mismatch.includes('qq_send_image'), 'mismatch 点名 qq_send_image', JSON.stringify(withSnap.json.mismatch));
  ok(/qq_send_image/.test(withSnap.json.summary) && /重起/.test(withSnap.json.summary),
    'summary 直接点名并给出该做的动作', withSnap.json.summary);

  // 换成**热生效进程**的快照（hot:true）：同一份错位数据，给出的说法必须不同 ——
  // 热进程下"开着但没注册"只可能是刚保存、还在同步，绝不能让人去掐进程。
  fs.writeFileSync(path.join(stateDir, `mcp-tools.${process.pid}.json`), JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    server: 'snowluma-safe',
    hot: true,
    flags,
    registered: ['qq_get_prompt'],
    disabled: []
  }));
  const hotSnap = await call({ 'x-console-token': CONSOLE_TOKEN });
  ok(hotSnap.json?.snapshot?.hot === true, '端点把 hot 透出来了（控制台据此换文案）', JSON.stringify(hotSnap.json?.snapshot));
  ok(hotSnap.json.mismatch.includes('qq_send_image'), '热快照下同样能报出错位', JSON.stringify(hotSnap.json.mismatch));
  ok(!/重起|重启/.test(hotSnap.json.summary), '热生效进程的 summary 不许叫人去重起', hotSnap.json.summary);
  ok(/热生效|同步/.test(hotSnap.json.summary), '热生效进程的 summary 说"正在同步"', hotSnap.json.summary);

  // 热快照下「关了但还开着」：工具在 disabled 里 ⇒ available=false ⇒ 与 enabled=false 一致 ⇒ ok。
  // 这是热语义的核心：注册 ≠ 可用，disabled 也要算进去。
  fs.writeFileSync(path.join(stateDir, `mcp-tools.${process.pid}.json`), JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    server: 'snowluma-safe',
    hot: true,
    flags,
    registered: ['qq_get_prompt', 'qq_send_image'],
    disabled: ['qq_get_prompt(getPrompt)']
  }));
  const hotOff = await call({ 'x-console-token': CONSOLE_TOKEN });
  ok(hotOff.json.items.some((it) => it.tool === 'qq_get_prompt' && it.available === false),
    '热快照下 registered 但在 disabled 里 ⇒ available=false（只看 registered 会误报）',
    JSON.stringify(hotOff.json.items.find((it) => it.tool === 'qq_get_prompt')));
  ok(hotOff.json.mismatch.includes('qq_get_prompt'),
    '于是"关着却仍可用"这类错位在热快照下也能被发现', JSON.stringify(hotOff.json.mismatch));

  h.close();
}

console.log(`\n== 工具注册对账自检：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
