# 新能力总览（发图 / 提醒 / 历史检索 / 自省 / 音乐卡片 / 群管理 / 群聊 +1）

这一页把 2026-10 这一批新增能力的**开关、工具名、端点、上限与当前状态**放在一处，便于启用与排查。
每一项的细节各自有一份说明：`SEND_IMAGE.md`、`REMINDERS.md`、`HISTORY.md`、`SELF_STATUS.md`、`MUSIC.md`、`GROUP_ADMIN.md`。

## 一览

| 能力 | 开关（出厂默认） | AI 工具 | 端点 | 状态 |
| --- | --- | --- | --- | --- |
| ① 发图 | `socialV2.tools.sendImage`（**false**） | `qq_send_image` | `POST /api/socialV2/send-image`（AI）/ `POST /api/media/send-image`（控制台·CLI） | **已上线并端到端验收** |
| ② 自省与花费 | `socialV2.tools.status`（true） | `qq_bridge_status` | `GET /api/socialV2/self-status`（AI）/ `GET /api/self-status`（操作者） | 接线中 |
| ③ 音乐卡片 | `socialV2.tools.sendMusic`（**false**） | `qq_send_music` | `POST /api/socialV2/send-music` / `POST /api/media/send-music` | 接线中 |
| ④ 自主提醒 | `socialV2.tools.reminders`（true） | `qq_set_reminder` / `qq_list_reminders` | `POST`、`GET /api/socialV2/reminders` | **已上线并端到端验收** |
| ⑤ 历史检索 | `socialV2.tools.searchHistory`（true） | `qq_search_history` | `POST /api/socialV2/history/search`、`GET /api/socialV2/history/stats` | **已上线并端到端验收** |
| ⑥ 群管理 | `socialV2.tools.groupAdmin`（**false**） | `qq_group_admin` / `qq_list_requests` | `POST /api/socialV2/group-admin` / `POST /api/group-admin` | 接线中 |
| ⑦ 群聊 +1 | `socialV2.tools.repeatMessage`（true） | `qq_repeat_message` | `POST /api/socialV2/repeat-message` | **已上线并端到端验收** |
| ⑧ 读文件 | `socialV2.tools.readFile`（true） | `qq_read_file` | `GET /api/files/message` | **已上线并端到端验收** |
| ⑨ 点开卡片 | `socialV2.tools.openCard`（true） | `qq_open_card` | `GET /api/cards/message` | **已上线并端到端验收** |
| ⑩ 看视频 | `socialV2.tools.watchVideo`（true） | `qq_watch_video` | （MCP 侧直连 B 站 API，无桥接端点） | **已上线并端到端验收**（m10533：全片采样 + 联系表） |

## 怎么开

1. **控制台**：工具区逐项勾选（写入 `config.json` 的 `socialV2.tools.<flag>`）。✅ **工具开关是热的** ——
   保存后 MCP 进程收到 `config.json` 变化，当场把对应工具启用/停用并发一次 `tools/list_changed`，
   DSH 重新拉清单，通常不到 1 秒。不用重起 MCP、不用重启 DSH、也不用新建会话。详见下面「工具开关是热的」一节。
2. **手改配置**：`config.json` → `socialV2.tools.<flag> = true`。桥接侧调用期读配置（立刻生效）；
   MCP 侧监听该文件、会在 1 秒内跟上（`fs.watch` + 5 秒轮询兜底），**不用重启桥接**。
3. **让模型真正看到新工具**：什么都不用做。DSH 在每个模型步都会重新装配工具表
   （`systemPrompt.assemble()` 在 `preStep` 里调），并且 MCP 客户端注册了
   `listChanged.tools.onChanged → refreshTools()`，收到 `notifications/tools/list_changed` 就当场重同步。
   真实会话日志里能直接看到这种中途变化被记成 `tool-addition` / `tool-removal` 事件（`state/agents/*.jsonl.zstd`）。

## 为什么有些默认是关的

- `sendImage` / `sendMusic` / `groupAdmin` 属于**对外动作**或**影响他人的操作**：
  - 图片发出去撤不回，图片库里常是操作者的私人图，而群聊内容不可信（prompt injection 可以把"发这张图"伪装成你的指令）；
  - 平台音乐卡片需要第三方签名服务；
  - 群管理（禁言/踢人）会真的影响到人。
- `sendVoice` / `setStickerRemark` 的出厂默认同样是关，这批能力与它们保持同一口径。
- **关闭的工具不会出现在模型的工具清单里**（MCP 侧把它 disable，`tools/list` 只列 enabled 的），
  因此不会白付每轮的 schema token，也不会诱导模型误调；而这条**保存即成立**，不用等任何重启。

