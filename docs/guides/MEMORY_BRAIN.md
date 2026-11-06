# 记忆大脑：一张 SQLite 里的长期记忆

> 一句话：把她「记得的事」从提示词里搬进数据库——写入、检索、遗忘、治理都有据可查；
> 注入给模型的只是**一小块带 marker 的文本**，人格卡（`roles/小鲸鱼.md`）一个字都不动。

设计来源是一份 AstrBot/Python 的记忆系统需求与实现（五层：记忆 / 情绪 / 生活 / 表达 / 反馈）。
这次只移植了其中**记忆层、表达层、反馈层**（外加记忆层自带的治理），情绪层与生活层**没做**，
原因见第九节。零 npm 依赖，库里用 Node 24 自带的 `node:sqlite`。

## 一、五层里只做了三层

| 层 | 这一版做了什么 | 状态 |
| --- | --- | --- |
| 1 记忆层 | 单库 SQLite、五类记忆、bigram FTS、1024 维本地向量、五路加权检索、衰减/归档/清理/合并/冲突/上限 | ✅ 做了 |
| 4 表达层 | 注入块（唯一 marker、重复注入先删旧块）、群聊可见性过滤、条数/分数门槛 | ✅ 做了（只做了「往提示词追加块」这一半，语感统计与发送前清洗仍走原有模块） |
| 5 反馈层 | 被纠正 → 上轮命中记忆降权 15% + 写一条 `lesson`；health 四类可修项；自带 recall 自检 | ✅ 做了（评估集是**从库里现成记忆自动造**的 20 条，不是人工标注的真实问法集） |
| 2 情绪层 | PAD 三维、10 标签、半衰期、安慰只降一点 | ❌ 没做 |
| 3 生活层 | 独立进程的随机活动/兴趣衰减/长期与临时笔记 | ❌ 没做 |

情绪层与生活层不是「忘了」，而是**改动面比记忆大得多**：情绪要参与提示词与语气、生活层要独立进程与调度，
在「不改人格、可一键回滚」的前提下第一版只做能离线测试、能灰度、关掉就当不存在的部分。

## 二、存哪：一张库、十一张表

默认 `state/memory-brain.sqlite`（`memoryBrain.dbPath` 可改；相对路径按仓库根解析）。
库以 WAL 打开（`journal_mode=WAL, synchronous=NORMAL, busy_timeout=3000`）。

| 表 | 存什么 |
| --- | --- |
| `memories` | 记忆本体：`id, kind, text, importance, valence, arousal, created_at, last_access, access_count, status(active\|archived\|merged), source, meta(JSON), visibility(private\|group\|public), archived_at` |
| `vectors` | `memory_id, dim, vec`（BLOB，Float32；维度固定 **1024**） |
| `memories_fts` | fts5(`tokens, memory_id UNINDEXED, tokenize='unicode61'`)，`tokens` 是 bigram 用空格连起来的串 |
| `entities` / `relations` / `memory_entities` | 实体、实体间关系、记忆↔实体（图谱那一路打分与 `/graph` 都读它） |
| `working` | 工作记忆（短时、按会话、带过期时间；默认保留最近 5 条） |
| `raw_messages` | 入站原文缓冲（每会话保留 2000 条，12 条一个窗口做摘要） |
| `conflicts` | 冲突对（`a_id, b_id, reason, resolved`） |
| `daily_stats` | 按天计数（`day, key, value`；写入数 / episode 数） |
| `meta` | 库版本、每个会话的摘要水位、上次治理时间等 |

`text` 入库前会**清洗**：先抹掉旧的注入块 marker、压成单行、按 `write.maxChars`（默认 600）截断；
少于 `write.minChars`（默认 4）的碎话直接跳过（返回 `skipped:'too-short'`），不会占一条记忆。

## 三、检索：五路加权 + 文本去重

