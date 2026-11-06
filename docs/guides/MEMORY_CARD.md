# 记忆卡：她跨会话记得什么

> 角色卡（`roles/小鲸鱼.md`）回答「她是谁」，记忆卡回答「她记得什么」。
> 角色卡是**每次都整份注入**的，记忆卡是**挑一小段注入**的——因为前者是设定，后者会无限增长。

## 一、它和「社交记忆」不是一回事

仓库里有两套记忆，别混：

| | 社交记忆（旧） | 记忆卡（本页） |
| --- | --- | --- |
| 工具 | `qq_memory_append` / `qq_memory_query` 等 | 无 MCP 工具，进站消息自动记 |
| 范围 | **按会话**（私聊 A 看不到群 B 的记忆） | **全局**，跨会话跨重启 |
| 内容 | 她想主动记下的：进行中的话题、想说没说的话、对某人的印象 | 从聊天里沉淀的：谁说过什么、答应过什么、闹过什么别扭 |
| 注入 | `formatMemoryV2()` 渲染成一两行 | `renderMemoryCard()` 渲染成【记忆卡】块 |
| 存哪 | 各会话的 `social-v2.json` | `state/memory-card.json` |

两套可以同时存在，互不覆盖。

## 二、存哪、什么时候写

- `state/memory-card.json`：卡片本体（`{version, records[], lastDecayDate, stats}`）。**用户数据，不要手改、不要删**。
- `state/memory-inbox.jsonl`：入站消息的**缓冲**。收消息时只追加一行（同步、便宜），真正的打分/去重放在维护循环里做，避免每条消息都读一次卡片文件。
- 维护循环每 10 分钟跑一次（`MEMORY_CARD_MAINTAIN_MS = 600000`），启动时也跑一次：先 drain inbox，再按天衰减 + 必要时压缩；**有变化才落盘、才重渲染**（所以空卡启动时日志里什么都没有，这是正常的）。

一条入站消息会被跳过、不记忆的情况：`/` 开头的命令、纯 `[图片]`/`[表情]` 这种占位、非主人发的且短于 `minChars` 的碎话。

## 三、什么值得记（`scoreMemory`）

基础分 8，然后加：

| 情形 | 加分 |
| --- | --- |
| 主人私聊里说的 | **+45** |
| 主人在群里说的 | **+30** |
| 直接对她说的（@ / 引用她 / 私聊） | +8 |
| 情绪强烈（"崩溃""气死""太好了"…） | +0 ~ +24 |
| 第一次发生（第一次约她、第一次提某件事） | +30；若同时是主人说的 ⇒ 直接 100 分并**置顶** |
| 承诺（"以后…""记得…""每天…""答应你"） | +16 |
| 前后矛盾（"但是/其实/之前说"） | +14 |
| 关于她自己（"你是…""你像…"） | +5 |
| 太短（短于 `minChars` 且不是主人） | −12 |

夹到 1~100。类型（`kind`）按顺序取第一个命中的：`first` → `owner` → `emotion`（情绪 ≥14 分才算）→ `conflict` → `promise` → `event`。

写进卡片之前会**脱敏**（`redactForMemory`）：QQ 号 → `[号码已隐藏]`、手机号、邮箱、`sk-`/`ghp_` 类密钥、`密码/token/密钥` 后跟的值、URL → `[链接]`。记忆卡是长期文件，不能变成密码本。

## 四、清晰度与衰减（`targetClarity` / `applyDailyDecay`）

五档：`vivid` 清晰 / `clear` 较清楚 / `fuzzy` 有点模糊 / `trace` 只剩影子 / `forgotten` 忘了（不注入，压缩时才真删）。

- **置顶（pinned）永远是 `vivid`**。
- 主人说的重要事（`isOwner && importance ≥ minOwnerImportance`，默认 50）和「第一次」衰减很慢（`penaltyRate 0.12`），普通琐事衰减快（0.35）。
- 超过 `forgetAfterDays`（60 天）、重要度 <50、又不是主人重要记忆/第一次的，直接 `forgotten`。
- 其余按 `retention = importance + recall×2（≤12）+ 新鲜度加成（7 天内 +18、2 天内再 +8）− 年龄惩罚` 分档：≥68 vivid、≥46 clear、≥24 fuzzy、≥12 trace。
- **一天只降一档**（同一天重复调用不再降），所以不会睡一觉起来忘光；补跑最多算 30 天（`decayDaysBetween` 封顶），关机一个月回来也只降一档。
- 只在本地时间 4 点后跑（`dailyHour`），避免刚过零点就把「今天」算成旧账。

