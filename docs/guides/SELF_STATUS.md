# 自省全解（SELF_STATUS）

> 两个入口，共用同一个构造函数（`src/self-status.mjs` 的 `buildSelfStatus()`）：
> **AI 工具** `qq_self_status`（→ `GET /api/socialV2/self-status?key=&token=`）与
> **操作者通道** `GET /api/self-status`（控制台 / CLI，凭 `x-console-token`）。
>
> 这是**唯一的只读工具**，出厂默认**开**：`socialV2.tools.status=true`。它只回答"我现在是什么状态"，
> 不产生任何外发消息、不读写他人数据，所以不需要像 `sendImage` / `sendVoice` 那样默认关闭。

---

## 一、这个能力干什么

模型在群里说话前经常需要知道：现在是不是活跃模式？跑的是哪个模型？今天花了多少钱？缓存命中率怎么样？
这轮是怎么被唤醒的？待办提醒还有几条？以前这些都得靠 `qq_get_prompt` 附带的信息去猜，或者干脆猜错。

`qq_self_status` 把这些问题一次性收拢成**一段人话摘要**（喂给模型的 `text`）**加一份结构化数据**（`data`）：

- `text`：≤1200 字的纯文本，按 `【运行】/【SnowLuma】/【本会话】/【花费】/【额度与等待】/【其它】/【建议】`
  分段。模型拿到就能直接读，不需要自己拼字段。
- `data`：同名信息的结构化版本（见第三节），给控制台或人看的，**同一份输入**下与 `text` 一致。

它**不返回**原始日志、不返回群成员名单、不返回未读消息正文——那些走 `qq_get_unread_messages` /
`qq_get_recent_messages`。

## 二、为什么默认开启

1. **只读**：一次 HTTP 调用，读的是桥接自己内存里的计数器和会话记录，没有外发通道。
2. **越权面为零**：`key` 只用来定位"本会话"，AI 通道由 `agentTokenOk(key, token)` 把关，拿不到别的
   会话的令牌就看不到别的会话的状态。
3. **省 token**：比让模型反复调 `qq_get_prompt` + 自己数提醒条数便宜得多。

`socialV2.tools.status` 只影响 AI 工具；操作者通道不受它限制（见第七节）。

## 三、端点与参数

### AI 通道（GET + 查询串）

```
GET /api/socialV2/self-status?key=group:123456&token=<该 key 的会话令牌>
  x-console-token: <控制台令牌>      # 最外层全局鉴权认这个
  x-agent-call: 1
  x-agent-token: <该 key 的会话令牌>
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✅ | `group:群号` 或 `private:QQ号`；格式错 → 400 `key 格式应为 group:群号 或 private:QQ号` |
| `token` | ✅ | 该 key 的 `agentToken`。放查询串里（GET 没有 body）；请求头 `x-agent-token` 也要带 |
| `raw` | ❌ | `1` 时**额外**返回 `data`（默认 `data` 也返回，这个参数只是显式声明） |

响应：

```json
{
  "ok": true,
  "text": "【运行】模式 reserved2 · 模型 deepseek-chat …",
  "data": { "key": "group:123456", "mode": "reserved2", "model": "deepseek-chat",
            "provider": "qodercn", "costToday": 0.42, "cacheHitRate": 0.71,
            "wakeUsedMinute": 3, "wakeCapMinute": 10, "waiting": false, "busy": false,
            "pendingReminders": 1 },
  "warnings": ["low-cache-hit"],
  "truncated": false
}
```

### 操作者通道（GET，无 key 也行）

```
GET /api/self-status?key=group:123456   (key 可省略，省略时用 key 列表里的第一个)
  x-console-token: <控制台令牌>
