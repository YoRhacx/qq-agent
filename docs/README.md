# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注） · 🗄️ 已被取代（保留作背景）
>
> 📦 **本仓库未收录的内部文档**（本索引里仍保留条目，但链接会 404）：`guides/PROJECT_GUIDE.md`（113 KB 的完整项目说明书）、
> `guides/VOICE.md`、整个 `design/`（二代仿真与"一切皆工具"的实施计划）、`research/`（SnowLuma 能力调研、本地模型选型）、
> `audits/`（历次审计报告）。原因：这些文档里带大量运行期数据、本机路径与未脱敏案例，不适合直接公开；
> 需要时按目录名自行向维护者索取。

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/PROJECT_GUIDE.md](guides/PROJECT_GUIDE.md) | **权威项目说明书**（113 KB / 1450+ 行）：架构、内外核划分、数据流、配置全解、安全机制、调试与改进指南，含 2026-08-20 ~ 2026-09-11 的逐轮更新记录 | ✅ **唯一权威版本**（另一份同名精简版已归档到 legacy，见下） |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/VOICE.md](guides/VOICE.md) | 语音发送全解：独立工具（`voice-tool/` 的图形界面与命令行）、桥接 CLI、AI 工具、控制台面板，以及**工具拆出后的配置解析顺序** | ✅ 2026 整理时已更新（工具移到上一级 `voice-tool/`） |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ 2026 整理时自 `scripts/` 移入 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读**（2026-09-20 新增） |
| [guides/SEND_IMAGE.md](guides/SEND_IMAGE.md) | 发图全解：图片来源只有两类（`media/images/` 库内文件 / 公网 URL，URL 由桥接自己按 SSRF 规则抓）、AI 工具 `qq_send_image` 与操作者接口 `/api/media/send-image`、为什么默认关、审计与限流、`dryRun`、以及**群文件发送为什么做不了** | ✅ 新增（配 `media/README.md`） |
| [guides/REMINDERS.md](guides/REMINDERS.md) | 到点提醒全解：AI 工具 `qq_set_reminder` / `qq_list_reminders` 与操作者接口 `/api/socialV2/reminders`、**唤醒式投递**（`sent`/`queued`/`skipped` 与限流时直发兜底）、迟到超 `graceMs` 只标记不发送、上限与重复语义、以及**它为什么不是定时播报** | ✅ 新增（默认开） |
| [guides/HISTORY.md](guides/HISTORY.md) | 历史检索全解：入站/出站三处挂点把收发文字按行落盘（媒体只记一条描述，不存字节）、AI 工具 `qq_search_history` 与操作者接口 `/api/socialV2/history/search`、关键词 AND 的**片段**语义、去重（只对数字 `messageId`）与 30 天 / 64 MB 保留策略 | ✅ 新增（默认开，只读） |
| [guides/NEW_CAPABILITIES.md](guides/NEW_CAPABILITIES.md) | **六项新能力总览**：自省 / 音乐卡片 / 群管理 / 到点提醒 / 历史检索 / 发图的「一句话是什么 + 开关与默认值 + 为什么默认关 + 上限与限流 + 明确做不到的 + 怎么验收」一览表；想先看全貌再看细节就从这里进 | ✅ 新增（入口页） |
| [guides/SELF_STATUS.md](guides/SELF_STATUS.md) | 自省全解：AI 工具 `qq_bridge_status` 与操作者接口 `/api/self-status`，返回**摘要文本（≤1200 字）+ 结构化 data**、花费是 best-effort（拿不到就整段省略）、五个建议告警码（`provider-not-cache-friendly` / `low-cache-hit` / `cost-warn` / `wake-quota-low` / `bridge-not-ready`）的含义 | ✅ 新增（默认开，只读） |
| [guides/MUSIC.md](guides/MUSIC.md) | 音乐卡片全解：AI 工具 `qq_send_music` 与操作者接口 `/api/media/send-music`、平台卡（`qq`/`163`/`kugou`/`kuwo`/`migu`/`bilibili`）与自定义卡两类、**平台卡要经 SnowLuma 的 `musicSignUrl`（默认 `https://ss.xingzhige.com/music_card/card`）第三方签名换取**、因此默认关闭、想完全避免第三方就用 `type:'custom'`、以及限流与 `dryRun` | ✅ 新增（默认关） |
| [guides/MEMORY_CARD.md](guides/MEMORY_CARD.md) | 记忆卡全解：跨会话长期记忆怎么沉淀（入站自动进 inbox → 打分 → 衰减 → 压缩 → 注入），两套记忆的区别、五档清晰度、注入预算与脱敏规则、`/api/memory-card*` 控制台接口、`memoryCard` 配置项、v1 明确的边界 | ✅ 新增（2026-10-28） |
| [guides/MEMORY_BRAIN.md](guides/MEMORY_BRAIN.md) | 记忆大脑全解：SQLite 长期记忆库（五类记忆 + 五路加权检索 + 治理/合并/冲突/蒸馏）、注入块 marker 与群聊可见性、写入管线（12 条一窗口 / 每天蒸馏）、`/api/memory-brain/*` 控制台接口、`memoryBrain` 配置项与**一键关 / 灰度**步骤；明确只做了五层中的记忆·表达·反馈三层 | ✅ 新增（2026-10-28） |
| [guides/PERSONA_STATE.md](guides/PERSONA_STATE.md) | 人格状态（情绪层）：PAD 三轴心情 + 好感 + 识海（永久记住）+ 旧账（不原谅），**角色卡只读**、所有增强都是一段可裁剪的注入块（`<!-- PS:BEGIN persona -->`）；标签 45 分钟半衰、心情 6 小时回基线、久不联系好感回落；`personaState` 配置项、`/api/emotion` 与 `POST /api/emotion/action` | ✅ 新增（2026-10-28） |
| [guides/MEMORY_MODULES.md](guides/MEMORY_MODULES.md) | 记忆模块三件套：**人物画像**（谁是谁 / 多熟 / 什么印象）/ **每日反思**（一天压成一句 + 三条 highlight）/ **程序记忆**（这件事这么做）；纯启发式、不调模型不联网、各写自己一份小 JSON、**不碰** `state/memory-brain.sqlite`；`memoryProfile` / `memoryReflection` / `memoryProcedural` 配置项与 `/api/profile`、`/api/reflection`、`/api/procedural` | ✅ 新增（2026-10-28） |
| [guides/STAR_MAP.md](guides/STAR_MAP.md) | 星图展示层：记忆卡八章 + 13 天日记怎么来的、本机档案模式的配置（`~/.dsh/xingxi/config.json` 的 `记忆卡`/`日记` 两个字段）、为什么没跑「拾星」（`scripts/build-xingxi-archive.mjs` 直读 history，零模型成本）、以及**为什么她的会话调不到 `xingxi_read`**（`qq-tool-restrict` 白名单默认拒绝，星图只给人看） | ✅ 新增（2026-11-06） |
| [guides/MEME_WIKI.md](guides/MEME_WIKI.md) | 梗百科（dsh-memewiki 0.1.20）：6792 条离线词库装在哪、两个工具（`search_meme_wiki` / `feedback_meme_wiki`）、预查注入（order 950，纯本地不花钱）为什么对她的会话基本不触发、我们给她开的白名单与人格卡规则、重启/验收步骤 | ✅ 新增（2026-11-06） |
| [guides/LITERARY.md](guides/LITERARY.md) | 文学性尺子：五项可数指标（具体性 / 画面 / 节奏 / 质感 / 人味）减一类 AI 腔、0~100 分与分档、40 条基准与三条判据、`npm run eval:literary` 的四种用法、改人格卡的「留底 → 单点改动 → 同批对比」流程、加词/加基准的规矩，以及**为什么「拿大量文本训练」在这里走不通** | ✅ 新增（2026-10-29） |
| [guides/STYLE_LIFE.md](guides/STYLE_LIFE.md) | 表达层三件：**真人语感**（学这群人的句长/句尾/语气词，出站顺手洗一遍）/ **自我语感**（防人格漂移，只给 160 字手感）/ **生活层**（今天看过什么，给个能接的话头）；marker `<!-- STYLE:BEGIN -->` 与 `<!-- SELF-STYLE:BEGIN -->`；`styleGuard` / `selfStyle` / `lifeLoop` 配置项与 `/api/style`、`/api/self-style`、`/api/life` | ✅ 新增（2026-10-28） |
| [guides/PURPOSE_ENGINE.md](guides/PURPOSE_ENGINE.md) | 目的引擎全解：主动开口前先提炼「心里惦记的事」（五类来源 → score）、八道硬闸门（插嘴保护 / 跨零点静默 / 日上限 / 载体互斥 / 冷却 / 弱候选沉默）、两种输出（不注入 / 注入并抬高主动概率）、`purpose` 配置项、只读端点 `/api/purpose`、以及明确不做的五件事 | ✅ 新增（2026-10-28） |
| [guides/TOKEN_BUDGET.md](guides/TOKEN_BUDGET.md) | 每日额度（双单位）：`dailyCny` / `dailyTokens` 各自独立设线，谁先到线谁生效；80% 只提醒、100% 停止主动开口（被动回复不拦）；「今天」按本地自然日切、跨零点那一桶不算；`tokenBudget` 配置项、只读端点 `/api/budget`、状态文件只存「今天提醒过没有」、以及明确不做的五件事 | ✅ 新增（2026-10-28） |
| [guides/CONVERSATION_CLOSURE.md](guides/CONVERSATION_CLOSURE.md) | 对话收束全解：什么时候该停（六类信号 → `continue` / `linger` / `close`）、**对方在提问时永远不许判收尾**、告别为什么单独就 close、`conversationClosure` 配置项、只读端点 `/api/socialV2/closure`、以及 v1 明确的边界（不是潜水、不加 MCP 工具、不写 nextOpening） | ✅ 新增（2026-10-28） |
| [guides/GROUP_ADMIN.md](guides/GROUP_ADMIN.md) | 群管理全解：AI 工具 `qq_group_admin` / `qq_list_requests` 与操作者接口 `/api/group-admin`、六个动作（踢人/禁言/解禁/删消息/好友申请/入群申请）、风险分级、**`kick` 属高危必须由管理者显式放行**、朋友与入群申请的处理路径、以及 SnowLuma **不支持**的动作（`set_group_card` / `set_group_leave` / `set_group_name` / `set_group_whole_ban` / `get_group_info` / `get_friend_list`） | ✅ 新增（默认关） |

