# PITFALLS.md — 这个仓库踩过的坑

> 每条都是**真的发生过**、且**当时测试是绿的**或**日志什么都没说**的那种。
> 目的不是记流水账，是让下一个人（或下一轮的我）少花两小时。
> 结构：症状 → 根因 → 处置 → 预防。深一点的复盘在 [docs/cases/](docs/cases/)。
> 新踩到坑就加一条，编号连续；修完的坑把「预防」里那条落到 `npm run guard:check`。

## 索引

| 编号 | 一句话 | 症状类型 | 案例 |
| --- | --- | --- | --- |
| P-001 | 重复 `import` 让桥接起不来，单测与 audit 全绿 | 启动即崩 | [case-002](docs/cases/case-002-duplicate-import-green-tests.md) |
| P-002 | 审计夹具剥掉顶层 import，vm 少注入一个绑定 → 运行时 500 | 测试骗人 | [case-002](docs/cases/case-002-duplicate-import-green-tests.md) |
| P-003 | 把「base 拼接顺序」写成相邻字符串断言，插一行就红 | 测试脆 | [case-003](docs/cases/case-003-base-order-assertions.md) |
| P-004 | PowerShell `>` 重定向得到 0 字节日志 | 环境 | — |
| P-005 | MSYS bash 里 `taskkill /F` 的 `/F` 被当成路径 | 环境 | — |
| P-006 | DSH 每次重启换端口，桥接写死 19387 → 3 秒一次静默重连 | 静默故障 | [case-001](docs/cases/case-001-dsh-port-silent-loop.md) |
| P-007 | WebSocket 连不上时生成器正常 return，`catch` 抓不到任何东西 | 静默故障 | [case-001](docs/cases/case-001-dsh-port-silent-loop.md) |
| P-008 | supervisor 停在 `:already`/`pause`，日志零输出、端口不听 | 运维 | [case-001](docs/cases/case-001-dsh-port-silent-loop.md) |
| P-009 | 人格注入上限 / 体积护栏是两道上限，先撞哪道都不明显 | 配置 | [case-004](docs/cases/case-004-role-injection-truncation.md) |
| P-010 | 用模板字符串写含反引号的 Markdown → 语法错，白写一遍 | 工具使用 | — |
| P-011 | CRLF 让 `\/\/.*$` 剥不掉注释，正则误报 | 细节 | — |
| P-012 | 控制台 401/403：先查令牌与 Host 头，别怀疑鉴权逻辑 | 排障 | — |
| P-013 | 测试写真实 `state/`，污染账本与唤醒计时 | 测试卫生 | — |
| P-014 | `${err?.message ?? err}` 遇到普通对象变成 `[object Object]` | 可观测性 | — |
| P-015 | 脚本把 DSH profile 名写死 `web`，桌面版直接 ENOENT | 环境假设 | — |
| P-016 | `loadConfig()` 是白名单组装：config.json 写了新块也当没写，`enabled:false` 关不掉 | 配置静默失效 | — |

## P-001 重复 import：测试全绿，桥接起不来

**症状**：`node src/bridge.js` 立刻 `SyntaxError: Identifier 'analyzeClosure' has already been declared`，
桥接根本起不来；而 `npm run test:audit` 51/54 全绿、模块单测 10/10。

**根因**：给 `src/bridge.js` 加能力时，同一行 import 被插了两遍（两次编辑各加了一次）。
Node 的 ESM 对重复声明是**语法错误**，但审计夹具会把 `bridge.js` 的顶层 import 全部剥掉再 vm 注入，
所以测试看不到这段代码。

**处置**：删掉重复行，重启，`netstat` 确认真在听。

**预防**：`npm run guard:check` 会解析 `bridge.js` 的顶层 import 并报重复标识符；
改完 `bridge.js` 必须真的起一次进程（见 AGENTS.md 硬约束第 3 条）。

## P-002 审计夹具少注入一个绑定

**症状**：审计里跑到真实 `bridge.js` 的用例报 `ReferenceError: <name> is not defined` 或端点 500；
纯函数测试仍然全绿。