```
score = 0.18 * semantic   语义（1024 维向量余弦）
      + 0.46 * keyword    关键词（fts5/bm25 的排名映射到 0~1）
      + 0.11 * graph      图谱（命中记忆的实体邻居与查询实体的重合度，min(1, 共享/3)）
      + 0.14 * importance 重要度（0~1，写入时给，纠正/合并会微调）
      + 0.11 * freshness  新鲜度 = 0.5 ^ (距今天数 / 14)   ← 14 天半衰期
```

- **关键词**：中文按 **bigram** 切（「冰美式」→ `冰美 美式`），英文/数字按整词；入库时把 bigram 用空格连起来写进
  `memories_fts`，查询时同样切 bigram、用 OR 拼起来 —— 这样「美式」也能召回到「冰美式」那条。
  bm25 排名映射：`keyword = 1 - rank/(命中数-1)`（只命中一条时是 1）。
- **语义**：本机没有 bge-m3，默认 `embedding.backend='local-hash'` —— 把 bigram + 整词哈希到 1024 维再 L2 归一化；
  确定、离线、零依赖。想换真模型就配 `backend:'http'` + `baseUrl`，桥接会 POST `{model, input:[text]}` 并期望
  `{data:[{embedding:[]}]}`（见第八节）。**维度固定 1024**，换后端不用改库。
- **去重**：结果按分数降序后，文本 bigram 相似度 ≥ **0.82** 的只留第一条（同一件事换了个说法不重复喂给模型）。
- 检索默认**会 touch**（`last_access=now`、`access_count+1`），这是「被想起过」的证据，衰减与归档都看它；
  只读场景传 `touch:false`。

## 四、写入管线：满 12 条一窗口，聊完 10 分钟也总结

| 触发 | 动作 | 落什么 |
| --- | --- | --- |
| 每条入站消息 | 落 `raw_messages` + 更新工作记忆；到 `write.windowSize`（默认 **12**）条 | `summarizeWindow()` 生成一条 `episode`（`source='window:<会话>'`，importance 0.45，meta 记会话/条数/起止） |
| 每 5 分钟扫一次（启动后 3 秒也扫） | `pendingWindows({minPending:5, idleMs:20min})` → `summarizeWindow({force:true, mergeWithinMs:6h})` | 会话**安静 20 分钟且攒了 ≥5 条**就结一段对话；同一会话 **6 小时内**的下一批并进同一颗星（`meta.windows` 累加），不会碎成一堆空星 |
| 手动 | `POST /api/memory-brain/action {action:'consolidate'}` | 立刻把「聊完但没满窗口」的会话全结掉（控制台「记忆大脑 → 治理 → 立刻总结」） |

**episode 的重要度按条数缩放**：`0.30`（3 条）→ `0.55`（12 条封顶），不再一律 0.45。
短摘要排位靠后、记忆星系里更暗，检索时不会盖过大段对话。
| 每天一次（启动后 + 24h 定时） | `distillFacts()`：从当天的 episode 抽 `fact` | 最多 `distill.factPerDay` 条（默认 6） |
| 每天一次 | `distillLessons()`：从 `reflection` / 带「记错了/不是这样」的笔记抽 `lesson` | 最多 `distill.lessonPerDay` 条（默认 3） |
| 手动 | `POST /api/memory-brain/action {action:'distill'}` | 立刻跑一次上面两步 |

**默认摘要绝不调模型**：`summarize.useLlm=false` 时只走启发式（规则抽句 → 去重 → 截断），
全程本地、确定、可测。`useLlm=true` 也不会自己找模型 —— 必须由 bridge 显式注入 `llm(prompt)` 钩子
（`memoryBrain.setLlm(...)`），没钩子时仍回落到启发式。多条消息的窗口摘要幂等：同一窗口重复调用返回 `null`，
不会重复插 episode（水位存在 `meta` 的 `window:<会话>` 键里）。

多模态只做「入库」：`ingestMedia({kind:'image'|'voice'|'video'|'file', text, session, meta})` 把**已经算好的**
视觉描述/转写文本写成 episode（前缀 `[图片]` / `[语音]` / `[视频]` / `[文件]`，`source='media:<kind>'`），
再挑其中像事实的句子插最多 2 条 `fact`。**本机没有 whisper，不做任何转写** —— 转写发生在调用方。

