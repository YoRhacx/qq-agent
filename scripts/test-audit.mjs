// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  // DSH 端点自愈的**桥接层**（m00138「根治」）：发现到新端口后 api.baseUrl 真的切换、
  // 端点没变不重复切、10 秒节流、总闸与失败路径。故障形态是静默的（WS 连不上时
  // 生成器正常 return、不抛错），只能靠断言。发现逻辑本身见 test-dsh-discovery.mjs。
  'test-dsh-endpoint-switch.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 错误可读化（2026-10-23「她变笨」的直接诱因之一）：`${error?.message ?? error}` 遇到普通对象
  // 会变成 `[object Object]`，模型等于没被告知原因。这里锁住任意形状错误值 → 一句话。
  'test-error-text.mjs',
  // 身份泄漏守卫（第一轮照 SurfCore 学的第 1 项）：她出站的话里一旦承认「我是 AI / 模型 /
  // 程序」或抖出提示词，群友的幻觉当场就破。判据是「第一人称 + 身份名词」的组合，两类误判
  // 都要钉住：真自曝漏过去、正常说话被砍（我是程序猿 / 这个 AI 真强 / 我是 DeepSeek 小鲸鱼）。
  // 纯函数全绿而发送端点没接上也是白做，所以同一脚本里还断言 bridge.js 的六处接入点与
  // config 默认值都在位。
  'test-identity-guard.mjs',
  // 长期记忆卡（第二轮照 SurfCore 学的第 2 项）：跨会话记忆的打分/衰减/压缩/预算渲染。
  // 同样带接入断言——只测纯函数、bridge.js 没接线，等于什么都没发生。
  'test-memory-card.mjs',
  'test-memory-brain.mjs',
  // 七层里的情绪层：PAD 心情、好感、识海（永久记住）、旧账，以及 45 分钟标签半衰 /
  // 6 小时心情回基线这两种「遗忘」。纯函数，不碰 state/ 真目录。
  'test-persona-state.mjs',
  // 记忆三件套（人物画像 / 每日反思 / 程序记忆）：从记忆库的只读输入压成能用的三样，
  // 各写自己一份小 JSON，不碰 state/memory-brain.sqlite。
  'test-memory-modules.mjs',
  // 表达层三件（真人语感 / 自我语感 / 生活层）：学群友怎么说话、防自己人格漂移、
  // 今天看过什么。出站清洗也在这里钉住。
  'test-style-life.mjs',
  // 文学性的「尺子」（主人 m06842 问「怎么训练文学性」→ 结论是不训练、先有尺子）：
  // 五个可数指标（具体性/画面/节奏/质感/人味）减一类 AI 腔，纯函数不调模型。
  // 光测指标不够——尺子自己失真时任何「改好了」的结论都是假的，所以同一脚本里
  // 还锁住 40 条基准（good > flat > slop 各差 8 分）。CLI 见 npm run eval:literary。
  'test-literary-score.mjs',
  // 对话收束（第三轮照 SurfCore 学的第 3 项）：六类信号 → continue/linger/close，只给建议。
  // 关键红线在测试里钉死了：对方在提问时永远不许判 close。
  'test-conversation-closure.mjs',
  'test-purpose-engine.mjs',
  'test-token-budget.mjs',
  // 拟人化行为（主人 2026-10-11 的要求）：唤醒延迟抖动（固定时刻唤醒绝不能抖）与
  // 「主人私聊是唯一允许谈后台的会话」这条边界（提示词里必须显式点名，不能靠她猜 QQ 号）。
  'test-wake-jitter.mjs', 'test-owner-private-scope.mjs',
  // 黑话只在群聊里学、按出现次数挑词 + 待学习窗口跨重启存活（主人 m01652）。
  'test-slang-frequency.mjs',
  // 接话冷却（主人 2026-10-12 的「2+1」）：@ 也别秒回、普通消息要等冷却，且控制台必须有地方改。
  'test-reply-gap.mjs',
  // 积压兜底（主人 m07680 的方案 B）：「不是每条都回，但不能一条不回」。
  // 只掷概率是不够的 —— p=0.12 时 5 条消息至少中一次只有 1-0.88^5≈47%，孤条消息更是
  // 88% 永远不回（之后没有新消息，触发判定再也不会被调用）。这里锁住那条确定性兜底：
  // 攒够 backlogWakeAfter 条就必定唤醒、软闸门照旧生效、提示词两层都教「挑最有梗那条接住」。
  'test-backlog-wake.mjs',
  // 引用口径 + @（主人 m10890 提需求 → 2026-10-13 收窄）：第一版实现过头了，只要 unread>=1
  // 就注入【该引用时就引用】，实测把群聊引用率推到 90%，主人连吐槽四次「句句引用你是人机？」。
  // 现在引用**默认关闭**，只有两处必须引：① 两个人以上同时找她；② 她接的不是最新那一条。
  // 分档注入改为「只在多人在找她时给」，未读多/少两档不再催；人格层/preset/工具描述都写「默认不引」。
  // 外加恒定的 @ 用法说明。这段引导依赖运行时信息，所以放桥接层而非只写角色卡。
  'test-quote-guide.mjs',
  // 「看得见别人发来的东西」（主人 m09102）：读群里的 txt、读动图、点开网易云/B 站卡片。
  // 三件事原本一条通路都没有：file 段只吐文件名（下载直链当场扔掉）、json 卡只吐
  // 「[卡片消息]」四个字（群友发的《雨爱》模型看不见）、动图只喂第一帧（首帧常是空白）。
  // 这里锁住：文本化带标题、media 留住直链、GIF 真拆成多帧、两个端点鉴权+开关、三处名单齐全。
  'test-media-inbound.mjs',
  // GIF 拆帧的**真值回归**（主人 m09102 的「读动图」）：src/gif-lite.js 的 LZW 解码、
  // 调色板合成、隔行重排、disposal 处理全是手写的（没有 sharp/jimp/omggif，也没有 ffmpeg），
  // 「跑起来不报错」完全不能说明解对了 —— 帧数对、尺寸对、颜色全错是常见失败模式。
  // 这里拿 Pillow 解出的逐帧像素指纹当真值，夹具是 Pillow 生成的真 GIF（透明/隔行/局部调色板）。
  'test-gif-frames.mjs',
  // 「从头看到尾」（主人 m10533）：旧实现 `duration*(i+1)/(n+1)` 永远采不到片头片尾，
  // 而且逐张返回图片（每张一份图像成本）逼得帧数只能 4~6。现在改成端点包含采样
  // + 拼一张联系表，于是 15~24 个时间点只占一份图像成本。
  // 采样公式退回去不会报任何错，只会让鲸鱼娘讲视频时缺头少尾 —— 必须靠断言钉住。
  'test-video-sampling.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // 新能力（自省 / 音乐卡片 / 群管理）的离线验收：跑真实 bridge.js + 假网关，
  // 不发真实 QQ 消息、不依赖活进程（`QQ_BRIDGE_TEST_LIVE=0` 下同样成立）。
  // 纯函数层直接 import 模块断言，HTTP 层打 harness 起的控制台端口。
  'test-self-status-http.mjs',
  'test-music-card-http.mjs',
  // 群管理的三个端点（`POST /api/socialV2/group-admin`、`POST /api/group-admin`、
  // `GET|POST /api/socialV2/group-requests`）与 `bot.onRequest` 申请通道**已接线**，
  // 所以它现在可以安全纳入：任何一个端点被改坏，这里会立刻变红。
  'test-group-admin-http.mjs',
  // 群聊 +1（`qq_repeat_message` / `POST /api/socialV2/repeat-message`）：整段端点已在
  // 真实 bridge.js + 假网关上端到端验收（原文一字不改、只在群聊、失败不吃频率配额），
  // 外加 6 处登记点的静态断言 —— 漏登记的后果是"控制台关了模型仍收到 schema"这类静默故障。
  'test-repeat-message-http.mjs',
  // 「工具开关 ↔ MCP 实际注册」对账（主人问"控制台改完到底热不热生效"查出来的那个冷点）：
  //   历史上 MCP 进程启动时读一次 config.json 就不再读盘 ⇒ 关掉的工具模型仍看得到
  //   （schema 照发）、打开的工具根本注册不上；光看 config.json 一个字都看不出来。
  //   现在 MCP 侧改成热生效（全部注册 + 按活配置 enable/disable），但**旧进程仍可能存在**
  //   （快照没有 hot 字段），所以两代语义都要认。这里锁住四种 state 判定、
  //   「快照不可信时绝不下结论」、以及一个开关管多个工具时不漏判。
  'test-mcp-tool-registry.mjs',
  // 热生效的**端到端**验证：真起 stdio MCP 子进程 + 真 MCP Client，改配置后不重起进程，
  // 断言工具当场从清单里消失/回来、且发出 tools/list_changed。
  // 上面那个测的是"对账逻辑"，这个测的是"MCP 真的会跟着变" —— 两条缺一不可：
  // 只测对账，MCP 侧的同步一旦失效，页面会忠实地显示一个错误结论。
  'test-tool-hot-toggle.mjs',
  // 同一个开关在**四处**各写一遍（MCP 的 TOOL_CONFIG_FLAGS、控制台的勾选框、
  // 桥接的保存白名单、桥接的出厂默认表），漏一处不会报错，只会安静地变成
  // 「界面上看不见 / 保存了不生效 / 关了也拦不住」。这里把它们两两对齐。
  // 真实抓到过：qq_listen_voice 没有勾选框、qq_watch_video 不在保存白名单里。
  'test-tool-flag-alignment.mjs',
  // 启动器的**进程识别**：D 盘上有同构的第二个项目（B 站那套 bili-bridge），
  // 它的入口同样叫 `src\bridge.js`、MCP 同样叫 `src\mcp-*.js`。旧写法按命令行文本匹配，
  // 点一下快捷方式就把**别人的桥接**杀了（2026-10-12 实际踩到）。这里钉住
  // 「桥接按端口归属识别 + 命令行 sanity check」「MCP 必须锚定本仓库绝对路径」。
  'test-proc-match.mjs',
  // 还该补进来的（前几轮接线留下的同类验收，目前没进这套 audit）：
  // `test-reminders-http.mjs` / `test-history-http.mjs` / `test-send-image.mjs`。
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
