# 行为与拟人化（她像不像人、说什么、什么时候说）

> 这份文档回答的是**行为**问题：她多久回一次、被 @ 了要不要立刻回、冷场时会不会主动说话、
> 别人让她做事她会不会答应、**她嘴上会不会把"后台/工具"抖出来**。
> 涉及文件、生效时机、以及那个最容易踩的坑（两层不是一回事）都在这里。

---

## 一、先搞清楚两层：改哪一层，什么时候生效

| 层 | 文件 | 里面是什么 | 生效时机 |
| --- | --- | --- | --- |
| **人格层** | `roles/小鲸鱼.md` | 角色卡全文（§一~§二十几）：说话铁律、长度、语气、什么时候别回 | 桥接**每条消息前注入**（`src/bridge.js:287` 附近注释写明「热生效，无需重启 DSH」）⇒ **改完下一轮就见效** |
| **仿真层** | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | preset 的 `persona.prefix`：发送禁令、新能力速查、回复节奏 | DSH 在**会话创建时**装配（`src/bridge.js:405` 附近）⇒ **改完必须重建 patch + 重启 DSH + 新会话**，否则跑的还是老提示词 |

仿真层的交付链（别手改产物）：

```text
dsh/agent-presets/qq-chat-v2/agent.cordis.yml      ← 权威源（改这里）
        │ node scripts/build-agent-preset-patches.mjs
        ▼
plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml  ← 产物（别手改）
        │ 作为 DSH bundle patch 安装（plugins/qq-agent-presets/package.json 的 dsh.bundle.patch）
        ▼
DSH 会话创建时装配进 agent
```

自检：`node scripts/test-agent-preset-patches.mjs`（末行 `✅ agent preset patch 契约通过`）。

### 1.1 还有第三层：MCP 工具开关（曾经是冷的，2026-10-12 已改成热生效）

这是主人 2026-10-12 问「控制台改完保存是否热生效」时查出来的一个**反直觉的例外**，
当天做了改造，现在它和控制台其余参数一样是热的：

| 改什么 | 热不热 |
| --- | --- |
| 控制台里**所有**数值（唤醒窗口、接话冷却、配额、人格、语音…） | ✅ **热**：`POST /api/socialV2/config` 写盘后桥接**当场**用新值 |
| **工具开关**（「工具开关」分组里的 41 个勾选框） | ✅ **热**：MCP 进程发现 `config.json` 变了，当场 enable/disable 并发 `tools/list_changed`，DSH 重拉清单，通常不到 1 秒 |

它**曾经**是冷的（这段留着，免得改回去）：MCP 进程原先在启动时读一次 `config.json`
（`const cfg = loadConfig()`），据此决定**注册哪些工具**，之后再不读盘。于是出现两种
**肉眼看不出来**的错位：

- **关掉**某个工具 → 桥接调用期立刻 403，但**模型那边工具还在** —— 它的描述和参数 schema
  每次请求照发（白烧 token），模型还会去调它、然后拿到 403。
- **打开**某个工具 → **打开不生效**：注册期已经跳过它了，进程里根本没这个工具，模型看不到。

更隐蔽的第三种：有些工具外面套着父闸门（`socialV2.media/voice/sticker.enabled`），
闸门一关那行 `server.tool(...)` 根本不执行 ⇒ 该工具**既不在注册清单、也不在禁用清单**，
对账时最该报警的那条反而被吞成"未知"。

现在的做法是**全部注册 + 按活配置 enable/disable**（`src/mcp-snowluma-safe.js` 的
`desiredToolStates` / `applyToolStates`，父闸门登记在 `TOOL_PARENT_GATES`）：

- 停用的工具**不进** `tools/list`（SDK 的处理器按 `enabled` 过滤）⇒ **省 token 的效果一模一样**；
- 调用被停用的工具报 `disabled` 而不是 `not found` —— 对账靠这个区分"关了"和"压根没有"；
- 注册期到 `connect()` 之间、以及文件变化时的同步，都会发 `tools/list_changed`。

它为什么能立刻生效：DSH 侧订阅了 `notifications/tools/list_changed`
（`listChanged.tools.onChanged → refreshTools()`），收到就把整代工具注销、重新 `tools/list`
注册一遍（`dsh-mcp-client` 的 `syncTools`）。**不用新建会话** —— DSH 每个模型步都会重新装配
工具表（`systemPrompt.assemble()` 在 `preStep` 里调），真实会话日志里能看到这种中途变化被记成
`tool-addition` / `tool-removal` 事件。

为了不让人靠猜，控制台会自己摊开对账：

- 开关分组顶部一行汇总（文案由后端 `describeToolRegistry()` 统一给，控制台不另写一套）。
- 每个开关右侧一枚徽章：`· 已注册` / `· 未注册` / `⚠️ 开着但未注册` / `⚠️ 关了但还在` / `· 注册状态未知`。
  一个开关管多个工具时（`memory` 管 4 个）显示 `已注册 2/4`，不会只看第一个就下结论。
- 页面每 5 秒自查一次（`guardPoll('toolreg')`），保存成功后另外在 1.2 秒与 5 秒各复查一次 ——
  **这个延后是必须的**：MCP 侧走 fs.watch（120ms 去抖）+ 快照 60 秒心跳写盘，
  保存后同一毫秒去读必然拿到**上一代快照**，于是每个开关都被标黄、还容易被误读成"没保存上"。
  （2026-10-12 修：以前只在「加载配置」和「保存成功」两处刷新，于是那句"自动刷新后即消失"是假承诺 ——
  页面开着不动，黄标永远不会自己消失。）
- 例外：`qq_send_group_message` / `qq_send_private_message` / `qq_reply` 三个开关**故意**不登记进
  MCP 的工具开关表（它们同时服务 chat/reserved/closed-agent 三种模式，按 v2 开关注册会误伤别的模式）。
  所以它们恒为注册、永不出现在对账 `items` 里，徽章显示灰色的 **`· 仅调用期拦截`** ——
  关掉它们**不会**从模型清单里消失、也**不省 token**，只是在被调用时由桥接拒绝（403）。
