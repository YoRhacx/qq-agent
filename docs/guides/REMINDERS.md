# 到点提醒全解（REMINDERS）

> 能力：**AI 可以在自己那个会话上排一条"到点提醒"**，到点后桥接把它**唤醒一次**，由模型用自己的语气说出来。
> 两个入口：**AI 工具** `qq_set_reminder` / `qq_list_reminders`（→ `POST|GET /api/socialV2/reminders`，带 `key` + 会话令牌）
> 与**操作者通道**（同一个端点，凭 `x-console-token`，可查任意 key）。
>
> ✅ 出厂默认**开**：`socialV2.tools.reminders=true`。它是**只影响自己那个会话**的低风险能力（不是外发消息工具），
> 与 `sendImage` / `sendVoice` 的"默认关"口径相反。
>
> 状态落在 `state/reminders.json`（可用 `socialV2.reminders.file` 改）；到期检查挂在**已有的 60 秒调度 ticker** 上。

---

## 一、它是怎么工作的（谁在什么时候说话）

1. AI 调 `qq_set_reminder`（或操作者打 HTTP）写一条提醒进 `state/reminders.json`；
2. 每 60 秒的 `startScheduleTickerV2` tick（**不是** 5 秒的 `socialLoopTick`，避免双触发）里：
   `store.due(Date.now())` 取出所有到点的条目 → 逐条投递 → 投递成功才 `markFired`（标记已触发）；
3. 投递 = `sendWakePromptV2(key, 'reminder:<id>')`：**唤醒 AI 一次**，提示词里带上"要提醒的事"，
   并要求它**用自己的语气顺口说一句**（明确写了不要用"叮！提醒事项："这种闹钟腔）；
4. 提示词由 `buildWakePromptV2` 的 `reminder:` 分支按 **id 回 store 查**（不是读共享槽位），
   所以繁忙期两条提醒排队也不会串味。

**为什么是"唤醒"而不是桥接直接播报**：提醒这件事的价值在于"像人自己想起来了"，而不是定时器播报；
同时它天然继承了苏醒链路里的沉睡前观察（说完要按规矩收尾），不会多出一条绕过收尾的外发通道。

## 二、到点之后到底发没发（三种状态 + 兜底规则）

`sendWakePromptV2` 返回 `'sent' | 'queued' | 'skipped'`，提醒侧据此决定"算不算投递成功"：

| 结果 | 含义 | 提醒侧动作 |
| --- | --- | --- |
| `sent` | 提示词真投给 DSH 了 | 清槽位 + `markFired` |
| `queued` | 会话繁忙，原因已进 `pendingWakeReasons`，稍后由补投路径真正唤醒 | 清槽位 + `markFired`（补投时按 id 回查文本） |
| `skipped` + `ratelimit`（自限性） | 唤醒频率超限 | **退化为直发** `⏰ 提醒：<内容>`（`sendToQQ`）；`lastSendSucceeded(key)` 为真才 `markFired`，失败就留给下个 tick 重试 |
| `skipped` + 人工意图原因 | `socialV2.enabled=false` / 已暂停 / 非 reserved2 / 不在允许范围 / 静默模式 / 投递被拒 | **不兜底、也不标已触发**：留着待发，条件恢复后补投（超过 `graceMs` 再由下面的分支收尾） |

两条硬规矩：

- **迟到超过 `graceMs`（默认 10 分钟）只标记、不发送**：半夜关机/进程没起时不补发一句"该吃药了"——
  补发比不提醒更糟。
- **同一 tick 内用内存 Set 防重入**；`due()` 是只读的，投递是异步的，没有这层同一条会被处理两次。

## 三、硬边界（代码里拦掉的，不是建议）

| 情况 | 结果 |
| --- | --- |
| `key` 不是 `group:<数字>` / `private:<数字>` | ❌ 400 `key 格式应为 group:群号 或 private:QQ号` |
| `dueAt` 在过去 / 距现在 < 1 秒 | ❌ 400 `提醒时间太近：至少要排在 1 秒后` |
| `dueAt` 超过 90 天 | ❌ 400 `提醒时间太远：最多只能排到 90 天以内` |
| 既没给 `dueAt` 也没给 `afterMs` | ❌ 400 `缺少提醒时间` |
| `afterMs` 非数字 / < 1000 | ❌ 400 `afterMs 必须是毫秒数` / `提醒时间太近` |
| `dueAt` 不是毫秒数也不是能解析的 ISO 串 | ❌ 400 `dueAt 无法解析：请给毫秒时间戳，或 ISO 时间字符串` |
| `text` 为空 / 去空白后 > 200 字 | ❌ 400 `text 不能为空` / 长度报错 |
| `repeat` 不是 `none`/`daily`/`weekly` | ❌ 400 `repeat 只能是 none / daily / weekly` |
| `action` 不是 `add`/`cancel`/`cancelAll` | ❌ 400 `action 只能是 add / cancel / cancelAll` |
| `cancel` 没给 `id` | ❌ 400 `cancel 需要 id（用 qq_list_reminders 查）` |
| 单会话待触发 ≥ `maxPerKey`（默认 50） | ❌ 400 `…的待触发提醒已达上限 50 条` |
| 全局 ≥ `maxTotal`（2000） | ❌ 400 `提醒总数已达上限 2000 条` |
| AI 拿**别的会话**的 key（令牌不匹配） | ❌ 403 `agent token 无效` |
| AI 调用不带令牌 | ❌ 403（外层鉴权 `智能体调用必须携带有效的会话令牌`） |
| `tools.reminders=false` 时的 AI 调用 | ❌ 403 `工具未启用：qq_set_reminder / qq_list_reminders`（操作者通道不受影响） |

