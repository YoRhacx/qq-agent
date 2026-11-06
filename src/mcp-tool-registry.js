// 「工具开关」与「MCP 进程此刻到底把哪些工具给了模型」的对账。
//
// 为什么需要这个模块（而不是在控制台里猜）：
//   MCP 进程（src/mcp-snowluma-safe.js）与桥接进程（src/bridge.js）是**两个进程**，
//   各自读 config.json。看 config.json 里那个勾，是看不出模型手里实际有什么的 ——
//   必须把两边摊在一起比。MCP 侧每 60 秒把真实注册清单写进 state/mcp-tools.<pid>.json
//   （见 mcp-snowluma-safe.js 的 writeRegisteredToolsSnapshot），这里负责比对。
//
// ── 两种进程，两套语义（这份模块必须同时认）───────────────────────────────
// 历史背景：早先 MCP 侧在**启动时读一次** config.json，用它决定注册哪些工具，
// 于是「关掉」要重起进程才从模型清单里消失、「打开」则永远不生效。那时快照里
// `registered` 的含义是「**模型能看到的**」—— 没注册就是没注册。
//
// 现在（`snapshot.hot === true`）改成了「全部注册 + 按活配置 enable/disable」：
// 进程内**所有**工具都存在，`registered` 是全集，`disabled` 才是「此刻关着的」。
// 所以：
//     · hot 快照：available = registered 且不在 disabled 里
//     · 旧快照 ：available = registered（没有热开关，注册即可用）
// 对外统一用 `available`（模型能不能看到/调用）来判 state，这样两套快照都能对账，
// 过渡期也不会出现一屏假报警。
//
// 剩下还可能的错位只有三种，都不是"要重启 DSH"：
//   ① 刚保存完的那不到 1 秒（MCP 收到文件变化、发 list_changed、客户端重拉）
//   ② 缓存里的快照还是旧的（还没到下一拍心跳）
//   ③ MCP 进程跑的是老代码（快照没有 hot 字段）或已经死了（快照过期）
//
// 单独成文件是为了可测：scripts/test-mcp-tool-registry.mjs 直接喂快照做断言，
// 不用起 MCP 进程、也不用起桥接。
// scripts/test-tool-hot-toggle.mjs 则起真进程验证改动当场生效。

/** 快照心跳间隔（与 mcp-snowluma-safe.js 里的 setInterval 保持一致）。 */
export const SNAPSHOT_HEARTBEAT_MS = 60_000;

/** 快照超过这个年龄就认定不可信：心跳 60 秒，容 3 拍。 */
export const SNAPSHOT_MAX_AGE_MS = SNAPSHOT_HEARTBEAT_MS * 3;

/**
 * 判定工具开关与「模型实际能看到的工具」是否错位。
 *
 * @param {object} opts
 * @param {string[]} opts.registered MCP 快照里的 registered 列表
 * @param {string[]} opts.disabled MCP 快照里的 disabled 列表（形如 `qq_x(flag)`，也可能是裸名）
 * @param {Record<string,string>} opts.flags tool → 开关名（来自 MCP 的 TOOL_CONFIG_FLAGS）
 * @param {Record<string,boolean>} [opts.tools] 活的 socialV2.tools（缺省即「开」）
 * @param {boolean} [opts.snapshotUsable] 快照是否可信（新鲜 + 进程存活）
 * @param {boolean} [opts.hot] 快照是否来自热生效进程（见文件头「两种进程，两套语义」）
 * @returns {{items: Array<{tool:string,flag:string,enabled:boolean,registered:boolean,available:boolean,state:string}>, mismatch: string[]}}
 *
 * state 取值：
 *   · `unknown`              快照不可信 ⇒ 不下结论（绝不能拿一份过期清单让人去折腾进程）
 *   · `ok`                   开关与「模型实际能不能看到」一致
 *   · `on-not-registered`    开着但模型看不到 ⇒ 打开不生效
 *   · `off-still-registered` 关了但模型仍看得到 ⇒ 描述/schema 照发，白烧 token 还诱导误调
 */
