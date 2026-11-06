# 每日额度（tokenBudget）

> 一句话：**今天花超了就别再主动开口**。80% 提醒她收敛，100% 直接掐掉主动机会检查。
> 代码：[src/token-budget.js](../src/token-budget.js)（纯函数）；接线在 [src/bridge.js](../src/bridge.js)。

## 一、为什么需要它

桥接每主动开一次口，就是一次完整的 DSH 回合（人格卡 + 记忆卡 + 目的 + 收束全都要重新投喂），
一天主动几十次，账单会自己长出来。而「今天还能不能开口」这个判断如果只靠人盯控制台，
结局一定是事后才发现超支。

所以做成两件事：

1. **两个单位各自设线**：人民币（`dailyCny`）和 token 数（`dailyTokens`）。谁先到线谁生效，
   两个都设也不冲突——省钱的人和管配额的人关注的东西本来就不一样。
2. **两档动作**：到 `warnRatio`（默认 0.8）**只提醒不拦**（提示词里加一句「省着点」）；
   到 `stopRatio`（默认 1）才**拦**：不再安排主动机会检查，并明确要求「非必要不开口」。
   被动回复永远不拦——主人叫她，她必须能应。

## 二、判定口径

| 项 | 口径 | 说明 |
| --- | --- | --- |
| 「今天」 | **本地自然日**（零点切） | 不是滚动 24 小时，方便对账时心算 |
| 用量来源 | token 账本的逐桶序列（`tokenLedger.series({hours:26})`） | 只累加 `t >= 本地零点` 的桶；**跨零点那一桶整桶不算**（宁少算不多算） |
| 缓存 | 60 秒 | 拼提示词时现算太贵，为此拖慢回复不值得 |
| 单位比较 | 金额、token 各自算比例，取最大 | `dailyCny: 8` + `dailyTokens: 5000000`，token 到 120% 就是 stop |
| 关闭方式 | 两个单位都留 `null`，或 `enabled: false` | 判定结果 `off`，提示词里一个字符都不占 |

## 三、两档动作

| 档位 | 触发 | 提示词里说什么 | 还主动吗 |
| --- | --- | --- | --- |
| `ok` | 都低于 warnRatio | 什么都不说（空串，不占预算） | 是 |
| `warn` | 任一单位 ≥ warnRatio | 「今天额度快到了 … 省着点：回复短一点，别主动挑话头」 | 是（但会收敛） |
| `stop` | 任一单位 ≥ stopRatio | 「今天的额度用完了 … 非必要不要再开口」 | **否**：`scheduleProactiveCheckV2` 直接 return（每小时最多一条日志） |

`gateProactive: false` 可以只提醒、不掐主动机会（有些部署希望「知道归知道，别替我做决定」）。

## 四、配置

```json
"tokenBudget": {
  "enabled": true,
  "inject": true,
  "gateProactive": true,
  "dailyCny": 8,
  "dailyTokens": null,
  "warnRatio": 0.8,
  "stopRatio": 1,
  "promptMaxChars": 320
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后判定恒为 `off` |
| `inject` | `true` | 是否把提醒写进唤醒提示词 |
| `gateProactive` | `true` | 到 100% 是否停掉主动机会检查 |
| `dailyCny` | `8` | 元；`null` = 不限额。也接受 `"¥8"` 这种字符串 |
| `dailyTokens` | `null` | token 数；接受 `8000000` / `"8M"` / `"2万"` |
| `warnRatio` | `0.8` | 收敛到 0.05–0.99 |
| `stopRatio` | `1` | 收敛到 0.5–5（允许「提前刹车」，也允许「留 20% 缓冲」） |
| `promptMaxChars` | `320` | 提示词里那段话的硬上限 |

账户金额与单价来自 `pricing`（见 [TOKEN_USAGE_CONSOLE.md](TOKEN_USAGE_CONSOLE.md)），
额度本身**不记账**：它只读账本，不改账本。

## 五、端点

`GET /api/budget`（仅控制台；带 `x-agent-token` 会被 403 拒）

```json
{
  "ok": true,
  "day": "2026-10-28",
  "dayStart": 1793030400000,
  "usage": { "cost": 1.8675, "tokens": 19909082 },
  "level": "ok",
  "ratios": { "cny": 0.23, "tokens": null },
  "hits": [],
  "blocked": false,
  "summary": "budget ok（¥1.87 / ¥8.00）",
  "line": "",
  "alertDay": "",
  "config": { "…": "…" }
}
```

`line` 就是此刻会被拼进提示词的那段话（空串 = 不占预算），排障时先看它。

## 六、状态文件

`state/token-budget.json` 只存一件事：**今天提醒过没有**（`alertDay`）。

不存用量数字——数字每次从账本现算；存下来只会变成一份过期账，还会在账本被 `POST /api/tokens/reset`
重置后继续拦人。跨零点也不需要清：`alertDay` 与今天不同就重新可以提醒。

## 七、明确不做的事

1. **不拦被动回复**：主人直接说话时永远能回（额度是「少主动」，不是「装死」）。
2. **不按会话分摊**：额度是整台机器的总额，不区分群聊/私聊/黑话学习。
3. **不发 QQ 提醒**：只在日志、`/api/budget`、提示词里体现——花超了还发条私信告诉主人，本身就是一笔没必要的开销。
4. **不做滚动窗口**：自然日就是自然日，不搞「最近 24 小时」两套口径。
5. **不猜单价**：金额完全来自 `pricing` 账本，账本没有的价格不编。

## 八、测试

`npm run test:budget`（也在 `npm run test:audit` 里）：金额/token 输入解析、配置归一化与越界收敛、
off/ok/warn/stop 四档、双单位「谁先到线谁说话」、`inject:false`、每天只提醒一次、跨零点窗口，
以及 `src/bridge.js` 的接线断言（import / `cfg.tokenBudget` / 拼进 base 的位置 / `gateProactive` / `/api/budget`）。