## 上限与限流（细则见各自文档）

- 图片：`socialV2.media.maxSendBytes` 默认 5 MB（硬上限 20 MB）、单张 ≤ 6400 万像素；`maxPerMinute` 2、`maxPerHour` 10（独立桶，只检查、真发出才记账）。
- 提醒：每条文本 ≤ 200 字、最早 1 秒后、最远 90 天；每会话 ≤ 50 条、全局 ≤ 2000 条；迟到超过 `socialV2.reminders.graceMs`（默认 10 分钟）只标记不补发。
- 历史：保留 `socialV2.history.retentionDays`（默认 30 天）与 `maxBytes`（默认 64 MB）；检索 `limit` ≤ 50、单次扫描有预算（撞上会返回 `truncated=true`）。
- 音乐：默认 `maxPerMinute` 2、`maxPerHour` 10。
- 群聊 +1（`qq_repeat_message`）：**只在群聊**（私聊复读没有意义 ⇒ 400）；复读的是桥接从会话里取出的**原文**，一字不改、不带引用、不带 @，也**不能复读自己**（图片/表情/语音没有文字 ⇒ 400；命中敏感信息检查 ⇒ 403 不复制）；长度受 `send.maxMessageChars` 约束（默认 500，本项目 config.json 现设 2000）；专属闸门 `socialV2.repeat.maxPerHour` 默认 **12**（`0` 或负数 = 不单独限），并且和普通发言**共用** `send.maxSendPerMinute` / `maxSendPerHour`。
- 读文件（`qq_read_file`，主人 m09102）：只读**文本类**后缀（txt/md/json/csv/log/yaml…约 60 种，`src/text-file.js` 的 `TEXT_EXTS`；**不含 pdf/docx/xlsx** —— 那些要真解析器，假装能读比读不了更糟）；单次最多 `socialV2.media.maxFileBytes`（默认 4 MB，硬上限同值）；正文默认截断到 `DEFAULT_MAX_CHARS = 20000` 字并注明「文件较长，只读了前 N 字（全文 M 字）」；编码按 BOM → UTF-8 严格 → GB18030 三级嗅探，中文 Windows 的 GBK txt 也能读对。
- 点开卡片（`qq_open_card`，主人 m09102）：网易云走**公开接口**（`music.163.com/api/song/detail` + `/api/song/lyric`，无需 cookie）拿歌名/歌手/专辑/时长/封面/歌词节选；B 站走 `video-watch.js`（四层降级）。卡片自带的 `musicUrl` 是带 rkey 的临时直链、过期即废，所以**只认歌曲 id**、拿 id 去查才是稳定的。
- 看视频「从头看到尾」（`qq_watch_video` / B 站卡片，主人 m10533）：
  - **采样端点包含**：`sampleTimes(duration, n)` 让第一个点是 `0`（片头）、最后一个是全长（片尾）。旧实现是 `duration*(i+1)/(n+1)`，4 帧只看得到 20%/40%/60%/80% —— 开头讲了什么、结尾什么结果全丢。
  - **拼一张联系表**：默认 `layout:'sheet'`，把 n 个时间点用 ffmpeg `tile=CxR` 拼成**一张**图（列行数由 `sheetGrid(n)` 取接近正方形）。关键收益是**图像成本**：逐张返回时每张图都是一份独立图像输入，所以旧版帧数被迫压到 4~6；拼成一张后 15~24 个时间点只占**一份**成本（实测 16 帧拼 4×4 约 130 KB，比单发 16 张还小）。报告里会写清「左→右、上→下按时间先后」和每个时间点的 `M:SS`。
  - 默认 **8** 个采样点，上限 **24**（`MAX_FRAMES`）；`layout:'list'` 可退回逐张（更清楚但费额度）。
  - 下载流带 300 MB 上限（边下边数，`content-length` 可能缺失或撒谎），超限中断而不是撑爆磁盘。
- 动图（GIF/APNG/动图 WebP）：`qq_get_message_images` 会**自动拆帧**（默认 4 帧、最多 12，长边缩到 512），逐帧以 PNG 交给视觉模型。拆帧失败一律退回原图（绝不因为拆不开而把图丢了）。

## 明确做不到的

