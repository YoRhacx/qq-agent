# AGENTS.md — 在 qq-bridge 里干活的规矩

> 给「下一个改这个仓库的人」——不管那是真人还是 AI。
> 这里写的不是理想架构，是**这个仓库真的踩过的坑**换来的最低要求。
> 现状速查：[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)；踩过的坑：[PITFALLS.md](PITFALLS.md)；案例复盘：[docs/cases/](docs/cases/)。

## 一、这个仓库是什么

QQ 机器人的桥接层：一边连 SnowLuma（QQ 侧 OneBot 网关），一边连 DSH（DeepSeek Harness）的事件流，
中间负责唤醒、提示词拼装、回复落地、限流与护栏。

| 文件 | 是什么 | 能不能随便改 |
| --- | --- | --- |
| `src/bridge.js` | 主进程，一万四千行：启动、事件泵、唤醒、发送、控制台 HTTP | 能改，但每次改完必须重启并 netstat 验证 |
| `src/*.js`（其余） | **纯函数模块**：零 import、零 I/O、可单测 | 新能力优先落在这里 |
| `scripts/test-*.mjs` | 测试。断言纯函数 **+ bridge.js 的接线点** | 新模块必须同时加 |
| `scripts/audit-bridge-harness.mjs` | 用 vm 跑真实 `bridge.js` 的审计夹具 | 新模块的导出**必须注入**，否则运行时 500 |
| `scripts/probe-*.mjs` | 对真实 DSH/SnowLuma 的探针（会起会话，只读为主） | 谨慎跑，别在主人睡觉时跑 |
| `docs/guides/*.md` | 每个能力一篇说明（为什么/怎么配/不做什么） | 改了行为就改它 |
| `config.json` | **主人手写的运行配置** | ❌ 不许程序化覆盖；要改走控制台或 `config.example.json` |
| `roles/*.md` | 人格卡（`小鲸鱼.md` 是主人在维护的） | ❌ 不许覆盖；测试只读 |
| `state/` | 运行期状态（账本、记忆卡、锁、日志） | ❌ 不提交、测试不许写真实目录 |

## 二、一次改动的完整闭环（照顺序做，别跳）

1. **纯函数模块**：`src/<name>.js`。零 `import`、零文件读写、零网络；所有输入从参数来，所有出口是返回值。
2. **接线**：在 `src/bridge.js` 里 import、读配置、拼提示词或挂闸门、暴露只读端点。
3. **测试**：`scripts/test-<name>.mjs`，**两类断言都要有**——纯函数行为 + `bridge.js` 里那些字符串/位置/端点是否真的接上了。
4. **注册**：`scripts/test-audit.mjs` 的清单加一行；`scripts/audit-bridge-harness.mjs` 的 `vm.createContext({...})` 里注入 `import * as <name>` 与 `...<name>,`。
5. **文档**：`docs/guides/<NAME>.md`（八到九节：为什么/机制/配置/端点/不做的事/测试）；`docs/README.md` 索引行；`docs/FOLDER_MAP.md` 三处（`src/` 行、`guides/` 树、测试行）+ 脚本总数；`README.md` 配置表；`config.example.json` 示例块。
6. **重启并**真机**验证**：跑 `npm run apply-update`（或手动重启），确认端口在听、`/api/status` 里 `dshReady=true`、新端点返回合理值。
7. **记账**：遇到新坑 → [PITFALLS.md](PITFALLS.md) 加条目；值得复盘的故障 → `docs/cases/` 加一篇。

> 只做第 1 步和第 3 步（纯函数绿了）在测试上看起来是"完成"，在真机上是**什么都没发生**。
> 反过来，只接线不写文档，下一个人会以为这个模块不存在。

## 三、硬约束（违反会静默出错）

1. **DSH 端口不是常量**。桌面版用 `--port 0`，每次重启换端口。任何"连 19387/3080"的硬编码都是 bug；
   只有 `LEGACY_DSH_PORTS`（`src/dsh-discovery.js`）和白名单探测可以出现这些数字。