- 端点：`GET /api/socialV2/tools`（**仅控制台可用** —— AI 通道 403，它不该拿管理信息对账）。

数据从哪来：MCP 进程每 60 秒把自己**真实注册的清单 + 此刻被停用的那些**写进
`state/mcp-tools.<pid>.json`（文件名带 PID：DSH 重启期可能有两个进程交叠，共用一份会互相覆盖；
一个刚起就退出的探针曾把在跑进程的快照盖掉，控制台随即显示"未知"）。桥接侧挑「**活着且最新**」
的那一份 —— 两个条件缺一不可：只看 PID 会被系统回收的 PID 骗到（旧号被新进程复用），
只看时间会把刚起就死的探针当权威。

热快照带 `hot: true`，对账逻辑据此区分两代语义（**这是最容易写错的一处**）：

| 快照 | 「模型能不能看到」怎么算 |
| --- | --- |
| 老进程（无 `hot`） | `registered` 里有就是有（那时注册即启用） |
| 新进程（`hot: true`） | `registered` 里有**且不在 `disabled` 里**才算 —— 只看 `registered` 会把"已关掉的工具"误报成"关了却还在" |

> 判定与文案都在 `src/mcp-tool-registry.js`（纯函数，可测），自检 `npm run test:mcp-tool-registry`
> （85 项：两代快照的可用性口径、四种 state、开关缺省即「开」、快照不可信时**绝不下结论**、
> 多份快照选活的、一个开关管多工具不漏判、端到端打 `GET /api/socialV2/tools`、以及**文案里
> 不许出现"必须重启 DSH"这种会让人白掐掉所有会话的说法**）。
> 「改完是否真的当场变」由 `npm run test:tool-hot-toggle`（23 项）钉住：它真起一个 stdio MCP
> 子进程 + 真 MCP Client，改配置后**不重起进程**，断言工具当场从清单消失/回来、且发出了通知。
> 「四处开关名单是否对齐」由 `npm run test:tool-flag-alignment`（19 项）钉住：同一个开关要同时出现在
> MCP 的 `TOOL_CONFIG_FLAGS`、控制台的勾选框、桥接的保存白名单、`SOCIAL_V2_TOOL_DEFAULTS`
> 出厂默认**四处**；少一处都不报错，只会安静地变成「界面上看不见 / 保存了不生效 / 关了也拦不住」
> （真实抓到过 `listenVoice` 没勾选框、`watchVideo` 关不掉），另有 `config.example.json` 必须键齐且值对
> （控制台读法是 `c.tools[k] !== false` ⇒ **键缺失 = 显示勾选**，会让新装用户看到反的初始状态）。

**实测**（2026-10-12，真 MCP 子进程）：关掉 `sendImage` ⇒ 清单 49 → 48、`qq_send_image` 消失；
调它报 `MCP error -32602: Tool qq_send_image disabled`；再打开 ⇒ 当场回到清单。

> ⚠️ 措辞会有两种，都是对的：**协议层**由 SDK 拦（英文 `` Tool X disabled ``，`-32602`），
> **桥接层**自己也有中文 `工具未启用：qq_xxx`（403）。竞态窗口里模型可能先看到英文那句 ——
> 这是"关掉"而不是"工具不存在"，不必当成故障。

### 1.2 什么时候还需要动进程

只有两种情况：MCP 进程跑的是**老代码**（快照没有 `hot` 字段），或者它**已经死了**。
那时点一下桌面「QQ机器人」快捷方式：`ensure-bot-env.mjs` 会按入口比新旧，把过期的 `mcp-*.js`
进程 `taskkill` 掉，DSH 约 1.7 秒后用新代码重拉 —— **不需要重启 DSH**，代价只是那一刻的在途调用失败一次。

> ⚠️ 0.1.7+ 已经改走 bundle patch，`~/.dsh/.agent-presets/qq-chat{,-v2}` **不存在**，
> 所以别照着老文档去改那个目录（改了没有任何效果）。

---

## 二、四条硬要求（2026-10-11 主人提的）

1. **不要有应就回**；被 @ 了也别马上就回 —— 「可以装死一小会再回」。
2. 别人让她做事，**可以先拒绝小几次**，后面才慢慢答应。
3. **冷场时要会主动分享歌**（平台随意，主要网易云）。
4. **绝不把"我在调 DSH 后台工具"说出来** —— 群聊里和对外私聊里一句都不许，**连管理员来问也不行**；
   **唯一例外是主人（`ikkk`）自己的那条私聊**（见第六节）。

其中 1、2、3、4 都在**两层里各写了一份**：人格层写「她自己的性格」，仿真层写「具体怎么用工具做到」。
两边都改是因为人格层热生效、仿真层能写工具用法，缺一边就会出现「知道该装死但不知道怎么等」或反过来。

---

## 三、「装死」是怎么落地的（两层保险）

### 保险 A：提示词层（人格层 §十九 / 仿真层【回复时机】）

被 @ 或被点名后，先别开口，用 `qq_wait_for_messages(purpose="reply", quietMs=15000~90000)` 把静默等掉。

**关键机制（不看会白写提示词）**：`purpose="reply"` 的静默是**从最后一条来信计时**的，
不是「从现在起再等 N 秒」——见 `src/bridge.js` 的 `replyTimingV2()`（回报 `remainingQuietMs = quietMs - elapsed`）
与 `/api/socialV2/wait` 处理里的 `lastNewAt`。也就是说：

- 唤醒延迟 + 读提示词已经吃掉了一部分，工具只**补足剩余**静默；
- 如果最后一条来信已经过了很久（比如主动机会唤醒、或补投唤醒），`quietMs` 会**立刻满足、直接返回**，
  这时它**制造不出延迟**。要真延迟，得靠下面的保险 B。

### 保险 B：结构层（不依赖模型听话）

唤醒延迟 = 合批窗口（**最短**时间）+ 随机抖动：

