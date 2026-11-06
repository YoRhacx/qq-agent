// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as sendImageLib from '../src/send-image-lib.js';
import * as tts from '../src/tts.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as reminders from '../src/reminders.js';
import * as historyArchive from '../src/history-archive.mjs';
import * as selfStatus from '../src/self-status.mjs';
import * as musicCard from '../src/music-card.js';
import * as groupAdmin from '../src/group-admin.js';
import * as mcpToolRegistry from '../src/mcp-tool-registry.js';
import * as textFile from '../src/text-file.js';
import * as richCard from '../src/rich-card.js';
import * as gifLite from '../src/gif-lite.js';
import * as dshClient from '../src/dsh-client.js';
import * as dshDiscovery from '../src/dsh-discovery.js';
import * as errorTextModule from '../src/error-text.js';
import * as identityGuard from '../src/identity-guard.js';
import * as memoryCard from '../src/memory-card.js';
import * as memoryBrain from '../src/memory-brain.js';
import * as conversationClosure from '../src/conversation-closure.js';
import * as purposeEngine from '../src/purpose-engine.js';
import * as tokenBudget from '../src/token-budget.js';
import * as roleCard from '../src/role-card.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as snowlumaConn from '../src/snowluma-conn.js';
// 人物七层（2026-10-28 第六轮）：bridge.js 顶层 import 了这七个模块并直接调用它们的导出，
// 所以 vm 里也必须注入 —— 少一个绑定的形态还是那个老样子：纯函数测试全绿，真 bridge.js
// 一加载就 ReferenceError（P-001）。加新模块时跟这份清单同步。
import * as personaState from '../src/persona-state.js';
import * as memoryProfile from '../src/memory-profile.js';
import * as memoryReflection from '../src/memory-reflection.js';
import * as memoryProcedural from '../src/memory-procedural.js';
import * as styleGuard from '../src/style-guard.js';
import * as selfStyle from '../src/self-style.js';
import * as lifeLoop from '../src/life-loop.js';

const { unwrap, createTurnCollector } = dshClient;