| [guides/PRIVACY.md](guides/PRIVACY.md) | **发布前隐私检查**：工作树里有什么（真实 QQ 号/群号/绝对路径/令牌/人格卡）、`npm run privacy-scan` 与 `--strict` 的区别（strict 忽略 allowPaths 并追加更严规则）、命中项怎么处置 | ✅ **push 前必跑**

| [guides/PERSONA_BEHAVIOR.md](guides/PERSONA_BEHAVIOR.md) | **行为与拟人化全解**：人格层（`roles/小鲸鱼.md`，热生效）与仿真层（preset，会话创建时装配）**不是一个东西**、四条硬要求（不有应就回 / 先拒绝小几次 / 冷场主动甩歌 / 绝不暴露工具与后台），以及"装死"的**两层保险**——提示词层 `qq_wait_for_messages(purpose="reply")` 与结构层 `wakeDelayMsV2()` 唤醒抖动（窗口 + `[0, 窗口)` 随机，固定时刻唤醒不抖，窗口 <4000ms 不抖）；**另含 §1.1「工具开关是热的」**：MCP 侧怎么做到"全部注册 + 按活配置 enable/disable"，以及控制台那行对账提示（`GET /api/socialV2/tools`）怎么读、什么时候才需要动进程（§1.2） | ✅ 新增（2026-10-11；2026-10-12 补 §1.1/§1.2 并改为热生效） |

