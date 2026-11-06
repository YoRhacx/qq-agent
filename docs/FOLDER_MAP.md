# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么、哪些脚本像是过期的一次性产物。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-09-29（v0.2.0 / DSH 0.2.0-rc.2 适配）。新增目录/脚本时请顺手补一行。

---

## 一、顶层布局

```
DSH/                         ← 工作区根（不是仓库根）
├── qq-bridge/               ← 本仓库（QQ ↔ DSH 桥接）
├── voice-tool/              ← 独立「发语音」工具（从 qq-bridge 拆出；不依赖桥接运行）
├── 发语音-图形界面.cmd      ← 工作区根的双击启动器 → 进 voice-tool/ 起图形界面
└── 重启DSH-加载语音工具.cmd  ← 工作区根的运维启动器（重启 DSH 让 MCP 工具重新挂载）
```

`qq-bridge/` 内部：

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：主程序、DSH 客户端、三个 MCP server、黑话/表情/语音/图片共享库（`send-image-lib.js`：图片库路径闸门 + 图片格式嗅探 + 公网图片抓取校验）、`tts.js`（文字转语音：`msedge-tts` 合成 + 清洗截断 + 内容哈希缓存 + 音色表）。**零依赖的四个小手艺**（主人 m09102「看得见别人发来的东西」）：`text-file.js`（文本编码三级嗅探 + 截断）、`xml-lite.js`（极简 XML 解析，卡片要用）、`rich-card.js`（网易云/B 站卡片 → 一行可读摘要 + 稳定 id）、`gif-lite.js`（手写 GIF 解码/拆帧 + PNG 编码）、`card-open.js`（点开卡片：网易云公开接口拿歌词 / B 站交给 `video-watch.js`）；`memory-card.js`（跨会话长期记忆卡：打分 / 五档清晰度衰减 / 有损压缩 / 带预算的提示词渲染，纯函数不碰 fs，说明见 [guides/MEMORY_CARD.md](guides/MEMORY_CARD.md)）、`src/memory-brain.js`（**记忆大脑**：`node:sqlite` 单库长期记忆 —— 五类记忆 / 五路加权检索 / 治理与合并 / 冲突检测 / 蒸馏；纯逻辑 + 一个库，注入块与端点见 [guides/MEMORY_BRAIN.md](guides/MEMORY_BRAIN.md)）、`conversation-closure.js`（对话收束判定：六类收尾信号 → continue/linger/close，只给建议不写状态，说明见 [guides/CONVERSATION_CLOSURE.md](guides/CONVERSATION_CLOSURE.md)）、`purpose-engine.js`（目的引擎：从记忆卡/轻量记忆提炼「心里惦记的事」，八道硬闸门后决定此刻能不能开口，说明见 [guides/PURPOSE_ENGINE.md](guides/PURPOSE_ENGINE.md)）、`token-budget.js`（每日额度：金额/token 双单位各自设线，80% 提醒、100% 停主动开口，读账本不改账本，说明见 [guides/TOKEN_BUDGET.md](guides/TOKEN_BUDGET.md)）；其余内核模块：`dsh-client.js`（DSH 的 HTTP / 事件流客户端，含离线铸造浏览器会话 Cookie 的鉴权）、`dsh-discovery.js`（端点自动发现：env → 配置 → 缓存 → netstat 监听表 → 历史端口，命中后才用 Cookie 复验）、`error-text.js`（错误消息翻成人话）、`forward.js`（合并转发的读取与渲染）、`identity-guard.js`（出站自曝守卫：拦「我是 AI / 我只是个程序」这类说法，放行「我是程序猿」）、`group-admin.js`（群管理动作：撤回 / 禁言 / 审批）、`mcp-host-server.js` + `mcp-tool-registry.js` + `mcp-web-search-safe.js`（对外 MCP 宿主、工具注册表、只读网页检索与抓取）、`md-to-plain.js`（Markdown → 纯文本）、`model-prices.js`（模型单价表）、`music-card.js`（音乐卡片构造）、`preset-prompt.js`（Agent 预设补丁的人格段 / 安全段校验）、`qq-model-view.js`（模型能力视图）、`reminders.js`（到点提醒的解析与投递）、`role-card.js`（人格卡解析、按模式取用、示例空格改写）、`safe-fetch.js`（带 SSRF 校验的抓取）、`self-test.js`（自检 CLI）、`sensitive.js`（敏感词与隐私过滤）、`slang-learner.js`（群黑话候选提取）、`sticker-lib.js`（收藏表情库）、`token-ledger.js`（token / 花费账本）、`v2-wait.js`（二代等待与静默判定） | 不能动。`bridge.js` 是主程序（约 10,400 行，QSH 计划拆分）；`voice-core.js` 与 `snowluma-conn.js` 是**独立工具也在用的单一实现**。**目录里只应有 `.js`**：曾经的 `bridge.js.bak-*` 会污染全局搜索并看起来像 module，2026-09-20 已移出（见下） |
| `scripts/` | 调试 / 测试 / 一次性运维脚本（见第二节命名约定） | 测试脚本不能删；`cleanup-*` / `fix-*` / `patch-*` / `diag-*` 多为历史遗留 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/qq-chat`、`agent-presets/qq-chat-v2`（preset 的**权威源**，含工具白名单 `qq-tool-restrict.mjs` 的 re-export 壳）。DSH 0.1.7 起 preset 以 bundle patch 形式安装，patch 由 `scripts/build-agent-preset-patches.mjs` 从这里的源生成到 `plugins/qq-agent-presets/presets/` | 改 preset 会影响所有人设行为；改完必须重新生成 patch |
| `plugins/` | DSH 插件：`qq-mode-console`（暴露 `qq-mode` 设置命名空间；**只有 host 半**，浏览器 UI 卡片未实现）、`qq-agent-presets`（生成两个 preset 行 + 携带唯一的 `qq-tool-restrict` 权威实现） | 改了要重装/重启 DSH |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100）、`memory-brain.html`（记忆大脑）、`galaxy.html`（记忆星系）、`voice.html`；`assets/` 下放页面插画（`whale-mascot.webp` 星系页立绘，`/assets/*` 路由免令牌、只需白名单扩展名、路径压到 basename 防穿越） | 插画别放体积大的原图（当前 webp 84KB）；历史备份 `console.html.bak` 已移出仓库 |
| `roles/` | 人格卡（`小鲸鱼.md` / `傲娇助手.md` / `README.md`）：控制台「人格与角色」页可编辑，保存即生效 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`；`project-intro.mp4` 已改为 Release 附件、不入库） | 别加体积大的二进制 |
| `audio/` | **语音库**（用户的真实音频）。桥接的 AI 语音工具只能发这里的文件；独立 `voice-tool` 默认也指向这里 | **用户文件，绝不删除/移动** |
| `media/` | **图片库**：`media/images/`（用户的真实图片，可建子目录）+ `media/README.md`。桥接的 AI 发图工具只能取这里的文件；操作者通道（控制台/CLI）才允许库外文件。目录与说明入库，图片本身被 `.gitignore` 排除 | **用户文件，绝不删除/移动**（`.gitkeep` 与 `README.md` 别删，否则新克隆缺目录） |
| `state/` | **运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌、长期记忆卡 `memory-card.json` 与入站缓冲 `memory-inbox.jsonl`）。`.gitignore` 排除 | **用户数据，绝不删除/移动**；`memory-card.json` 删掉等于让她忘掉所有人 |
| `docs/` | 全部文档，按用途分子目录（见第三节） | 见第三节 |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存 | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

**人格 / 记忆 / 表达七层（2026-10-28 第六轮）**：下面七个模块各写自己一份 `state/*.json`，**都不碰** `state/memory-brain.sqlite`，也不往 `roles/*.md` 里写一个字（全部增强都是可裁剪的注入块）：

| 模块 | 作用 | 注入块 / 状态文件 |
| --- | --- | --- |
| `src/persona-state.js` | 情绪层：PAD 心情 + 好感 + 识海（永久记住）+ 旧账（不原谅） | `<!-- PS:BEGIN persona -->` / `state/persona-state.json` |
| `src/memory-profile.js` | 人物画像：谁是谁 / 多熟 / 一句印象 | `【人物印象】` / `state/memory-profile.json` |
| `src/memory-reflection.js` | 每日反思：一天压成一句 + 三条 highlight | `【最近的回想】` / `state/memory-reflection.json` |
| `src/memory-procedural.js` | 程序记忆：这件事这么做（步骤 + 次数 + 成功率） | `【这样做过】` / `state/memory-procedural.json` |
| `src/style-guard.js` | 真人语感：学群友句长/句尾/语气词，出站顺手洗一遍 | `<!-- STYLE:BEGIN -->` / `state/style-guard.json` |
| `src/self-style.js` | 自我语感：防人格漂移，只给 160 字手感 | `<!-- SELF-STYLE:BEGIN -->` / `state/self-style.json` |
| `src/life-loop.js` | 生活层：今天看过什么，给个能接的话头 | `state/life.json` |
| `src/literary-score.js` | 文学性尺子：五项可数指标（具体性/画面/节奏/质感/人味）减一类 AI 腔，0~100 分 + 短板说明；纯函数不调模型，说明见 [guides/LITERARY.md](guides/LITERARY.md) | 无状态（`scripts/fixtures/literary-eval.json` 是基准） |

七层的开关都在 `config.json` 里各自一块（`personaState` / `memoryProfile` / `memoryReflection` / `memoryProcedural` / `styleGuard` / `selfStyle` / `lifeLoop`），`enabled:false` 时连状态文件都不建。说明见 [guides/PERSONA_STATE.md](guides/PERSONA_STATE.md)、[guides/MEMORY_MODULES.md](guides/MEMORY_MODULES.md)、[guides/STYLE_LIFE.md](guides/STYLE_LIFE.md)。

---

## 二、`scripts/` 命名约定

脚本共 125 个文件（122 个 `.mjs` + 3 个 JSON 基线，另有 `fixtures/` 目录）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 QQ 消息、不用生产凭据） | 保留，改动需同步 test-audit 清单 |
| `test-dsh-*.mjs` | **需要活的 DSH**（不在 `test:audit` 里）：`test-dsh-auth.mjs`（鉴权链路）、`test-dsh-inbox-projection.mjs`（会话队列投影解析，离线）、`test-dsh-session-retire.mjs`（退役会话的端到端回归）、`test-dsh-v2-wait.mjs`（preset 工具面） | 保留（改 DSH 契约时必须跑） |
| `test-dsh-discovery.mjs` | **端点自动发现的离线回归**（不需要活的 DSH，`npm run test:dsh-discovery`）：DSH 桌面版用 `--port 0` 启动、每次重启换端口，而失败的形态是**静默的**（拨死端口，日志只剩「连接 DSH 事件流…」）。断言：① 靠 401 正文 `dsh web authentication required` 认身份，普通 200 服务不被误认；② 认不出时**绝不**把会话 Cookie 发给本机其它程序；③ 候选顺序（env → config → 缓存 → 监听表）与命中后写回 `state/dsh-endpoint.json`；④ `netstat` 解析只留 LISTENING。假 DSH/假服务都由测试自己起在本机随机端口 | 保留（改动发现逻辑或 DSH 探活判据必须跑） |
| `test-dsh-endpoint-switch.mjs` | **端点自愈的桥接层回归**（离线，列在 `test:audit` 里，也可单跑 `npm run test:dsh-endpoint`）：把 `discoverDshEndpoint` 桩成"发现到 51144"，断言 ① 发现后 `api.baseUrl` 真的切换、`source/authOk` 记账；② 端点没变返回 `false`（否则每次心跳都打切换日志）；③ 非 force 调用 10 秒节流、force 绕过；④ `dsh.followDiscoveredEndpoint=false` 时一次都不探测；⑤ 发现抛错只记 `lastError`、不改当前端点。配合 `test-dsh-discovery.mjs`（找端点）与真机日志（`🔎 DSH 端点已切到 …`）三层钉住 | 保留（改 `ensureDshEndpoint` 的节流/切换/总闸必须跑） |
| `test-purpose-engine.mjs` | **目的引擎的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:purpose`）：五类候选来源、话题「静了 2h–2d 且存在 ≥1h」的窗口、插嘴保护（对方 15 分钟内说过话不开口）、跨零点静默、三种节奏闸门（min-gap / daily-max / cooldown）、载体互斥、弱候选沉默、状态语义（跨日归零 / 了结不再提）、提示词条数与措辞、配置归一化；另断言 `src/bridge.js` 的 import / `purposeConfig` / 拼进 base 位置 / 概率抬升 / 记账 / `/api/purpose` 端点与示例配置块（**11 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改目的判定或主动机会必须跑） |
| `test-token-budget.mjs` | **每日额度的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:budget`）：金额/token 输入解析（`¥8` / `8.5元` / `8M` / `2万` / `1.5亿`）、配置归一化与阈值越界收敛、off/ok/warn/stop 四档、双单位「谁先到线谁说话」、`inject:false` 不注入、每天只提醒一次且跨天重置、按本地零点切窗口（零点前的桶不算）、`describeBudget` 文案；另断言 `src/bridge.js` 的 import / `cfg.tokenBudget` / 拼进 base 的位置（purposeLine 之后、closureLine 之前）/ `gateProactive` / `/api/budget` 端点与示例配置块（**10 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改额度阈值或闸门必须跑） |
| `test-conversation-closure.mjs` | **对话收束的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:closure`）：问句一票否决（含「那晚安？」这种告别+问句）、告别单独即 close、短确认+冷场先 linger 再加「越说越短」才 close、冷场单独不够、她自己刚提问时绝不 close、阈值/窗口可配、enabled/inject 开关、配置归一化；另断言 `src/bridge.js` 的 import / `closureConfig` / 收束行拼进 base 提示词 / 只读端点 / `config.example.json` 的 `conversationClosure` 块（**10 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改收束判定必须跑） |
| `test-memory-card.mjs` | **长期记忆卡的离线回归**（列在 `test:audit` 里）：打分（主人私聊 > 主人群里 > 群友、情绪/承诺/矛盾/第一次加分、太短降权）、脱敏（QQ 号/手机号/密码/链接不落盘）、去重、衰减（久远琐事变模糊而主人记忆不删、一天只降一档）、压缩（真删且 pinned/主人重要记忆受保护）、渲染预算（超预算补「另有 N 条」）、条数上限；另读 `src/bridge.js` 断言 import / `startMemoryCardMaintenance` / 入站 `rememberInboundForMemory` / `memoryCardLine` 拼进提示词 / 两个端点 / `config.example.json` 的 `memoryCard` 块都在位（纯函数全绿而没接线是这类功能的典型失败形态）（**10 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改记忆卡逻辑必须跑） |
| `test-memory-brain.mjs` | **记忆大脑（SQLite 长期记忆库）的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:memory`）：11 张表建库、五类记忆写入、五路加权检索（`0.18·semantic + 0.46·keyword + 0.11·graph + 0.14·importance + 0.11·freshness`，freshness 14 天半衰期）、bigram 分词命中、`0.82` 文本去重、衰减/归档/180 天清理、`0.92` 相似合并、同实体+反义词的冲突检测、fact/lesson 分类上限、注入块 marker 与群聊可见性、纠正降权、health 四类可修项、12 条窗口幂等；另跑真实 `bridge.js` 的 7 个 `/api/memory-brain/*` 端点（含 `enabled=false` 全 disabled、令牌 401、页面路由 404）（**197 通过 / 0 失败**） | 保留（改记忆大脑逻辑必须跑） |
| `test-persona-state.mjs` | **情绪层（人格状态）的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:persona`）：PAD 三轴心情更新、标签 45 分钟半衰、心情 6 小时回基线、好感/等级/久不联系回落、识海触发词抓取与超预算裁剪、旧账（不原谅 / 提及才想起 / `resolveGrudge`）、注入块 marker 与 `peek`、`stripPersonaBlocks`；纯函数测试，`bridge.js` 接线由 `test-audit-bridge.mjs` 与 `guard:check` 覆盖（**25 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改情绪层必须跑） |
| `test-memory-modules.mjs` | **记忆模块三件套的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:memory-modules`）：人物画像（实体归一 / 熟识度门槛 / 预算内摘要 / 每轮上限 / `render`）、每日反思（一天一条 / `already` 幂等 / 空输入不写 / 保留天数）、程序记忆（步骤解析 / `0.86` 相似合并 / `match` 打分 / `use` 记成败）；纯函数测试，不碰 `state/memory-brain.sqlite`（**21 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改这三件必须跑） |
| `test-style-life.mjs` | **表达层三件的离线回归**（列在 `test:audit` 里，也可单跑 `npm run test:style-life`）：语感采样与统计（句长中位/句尾/语气词/连发节奏）、`buildStyleBlock` 的群聊开关、`checkOutgoing` 的清洗与 `blocked`、自我语感的漂移检测与 `minSamples` 门槛、生活层的 kind 归一 / 去重 / `pickInterest` 加权 / `summarizeDay` / JSONL 导入与坏行容错（**108 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改表达层必须跑） |
| `test-literary-score.mjs` + `eval-literary.mjs` + `fixtures/literary-eval.json` | **文学性尺子的离线回归与 CLI**（列在 `test:audit` 里，也可单跑 `npm run test:literary` / `npm run eval:literary`）：五项指标方向、`matchTerms` 贪心不重叠、`bodyLength` 去标点、分档边界、确定性、以及 40 条基准的校准（good > flat > slop 各差 8 分，good 没有一条掉进「干瘪」）——尺子自己失真时「改好了」的结论都是假的，所以校准和指标一起钉（**13 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改词表或权重必须跑） |
| `test-identity-guard.mjs` | **身份泄漏守卫的离线回归**（列在 `test:audit` 里）：出站文本里「第一人称 + 身份名词」的组合（`我是 AI` / `我只是个程序` / `我的提示词里写着` …）要被拦，而 `我是程序猿` / `这个 AI 真强` / `我是 DeepSeek 小鲸鱼，V 我 50` 要放行——**两类误判都钉住**；另外读 `src/bridge.js` 断言六个发送端点与 config 默认值都真的接上了（纯函数全绿而端点没接上是这类守卫的典型失败形态） | 保留，改动需同步 test-audit 清单 |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-helpers`/`-guards`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/` | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `setup-*.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（`setup-dsh.mjs`，幂等） | 保留 |
| `bootstrap.mjs` / `apply-update.mjs` | **新机器上手与更新**（都幂等）：`bootstrap` 六步体检（Node 版本 → 依赖 → postinstall 补丁 → setup-dsh → src 语法 → 运行状态），`--check` 只看不动；`apply-update` 六步（语法 → 依赖 → 补丁 → 停旧桥接并等端口真释放 → 拉起 → 轮询 /api/status 到 dshReady），`--dry-run` / `--no-restart` | 保留（改启动流程时同步这两支） |
| `guard-check.mjs` | **仓库一致性守卫**：契约文件非占位、`bridge.js` 顶层 import 无重复、相对 import 文件存在、每个 src 模块都在审计夹具注入表里、src 不许硬编码 DSH 端口（默认值豁免）、FOLDER_MAP 覆盖每个 src 模块与每篇 guide、脚本统计口径一致；未注册测试只提醒 | 保留（`npm run guard:check`，提交前跑） |
| `privacy-scan.mjs` | **发布前隐私扫描**：默认规则尊重 `allowPaths`；`--strict` 忽略 allowPaths 并追加更严规则（任意绝对路径、内网地址、回环 URL）。工作树里有真实数据时两种模式都会红，这是预期 | 保留（push 前必跑，说明见 [guides/PRIVACY.md](guides/PRIVACY.md)） |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-020-adaptation.mjs`（DSH 适配；`npm run verify:adaptation`）、`verify-persona-config.mjs`（人格配置） | 保留 |
| `probe-*.mjs` | **探针**：用来问 DSH/SnowLuma「实际支持什么」（RPC 形状、工具清单、事件流、工作区、模型、协议帧、settings 命名空间）。鉴权统一走 `probe-auth.mjs` | 保留，按需重跑 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | 0.2.0 版探针：前者采样 `session/control` baseline、`session/projections`、`session/follow`、`$events`、`session/cancel` 的**原始帧结构**；后者列 settings 命名空间并**幂等写回**验证 `qq-mode` 可写。控制台「改模式不生效」时的第一手诊断 | 保留（`npm run probe:protocol` / `probe:settings`） |
| `scan-dsh-tool-names.mjs` + `dsh-tool-names.mjs` | **工具名对账**：从已安装的 DSH 包里抽真实工具名，与 QQ 守卫的 restrict 名单双向求差（防拼错假名静默失效 / 防新版本新增能力漏隐藏）。抽取实现只有 `dsh-tool-names.mjs` 一份，`test-preset-local-tools.mjs` 与 `scan-dsh-tool-names.mjs` 共用 | 保留（每次升级 DSH 后跑一次） |
| `probe-snowluma-heartbeat.mjs` | 只读探针：连 SnowLuma 的 OneBot WS，等一个 `meta_event/heartbeat`，打印载荷里的 `status.online` / **`status.good`**。桥接的上游健康主信号就是这个字段——它存不存在、拼写对不对只能拿**真实运行时**验证（SDK 不校验 data 载荷，取错字段不会报错）。不发消息、不建会话 | 保留（`npm run probe:heartbeat`） |
| `voice-tool-locator.mjs` | 「发语音」独立工具（在仓库上一级 `../voice-tool/`）的位置解析 + 「它不在本仓库」时的统一跳过口径；支持 `QQ_BRIDGE_VOICE_TOOL_DIR` 覆盖 | 保留（被 6 个测试引用） |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 与 `test-send-image.mjs` 使用；vm context 里需要**显式注入**新共享模块的导出，否则桥接内部会 `ReferenceError`） | 保留 |
| `test-send-image.mjs` | **发图能力**的离线回归：库外路径/`..`/symlink 逃逸、内网与坏 URL、非图片内容、超限、像素炸弹、工具开关关闭、非 reserved2 模式、白名单外目标、限流 429、`dryRun` 不发送、正常路径真的发出 `image` 段。跑真实 `bridge.js` + 假网关，不发任何真实 QQ 消息 | 保留（改发图逻辑必须跑） |
| `test-self-status-http.mjs` | **自省能力**的离线验收（两层）：先直接 `import` `src/self-status.mjs` 断言纯函数（分段、结构化 `data`、1200 字硬截断、五个告警码、缺字段降级），再走 harness 起真实 `bridge.js` 打控制台端口断言 `GET /api/socialV2/self-status`（AI 通道，令牌走 `x-agent-token` 头）与 `GET /api/self-status`（操作者通道）：越权 403、缺凭据 401/403、参数 400、`tools.status=false` 时 AI 403 而操作者仍可用 | 保留（已纳入 `test:audit`；改自省逻辑必须跑） |
| `test-music-card-http.mjs` | **音乐卡片能力**的离线验收（两层）：纯函数层断言平台卡标记 `thirdPartySign:true`/`third-party-sign`、六个平台、自定义卡、13 组非法参数与长度上限；HTTP 层断言 `POST /api/socialV2/send-music`（AI）与 `POST /api/media/send-music`（操作者，字段 `target`）：`dryRun` 零网关调用、真发时交给网关的段是 `{type:'music',data:{type,id}}` 且**不含** `ss.xingzhige.com`、限流 429 按会话独立、`tools.sendMusic=false` 时 AI 403 | 保留（已纳入 `test:audit`；改音乐逻辑必须同步跑 `test-send-image.mjs`） |
| `test-group-admin-http.mjs` | **群管理能力**的离线验收（两层）：纯函数层断言六个动作映射/风险分级/`requiresOwnerApproval`、**`kick` 未放行必返回 `needApproval:true`**、24 组非法参数与截断；HTTP 层断言两个端点（AI / 操作者）、越权、开关关闭。**状态：端点已全部接线，HTTP 断言均为真断言（98 通过 / 0 失败），已纳入 `test:audit`** | 保留（改群管理逻辑必须跑） |
| `test-mcp-tool-registry.mjs` | **「工具开关 ↔ MCP 实际注册」对账**的离线验收（主人问"控制台改完保存是否热生效"查出来的那个冷点）：纯函数层断言四种 state（`ok` / `on-not-registered` / `off-still-registered` / `unknown`）、开关缺省即「开」、**快照不可信时绝不下结论**（不能拿过期清单让人去折腾进程）、多份快照选「活着且最新」的那份、一个开关管多个工具（`memory` 管 4 个）不漏判、**两代快照的可用性口径**（老进程 `registered` 里有即可用；热进程还要看 `disabled`，只看前者会把已关掉的工具误报成"关了却还在"）、文案里**不许**出现「必须重启 DSH」这类会让人白掐掉所有会话的说法；HTTP 层打 `GET /api/socialV2/tools` 断言 401/403/200、无快照与有快照两支、`hot` 透出、错位工具真的被点名（**85 通过 / 0 失败**） | 保留（已纳入 `test:audit`） |
| `test-tool-hot-toggle.mjs` | **工具开关真的会当场变**（不是只测对账表格）：真起一个 stdio MCP 子进程（临时目录 Junction + `--preserve-symlinks`，避免往真 `state/` 写快照）+ 真 MCP Client，改配置后**不重起进程**，断言 ①基线 51 个工具在 ②关掉 `sendImage` ⇒ 当场从 `tools/list` 消失、相邻工具不受影响、收到 `tools/list_changed` ③调它报 `disabled` 而非 `not found` ④再打开 ⇒ 当场回来 ⑤父闸门 `media/voice/sticker` 也热 ⑥注册快照如实反映（`hot:true`、`disabled` 形如 `qq_send_image(sendImage)`）（**23 通过 / 0 失败，约 1.9 秒**） | 保留（已纳入 `test:audit`；只测对账不测这条，MCP 侧同步失效时页面会忠实显示错误结论） |
| `test-tool-flag-alignment.mjs` | **同一个开关在四处名单之间的一致性**（`src/mcp-snowluma-safe.js` 的 `TOOL_CONFIG_FLAGS` / `public/console.html` 的 `data-v2-tool` 勾选框 / `src/bridge.js` 的保存白名单 `toolFlags` / 同文件的 `SOCIAL_V2_TOOL_DEFAULTS` 出厂默认）。漏一处都不会报错，只会安静地变成「界面上看不见 / 保存了不生效 / 关了也拦不住」。真实抓到过两项：`qq_listen_voice` 的 `listenVoice` 没有勾选框（界面上改不了）、`qq_watch_video` 的 `watchVideo` 不在保存白名单里（关不掉）；另断言跨模式共用的 `sendGroup/sendPrivate/reply` 在桥接调用期确有校验（走 `flagMap` 间接写法，所以不能只搜字面量）、`sendImage`/`watchVideo`/`sendMusic`/`groupAdmin` 等有副作用的开关在关掉后仍有一道调用期校验（否则「关掉」只是「藏起来」，HTTP 端点照样能打）、以及 **`config.example.json` 的 `socialV2.tools` 必须覆盖全部出厂键且值一致**（控制台读法是 `c.tools[k] !== false` ⇒ **键缺失 = 显示勾选**，少一个"出厂 false"的键会让新装用户看到反的初始状态；实测曾缺 `watchVideo`/`listenVoice`/`status`/`sendMusic`/`groupAdmin` 五个）（**22 通过 / 0 失败**） | 保留（已纳入 `test:audit`；新增开关时四处都要加，这个自检负责提醒） |
| `test-proc-match.mjs` | **进程识别的防误杀自检**（D 盘上出现过同构的第二个项目 —— `D:\bili-bot\bili-bridge\src\bridge.js` —— 之后必须跑）。旧实现用 PowerShell 匹配命令行 `src\bridge.js`，而 QQ 桥接的命令行是**相对路径**（`node  src\bridge.js`）、B 站桥接也含同样的尾巴 ⇒ 点一下桌面「QQ机器人」快捷方式会把**别的项目正在跑的桥接杀掉**。现在改为①桥接**以端口归属为准**（`portOwnerPid(BRIDGE_PORT)`，B 站在 3200），再用纯函数 `looksLikeQqBridge(cmd)`（含 `src[\\/]bridge\.js` 且**不含** `bili`）做 sanity check，对不上就返回 `[]`（视作"端口被别人占着"，绝不杀）②MCP 用 `looksLikeLocalMcp(cmd, bridgeDir)`（归一化后必须 **includes 本仓库目录**）。另断言 `main()` 只在**直接运行**时执行（否则 `import` 它做自检会顺手把环境改一遍）（**21 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改 `ensure-bot-env.mjs` 的进程匹配必须跑） |
| `test-wake-jitter.mjs` / `test-reply-gap.mjs` / `test-backlog-wake.mjs` / `test-quote-guide.mjs` | **「接话频率 + 引用」四件套**（主人 2026-10-12 要求「不是每条都回，但也不能一条不回」，随后 m10890 迭代为「自主选择最有意思最有梗的那条**引用**回复」）：①抖动——被消息叫醒的窗口 `batchWindowMs` 要加随机抖动，固定时刻（`reminder:`/`schedule:`/`timeout`/`bootstrap`）一律不抖，窗口 <4000ms 也不抖（否则提醒会迟到 / 老部署行为会变）；②接话冷却——`reply.minGapMs`（普通）与 `minGapDirectedMs`（被点名，更短），语义是**延后不是丢弃**；③积压兜底——`wake.backlogWakeAfter`：群聊里自她上次开口后未读攒够 N 条普通消息就**不再掷骰子**、必定唤醒一次（reason `backlog`，优先级 55，仍过软闸门，拍一拍不计入）；④引用引导——`quoteGuideV2()` 按未读人数/条数注入【多人在找你】/【挑一条引用】/【该引用时就引用】+ 恒定【@ 怎么用】，且**只在群聊**（私聊引用没有信息量）。四个自检都含**接线守卫**（直接读 `src/bridge.js` 源码正则断言调用点存在），防止纯函数变成没人调的死代码（**57 / 58 / 43 / 43 项，均 0 失败**） | 保留（已纳入 `test:audit`；改唤醒频率或引用逻辑必须跑） |
| `test-media-inbound.mjs` | **「看得见别人发来的东西」**（主人 m09102：读群里的 txt、读动图、点开网易云/B 站卡片）。这三件事原本**一条通路都没有**：`file` 段只渲染成 `[文件 名字]`（下载直链当场扔掉）、`json` 卡片只渲染成 `[卡片消息]` 四个字（群友发的《雨爱》模型看不见）、GIF 只喂第一帧（首帧常是空白）。分五层断言：①文本化（带标题/歌手/大小，且**不把裸下载直链写进提示词**）②`media` 留存（`kind:'file'`/`'card'` 穿过 `appendSocialV2Message` 的白名单，未知 kind 仍回落 `image`）③端到端 HTTP（两个新端点的 200/403/开关关闭、GBK 正文、无文件/无卡片时的如实说明、**不带 agent token 一律拒**）④动图经 `qq_get_message_images` 变成多帧且帧内容不同 ⑤接线守卫（三处名单 + 控制台勾选框 + 两个 config + 人设卡提到工具名）⑥`mediaHintFor` 指路提示（**别把文件/卡片数成图片**：纯图片消息才指向 `qq_get_message_images`，文件指向 `qq_read_file`、卡片指向 `qq_open_card`，且工具名只在 reserved2 下写出来 —— 一代里模型手里没这些工具，提示它去调一个不存在的工具比不提示更糟）（**129 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改入站段解析或媒体白名单必须跑） |
| `test-gif-frames.mjs` | **GIF 拆帧的真值回归**：`src/gif-lite.js` 的 LZW 解码、调色板合成、隔行重排、disposal 处理**全是手写的**（仓库没有 sharp/jimp/omggif，机器上也没有 ffmpeg），而「跑起来不报错」完全不能说明解对了——帧数对、尺寸对、颜色全错是常见失败模式。真值来自 Pillow 解出的逐帧指纹（宽/高/不透明像素数/不透明像素坐标+RGBA 的 CRC32），夹具是 Pillow 生成的真 GIF，覆盖普通多帧、透明索引 + disposal=2、隔行扫描、`optimize=True`（局部调色板）、12 帧、单帧。另断言单帧不被判成动图、抽帧上限、`maxSide` 缩放与 64 下限、`count=1` 取中间帧而非首帧（动图首帧常是空白）。⚠️ 全透明像素的 RGB 无定义，指纹**只统计不透明像素**——不排除它时 `anim_trans.gif` 会报 80% 差异，其实 alpha 完全一致（实测踩过）（**43 通过 / 0 失败**） | 保留（已纳入 `test:audit`；改 `gif-lite.js` 必须跑，且要重生成真值） |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) §2.6：DSH 沙箱的写权限只靠继承下发能力 SID，切断继承 ⇒ 沙箱里写不进去。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块 | 保留 |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `patch-*.mjs` | **补丁**（含 `postinstall` 的 `patch-snowluma-sdk.mjs`：修 `@snowluma/sdk` 的 ESM 打包 bug） | `patch-snowluma-sdk.mjs` **必须保留**（postinstall 依赖）；其余见第四节 |
| `cleanup-*.mjs` | **清理一次性残留**（probe 会话/工作区、测试会话） | 见第四节 |
| `fix-*.mjs` | **一次性修复**（针对某次运行产生的脏数据） | 见第四节 |
| `diag-*.mjs` | **诊断**（如归档并清理日志） | 见第四节 |
| `debug-*.mjs` | **调试**（如白名单逻辑对照） | 见第四节 |
| `CONSOLE-UI-TESTING.md` | 已移到 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | — |

---

## 三、`docs/` 结构

```
docs/
├── README.md     # 文档索引（每篇一句话 + 是否仍然有效）  ← 先看这个
├── FOLDER_MAP.md # 本文件
├── guides/       # 面向使用者/运维：NEW_CAPABILITIES / DSH_SETUP / DSH_020_ADAPTATION / SECURITY_BASELINE / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PRIVACY / PROJECT_GUIDE / VOICE / SEND_IMAGE / REMINDERS / HISTORY / SELF_STATUS / MUSIC / GROUP_ADMIN / MEMORY_CARD / CONVERSATION_CLOSURE / PURPOSE_ENGINE / TOKEN_BUDGET / PERSONA_BEHAVIOR / MEMORY_BRAIN / PERSONA_STATE / MEMORY_MODULES / STYLE_LIFE / STAR_MAP / LITERARY / MEME_WIKI
├── design/       # 设计与规划：GEN2_SIMULATION_PLAN / SOCIAL_MODE_PLAN / DSH_QQ_TOOLS_PLAN / 真人语感策略
├── research/     # 调研：SnowLuma功能调研 / 免打扰 / 表情包 / 本地模型选型
├── audits/       # 审查与优化报告（最新的全项目体检是 AUDIT_REPORT_2026-09-20）
└── legacy/       # 历史归档（已被取代 / 问题已全部修复的旧报告）
```

> ⚠️ **哪些文档真的会进公开仓库**：`.gitignore` 第 52–64 行把
> `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 以及
> `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` **整体排除**了
> （原因写在那里：这批文档里扫出过多份含本机真实路径的内容）。
> 也就是说：**只有 `docs/README.md`、`docs/FOLDER_MAP.md` 与 `docs/guides/` 下的其余几篇会出现在 GitHub 上**，
> 上面那份索引里指向 `audits/` `design/` `legacy/` `research/` 的链接**对公开读者是死链**，只在本机有效。
> 因此：**要公开的新文档请放 `docs/guides/`**（新写的 `DSH_020_ADAPTATION.md` 就放这里）；
> 放进那四个目录 = 只在本机可见，`git add` 会直接被 .gitignore 挡下。

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档**，其余一律进 `docs/` 对应子目录，
并在 [README.md](README.md) 索引里登记一行（含「仍然有效 / 被谁取代」）。

---

## 四、疑似过期的一次性脚本（未删除，待确认）

> 判断依据：`.gitignore` 已把它们列为「Local one-off dev/debug/patch scripts（machine-specific paths/IDs,
> or bound to artifacts of a single probe run under `state/`）」——也就是说作者当初就认为**它们不该进公开仓库**；
> 加上脚本内容绑定某一次运行留下的 `state/` 残留。**本次整理没有移动或删除任何脚本**，仅列出待人工确认。

| 脚本 | 像是过期的理由 |
| --- | --- |
| `scripts/cleanup-probe-sessions.mjs` | 清理某次 probe 在 DSH 里建的会话；probe 产物已不在（`state/` 下 `self-test*` 目录仍有余留），脚本本身是一次性的 |
| `scripts/cleanup-probe-workspaces.mjs` | 同上，清理 probe 建的工作区 |
| `scripts/cleanup-test-sessions.mjs` | 同上，清理自测会话 |
| `scripts/fix-probe-workspace-title.mjs` | 修某次 probe 工作区标题的脏数据；一次性 |
| `scripts/diag-archive.mjs` | 诊断 + 归档日志；日志归档已手动完成，属一次性运维 |
| `scripts/debug-whitelist.mjs` | 白名单逻辑对照调试；与 `test-audit-*` 的白名单用例重复 |
| `scripts/patch-qq-chat-v2-presleep.mjs` | 给 `qq-chat-v2` preset **打一次补丁**；目标内容现已直接在 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 里，重跑会重复插入 |
| `scripts/patch-qq-chat-v2-stickers.mjs` | 同上（表情包小节） |
| `scripts/patch-qq-chat-v2-collect-memory.mjs` | 同上（收藏 + 记忆小节） |
| `scripts/patch-web-mcp-timeout.mjs` | 给 DSH 的 web MCP 配置打超时补丁；属对**外部 DSH 安装**的一次性改动，重启/升级 DSH 后语义就变了 |
| `scripts/probe-015.mjs` | **v0.2.0 已删除**：针对 DSH **0.1.5** 的探针，结论早已被 verifier 取代，且它走的是 0.1.5 的点号协议路径。同一用途改由 `scripts/probe-020-protocol.mjs`（`npm run probe:protocol`）承担 | 已删除 |
| `scripts/probe-rpc-compat.mjs` / `probe-models.mjs` / `probe-workspace.mjs` / `probe-events.mjs` / `probe-tools.mjs` | 协议/能力探针：问完「DSH 现在长什么样」用处就小了。**v0.2.0 已修好**：它们的鉴权过去各自复制「从 guard 日志抓 launch token」，那条路在 DSH 0.1.7 起就死了（一律 401），现统一走 `probe-auth.mjs` 的离线铸造 Cookie；工作区也改到系统临时目录（`state/` 的 ACL 被收紧，沙箱里写不进去）。挂在 `npm run probe:*` 上，按需重跑 | 保留 |
| `scripts/test-onebot-connection.mjs` / `test-mcp-*.mjs`（`test-mcp-exec` / `-host` / `-safe` / `-web-search`） | **不在** `test-audit.mjs` 的清单里，属手工排查脚本而非回归套件；功能上被 `check-onebot-status.mjs` / `test-audit-security-mcp.mjs` 覆盖 |

处理建议（**没有执行**，等确认）：确认无用后整批移到一个不影响 `npm run test:audit` 的位置
（例如 `scripts/legacy/`），或直接删除——它们都不在 `package.json` 脚本里，也没有被 `test-audit.mjs` 引用，
移动不会影响任何自动化回归。反过来，**下面这些千万别当"过期脚本"清掉**：

- `scripts/patch-snowluma-sdk.mjs`（`postinstall` 依赖，删了 `npm install` 就坏）
- `scripts/test-audit.mjs` 清单里的每一个（完整清单见该文件 `tests[]` 数组）
- `scripts/console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/`（控制台回归基线）
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs`（被测试/工具引用）

---

## 五、独立工具 `voice-tool/`（不在本仓库内）

| 路径 | 作用 |
| --- | --- |
| `voice-tool/voice-cli.mjs` | 命令行：交互菜单 / `send` / `list` / `check` / `remove` / `status` |
| `voice-tool/voice-gui.mjs` | 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌 + 浏览器 UI |
| `voice-tool/public/voice.html` | 图形界面前端（拖拽上传、试听、音量、发送、历史） |
| `voice-tool/发语音.cmd` | 命令行启动器（纯 ASCII，双击即用） |
| `voice-tool/config.json` | 工具自己的配置（**可选**）。本机显式把 `voice.voiceDir` 指向 `../qq-bridge/audio`，让已有音频继续可见 |
| `voice-tool/config.example.json` | 配置模板 |
| `voice-tool/state/` | 运行时：`voice-gui-url.txt`（当前界面地址 + 一次性令牌） |

共享内核**不复制**：工具经 `../qq-bridge/src/voice-core.js` 与 `../qq-bridge/src/snowluma-conn.js`
引同一份实现（qq-bridge 里的 `src/send-voice-lib.js` 也是转发这同一份）。
