# 对话收束：她什么时候该停下来

> 唤醒机制解决「什么时候开口」，这一页解决「什么时候闭嘴」。
> 代码只给建议，**说还是不说由模型决定**；但建议必须算得准，否则等于没提醒。

## 一、为什么需要它

reserved2 里「什么时候说话」是确定性调度（唤醒条件、静默观察、潜水定时器），
但「什么时候该停」过去完全靠模型自觉，实际会翻成两种错：

1. 对方已经说了「晚安」「先这样」，她还要补一句「好梦～」——收尾不收，像客服随访。
2. 话题早就枯了（对方只剩「嗯」「哦」），她每轮都硬接，越接越尴尬。

两种都是**该停没停**。反过来更糟的是另一种：对方明明问了话，她判成「聊完了」直接潜水，
变成已读不回。所以这套判定的最高优先级是**「有人还在等你说话」时永远不许收尾**。

## 二、判定输入与输出

输入是当前会话的 recentMessages（最近 window 条，默认 12），输出三选一：

| action | 含义 | 提示词里长什么样 |
| --- | --- | --- |
| `continue` | 正常聊，什么都没说 | **不注入**（不占提示词） |
| `linger` | 可以再等一条，别急着收，也别自己找话 | 两行「先别急着收（原因）」 |
| `close` | 到站了，可以打住 | 三行「已到站（原因）+ 别补晚安 + 想留尾巴记 pendingThought」 |

判定是纯函数（`src/conversation-closure.js`），不碰 fs、不写任何状态；`bridge.js` 只在
`buildWakePromptV2` 里取数、拼行。

## 三、六类信号

| 信号 | 触发条件 | 权重 |
| --- | --- | --- |
| `open-question` | **对方最后一句是问句** ⇒ 直接 `continue`，`score` 归零 | —（一票否决收尾） |
| `farewell` | 对方最后一句命中告别词（晚安/睡了/拜拜/先这样/我下了/去忙/干饭去…） | **直接 `close`**，不凑分 |
| `short-ack` | 对方最后一句 ≤6 字且是「嗯/好/行/收到/哈哈/6/牛/确实/ok/👌…」 | +2 |
| `cooling` | 距最后一条已过 `idleMs`（默认 5 分钟） | +2 |
| `shrinking` | 对方最后三条长度**严格递减**且末条 ≤10 字（兴致在退） | +1 |
| `awaiting-answer` | **最后一条是她自己且是问句**、对方还没答 ⇒ 禁止 `close` | —（最多 `linger`） |

判定：`score ≥ closeScore`（默认 5）且没有 `awaiting-answer` ⇒ `close`；
`score ≥ lingerScore`（默认 3）或 `awaiting-answer` ⇒ `linger`；否则 `continue`。

**告别为什么单独就 `close`**：凑阈值会让「晚安」这种最强信号恰好漏掉（4 分 < 5 分）。
显式告别不需要其他证据佐证，它本身就是结论。

**问句为什么一票否决**：判成收尾的代价不是「多说一句」，是「对方问了你没回」。
宁可多回一句，也不能把问句当句号。这一条在 `test-conversation-closure.mjs` 里被钉死
（包括「那晚安？」这种既是告别又是问句的写法）。

## 四、配置（`config.json` → `conversationClosure`）

```json
"conversationClosure": {
  "enabled": true,
  "inject": true,
  "closeScore": 5,
  "lingerScore": 3,
  "idleMs": 300000,
  "window": 12,
  "farewellWeight": 4,
  "shortAckWeight": 2,
  "coolingWeight": 2,
  "shrinkingWeight": 1
}
```

- `enabled:false` ⇒ 一律 `continue`（等于关掉整套判定）。
- `inject:false` ⇒ 照常判定、照常能在端点里看到结果，但**不写进提示词**（只观察不干预）。
- 数字都会被 `normalizeClosureConfig` 夹进合理区间（`closeScore` 2~20、`window` 4~40、`idleMs` 30 秒~24 小时），坏值回落默认。
- 改完重启桥接生效（这是进程内配置，不热更）。

## 五、怎么看它此刻判成了什么

```
GET http://127.0.0.1:3100/api/socialV2/closure?key=private:1000000001
```

返回 `action / score / openQuestion / signals / summary / line / config`；`line` 就是拼进提示词的那段文本
（`continue` 时为空串）。端点**只读**，不写状态、不触发发送。

## 六、边界（v1 明确不做的）

- **不加 MCP 工具**：她拿不到「查询收束状态」的工具，也不会因为判定为 `close` 被强制停止。
  收束的执行面就是「她不再说话」，而模型本来就能选择不说——加工具只会多一处白名单与回归成本。
- **不是潜水**：`close` ≠ `qq_set_wake_config` 进入潜水。前者是「这段聊完了」，后者是「怎么被叫醒」，
  两件事分开；判 `close` 之后她仍按自己的节奏决定是否设置唤醒条件。
- 不写 `nextOpening` 字段：想留尾巴用现成的 `qq_memory_append`（`pendingThought`），不另起一套存储。
- 只看 `recentMessages`，不跨会话聚合；群聊里多人接话时，判定只按「最后一条」算——所以它给的是
  提示不是判决，模型看到上下文会自动修正。

## 七、怎么验证

- 单测：`npm run test:closure`（`scripts/test-conversation-closure.mjs`，10 条用例，含接线断言）。
- 全量：`npm run test:audit`（该脚本已列入）；它会顺带证明 `audit-bridge-harness.mjs` 的 vm 注入没漏。
- 真机：改完重启 → 用上面的端点看 `action/signals` 是否符合预期 → 在私聊里说一句「晚安」，
  下一轮唤醒提示词里应出现「这段已经到站了」。