```

操作者通道**不要求** `token`（控制台令牌已经是凭据），可以查任意会话；`key` 不存在时用默认会话。
返回体形状与 AI 通道完全一致。

## 四、MCP 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `qq_self_status` | `key`、`token`（会话令牌） | `text` 摘要 + `data` + `warnings` |

工具描述里写明"只读、不发送任何消息"，因此模型可以放心地在每轮开头调一次。

## 五、上限与 best-effort

- **长度**：`text` 硬上限 **1200 字**（`SELF_STATUS_MAX_CHARS`）。超长会按段截断并把 `truncated` 置 `true`，
  同时在 `warnings` 里说明截断原因——不会静默丢信息。
- **花费是 best-effort**：`costToday` 来自按天累计的用量统计（`data/usage-*.json` 之类）。
  文件缺失、解析失败、当天还没有任何调用时，**`costToday` 为 `null` 且 `【花费】`整段省略**，
  绝不编一个 `0` 出来骗模型（`0` 和"不知道"是两件事）。
- **缓存命中率**：只有累计轮数 ≥ 3 时才给判断（样本太少不算数）。
- **唤醒额度**：`wakeCapMinute<=0` 视为不限流，`【额度与等待】`里不显示百分比。
- **不抛错**：任何一项拿不到就省略，端点始终 `200`。

## 六、`data` 字段

| 字段 | 类型 | 拿不到时 |
| --- | --- | --- |
| `key` | string | 必有 |
| `mode` | `'reserved2'` / `'closed-agent'` | 必有 |
| `model` / `provider` | string | `null` |
| `costToday` | number（元） | `null`（当日无记录） |
| `cacheHitRate` | number 0~1 | `null`（样本不足） |
| `wakeUsedMinute` / `wakeCapMinute` | number | `null` |
| `waiting` / `busy` | boolean | `false` |
| `pendingReminders` | number | `0` |

## 七、建议段的告警码

`【建议】`段是给人看的行动建议；没有告警时它输出"一切正常，按角色正常说话即可"。
告警码同时出现在 `warnings` 数组里：

| 告警码 | 触发条件 | 建议做什么 |
| --- | --- | --- |
| `provider-not-cache-friendly` | 当前 provider 不是 `qodercn` / `deepseek`（缓存友好的一档） | 换回缓存友好 provider，否则每轮都在重新计费 |
| `low-cache-hit` | 命中率 < 50% 且累计轮数 ≥ 3 | 检查前缀是否被 MCP 工具结果/时间戳等易变内容污染 |
| `cost-warn` | `costToday >= 3` 元（`SELF_STATUS_COST_WARN_YUAN`） | 当天花费偏高，考虑降频或换模型 |
| `wake-quota-low` | 本分钟唤醒用量 / 上限 ≥ 80% | 快要被限流了，少说两句，把"值得说的话"留给关键回合 |
| `bridge-not-ready` | 会话处于 `paused`，或 `dshReady === false` | 桥接没准备好，此刻发的消息可能丢；先等再发 |

## 八、常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `HTTP 401 未授权：请提供控制台访问令牌` | 没带 `x-console-token`（最外层全局鉴权先拦了） | 每个请求都带控制台令牌 |
| `HTTP 403 agent token 无效` | `token` 不是这个 `key` 的会话令牌（越权） | 用 `key` 自己那一份令牌，别串会话 |
| `HTTP 403 工具未启用：qq_self_status` | `socialV2.tools.status=false` | 控制台把它打开（或改 `config.json`） |
| `HTTP 400 key 格式应为 group:群号 或 private:QQ号` | key 写成了裸群号/`群:123` | 补成 `group:` / `private:` 前缀 |
| `HTTP 429` | 自省也有频率上限（防模型每轮狂调） | 等一会儿；它本来就是低频工具 |
| `text` 里 `【花费】`整段不见了 | 当日用量文件缺失/解析失败（best-effort） | 正常现象；要核对就去控制台看用量页 |
| `truncated: true` | 摘要超过 1200 字被截断 | 正常现象；需要细节就去看 `data` 或控制台 |

## 九、相关文件与测试

- 构造函数：`src/self-status.mjs`（`buildSelfStatus()`、`SELF_STATUS_MAX_CHARS=1200`、
  `SELF_STATUS_COST_WARN_YUAN=3`、`humanAgo()`、`humanDelta()`）。
- 端点与工具：`src/bridge.js`（`/api/socialV2/self-status`、`/api/self-status`）、
  `src/mcp-snowluma-safe.js`（`qq_self_status`）。
- 会话令牌与开关：`src/bridge.js` 的 `agentTokenOk()`、`v2ToolEnabled('status')`；
  控制台可写 `socialV2.tools.status`。

```bash
node scripts/test-self-status-http.mjs    # 离线：真实 bridge.js + 假网关，不发任何真实 QQ 消息
```

覆盖：纯函数（分段/`data`/1200 字截断/五个告警码/缺字段降级）、AI 通道成功路径、
操作者通道、跨会话越权 403、缺令牌 403 / 缺全局令牌 401、参数非法 400、
`tools.status=false` 时 AI 403 而操作者通道不受影响。
