# case-001 桥接每 3 秒重连，却不说一句错

- **日期**：2026-10-18
- **影响**：QQ 机器人完全收不到 DSH 事件，群消息不回；控制台只有一行行「连接 DSH 事件流…」，看起来像在正常重试。
- **发现方式**：主人截图问「为什么接不上」，此前没有任何告警。
- **关联**：[PITFALLS P-006 / P-007 / P-008](../../PITFALLS.md)、[guides/DSH_DISCOVERY.md](../guides/DSH_DISCOVERY.md)

## 现场

控制台每 3 秒一行：

```
11:37:15 [bridge] 连接 DSH 事件流…
11:37:18 [bridge] 连接 DSH 事件流…
```

而 `GET /api/status?token=…` 里 `dshReady: false`，SnowLuma 侧 `connected: true`、`accountOnline: true`。
`state/bridge.log` 里「中断」出现 **0 次**。

## 排查（按证据推进，不猜）

1. `netstat -ano | grep 19387` —— **没有任何 LISTENING**。桥接在敲一扇不存在的门。
2. DSH 实际在 `127.0.0.1:51144`（PID 4524，进程名 `DeepSeek Harness`）。
3. `config.json:3` 写着 `"baseUrl": "http://127.0.0.1:19387"`；而 DSH 桌面版用 `--port 0`，端口由系统分配。
4. 为什么日志不报错？读 `src/dsh-client.js` 的 `_remoteMuxGenerator`：
   WebSocket 在 **open 之前**失败 → `handleClose/handleError` → `endStream()` → 生成器**正常 return**。
   `pumpMux()` 的 `for await` 于是正常结束，`catch` 永不触发，只剩 `await sleep(3000)` 再试。
   **失败被写成了"正常结束"**。

## 根因

- 端口是运行时变量，代码里当成了常量（配置/文档/体检脚本三处都写死 19387）。
- 失败路径与结束路径共用，且没有失败回调。

## 修复

- 新增 `src/dsh-discovery.js`：先探已知候选（env → config → 缓存 → 额外候选）**不带 Cookie**，
  无命中才 `netstat` 找监听进程（进程名像 DSH 的优先），命中后才用离线铸造的 Cookie 复验。
- `dsh-client.js` 增加 `onStreamFailure` 回调与 10s 连接超时，桥接打 `⚠️ DSH 事件流未建立…`。
- 桥接 `ensureDshEndpoint()`：启动、就绪前、事件流每轮各调一次；切换打 `🔎 DSH 端点已切到 …`。
- 状态落 `state/dsh-endpoint.json`，跨重启记忆；**不改主人手写的 `config.json`**。

## 验证

- 日志出现 `🔎 DSH 端点已切到 http://127.0.0.1:51144（原 …，来源 listen:DeepSeek Harness.exe，鉴权 正常）`，随后 `DSH 已就绪`。
- `/api/status` → `dshReady: true`，`dsh.source: listen:DeepSeek Harness.exe`。
- 用死端口单测 `onStreamFailure`：28ms 内回调 `reason: error-before-open`，生成器仍正常 return（证明必须靠回调而非 catch）。

## 教训

1. **端口、路径、profile 名都不是常量**；凡"只在这台机器上对"的值，都要能从环境推出来。
2. 断线必须有 **失败回调**，不能依赖异常；否则"重试"会变成"静默"。
3. 修复必须带**真机复查**：单测绿 ≠ 端口在听。

## 遗留

- 端口发现依赖 `netstat`，非 Windows 平台走候选列表（未在 Linux/macOS 实测）。
- `config.json` 里仍是旧 19387（故意），启动首轮会被判死并自动切换。