**根因**：`scripts/audit-bridge-harness.mjs` 剥掉顶层 import 后，靠 `vm.createContext({...})` 手工注入绑定。
新模块 `export` 了函数，但注入表里没加 `import * as x` / `...x`，于是 `bridge.js` 里那个名字在沙箱里不存在。

**处置**：在注入表里加两行（import + spread），位置紧随同类模块。

**预防**：guard-check 会比对 `src/*.js` 的导出与 harness 的注入名，漏了就报。

## P-003 base 拼接顺序断言太脆

**症状**：往唤醒提示词里插一行（`purposeLine`、`budgetLine`），三个**不相关**的测试一起红：
`test-conversation-closure` / `test-purpose-engine` / …。

**根因**：断言写成了相邻关系 `/memoryCardLine \+ purposeLine \+ closureLine/`，
插一行就再也不相邻。而这几行的**真实要求**只是「都在 base 里、相对顺序成立」。

**处置**：改成 `const base = [^;]*A[^;]*B[^;]*;` 这种「在同一句里 + 先后顺序」的写法。

**预防**：顺序类断言优先用 `indexOf` 比较，或匹配「同一条语句内、按序出现」。见 [case-003](docs/cases/case-003-base-order-assertions.md)。

## P-004 PowerShell 重定向得空文件

**症状**：`& node script.mjs > log.txt` 之后 `log.txt` 是 0 字节，作业却报 exit 0。

**根因**：这台机器上 DSH 的 Electron 运行时 + PowerShell 原生重定向的组合会丢输出（编码/管道问题）。

**处置**：改用 bash：`ELECTRON_RUN_AS_NODE=1 "/d/dsh/.../DeepSeek Harness.exe" script.mjs > /tmp/x.log 2>&1`，
或 PowerShell 里用 `| Out-File -Encoding utf8`。

**预防**：长输出永远重定向到文件再 `tail`；读完确认字节数不为 0。

## P-005 MSYS bash 里 taskkill 的 /F 被路径转换

**症状**：`taskkill /F /PID 123` 报「无效参数」，因为 `/F` 被 MSYS 转成了 `F:/`。

**处置**：用 PowerShell `Stop-Process -Id 123 -Force`；或 `MSYS_NO_PATHCONV=1`。

## P-006 DSH 端口不是常量

**症状**：控制台每 3 秒刷一行「连接 DSH 事件流…」，没有任何报错；`/api/status` 里 `dshReady: false`，
QQ 侧一切正常（`snowluma.connected=true`）。

**根因**：桌面版 DSH 用 `--port 0` 由系统分配端口，重启就换（19387 → 51144 → 55608 …）；
桥接 `config.json` 写死 `http://127.0.0.1:19387`，那里已经没有任何监听。

**处置**：`src/dsh-discovery.js` 两阶段发现（先探已知候选不带 Cookie，再 `netstat` 找监听进程），
命中后用离线铸造的 Cookie 复验；桥接 `ensureDshEndpoint()` 在启动/就绪前/事件流每轮调用；
状态落 `state/dsh-endpoint.json`。详见 [docs/guides/DSH_DISCOVERY.md](docs/guides/DSH_DISCOVERY.md)。

**预防**：`src/` 里除 `LEGACY_DSH_PORTS` 外不许出现 19387/3080 字面量（guard-check 会查）。

## P-007 断线为什么没有声音

**症状**：连接失败时 `src/bridge.js` 的 `pumpMux()` 只有「连接 DSH 事件流…」，
`catch` 里的「事件流中断」一次都没出现。

**根因**：`_remoteMuxGenerator` 在 WebSocket **打开之前**就失败时，走 `handleClose/handleError` → `endStream()`，
生成器**正常 return**；`for await` 正常结束，不抛错，于是 `catch` 永不触发。

**处置**：给 client 加 `onStreamFailure` 回调（记录 `reason`/`code`/`message` 与目标 URL，10s 连接超时），
桥接侧打 `⚠️ DSH 事件流未建立…`。