## design/ —— 设计与规划（读设计意图用）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [design/GEN2_SIMULATION_PLAN.md](design/GEN2_SIMULATION_PLAN.md) | 二代仿真（`reserved2`）「一切皆工具」实施计划：WakeConfig 唤醒调度、MCP 工具集、控制台参数、`qq-chat-v2` preset | ⚠️ 骨架/API/调度/MCP/UI 均已落地，文中「状态：实施中」与残留 TODO 以当前代码为准 |
| [design/SOCIAL_MODE_PLAN.md](design/SOCIAL_MODE_PLAN.md) | 一代仿真模式（`reserved`）的头脑风暴定案：规则引擎管「何时说」、LLM 管「说什么」 | ⚠️ 描述的一代状态机已实现；`reserved2` 已是默认模式，设计背景仍有效 |
| [design/DSH_QQ_TOOLS_PLAN.md](design/DSH_QQ_TOOLS_PLAN.md) | 「一切皆工具」总路线与交接文档：当前能力盘点、安全性设计、分阶段计划 | ⚠️ 阶段计划大部分已完成，作为路线/安全设计参考仍有效 |
| [design/真人语感策略.md](design/真人语感策略.md) | 拟人化策略：短句碎片、接梗、错别字、话题漂移、选择性沉默、括号用法 | ⚠️ 文首已自注：部分「现状」写于旧版随机分句时期，最新行为以 PROJECT_GUIDE / 代码为准 |