```js
// src/bridge.js
function wakeDelayMsV2(reason, batchWindowMs, random = Math.random) { … }
// 被消息叫醒：batchMs = base + floor(random * base)   →   窗口 8000 ⇒ 实际 8~16 秒
// 固定时刻唤醒：batchMs = base（**不抖**，提醒必须准点）
```

为什么要有抖动：「每次都在第 8 秒开口」本身就是另一种机器味；真人的回应时间是散开的。

- **不抖的白名单**：`bootstrap`（首帧）、`timeout`（睡眠到期）、`reminder:*`、`schedule:*`。
- **窗口 < 4000ms 不抖**：老部署的 `batchWindowMs: 2000` 行为完全不变。
- 固定时刻唤醒走的是 `setupSleepTimerV2` / 提醒 ticker，**不经过**合批窗口，所以不受影响。

调窗口的三种途径：

| 途径 | 说明 |
| --- | --- |
| 控制台 → 二代仿真 → 「合并窗口（毫秒）」 | 写全局默认 + 当前会话，热生效 |
| `POST /api/socialV2/wake-config` `{key, config:{batchWindowMs}}` | 校验 `>=1000`，夹取上限 `3600000`（`src/bridge.js:6706` 附近） |
| MCP 工具 `qq_set_wake_config` | AI 自己也能调（走同一个端点） |

> 改全局默认改的是 `config.json` 的 `socialV2.wake.batchWindowMs`，**只影响之后新建的会话**；
> 已经存在的会话把值存在 `state/social-v2.json` 里，要单独改（控制台或上面的端点）。

自检：`npm run test:wake-jitter`（57 项断言：抖动量域、白名单不抖、小窗口不抖、脏输入兜底、接线守卫）。

### 保险 C：接话冷却（`socialV2.reply.*`，2026-10-12 加的主要一道闸门）

抖动只能把「第 8 秒开口」变成「8~16 秒之间某个时刻开口」——**她还是每次都开口**。实测那天晚上
21 点那一小时里：群友 16 条、**她 21 条**；她接话 20 次里有 12 次是拆成 2~3 条发的。
所以又加了一道**真闸门**：她说完话之后，**被消息叫醒**的唤醒要等冷却走完才发。

```js
// src/bridge.js
function replyGapWaitMsV2(reason, lastAiReplyAt, replyCfg, now = Date.now()) { … }
// scheduleWakeV2 里：
const { baseBatchMs, jitterMs, batchMs: jitteredBatchMs } = wakeDelayMsV2(reason, st.wakeConfig?.batchWindowMs);
const gap = replyGapWaitMsV2(reason, st.lastAiReplyAt, cfg.socialV2?.reply);
const batchMs = Math.max(jitteredBatchMs, gap.waitMs);   // 取"更晚的那个"
```

| 配置项 | 出厂默认 | 管什么 |
| --- | --- | --- |
| `socialV2.reply.minGapMs` | `30000`（30 秒） | **普通消息**叫醒后的接话冷却（要 `anyMessage`/概率开着才有意义） |
| `socialV2.reply.minGapDirectedMs` | `12000`（12 秒） | 被 **@ / 叫名字 / 关键词 / 提问 / 指定成员 / 拍一拍** 叫醒后的最短间隔（"装死一小会"） |
| `socialV2.wake.softWakeCooldownMs` | `180000`（3 分钟） | 软闸门：**只挡** `anyMessage`/概率 这类普通消息唤醒（原来只写死在代码里读，现在也在界面上） |
| `socialV2.wake.softWakePerHour` | `6` | 软唤醒每小时的额度（定向唤醒不吃这个额度） |

**关键语义（别记错）**：

- **是"延后"不是"丢弃"**：消息照常进未读缓冲，冷却结束的那次唤醒会把它们一起看到。
- **固定时刻的唤醒一律不延后**：`reminder:*`（提醒）、`schedule:*`（定时）、`timeout`（睡眠到期）、
  `bootstrap`（首帧）——否则提醒会迟到。判定见 `isDirectedWakeReasonV2()` / `replyGapWaitMsV2()`。
- **被点名也算**：这正是主人要的「@ 了也别马上回」；只是给了个更短的 `minGapDirectedMs`，
  免得她像没听见。
- 设 `0` = 关掉这道闸门（退回只有抖动）；`cfg.socialV2.reply` 整个缺失时也等于关（缺省即关）。

**在哪改（主人 2026-10-12 明确要求「功能要有修改的界面」）**：控制台 → **二代仿真** →
「**接话频率与冷却（她多久才允许再开口）**」分组，四个输入框就是上表那四项；点本页的
「保存当前参数（写入 config.json）」**热生效，不用重启桥接**。保存路径是
`POST /api/socialV2/config`（控制台 `saveV2Config()`），桥接侧在 `src/bridge.js` 里归一化
（`reply.minGapMs`/`minGapDirectedMs` 非负取整、上限 1 小时），`softWakeCooldownMs`/`softWakePerHour`
走 `wake` 的数值归一名单（`src/bridge.js` 里 `POST /api/socialV2/config` 的 `for (const k of [...])` 一段）。

自检：`npm run test:reply-gap`（58 项：默认值、纯函数判定、`scheduleWakeV2` 接线
（真的看定时器时长）、控制台四个输入框与换算、两层提示词是否都在）。

### 保险 D：积压兜底（`socialV2.wake.backlogWakeAfter`，2026-10-12 方案 B）

**为什么光调概率不够（这段数学是这套设计的存在理由）**：纯「每条消息掷 p」的累积命中率是
`1-(1-p)^n`。p=0.12 时，5 条消息至少中一次只有 `1-0.88^5 ≈ 47%`，**不到一半**；孤零零一条消息
（n=1）更是 **88% 概率永远不回**——因为之后没有新消息，`evaluateWakeTriggerV2()` 再也不会被调用，
这条路永远不会补唤醒，只能等 `proactiveCheck`（间隔 30~90 分钟、群聊概率还要乘 0.5）来兜。
主人 m07680 的要求是「不是每条都回，**但不能一条不回**」，所以必须有独立的确定性兜底。