2. **重启后必须 `netstat` 确认 3100 在 LISTENING**，别看日志最后一行。
   supervisor 停在 `:already/pause` 时**一行日志都不会有**；`get_goal` 说"已启动"也可能是假的。
3. **审计夹具会剥掉 `bridge.js` 的顶层 import**（`scripts/audit-bridge-harness.mjs` 用 vm 注入）。
   所以：重复 import、少注入一个绑定、引用不存在的符号，**单测和 audit 都可能全绿而桥接起不来**。
   改完 `bridge.js` 必须真的重启一次。
4. **`state/` 只属于运行中的进程**。测试用 `fs.mkdtemp()`；不许读写真 `state/`，否则会污染账本、记忆卡、唤醒计时。
5. **别覆盖主人的文件**：`config.json`、`roles/*.md`。要改默认值改 `config.example.json`，要改运行值走 `POST /api/...`。
6. **控制台 API 需要令牌**：`x-console-token`（见 `config.json` 的 `consoleToken`），agent 面用 `x-agent-token`。
   看到 401/403 先想"是不是没带令牌"，别急着改鉴权。
7. **出站内容有护栏**：身份自曝（`identity-guard`）、额度（`token-budget`）、插嘴保护（`conversation-closure`）都会拦。
   测试时如果"话没发出去"，先查这些闸门，不要绕过。

## 四、常用命令

| 目的 | 命令 |
| --- | --- |
| 跑全量审计 | `npm run test:audit`（约 55 个脚本，必须只剩那 3 个环境失败） |
| 仓库规矩体检 | `npm run guard:check` |
| 发布前隐私扫描 | `npm run privacy-scan:strict` |
| DSH 适配总验证 | `npm run verify:adaptation`（需要 DSH 在跑；`DSH_BASE_URL` 可指定端口） |
| 新机器/第一次装 | `npm run bootstrap`（幂等，可反复跑） |
| 改完代码上线 | `npm run apply-update`（语法→依赖→setup→重启→自检，幂等） |
| 单测某个能力 | `npm run test:purpose` / `test:budget` / `test:closure` / `test:role-card` … |

**运行 node 的方式**：这台机器的 `PATH` 里没有 node，统一用 DSH 自带的 Electron 运行时：

```
ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/xxx.mjs
```

长输出必须重定向到文件再读（在 bash 里 `>` 是可靠的；PowerShell 的 `>` 有时得到 0 字节空文件）。

## 五、"我该先看哪里"

| 症状 | 先看 |
| --- | --- |
| 桥接连不上 DSH / 每 3 秒刷"连接 DSH 事件流…" | [docs/guides/DSH_DISCOVERY.md](docs/guides/DSH_DISCOVERY.md)、`state/bridge.log`、`/api/status` 的 `dsh` 字段 |
| 她说话不对味 / 人格没生效 | `roles/小鲸鱼.md`、`role.maxInjectChars`、`GET /api/roles/content` |
| 她"变笨"、回复只有一句废话 | 错误可读化、`tokenLine`、`/api/usage` |
| 该主动说话却一直沉默 | `/api/purpose`、`/api/socialV2/closure`、`/api/budget`（额度可能 stop）、`state/bridge.log` 的 `[purpose]`/`[budget]` |
| 控制台打不开 / 401 | `consoleToken`、Host 头校验、`/api/status` |
| 测试莫名其妙变红 | `scripts/audit-bridge-harness.mjs` 注入、base 拼接断言、`state/` 被脏写 |

## 六、提交前（人也要做）

```
npm run test:audit        # 允许且只允许那三个环境失败
npm run guard:check       # 仓库规矩（重复 import、测试未注册、文档滞后、硬编码端口…）
npm run privacy-scan:strict   # 真实 QQ 号/路径/令牌一个都不能带出去
```

三条全过才算"改完"。任何一条红了，先修，不要用 `--no-verify` 绕过。