## 四、配置项

```json
"socialV2": {
  "tools": { "reminders": true },
  "reminders": {
    "maxPerKey": 50,
    "maxHorizonDays": 90,
    "graceMs": 600000
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tools.reminders` | `true` | AI 工具 `qq_set_reminder` / `qq_list_reminders` 的开关（控制台勾选写这里） |
| `reminders.maxPerKey` | `50` | 每个会话最多待触发条数；钳在 1~200 |
| `reminders.maxHorizonDays` | `90` | 最多能排到多少天以后；钳在 1~365，换算成模块的 `maxLeadMs` |
| `reminders.graceMs` | `600000`（10 分钟） | 迟到超过它就**只标记不发送**（防半夜补发） |
| `reminders.file` | `state/reminders.json` | 状态文件；相对路径按仓库根解析，绝对路径原样使用 |

模块层的默认上限（`REMINDER_LIMITS`，可被上面的键覆盖）：`minTextChars 1`、`maxTextChars 200`、
`minLeadMs 1000`、`maxLeadMs 90 天`、`maxPerKey 50`、`maxTotal 2000`、`maxCreatedByChars 64`。

## 五、状态文件与幂等

- 结构：`{ version, items: [...] }`，每条是 `{id, key, text, dueAt, repeat, createdBy, createdAt, firedAt?, lastFiredAt?}`；
  按 `dueAt` 排序落盘，tmp + rename 原子写。
- **懒加载 + 单例**：进程里只有一份内存状态（`due()`/`markFired()` 的判据都在内存里）；
  `createRemindersStore()` 创建时读一次盘，坏文件会**备份成 `*.corrupt-<时间戳>`** 并按空库启动，警告进 `warnings[]`。
- `id` 是 `r` + 6 位 base36（如 `r0a3f9x`）：短到能在 QQ 里手打（`取消 r0a3f9x`），撞了重试。
- `repeat` 语义（`markFired` 时决定）：
  - `none` → 记 `firedAt`，视为完成，`due()`/`list()` 不再返回它（等 prune 清理）；
  - `daily` / `weekly` → `dueAt` **顺延到第一个还没到的时刻**（积压多次触发不补发，开机只算一次）；
  - 幂等：对已完成的项再 `markFired` 一次不会重复计数、也不重复写盘。
- `prune` 会清掉已完成的一次性提醒（`doneKeepMs` 默认 0，即立刻清）。

## 六、做不了 / 没做

- **没有"桥接直接播报"模式**：到点一律走唤醒，模型不发言就没有 QQ 消息（这是有意的，见第一节）。
- **没有自然语言时间解析**：`dueAt` 只接受毫秒时间戳或 ISO 字符串，`afterMs` 只接受毫秒——
  "明天早上八点"由模型自己换算（它知道当前时间，`dueText` 也会回显本地时间）。
- **重复提醒没有次数上限**：`daily`/`weekly` 一直顺延到被 `cancel`；要停就取消。
- **没有控制台面板**：操作者入口是 HTTP 接口（见下），界面面板未做。

## 七、操作者通道

```bash
# 加一条（TOKEN 见 config.json 的 consoleToken）；操作者可以操作任意 key
node -e "fetch('http://127.0.0.1:3100/api/socialV2/reminders',{method:'POST',headers:{'content-type':'application/json','x-console-token':process.env.TOKEN},body:JSON.stringify({key:'group:123456',text:'提醒他吃药',afterMs:600000})}).then(r=>r.json()).then(console.log)"

# 列出 / 取消
node -e "fetch('http://127.0.0.1:3100/api/socialV2/reminders?key=group%3A123456&includeDone=1',{headers:{'x-console-token':process.env.TOKEN}}).then(r=>r.json()).then(d=>console.log(d.count,d.items.map(i=>[i.id,i.text,i.dueText])))"
node -e "fetch('http://127.0.0.1:3100/api/socialV2/reminders',{method:'POST',headers:{'content-type':'application/json','x-console-token':process.env.TOKEN},body:JSON.stringify({key:'group:123456',action:'cancelAll'})}).then(r=>r.json()).then(console.log)"
```

- 请求体：`{ key, action?, text?, dueAt? | afterMs?, repeat?, id? }`（`action` 缺省 `add`；
  `token` 对操作者不需要）。
- `GET` 支持 `includeDone=1` 看已触发的（审计用，含 `firedAt`）。
- ⚠️ **`?token=` 是控制台令牌**（外层全局鉴权优先读它）。会话令牌一律只走 `x-agent-token` 头——
  MCP 的 GET 工具也遵守这条，别把会话令牌塞进查询串，否则会在最外层 401。

## 八、测试

```bash
node scripts/test-reminders.mjs        # 纯模块层：store 的增删查改 / 边界 / 幂等 / 坏文件自愈
node scripts/test-reminders-http.mjs   # 端到端：真实 bridge.js + 假网关 + 控制台端口，不发真实 QQ 消息
```

`test-reminders-http.mjs` 覆盖：add / 列表（含 `dueText`/`inText`）/ cancel / cancelAll、`action` 缺省、
ISO 与 `afterMs` 与 `repeat`、非法 key、过去时间、超 90 天、缺时间、空 text、非法 `repeat`/`action`/缺 `id`、
AI 只能操作自己的 key（别的 key → 403）、AI 不带令牌 → 403、匿名 → 401、`tools.reminders=false` → 403、
**限流时走 `sendToQQ` 直发兜底并标记已触发**、**迟到超过 `graceMs` 只标记不发送**。