```js
// src/bridge.js
function backlogUnansweredV2(st) { … }        // 自她上次开口以来，未读里还没接的普通消息条数
const backlogAfter = Math.max(0, Math.round(Number(cfg.socialV2?.wake?.backlogWakeAfter) || 0));
if (backlogAfter > 0 && backlogUnansweredV2(st) >= backlogAfter && softWakeGateV2(st, kind) === 'ok') return 'backlog';
if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability) && softWakeGateV2(st, kind) === 'ok') return 'probability';
```

| 配置项 | 出厂默认 | 管什么 |
| --- | --- | --- |
| `socialV2.wake.backlogWakeAfter` | `3` | 群聊里自她上次开口后，攒够这么多条还没接的**普通消息**就必定唤醒一次（不再掷概率）。`0` = 关闭兜底 |
| `socialV2.wake.recommendedProbability` | `0.12` | 「适中频率」：新建会话的 `triggers.probability` 由它折算（**已有会话不受影响**，见下） |

**关键语义（别记错）**：

- **计数口径**：`st.unread` 里 `time > lastAiReplyAt` 且非 `isSelf`、非 `kind==='poke'` 的条数。
  用未读缓冲而不是新加计数器，是因为她 `qq_mark_read` / `qq_set_wake_config` 收尾时会按水位清空
  未读——正好等价于「这一堆她已经处理过了」，不需要第二份会跟缓冲打架的状态。
- **拍一拍不计入**：拍一拍自己就是定向触发（`triggers.poke`），重复计入只会让积压提前。
- **仍然过软闸门**：`softWakeGateV2`（冷却 + 每小时额度）照旧生效，所以「必定醒」不会变成话痨；
  被挡下的消息不丢，下一轮唤醒一起看。
- **顺序在概率之前**：攒够时原因必须是 `backlog`（提示词才会给「挑一条引用着回」的引导），
  不能被一次侥幸的骰子改写成 `probability`。
- **优先级 55**：高于 `anyMessage`(50)、低于 `keyword`(60)；且**不算定向唤醒**
  （走普通消息的接话冷却，否则会像被 @ 一样抢着回）。见 `WAKE_PRIORITY`。
- **只在群聊**：私聊永远 `return 'private'`，不走这一套。

**「攒了几条挑一条引用着回」**（主人 m07680 提出、m10890 迭代为「自主选择最有意思最有梗的那条引用回复」）
落在提示词两层：

- 人格层 `roles/小鲸鱼.md` §十七；
- 仿真层 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（改完要跑
  `node scripts/build-agent-preset-patches.mjs` 重建 patch）；
- 另外 `buildWakePromptV2()` 会在**群聊 + 软唤醒**（`backlog`/`probability`/`anyMessage`/`proactiveCheck`）
  且未读 ≥2 时注入 `【攒了几条】` 一行；被 @/叫名字/提问叫起来时**不给**这行（该回的是点名的人）。

### 主动引用与 @（主人 m10890）

新增 `quoteGuideV2(key, st)`（`src/bridge.js`，紧跟 `backlogUnansweredV2`），
`buildWakePromptV2()` 里以 `quoteLine` 注入 `base`，**只在群聊**给：

- **多人在找你**（未读里 ≥2 个不同的人 @她/叫她名字/提问/引用她）：注入 `【多人在找你】`，
  要求**分开回、各自引用**，不许一条消息应付两个人；
- **未读 ≥3**：注入 `【挑一条引用】`，挑最有话说最有梗的那条引用着回，不必非得是最新的；
- **未读 ≥1**：注入 `【该引用时就引用】`（只在不是接刚刚那条时）；
- 恒定注入 `【@ 怎么用】`：`atUserId` 是点名不是标点，一条消息最多 @ 一个人。

配套改动：唤醒提示词默认分支的「【引用：只在必要时用】」改为「【引用：主动挑一条】」；
`GET /api/socialV2/unread` 给每条「在找她」的未读补 `directedToMe` / `quotedMe` / `replyHint`，
并在响应顶层给 `askers` 与 `multiAsker`（≥2 人同时找她）。

**在哪改**：控制台 → **二代仿真** → 「接话频率与冷却」→「**攒够几条必醒（条）**」。

> ⚠️ **改 `recommendedProbability` 对已经存在的会话无效**。会话一旦被 `qq_set_wake_config` /
> `qq_mark_read` 写过，`confirmedBy` 就不再是 `'default'`，`refreshDefaultWakeConfigV2()` 会直接
> 跳过它（`src/bridge.js` 里 `if (st.wakeConfig.confirmedBy !== 'default') return false;`）。
> 要给某个群开概率，必须**显式**写那个会话的 `triggers.probability`（控制台对应输入框 /
> `POST /api/socialV2/wake-config` / `qq_set_wake_config`）；直接手改 `state/social-v2.json`
> 会被运行中进程的内存态覆盖。

自检：`npm run test:backlog-wake`（43 项：出厂默认与归一化、计数口径、触发顺序与软闸门、
`WAKE_PRIORITY`/定向判定、两层提示词、控制台输入框、`config.example.json` 完整性）。

---

## 四、先拒绝小几次（只写在提示词里）

人格层 §二十 + 仿真层【先拒绝小几次】。要点：

- 默认先不给，可以推掉 / 装傻 / 已读乱回；「小几次」通常 **1~3 次**，按事情轻重分级。
- **拒完要给**：只嘴硬不干活是摆烂，不是性格。
- 不许客服腔；越底线的事直接拒到底，不要「先拒后答应」地来回拉扯。
- 别无限循环推辞：拒过头就不是拟人，是坏掉了。

这一条没有结构性抓手（桥接无法判断「这件事该不该答应」），所以完全靠提示词。

---

## 五、冷场时主动分享歌

人格层 §二十一 + 仿真层【新能力速查】5.1。要点：