## 五、压缩（`compactMemoryCard`）

- 触发：总字数超过 `warnChars × 0.9`（默认 24000 × 0.9 = 21600），或记录数超过 `maxRecords`（400）。
- 目标：压到 `warnChars × compactTargetRatio`（约 20400 字）。
- 顺序：先删 `fuzzy`/`trace` 的旧记录（真删，降清晰度不减字数，只降档腾不出预算），再继续按低分淘汰；**最多 12 轮**，保护 `pinned`、主人重要记忆、「第一次」。
- 压缩是**有损**的：删掉就是删掉，没有回收站。想留的用控制台 `pin` 住。

## 六、注入（`renderMemoryCard`）

每次唤醒拼进提示词（`buildWakePromptV2` 里 `memoryLine` 之后），形如：

```
【记忆卡】
◆ 关于主人
- 今天 主人：以后每天记得提醒我喝水，别老熬夜
◆ 答应过的事
- 3 天前 主人：周末陪我看那部剧（有点模糊）
```

- 分区顺序：`◆ 最初`（第一次）→ `◆ 关于主人` → `◆ 答应过的事` → `◆ 闹过的别扭` → `◆ 记得你的情绪` → `◆ 最近记得`。
- 排序：置顶 → 重要度 → 最近提到。
- **预算只看正文行**：`injectMaxChars`（默认 1200 字）；标题和分区头不占预算。超预算的行直接丢，末尾补一句 `（另有 N 条更旧的记忆，已经想不太起来了）`——让她知道"还有些事想不起来了"，而不是以为那就是全部。
- 单条正文超过 60 字会截断成 59 字 + `…`（防止一条长文吃掉整个预算）。
- 卡片是空的 ⇒ 渲染结果为空串 ⇒ 提示词里不会出现空标题。

## 七、控制台接口

都走 `GET/POST /api/memory-card*`，鉴权与控制台一致（`x-console-token`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/memory-card` | 状态统计 + 当前渲染结果 + 最近 200 条记录 + 生效配置 |
| POST | `/api/memory-card/maintain` | 立刻 drain + 衰减 + 压缩一次（不用等 10 分钟） |
| POST | `/api/memory-card/add` | 手动记一条：`{text, speaker, isOwner, pinned, importance}` |
| POST | `/api/memory-card/record` | 管单条：`{id, action: "pin"｜"unpin"｜"delete"}` |

例：

```bash
curl -H 'x-console-token: <token>' http://127.0.0.1:3100/api/memory-card
```

> ⚠️ Windows 上发中文 JSON 别直接写在命令行里（会变成 GBK 乱码）：先写成 UTF-8 文件，再 `curl --data-binary @文件`。

## 八、配置（`config.json` 的 `memoryCard`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉就不记账、不注入（已有文件保留） |
| `injectMaxChars` | `1200` | 每轮注入的正文预算（字） |
| `maxRecords` | `400` | 条数上限，超了触发压缩 |
| `warnChars` | `24000` | 总字数警戒线，×0.9 触发压缩 |
| `autoCompact` | `true` | 关掉就只报警不自动删 |
| `compactTargetRatio` | `0.85` | 压缩目标 = warnChars × 该值 |
| `forgetAfterDays` | `60` | 超过这么多天的低重要度记忆直接忘掉 |
| `fuzzyAfterDays` | `7` | 几天后开始变模糊（衰减曲线起点） |
| `minOwnerImportance` | `50` | 主人记忆的"重要"门槛，达标的不会被压缩删掉 |
| `minChars` | `4` | 非主人消息短于这个长度不记 |

想彻底关掉：`"memoryCard": { "enabled": false }`，重启桥接生效。

## 九、边界（v1 明确不做）

- **没有 MCP 工具**：她不能主动"想起"或"写下"长期记忆，只有入站消息自动沉淀 + 控制台手动加。
- **只从 `reserved2` 入站接记忆**（一代 `chat` 模式不记）。
- 控制台**没有记忆卡页面**，只有上面的 JSON 接口。
- 衰减/压缩是**按天、有损**的，不提供撤销。

## 十、测试

`scripts/test-memory-card.mjs`（列在 `npm run test:audit` 里）10 项：打分排序、脱敏、去重、衰减、一天只降一档、压缩保护、渲染预算、条数上限、**接线断言**（bridge.js 真的 import/调用/拼进提示词，两个端点都在，config.example.json 有 memoryCard）、状态统计。

纯函数全绿但没接线是这类功能的典型失败形态，所以接线断言和纯函数测试写在同一个脚本里。