## research/ —— 调研记录（结论可直接引用，过程可能过时）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [research/SnowLuma功能调研.md](research/SnowLuma功能调研.md) | SnowLuma 除「OneBot WS + 基础收发」之外还有哪些 QQ 相关功能与机制（API 面、可扩展点） | ✅ 调研对象 v1.14.9；换 SnowLuma 大版本后需复核 |
| [research/RESEARCH_QQ_MESSAGE_DND.md](research/RESEARCH_QQ_MESSAGE_DND.md) | QQ 群「消息免打扰」到底影响不影响 SnowLuma 收发消息 —— 结论：不影响，只是不提醒 | ✅ |
| [research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md](research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md) | SnowLuma 的表情包/收藏表情能力（`fetch_custom_face*` 等），本仓库收藏表情功能的依据 | ✅ |
| [research/LOCAL_MODEL_SIZING.md](research/LOCAL_MODEL_SIZING.md) | 若要本地复刻：本项目对模型的真实负载、显存门槛、27–35B 起步、双 3090 是性价比拐点 | ✅ 调研日期 2026-09-17 |

## audits/ —— 审查 / 体检 / 优化报告（按时间读，越新越权威）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**（v0.1.7 → v0.2.0）：逐条列出为适配 0.2.0-rc.2 做的改动（现象/为什么必须改/证据/怎么验证），并单独列出「复核后判定兼容、因此没改」的部分与「同批但不属于适配」的改动 | ✅ **最新**；升级 DSH 前先读 §10 的操作清单。放在 `guides/` 是因为 `audits/`、`design/`、`legacy/`、`research/` 都在 `.gitignore` 里（见该文件第 52–64 行），放进那几处的文档**不会进公开仓库** |
| [audits/AUDIT_FIXES_2026-09-20.md](audits/AUDIT_FIXES_2026-09-20.md) | **那一轮（第二轮）三路并行审计与修复记录**：桥接内核 / 控制台与打包 / 文档基线；逐条列出已修、已确认无问题、列为规划 | ✅（取代下面那份的结论；`CODE_AUDIT` 中当时未修完的项已在此结清）⚠️ **本文件不在公开仓库里**（`docs/audits/` 被 `.gitignore` 排除），只在本地可见 |
| [audits/CODE_AUDIT_2026-09-20.md](audits/CODE_AUDIT_2026-09-20.md) | 同日较早的代码体检（P0/P1/P2/P3 清单与实现细节、指标统计：monolith 度量、重复代码盘点） | ⚠️ **多数已修**：修复状态以 AUDIT_FIXES 为准；本文的实现细节与度量仍有参考价值（2026-09-20 补登进索引） |
| [audits/AUDIT_REPORT_2026-09-20.md](audits/AUDIT_REPORT_2026-09-20.md) | 全项目体检：四条独立审计线（状态机与重连、安全边界、健壮性与资源、配置/脚本/文档一致性）+ 按影响排序的修复 | ✅ 结论仍有效（取代 2026-09-18 那份） |
| [audits/CONSOLE_FEATURES_REPORT.md](audits/CONSOLE_FEATURES_REPORT.md) | 控制台功能增强：人格管理、两层提示词（仿真层/人格层）、DSH 思考强度 | ✅ |
| [audits/CONSOLE_UI_REDESIGN_REPORT.md](audits/CONSOLE_UI_REDESIGN_REPORT.md) | 控制台改版报告：九页导航 + 全局搜索 + 浅色/深色主题，纯前端改造 | ⚠️ 页数已增至 10（新增「令牌与花费」），其余仍有效 |
| [audits/TOKEN_OPTIMIZATION.md](audits/TOKEN_OPTIMIZATION.md) | `reserved2` 的 token 开销优化与消息水位协议、升级与回退说明（README 直接引用它） | ✅ |
| [audits/TOKEN_COST_ANALYSIS.md](audits/TOKEN_COST_ANALYSIS.md) | token 成本实测档案与优化清单（含本文档形成时的个人用量数据） | ⚠️ 数据是当时的实测快照；结论方向仍被 TOKEN_OPTIMIZATION 引用，具体数字别当现值 |