- 触发面：冷场 / 半天没人说话 / **主动机会唤醒**（`socialV2.wake.proactive`，见 `REMINDERS.md` 同族的 `proactiveCheck`）。
- 默认 `type:"163"`（网易云）；id **必须真实**，拿不准先搜再发。
- 配一句自己的话当 `text`，别播报（「给你推首歌」这种就是播报）。
- 频率克制：同一会话隔很久才一次；刚点过歌 / 刚发过卡片 / 群里正热时不要发；发完不许追问「好听吗」。
- 工具本身的规则（平台卡要过第三方签名、默认关、限流、`dryRun`）见 **[MUSIC.md](MUSIC.md)** —— 这里只管「什么时候该发」。

---

## 六、绝不暴露工具与后台（违反即严重违规；只有主人私聊是例外）

两层里都逐条列了**禁止词表**：任何工具名（`qq_wait_for_messages` / `qq_send_music` / `qq_group_admin` …），
以及 `桥接 / DSH / MCP / 控制台 / 后台 / 脚本 / 接口 / API / 端点 / 令牌 / token / 唤醒 / 额度 /
工具调用 / fetch failed / 报错 / 日志 / 重启` 这一类词。

- 要表达"失败"，用人的说法：没搜到 / 找不到 / 看不了 / 刚没看手机 / 走神了 / 网卡 / 懒得。
- **唯一例外：主人（`ikkk`）自己的私聊**（`private:<ownerQQ>`）。他就是这个后台的管理员，所以在那一条会话里
  她可以坦白"我背后是 DSH""我是被程序驱动的""刚才那几个调用失败了""我在等消息"，也可以说清自己在用什么工具。
  三条边界不变：① **群聊里、以及和任何别人私聊里绝不破例**（也不许用"这个我跟主人说过"来暗示）；
  ② **他问才说**，不主动刷后台日志；③ **凭据类不谈**（令牌 / token、账号密码、别人的隐私数据），任何地方都不谈。
  另外，主人也可以在**管理端 / 控制台**里直接看系统状态与工具日志（`GET /api/socialV2/tool-log`）—— 那本来就有看板，
  不依赖她开口。
- 实现落点（改这三处即可）：`roles/小鲸鱼.md` §二十二 的 `> 优先级极高` 提示块与第 2、3、5、7 条；
  preset `agent.cordis.yml` 的【绝不暴露工具、后台与"我是被程序驱动的"】整段；
  以及 **`src/bridge.js` 的 `buildWakePromptV2()` 里那行 `ownerLine`** —— 当 `key === private:<ownerQQ>`
  时，唤醒提示词会带上 `【会话身份】这是主人（ikkk，ownerQQ）自己的私聊……`。
  为什么要单独点名：**她不该靠 QQ 号去猜「这条私聊是不是主人自己的」**；群聊与别人的私聊里
  这行根本不会出现（`ownerQQ` 没配时谁都没有，fail-closed）。
  自检：`npm run test:owner-private-scope`（19 项：主人私聊有 / 群聊没有 / 别人私聊没有 / 未配 ownerQQ 没有）。
- 重点：这只改**她嘴上说什么**，不改变工具行为，也不隐藏日志。真要审计，看控制台的「工具日志」面板
  （`GET /api/socialV2/tool-log`）——**群里的人看不到，你随时能看到**。

---

### 六之一、身份泄漏守卫（2026-10-28 加，代码层兜底）

提示词管不住的，交给代码拦。`src/identity-guard.js` 在**出站端点层**再过一道：她要说的话里一旦出现
**第一人称 + 身份名词**的组合 —— `我是个 AI`、`我只是个程序`、`作为一个语言模型`、`我不是真人`、
`我的提示词里写着`、`我是被训练出来的`、`as an AI` —— 这条消息**不发出去**，而是被打回给模型重写，
同时记一条 `identity-guard` 活动（控制台能看到）。

- 为什么只认「第一人称」：`这个 AI 真强`、`你才是 AI 吧`、`我是程序猿`、`我是 DeepSeek 小鲸鱼，V 我 50`
  都是正常聊天，拦了反而出戏。实测回放 726 条真实出站消息，误伤 0。
- 覆盖六个文本出口：分条发送、单条发送、语音的 TTS 字幕、图片的附图说明、音乐卡的随卡话、旧版 `/api/send/*`。
  `qq_repeat_message`（+1 复读）**不拦** —— 它发的是别人的原话，不是她在自曝。
- **主人私聊也不豁免**：§二十二 第 7 条允许她跟主人对账「刚才那条我确实没发出去」，但仍然要求
  「别把自己说成程序/工具/被谁驱动的东西」，所以这里默认全局拦。真要放宽，在 `config.json` 里加
  `identityGuard.exemptKeys: ["private:<ownerQQ>"]`。
- 配置：`identityGuard: { enabled: true, mode: "block", exemptKeys: [] }`；`mode` 可选 `block`（默认，拦 + 打回）、
  `warn`（只记日志、照发）、`strict`（连「我没有感情」「我的人设」这类擦边球也拦）；`enabled: false` 或
  `mode: "off"` 全关。**改了 `src/bridge.js` / `src/identity-guard.js` 要重启桥接才生效。**
- 自检：`npm run test:audit` 里的 `test-identity-guard.mjs`（用例 + 接线断言）。

## 七、改完怎么验证

| 改了什么 | 怎么让它生效 | 怎么验 |
| --- | --- | --- |
| `roles/小鲸鱼.md` | 无需重启 | 下一轮回复里看；`npm run test:role-card` |
| preset `agent.cordis.yml` | `node scripts/build-agent-preset-patches.mjs` → **重启 DSH** → 新会话 | `node scripts/test-agent-preset-patches.mjs`、`npm run test:preset-prompt` |
| `src/bridge.js`（唤醒抖动） | 重启桥接（桌面快捷方式会自动判定） | `npm run test:wake-jitter` |
| `src/mcp-*.js` | **桥接重启没用**（MCP 是 DSH spawn 的）—— 点桌面快捷方式即可自动换新，见下节 | `npm run test:mcp-servers` |