- **QQ 群文件「发」**：SnowLuma（OneBot 网关）没有实现 `upload_group_file` / `upload_private_file`，所以 `qq_send_file` 做不了；图片走消息段，不受此限。**「读」已经可以**（`file` 段自带 QQ 直链，见 `qq_read_file`），但那条直链带 rkey、**会过期**——太旧的文件只能如实说读不到，不是 bug。
- **不依赖第三方的平台音乐卡**：平台卡要经 SnowLuma 的 `musicSignUrl`（默认 `https://ss.xingzhige.com/music_card/card`）签名；不想涉第三方就用 `type:'custom'` 的自定义卡（需要自备 `url`+`audio`+`title`）。
- 群管理里 SnowLuma **未实现**的动作一律不做：`set_group_card`、`set_group_leave`、`set_group_name`、`set_group_whole_ban`、`get_group_info`、`get_friend_list`。

## 验收怎么做

- 端到端 HTTP 冒烟（仓库外的一次性脚本，可反复跑）：基线 `/api/status` → 自动挖会话令牌 → 发图（AI 通道默认关应 403、开开关后 dryRun 200；操作者通道 200）→ 提醒 add/list/cancel + 越权应 403 → 历史检索 → ②③⑥ 未接线时自动 SKIP。
- MCP 清单探针：直接 spawn `src/mcp-snowluma-safe.js` 发 `initialize`+`tools/list`，确认哪些工具此刻是**启用**的（disabled 的工具不出现是正确行为）。
- 模块自检：`scripts/test-*.mjs`（send-image / reminders / reminders-http / history-archive / history-http / self-status / music-card / group-admin / repeat-message-http / mcp-tool-registry / tool-hot-toggle）。

## 工具开关是「热的」：保存即生效（曾经不是，这里是踩过的坑）

六项能力里每一项都有自己的 `socialV2.tools.*` 开关，**与控制台其余参数一样是热生效的**：
保存后 MCP 进程发现 `config.json` 变了，当场把对应工具 enable/disable，SDK 内部会发
`notifications/tools/list_changed`，DSH 收到就重拉 `tools/list` —— 通常不到 1 秒，
**不用重起 MCP、不用重启 DSH、也不用新建会话**。

它曾经是冷的（这一段留着，免得改回去）：MCP 进程原先在启动时读一次 `config.json`、据此决定
**注册哪些工具**，于是「关掉」要重起进程才从模型清单里消失、「打开」则永远不生效；更糟的是
父闸门（`socialV2.media/voice/sticker.enabled`）关掉时那个工具既不在注册清单也不在禁用清单，
对账时最该报警的错位反而被吞掉。现在改成**全部注册 + 按活配置 enable/disable**：

- 停用的工具不进 `tools/list`（SDK 的 `tools/list` 处理器按 `enabled` 过滤），**省 token 的效果不变**；
- 调用被停用的工具报 `disabled` 而不是 `not found` —— 对账靠这个区分"关了"和"压根没有"；
- 父闸门也一起热了（`TOOL_PARENT_GATES`），不再有"闸门关掉 ⇒ 工具凭空消失"的形态。

控制台「工具开关」分组会摊开对账（`GET /api/socialV2/tools`，仅控制台可用）：顶部一行汇总 +
每个开关右侧一枚徽章（`已注册` / `未注册` / `⚠️ 开着但未注册` / `⚠️ 关了但还在` / `注册状态未知`）。
数据来自 MCP 进程每 60 秒写出的 `state/mcp-tools.<pid>.json`。
判定逻辑是可测纯函数：`src/mcp-tool-registry.js`，自检 `npm run test:mcp-tool-registry`（85 项）
与端到端 `npm run test:tool-hot-toggle`（23 项，真起 stdio MCP 子进程验证"改完当场变"）。

**唯一还需要动进程的情形**：MCP 进程跑的是老代码（快照没有 `hot` 字段）或它已经死了。
那时点一下桌面「QQ机器人」快捷方式即可 —— `ensure-bot-env.mjs` 会把过期的 `mcp-*.js` 结束掉，
DSH 约 0.5~2 秒用新代码重拉（实测 1793 ms）。这之后**也不用新建会话**。
细节见 [PERSONA_BEHAVIOR.md](PERSONA_BEHAVIOR.md) §1.1 / §1.2。

## 相关文件

- 图片库：`media/images/`（`media/README.md`）
- 提醒状态：`state/reminders.json`
- 历史归档：`state/history/<key>.jsonl`
- MCP 注册快照：`state/mcp-tools.<pid>.json`（每进程一份，死掉的会被顺手清掉）
- 模块：`src/send-image-lib.js`、`src/reminders.js`、`src/history-archive.mjs`、`src/self-status.mjs`、`src/music-card.js`、`src/group-admin.js`、`src/mcp-tool-registry.js`