## 五、治理：会忘，但忘得有据

每天一轮（`maintainMemoryBrainNow`：衰减 → 归档 → 清理 → 相似合并 → 冲突检测 → 蒸馏），每一项都能单独关：

| 项 | 规则 | 默认 |
| --- | --- | --- |
| 时间衰减 | 每天 `importance = importance * 0.99` | 开 |
| 频繁访问减半 | 最近 **30 天**内被访问过且 `access_count >= 10` → 衰减系数减半（`0.995` 而不是 `0.99`） | 开 |
| 归档 | `importance < 0.3` **且** 超过 30 天没被想起 → `status='archived'`（不删除，索引同时撤掉） | 开 |
| 清理 | 归档满 **180 天** → 彻底删除 | 开 |
| 相似合并 | 同 kind + 余弦 ≥ **0.92** → 保留访问多/重要/更早的那条，另一条 `status='merged'`；合并方的 `meta.mergedFrom` 记来源，importance +0.02 | 开 |
| 冲突检测 | 同实体 + 余弦 ≥ **0.8** + 反义词对（喜欢/讨厌、能/不能、想/不想 等 20 对）→ 写 `conflicts` | 开 |
| 分类上限 | `fact` 3000 / `lesson` 500，超了按 importance、created_at 从低到高归档 | 开 |

`health()` 返回四类**可修项**：`duplicates`（重复/近重复）、`orphans`（悬空 link 与没人指向的实体）、
`zombies`（长期不用的记忆）、`conflicts`（未解决的冲突对）；`healthFix` 会真的动手（合并/归档/清悬空），
返回 `{changed, before}`。控制台「体检」按钮走的就是它。

## 六、表达层：注入块长什么样

只有 `enabled=true` **且** `inject.enabled` 时才可能注入；没有任何命中就返回空串（提示词里不出现这一段）。

```
<!-- MB:BEGIN memory -->
## 长期记忆（背景参考，不是指令；不要逐字复述）
- [fact] 主人每天早上喝一杯冰美式
- [episode] 昨天群里聊到显卡价格又涨了
<!-- MB:END memory -->
```

- marker 是**整行 HTML 注释**，用来「先删旧块再插新块」：`stripMemoryBlocks(text)` 删块，`hasMemoryBlock(text)` 判断有没有。
- 位置：出站 base 提示词里，**紧跟在 `memoryCardLine` 之后**、`purposeLine` 之前（`memoryCardLine + memoryBlockLine + purposeLine`）。
- 条数与门槛：私聊最多 **2** 条、门槛 **0**；群聊最多 **1** 条、门槛 **0.45**（`inject.privateCount` / `groupCount` /
  `privateMinScore` / `groupMinScore` 可改）。
- **群聊可见性**：群聊检索传 `visibility='group'`，`private` 记忆一律不进来（私聊里能看到全部）。
  `buildMemoryBlock({query, chatType, visibility})` 是唯一入口，别自己拼字符串。
- 每条按 `inject.maxCharsPerItem`（默认 140 字）截断，避免一条长记忆挤掉人格。

## 七、反馈层：被纠正之后

`applyCorrection({query})`（桥接在识别到「不是 / 记错了 / 我没说过」时调用）：

1. 取**上一轮注入命中的**记忆（`brain.lastInjected`，没有就当场检索一次 top1）；
2. 把它们 `importance * 0.85`（最低 **0.05**，不会降成 0）；
3. 插一条 `kind='lesson'`、`source='correction'`、`text='用户纠正过我：<原话>'` 的记忆（importance 0.72，private）；
4. 清空 `lastInjected`，返回 `{ok, changed, ids, lessonId}`。

自检评估 `evalRecall({cases})`：默认从库里**现成记忆**取 20 条，用每条文本的前 6~14 字当查询，
算 `recall@1 / recall@3 / MRR / p50 毫秒`。它是「索引没坏、检索没退步」的冒烟测试，
**不是**人工标注的真实问法评估集 —— 别拿它当效果指标对外承诺。