---

## 八、附：她"调不动那个工具"（`qq_wait_for_messages` 长轮询）

**症状**：工具日志里 `qq_wait_for_messages => 等待失败：fetch failed`，但同一时刻
`qq_bridge_status` 显示 SnowLuma 已连接、心跳正常、读取/发送/标已读全都正常 —— 看起来像"只有等待接口坏了"。

**根因（实测）**：Node 全局 `fetch` 就是 undici，它给每个请求的 `headersTimeout` / `bodyTimeout` 默认都是
**300000ms**，而且**无法**从 `fetch` 选项里覆盖（undici 不作为公开模块导出，拿不到 Agent）。
规范里那句「沉睡前观察用 `timeoutMs=300000`」**正好压在 300 秒那一刻**：客户端比服务端先放弃，
抛出来的是 `TypeError: fetch failed`（不是 `AbortError`），从文案完全看不出是超时。
直连探测证实桥接服务端能撑满：`HTTP 200 耗时 300264ms timeout=true waitedMs=300245`。

**修法**（`src/mcp-snowluma-safe.js`）：预算超过 `UNDICI_SAFE_BUDGET_MS = 280000` 的请求改走
`agentApiRaw()` —— 用 `node:http` 直连（同样的 `x-console-token` / `x-agent-call: 1` / 错误语义，
外加 socket 空闲兜底），绕开 undici 的 300 秒上限。

**验证**：

```bash
npm run test:wait-longpoll        # 15 秒快烟，几秒出结果
npm run test:wait-longpoll:e2e    # 真的跑 300 秒档，断言 elapsed >= 290000
```

> 注意 MCP SDK 的 `Client` 自己还有一个请求超时（默认 60 秒，`DEFAULT_REQUEST_TIMEOUT_MSEC`），
> 那是**第三层**、只影响测试脚本自己：测试必须写 `client.callTool(args, undefined, { timeout: budgetMs + 60000 })`。
> DSH 那一侧不受影响 —— `~/.dsh/profiles/desktop/cordis.patch.yml` 给 `mcp-snowluma` 显式配了
> `toolCallTimeoutMs: 725000`。

**改 `src/mcp-*.js` 之后**：MCP server 进程是 **DSH 自己 spawn** 的（不是桥接的子进程），所以
重启桥接**不会**刷新它。三条路，按推荐顺序：

1. **点一下桌面的「QQ机器人」快捷方式就行**（`start-all.cmd` → `ensure-bot-env.mjs`）——
   它会**逐个入口**比对新旧：某个 `mcp-*.js`（含它 import 的本地模块，见 `MCP_SOURCE_MAP`）
   比对应进程新，就 `taskkill` 掉那个过期进程，然后等 DSH 用新代码重拉（实测 **约 1.7 秒**），
   并打印 `DSH 已用新代码重拉 MCP（约 1679 ms）：mcp-web-search-safe.js#24828`。
   **不需要重启 DSH**。代价只是那一刻的**在途工具调用会失败一次**。
   - 只改了 `mcp-snowluma-safe.js` 时，`mcp-host-server.js` / `mcp-web-search-safe.js` 两个进程
     不会被误杀（早期版本用一个"全局最新时间"比对，会把它们一起杀掉 —— 现在按入口分开比）。
   - `--check` 只报告不动手；`--restart` 强制重启桥接，但 MCP 仍按新鲜度判断。
2. 手动结束那个 `mcp-*.js` 进程：DSH 的 `@deepseek-ai/dsh-mcp-client` 默认开启重连
   （`initialDelayMs: 500` / `maxDelayMs: 30000` / `maxAttempts: 10`），约 0.5 秒后会重新拉起来，
   工具清单不变（实测旧 PID 32812 → 新 PID 11404）。
3. 重启 DSH（最稳，但会掐掉所有会话）。

> 重连次数耗尽（`maxAttempts: 10`）时工具会被**注销**、脚本会打印
> `[!] 等了 20 秒没看到重拉的新 MCP 进程` —— 那时**只能重启 DSH** 才能恢复。
> 判断当前状态：`node D:\qq-bot\ensure-bot-env.mjs --check`。

---

## 九、群友说睡觉：按**当前时间**说早/午/晚安（硬要求）

人格层 §二十三 + 仿真层【群友说睡觉：按"当前时间"说早/午/晚安（硬要求，没有例外）】。要点：

- **时间不需要额外注入**：每条唤醒提示词前面本来就有 `【当前时间】…（Asia/Shanghai）`
  （`withSlangContext()`，`src/bridge.js` 里 `const timeLine = …` 那一行；调用点在 `deliverPromptNow` 那条投递路径上）。
  所以这一条**纯提示词**，桥接不需要改代码。
- 时段口径（两层提示词里写死同一份）：**05:00–11:00 早安 / 11:00–17:00 午安 / 17:00–05:00 晚安**。
  判断依据是**她此刻的时间**，不是对方说了什么 —— 早上七点有人说「我去睡了」，回的是**早安**
  （对方刚熬完夜/下夜班），说错时段就是违规。
- 形式**三选一都行**：颜文字（`(¦3[▓▓]`、`( ˘ω˘ )zzZ`）、纯文字（`晚安`、`午安补个觉`）、
  或收藏表情包（`qq_send_sticker`）—— 选哪个看语境，不许每次都同一个形式。
- 一句就够，不许三连、不许长篇、不许拦人聊天（「你怎么这么晚睡」「再聊会儿嘛」都不行）。
- 这是**硬要求**：别人说「睡了 / 晚安 / 我先下了 / 眯一会 / 困死了」就必须按当前时段问候一个，
  不能只回一个「嗯」。群里别人之间互道晚安，接不上就让它过去（不要求每条都回）。

## 十、群聊 +1：把别人的话原样再说一遍

人格层 §二十四 + 仿真层【群聊 +1：把别人的话原样再说一遍（主人专门要求）】+ MCP 工具 `qq_repeat_message`。