export function reconcileToolRegistry({
  registered = [],
  disabled = [],
  flags = {},
  tools = {},
  snapshotUsable = true,
  hot = false
} = {}) {
  const reg = new Set((Array.isArray(registered) ? registered : []).map(String));
  // disabled 里的条目形如 `qq_set_sticker_remark(setStickerRemark)`，取括号前的名字。
  const dis = new Set(
    (Array.isArray(disabled) ? disabled : [])
      .map((s) => String(s).replace(/\(.*$/, '').trim())
      .filter(Boolean)
  );
  const items = Object.entries(flags ?? {}).map(([tool, flag]) => {
    // 开关缺省即「开」——与 bridge.js 的 v2ToolEnabled（`!== false`）口径一致。
    const enabled = tools?.[flag] !== false;
    const isRegistered = reg.has(tool);
    // 模型能不能看到：热进程里还要再过一道 disabled；旧快照只看注册。
    const available = isRegistered && !(hot && dis.has(tool));
    // 一份可信的快照是**穷举**的：每个工具要么在 registered 里、要么（热进程下）
    // 在 disabled 里，所以「不在 registered 里」本身就是没注册的确证。
    //
    // 这一点踩过坑：以前有些工具外面还套了一层 `if (cfg...enabled !== false) { server.tool(...) }`
    // （如 qq_send_image 受 socialV2.media.enabled 管），父闸门关掉时那行 server.tool 根本
    // 不执行 ⇒ 它既不在 registered 也不在 disabled。若只认「出现在 disabled 里」才是已知，
    // 这类工具会被误判成 unknown，于是「开着但没注册」这种最该报警的错位反而被吞掉。
    const known = snapshotUsable;
    const state = !known
      ? 'unknown'
      : enabled === available
        ? 'ok'
        : enabled
          ? 'on-not-registered'
          : 'off-still-registered';
    // deliberatelyDisabled 只用于解释「为什么模型看不到」，不参与 state 判定。
    return { tool, flag, enabled, registered: isRegistered, available, deliberatelyDisabled: dis.has(tool), state };
  });
  // mismatch 只在快照可信时才有意义。
  const mismatch = snapshotUsable ? items.filter((it) => it.state !== 'ok' && it.state !== 'unknown').map((it) => it.tool) : [];
  return { items, mismatch };
}

/**
 * 快照是否可信：既要新鲜（心跳没停），又要写出它的进程还活着。
 *
 * 两个条件缺一不可 —— 只看 PID 会被系统回收的 PID 骗到（旧号被新进程复用，
 * 一份过期清单看起来仍然有效）；只看年龄则会在进程卡死但心跳文件还新时放过它。
 *
 * @param {object|null} snapshot 读到的 state/mcp-tools.<pid>.json
 * @param {number} [now] 当前时间（测试可注入）
 * @param {(pid:number)=>boolean} [isAlive] 进程存活判定（测试可注入）
 */
export function snapshotUsable(snapshot, now = Date.now(), isAlive = defaultIsAlive) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const at = Date.parse(String(snapshot.at ?? ''));
  if (!Number.isFinite(at)) return false;
  if (now - at >= SNAPSHOT_MAX_AGE_MS) return false;
  const pid = Number(snapshot.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return isAlive(pid);
}

/**
 * 从多份快照里挑出「当前有效」的那一份。
 *
 * 为什么会有多份：MCP 进程可能不止一个（DSH 重启期的交叠、手工起的探针），
 * 所以每份快照按 PID 单独落盘。挑法是**先筛掉不可信的，再取最新的那一份**：
 * 不能简单取 mtime 最大 —— 一个刚启动就退出的探针会写出最新的一份，
 * 它的注册清单未必代表正在服务 DSH 的那个进程。
 *
 * 一份都不可信时返回 null（调用方据此显示"注册状态未知"，而不是拿过期数据下结论）。
 *
 * @param {Array<object>} snapshots 读到的所有快照
 * @param {number} [now] 当前时间
 * @param {(pid:number)=>boolean} [isAlive] 进程存活判定
 */
export function pickLiveSnapshot(snapshots, now = Date.now(), isAlive = defaultIsAlive) {
  const usable = (Array.isArray(snapshots) ? snapshots : [])
    .filter((s) => snapshotUsable(s, now, isAlive));
  if (!usable.length) return null;
  // 都可信就取 at 最新的那份（同时活着的多个进程，注册清单本应一致）。
  return usable.reduce((best, cur) => (Date.parse(String(cur.at)) > Date.parse(String(best.at)) ? cur : best));
}

/** 进程存活探测：signal 0 只做权限/存在性检查，不真的发信号。 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但当前用户无权 signal —— 对本用途仍算「活着」。
    return error?.code === 'EPERM';
  }
}

/**
 * 把对账结果压成一句给人看的话（控制台与自省工具共用同一份口径，
 * 免得两处各写一套文案、慢慢说不到一起去）。
 *
 * ⚠️ 措辞是有讲究的：**不要写成"必须重启 DSH"**。
 * 工具开关现在是热生效的：保存后 MCP 收到 config.json 变化、当场 enable/disable 并发
 * list_changed，DSH 重新拉清单，通常不到 1 秒。所以：
 *   · 热进程（快照带 hot）不一致 ⇒ 只可能是刚保存还没同步完，让人**等一下**，别让人去重起；
 *   · 老进程（快照无 hot，跑的是改造前的代码）⇒ 那才真的只能让它按新配置重起一次。
 */
export function describeToolRegistry({ staleSnapshot = false, mismatch = [], snapshot = null } = {}) {
  if (!snapshot) {
    return '还没有 MCP 注册快照（MCP 进程还没在新代码下启动过）。让 MCP 重起一次后这里会显示每个工具的实际注册状态。';
  }
  if (staleSnapshot) {
    return `MCP 注册快照已过期（写出它的进程 PID ${snapshot.pid} 已不在，或心跳停了）。让 MCP 重起一次后重新对账。`;
  }
  const hot = snapshot.hot === true;
  if (mismatch.length) {
    if (!hot) {
      // 老进程：注册期快照决定的，只能靠重起进程对齐。
      return `有 ${mismatch.length} 个工具「开关」与「MCP 实际注册」不一致：${mismatch.join('、')} —— 这个 MCP 进程还在用旧的「启动时读一次」逻辑，让它按新配置重起一次即可（点桌面「QQ机器人」快捷方式最省事，不必重启整个 DSH）。`;
    }
    return `有 ${mismatch.length} 个工具刚刚改过、MCP 可能还在同步：${mismatch.join('、')} —— 工具开关是热生效的，通常不到 1 秒。若一直这样，看一眼 MCP 进程是否还活着（PID ${snapshot.pid}）。`;
  }
  return hot
    ? `工具开关与 MCP 实际注册一致（热生效，快照 ${snapshot.at}，PID ${snapshot.pid}）。`
    : `工具开关与 MCP 实际注册一致（快照 ${snapshot.at}，PID ${snapshot.pid}）。`;
}