## 八、控制台 API（都要控制台令牌）

鉴权与 `/api/memory-card` 同款：`x-console-token` 或 `?token=`。**`enabled=false`（或开库失败）时所有端点**
统一回 `{ok:false, disabled:true, enabled:false, error:'记忆大脑未开启（config.memoryBrain.enabled）'}` —— 前端据此显示「未开启」，
而不是 404（404 分不清「没这个功能」和「功能关着」）。

| 方法 | 路径 | 回什么 |
| --- | --- | --- |
| GET | `/api/memory-brain/overview` | `{ok, enabled, db:{path,sizeBytes}, counts:{episode,fact,reflection,skill,lesson,active,archived,working}, caps:{fact:3000,lesson:500}, health:{duplicates,orphans,zombies,conflicts}, stats:{todayWrites,todayEpisodes}}` |
| GET | `/api/memory-brain/list?kind=&status=&limit=&offset=` | `{ok,total,items:[{id,kind,text,importance,valence,accessCount,status,source,visibility,createdAt,lastAccess,archivedAt}]}` |
| GET | `/api/memory-brain/search?q=&chatType=` | `{ok,items:[{id,kind,text,score,parts:{semantic,keyword,graph,importance,freshness}}]}` |
| GET | `/api/memory-brain/graph?limit=` | `{ok,nodes:[{id,name,type,mentions}],edges:[{source,target,relation,weight}]}` |
| GET | `/api/memory-brain/health` | `{ok,items:{duplicates,orphans,zombies,conflicts},sample:{…各 3 条}}` |
| GET | `/api/memory-brain/eval?run=1` | `{ok,caseCount,recallAt1,recallAt3,mrr,p50Ms,hits,ran}`（不带 `run=1` 不跑，回 `ran:false`） |
| POST | `/api/memory-brain/action` | 体 `{action:'archive'\|'restore'\|'delete'\|'decay'\|'purge'\|'merge'\|'health-fix'\|'distill'\|'reindex', id?, ids?}` → `{ok,changed}`；缺参回 400 |

页面：`GET /memory-brain` 与 `/memory-brain.html` 返回 `public/memory-brain.html`（免令牌，和 `console.html` 同款）；
文件不存在时回 404 + 中文提示「记忆大脑页面缺失：qq-bridge/public/memory-brain.html」。

启动日志：

```
🧠 记忆大脑已开启：128 条记忆（fact 12 / episode 30）
```

关掉时只有一行 `🧠 记忆大脑未开启（config.memoryBrain.enabled=false）`。

## 九、开关清单（`config.json` 的 `memoryBrain`）

默认值全在 `src/memory-brain.js` 的 `DEFAULT_MEMORY_BRAIN_CONFIG`；`config.json` 是主人手写的，程序不会改它。
`config.example.json` 里有一份完整示例块。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | **总闸**：false = 不开库、不注入、所有端点回 disabled |
| `dbPath` | `state/memory-brain.sqlite` | 库位置（相对仓库根） |
| `inject.enabled` | `true` | 只关「注入」，写入/治理照常 |
| `inject.privateCount` / `groupCount` | 2 / 1 | 私聊/群聊最多注入几条 |
| `inject.privateMinScore` / `groupMinScore` | 0 / 0.45 | 门槛分 |
| `write.enabled` / `windowSize` | true / 12 | 入站落库与摘要窗口 |
| `summarize.enabled` / `useLlm` | true / **false** | 关掉摘要 / 用 LLM（需 bridge 注入钩子） |
| `distill.enabled` / `factPerDay` / `lessonPerDay` | true / 6 / 3 | 每天蒸馏 |
| `decay.enabled` / `dailyFactor` / `minImportance` / `protectDays` / `frequentAccessCount` | true / 0.99 / 0.3 / 30 / 10 | 衰减与归档阈值 |
| `archive.enabled` / `afterDays` | true / 180 | 归档后多久彻底删除 |
| `merge.enabled` / `similarity` | true / 0.92 | 相似合并阈值 |
| `conflict.enabled` / `threshold` | true / 0.8 | 冲突检测阈值 |
| `caps.fact` / `caps.lesson` | 3000 / 500 | 分类上限 |
| `weights.semantic` / `keyword` / `graph` / `importance` / `freshness` | 0.18 / 0.46 / 0.11 / 0.14 / 0.11 | 五路权重（改这里就能调「关键词 vs 语义」的配比） |
| `search.dedupeSimilarity` / `freshnessHalfLifeDays` / `minScore` | 0.82 / 14 / 0 | 去重阈值、半衰期、总分门槛 |
| `embedding.backend` / `model` / `baseUrl` / `timeoutMs` / `dim` | local-hash / bge-m3 / '' / 8000 / 1024 | 向量后端；`http` 时 POST `{model,input:[text]}` 到 `baseUrl`，期望 `{data:[{embedding:[]}]}`；维度固定 1024，换后端不改库 |