- **工具而不是手抄**：让模型自己打原文一定会变形（"中秋快乐" → "中秋快乐呀"），那就不叫 +1。
  `qq_repeat_message({ key, messageId })` 由**桥接**取出原文再原样发出去，一字不改、不带引用、不带 @。
- 什么时候加一：节日祝福（「中秋快乐」）、群里在刷同一个梗、对方的话你不想接 / 接不住、
  或者单纯觉得有意思 —— 都可以直接跟一句。**冷场不适用**（那走 §五 主动分享歌）。
- 边界（端点上真实存在，见 **[NEW_CAPABILITIES.md](NEW_CAPABILITIES.md)** ⑦）：只在群聊；
  不能复读自己；图片/表情/语音没有文字 ⇒ 400；命中敏感信息检查 ⇒ 403；超长 ⇒ 400。
- 频率克制：专属 `socialV2.repeat.maxPerHour` 默认 12，并和普通发言共用 `send.maxSendPerMinute/maxSendPerHour`；
  同一个梗连刷三次就不是玩梗，是卡带。
- 端点/开关/测试：`socialV2.tools.repeatMessage`（出厂 true）、`POST /api/socialV2/repeat-message`、
  自检 `node scripts/test-repeat-message-http.mjs`（43 项断言）。**改了 `src/bridge.js` 要重启桥接**，
  改了 MCP 侧按本页 §八 的新鲜度流程处理。

## 十一、偶尔在群里卖个萌（主人 2026-10-11 加的一条）

人格层 §二十五 + 仿真层【偶尔在群里卖个萌（主人专门要求；但这是"偶尔"，别当成常规武器）】。

- 为什么加：她抱怨「被桥接拒绝」的次数多了以后，回话越来越像在自我检查（"我做不到""这个不行"），
  主人要的是**偶尔漏出软的一面**，别整只都是硬邦邦的嘴硬。
- 分寸（写死在两层提示词里，防止她理解成"可以一直发嗲"）：**一天一两次、同一话题最多一次**；
  别人说正事 / 吵架 / 倾诉时不卖萌；不说「嘤嘤嘤 / 人家 / 小女子」这种过度卖萌；
  **不许用卖萌躲该说的话**（该拒绝、该道歉、该说清的先说清楚，见 §四）。群聊一两句就收，私聊可以多一点（§十八）。
- 形式：颜文字（`(๑•̀ㅂ•́)و`、`( ˘ω˘ )`、`>_<`、`qwq`）、叠字/语气词（好耶、呜、诶嘿、不许笑），或偶尔配一张收藏表情。
- 这一条**纯提示词**，桥接不用改代码；但仿真层那半要重启 DSH 才生效（§一）。

## 十二、黑话只学"群里真的在用的词"（主人 2026-10-11 加的一条）

人格层 §二十六 + 仿真层【黑话：只学群里真正在用的词】+ `qq_slang_submit` 的工具说明。
这一条**光靠提示词不够**：桥接侧原来有三个缺陷让"群聊学黑话"整条链路上不来，所以代码也改了。

- **缺陷 ①（最致命）待学习窗口是纯内存态。** `slangWindows` 只在内存里，而桥接进程换得勤
  （桌面一键启动 + 手动重启，实测 6 小时内重启 **29 次**），每次重启都把攒了一半的素材清零。
  群安静的时候单进程寿命内**最多只攒到 10 条** < `slang.extractMinMessages`（本机 12）
  ⇒ `maybeQueueSlangExtraction()` 一直静默 return，`bridge.log` 里 6 小时**零条**「黑话提取」。
  **修法**：窗口落盘到 `state/slang-window.json`（`saveSlangWindowsSoon()` 1.5 秒去抖 + `restoreSlangWindows()`
  启动时读回并续上 `slangWindowSeq`），容量由写死的 80 改为 `slang.windowMax`（默认 200）。
- **缺陷 ②`count` 不是词频。** `count` 的语义是"被提取批次命中过几次"，所以安静群里永远到不了
  `inferenceThresholds=[2,4,8]`，也就永远不研究 ⇒ 控制台里只有光秃秃的词、没有含义。
  **修法**：新增 `groupCount`（= 这个词出现在多少条群消息里，`countTermOccurrences()` 复核，不信模型自报），
  研究门槛与排序都改用 `heat = max(count, groupCount)`。
- **缺陷 ③研究结果对不上就被静默丢弃。** `runSlangResearch` 原来用 `e.content === r.content` **严格相等**
  匹配词条（库里是「飞八分钱（张顺飞梗）」而模型回「飞八分钱」就 `continue`），
  而收尾日志按**模型返回条数**报「已更新 N 条」⇒ "日志说更新了、条目上什么都没变"。
  同时 `entry.research` 字段**不在 `normalizeSlangEntry` 的字段白名单里**，写进去下次存盘就被 strip。
  **修法**：`findSlangEntryByContent()`（先规范化标点空格精确匹配，再"互相包含且两侧 ≥2 字"的别名兜底）、
  日志区分 `已更新 N 条（模型返回 M 条）` / `没有一条能对上库里现有词条（…），未写入`、
  `normalizeSlangEntry` 显式保留 `research: { verified, at }`。
- **挑词门槛**（主人要的"选出现次数多的词"）：`selectExtractionItems()` ——
  **新词**必须在窗口里出现 ≥ `slang.minGroupCount`（默认 2）条消息才收，一次性的用词丢进 `skipped`
  （日志会写"跳过 N 条（窗口里出现不足 2 次：…）"）；**库里已有的词**照旧更新，不会因为这一窗只出现一次就被丢掉。
  提取提示词里还会附一段 `本地词频统计`（`词×次数`），让学习器照着高频词挑，而不是凭感觉。
- **手动提交（`qq_slang_submit`）**：只做**提示**不做拦截 —— 桥接会用群窗口复核这个词的出现次数，
  太少就在返回里给一句 `warning`（"最近在群聊窗口里只见到 N 次…"）。硬拦会让她又收到一次"被桥接拒绝"，
  而且窗口可能刚被提取清空。**只在主人私聊里出现的梗不算群黑话**（`slangGroupHitCount()` 只数 `group:` 键）。