const root = fileURLToPath(new URL('..', import.meta.url));
// tempDir：复用同一个临时目录 = 模拟"桥接重启"（窗口落盘 state/slang-window.json 之后
// 下一个进程能不能读回来，见 scripts/test-slang-frequency.mjs）。不传则每次新建、close 时删掉。
export async function bridgeHarness({ config = {}, savedState, globals = {}, tempDir = null } = {}) {
  const temp = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  const ownsTemp = !tempDir;
  fs.mkdirSync(path.join(temp, 'src'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'state'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], http: [], ptt: [], pttMode: 'ok' };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    if (action === 'fetch_ptt_text') {
      // calls.pttMode 由用例切换：ok（默认，回 fixture 文本）、empty（QQ 还没生成）、error9（QQ 侧拒绝转写）。
      // 收语音的规矩（实测）是「同一个 message_id 只能有一个 waiter、单次必须 >20s」，
      // 所以这里必须能复现失败路径，否则测不出「连环重试把 waiter 顶掉」这个 bug。
      calls.ptt.push({ messageId: body?.message_id ?? null, mode: calls.pttMode });
      if (calls.pttMode === 'error9') {
        return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 200, message: 'ptt translate failed: error=9' }) };
      }
      if (calls.pttMode === 'empty') {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: '' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendToQQResult, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    // DSH 端点自愈（m00138 根治）：导出内部件，让 scripts/test-dsh-endpoint-switch.mjs
    // 能直接喂一个"发现到新端口"的桩、断言 api.baseUrl 真的切换、节流与总闸真的生效。
    ensureDshEndpoint, dshEndpoint,
    // bot 本身也导出来：测试要能把某次发送**定向弄失败**（例如把 sendGroupMessage 换成抛错的桩），
    // 才能验证「发送失败 = 提醒不 markFired、下个 tick 还留着」这类失败路径。
    bot,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    // 唤醒延迟（窗口 + 拟人化抖动）是纯函数，导出给 scripts/test-wake-jitter.mjs 做确定性自检。
    wakeDelayMsV2, scheduleWakeV2,
    // 接话冷却（socialV2.reply.minGapMs / minGapDirectedMs）：纯函数 + scheduleWakeV2 的接线方式，
    // 见 scripts/test-reply-gap.mjs。
    replyGapWaitMsV2, isDirectedWakeReasonV2, wakePriorityV2,
    // 积压兜底（方案 B，主人 m07680）：「不是每条都回，但不能一条不回」「攒了几条没回的信息
    // 挑最近的那一条回就好」。纯函数 backlogUnansweredV2 + 触发分支 evaluateWakeTriggerV2
    // 导出给 scripts/test-backlog-wake.mjs（要能直接喂未读缓冲、断言返回的 reason）。
    backlogUnansweredV2, evaluateWakeTriggerV2, softWakeGateV2,
    // 引用 / @ 引导（主人 m10890）：「主动引用别人的消息回复」「自主选择最有意思最有梗的那条
    // 引用回复」「两个人都在和自己聊天时引用回复具体信息」。纯函数按未读人数/条数决定注入哪段，
    // 导出给 scripts/test-quote-guide.mjs 直接断言文本与「只在群聊」这条边界。
    quoteGuideV2,
    // 读文件 / 读动图 / 点开卡片（主人 m09102）：segmentsToText 与 extractMediaFromSegments
    // 是"消息怎么变成文字 + 怎么留下定位信息"的唯一入口，file/card 段必须在这里就保住，
    // 否则后面的 qq_read_file / qq_open_card 再怎么写也没东西可读。见 scripts/test-media-inbound.mjs。
    segmentsToText, extractMediaFromSegments,
    // 提示词里给模型指路的那一段（「本条消息包含 N 个图片/表情…请调用 qq_get_message_images」）。
    // 导出是因为它最容易"数错对象"：media 里现在还有 file/card，把一张分享卡算成图片会让模型
    // 去调图片工具扑空。见 scripts/test-media-inbound.mjs 的「指路提示」段。
    mediaHintFor, findMessageMedia,
    flushQueue, retireSession,
    // 提醒 / 历史归档：测试要能直接驱动 60s ticker 里的检查函数（harness 把 setInterval 桩掉了，
    // 定时器不会自己跑），并检查跳过原因与 store 状态。
    checkDueRemindersV2, remindersStore, historyArchive, maybePruneHistoryV2, wakeSkipReasonV2,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk, prepareVoiceForV2,
    requestPttTextOnce, fetchPttTextForMessage, enrichVoiceTranscriptV2,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
    // 黑话学习窗口：窗口原本只在内存里、每次重启清零，导致群安静时永远攒不到
    // extractMinMessages（详见 src/bridge.js 里 slangWindows 附近的注释）。
    // 导出这几个内部件，让 scripts/test-slang-frequency.mjs 能验证"落盘 → 重启 → 读回来"。
    feedSlangWindow, dropSlangWindowMessages, maybeQueueSlangExtraction,
    saveSlangWindowsNow, saveSlangWindowsSoon, restoreSlangWindows, slangGroupHitCount,
    slangWindows, SLANG_WINDOW_FILE,
    // 记忆大脑（sqlite 句柄）：**必须能在测试收尾时关掉**。
    // Windows 上 sqlite 打开的文件删不掉，不关的话 close() 里 rmSync 临时目录会 EPERM，
    // 一跑全量审计就有一堆 "Permission denied" —— 和记忆内容本身无关的假失败。
    closeMemoryBrain() { try { memoryBrain?.close?.(); } catch { /* 已经关了 */ } memoryBrain = null; },
    // 人物七层同理：flush 掉各层待写的 state 再删临时目录（Windows 上句柄没放会 EPERM）。
    shutdownPersonaLayers() { try { closePersonaLayers(); } catch { /* 已经关了 */ } },
    // 启动路径在 main() 的后半段（harness 把 return 注入在前面就返回了），所以真实进程里
    // startMemoryBrainMaintenance() 在 vm 里**不会**被跑到。想验 HTTP 端点的用例显式调它。
    startMemoryBrainMaintenance,
    // 人物七层同理：实例在 startPersonaLayers() 里建（真实进程 main() 后半段），vm 不会跑到。
    // 想验 /api/emotion、/api/style 这类端点的用例显式调它；收尾仍走 shutdownPersonaLayers()。
    startPersonaLayers,
    // 入站三层的唯一入口（情绪 → 语感 → 12 条窗口），导出给用例直接喂消息，
    // 免得为了「一句群消息」去编一整个 OneBot 事件。
    observeLayersInbound,
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    // 真 NodeApiClient 的构造函数会把 baseUrl 挂在实例上（bridge.js 的 dshEndpoint 与 /api/status
    // 都直接读 api.baseUrl）。桩只返回 api 对象、不设 baseUrl 的话，那边读到的就是 undefined ——
    // 「端点自愈」的断言会全部失真（scripts/test-dsh-endpoint-switch.mjs）。
    NodeApiClient: class { constructor(baseUrl) { if (baseUrl !== undefined) api.baseUrl = baseUrl; return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // DSH 端点自动发现（m00138 根治）：bridge.js 的 ensureDshEndpoint 会调 discoverDshEndpoint。
    // 这里**故意桩成不发现**：真跑会探活宿主 localhost、必要时还 netstat 起子进程，
    // 审计不该碰宿主机网络/进程表。发现逻辑本身由 scripts/test-dsh-discovery.mjs 专职覆盖。
    // dsh-discovery 的纯函数也一并给上：端点相关的审计用例可能直接调 normalize/port 这类工具。
    // 人物七层（情绪/画像/反思/技能/语感/自我语感/生活）：bridge.js 的 startPersonaLayers、
    // observeLayersInbound、personaLayerBlock、cleanOutgoingText 都直接调这些导出。
    // ⚠️ 这七个 spread 放在**最前面**：让后面的既有模块覆盖同名导出。
    //     src/persona-state.js 与 src/memory-brain.js 都导出 bigrams（实现不同），后展开者赢；
    //     bridge.js 自己不用 bigrams，但把这个坑留在原地迟早有人踩。
    ...personaState,
    ...memoryProfile,
    ...memoryReflection,
    ...memoryProcedural,
    ...styleGuard,
    ...selfStyle,
    ...lifeLoop,
    // 注意顺序：桩必须放在 spread **之后**，否则真的 discoverDshEndpoint 会把桩覆盖回去。
    ...dshDiscovery,
    // 错误可读化（2026-10-23）：bridge.js 里所有错误日志/回包都走 errorText。
    // 漏注入的形态同样是隐蔽的 —— 只有真正走到「出错」分支的用例才会 ReferenceError。
    ...errorTextModule,
    // 身份泄漏守卫（2026-10-28 第一轮）：bridge.js 在六个发送端点调 identityGuardBlockReason，
    // 内部用 checkOutboundIdentity。漏注入的形态和上面几次一模一样 —— 纯函数测试全绿，
    // 只有走真实 bridge.js 的发送端点 500 `checkOutboundIdentity is not defined`
    // （test-music-card-http.mjs 就是这么炸的）。守卫自己的用例在 test-identity-guard.mjs。
    ...identityGuard,
    // 长期记忆卡（2026-10-28 第二轮）：bridge.js 启动时 loadMemoryCardState/maintainMemoryCardNow，
    // 入站消息走 rememberInboundForMemory → addMemoryRecord。漏注入的形态是 /api/memory-card 全 500。
    ...memoryCard,
    // 记忆大脑（2026-10-28 第五轮）：bridge.js 启动时 startMemoryBrainMaintenance → openMemoryBrain，
    // 入站消息走 rememberInboundForBrain → ingestInbound，唤醒提示词用 buildMemoryBlock。
    // 漏注入的形态和上面一样：纯函数测试全绿，走真 bridge.js 的用例启动即 ReferenceError。
    ...memoryBrain,
    // 对话收束（2026-10-28 第三轮）：buildWakePromptV2 用 analyzeClosure 算建议，
    // /api/socialV2/closure 也用它。漏注入的形态是唤醒提示词 500 / 该端点 500。
    ...conversationClosure,
    // 目的引擎（2026-10-28 第四轮）：buildWakePromptV2 / scheduleProactiveCheckV2 / /api/purpose
    // 都要用 selectPurpose 等；漏注入的形态是唤醒提示词 500、主动检查 ReferenceError、端点 500。
    ...purposeEngine,
    ...tokenBudget,
    ...roleCard,
    ...presetPrompt,
    ...snowlumaConn,
    discoverDshEndpoint: async () => null,
    // 只有真的发现到端点后才会用到这两个绑定（给候选带上会话 Cookie）；桩成空串即可。
    mintBrowserSessionCookie: dshClient.mintBrowserSessionCookie,
    readBrowserSessionSecret: dshClient.readBrowserSessionSecret,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...sendImageLib, ...tts, ...stateAcl,
    // 到点提醒 / 历史归档同样是「bridge.js 里 import 进来的模块」，vm 沙箱只认这些显式注入的
    // 绑定（bridge.js 顶层的 import 行会被剥掉）。漏一个就是 `X is not defined`。
    ...reminders, ...historyArchive,
    // 自省 / 音乐卡片 / 群管理同样是「bridge.js 里 import 进来的模块」，vm 沙箱只认显式注入的
    // 绑定。漏一个的报错形态很隐蔽：纯函数层的测试照常全绿（它们直接 import 模块），
    // 只有走真实 bridge.js 的端点会 500 `buildSelfStatus is not defined`。
    ...selfStatus, ...musicCard, ...groupAdmin,
    // 「工具开关 ↔ MCP 实际注册」对账。同一类坑的第三次复现：漏注入的报错是
    // 端点 500 `pickLiveSnapshot is not defined`，而纯函数层测试照样全绿。
    ...mcpToolRegistry,
    // 读文件 / 点开卡片 / 读动图（主人 m09102）用到的三个纯模块。同一类坑的第 N 次复现：
    // bridge.js 顶层 import 被剥掉，vm 里只有显式注入的绑定 —— 漏了就是端点 500
    // `parseCardSegment is not defined`，而直接 import 模块的纯函数测试照常全绿。
    // text-file 的 formatBytes 在 bridge.js 里被 `as formatTextBytes`（避免与 send-voice-lib
    // 的同名导出打架），所以这里**必须显式给 formatTextBytes**：整包 spread 只会注入一个
    // 叫 formatBytes 的绑定，bridge.js 找的却是 formatTextBytes。
    ...richCard, ...gifLite,
    extractTextFromFile: textFile.extractTextFromFile,
    fileExtension: textFile.fileExtension,
    isTextFileName: textFile.isTextFileName,
    looksLikeTextBuffer: textFile.looksLikeTextBuffer,
    decodeTextBuffer: textFile.decodeTextBuffer,
    formatTextBytes: textFile.formatBytes,
    TEXT_FILE_MAX_BYTES: textFile.DEFAULT_MAX_BYTES,
    TEXT_FILE_MAX_CHARS: textFile.DEFAULT_MAX_CHARS,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    // edge TTS 要真连微软的朗读服务；测试环境不该联网，且这里的断言关心的是
    // 「桥接把哪段文字、哪个音色交给 TTS」，不是音频内容本身。
    // 桩成「按文本哈希写一个 fixture mp3」，调用方可用 globals.synthesizeSpeech 覆盖来断言真实参数。
    synthesizeSpeech: async (input, options = {}) => {
      const outDir = path.resolve(String(options.outDir ?? path.join(temp, 'audio', 'tts')));
      fs.mkdirSync(outDir, { recursive: true });
      // 用真实的清洗/截断逻辑，桩只替换「联网合成」这一步（否则测试观察不到截断行为）。
      const { text, truncated, originalLength } = tts.normalizeSpeechText(input, options.maxChars);
      if (!text) throw new Error('没有可合成的文字（清洗后是空的）');
      const file = path.join(outDir, `fixture-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}.mp3`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.alloc(4096, 1));
      return {
        path: file,
        bytes: 4096,
        text,
        voice: String(options.voice ?? 'zh-CN-XiaoyiNeural'),
        rate: String(options.rate ?? '+0%'),
        cached: false,
        truncated,
        originalLength,
        ms: 1
      };
    },
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    // 先 flush 人物七层的 state，再关 sqlite（记忆大脑），否则 Windows 上临时目录删不掉。
    try { bridge.shutdownPersonaLayers?.(); } catch { /* ignore */ }
    try { bridge.closeMemoryBrain?.(); } catch { /* ignore */ }
    if (ownsTemp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 文件被占用时留给人清理，别让测试假红 */ } }
  } };
}