## legacy/ —— 历史归档（**不要照着做**，留作背景与追溯）

| 文档 | 一句话说明 | 为什么归档 |
| --- | --- | --- |
| [legacy/PROJECT_GUIDE.public-condensed.md](legacy/PROJECT_GUIDE.public-condensed.md) | 面向公开仓库的**精简版**项目说明书（约 375 行、10 节，末行自述「公开版文档，不包含本地开发历史与个人配置」） | 🗄️ **被 `guides/PROJECT_GUIDE.md` 取代**：内容更全的那份一直持续更新到 2026-09-11（新增「近期更新」章节到第 25 节），精简版只覆盖到早期的 10 节；两份同名文档并存正是「界面叫法不同步」的来源（见 CONSOLE_UI_REDESIGN_REPORT 第 6 条）。**未删除**，保留以便需要对外发布脱敏版时取用 |
| [legacy/AUDIT_REPORT_2026-09-18.md](legacy/AUDIT_REPORT_2026-09-18.md) | 2026-09-18 的架构审查与修复报告（基线 `3c54e6b`，P0~P3 清单） | 🗄️ **被 `audits/AUDIT_REPORT_2026-09-20.md` 取代**：后者是对同一代码库的更新一轮体检，并已覆盖前者的待办 |
| [legacy/ARCH_REVIEW.md](legacy/ARCH_REVIEW.md) | 2026-08-18 的架构审查：严重 #1~#6、中等 #7~#15、轻微 #16~#20、新增 #21~#30 | 🗄️ **问题已全部修复**：文首两份「修复状态」清单逐条标 ✅（含复查残留项），属已结案的历史记录 |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | [guides/PROJECT_GUIDE.md](guides/PROJECT_GUIDE.md) |
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 发语音 / 换 QQ 账号后语音工具 401 | [guides/VOICE.md](guides/VOICE.md)（独立工具在仓库上一级 `../voice-tool/`） |
| 让它发图片 / 往图片库放图 | [guides/SEND_IMAGE.md](guides/SEND_IMAGE.md)、[../media/README.md](../media/README.md) |
| 想发的是"文件"而不是图片 | [guides/SEND_IMAGE.md](guides/SEND_IMAGE.md) 第六节：SnowLuma 没有群文件上传能力，做不了 |
| 让它到点提醒我 / 让它查自己还记得什么 | [guides/REMINDERS.md](guides/REMINDERS.md)、[guides/HISTORY.md](guides/HISTORY.md) |
| 先看六项新能力的全貌与开关 | [guides/NEW_CAPABILITIES.md](guides/NEW_CAPABILITIES.md) |
| 问"你现在什么状态 / 今天花了多少 / 缓存怎么样" | [guides/SELF_STATUS.md](guides/SELF_STATUS.md)（`qq_bridge_status`，只读、默认开） |
| 让它点歌 / 发音乐卡片 | [guides/MUSIC.md](guides/MUSIC.md)（平台卡经第三方签名、默认关；想避免第三方用 `type:'custom'`） |
| 让它管群（踢人/禁言/删消息/处理申请） | [guides/GROUP_ADMIN.md](guides/GROUP_ADMIN.md)（默认关；`kick` 需显式放行） |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md)、[audits/TOKEN_COST_ANALYSIS.md](audits/TOKEN_COST_ANALYSIS.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md)、[audits/CONSOLE_UI_REDESIGN_REPORT.md](audits/CONSOLE_UI_REDESIGN_REPORT.md) |
| 改代码前先知道有哪些坑 | [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md)（最新，DSH 适配）、[audits/AUDIT_FIXES_2026-09-20.md](audits/AUDIT_FIXES_2026-09-20.md)、[audits/AUDIT_REPORT_2026-09-20.md](audits/AUDIT_REPORT_2026-09-20.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 这个项目要往哪走（QSH） | 上位目录的 `../../QSH-plan/`（总索引 `README.md`；另有工具面/技能/云部署/新仓库与官网四份专项） |