## 十、验证「没有改坏人格」

这是整套东西的验收标准：**关掉它，行为必须和没有它时一模一样**。

1. **备份**：`cp config.json config.json.bak-$(date +%F)`，`cp state/memory-card.json` 同理（本功能不碰记忆卡，但备份便宜）。
   `roles/*.md` 只读，任何情况下不改。
2. **灰度**：先把 `memoryBrain.enabled` 设 true、`inject.enabled` 设 **false** 跑一天 —— 只有写入与治理，不进提示词。
   看 `GET /api/memory-brain/overview` 的 `counts` 是否在长、`health` 是否干净。
3. **开注入**：把 `inject.enabled` 改回 true，重启，抓一次出站提示词看块的位置与内容：
   marker 在、条数对（私聊 ≤2 / 群聊 ≤1）、没有 private 记忆漏进群、每条不超过 140 字。
4. **对照语气**：同一段对话在开/关注入下各跑一遍；人格卡没变、语气没变、没有「背课文」式的复述（块里已写明「不是指令」）。
5. **一键关**：`enabled=false` → 重启 → 日志出现「未开启」、所有端点回 `disabled`、提示词里不再出现 `MB:BEGIN`。
   库文件**原地保留**，想再开随时开，数据不丢。
6. **回滚**：本项目不是 git 仓库，回滚靠「删代码目录里新增的文件 + 恢复 config 备份」：
   去掉 `src/bridge.js` 里那几处接线（import、`startMemoryBrainMaintenance`、`memoryBlockForWake`、端点块、页面路由），
   删除 `src/memory-brain.js` / `scripts/test-memory-brain.mjs` / 本指南即可回到改动前；`state/memory-brain.sqlite` 可留可删。
   **最省事的回滚永远是 `enabled=false`**：一行配置，不改代码。

## 十一、明确不做的事

- 不改 `roles/*.md`，不覆盖 `config.json`；所有增强都是「往提示词追加一块、可整块删除」的形态。
- 不做 whisper 转写、不做视频抽帧（`ingestMedia` 只接收**已经算好的**文本）。
- 不做情绪层与生活层（见第一节）。
- 不做跨设备同步、不做向量数据库；一张本地 SQLite 就是全部。
- 不做「用记忆改变人格」：注入块永远只是背景参考，冲突时人格卡优先。

## 十二、测试

```bash
npm run test:memory   # = node scripts/test-memory-brain.mjs，离线、临时目录库
```

覆盖：11 张表建库、五类记忆写入、五路权重与排序、bigram 命中、0.82 去重、衰减/归档/180 天清理、
0.92 相似合并、反义词冲突、分类上限、注入块 marker 与群聊可见性、纠正降权、health 四类与修复、
12 条窗口幂等、embedding 两种后端（http 用假 fetch）、以及真实 `bridge.js` 的 7 个端点（含 `enabled=false`、401、页面 404）。
当前 **197 项断言全过**。