**预防**：凡是「正常结束」和「失败」共用一条路径的地方，都必须有显式的失败回调（见 [case-001](docs/cases/case-001-dsh-port-silent-loop.md)）。

## P-008 supervisor 假活

**症状**：杀进程后等 10 秒，端口不听；`start-bridge.cmd` 的窗口（或隐藏 cmd）还在，日志停在上一行，
`:already` 分支不会打任何东西。

**处置**：`Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where CommandLine -like '*start-bridge.cmd*' | Stop-Process -Force`，
再 `Start-Process cmd.exe -ArgumentList '/c','D:\qq-bot\start-bridge.cmd' -WindowStyle Hidden`，等 10s 后 `netstat`。

**预防**：`npm run apply-update` 内含「停旧进程 → 拉起 → 轮询端口 → `/api/status`」四步，替代手工重启用。

## P-009 两道上限：注入字符数 与 文件体积

**症状**：人格卡明显被截断（尾部三节全丢），控制台提示只写了「超出注入上限」。

**根因**：注入上限 `role.maxInjectChars`（原 20000 硬顶 18500 默认）与文件体积护栏 `ROLE_CONTENT_MAX_BYTES`（原 64KB）
是**两套**限制；卡片 20371 字符先撞前者，而 2.5 万汉字约 7 万字节又会撞后者。

**处置**：上限抬到 25000（代码 clamp、控制台 `max`、文档同步），体积护栏抬到 128KB；
运行时用 `POST /api/roles/limit` 落盘，不等重启。见 [case-004](docs/cases/case-004-role-injection-truncation.md)。

**预防**：`GET /api/roles/content` 要同时看 `chars` / `bytes` / `truncated`；改上限时三处一起改（代码、前端、文档）。

## P-010 模板字符串写 Markdown

**症状**：写文档的脚本 `Expected ';', '}' or <eof>` / `Expression expected`，文件没写成。

**根因**：外层用模板字符串，正文里的 Markdown 反引号把模板提前闭合。

**处置**：改用**字符串数组 + `join("\n")`**，或把内层反引号全部转义。

## P-011 CRLF 与注释剥离

**症状**：`stripComments` 之后仍然命中旧模型名，误报。

**根因**：JS 的 `.` 不匹配 `\r`；`split('\n')` 后行尾带 `\r`，`\/\/.*$` 的 `$` 够不到行尾。

**处置**：`split(/\r?\n/)`。**预防**：所有按行解析的脚本都显式处理 CRLF。

## P-012 控制台 401/403

**症状**：`curl http://127.0.0.1:3100/api/status` 返回 401 / 「dsh web authentication required」；或控制台端点 403。

**处置**：控制台端点带 `x-console-token`（`config.json` 的 `consoleToken`）；agent 面端点带 `x-agent-token`；
`/api/status?token=` 用查询参数。Host 头必须精确匹配（防 DNS rebinding），别用 `127.0.0.1.nip.io` 试。

## P-013 测试别写真实 state

**症状**：跑完测试，账本数字变了、记忆卡多了条目、唤醒计时被打乱。

**根因**：测试沿用了默认 `STATE_DIR`。

**预防**：测试里一切落盘走 `fs.mkdtemp()`；只读校验用 `GET` 端点或直接读文件不写。

## P-014 `[object Object]`

**症状**：日志/提示词里出现 `[object Object]`，模型等于没被告知失败原因（"她变笨"的直接诱因之一）。

**根因**：`${error?.message ?? error}` 遇到没有 `message` 的普通对象。

**处置**：统一走 `describeError()`（`src/error-text.js`）把任意形状错误值转成一句话。

## P-015 profile 名写死 web

**症状**：`npm run verify:adaptation` 在桌面版机器上 `ENOENT: ~/.dsh/profiles/web/cordis.patch.yml`，整脚本崩。

**根因**：DSH 官方 web 包的 profile 叫 `web`，桌面版叫 `desktop`。脚本写死 `web`，且 MCP 数量断言写死「恰好 3 个」
（桌面版还挂了 `mcp-bili`）。