- **控制台看得到**：黑话页「词条」列现在会在状态标签下加一个 `🔎 已考究 / 考究未过` 徽章（鼠标悬停显示考究时间），
  「次数」列下面多一行 `群频 N`。**次数 ≠ 群频**：次数是"被提取批次命中过几次"（老字段、语义容易误解），
  群频才是这个词真的出现在多少条群消息里 —— 两个都显示，就是为了不再把批次次数当群热度。
- 相关配置：`slang.windowMax`（默认 200）、`slang.minGroupCount`（默认 2）—— `config.json` / `config.example.json` / 出厂默认三处都有。
- 自检：`npm run test:slang-frequency`（或 `node scripts/test-slang-frequency.mjs`，28 项断言：
  词频统计、新词门槛、已有的词不被门槛误伤、`research`/`groupCount` 落盘存活、
  **窗口落盘 → 模拟重启 → 读回来**）。窗口文件本身不落盘也能跑（坏了只记一条日志，不影响收发）。

---

## 十三、2026-10-12 主人的三条新要求（频率、指代、语癖）

> 触发材料：主人 07:25 的私聊截图（她连着回「图收了 这莲花一看就很养生」「睡啦 我记下来了」这类
> **把对方发的东西再复述一遍**的话）＋ 一句「还有这说话太人机了改一改」。
> 另外两条是他在同一轮里明确说的硬要求。三条**都写进了两层**（人格层 + 仿真层）。

### 1）别拆条 + 接话冷却（"不要有应就回"的落地）

- **提示词**：人格层 §十九 新增第 8~10 条（一次只发一条、别拆 2~3 条；刚说过话后别想着逐条补答；
  别把冷场当成自己的责任）；仿真层新增【别拆条：一次唤醒默认只发一条】。
- **结构层（真闸门）**：`socialV2.reply.minGapMs` / `minGapDirectedMs` —— 见上面**第三节·保险 C**
  （含"在哪改"：控制台 → 二代仿真 → 「接话频率与冷却」）。
- 为什么两层都要：提示词管"她想不想拆"，闸门管"她能不能马上开口"；只靠前者就是这次实测到的
  六成拆条、一小时 21 条。

### 2）指代与命名：第一次说清"这是什么"，之后就别再点名

人格层 **§二十七** + 仿真层**【指代与命名：第一次说清"这是什么"，之后就别再点名】**。

- **第一次出现**：指示代词 + 全称（"这只小猫好可爱"、"你发的这朵莲花看着挺养生"）。
- **已经在聊了**：省掉指示代词与全称，直接说感受（"确实可爱"、"看着挺养生"）；反复点名＝人机味。
- **别复述对方刚发的东西**（主人那条截图的重点）：发了图给他看，不用回"图收了"，
  直接说看到它的感受。
- 判断标准一句话：**这个名词对听的人是否提供了新信息**——第一次说提供，已经在聊就不提供。
  但话题翻篇/同时在聊好几样东西时，全称要说回来（别省到看不懂）。

### 3）语癖：偶尔用「嘿嘿」「啦」开头或收尾

人格层 **§二十八** + 仿真层**【语癖：偶尔用「嘿嘿」「啦」这类口头禅开头或收尾】**。

- 常用 `嘿嘿`（前置/后置都行）、`啦`（后置：好啦/行啦/知道啦/那我睡啦），同类还有 `诶嘿`/`嘛`/`嗷`/`呀`。
- **一天一两次级别**，别每句都带（固定后缀比不用还假）；不要堆在一句里。
- 不用在：别人说正事/吵架/倾诉、正式回答问题时；群里比私聊克制。
- 和第十一节的卖萌是同一批场景：`嘿嘿`是"有点小得意但不想说破"的收尾，不是傻笑，
  也不许用它躲该说的话。

**这一批的落点**（改的时候照这张表找）：

| 内容 | 人格层（热生效） | 仿真层（要重建 patch + 重启 DSH） |
| --- | --- | --- |
| 别拆条 / 频率 | `roles/小鲸鱼.md` §十九 第 8~10 条 | 【别拆条：一次唤醒默认只发一条】 |
| 攒了几条挑一条引用着回 | §十七 | 【选择性回话】行尾那段（同一次唤醒里） |
| 主动引用 / 多人在找你 / @ 点名 | §十七 | 【选择性回话】行尾那段 + `quoteGuideV2()` 运行时注入 |
| 指代与命名 | §二十七 | 【指代与命名：第一次说清"这是什么"，之后就别再点名】 |
| 语癖 | §二十八 | 【语癖：偶尔用「嘿嘿」「啦」这类口头禅开头或收尾】 |

自检：`npm run test:reply-gap`（58 项，含"控制台四个输入框 + 换算 + 两层提示词都在"）
+ `npm run test:backlog-wake`（43 项，含积压兜底的计数口径、触发顺序、两层提示词）。

**关于启动器**：`D:\qq-bot\ensure-bot-env.mjs`（桌面「QQ机器人」→ `start-all.cmd` 里调它）现在还会报
**仿真层提示词是否比 DSH 进程新**——比它新就会打印「需要重启一次 DSH 才生效」。
这条检查是专门为"两层生效机制不一样、最容易记错"加的：人格层热生效；**仿真层 preset** 要重建 patch + 重启 DSH
（DSH 在启动时装载 profile bundle、在会话创建时装配 persona）。

> ⚠️ 别把两件事混起来：**仿真层 preset** 要重启 DSH，**MCP 工具开关**不要 —— 后者只要让 MCP 进程
> 按新配置重起一次（点同一个快捷方式即可，它会按入口比新旧去 taskkill 过期的 `mcp-*.js`，DSH 约 2 秒自动重拉），
> **当场生效，不用新建会话**。把工具开关当成"要掐掉所有会话"来对待是白付代价（§1.1 / §1.2）。