**处置**：`DSH_PROFILE` 可覆盖，未设置时自动探测（有 `cordis.patch.yml` 的 profile 目录，优先 desktop/web）；
MCP 断言改成「三个必需的都在、且无重复」。

## P-016 loadConfig 白名单吞掉整块配置

**症状**：给 config.json 加了 `"memoryBrain": { "enabled": false }`，重启后日志照样「已开启」、
`/api/memory-brain/*` 也照样有数据 —— 写 `false` 跟没写一样。测试里传的 config 直接进 `cfg`，全绿。

**根因**：`src/bridge.js` 的 `loadConfig()` 不是「读文件 → 深合并默认值」，而是**白名单式逐键组装**：
只有显式写进那个对象字面量的键才会出现在 `cfg` 里。新能力把默认值放在自己的模块
（`DEFAULT_MEMORY_BRAIN_CONFIG`）时，很容易忘了在 `loadConfig()` 里补一行 `memoryBrain: file.memoryBrain ?? {}`，
于是 `cfg.memoryBrain` 永远是 `undefined` → `normalize({})` → 默认 `enabled:true`（用户想关都关不掉）。
而单测/harness 常常自己传 config，绕过了 loadConfig，所以「测试绿、真机没生效」。

**处置**：`loadConfig()` 里补 `memoryBrain: file.memoryBrain ?? {}`（见 src/bridge.js:1093）；
默认值仍只放在模块里，叠加与夹取交给 `normalizeMemoryBrainConfig`。

**预防**：新增一块配置时，**必须同时在 loadConfig 里显式带过去**，并写一条「读真实 config 文件」的断言；
只测「函数收到 config」不算数。

## P-017 子进程「像 node」但环境被 SDK 过滤干净

**症状**：`test-qq-model-view` / `test-tool-hot-toggle` 在本机稳定失败 `MCP error -32000: Connection closed`，
在别人机器（PATH 里有真 node）却全绿。

**根因**：测试用 `process.execPath` 起子进程 —— 这台机器上它就是
`D:\dsh\DeepSeek Harness.exe`，靠环境变量 `ELECTRON_RUN_AS_NODE=1` 才当 node 用。
而 MCP SDK 的 `StdioClientTransport` 只继承白名单变量（PATH/TEMP/USERPROFILE…），
**把 ELECTRON_RUN_AS_NODE 丢了** → 子进程按 GUI 启动、立刻退出 → 连接关闭。

**处置**：给 transport 显式传 `env: { ...process.env }`（scripts/test-qq-model-view.mjs、
scripts/test-tool-hot-toggle.mjs 的 fixture server 各一处）。

## P-018 node_modules 里的包是空目录（pnpm 装了壳没装肉）

**症状**：`test-qq-mode-plugin` 报 `ERR_MODULE_NOT_FOUND … @deepseek-ai/schemastery/index.js`，
`node_modules/@deepseek-ai/schemastery` 只有符号链接、目标目录是空的；`cosmokit` 同样。
线上无感 —— DSH 自带一份 schemastery，插件跑在 DSH 里，跟本仓库的 node_modules 无关。

**根因**：pnpm 的 store 里只落了目录结构与链接，实体文件没落盘（离线/供应链策略下 `pnpm install` 也修不动：
`ERR_PNPM_NO_OFFLINE_META`、linkBins 的 fs 报错）。

**处置**：从 registry 下载 tarball 解到包目录（`--strip-components=1`）：
`schemastery-3.18.4.tgz` → `node_modules/.pnpm/@deepseek-ai+schemastery@3.18.4/node_modules/@deepseek-ai/schemastery`；
`cosmokit-1.8.5.tgz` → `node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.5/node_modules/@deepseek-ai/cosmokit`。
装完 `npm run test:qq-mode-plugin` 6/6。

**预防**：这种失败看着像代码问题（插件/配置），其实先 `ls` 一下包目录；
「昨天还绿、今天红了」的依赖类失败，先怀疑包目录被清空。

