// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, isCjkLikeChar, parseRoleSections, rewriteExampleSpaces, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken, mintBrowserSessionCookie, readBrowserSessionSecret } from './dsh-client.js';
import { discoverDshEndpoint } from './dsh-discovery.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { checkOutboundIdentity } from './identity-guard.js';
import { addMemoryRecord, createEmptyCard, maintainMemoryCard, memoryCardStatus, normalizeCard, normalizeMemoryCardConfig, renderMemoryCard } from './memory-card.js';
// 对话收束：只算「该不该停」，不替模型决定（判成 close 也只是提示词里一行建议）
import { analyzeClosure, buildClosureLine, describeClosure, normalizeClosureConfig } from './conversation-closure.js';
// 目的引擎：主动开口前先有件"惦记的事"，并用硬闸门挡住插嘴时段（纯函数，见 src/purpose-engine.js）
import { buildPurposeCandidates, buildPurposeLine, describePurpose, markPurposeFired, normalizePurposeConfig, normalizePurposeState, selectPurpose } from './purpose-engine.js';
// 每日额度：双单位（金额 + token），80% 提醒、100% 停止主动开口（纯函数，见 src/token-budget.js）
import { buildBudgetLine, dayKeyOf, describeBudget, evaluateBudget, localDayStart, normalizeBudgetConfig, shouldAlert, sumSeriesSince } from './token-budget.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage } from './qq-model-view.js';
import { safeFetchBuffer, safeFetchBytes, looksLikeImageBuffer } from './safe-fetch.js';
import { DEFAULT_MAX_BYTES as TEXT_FILE_MAX_BYTES, DEFAULT_MAX_CHARS as TEXT_FILE_MAX_CHARS, extractTextFromFile, fileExtension, formatBytes as formatTextBytes, isTextFileName } from './text-file.js';
import { bilibiliIdFromCard, describeCard, isMusicCard, neteaseSongIdFromCard, parseCardSegment } from './rich-card.js';
import { extractGifFrames, isAnimatedBuffer, isGifBuffer } from './gif-lite.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { DEFAULT_MAX_SEND_BYTES, describeImage, fetchImageBytes, mediaCfg, readLocalImage, resolveImagePathForOperator, resolveImagePathInV2Library, sendImageToolEnabled } from './send-image-lib.js';
import {
  TTS_DEFAULT_VOICE,
  TTS_LIMITS,
  TTS_LOCAL_DEFAULT_URL,
  TTS_LOCAL_VOICES,
  TTS_RVC_VOICES,
  TTS_VOICES,
  fetchLocalTtsVoices,
  resolveTtsVoice,
  synthesizeSpeech,
  ttsCacheStats,
  ttsVoiceProvider
} from './tts.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { normalizeUsage, resolvePriceTable } from './model-prices.js';
import { createTokenLedger, usageOfEvent } from './token-ledger.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  topRepeatedTerms,
  countTermOccurrences,
  selectExtractionItems,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
import { REMINDER_LIMITS, REMINDER_REPEATS, createRemindersStore, formatLocalTime, isValidSessionKey } from './reminders.js';
import { SELF_STATUS_MAX_CHARS, buildSelfStatus, humanDelta } from './self-status.mjs';
import { MUSIC_MAX_ID_CHARS, MUSIC_MAX_TITLE_CHARS, MUSIC_MAX_TYPE_CHARS, MUSIC_PLATFORMS, buildMusicSegment, describeMusicSegment } from './music-card.js';
import { GROUP_ADMIN_ACTIONS, GROUP_ADMIN_RISK, GROUP_REQUEST_SUBTYPES, MAX_BAN_SECONDS, buildGroupAdminAction, requiresOwnerApproval, riskHint } from './group-admin.js';
import { HISTORY_LIMITS, createHistoryArchive } from './history-archive.mjs';
import { describeToolRegistry, pickLiveSnapshot, reconcileToolRegistry } from './mcp-tool-registry.js';
import { errorText } from './error-text.js';
import { openMemoryBrain, normalizeMemoryBrainConfig, buildMemoryBlock, stripMemoryBlocks } from './memory-brain.js';
// 人物七层（情绪/画像/反思/技能/语感/自我语感/生活）：七个纯函数模块，各自只写自己的 state/*.json。
// ⚠️ 审计夹具（scripts/audit-bridge-harness.mjs）会剥掉这些顶层 import 并在 vm 里注入同名导出：
// 少注入一个绑定 = 单测全绿而桥接真机起不来（P-001）。改这里必须同步改 harness。
import { createPersonaState, normalizePersonaStateConfig, stripPersonaBlocks } from './persona-state.js';
import { createProfileBuilder, collectInputsFromMemoryBrain, normalizeProfileConfig } from './memory-profile.js';
import { createReflectionWriter, normalizeReflectionConfig } from './memory-reflection.js';
import { createProceduralStore, normalizeProceduralConfig } from './memory-procedural.js';
import { createStyleGuard, normalizeStyleConfig, stripStyleBlock } from './style-guard.js';
import { createSelfStyle, normalizeSelfStyleConfig, stripSelfStyleBlock } from './self-style.js';
import { createLifeLoop, normalizeLifeConfig } from './life-loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');

// ── 人物七层（情绪 / 画像 / 反思 / 技能 / 语感 / 自我语感 / 生活） ─────────────────
// 七个纯函数模块各自只写自己的 state/*.json，不碰记忆库的写操作。这一层只做三件事：
// 建实例、把入站消息喂进去、把各自渲染出来的那一段拼进提示词。
// 任何一层出错都只影响它自己（layerWarnOnce 去重，一次运行每类错误只提示一次），
// 绝不阻塞消息收发 —— 七层是锦上添花，不是消息通路上的必经关卡。
let personaState = null;
let profileBuilder = null;
let reflectionWriter = null;
let proceduralStore = null;
let styleGuard = null;
let selfStyle = null;
let lifeLoop = null;
let personaStateConfig = normalizePersonaStateConfig({});
let profileConfig = normalizeProfileConfig({});
let reflectionConfig = normalizeReflectionConfig({});
let proceduralConfig = normalizeProceduralConfig({});
let styleGuardConfig = normalizeStyleConfig({});
let selfStyleConfig = normalizeSelfStyleConfig({});
let lifeLoopConfig = normalizeLifeConfig({});
let personaTickTimer = null;
let layerMaintainTimer = null;
const PERSONA_TICK_MS = 5 * 60 * 1000;
const LAYER_MAINTAIN_CHECK_MS = 60 * 60 * 1000;
const LAYER_DAILY_HOUR = 4;
const LAYER_DAILY_MINUTE = 10;
const LAYER_MAINTAIN_GAP_MS = 20 * 60 * 60 * 1000;
const LAYER_WINDOW_EVERY = 12;
const LAYER_PROMPT_MAX_CHARS = 400;
const LAYER_MAINTAIN_FILE = path.join(STATE_DIR, 'layer-maintenance.json');
const layerWarned = new Set();
const layerInboundWindows = new Map();

function layerEnabled(config) {
  return !!config && config.enabled !== false;
}

function isGroupSessionKey(key) {
  return String(key ?? '').startsWith('group:');
}

function layerStatePath(value, fallback) {
  const raw = String(value ?? '').trim() || String(fallback ?? '');
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

/** 同一类失败只提示一次：七层都在消息热路径上，刷屏比失败本身更糟。 */
function layerWarnOnce(tag, error) {
  if (layerWarned.has(tag)) return;
  layerWarned.add(tag);
  log(`[${tag}] ${String(errorText(error))}（同类错误本次运行只提示这一次）`);
}

/** 建实例 + 打启动日志。各层独立判 enabled：只开一层也能跑；全关只留一行汇总。 */
function startPersonaLayers() {
  if (layerEnabled(personaStateConfig)) {
    try {
      personaState = createPersonaState({
        stateFile: layerStatePath(personaStateConfig.stateFile, 'state/persona-state.json'),
        config: personaStateConfig
      });
      const snap = personaState.snapshot();
      const mood = snap?.state?.mood || '平静';
      const people = Array.isArray(snap?.affinity) ? snap.affinity.length : 0;
      const cores = Array.isArray(snap?.core?.items) ? snap.core.items.length : 0;
      log(`🙂 情绪层已开启：心情 ${mood}（好感 ${people} 人 / 识海 ${cores} 条）`);
    } catch (error) {
      personaState = null;
      layerWarnOnce('persona-start', error);
    }
  }
  if (layerEnabled(profileConfig)) {
    try {
      profileBuilder = createProfileBuilder({
        statePath: layerStatePath(profileConfig.statePath, 'state/memory-profile.json'),
        config: profileConfig
      });
      log(`👤 人物画像：${profileBuilder.list().length} 个`);
    } catch (error) {
      profileBuilder = null;
      layerWarnOnce('profile-start', error);
    }
  }
  if (layerEnabled(reflectionConfig)) {
    try {
      reflectionWriter = createReflectionWriter({
        statePath: layerStatePath(reflectionConfig.statePath, 'state/memory-reflection.json'),
        config: reflectionConfig
      });
      log(`📝 反思：${Number(reflectionWriter.status()?.total) || 0} 天`);
    } catch (error) {
      reflectionWriter = null;
      layerWarnOnce('reflection-start', error);
    }
  }
  if (layerEnabled(proceduralConfig)) {
    try {
      proceduralStore = createProceduralStore({
        statePath: layerStatePath(proceduralConfig.statePath, 'state/memory-procedural.json'),
        config: proceduralConfig
      });
      log(`🛠 技能：${proceduralStore.list().length} 条`);
    } catch (error) {
      proceduralStore = null;
      layerWarnOnce('procedural-start', error);
    }
  }
  if (layerEnabled(styleGuardConfig)) {
    try {
      styleGuard = createStyleGuard({
        // 默认值写仓库相对路径（而不是模块导出的绝对路径）：layerStatePath 会按 ROOT 拼，
        // 审计夹具的临时 ROOT 才不会被解析回真实 state/（测试不许写真实目录）。
        stateFile: layerStatePath(styleGuardConfig.stateFile, 'state/style-guard.json'),
        config: styleGuardConfig
      });
      log(`🗣 语感样本：${Number(styleGuard.snapshot()?.samples) || 0} 条`);
    } catch (error) {
      styleGuard = null;
      layerWarnOnce('style-start', error);
    }
  }
  if (layerEnabled(selfStyleConfig)) {
    try {
      selfStyle = createSelfStyle({
        stateFile: layerStatePath(selfStyleConfig.stateFile, 'state/self-style.json'),
        config: selfStyleConfig
      });
      log(`🪞 自我语感：${Number(selfStyle.snapshot()?.samples) || 0} 条`);
    } catch (error) {
      selfStyle = null;
      layerWarnOnce('self-style-start', error);
    }
  }
  if (layerEnabled(lifeLoopConfig)) {
    try {
      lifeLoop = createLifeLoop({
        stateFile: layerStatePath(lifeLoopConfig.stateFile, 'state/life.json'),
        config: lifeLoopConfig
      });
      log(`🌿 生活笔记：${lifeLoop.allNotes().length} 条`);
    } catch (error) {
      lifeLoop = null;
      layerWarnOnce('life-start', error);
    }
  }
  // 关掉的层合成一行（别七行「已关闭」刷屏，但也别静默——排查「为什么没生效」靠它）。
  const off = [];
  if (!personaState) off.push('personaState');
  if (!profileBuilder) off.push('memoryProfile');
  if (!reflectionWriter) off.push('memoryReflection');
  if (!proceduralStore) off.push('memoryProcedural');
  if (!styleGuard) off.push('styleGuard');
  if (!selfStyle) off.push('selfStyle');
  if (!lifeLoop) off.push('lifeLoop');
  if (off.length) log(`ℹ️ 人物七层未开启：${off.join(' / ')}（config.json 对应块 enabled=false 或创建失败）`);
  // 情绪衰减：启动先 tick 一次（补停机期间的衰减），之后每 5 分钟一次。
  if (personaState) {
    try { personaState.tick(Date.now()); } catch (error) { layerWarnOnce('persona-tick', error); }
    if (personaTickTimer) clearInterval(personaTickTimer);
    personaTickTimer = setInterval(() => {
      try { personaState?.tick(Date.now()); } catch (error) { layerWarnOnce('persona-tick', error); }
    }, PERSONA_TICK_MS);
    personaTickTimer.unref?.();
  }
  startLayerMaintenance();
}

function readLayerMaintainState() {
  try {
    const saved = readJsonSafe(LAYER_MAINTAIN_FILE, {});
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function layerDayKey(at) {
  const d = new Date(Number(at) || Date.now());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 04:10 之后、且今天还没跑过 → 该跑。落库在 state/layer-maintenance.json，重启不重跑。 */
function layerMaintenanceDue(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() * 60 + d.getMinutes() < LAYER_DAILY_HOUR * 60 + LAYER_DAILY_MINUTE) return false;
  const saved = readLayerMaintainState();
  if (String(saved.lastRunDate || '') === layerDayKey(now)) return false;
  const last = Number(saved.lastRunAt) || 0;
  return !last || (now - last) >= LAYER_MAINTAIN_GAP_MS;
}

/** 只读输入：记忆大脑 list() 的最近若干条；没开库/没数据就回空壳，各层自己会判空。 */
function layerMaintenanceInputs() {
  if (!memoryBrain) return { memories: [] };
  try {
    return collectInputsFromMemoryBrain(memoryBrain, { limit: 500 });
  } catch (error) {
    layerWarnOnce('layer-inputs', error);
    return { memories: [] };
  }
}

/** 每日一轮：画像重建 + 今日反思 + 技能抽取。三者互相独立，一个失败不影响其它。 */
function runLayerMaintenance(reason = '每日 04:10', now = Date.now()) {
  const inputs = layerMaintenanceInputs();
  const result = {
    at: now,
    reason,
    memories: Array.isArray(inputs?.memories) ? inputs.memories.length : 0,
    profile: null,
    reflection: null,
    procedural: null
  };
  if (profileBuilder) {
    try { result.profile = profileBuilder.build(inputs); } catch (error) { layerWarnOnce('profile-build', error); }
  }
  if (reflectionWriter) {
    try { result.reflection = reflectionWriter.run(inputs); } catch (error) { layerWarnOnce('reflection-run', error); }
  }
  if (proceduralStore) {
    try { result.procedural = proceduralStore.extract(inputs); } catch (error) { layerWarnOnce('procedural-extract', error); }
  }
  try {
    atomicWriteJson(LAYER_MAINTAIN_FILE, {
      lastRunAt: now,
      lastRunDate: layerDayKey(now),
      lastReason: reason,
      memories: result.memories
    });
  } catch (error) {
    layerWarnOnce('layer-maintain-state', error);
  }
  const written = Number(result.profile?.written) || 0;
  const added = Array.isArray(result.procedural?.added) ? result.procedural.added.length : 0;
  log(`[persona-layers] ${reason}：画像 +${written} / 反思 ${result.reflection?.date || '-'} / 技能 +${added}`);
  return result;
}

function startLayerMaintenance() {
  if (layerMaintenanceDue()) runLayerMaintenance('启动补跑');
  if (layerMaintainTimer) clearInterval(layerMaintainTimer);
  layerMaintainTimer = setInterval(() => {
    try {
      if (layerMaintenanceDue()) runLayerMaintenance('每日 04:10');
    } catch (error) {
      layerWarnOnce('layer-maintain', error);
    }
  }, LAYER_MAINTAIN_CHECK_MS);
  layerMaintainTimer.unref?.();
}

/** 入站：先情绪（要原话 + 说话人），再语感（只学群友，私聊不采），最后才进记忆大脑。 */
function observeLayersInbound({ key, kind, sender, text, userId } = {}) {
  const chatType = kind === 'group' ? 'group' : 'private';
  const body = String(text ?? '');
  const name = String(sender ?? '');
  const at = Date.now();
  if (personaState) {
    try {
      personaState.observeMessage({ userId: String(userId ?? name), name, text: body, chatType, at });
    } catch (error) {
      layerWarnOnce('persona-inbound', error);
    }
  }
  if (styleGuard && chatType === 'group' && body.trim()) {
    try {
      styleGuard.observe({ text: body, from: name, at });
    } catch (error) {
      layerWarnOnce('style-inbound', error);
    }
  }
  noteLayerWindow(key);
}

/** 每 12 条入站消息补一次技能抽取（与记忆大脑的 12 条窗口同频，但不写它的库）。 */
function noteLayerWindow(key) {
  if (!proceduralStore) return;
  const id = String(key ?? '');
  const count = (layerInboundWindows.get(id) || 0) + 1;
  layerInboundWindows.set(id, count);
  if (count % LAYER_WINDOW_EVERY !== 0) return;
  try {
    proceduralStore.extract(layerMaintenanceInputs());
  } catch (error) {
    layerWarnOnce('procedural-window', error);
  }
}

/** 情绪块：群聊是否注入由 personaStateConfig.injectInGroup 决定（模块内部判）。 */
function personaLayerBlock(key) {
  if (!personaState || personaStateConfig.inject === false) return '';
  try {
    const raw = personaState.buildPersonaBlock({ chatType: isGroupSessionKey(key) ? 'group' : 'private', at: Date.now() });
    const text = stripPersonaBlocks(String(raw ?? '')).trim();
    return text ? `${text}\n\n` : '';
  } catch (error) {
    layerWarnOnce('persona-block', error);
    return '';
  }
}

/** 画像块：只取前 2 个（list 已按亲密度/出现次数排序），最多 400 字。 */
function profileLayerBlock() {
  if (!profileBuilder) return '';
  try {
    const list = profileBuilder.list();
    if (!Array.isArray(list) || !list.length) return '';
    const names = list.slice(0, 2).map((item) => String(item?.name || '').trim()).filter(Boolean);
    const text = String(profileBuilder.render({ names, maxChars: LAYER_PROMPT_MAX_CHARS }) || '').trim();
    return text ? `${text}\n\n` : '';
  } catch (error) {
    layerWarnOnce('profile-block', error);
    return '';
  }
}

/** 语感块：styleInGroup=false 或私聊时模块自己会回空串。 */
function styleLayerBlock(key) {
  if (!styleGuard) return '';
  try {
    const raw = styleGuard.buildStyleBlock({ isGroup: isGroupSessionKey(key) });
    const text = stripStyleBlock(String(raw ?? '')).trim();
    return text ? `${text}\n\n` : '';
  } catch (error) {
    layerWarnOnce('style-block', error);
    return '';
  }
}

function selfStyleLayerBlock() {
  if (!selfStyle) return '';
  try {
    const text = stripSelfStyleBlock(String(selfStyle.buildSelfStyleBlock() || '')).trim();
    return text ? `${text}\n\n` : '';
  } catch (error) {
    layerWarnOnce('self-style-block', error);
    return '';
  }
}

/**
 * 出站清洗：模型这句话发往 QQ 之前把客服腔/超长段落/堆叠标点清掉。
 * 只挂在 auditAndSend（模型输出的唯一漏斗），不动系统提示语与固定通知。
 */
function cleanOutgoingText(key, text) {
  if (!styleGuard || !layerEnabled(styleGuardConfig) || styleGuardConfig.cleanOutgoing === false) return text;
  try {
    const result = styleGuard.checkOutgoing(String(text ?? ''));
    const next = String(result?.text ?? '');
    const changes = Array.isArray(result?.changes) ? result.changes : [];
    if (changes.length) {
      const kinds = [...new Set(changes.map((item) => String(item?.type || item?.kind || '?').trim() || '?'))].slice(0, 3).join('/');
      log(`[style-guard] 出站清洗 ${key}：${changes.length} 处（${kinds}）`);
    }
    return next.trim() ? next : text;
  } catch (error) {
    layerWarnOnce('style-clean', error);
    return text;
  }
}

/** 关停：flush 掉各层待写的 state（测试临时目录要能删、真机退出不丢样本）。 */
function closePersonaLayers() {
  if (personaTickTimer) { clearInterval(personaTickTimer); personaTickTimer = null; }
  if (layerMaintainTimer) { clearInterval(layerMaintainTimer); layerMaintainTimer = null; }
  for (const store of [personaState, profileBuilder, reflectionWriter, proceduralStore, styleGuard, selfStyle, lifeLoop]) {
    try { store?.flush?.(); } catch { /* 退出路径不抛 */ }
  }
  personaState = null;
  profileBuilder = null;
  reflectionWriter = null;
  proceduralStore = null;
  styleGuard = null;
  selfStyle = null;
  lifeLoop = null;
  layerInboundWindows.clear();
}
// 黑话学习滚动窗口的持久化文件（见 slangWindows 附近的注释：窗口必须在重启后活下来）。
const SLANG_WINDOW_FILE = path.join(STATE_DIR, 'slang-window.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const REMINDERS_FILE = path.join(STATE_DIR, 'reminders.json');
const HISTORY_DIR = path.join(STATE_DIR, 'history');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
// 定时主动唤醒（作息/节日）的「今天触发过没有」记录；每个 item 每天只发一次，重启不重复。
const SCHEDULE_STATE_FILE = path.join(STATE_DIR, 'schedule-state.json');
let scheduleState = { fired: {} };
function loadScheduleState() {
  const s = readJsonSafe(SCHEDULE_STATE_FILE, { fired: {} });
  scheduleState = s && typeof s === 'object' && s.fired && typeof s.fired === 'object' ? s : { fired: {} };
  return scheduleState;
}
function saveScheduleState() {
  try { atomicWriteJson(SCHEDULE_STATE_FILE, scheduleState); } catch {}
}

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${errorText(error)}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// ── 长期记忆卡（跨会话）──────────────────────────────────────────────
// 和按会话的轻量记忆（socialV2 里的 activeTopics / memberImpressions）不同，
// 这张卡记的是「跨会话、会衰减、每轮注入」的东西：主人说过什么、群里谁有什么梗、
// 答应过什么、闹过什么别扭。引擎在 src/memory-card.js（纯函数），这里只负责读写与接线。
const MEMORY_CARD_FILE = path.join(STATE_DIR, 'memory-card.json');
const MEMORY_INBOX_FILE = path.join(STATE_DIR, 'memory-inbox.jsonl');
const MEMORY_CARD_MAINTAIN_MS = 10 * 60 * 1000;
let memoryCard = createEmptyCard();
let memoryCardConfig = normalizeMemoryCardConfig({});
let closureConfig = normalizeClosureConfig({});
let memoryCardPromptText = '';
let memoryCardMaintainTimer = null;

function loadMemoryCardState() {
  const raw = readJsonSafe(MEMORY_CARD_FILE, null);
  memoryCard = normalizeCard(raw, Date.now());
  refreshMemoryCardPrompt();
  return memoryCard;
}

function saveMemoryCardState() {
  try {
    atomicWriteJson(MEMORY_CARD_FILE, memoryCard);
  } catch (error) {
    log(`[memory-card] 写盘失败：${errorText(error)}`);
  }
}

// ── 目的引擎状态（跨会话）────────────────────────────────────────────
// 存的是"什么时候提过哪个目的"：lastFireAt / dailyDate / dailyCount / tried{id:ts}。
// 候选本身不落盘——它是每次从记忆里现算的，落盘只会让"惦记"变成一份过期的清单。
const PURPOSE_STATE_FILE = path.join(STATE_DIR, 'purpose-engine.json');
let purposeConfig = normalizePurposeConfig({});
let purposeState = normalizePurposeState(null);

function loadPurposeState() {
  purposeState = normalizePurposeState(readJsonSafe(PURPOSE_STATE_FILE, null));
  return purposeState;
}

function savePurposeState() {
  try {
    atomicWriteJson(PURPOSE_STATE_FILE, purposeState);
  } catch (error) {
    log('[purpose] 写盘失败：' + errorText(error));
  }
}

// ── 每日额度状态 ─────────────────────────────────────────────────────
// 只存"今天提醒过没有"：数字本身每次从 token 账本现算，落盘只会变成一份过期账。
const BUDGET_STATE_FILE = path.join(STATE_DIR, 'token-budget.json');
let budgetConfig = normalizeBudgetConfig({});
let budgetAlertDay = '';

function loadBudgetState() {
  const raw = readJsonSafe(BUDGET_STATE_FILE, null);
  budgetAlertDay = raw && typeof raw.alertDay === 'string' ? raw.alertDay : '';
  return budgetAlertDay;
}

function saveBudgetState() {
  try {
    atomicWriteJson(BUDGET_STATE_FILE, { alertDay: budgetAlertDay, day: dayKeyOf(Date.now()), at: Date.now() });
  } catch (error) {
    log('[budget] 写盘失败：' + errorText(error));
  }
}

function refreshMemoryCardPrompt() {
  try {
    memoryCardPromptText = renderMemoryCard(memoryCard, { config: memoryCardConfig, now: Date.now() });
  } catch (error) {
    memoryCardPromptText = '';
    log(`[memory-card] 渲染失败：${errorText(error)}`);
  }
  return memoryCardPromptText;
}

// 入站消息先落 inbox（append-only、一行一个事件），再由维护任务统一打分入库。
// 这样即使维护中途挂掉，消息也不会丢；也避免每条消息都重写整份 card。
function appendMemoryInbox(event) {
  if (!memoryCardConfig.enabled) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(MEMORY_INBOX_FILE, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    log(`[memory-card] 写 inbox 失败：${errorText(error)}`);
  }
}

/** 只记「像人说的话」：命令、纯符号、太短的不记（主人私聊例外，短也记）。 */
function rememberInboundForMemory({ key, kind, id, sender, isOwner, text }) {
  if (!memoryCardConfig.enabled) return;
  const raw = String(text ?? '').trim();
  if (!raw) return;
  if (raw.startsWith('/')) return;
  if (/^\[[^\]]*\]$/.test(raw)) return;
  if (raw.length < memoryCardConfig.minChars && !isOwner) return;
  appendMemoryInbox({
    source: 'qq',
    conversationKey: key,
    kind,
    groupId: kind === 'group' ? String(id) : '',
    speaker: String(sender ?? '').slice(0, 40),
    isOwner: isOwner === true,
    text: raw.slice(0, 600),
    createdAt: Date.now(),
  });
}

function drainMemoryInbox() {
  let text = '';
  try {
    if (!fs.existsSync(MEMORY_INBOX_FILE)) return { consumed: 0, added: 0 };
    text = fs.readFileSync(MEMORY_INBOX_FILE, 'utf8');
  } catch (error) {
    log(`[memory-card] 读 inbox 失败：${errorText(error)}`);
    return { consumed: 0, added: 0 };
  }
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) return { consumed: 0, added: 0 };
  let added = 0;
  let consumed = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      consumed += 1; // 坏行也不能留着把后面堵死
      continue;
    }
    const result = addMemoryRecord(memoryCard, {
      source: event.source ?? 'qq',
      sourceId: event.sourceId ?? '',
      scope: 'qq',
      kind: event.kind === 'private' ? 'private' : 'group',
      text: event.text,
      speaker: event.speaker,
      groupId: event.groupId,
      conversationKey: event.conversationKey,
      isOwner: event.isOwner === true,
      createdAt: Number(event.createdAt) || Date.now(),
    }, memoryCardConfig, Number(event.createdAt) || Date.now());
    if (result.added) added += 1;
    consumed += 1;
  }
  try {
    fs.unlinkSync(MEMORY_INBOX_FILE);
  } catch {}
  return { consumed, added };
}

/**
 * 维护一次：把 inbox 消化掉 → 按天衰减 → 必要时压缩 → 重渲染注入用的那一段。
 * reason 只用于日志（启动 / 定时 / 手动）。
 */
function maintainMemoryCardNow(reason = 'timer') {
  if (!memoryCardConfig.enabled) return { changed: false };
  const drained = drainMemoryInbox();
  const result = maintainMemoryCard(memoryCard, memoryCardConfig, Date.now());
  if (drained.added || result.changed) {
    saveMemoryCardState();
    refreshMemoryCardPrompt();
    if (drained.added) log(`[memory-card] ${reason}：新记 ${drained.added} 条（共 ${memoryCard.records.length} 条）`);
    if (result.decayed) log(`[memory-card] ${reason}：跑了一轮遗忘整理（当前 ${memoryCard.records.length} 条）`);
    if (result.compacted) log(`[memory-card] ${reason}：压缩了 ${result.compacted} 条`);
  }
  return { ...result, added: drained.added };
}

function startMemoryCardMaintenance() {
  loadMemoryCardState();
  maintainMemoryCardNow('启动');
  if (memoryCardMaintainTimer) clearInterval(memoryCardMaintainTimer);
  memoryCardMaintainTimer = setInterval(() => {
    try {
      maintainMemoryCardNow('定时');
    } catch (error) {
      log(`[memory-card] 定时维护失败：${errorText(error)}`);
    }
  }, MEMORY_CARD_MAINTAIN_MS);
  memoryCardMaintainTimer.unref?.();
}

// ── 记忆大脑（src/memory-brain.js）──────────────────────────────────────────
// 长期记忆库：episode / fact / reflection / skill / lesson 五类，检索打分 + 遗忘治理 + 注入块。
// 默认值全在 src/memory-brain.js 的 DEFAULT_MEMORY_BRAIN_CONFIG 里：config.json 没写
// memoryBrain 块时就按默认跑（enabled=true、库在 state/memory-brain.sqlite）。
// 一键回滚：config.memoryBrain.enabled=false —— 数据端点一律回 {ok:false,disabled:true}，
// 提示词里不再出现注入块，库文件原样留在磁盘上（想找回记忆就再把开关打开）。
let memoryBrain = null;
let memoryBrainConfig = normalizeMemoryBrainConfig({});
let memoryBrainTimer = null;
// 治理（衰减/归档/蒸馏）一天一轮；按 24h 定时，重启不重跑，避免一天衰减两次。
const MEMORY_BRAIN_MAINTAIN_MS = 24 * 60 * 60 * 1000;
const MEMORY_BRAIN_MAINTAIN_MIN_GAP_MS = 20 * 60 * 60 * 1000;
// 「聊完就记住」：一个会话攒够这么多条、且已经安静这么久，就把它强制总结成一条 episode，
// 不等 windowSize（默认 12）攒满 —— 否则一场 7 条的群聊永远出不了记忆，星系一直是空的。
const MEMORY_BRAIN_IDLE_SWEEP_MS = 5 * 60 * 1000;
const MEMORY_BRAIN_IDLE_MS = 20 * 60 * 1000;
const MEMORY_BRAIN_IDLE_MIN_PENDING = 5;
// 同一会话 6 小时内的对话算「同一场」：静默总结时并进同一颗星，而不是碎成好几颗。
const MEMORY_BRAIN_MERGE_WITHIN_MS = 6 * 60 * 60 * 1000;
let memoryBrainSweepTimer = null;

function memoryBrainDbPath() {
  const raw = String(memoryBrainConfig.dbPath ?? '').trim() || 'state/memory-brain.sqlite';
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function startMemoryBrain() {
  if (!memoryBrainConfig.enabled) {
    log('🧠 记忆大脑未开启（config.memoryBrain.enabled=false）');
    return;
  }
  try {
    memoryBrain = openMemoryBrain({ dbPath: memoryBrainDbPath(), config: memoryBrainConfig });
    const counts = memoryBrain.count();
    log(`🧠 记忆大脑已开启：${counts.active} 条记忆（fact ${counts.byKind.fact} / episode ${counts.byKind.episode}）`);
    // useLlm=true 时需要外部注入 llm 钩子（memoryBrain.setLlm）；桥接默认不接模型，
    // 没钩子时 summarizeWindowWithLlm 会自己回落启发式 —— 开关打开也绝不偷偷调模型。
  } catch (error) {
    memoryBrain = null;
    log(`⚠️ 记忆大脑开启失败（桥接照常运行，只是没有长期记忆）：${errorText(error)}`);
  }
}

/**
 * 注入块：按这个会话最近几条来信检索，命中 2 条（私聊）/ 1 条（群聊）。
 * 群聊传 visibility='group'，private 记忆不会漏进群里。
 * 库没开、inject 关了、一条都没命中时返回空串（提示词里就不出现这一段）。
 */
function memoryBlockForWake(key, st) {
  if (!memoryBrain) return '';
  try {
    const msgs = (Array.isArray(st?.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf);
    const query = msgs.slice(-3).map((m) => String(m.text || m.plain || '')).join(' ').trim();
    if (!query) return '';
    // 等价于 main() 里的 isGroupKey（模块作用域拿不到那个函数，这里按同一规则判）。
    const group = String(key ?? '').startsWith('group:');
    return buildMemoryBlock(memoryBrain, {
      query,
      chatType: group ? 'group' : 'private',
      visibility: group ? 'group' : 'private'
    });
  } catch (error) {
    log(`[memory-brain] 注入块生成失败：${errorText(error)}`);
    return '';
  }
}

/** 每天一轮治理：衰减 → 归档 → 清理 → 相似合并 → 冲突检测 → 蒸馏 fact/lesson。 */
function maintainMemoryBrainNow(reason = 'timer') {
  if (!memoryBrain) return { changed: 0 };
  const summary = { changed: 0, decayed: 0, archived: 0, purged: 0, merged: 0, conflicts: 0, facts: 0, lessons: 0 };
  try {
    summary.decayed = memoryBrain.decay()?.changed || 0;
    summary.archived = memoryBrain.archive()?.changed || 0;
    summary.purged = memoryBrain.purge()?.changed || 0;
    summary.merged = memoryBrain.mergeSimilar()?.merged || 0;
    summary.conflicts = memoryBrain.detectConflicts()?.found || 0;
    summary.facts = memoryBrain.distillFacts()?.inserted || 0;
    summary.lessons = memoryBrain.distillLessons()?.inserted || 0;
    summary.changed = summary.decayed + summary.archived + summary.purged + summary.merged
      + summary.facts + summary.lessons;
    memoryBrain.metaSet('lastMaintainAt', String(Date.now()));
    if (summary.changed) log(`[memory-brain] ${reason}治理：衰减 ${summary.decayed} / 归档 ${summary.archived} / 清理 ${summary.purged} / 合并 ${summary.merged} / 新 fact ${summary.facts} / 新 lesson ${summary.lessons}`);
  } catch (error) {
    log(`[memory-brain] ${reason}治理失败：${errorText(error)}`);
  }
  return summary;
}

/**
 * 会话静默总结：把「攒了几条但没满窗口、且已经安静 10 分钟」的会话强制出 episode。
 * 这是星系能长星星的主要来源（一场对话 = 一颗星），别把它当可选项关掉。
 */
function consolidateIdleMemoryWindows(reason = 'silent', { minPending = MEMORY_BRAIN_IDLE_MIN_PENDING, idleMs = MEMORY_BRAIN_IDLE_MS } = {}) {
  if (!memoryBrain) return { summarized: 0, sessions: [] };
  const out = { summarized: 0, sessions: [] };
  try {
    const pending = memoryBrain.pendingWindows({ minPending, idleMs });
    for (const item of pending) {
      const episode = memoryBrain.summarizeWindow({
        session: item.session,
        visibility: item.visibility,
        force: true,
        mergeWithinMs: MEMORY_BRAIN_MERGE_WITHIN_MS
      });
      if (episode && episode.episodeId) {
        out.summarized += 1;
        out.sessions.push({ session: item.session, episodeId: episode.episodeId, messages: episode.messageCount, merged: !!episode.merged, total: episode.totalMessages || episode.messageCount });
        log(`[memory-brain] ${reason}总结：${item.session} 的 ${episode.messageCount} 条对话 → episode #${episode.episodeId}${episode.merged ? `（并进同一段，共 ${episode.totalMessages} 条）` : ''}`);
      }
    }
  } catch (error) {
    log(`[memory-brain] ${reason}总结失败：${errorText(error)}`);
  }
  return out;
}

function startMemoryBrainMaintenance() {
  startMemoryBrain();
  if (!memoryBrain) return;
  try {
    // 一次性升级：早期 episode 一律 0.45，现在按条数缩放，把老库对齐一次。
    if (memoryBrain.metaGet('episodeImportance:v2') !== '1') {
      const fixed = memoryBrain.recomputeEpisodeImportance();
      memoryBrain.metaSet('episodeImportance:v2', '1');
      if (fixed.changed) log(`[memory-brain] 旧记忆重要度按条数重算：${fixed.changed} 条`);
    }
  } catch (error) {
    log(`[memory-brain] 旧记忆重要度重算失败（不影响新记忆）：${errorText(error)}`);
  }
  try {
    const last = Number(memoryBrain.metaGet('lastMaintainAt') || 0);
    if (!last || Date.now() - last >= MEMORY_BRAIN_MAINTAIN_MIN_GAP_MS) maintainMemoryBrainNow('启动');
  } catch (error) {
    log(`[memory-brain] 启动治理失败：${errorText(error)}`);
  }
  if (memoryBrainTimer) clearInterval(memoryBrainTimer);
  memoryBrainTimer = setInterval(() => {
    try { maintainMemoryBrainNow('定时'); } catch (error) { log(`[memory-brain] 定时治理失败：${errorText(error)}`); }
  }, MEMORY_BRAIN_MAINTAIN_MS);
  memoryBrainTimer.unref?.();
  if (memoryBrainSweepTimer) clearInterval(memoryBrainSweepTimer);
  memoryBrainSweepTimer = setInterval(() => consolidateIdleMemoryWindows('静默'), MEMORY_BRAIN_IDLE_SWEEP_MS);
  memoryBrainSweepTimer.unref?.();
  // 启动时先扫一遍：重启前聊完的那场对话，应该在重启后立刻变成一颗星。
  setTimeout(() => consolidateIdleMemoryWindows('启动'), 3000).unref?.();
}

/** 入站消息落库（原始消息 + 工作记忆；满一个窗口自动出 episode）。失败绝不影响收消息。 */
function rememberInboundForBrain(key, kind, sender, text) {
  if (!memoryBrain) return;
  try {
    memoryBrain.ingestInbound({
      session: key,
      role: 'user',
      sender: String(sender || ''),
      text: stripMemoryBlocks(String(text || '')),
      visibility: kind === 'group' ? 'group' : 'private'
    });
  } catch (error) {
    log(`[memory-brain] 入站记忆写入失败：${errorText(error)}`);
  }
}

/** 概览（GET /api/memory-brain/overview）：字段名是前端约定死的，别改。 */
function memoryBrainOverviewPayload() {
  const dbPath = memoryBrain?.dbPath ?? memoryBrainDbPath();
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(dbPath).size; } catch {}
  const counts = memoryBrain.count();
  const stats = memoryBrain.stats();
  const byKind = counts.byKind ?? {};
  return {
    ok: true,
    enabled: true,
    db: { path: dbPath, sizeBytes },
    counts: {
      episode: byKind.episode || 0,
      fact: byKind.fact || 0,
      reflection: byKind.reflection || 0,
      skill: byKind.skill || 0,
      lesson: byKind.lesson || 0,
      active: counts.active,
      archived: counts.archived,
      working: stats.working || 0
    },
    caps: { fact: memoryBrainConfig.caps.fact, lesson: memoryBrainConfig.caps.lesson },
    health: memoryBrain.health(),
    stats: { todayWrites: stats.todayWrites, todayEpisodes: stats.todayEpisodes }
  };
}

/** 列表项：只给前端要的字段（meta 里可能有会话 key，不外泄）。 */
function memoryBrainListItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    importance: item.importance,
    valence: item.valence,
    accessCount: item.accessCount,
    status: item.status,
    source: item.source,
    visibility: item.visibility,
    createdAt: item.createdAt,
    lastAccess: item.lastAccess,
    archivedAt: item.archivedAt
  };
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 128 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~25000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(25000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  // 回复示例里的中文空格不再单列警告：二代注入前由 rewriteExampleSpaces 统一改写成逗号
  // （标题式与列表式示例块都认），提示了也没人需要动手。
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'default' 是本桥接的哨兵值：**完全不下发 reasoningEffort 字段**。有些 provider/模型
// 在 DSH 模型目录里没有思考强度维度（实测 trae 的 MiMo/Doubao 全系），传任何档位都会被
// DSH 拒为 `session/model-unavailable: ... does not support reasoning effort "high"`；
// 只有省略该字段才能选中，因此需要这个「不表态」档位。
//
// 除哨兵值外**不做固定白名单**：DSH 各模型公布的档位词汇并不统一 —— DeepSeek 是
// off/low/high/max，buddy 有 medium / xhigh，trae 的 deepseek-v4.1-flash 是
// light/high/extra_high。写死白名单会把「目录里明明支持」的档位在保存时拒掉（真踩过：
// 目录写着 light/high/extra_high，保存却报"只能是 default / off / low / high / max"）。
// 所以这里只做形状校验；合法性交给控制台（对着模型目录校验）与 DSH（selectModel 会明确报错）。
const REASONING_EFFORT_DEFAULT = 'max';
// 仅在读不到 DSH 模型目录时用作兜底候选，**不是白名单**。
const REASONING_EFFORT_OPTIONS = ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'extra_high', 'max'];
const REASONING_EFFORT_SHAPE = /^[a-z][a-z0-9_-]{0,23}$/;
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'default') return v;
  if (!REASONING_EFFORT_SHAPE.test(v)) {
    throw new Error('思考强度只能是 default（不下发该字段）或形如 light / high / max 的档位名');
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      // DSH 桌面版用 --port 0 启动，端口由系统分配、每次重启都变。默认开启自动发现：
      // 连之前先确认当前监听端口（见 dsh-discovery.js），不再依赖钉死的 baseUrl。
      followDiscoveredEndpoint: true,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    // 身份泄漏守卫：她出站的话里不许自曝「我是 AI / 模型 / 程序」，也不许抖提示词。
    // 默认开；mode=warn 只记日志、strict 连擦边球（我没有感情 / 我的人设）也拦。
    identityGuard: { enabled: true, mode: 'block', exemptKeys: [], ...(file.identityGuard ?? {}) },
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      // 待学习滚动窗口的容量（窗口跨重启落盘到 state/slang-window.json）。
      windowMax: 200,
      // 新候选词必须在窗口里出现这么多条消息才算"群聊里真的在用的词"（主人 m01652 的要求）。
      minGroupCount: 2,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    // 记忆大脑（长期记忆）：默认值全在 src/memory-brain.js 的 DEFAULT_MEMORY_BRAIN_CONFIG，
    // 这里把 config.json 里的块**原样**带过去，由 normalizeMemoryBrainConfig 再逐字段夹取。
    // ⚠️ loadConfig 是白名单式组装（只挑显式列出的键），漏了这行 = 用户写了 memoryBrain
    // 也当没写（永远是默认 enabled=true，想关都关不掉）。
    memoryBrain: file.memoryBrain ?? {},
    // 人物七层同属白名单：漏一行 = config.json 里写 enabled:false 也关不掉（P-016）。
    personaState: file.personaState ?? {},
    memoryProfile: file.memoryProfile ?? {},
    memoryReflection: file.memoryReflection ?? {},
    memoryProcedural: file.memoryProcedural ?? {},
    styleGuard: file.styleGuard ?? {},
    selfStyle: file.selfStyle ?? {},
    lifeLoop: file.lifeLoop ?? {},
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true,
        watchVideo: true,
        listenVoice: true,
        // 到点提醒（qq_set_reminder / qq_list_reminders）与历史检索（qq_search_history）默认开：
        // 一个是「你让我几点提醒」的低风险定时回话，一个是只读的片段检索，开关只是留个关掉的口子。
        reminders: true,
        searchHistory: true,
        // +1 复读（qq_repeat_message）：只发文字、只能复读本会话已有的原文，默认开。
        repeatMessage: true,
        sendImage: false
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.12,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。**潜水多久你自己定**：想歇一会儿就 5~30 分钟，想认真去做别的事就 1~3 小时，想消失半天也可以（上限 8 小时）；普通消息概率 0.12（不是每条都回，但也不能一条不回；群聊里自你上次开口后攒够 backlogWakeAfter 条还没接的普通消息，桥接会直接叫醒你一次，不需要你设置）；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2,
        // 软闸门（只挡 anyMessage / 概率 这类"普通消息"唤醒；定向唤醒不吃它）：
        // 刚说过话的冷却 + 每小时的普通消息唤醒额度。控制台「接话频率与冷却」里可改。
        softWakeCooldownMs: 180000,
        softWakePerHour: 6,
        // 积压兜底（主人的要求：「不是每条都回，但不能一条不回」「攒了几条没回的信息挑最近的那一条回」）。
        // 群聊里自她上次开口以来，未读里攒够这么多条**普通消息**（不含她自己的、不含拍一拍）就必定唤醒一次，
        // 不再掷概率骰子（但仍走 softWakeGateV2 的冷却与每小时额度，免得变成话痨）。
        // 0 = 关闭兜底，只靠概率与定向触发。
        backlogWakeAfter: 3
      },
      // 接话冷却：她说完话之后，**被消息叫醒**的唤醒至少隔这么久才发（延迟发送、不丢消息，
      // 消息照常进未读，醒来一起看）。与 wake.softWakeCooldownMs 的区别：软闸门只挡
      // anyMessage/概率这类普通消息，而这里连 @/叫名字/提问/拍一拍也一起延后 —— 主人的要求是
      // 「不要有应就回，@ 了也别马上回，可以装死一小会」。固定时刻的唤醒（提醒 reminder: /
      // 定时 schedule: / 睡眠到期 timeout / 首帧 bootstrap）一律不延后，否则提醒会迟到。
      reply: {
        minGapMs: 30000,          // 普通消息叫醒后的接话冷却（0=关闭，只保留合批窗口抖动）
        minGapDirectedMs: 12000   // 被 @/叫名字/关键词/提问/拍一拍叫醒后的最短间隔（0=只靠抖动）
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  //
  // 表本身在模块级 `SOCIAL_V2_TOOL_DEFAULTS`（见其上方注释：保存端点也必须引同一份表，
  // 否则"配置文件里没有的新开关"会被归一化成 true）。这里只做「出厂默认 ← 用户配置」两层叠加。
  cfg.socialV2.tools = { ...SOCIAL_V2_TOOL_DEFAULTS, ...(cfg.socialV2.tools ?? {}) };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    // ── 「听」：收到的语音用 QQ 自带的语音转写（网关 fetch_ptt_text）变成文字 ──────────
    // QQ 客户端会把收到的语音转成文字，SnowLuma 把它暴露成 fetch_ptt_text；桥接在收到语音
    // 消息时把它取回来，替换掉 [语音] 占位符，AI 就能「听懂」而不是只看到一条占位。
    // hear=false 时退回老行为（只有 [语音]）。转写是异步生成的，首次可能为空，会重试。
    // 注意：SnowLuma 侧一次 fetch_ptt_text 自己会挂 20s 等 QQ 推送，而且同一 message_id
    // 只允许一个 waiter（新请求会把上一个顶掉）——所以单次超时必须 >20s，重试也不能太密。
    hear: true,
    hearAttempts: 2,
    hearRetryMs: 4000,
    hearTimeoutMs: 25000,
    // ── 「说」：文字转语音（edge + 本机 HoYo TTS 两条 provider）──────────────────
    // 语音库里只有预先准备好的固定音频，AI 说不了「任意一句话」。开了这段之后，
    // qq_send_voice 可以直接传 text：桥接现场合成音频，落在语音库的 tts/ 子目录，
    // 再走同一条语音发送链路（不需要 API key、不花钱；同一句话按内容哈希缓存）。
    //   voice 形如 zh-CN-XiaoyiNeural → edge（微软 Read Aloud，一次 ~0.3s）；
    //   voice 形如 local:hoyo:129    → 本机 HoYo TTS 服务（原神/星铁角色音色，CPU 一次 ~5s）。
    ...(cfg.socialV2?.voice ?? {}),
    // tts 必须放在展开之后并单独深合并：否则 config.json 里写了 tts（哪怕只写了一个键）
    // 就会把 default 里 local.url/local.params 整段顶掉，ttsCfg() 再兜底也只能兜到默认地址。
    tts: {
      enabled: true,
      voice: TTS_DEFAULT_VOICE,
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
      maxChars: TTS_LIMITS.maxChars,
      timeoutMs: TTS_LIMITS.timeoutMs,
      ...(cfg.socialV2?.voice?.tts ?? {}),
      local: {
        url: TTS_LOCAL_DEFAULT_URL,
        params: {},
        ...(cfg.socialV2?.voice?.tts?.local ?? {})
      }
    }
  };

  // socialV2.media：图片发送（把一张本地图片或公网图片当 QQ 图片消息发出去）。
  //
  // 与 socialV2.voice 的三点对应关系，读代码时别混淆：
  //   - `media.enabled`  = 「AI 能不能发图」总闸（如语音的 voice.enabled）；操作者通道
  //                        （控制台 /api/media/send-image）**不受它限制**，否则你连试发都做不了。
  //   - `tools.sendImage` = 工具级开关，控制台可逐项勾选（MCP 也会据此在注册期隐藏工具）。
  //   - `dir`            = 图片库目录，AI 通道只能从这里取文件（相对仓库根目录）。
  //
  // 出厂默认：enabled=true 但 tools.sendImage=false —— 即"能力在、AI 不给用"，
  // 想开只需在控制台勾一下，不必改文件。理由见 tools 默认表里的注释。
  cfg.socialV2.media = {
    enabled: true,
    dir: 'media/images',
    // 单张图片字节上限（URL 来源以 base64:// 内联，实际请求体约为它的 1.34 倍）
    maxSendBytes: DEFAULT_MAX_SEND_BYTES,
    // 频率口径复用语音：独立时间戳桶 + 每分钟/每小时上限，只检查、真正发出后才记账
    maxPerMinute: 2,
    maxPerHour: 10,
    ...(cfg.socialV2?.media ?? {})
  };

  // socialV2.status：自省（qq_bridge_status / GET /api/socialV2/self-status）。
  //
  // 与 tools.status 的分工：tools.status 管「AI 能不能调」，status 块管「这段摘要里
  // 允许出现哪些东西」。目前只有一个开关 includeCost —— 花费要读 token 账本、
  // 有实际成本与失败面，所以允许操作者单独关掉它（关掉后【花费】整段消失）。
  cfg.socialV2.status = {
    includeCost: true,
    ...(cfg.socialV2?.status ?? {})
  };

  // socialV2.music：音乐卡片（qq_send_music / POST /api/socialV2/send-music）。
  //
  // 出厂默认 enabled=true 但 tools.sendMusic=false —— 与图片同口径（能力在、AI 不给用）。
  // 原因见 tools 默认表里的注释：平台卡要经 SnowLuma 的 musicSignUrl 第三方签名。
  // allowThirdPartySign=false 时，平台卡会被 src/music-card.js 直接拒掉，
  // 只留 type:'custom'（自带 url/audio/title，不经第三方）。
  cfg.socialV2.music = {
    enabled: true,
    allowThirdPartySign: true,
    maxPerMinute: 2,
    maxPerHour: 10,
    ...(cfg.socialV2?.music ?? {})
  };

  // socialV2.groupAdmin：群管理（qq_group_admin / POST /api/socialV2/group-admin）。
  //
  // requireApprovalForKick 默认 true：kick 会真的把人移出群，必须由管理员显式放行
  // （操作者通道传 allowDangerous:true，或走挂起审批）。**ban（禁言）不需要批准**：
  // 按用户 2026-10 的决定，机器人可以自主禁言并自己选时长，只在事后给 owner 留通知/日志。
  // notifyOwnerOnBan=false 可以关掉那条事后通知。
  //
  // ⚠️ `enabled` 与 `socialV2.tools.groupAdmin` 是**两个不同的闸门**，出厂默认一致（都关）：
  //   · tools.groupAdmin —— 控制台勾选项，决定 MCP 是否注册这两个工具（模型看不看得见）；
  //   · enabled          —— 硬开关，端点在 AI 通道上直接 403。
  // 曾经两者默认都是 false，于是"在控制台把工具勾上"之后调用仍然 403「群管理已关闭」——
  // 用户看不到第二个闸门，表现就是"明明开了却说没开"。现在 enabled 默认跟随工具开关的语义
  // （默认 true，不再单独挡），把它降级成**只在显式写 false 时才生效的紧急熔断**：
  // 想彻底停掉群管理，在 config.json 里写 socialV2.groupAdmin.enabled=false。
  const groupAdminToolOn = cfg.socialV2?.tools?.groupAdmin === true;
  cfg.socialV2.groupAdmin = {
    enabled: groupAdminToolOn,
    requireApprovalForKick: true,
    notifyOwnerOnBan: true,
    maxPerMinute: 6,
    ...(cfg.socialV2?.groupAdmin ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${errorText(error)}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~25000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${errorText(error)}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${errorText(error)}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': {
        // 只给文件名，但**带上"能读"的暗示**：模型看到纯文件名常常直接忽略，
        // 以为那是个它够不着的东西。文件内容由 qq_read_file 按需取（消息里不下载）。
        const fname = String(d.name ?? d.file ?? '');
        const fsize = Number(d.file_size ?? d.size ?? 0);
        const sizeText = fsize > 0 ? ` ${formatTextBytes(fsize)}` : '';
        const textHint = isTextFileName(fname) ? '（可以直接读，用 qq_read_file）' : '（非文本文件）';
        out.push(`[文件${fname ? ` ${fname}` : ''}${sizeText}${textHint}]`);
        break;
      }
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      // 卡片（json 段 / xml 段）：以前只塞字面量「[卡片消息]」，模型完全看不到分享的是什么。
      // 现在解析出标题/歌手/平台，让"群友发了首网易云"这件事至少是可读的；
      // 想真去听/真去看，由模型自己调 qq_open_card（会落到 video-watch / 音乐直链）。
      case 'json':
      case 'xml': {
        let card = null;
        try { card = parseCardSegment(seg); } catch { card = null; }
        const line = card?.ok ? describeCard(card) : (seg?.type === 'xml' ? '[卡片消息]' : '[卡片消息]');
        // 音乐/视频卡额外把"点开方式"提示出来：卡片本身只是个壳，内容在链接后面。
        let extra = '';
        if (card?.ok) {
          const songId = neteaseSongIdFromCard(card);
          const biliId = bilibiliIdFromCard(card);
          if (songId || biliId) extra = `（用 qq_open_card 可以点开）`;
        }
        out.push(`${line}${extra}`);
        break;
      }
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    } else if (seg.type === 'file') {
      // 群文件/私聊文件：段里自带可下载 url（SnowLuma 的 mediaUrlResolver 已经换好直链），
      // 把它留下来，qq_read_file 才有东西可读 —— 以前 file 段连 media 都不进，
      // 等于收到文件就把地址扔了，之后再想读也没处找。
      media.push({
        kind: 'file',
        name: String(d.name ?? d.file ?? ''),
        fileId: String(d.file_id ?? d.id ?? ''),
        size: Number(d.file_size ?? d.size ?? 0) || 0,
        url: String(d.url ?? ''),
        hash: String(d.file_hash ?? '')
      });
    } else if (seg.type === 'json' || seg.type === 'xml') {
      // 卡片：解析结果存进 media，让 qq_open_card 能按 messageId 找到它，
      // 而不必为了点开一张卡再去 OneBot 捞一次原文。
      let card = null;
      try { card = parseCardSegment(seg); } catch { card = null; }
      if (card?.ok) {
        media.push({
          kind: 'card',
          cardKind: card.kind,
          title: card.title,
          desc: card.desc,
          url: card.url,
          audioUrl: card.audioUrl,
          image: card.image,
          source: card.source
        });
      }
    }
  }
  return media;
}

// 「听」语音用：从消息段里挑出语音段（record），拿到时长/文件线索。
// 与 extractMediaFromSegments 分开：图片/表情会进多模态附件，语音只做转写，别混进图片通道。
function extractVoiceFromSegments(segments) {
  const voices = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'record') continue;
    const d = seg.data ?? {};
    const duration = Number(d.duration ?? d.time ?? 0);
    voices.push({
      kind: 'record',
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
      file: String(d.file ?? ''),
      url: String(d.url ?? '')
    });
  }
  return voices;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// ── 二代工具开关的**出厂默认表**（唯一的真源）──────────────────────────────
//
// 为什么必须是模块级常量、而不是继续散在 `loadConfig()` 与 `/api/socialV2/config` 两处：
// 保存配置的那段归一化曾经是
//     `if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;`
// 对一个**配置文件里本来就没有的**新开关，`current.tools[k]` 是 `undefined`，
// `undefined !== false` 就是 `true` —— 于是"没登记过的新开关"会被写进 config.json 固化成**开**，
// 而不是回落到出厂默认。实测后果：新加的 `sendMusic` / `groupAdmin`（都该默认关）被写成 true，
// MCP 侧立刻把 `qq_send_music` 注册给了模型。**默认值错了等于未经允许就给模型开了对外动作面**，
// 所以这里只留一份表，两个地方都引它。
//
// 口径（与 docs/guides/NEW_CAPABILITIES.md 一致）：
//   · 只读、零副作用的默认**开**；
//   · "发出即外显/不可撤回/会作用到别人身上"的默认**关**（sendVoice / sendImage / setStickerRemark /
//     sendMusic / groupAdmin），需要时在控制台「二代仿真 → 工具开关」里逐行打开。
const SOCIAL_V2_TOOL_DEFAULTS = Object.freeze({
  getPrompt: true,
  getUnread: true,
  getRecent: true,
  socialState: true,
  sendGroup: true,
  sendPrivate: true,
  reply: true,
  sendBurst: true,
  sendMessage: true,
  waitMessages: true,
  feedback: true,
  getMyRecent: true,
  getMessageDetail: true,
  getActiveMembers: true,
  setWakeConfig: true,
  markRead: true,
  memory: true,
  slangQuery: true,
  slangSubmit: true,
  getImages: true,
  // 「读文件」与「点开卡片」默认**开**：两个都只读、都只作用于本会话里已经收到的消息，
  // 而且正是主人 2026-10-12 明确要的能力（群里发的 txt / 网易云卡 / B 站卡）。
  // 真正要小心的从来不是"读"，所以默认放行，需要时在控制台单独关。
  readFile: true,
  openCard: true,
  getForwardMsg: true,
  sendPoke: true,
  listStickers: true,
  getStickerImage: true,
  sendSticker: true,
  // 改 QQ 官方表情备注会作用在账号的收藏表情上（别人也看得到），默认关。
  setStickerRemark: false,
  stickerNote: true,
  collectSticker: true,
  getSelfImage: true,
  watchVideo: true,
  listenVoice: true,
  // 发语音是"开口说话"的强表达，默认关。
  sendVoice: false,
  // 发图（qq_send_image）默认**关**。理由是安全侧而非功能侧：
  // 图片一旦发出去就不可撤回，而图片库（media/images/）里放的往往是操作者的截图/私人图。
  // 群聊内容不可信 ⇒ 默认给 prompt injection 一个「把库里某张图外发到白名单会话」的动作面
  // 并不划算；需要时在控制台「二代仿真 → 工具开关」里打开一行即可。
  sendImage: false,
  // 提醒 / 历史检索默认**开**（与上面几个的出厂口径相反：这两个低风险，
  // 而且「到点提醒」「翻本会话历史」都是用户明确想要的能力）。
  reminders: true,
  searchHistory: true,
  // +1 复读（qq_repeat_message）默认**开**：它发出去的仍然只是文字，风险等级与
  // sendMessage（默认开）完全一样——真正危险的从来不是"文字"，而是图片/文件/群管理。
  // 它比 sendMessage 更窄：只能复读本会话里**已经存在**的原文，且只允许群聊。
  repeatMessage: true,
  // 自省（qq_bridge_status）默认**开**：它只读、零副作用，而且"说话前先知道自己多贵"
  // 正是省钱手段本身。关掉它只会让模型盲发。
  status: true,
  // 音乐卡片默认**关**：平台卡（qq/163/kugou/…）要经 SnowLuma 的 musicSignUrl
  // （第三方签名服务）换取卡片，等于把你的点歌请求交给外部站点；而且音乐卡是
  // "发出即外显"的强表达。想完全避开第三方请用 type:'custom'（自定义卡自带 url/audio/title）。
  sendMusic: false,
  // 群管理默认**关**：会真的踢人/禁言/删消息，且默认包含高危动作。
  groupAdmin: false
});

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();
  memoryCardConfig = normalizeMemoryCardConfig(cfg.memoryCard ?? {});
  closureConfig = normalizeClosureConfig(cfg.conversationClosure ?? {});
  purposeConfig = normalizePurposeConfig(cfg.purpose ?? {});
  loadPurposeState();
  budgetConfig = normalizeBudgetConfig(cfg.tokenBudget ?? {});
  loadBudgetState();
  // 记忆大脑（长期记忆库）：默认值在 src/memory-brain.js，config.json 写 memoryBrain 块才覆盖。
  memoryBrainConfig = normalizeMemoryBrainConfig(cfg.memoryBrain ?? {});
  // 人物七层：默认值在各模块 DEFAULT_*_CONFIG，config.json 写对应块才覆盖（逐字段夹取）。
  personaStateConfig = normalizePersonaStateConfig(cfg.personaState ?? {});
  profileConfig = normalizeProfileConfig(cfg.memoryProfile ?? {});
  reflectionConfig = normalizeReflectionConfig(cfg.memoryReflection ?? {});
  proceduralConfig = normalizeProceduralConfig(cfg.memoryProcedural ?? {});
  styleGuardConfig = normalizeStyleConfig(cfg.styleGuard ?? {});
  selfStyleConfig = normalizeSelfStyleConfig(cfg.selfStyle ?? {});
  lifeLoopConfig = normalizeLifeConfig(cfg.lifeLoop ?? {});

  // ── 提醒（reminders）+ 历史归档（history-archive）：懒单例 ─────────────────
  // 两个模块都是「纯逻辑 + 自己落盘」，这里包一层懒单例：
  //   · 懒创建：启动路径上不多一次可能失败的文件操作，只有真用到才建；
  //   · 单例：提醒库必须只有一份内存状态（due()/markFired() 的判据都在内存里）。
  function resolveStatePath(value, fallback) {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  }
  let remindersStoreInstance = null;
  function remindersStore() {
    if (!remindersStoreInstance) {
      const raw = cfg.socialV2?.reminders ?? {};
      const maxPerKey = Math.max(1, Math.min(200, Number(raw.maxPerKey) || REMINDER_LIMITS.maxPerKey));
      const horizonDays = Math.max(1, Math.min(365, Number(raw.maxHorizonDays) || Math.round(REMINDER_LIMITS.maxLeadMs / 86400000)));
      remindersStoreInstance = createRemindersStore({
        file: resolveStatePath(raw.file, REMINDERS_FILE),
        limits: { maxPerKey, maxLeadMs: Math.round(horizonDays * 86400000) }
      });
      for (const warning of remindersStoreInstance.warnings ?? []) log(`⚠️ 提醒库：${warning}`);
    }
    return remindersStoreInstance;
  }
  // 同一 tick 内的重入保护：due() 是只读的，投递是异步的，没有这层同一个提醒会被处理两次。
  const remindersInFlight = new Set();
  let remindersCheckBusy = false;

  let historyArchiveInstance = null;
  function historyArchive() {
    if (!historyArchiveInstance) {
      historyArchiveInstance = createHistoryArchive({ dir: resolveStatePath(cfg.socialV2?.history?.dir, HISTORY_DIR) });
    }
    return historyArchiveInstance;
  }
  const historyEnabledV2 = () => cfg.socialV2?.history?.enabled !== false;

  // 历史归档只存**文字**：图片/语音/表情退化成一个标签（如 `[图片] 猫.png`），
  // 绝不写 base64 / 字节 / 本地绝对路径——历史库是要长期躺在 state/ 里、还要给模型检索的。
  function historyMediaLabelV2(media) {
    const parts = [];
    for (const m of Array.isArray(media) ? media : []) {
      if (!m) continue;
      const name = String(m.file ?? m.name ?? m.url ?? '').trim();
      const short = name ? path.basename(name.split('?')[0]).slice(0, 60) : '';
      if (m.kind === 'face') parts.push(`[表情${m.faceId ? ` ${m.faceId}` : ''}]`);
      else if (m.kind === 'file') parts.push(`[文件${short ? ` ${short}` : ''}]`);
      else if (m.kind === 'card') parts.push(`[卡片${m.title ? ` ${String(m.title).slice(0, 40)}` : ''}]`);
      else parts.push(`[图片${short ? ` ${short}` : ''}]`);
    }
    return parts.join(' ');
  }

  /** append 是异步的：只排队、不 await，失败写日志——收消息主链路绝不能被历史库拖住。 */
  function appendHistoryRecordV2(key, record) {
    void historyArchive().append({ key, record })
      .catch((error) => log(`[reserved2] 历史归档失败 ${key}:`, errorText(error)));
  }

  function appendHistoryInboundV2(key, info) {
    if (!historyEnabledV2()) return;
    const text = String(info?.text ?? '').trim();
    const label = historyMediaLabelV2(info?.media);
    const merged = [label, text].filter(Boolean).join(' ').trim();
    if (!merged) return;
    appendHistoryRecordV2(key, {
      tsMs: info?.tsMs,
      dir: 'in',
      senderId: info?.senderId ?? undefined,
      senderName: info?.senderName ?? undefined,
      text: merged,
      messageId: info?.messageId ?? undefined,
      replyToId: info?.replyToId ?? undefined
    });
  }

  function recordHistoryOutboundV2(key, text, messageId = null) {
    if (!historyEnabledV2()) return;
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    appendHistoryRecordV2(key, {
      tsMs: Date.now(),
      dir: 'out',
      senderName: '我',
      text: value,
      messageId: messageId != null ? String(messageId) : undefined
    });
  }

  // 唤醒被静默跳过时的原因（key -> 'disabled'|'mode'|'paused'|'notAllowed'|'busy'|'ratelimit'|'rejected'|'error'）。
  // sendWakePromptV2 的返回字符串只区分 sent/queued/skipped，但提醒投递需要更细的判据：
  // 「限流」这类自限性跳过可以用 sendToQQ 兜底，而「已暂停/已关闭/不在允许范围」不能——
  // 那等于让提醒绕过明确的人工意图。成功投递时清掉这条记录。
  const wakeSkipReasonV2 = new Map();
  // 因不可兜底原因跳过的提醒 id：日志只打一次，避免每个 60s tick 刷屏。
  const remindersSkipLogged = new Set();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${errorText(error)}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  let slangWindowSeq = 0;               // 窗口条目自增序号（见 dropSlangWindowMessages）
  let slangWindowSaveTimer = null;

  // ── 窗口为什么必须落盘（2026-10-11 的根因） ──────────────────────────────
  // 窗口原本只在内存里，而桥接进程换得非常勤（桌面一键启动 + 手动重启，实测 6 小时内重启 29 次），
  // 每次重启都把攒了一半的素材清零。群安静的时候，**单个进程寿命内最多只攒到 10 条**
  // （实测 21:42:58→22:12:35 这一段），永远够不到 extractMinMessages=12 ⇒ 自动提取
  // 一次都没跑过（bridge.log 里 6 小时零条「黑话提取」）⇒ 候选词条的 count 永远停在 1，
  // 到不了 inferenceThresholds=[2,4,8]，于是永远不研究、控制台里就只有光秃秃的词没有含义。
  // 主人看到的两句话（「黑话还是要在群聊里选出现次数多的词」「研究完后 dsh 也没提交到控制台」）
  // 都是这条链的下游症状。
  const slangWindowMax = () => Math.max(20, Math.min(1000, Number(cfg.slang?.windowMax) || 200));

  function saveSlangWindowsNow() {
    try {
      const windows = {};
      for (const [key, win] of slangWindows.entries()) {
        if (Array.isArray(win) && win.length) windows[key] = win.slice(-slangWindowMax());
      }
      atomicWriteJson(SLANG_WINDOW_FILE, { seq: slangWindowSeq, windows });
    } catch (error) {
      log('黑话窗口落盘失败（不影响运行，只是重启后会丢素材）:', errorText(error));
    }
  }

  // 每条消息都同步写盘太浪费（群里刷起来一秒好几条），这里合并到 1.5 秒一次。
  // 定时器 unref：不能因为它拖着进程不退出。
  function saveSlangWindowsSoon() {
    if (slangWindowSaveTimer) return;
    slangWindowSaveTimer = setTimeout(() => {
      slangWindowSaveTimer = null;
      saveSlangWindowsNow();
    }, 1500);
    if (typeof slangWindowSaveTimer.unref === 'function') slangWindowSaveTimer.unref();
  }

  function restoreSlangWindows() {
    const saved = readJsonSafe(SLANG_WINDOW_FILE, null);
    if (!saved || typeof saved !== 'object') return;
    const windows = saved.windows && typeof saved.windows === 'object' ? saved.windows : {};
    let restored = 0;
    for (const [key, list] of Object.entries(windows)) {
      if (!Array.isArray(list) || !list.length) continue;
      const clean = list
        .filter((m) => m && typeof m.text === 'string' && m.text.trim() && Number.isFinite(Number(m.seq)))
        .slice(-slangWindowMax())
        .map((m) => ({
          sender: String(m.sender ?? '未知'),
          text: truncateText(String(m.text), 200),
          time: Number(m.time) || Date.now(),
          seq: Number(m.seq) || 0,
        }));
      if (!clean.length) continue;
      slangWindows.set(key, clean);
      const maxSeq = clean.reduce((acc, m) => Math.max(acc, m.seq), 0);
      if (maxSeq > slangWindowSeq) slangWindowSeq = maxSeq;
      restored += clean.length;
    }
    if (Number(saved.seq) > slangWindowSeq) slangWindowSeq = Number(saved.seq);
    if (restored) log(`黑话窗口已恢复：${slangWindows.size} 个会话 / ${restored} 条素材（跨重启继续攒）`);
  }
  restoreSlangWindows();
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangLearnerTurns = 0; // 当前学习会话已经跑完的轮数（用于主动换会话，避免上下文超限）
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${errorText(error)}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', errorText(error)); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${errorText(error)}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站媒体（语音 / 图片）的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的
   * **文件名**（图片还有附带的说明文字）都不允许外发（媒体内容本身无法审计，
   * 但文件名与说明同样会泄露路径与项目信息）。
   *
   * `kind` 只影响措辞：默认 'voice' 逐字保持语音通道原有文案（有测试与活动日志按它对齐），
   * 图片传 'image' 得到「图片…」的说法。判定逻辑两条通道完全共用。
   */
  // ── 身份泄漏守卫 ────────────────────────────────────────────────────────────
  // 她出站的话里一旦承认「我是 AI / 模型 / 程序」、或把提示词/人设抖出来，群友的幻觉当场
  // 就破了——这比说错话严重得多，所以拦在发送这一层，把话打回去让她重写。
  // 只拦**智能体自己写的话**：操作者通道（控制台 / CLI，没有 x-agent-token）放行，人想发
  // 什么本来就是他的自由；qq_repeat_message 是原样复读别人的话，也不拦。
  // 配置：identityGuard.enabled（默认 true）、.mode（block 默认 / warn 只记日志 / strict
  // 连「我没有感情」这类擦边球也拦）、.exemptKeys（豁免的会话 key 列表）。
  function identityGuardBlockReason(text, key) {
    const g = cfg.identityGuard ?? {};
    if (g.enabled === false) return '';
    const exempt = Array.isArray(g.exemptKeys) ? g.exemptKeys.map(String) : [];
    if (exempt.includes(String(key ?? ''))) return '';
    const result = checkOutboundIdentity(String(text ?? ''), { mode: g.mode });
    if (result.action === 'block') {
      const id = result.hit?.id ?? 'warn';
      log(`🛡️ 身份守卫拦下一条出站文本（${id} @ ${key || '?'}）：已打回给模型重写`);
      appendActivity(`${key || '?'} 出站文本被身份守卫拦下（${id}）`, 'identity-guard');
      return result.message;
    }
    if (result.action === 'warn') {
      log(`🛡️ 身份守卫（仅提示）命中 ${result.hit?.id ?? result.warnHit?.id} @ ${key || '?'}：已放行`);
    }
    return '';
  }

  function assertOutboundAuditOk(key, subject, kind = 'voice') {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      if (kind === 'image') {
        log(`⚠️ 图片发送被安全策略拦截 (${key})：${hasKnownToken ? '内容含会话令牌' : '内容疑似含敏感信息'}`);
        appendActivity(`${key} [image] 发送被拦截（图片内容疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
        throw new Error('图片文件名或说明疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请换一张图或改掉说明');
      }
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false,
      tts: ttsCfg()
    };
  }

  /**
   * 文字转语音的运行时配置（edge / local 两条 provider）。所有字段都做兜底 + 钳制：
   * 配置写错（音色名乱填、maxChars 写成 9999）也不该让发送整条链路炸掉 ——
   * 音色名在真正合成时才校验（那时才可能抛给调用方一个可读错误）。
   *
   * provider 由音色名决定：`local:hoyo:129` 走本机 HoYo TTS 服务，其余走 edge。
   */
  /**
   * 本地 HoYo TTS 音色表的短缓存：控制台/接口连着被调时不要每次都去问一次服务。
   * 返回 null 表示「服务没起或说不上话」，调用方退回 tts.js 里的兜底小表。
   */
  const localVoicesCache = { at: 0, url: '', value: null };
  async function localVoicesCached(url, { timeoutMs = 2500, ttlMs = 2000 } = {}) {
    const now = Date.now();
    if (localVoicesCache.url === url && now - localVoicesCache.at < ttlMs) return localVoicesCache.value;
    const value = await fetchLocalTtsVoices({ localUrl: url, timeoutMs });
    localVoicesCache.at = now;
    localVoicesCache.url = url;
    localVoicesCache.value = value;
    return value;
  }

  function ttsCfg() {
    const t = cfg.socialV2?.voice?.tts ?? {};
    const maxChars = Number(t.maxChars) > 0
      ? Math.min(TTS_LIMITS.hardMaxChars, Math.floor(Number(t.maxChars)))
      : TTS_LIMITS.maxChars;
    const libDir = path.resolve(ROOT, String(cfg.socialV2?.voice?.dir ?? 'audio'));
    const voice = String(t.voice ?? '').trim() || TTS_DEFAULT_VOICE;
    const local = t.local ?? {};
    return {
      enabled: t.enabled !== false,
      voice,
      provider: ttsVoiceProvider(voice),
      rate: String(t.rate ?? '').trim() || '+0%',
      pitch: String(t.pitch ?? '').trim() || '+0Hz',
      volume: String(t.volume ?? '').trim() || '+0%',
      maxChars,
      timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : TTS_LIMITS.timeoutMs,
      localUrl: String(local.url ?? t.localUrl ?? '').trim().replace(/\/+$/, '') || TTS_LOCAL_DEFAULT_URL,
      localParams: (local.params && typeof local.params === 'object') ? local.params : {},
      // RVC（变声）参数：解释器/脚本/设备/源音色，缺项由 tts.js 兜默认值
      rvc: (t.rvc && typeof t.rvc === 'object') ? t.rvc : {},
      dir: path.join(libDir, 'tts')
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看），或直接传 text 让桥接现场合成一句话（TTS）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * AI 通道的「要说/发什么」解析：两种来源二选一。
   *   - text ：现场用免费 edge TTS 合成（产物落在语音库的 tts/ 子目录里，所以天然满足
   *            「AI 只能发语音库内文件」这条约束，不需要放宽任何路径闸门）；
   *   - voice：语音库里已有的音频（resolveVoicePathForV2，路径闸门不变）。
   * 返回 { path, via, tts }；tts 非空表示这是合成产物（含清洗后真正被朗读的文本）。
   */
  async function prepareVoiceForV2(key, { voice = '', text = '', ttsVoice = '', ttsRate = '' } = {}) {
    const vc = voiceCfg();
    const spoken = String(text ?? '').trim();
    const named = String(voice ?? '').trim();
    if (spoken && named) throw new Error('text 与 voice 只能给一个：要么让桥接合成一句话（text），要么发语音库里已有的音频（voice）');
    if (!spoken) {
      const resolved = resolveVoicePathForV2(named);
      return { path: resolved.path, via: resolved.via, tts: null };
    }
    if (!vc.tts.enabled) throw new Error('文字转语音已关闭（socialV2.voice.tts.enabled=false）');
    // 要说的话会被送到微软的朗读服务（出了本机）：先按外发内容审计一遍，
    // 免得被群里的 prompt injection 诱导着把本机路径/令牌「念」出去。
    assertOutboundAuditOk(key, `[TTS]${spoken}`);
    const voiceName = resolveTtsVoice(ttsVoice || vc.tts.voice);
    const provider = ttsVoiceProvider(voiceName);
    const info = await synthesizeSpeech(spoken, {
      voice: voiceName,
      rate: ttsRate || vc.tts.rate,
      pitch: vc.tts.pitch,
      volume: vc.tts.volume,
      outDir: vc.tts.dir,
      maxChars: vc.tts.maxChars,
      timeoutMs: vc.tts.timeoutMs,
      localUrl: vc.tts.localUrl,
      localParams: vc.tts.localParams,
      rvc: vc.tts.rvc
    });
    return {
      // 命中缓存时也说清楚是哪条 provider 的缓存（edge/local 各有一份缓存目录）。
      path: info.path,
      via: info.cached ? `tts-cache${provider === 'local' ? '-local' : ''}` : `tts-${provider}`,
      tts: {
        text: info.text,
        voice: info.voice,
        provider: info.provider ?? provider,
        cached: info.cached,
        truncated: info.truncated,
        originalLength: info.originalLength,
        ms: info.ms
      }
    };
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds, ffmpegPath: vc.ffmpegPath });
    } catch (error) {
      throw new Error(`音频检查失败：${errorText(error)}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${errorText(error)}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /**
   * 把「我发了条媒体消息（语音 / 图片）」写进二代会话的 recentMessages，
   * 让 AI 自己知道刚发过什么（否则它下一轮会重复发、或者以为没发成功）。
   */
  function recordSelfMessageV2(key, display, messageId = null) {
    const st = getSocialV2State(key);
    const entry = {
      messageId: messageId ? String(messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    // 出站历史（媒体）：语音/图片在 recordSelfMessageV2 这一处记一次，
    // 文本路径在 recordSentMessagesV2 里记——两条路互不重叠，同一句不会被记两遍。
    recordHistoryOutboundV2(key, entry.text, entry.messageId);
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
    return entry;
  }

  /** 语音版本的包装（messageId 来自发送结果）。 */
  function recordVoiceSentV2(key, sent, label) {
    const display = label || `[语音 ${sent.detail}]`;
    return recordSelfMessageV2(key, display, sent.messageId);
  }

  /**
   * 发完语音/图片后的**落地验证**：把这条消息从网关读回来，确认它真的带着对应消息段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「真的发出去了」，唯一可靠的证据是 get_msg 回读到的消息段。
   * 返回 { confirmed, segment } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifySegmentSent(messageId, segmentType) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const segment = segments.find((s) => s?.type === segmentType);
      if (!segment) return null;
      // 注意：只回报「确认成功 + 必要元数据」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: segment.data?.duration != null ? Number(segment.data.duration) : null
      };
    } catch (error) {
      log(`[media] 发送后回读校验失败（不影响已发送）：${errorText(error)}`);
      return null;
    }
  }

  /** 语音专用的包装（回读 record 段）。 */
  async function verifyVoiceMessageSent(messageId) {
    return verifySegmentSent(messageId, 'record');
  }

  /**
   * AI 通道入口：解析引用（语音库文件 **或** 现场 TTS 合成）→ 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback, tts }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null, text = '', ttsVoice = '', ttsRate = '' } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const prepared = await prepareVoiceForV2(key, { voice: voiceRef, text, ttsVoice, ttsRate });
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, prepared.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    // 会话记录里写「我说了什么」：TTS 的话把原话记下来，AI 下一轮才知道自己刚说过什么。
    const shownLabel = label || (prepared.tts ? `[语音] ${prepared.tts.text}` : '');
    recordVoiceSentV2(key, sent, shownLabel);
    log(`[voice] ${key} 已发送语音 ${path.basename(prepared.path)} (${sent.detail}${prepared.tts ? `, tts=${prepared.tts.voice}${prepared.tts.cached ? '/cache' : ''}` : ''}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${prepared.tts ? `（TTS）${truncateText(prepared.tts.text, 60)}` : path.basename(prepared.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${errorText(error)}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: prepared.path, via: prepared.via, tts: prepared.tts, verification, readback: readbackText };
  }

  // ── 「听」：把收到的语音转成文字（QQ 自带转写，网关 fetch_ptt_text） ────────────
  // 转写由 QQ 客户端异步生成，SnowLuma 侧一次 fetch_ptt_text 自己会挂 20s 等 QQ 推送结果，
  // 而且它同一个 message_id 只允许一个 waiter（新请求会把上一个顶掉）。所以这里的规矩：
  // ①单次超时必须 >20s，不要在它还等着的时候中止；②同一个 message_id 只发一个请求
  // （in-flight 去重：自动补写和 qq_listen_voice 共用同一个 Promise）；③失败要记原因，
  // 占位符写清楚是超时还是 QQ 报错，别一律说「可能没开语音转文字」。
  const voiceTranscriptCache = new Map(); // messageId -> text
  const voiceTranscriptInflight = new Map(); // messageId -> Promise<string|null>
  const voiceTranscriptError = new Map(); // messageId -> 最近一次失败原因

  async function requestPttTextOnce(ref, timeoutMs) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: ref }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.status === 'ok' && body.retcode === 0) {
        return { text: String(body.data?.text ?? '').trim(), reason: '', hard: false };
      }
      const reason = String(body?.message ?? body?.wording ?? body?.msg ?? '').trim() || `网关返回 HTTP ${res.status}`;
      // QQ 明确报错（例如 ptt translate failed: error=9）时重复问没有意义，别再叠重试。
      const hard = /error=\d/.test(reason) || /不包含语音|不在缓存|已撤回/.test(reason);
      return { text: '', reason, hard };
    } catch (error) {
      const msg = String(errorText(error));
      const timedOut = /abort|timeout/i.test(msg);
      return { text: '', reason: timedOut ? 'QQ 20s 内没有推送转写结果' : `网关请求失败：${msg}`, hard: false };
    }
  }

  async function fetchPttTextForMessage(messageId, options = {}) {
    const ref = String(messageId ?? '').trim();
    if (!ref) return null;
    if (voiceTranscriptCache.has(ref)) return voiceTranscriptCache.get(ref);
    const inflight = voiceTranscriptInflight.get(ref);
    if (inflight) return inflight;
    const timeoutMs = Math.max(1000, Number(cfg.socialV2?.voice?.hearTimeoutMs) || 25000);
    const retryRaw = Number(cfg.socialV2?.voice?.hearRetryMs);
    const retryMs = Number.isFinite(retryRaw) ? Math.max(0, retryRaw) : 4000;
    const attempts = Math.max(1, Math.min(4, Number(cfg.socialV2?.voice?.hearAttempts) || 2));
    const task = (async () => {
      let reason = '';
      for (let i = 0; i < attempts; i += 1) {
        if (i > 0 && retryMs) await new Promise((resolve) => setTimeout(resolve, retryMs));
        const one = await requestPttTextOnce(ref, timeoutMs);
        if (one.text) {
          voiceTranscriptCache.set(ref, one.text);
          if (voiceTranscriptCache.size > 200) {
            const oldest = voiceTranscriptCache.keys().next().value;
            if (oldest !== undefined) voiceTranscriptCache.delete(oldest);
          }
          voiceTranscriptError.delete(ref);
          return one.text;
        }
        reason = one.reason || reason;
        if (one.hard) break;
        if (options.retry === false) break;
      }
      voiceTranscriptError.set(ref, reason || '没有转写结果');
      // 失败分支同样要有上限：以前只给 voiceTranscriptCache 裁剪，失败记录却只增不减，
      // 转写长期失败的会话会让这个 Map 无界增长。
      if (voiceTranscriptError.size > 200) {
        const oldestErr = voiceTranscriptError.keys().next().value;
        if (oldestErr !== undefined) voiceTranscriptError.delete(oldestErr);
      }
      log(`[voice] 语音转写获取失败 ${ref}：${reason || '没有转写结果'}`);
      return null;
    })().finally(() => {
      voiceTranscriptInflight.delete(ref);
    });
    voiceTranscriptInflight.set(ref, task);
    return task;
  }

  // 取回转写后补写进那条消息：收到语音时先写「（转写中…）」占位，不阻塞收消息流程
  // （QQ 的转写是异步生成的，硬等会拖慢处理并可能打乱消息落库顺序）。
  // 重试策略全部在 fetchPttTextForMessage 里（超时 >20s、同一 message_id 去重、最多 hearAttempts 次）；
  // 这里不再自己叠一层 1.2s 一次的快速重试——实测那种连环重试会把 SnowLuma 的 waiter 顶掉，必失败。
  async function enrichVoiceTranscriptV2(key, ref, voiceCount = 1) {
    const text = await fetchPttTextForMessage(ref);
    const st = getSocialV2State(key);
    const pool = [...(st.recentMessages ?? []), ...(st.unread ?? [])];
    const msg = pool.find((m) => m && String(m.messageId ?? '') === String(ref));
    const reason = text ? '' : voiceTranscriptError.get(String(ref)) || '没有转写结果';
    const detail = text ? `（QQ 转写：${text}）` : `（拿不到 QQ 转写：${reason}）`;
    if (msg) {
      for (const field of ['text', 'plain', 'tail']) {
        const current = String(msg[field] ?? '');
        if (!current.includes('（转写中…）')) continue;
        const next = current.replace('（转写中…）', detail);
        msg[field] = field === 'tail' ? truncateTextTail(next, 200) : truncateText(next, 200);
      }
      msg.voiceTranscript = text || '';
      saveSocialV2State();
    }
    log(text
      ? `[voice] ${key} 语音转写已补写（${voiceCount} 条语音）：${text.slice(0, 40)}`
      : `[voice] ${key} 语音转写最终没拿到（${voiceCount} 条语音）：${reason}`);
  }

  // ── 图片发送：来源解析 / 限流 / 发送 ─────────────────────────────────────────
  //
  // 两条通道（与语音同构，闸门定义在 bridge.js，路径与格式规则在 send-image-lib.js）：
  //   - AI（reserved2 + agent token）：只能发**图片库**（`socialV2.media.dir`，默认 media/images/）
  //     内的文件，或一个公网 http(s) 图片 URL（由桥接用 safe-fetch 抓取并校验，绝不把 URL
  //     交给网关去抓——那等于把 SnowLuma 变成 SSRF 出口，还绕过全部校验）。
  //   - 操作者（控制台 / CLI，凭 consoleToken）：可以发**库外**本机文件。这是有意放开的
  //     （操作者本来就能读本机文件，与语音 resolveVoicePathForOperator 同一口径），
  //     但体积/格式/像素校验、外发审计、限流一个都不少。
  //
  // 图片发送时间戳（scopeKey → number[]）：与文本、语音都分开计数，图片额度独立。
  const imageSendTimes = new Map();

  /**
   * 图片限流：与 voiceBudgetCheck 同一口径 —— 只检查、不占额度，真正发出去之后才由
   * imageBudgetCommit 记账（参数错、被审计拦、网关失败都不该白白吃掉配额）。
   */
  function imageBudgetCheck(scopeKey, cfgM) {
    const now = Date.now();
    const bucket = imageSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    // 限流单独用 429（其余校验错误都是 400）：调用方/模型据此区分"参数不对"与"稍后再试"，
    // 与桥接里文本发送超限的 429 口径一致。
    if (cfgM.maxPerMinute > 0 && inMinute.length + 1 > cfgM.maxPerMinute) {
      const error = new Error(`发图频率超限（每分钟最多 ${cfgM.maxPerMinute} 张），请稍后再试`);
      error.status = 429;
      throw error;
    }
    if (cfgM.maxPerHour > 0 && inHour.length + 1 > cfgM.maxPerHour) {
      const error = new Error(`发图频率超限（每小时最多 ${cfgM.maxPerHour} 张），请稍后再试`);
      error.status = 429;
      throw error;
    }
  }

  function imageBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (imageSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    imageSendTimes.set(scopeKey, bucket);
  }

  /**
   * 把「file 或 url」解析成一份**已验证的**可发送图片。
   *
   * 返回 { via, name, path?, url?, bytes, format, mimeType, width, height, detail, sendRef, auditSubject }：
   *   - sendRef：交给 OneBot 的 image 段 file 字段。库内文件用绝对路径（零拷贝）；
   *     URL 来源用 `base64://` 内联（不落盘：临时文件既要清理又会和网关读文件抢时序）。
   *   - auditSubject：交给外发审计的字符串。URL 只取 origin+pathname —— 查询串里常有
   *     签名/令牌，整串丢给 SENSITIVE_RE 会把正常图床链接误判成敏感信息。
   */
  async function resolveImageSource({ file = '', url = '' } = {}, { operator = false } = {}) {
    const mc = mediaCfg(cfg, ROOT);
    const rawFile = String(file ?? '').trim();
    const rawUrl = String(url ?? '').trim();
    if (rawFile && rawUrl) throw new Error('file 与 url 只能给一个：发库内文件用 file，发公网图片用 url');
    if (!rawFile && !rawUrl) {
      throw new Error('缺少图片：给图片库里的文件名（file），或给一个公网图片 URL（url）');
    }

    if (rawUrl) {
      const fetched = await fetchImageBytes(rawUrl, mc.maxSendBytes);
      let auditSubject = rawUrl;
      try {
        const u = new URL(fetched.url);
        auditSubject = `${u.origin}${u.pathname}`;
      } catch {}
      return {
        via: 'url',
        name: rawUrl,
        url: fetched.url,
        bytes: fetched.bytes,
        format: fetched.format,
        mimeType: fetched.mimeType,
        width: fetched.width,
        height: fetched.height,
        detail: describeImage(fetched),
        sendRef: `base64://${fetched.buffer.toString('base64')}`,
        auditSubject
      };
    }

    const resolved = operator
      ? resolveImagePathForOperator(mc.dir, rawFile)
      : resolveImagePathInV2Library(mc.dir, rawFile);
    // 先 stat 再读（readLocalImage 内部做），避免把超大文件整段读进内存。
    const info = readLocalImage(resolved.path, mc.maxSendBytes, '图片');
    return {
      via: resolved.via,
      name: resolved.name,
      path: resolved.path,
      bytes: info.bytes,
      format: info.format,
      mimeType: info.mimeType,
      width: info.width,
      height: info.height,
      detail: describeImage(info),
      sendRef: resolved.path,
      auditSubject: path.basename(resolved.path)
    };
  }

  /**
   * 底层发送：把图片（可带一句说明）作为 image 段交给 SnowLuma。
   *
   * 说明与图片放在**同一条消息**里（text 段在前、image 段在后，读起来就是"文字配图"）。
   * 这一点与表情不同：表情消息只能是一张表情（见 sendStickerV2），图片消息带文字是正常的。
   *
   * guard=true（AI 通道）时发送前必须通过 captureSendGuard：会话/模式/白名单任一变就放弃发送；
   * guard=false（操作者通道）不套会话闸门（操作者可能不在任何会话里）。
   * 与文本/语音共用 sendChain，保证"先文字后图片"的真人顺序不被并发工具调用打乱。
   */
  async function sendImageV2(key, source, { caption = '', guard = false } = {}) {
    const [kind, id] = key.split(':');
    const segments = [];
    if (caption) segments.push({ type: 'text', data: { text: caption } });
    segments.push({ type: 'image', data: { file: source.sendRef } });
    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          // 图片比文本大得多（base64 内联的 URL 来源最多 ~27 MB 请求体），给 60s 预算。
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    const data = await sendPromise;
    return { messageId: data?.message_id ?? null };
  }

  /**
   * 把**任意一个段**发给会话（音乐卡片走这里）。
   *
   * 为什么单独抽一个通用段发送器，而不是再写一份「音乐专用发送」：
   * 与图片一样，它必须共用 sendChain（否则并发的工具调用会把"先说话后发卡片"的顺序打乱）、
   * 共用 captureSendGuard（会话/模式/白名单在构造段与真正发出之间变了就放弃发送），
   * 以及共用同一条网关错误处理（HTTP 426 的提示语只有这里知道）。
   * 复制一份等于把这三条纪律各抄一遍，早晚会有一份忘记跟上。
   *
   * caption 会作为 text 段放在卡片**之前**：读起来就是"说一句 + 甩个卡片"，而不是卡片后
   * 跟一句无主的话。注意 music 段与 image 段一样是"独占气泡"的（QQ 客户端不会把文字与
   * 音乐卡渲染成同一个气泡），但 OneBot 允许同一条消息里两段共存，与发图的既有行为一致。
   */
  async function sendSegmentV2(key, segment, { caption = '', guard = false } = {}) {
    const [kind, id] = key.split(':');
    const segments = [];
    if (caption) segments.push({ type: 'text', data: { text: caption } });
    segments.push(segment);
    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    const data = await sendPromise;
    return { messageId: data?.message_id ?? null };
  }


  /**
   * 发图/音乐共用的发送主流程（与语音通道同构）。
   * 不会各自演化出偏差。顺序刻意与语音通道一致：
   *   解析来源 → 审计说明与文件名 → 限流检查 → dryRun 只校验 / 真发 → 记账 → 写会话记录
   *   → 写日志与活动日志 →（可选）回读校验。
   * 返回可以直接 sendJson 的对象；抛出的错误带 `status`（400 = 校验失败，500 = 发送失败）。
   */
  async function performImageSend(key, body, { agentCall = false, operator = false } = {}) {
    const mc = mediaCfg(cfg, ROOT);
    const caption = String(body.text ?? '').trim();
    const maxCaption = Number(cfg.socialV2?.send?.maxMessageChars) > 0 ? Number(cfg.socialV2.send.maxMessageChars) : 500;
    if (caption.length > maxCaption) {
      throw new Error(`附图说明过长（${caption.length} 字，上限 ${maxCaption} 字）。图片本身不需要长说明，想多说几句请用 qq_send_message 单独发`);
    }
    // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
    const source = await resolveImageSource({ file: body.file, url: body.url }, { operator });
    // 说明文字与文件名都是"会随图泄露"的内容：与文本发送同一条审计规则，命中就拒。
    if (caption) assertOutboundAuditOk(key, caption, 'image');
    assertOutboundAuditOk(key, source.auditSubject, 'image');

    // AI 借用操作者通道时，额度要记在会话桶里（和 /api/socialV2/send-image 只隔一个调用方），
    // 否则图片额度可以被另一条通道整片绕过。
    const scope = agentCall ? key : 'operator:cli';
    imageBudgetCheck(scope, mc);

    const preview = {
      key,
      // AI 通道只回报库内相对名 / 原始 URL，绝不回报绝对路径：这条 JSON 会进模型上下文，
      // 而模型面对的是不可信的群聊内容。操作者通道（控制台）才回报绝对路径。
      file: operator ? source.path : source.name,
      via: source.via,
      bytes: source.bytes,
      format: source.format,
      width: source.width,
      height: source.height,
      detail: source.detail,
      text: caption || null,
      limits: { maxSendBytes: mc.maxSendBytes, maxPerMinute: mc.maxPerMinute, maxPerHour: mc.maxPerHour }
    };
    if (body.dryRun === true) return { ok: true, dryRun: true, ...preview };

    let sent;
    try {
      sent = await sendImageV2(key, source, { caption, guard: agentCall });
    } catch (error) {
      const failure = new Error(error?.message ?? String(error));
      failure.status = 500;
      throw failure;
    }
    // 额度只在真正发出去之后记账（imageBudgetCheck 不占额度），失败路径无需回滚。
    imageBudgetCommit(scope);
    // 「我发过这张图」要落进会话记录，AI 下一轮才知道自己发过了（与语音/表情一致）。
    recordSelfMessageV2(key, `[图片 ${source.detail}]${caption ? ` ${caption}` : ''}`, sent.messageId);
    log(`[image] ${key} 已发送图片 ${source.name} (${source.detail}${caption ? `, 说明=${truncateText(caption, 40)}` : ''}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [image] 发送图片 ${source.name} (${source.detail})`);
    // 回读校验默认关（与语音不同）：图片段在 get_msg 里一眼可见，不值得每次多发一次网关往返。
    const verification = body.verify === true ? await verifySegmentSent(sent.messageId, 'image') : null;
    return { ok: true, ...preview, messageId: sent.messageId, verified: verification?.confirmed === true };
  }

  /**
   * 音乐卡片的公共后半段：两条通道（AI / 操作者）共用。
   *
   * 与 performImageSend 同构（构造段 → 限流 → dryRun / 真发 → 记账 → 写会话记录 → 日志），
   * 但有三处**刻意的**差别：
   *   ① 段不是我们下载/校验出来的文件，而是交给 SnowLuma 的一张卡片。平台卡（163/qq/…）
   *      的卡片内容由 SnowLuma 侧的 musicSignUrl 第三方签名服务换取 —— 桥接**只发
   *      `{type:'music',data:{type,id}}`，自己绝不联网去取签名**（测试里有一条断言守着
   *      「交给网关的段里不含 ss.xingzhige.com」）。这一点由 buildMusicSegment 的
   *      thirdPartySign 如实回报，并在下面写进日志。
   *   ② 没有外发审计主体：卡片的"内容"是平台 + 数字 id，没有自由文本会随卡片泄露。
   *      caption 仍然照常走审计（它是我们要说出去的话）。
   *   ③ 限流借用 imageBudgetCheck/Commit 的时间戳桶实现，但桶按**音乐**配置读，
   *      因此与发图配额互不挤占（各有各的 maxPerMinute/maxPerHour）。
   */
  async function performMusicSend(key, body, { agentCall = false, operator = false } = {}) {
    const mc = cfg.socialV2?.music ?? {};
    if (mc.enabled === false) {
      const error = new Error('音乐卡片已关闭（socialV2.music.enabled=false）');
      error.status = 403;
      throw error;
    }
    const caption = String(body.text ?? '').trim();
    const maxCaption = Number(cfg.socialV2?.send?.maxMessageChars) > 0 ? Number(cfg.socialV2.send.maxMessageChars) : 500;
    if (caption.length > maxCaption) {
      throw new Error(`随卡说明过长（${caption.length} 字，上限 ${maxCaption} 字）。想多说几句请用 qq_send_message 单独发`);
    }
    if (caption) assertOutboundAuditOk(key, caption, 'music');
    // allowThirdPartySign 由社交配置统一给：关掉之后平台卡会被 buildMusicSegment 直接拒掉
    // （而不是"悄悄退化成自定义卡"——那会让模型以为卡片发出去了）。
    const built = buildMusicSegment({ ...body, allowThirdPartySign: mc.allowThirdPartySign !== false });
    if (!built.ok) throw new Error(built.error ?? '音乐卡片参数不合法');
    const segment = built.segment;
    const kind = built.kind === 'custom' ? 'custom' : 'platform';
    const detail = describeMusicSegment(segment);
    // 额度检查必须在 dryRun **之前**：dryRun 的承诺是"只校验不发送"，但它必须如实报告
    // "这一次真发会不会被限流"，否则调用方拿 dryRun 探路、再真发时撞 429 就白跑一趟。
    const scope = agentCall ? key : 'operator:cli';
    imageBudgetCheck(scope, {
      maxPerMinute: Number(mc.maxPerMinute) || 0,
      maxPerHour: Number(mc.maxPerHour) || 0
    });
    const preview = {
      key,
      kind,
      thirdPartySign: built.thirdPartySign === true,
      detail,
      // 回报给模型的段信息里**不含**任何签名 URL：签名是 SnowLuma 内部的事。
      segment: { type: 'music', data: built.kind === 'custom' ? { type: 'custom', title: segment.data.title } : { type: segment.data.type, id: segment.data.id } },
      warnings: built.warnings ?? [],
      text: caption || null,
      limits: { maxPerMinute: Number(mc.maxPerMinute) || 0, maxPerHour: Number(mc.maxPerHour) || 0 }
    };
    if (body.dryRun === true) return { ok: true, dryRun: true, ...preview };

    let sent;
    try {
      sent = await sendSegmentV2(key, segment, { caption, guard: agentCall });
    } catch (error) {
      const failure = new Error(error?.message ?? String(error));
      failure.status = 500;
      throw failure;
    }
    imageBudgetCommit(scope);
    recordSelfMessageV2(key, `[音乐 ${detail}]${caption ? ` ${caption}` : ''}`, sent.messageId);
    // 平台卡必留一条"经第三方签名"的日志：这是本能力唯一的隐私外延，事后要能查得到发过什么。
    const signNote = built.thirdPartySign === true ? '（平台卡，经 SnowLuma musicSignUrl 第三方签名服务换取卡片）' : '（自定义卡，未经第三方）';
    log(`[music] ${key} 已发送${detail}${signNote}, messageId=${sent.messageId ?? '?'}`);
    appendActivity(`${key} [music] 发送${detail}`);
    return { ok: true, ...preview, messageId: sent.messageId };
  }

  // ── 群管理（kick / ban / unban / deleteMsg / 处理申请）────────────────────────
  //
  // 设计口径（为什么长这样）：
  //   1. 这里**没有一条不经过 buildGroupAdminAction 的动作**。参数校验、参数兜底、审计串、
  //      风险分级全部由 src/group-admin.js 决定；bridge 只负责"什么时候允许走到它"。
  //      这样以后加动作只改一个文件，也不会出现"某个端点偷偷用了自己的校验"。
  //   2. "要不要人批"与"参数对不对"是**两件事**，顺序不能颠倒：
  //      kick 未放行时 buildGroupAdminAction 会在第 76 行左右直接返回 needApproval，
  //      **连 groupId 都还没校验**。如果就这么返回 403，那么 `kick` 不带 groupId 也会得到
  //      "需要审批"而不是 400 —— 调用方会以为是权限问题，反复申请一个根本填错的参数。
  //      所以这里用 group-admin.js 自己的映射表先判"这个 op 认不认识、必填参数在不在"，
  //      再进审批闸门（见 assertGroupAdminShape）。
  //   3. 高危动作只有**操作者通道**能放行。AI 自己传 allowDangerous 一律无效 ——
  //      模型不能给自己发权限，那是 confused deputy。
  //
  // 申请记录件的上限：st.pendingRequests 只留最近 20 条。这是有意的：它会被写进
  // state/socialV2.json 并进入提示词的"最近消息"，无上限等于让一条刷屏申请把上下文撑爆。
  const GROUP_ADMIN_REQUEST_LIMIT = 20;
  // 群管理审批比"agent 请求审批"更急，但也不该几分钟就失效（管理员可能不在电脑前）；
  // 30 分钟够回，又不会让一个几小时前的踢人请求继续有效 —— 时间越久，参数里的
  // user_id 越可能已经不该被踢。
  const GROUP_ADMIN_APPROVAL_TTL_MS = 30 * 60 * 1000;
  // 需要管理员**显式放行**才能执行的动作 = group-admin.js 里判定为 high 风险的那些。
  // 从 GROUP_ADMIN_RISK 推导而不是另写一份，避免两处不一致。
  const GROUP_ADMIN_DANGEROUS_OPS = new Set(
    Object.keys(GROUP_ADMIN_RISK).filter((op) => GROUP_ADMIN_RISK[op] === 'high')
  );

  /**
   * 先判「这个 op 认不认识、必填参数在不在」再谈审批。
   *
   * 为什么不能只靠 buildGroupAdminAction：它在高危动作未放行时**提前返回 needApproval**，
   * 于是 `{op:'kick'}`（连 groupId 都没有）也会得到"需要审批"，而调用方要的是 400
   * "你参数没填全"。这里用同一张映射表 + 同一组正则做一遍**形状**检查，全部通过才允许
   * 进入审批闸门；任何一项不过就直接 400，和放行之后由 buildGroupAdminAction 给出的
   * 参数错误在文案上保持一致（同样是 400，且尽量给同一个错误文案）。
   */
  function assertGroupAdminShape(op, body, { requireGroupId = false, synthesizedGroupId = '', explicitGroupId = undefined } = {}) {
    const o = String(op ?? '').trim();
    const fail = (error) => {
      const e = new Error(error);
      e.status = 400;
      e.shapeError = true;
      throw e;
    };
    if (!Object.prototype.hasOwnProperty.call(GROUP_ADMIN_ACTIONS, o)) {
      fail(`不支持的群管理动作：${o || '（空）'}（可用：${Object.keys(GROUP_ADMIN_ACTIONS).join('、')}）`);
    }
    const idRe = /^[1-9]\d*$/;
    // groupId 有两条来源，语义不同：
    //   · **调用方显式给的** body.groupId —— 必须自己合法。
    //   · **本函数推导出来的** synthesizedGroupId（AI 通道来自会话 key；操作者通道来自 target）
    //     —— 只有 `requireGroupId === false`（低/中危）时才允许兜底那些"没打算指定群"的调用。
    //
    // 为什么高危必须要求显式给出：否则 `{op:'kick', userId:'999'}`（漏写群号）会被静默地
    // 当成"踢本群的人"。模型只是漏了个字段，后果却是真把人移出群 —— 这种事必须 400，
    // 让它改对再来。而 deleteMsg 这类低危动作让 target/key 兜底是安全的（作用域就是
    // 那个群，且可撤回/影响小）。
    // ⚠️ 关键：这里必须用**调用方自己写的** body.groupId，不能看 paramsIn ——
    // performGroupAdmin 为了低/中危动作的便利会把推导出来的群号注入 paramsIn，
    // 一旦改看 paramsIn，`{op:'kick'}` 就永远通不过 400 闸门。
    const ownGroupId = explicitGroupId === undefined ? body.groupId : explicitGroupId;
    const explicit = String(ownGroupId ?? '').trim();
    const groupId = explicit || (requireGroupId ? '' : String(synthesizedGroupId ?? '').trim());
    if (!idRe.test(groupId)) fail('groupId 必须是正整数（群号）');
    if (o === 'kick' || o === 'ban' || o === 'unban') {
      const userId = String(body.userId ?? '').trim();
      if (!idRe.test(userId)) fail('userId 必须是正整数（QQ 号）');
    }
    if (o === 'ban') {
      const sec = Number(body.durationSec);
      if (!Number.isInteger(sec) || sec <= 0) fail('durationSec 必须是正整数秒（解除禁言请用 op:"unban"）');
      if (sec > MAX_BAN_SECONDS) fail(`durationSec 超过上限（${sec} > ${MAX_BAN_SECONDS} 秒 = 30 天）`);
    }
    if (o === 'deleteMsg' && !/^-?[1-9]\d*$/.test(String(body.messageId ?? '').trim())) {
      fail('messageId 必须是非零整数（QQ 消息 id 可以是负数）');
    }
    if (o === 'approveFriend' || o === 'approveGroup') {
      if (!String(body.flag ?? '').trim()) fail('flag 不能为空（来自申请事件的 flag，见 qq_list_requests）');
      if (typeof body.approve !== 'boolean') fail('approve 必须是 true/false');
      if (o === 'approveGroup' && body.subType !== undefined && body.subType !== ''
        && !GROUP_REQUEST_SUBTYPES.includes(String(body.subType))) {
        fail(`subType 只能是 ${GROUP_REQUEST_SUBTYPES.join(' / ')}（收到：${body.subType}）`);
      }
    }
  }

  /**
   * 动作参数构造（单一出口）。
   *
   * 高危动作**只有**在 `approval === 'owner'`（管理员在私聊里回过「通过」）时才允许
   * `allowDangerous:true`；AI 通过 HTTP 传上来的 allowDangerous 一律丢弃 —— 模型不能
   * 自己给自己发权限。
   */
  function groupAdminParamsFor(op, body, { approval = 'none' } = {}) {
    // `approval`：
    //   'none'    —— 还没有得到任何放行。高危动作会被 buildGroupAdminAction 直接拒（needApproval）。
    //   'owner'   —— 管理员已回「通过」，可以真执行。
    //   'pending' —— 只是**构造参数以便登记待审批**，调用方保证不会执行（见 performGroupAdmin
    //                的高危分支）。没有这一档时，登记审批的那一步会先被 buildGroupAdminAction
    //                以"必须由管理员显式放行"拒掉 —— 于是**审批根本登记不上**，模型只看到一句
    //                "必须由管理员显式放行"，管理员那边一条消息都收不到，表现就是"群管理用不了"。
    const allowDangerous = approval === 'owner' || approval === 'pending';
    const built = buildGroupAdminAction({ ...body, op, allowDangerous });
    if (!built.ok) {
      const e = new Error(built.error ?? '群管理动作参数不合法');
      e.status = 400;
      // `shapeError` 是给端点分流用的：只有**参数本身不合法**才算参数错误（→ 400）。
      // 「需要审批」虽然也是 !ok，但它是业务结果（→ 403 + needApproval）：
      // 两者都在这里被抛出去，端点必须能分清，否则会出现"要审批"被报成"你填错了"，
      // 或者反过来 —— 漏填参数被报成"等管理员批"（后者会让调用方白等一场）。
      e.shapeError = built.needApproval !== true;
      e.needApproval = built.needApproval === true;
      throw e;
    }
    return built;
  }

  /** 群管理动作是否真的打到了网关 —— 只用于日志/断言的可读性，不参与控制流。 */
  function groupAdminOpText(entry) {
    if (!entry) return '';
    return `${entry.op ?? '?'} → ${entry.action ?? '?'} ${JSON.stringify(entry.params ?? {})}`;
  }

  // ── 群管理：通知管理员与挂起审批 ─────────────────────────────────────────
  //
  // 所有"通知管理员"的路径都只走**私聊**（`private:<ownerQQ>`），原因是它是唯一一条
  // 一定能被读到、且不会被群友看到的通道。但私聊 key 未必在白名单/模式允许范围内，
  // 所以每一次发送都要先过 `modeAllowed` —— 否则在 closed-agent 之外的模式里，
  // 一条"已按 AI 请求禁言某人"的通知会因为目标不在白名单而被 sendChain 里的
  // assertSendAllowed 抛错吞掉（只剩一行日志），管理员永远收不到。
  /** 管理员私聊 key；未配置 ownerQQ 时返回 ''。 */
  function ownerNotifyKey() {
    return cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
  }

  /**
   * 给管理员发一条通知（成功返回 true）。
   *
   * 为什么不用 sendToQQ 的返回值判断成败：sendToQQ 返回的是**全局 sendChain**，
   * 它 resolve 只代表"排到队了"，不代表这一发成功（失败是在链里的 catch 里记
   * lastSendFailed 的）。这里要的是本地事实，所以用 bot.sendPrivateMessage 直发 +
   * withTimeout，成功即 true，失败只记日志、绝不抛 —— 通知发不出去不该让已经完成的
   * 群管理动作变成一次失败（那会让模型重试踢人）。
   */
  async function notifyOwnerGroupAdmin(note) {
    const ownerKey = ownerNotifyKey();
    if (!ownerKey) {
      log('[group-admin] 未配置 ownerQQ，无法通知管理员');
      return false;
    }
    try {
      if (!modeAllowed(ownerKey, 'private', Number(cfg.ownerQQ), cfg, currentMode)) {
        log(`[group-admin] 管理员私聊 ${ownerKey} 不在当前模式允许范围内，通知仅记日志`);
        appendActivity(`[group-admin] 管理员通知未能发出（${ownerKey} 不在允许范围）：${note}`);
        return false;
      }
    } catch (error) {
      log('[group-admin] 检查管理员通道失败：', errorText(error));
      return false;
    }
    try {
      await withTimeout(bot.sendPrivateMessage(Number(cfg.ownerQQ), text(note)), SEND_TIMEOUT_MS, `群管理通知 ${ownerKey}`);
      return true;
    } catch (error) {
      log(`[group-admin] 通知管理员失败：${errorText(error)}`);
      appendActivity(`[group-admin] 通知管理员失败：${errorText(error)}`);
      return false;
    }
  }

  /**
   * 发起一条「群管理高危动作」审批：私聊管理员「通过 / 拒绝」，同时把它登记进既有的
   * `pending` 挂起通道。
   *
   * 复用而不是新建机制的理由：回执链路（`handlePendingAnswer` 读 owner 的下一句话、
   * 匹配 APPROVE_WORDS / REJECT_WORDS、超时清理）已经写好了，新造一套只会多出两条
   * 互不一致的"回复通过"路径。所以这里只用 `kind:'group-admin'` 做一次登记 +
   * 私聊提问（详细处理见 handleGroupAdminApproval）。
   *
   * 超时**不执行**：一个 30 分钟前的踢人请求，参数里的 user_id 可能早就不该被踢了。
   */
  async function askGroupAdminApproval(key, entry) {
    const ownerKey = ownerNotifyKey();
    if (!ownerKey) {
      const e = new Error('该动作需要管理员审批，但 config.json 里没有配置 ownerQQ，无法发起审批 —— 拒绝执行');
      e.status = 403;
      throw e;
    }
    let resolveFn;
    let rejectFn;
    const decided = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    // 没人 await 这个 promise 时（超时/被新请求覆盖），它的 reject 不能变成
    // unhandledRejection 把进程打崩 —— 记一行日志就够了。
    decided.catch(() => {});
    const record = {
      kind: 'group-admin',
      key,
      entry,
      resolve: resolveFn,
      reject: rejectFn,
      timer: null,
      expiresAt: Date.now() + GROUP_ADMIN_APPROVAL_TTL_MS
    };
    record.timer = setTimeout(() => {
      // 注意顺序：先从 pending 里摘掉，再 reject —— 否则 adminRespondGroupAdmin 可能
      // 恰好在这中间被 owner 的回复触发，产生"已超时又执行了"的竞态。
      if (pending.get(key) !== record) return;
      pending.delete(key);
      rejectFn(new Error(`群管理审批超时（${Math.round(GROUP_ADMIN_APPROVAL_TTL_MS / 60000)} 分钟未回复），已取消：${entry.summary ?? entry.op}`));
    }, GROUP_ADMIN_APPROVAL_TTL_MS);
    if (typeof record.timer?.unref === 'function') record.timer.unref();
    await registerPending(key, record);
    const riskLabel = entry.risk === 'high' ? '高危' : entry.risk === 'medium' ? '中危' : '低危';
    await notifyOwnerGroupAdmin(
      `🔐 AI 请求执行群管理动作（${riskLabel}）：${entry.op}\n`
      + `对象：${entry.params?.userId ?? entry.params?.messageId ?? '—'}\n`
      + `详情：${entry.summary ?? ''}\n`
      + `参数：${JSON.stringify(entry.params ?? {})}\n`
      + `回复「通过」执行，回复「拒绝」取消（${Math.round(GROUP_ADMIN_APPROVAL_TTL_MS / 60000)} 分钟内未回复自动作废）`
    );
    auditGroupAdminPending(key, entry.op, entry.params, `已向管理员 ${ownerKey} 发起审批（来源：${entry.sourceLabel}）`);
    // ⚠️ 返回 `record` 而**不是** `decided`：这个函数是 async，`return decided` 会被
    // async 包装成一个"等决定"的 promise，调用方 `await askGroupAdminApproval(...)` 于是
    // 一直阻塞 —— 审批要么等管理员回复、要么等 30 分钟超时才 reject，**HTTP 请求会挂 30 分钟**
    // （MCP 工具则直接超时）。而真正的放行路径根本不经过这个 promise：它是
    // handlePendingAnswer → kind:'group-admin' → handleGroupAdminApproval 里读 `pending`
    // 表直接执行的（那里从头到尾没调用过 resolve/reject）。
    // 结果必须**立刻**返回"已发起审批"，等待是管理员那边的事。
    return record;
  }

  /**
   * 管理员对一条群管理审批的回复处理（由 handlePendingAnswer 的 `kind:'group-admin'` 分支调用）。
   *
   * 这里必须**先结清 pending、再执行**：`callGroupAdminGateway` 要真发一次网络请求，
   * 期间如果 owner 又回了一句"通过"，pending 里还挂着条目就会被二次处理成踢两次。
   * 先摘条目 = 幂等（同一个审批只会被执行一次）。
   */
  async function handleGroupAdminApproval(p, answerText, key) {
    clearTimeout(p.timer);
    pending.delete(key);
    const entry = p.entry ?? {};
    const text2 = String(answerText ?? '').trim().toLowerCase();
    const opWord = text2.split(/\s+/)[0] ?? '';
    if (REJECT_WORDS.has(opWord)) {
      sendToQQ(key, `❌ 已拒绝：${entry.op} ${JSON.stringify(entry.params ?? {})}`);
      appendActivity(`${key} [group-admin] 管理员拒绝了 ${entry.op} ${JSON.stringify(entry.params ?? {})}`);
      log(`[group-admin] ${key} 管理员拒绝 ${groupAdminOpText(entry)}`);
      return;
    }
    if (!APPROVE_WORDS.has(opWord)) {
      // 既不是通过也不是拒绝：**保留** pending 让管理员再说一次。
      // 这里不能 fall through 到执行，也不能静默丢弃审批。
      pending.set(key, p);
      if (p.timer) p.timer = setTimeout(() => {
        if (pending.get(key) !== p) return;
        pending.delete(key);
      }, Math.max(1000, Number(p.expiresAt ?? (Date.now() + GROUP_ADMIN_APPROVAL_TTL_MS)) - Date.now()));
      sendToQQ(key, `请回复「通过」执行 ${entry.op}，或回复「拒绝」取消`);
      return;
    }
    // 放行：用 approval:'owner' 重构造（buildGroupAdminAction 的 allowDangerous 只在这里为真）
    let built;
    try {
      const b = buildGroupAdminAction({ ...entry.params, op: entry.op, groupId: entry.params?.groupId, allowDangerous: true });
      if (!b.ok) throw new Error(b.error ?? '审批后重新校验失败');
      built = b;
    } catch (error) {
      sendToQQ(key, `⚠️ 审批已通过，但参数重新校验失败，未执行：${errorText(error)}`);
      log(`[group-admin] ${key} 审批通过但重建失败：${errorText(error)}`);
      return;
    }
    try {
      await callGroupAdminGateway(built.action, built.params);
      afterGroupAdmin(p.key ?? key, built);
      sendToQQ(key, `✅ 已执行：${built.op} → ${built.action} ${JSON.stringify(built.params)}`);
      log(`[group-admin] ${p.key ?? key} 管理员放行后已执行 ${groupAdminOpText(built)}`);
    } catch (error) {
      sendToQQ(key, `❌ 执行失败：${errorText(error)}`);
      log(`[group-admin] ${p.key ?? key} 经审批后执行失败：${errorText(error)}`);
      appendActivity(`${p.key ?? key} [group-admin] 经审批执行失败：${errorText(error)}`);
    }
  }


  /** 把待审批的群管理请求落成一条日志 + 一行活动记录（事后要能查出谁批了什么）。 */
  function auditGroupAdminPending(key, op, params, reason) {
    log(`[group-admin] ${key} 待审批 ${op} ${JSON.stringify(params)}：${reason}`);
    appendActivity(`${key} [group-admin] 待管理员审批：${op} ${JSON.stringify(params)}`);
  }

  /**
   * 做完了记账。
   *
   * `recordSelfMessageV2` 走的是"自己发的消息"路径：写进会话最近消息 + 历史归档，
   * 让 AI 下一轮知道"我刚才把一个成员移出群了/我删了那条消息"。
   * 不写这个的话，模型会反复做同一个动作（它以为没成功）。
   */
  function afterGroupAdmin(key, built, { dryRun = false } = {}) {
    const line = `[群管理] ${built.op} → ${built.action} ${JSON.stringify(built.params)}`;
    if (!dryRun) recordSelfMessageV2(key, line, null);
    appendActivity(`${key} ${line}`);
    return line;
  }

  /**
   * 走网关执行一个已构造好的动作。
   *
   * 群管理动作（set_group_kick / set_group_ban / delete_msg / set_friend_add_request /
   * set_group_add_request）在本仓库里是**直连网关**的（没有走 sendChain）：它们不是"发言"，
   * 不该被发送配额、发送间隔、静默期（captureSendGuard）影响 —— 一个已获管理员放行的
   * 踢人动作不该因为"刚刚发过言"而被 5 秒的发送节流拖住或被静默期拦掉。
   */
  async function callGroupAdminGateway(action, params) {
    const res = await withTimeout(bot.request(action, params), SEND_TIMEOUT_MS, `群管理 ${action}`);
    const retcode = res?.retcode;
    if (res?.status && res.status !== 'ok' && res.status !== 'async') {
      throw new Error(`OneBot ${action} 失败：${res.status}${res.message ? ` ${res.message}` : ''}${retcode != null ? ` (retcode ${retcode})` : ''}`);
    }
    if (retcode != null && Number(retcode) !== 0) {
      throw new Error(`OneBot ${action} 失败：retcode ${retcode}${res?.message ? ` ${res.message}` : ''}`);
    }
    return res;
  }

  /**
   * 群管理主流程（AI 通道与操作者通道共用）。
   *
   * 返回 `{ ok:true, dryRun?..., action, params, risk, summary, warnings? }`；
   * 需要审批时返回 `{ ok:false, needApproval:true, error, op, params }`（HTTP 层记 403）；
   * 参数不合法一律抛 `error.status = 400`。
   */
  async function performGroupAdmin(key, body, { operator = false, sourceLabel = '' } = {}) {
    // 操作者通道的目标参数叫 target（与 /api/media/send-music 一致），消息里的 groupId
    // 才是"作用对象"。两条通道取 groupId 的来源不同是**有意**的：AI 的群号来自会话 key
    // （不可信输入里最可信的那个），操作者的群号来自显式 target + 白名单。
    const targetKey = String(body.target ?? body.key ?? key ?? '').trim();
    const gc = cfg.socialV2?.groupAdmin ?? {};
    if (gc.enabled === false && !operator) {
      // 与音乐/发图同一条纪律：出厂默认关，且**操作者通道不受工具开关限制**
      // （否则关掉之后连管理员自己都没法用；控制台令牌本身就是管理员身份）。
      const e = new Error('群管理已关闭（socialV2.groupAdmin.enabled=false）');
      e.status = 403;
      throw e;
    }
    const op = String(body.op ?? '').trim();

    // 两条通道都要先能推导出 groupId：
    //   · AI 通道：由**会话 key** 推导并使用（不采信 body.groupId —— 否则模型可以操作别的群）。
    //     端点已经先做过一致性检查，到这里 body 的 groupId 一定等于 key 里的群号或为空。
    //   · 操作者通道：**只在没给 groupId 时**由 target 兜底。控制台上选的是"要管理哪个群"，
    //     再让人把群号抄一遍没有意义；但显式给出的值优先，便于（未来）一个令牌管多个群。
    //
    // 顺序不能颠倒：先推导再判形状。反过来的话，操作者通道的 deleteMsg（只给 key/target）
    // 会因为"groupId 没填"被判 400 —— 而调用方明明已经把群写在 target 里了。
    // 同时这也保证了真正该 400 的场景仍然 400：`{op:'kick'}` 什么都不给时，
    // 推导不出来 → groupId 为空 → 形状检查如实报 400。
    let paramsIn = { ...body };
    let synthesizedGroupId = '';
    if (!operator) {
      // AI 通道：会话 key 是唯一可信的群号来源，**有条件地**注入 ——
      //   · body 里已经写了 groupId（端点已核对过与本会话一致）：保留原值，这样
      //     assertGroupAdminShape 看到的仍是"调用方自己写的参数"，
      //     `{op:'kick', userId:'999'}` 这种漏写群号的情况才会被它判成 400，
      //     而不是被我们偷偷补上群号后当成"合法参数"送进审批闸门（那就永远报不出 400 了）。
      //   · body 里没写：由 key 补齐，让 deleteMsg 这类低危动作不必重复抄群号。
      const explicit = String(body.groupId ?? '').trim();
      const m = /^group:(\d+)$/.exec(targetKey);
      if (m) {
        synthesizedGroupId = m[1];
        if (!explicit) paramsIn = { ...paramsIn, groupId: m[1] };
      }
    } else if (!String(paramsIn.groupId ?? '').trim()) {
      const m = /^group:(\d+)$/.exec(targetKey);
      if (m) { synthesizedGroupId = m[1]; paramsIn = { ...paramsIn, groupId: m[1] }; }
    }

    // 形状检查先于审批闸门：见 assertGroupAdminShape 的注释（否则 kick 缺 groupId 会变成"需要审批"）。
    // 高危动作要求**调用方显式**写出 groupId（见该函数里的注释），所以这里把推导值单独传进去
    // 由它自己决定要不要采信；低/中危则允许用推导值兜底。
    //
    // ⚠️ 这个"显式"要求**只对操作者通道成立**，AI 通道一律允许用会话 key 推出的群号：
    //   · AI 的作用域本来就锁死在它自己那个 key（端点已核对过 body.groupId === key 里的群号），
    //     不存在"踢错群"的可能 —— 要求它显式抄一遍群号只是纯粹的摩擦；
    //   · 而 `qq_group_admin` 这个 MCP 工具**根本不暴露 groupId 参数**（模型没这个字段可填），
    //     于是 `op:'kick'` 永远过不了形状检查、只会得到 400「groupId 必须是正整数（群号）」，
    //     而**不是**设计中的"需要管理员审批"。实测就是这个症状：群管理看起来"完全用不了"，
    //     连走上审批的机会都没有（ban/deleteMsg 等低中危反而正常，所以更像"只有踢人坏了"）。
    const opIsDangerous = GROUP_ADMIN_DANGEROUS_OPS.has(op);
    const ownGroupId = String(body.groupId ?? '').trim();
    assertGroupAdminShape(op, paramsIn, {
      requireGroupId: operator && opIsDangerous && !ownGroupId,
      synthesizedGroupId,
      explicitGroupId: ownGroupId
    });

    const risk = GROUP_ADMIN_RISK[op] ?? 'low';
    const dryRun = body.dryRun === true;

    // ① 高危：必须管理员放行
    if (GROUP_ADMIN_DANGEROUS_OPS.has(op)) {
      if (operator && body.allowDangerous === true) {
        const built = groupAdminParamsFor(op, paramsIn, { approval: 'owner' });
        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            op: built.op,
            action: built.action,
            params: built.params,
            risk: built.risk,
            summary: built.summary
          };
        }
        await callGroupAdminGateway(built.action, built.params);
        const line = afterGroupAdmin(key, built);
        log(`[group-admin] ${key} 执行（操作者已放行）${line}`);
        return { ok: true, op: built.op, action: built.action, params: built.params, risk: built.risk, summary: built.summary, executed: true };
      }
      // 未放行：登记挂起审批，**一个字节都不要发给网关**。
      // 用 requiresOwnerApproval 而不是硬编码 op==='kick'：以后 group-admin.js 把别的动作
      // 升成 high 时，这里自动跟着走。
      //
      // ⚠️ 这里必须用 `approval: 'pending'` 而不是 `'none'`：`'none'` 会让
      // buildGroupAdminAction 直接返回 needApproval（它以为调用方想立刻执行），
      // groupAdminParamsFor 于是抛错、**审批登记不上** —— 管理员收不到任何消息，
      // 模型只得到一句"必须由管理员显式放行后才执行"，看起来就是"群管理根本用不了"。
      // `'pending'` 只解开"允许构造参数"这一步，真正的执行仍然要等管理员回「通过」
      // （见 handleGroupAdminApproval 用 approval:'owner' 重构造后才 callGroupAdminGateway）。
      const built = groupAdminParamsFor(op, paramsIn, { approval: 'pending' });
      // dryRun 只预览：**不登记审批、不通知管理员**。否则"只校验一下参数"会真的在
      // owner 私聊里堆一条待审批、模型还得等一个永远不该来的回复（实测：探测 kick 的
      // dryRun 会把审批挂在 pending 里，30 分钟后才超时）。
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          needApproval: true,          // 参数没问题，但真要执行仍需管理员放行
          op: built.op,
          action: built.action,
          params: built.params,
          risk: built.risk,
          summary: built.summary,
          error: `「${built.op}」是高危操作（${built.summary}），需要管理员放行；dryRun 只校验参数，没有发起审批。`
        };
      }
      const entry = {
        kind: 'group-admin',
        key,
        op: built.op,
        params: built.params,
        action: built.action,
        risk: built.risk,
        summary: built.summary,
        requestedAt: Date.now(),
        sourceLabel: sourceLabel || (operator ? '操作者' : 'AI')
      };
      await askGroupAdminApproval(key, entry);
      return {
        ok: false,
        needApproval: true,
        op: built.op,
        params: built.params,
        risk: built.risk,
        // 文案必须同时说清"为什么被拦"和"怎么放行"，否则模型只会看到一句莫名其妙的 403。
        error: `「${built.op}」是高危操作（${built.summary}），已向管理员发起审批；管理员回复「通过」后才会真正执行，回复「拒绝」或 ${Math.round(GROUP_ADMIN_APPROVAL_TTL_MS / 60000)} 分钟未回复即作废。`
      };
    }

    // ② ban：中危。**不再要求管理员确认**（用户 2026-10 的决定：允许机器人自主禁言、
    // 时长由它自己按语境选）。保留的只有：
    //   - group-admin.js 的参数校验（时长必须是 1..2592000 的整数秒，0/负数/小数/超限一律拒）；
    //   - 执行后给 owner 留一条通知 + 活动日志 —— 是**事后可见**，不是事前批准（可用
    //     socialV2.groupAdmin.notifyOwnerOnBan=false 关掉通知）。
    // 高危的 kick 仍然必须走管理员审批（上面 ① 分支）。
    if (op === 'ban') {
      const built = groupAdminParamsFor(op, paramsIn, { approval: 'none' });
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          op: built.op,
          action: built.action,
          params: built.params,
          risk: built.risk,
          summary: built.summary,
          notifyOwner: gc.notifyOwnerOnBan !== false
        };
      }
      await callGroupAdminGateway(built.action, built.params);
      afterGroupAdmin(key, built);
      // 只有 AI 通道才需要"告诉操作者"：操作者自己刚做的就是这件事，回头再给他发一条
      // 私聊通知纯属噪音（而且如果 ownerQQ 恰好是当前会话，还会把 AI 拉起来自言自语）。
      const notified = (!operator && gc.notifyOwnerOnBan !== false)
        ? await notifyOwnerGroupAdmin(key, `🔨 已按 AI 请求禁言：${built.summary}\n参数：${JSON.stringify(built.params)}`)
        : false;
      log(`[group-admin] ${key} 执行 ban ${JSON.stringify(built.params)}（通知管理员：${notified ? '已发' : '未发'}）`);
      return {
        ok: true,
        op: built.op,
        action: built.action,
        params: built.params,
        risk: built.risk,
        summary: built.summary,
        executed: true,
        notifiedOwner: notified
      };
    }

    // ③ 低危：直接执行（但仍要 dryRun 尊重）
    const built = groupAdminParamsFor(op, paramsIn, { approval: 'none' });
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        op: built.op,
        action: built.action,
        params: built.params,
        risk: built.risk,
        summary: built.summary
      };
    }
    await callGroupAdminGateway(built.action, built.params);
    const line = afterGroupAdmin(key, built);
    // 处理完申请要把那条申请从待办里拿掉，否则它会一直留在 qq_list_requests 里，
    // AI 每轮都看到同一个"还没处理"的申请，于是反复处理。
    if (built.op === 'approveFriend' || built.op === 'approveGroup') {
      removePendingRequestByFlag(key, String(paramsIn.flag ?? '').trim());
    }
    log(`[group-admin] ${key} 执行 ${line}`);
    return {
      ok: true,
      op: built.op,
      action: built.action,
      params: built.params,
      risk: built.risk,
      summary: built.summary,
      executed: true
    };
  }

  // ── 好友 / 入群申请（bot.onRequest）────────────────────────────────────────
  //
  // 为什么单独做个待办列表，而不是"收到申请就直接让模型处理"：
  //   申请事件（post_type:'request'）是**带 flag 的一次性凭据**，而处理它需要一次
  //   「批准/拒绝」的往返。直接触发一次唤醒会让模型在没有上下文（谁申请的、申请几次了）
  //   的情况下做决定；而且 flag 只在很短的时间内有效，唤醒+首字延迟很容易错过。
  //   所以这里只做两件事：把申请**记下来**（有界、落盘、进消息流），以及**通知管理员**。
  //   真正的处置是模型（或管理员）在之后的某一轮里显式调 qq_group_admin
  //   （op:'approveFriend' / 'approveGroup'，带 flag）—— 那一步才调网关。
  //
  // 哪些申请会进这个列表：只收**能对应到一个会话 key** 的。
  //   · request.group / invite → 群 key group:<group_id>
  //   · request.friend        → 私聊 key private:<user_id>
  //   对不上就不记（宁可少记一条，也不要往一个凭空造出来的会话里写状态）。
  //
  // 去重：同一个 flag 只留一条。SnowLuma / OneBot 在重连后**会重放**申请事件，
  // 不去重的话一次申请能在待办里堆成十条，模型会以为有十个人在申请。
  function pendingRequestView(rec) {
    return {
      flag: rec.flag,
      type: rec.type,
      subType: rec.subType ?? null,
      userId: rec.userId ?? null,
      userName: rec.userName ?? '',
      groupId: rec.groupId ?? null,
      groupName: rec.groupName ?? '',
      comment: rec.comment ?? '',
      at: rec.at,
      ageText: rec.at ? humanDelta(Date.now() - rec.at) : ''
    };
  }

  function addPendingRequest(key, rec) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingRequests)) st.pendingRequests = [];
    const idx = st.pendingRequests.findIndex((r) => r && r.flag === rec.flag);
    if (idx >= 0) st.pendingRequests[idx] = { ...st.pendingRequests[idx], ...rec };
    else st.pendingRequests.push(rec);
    if (st.pendingRequests.length > GROUP_ADMIN_REQUEST_LIMIT) {
      st.pendingRequests.splice(0, st.pendingRequests.length - GROUP_ADMIN_REQUEST_LIMIT);
    }
    saveSocialV2State();
  }

  function removePendingRequestByFlag(key, flag) {
    if (!flag) return false;
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingRequests)) return false;
    const before = st.pendingRequests.length;
    st.pendingRequests = st.pendingRequests.filter((r) => !r || r.flag !== flag);
    if (st.pendingRequests.length !== before) {
      saveSocialV2State();
      return true;
    }
    return false;
  }

  function listPendingRequests(key) {
    const st = getSocialV2State(key);
    return (Array.isArray(st.pendingRequests) ? st.pendingRequests : []).map(pendingRequestView);
  }

  /**
   * 处理一个好友 / 入群申请事件。
   *
   * 全程 try/catch：这里跑在事件回调里，抛出去会打断 handleIncoming 的调用栈
   * （申请事件与消息事件共用同一条 WS 回调链），一条读不出 group_id 的脏事件
   * 不该让整个会话的消息处理停摆。
   */
  async function handleRequestEvent(event) {
    const requestType = String(event?.request_type ?? '');
    const flag = String(event?.flag ?? '').trim();
    if (!flag) return;
    const userId = event?.user_id != null ? String(event.user_id) : '';
    const groupId = event?.group_id != null ? String(event.group_id) : '';
    let key = '';
    let type = '';
    if (requestType === 'group') {
      if (!groupId) return;
      key = `group:${groupId}`;
      type = 'group';
    } else if (requestType === 'friend') {
      if (!userId) return;
      key = `private:${userId}`;
      type = 'friend';
    } else {
      // 其它 request_type（未来 OneBot 扩展）不猜语义，只记一行日志。
      log(`[group-admin] 收到未处理的申请类型 request_type=${requestType}，已忽略`);
      return;
    }
    const canonical = canonicalV2Key(key);
    if (!canonical) return;
    key = canonical;
    const subType = event?.sub_type != null ? String(event.sub_type) : '';
    const comment = String(event?.comment ?? '').slice(0, 200);
    let userName = '';
    try {
      userName = String(event?.sender?.nickname ?? event?.sender?.card ?? '');
    } catch { userName = ''; }
    const rec = {
      flag,
      type,
      subType: subType || null,
      userId: userId || null,
      userName,
      groupId: groupId || null,
      groupName: '',
      comment,
      at: Date.now()
    };
    addPendingRequest(key, rec);
    // 进消息流：让**下一轮唤醒**的模型看到"有人在申请加群/加好友"这件事。
    // 不加这一步，申请只存在于结构化 state 里，模型不主动调 qq_list_requests 就永远
    // 不知道有人在外面等 —— 而它没有任何理由主动去调。
    const who = userName ? `${userName}(${userId || '—'})` : (userId || '—');
    const groupBit = groupId ? ` 群 ${groupId}` : '';
    const subBit = subType ? `（${subType}）` : '';
    const line = type === 'friend'
      ? `【好友申请】${who} 请求加好友${comment ? `，附言：${comment}` : ''}（flag=${flag}）`
      : `【入群申请】${who} 申请加入本群${subBit}${comment ? `，附言：${comment}` : ''}（flag=${flag}）`;
    appendSocialV2Message(key, '系统', line, line, false, false, null);
    appendActivity(`${key} [group-admin] 收到${type === 'friend' ? '好友' : '入群'}申请：${who}${groupBit}`);
    log(`[group-admin] ${key} 收到申请 flag=${flag} user=${userId || '—'} sub=${subType || '—'}`);
    // 通知管理员（私聊）。注意：**不在这里自动执行批准**，也不把它当成"需要立刻唤醒 AI"
    // 的信号 —— 那是管理员的决定。
    await notifyOwnerGroupAdmin(
      `📩 ${type === 'friend' ? '好友申请' : '入群申请'}：${who}${groupBit}${subBit}`
      + `${comment ? `\n附言：${comment}` : ''}\n`
      + `让 AI 处理：告诉它「处理这个申请」，它会用 qq_list_requests 看详情、再 qq_group_admin 批准或拒绝。`
    );
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析）。QQ 没有"直接发收藏表情"的 OneBot 段，
  // 实际走的是 image + sub_type=1（PicElement 的 bizType/subType 表情标记）：客户端见到这个
  // 标记才按表情尺寸渲染；不带标记就是一张普通图片，1224×1224 的表情会把半个屏幕顶满。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${errorText(error)}`);
    }
    // 标成「表情」（OneBot image.sub_type=1，落在 QQ 的 PicElement subType/bizType 上）：
    // 不带这个标记，QQ 就把表情当普通图片铺开（1224×1224 的表情会顶满半个屏幕）；
    // 带上之后客户端按表情尺寸渲染，和手点收藏表情发出去的一样。
    const stickerSummary = String(entry.desc || entry.localNote || '').trim();
    segments.push({
      type: 'image',
      data: {
        file: 'base64://' + image.buffer.toString('base64'),
        sub_type: 1,
        ...(stickerSummary ? { summary: stickerSummary } : {})
      }
    });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', errorText(error)); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', errorText(error)));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    // 学习会话是**长期复用**的：每一轮黑话考究都要把之前的整个转录重新带上。曾经复用到第 8 轮时
    // 模型直接回 `context length has exceeded the maximum limit (code=4026)`，那一轮就废了；
    // 更糟的是错误文案里带「会话」二字，被下游的失效守卫误判成「会话坏了」→ 删掉记录另建一个，
    // 于是每失败一次就白扔一个 DSH 会话（实测残留 9 个）。这里改成按轮数主动换干净会话。
    const maxLearnerTurns = Math.max(2, Number(cfg.slang?.maxLearnerTurns) || 6);
    if (slangLearnerSessionId && slangLearnerTurns >= maxLearnerTurns) {
      log(`黑话学习会话已跑完 ${slangLearnerTurns} 轮，主动换一个干净会话（避免上下文超限）`);
      invalidateSlangLearnerSession();
    }
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    slangLearnerTurns = 0;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  // 学习会话的 turn 超时。原来写死 120s：黑话考究要跑多轮 web_search + web_fetch（提示词明确
  // 要求"点开最相关的 1~2 个结果看正文"），经常 2 分钟还没结束，于是每次都以
  // `黑话研究失败: 等待学习会话 turn 超时(120000ms)` 收场，研究结果永远落不了地。
  // 改成可配（默认 300s），并允许用 config.slang.researchTimeoutMs 覆盖。
  function waitLearnerTurn(sessionId, timeoutMs = Math.max(60000, Number(cfg?.slang?.researchTimeoutMs) || 300000)) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        // 超时的这个任务已经放弃了，但它的收集器还挂在 learnerCollectors 上：
        // 迟到的 turn/end 会被 push 出结果，然后按 FIFO 结算给**下一个**任务
        // （研究和提取互相串号，把别人的转录当成自己的答案）。所以超时即丢弃收集器。
        learnerCollectors.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  // 判定错误是否表示「学习会话真的没了」。必须先排除超时：waitLearnerTurn 超时抛出的
  // `等待学习会话 turn 超时(300000ms)` 里也带「会话」二字，曾被当成会话坏了 → 每次超时都
  // 白扔一个健康的学习会话（见 ensureSlangLearnerSession 里记录的那次事故：实测残留 9 个会话）。
  function isSlangSessionGoneError(error) {
    const msg = String(errorText(error) ?? '');
    if (/超时|timed?\s*out/i.test(msg)) return false;
    return /会话|session|not found|404/i.test(msg);
  }

  // 提取结束后，把「本次已送进提取的消息」从窗口里摘掉。必须按 seq 切、不能按快照长度切：
  // await 期间 feedSlangWindow 还在往里 push，并且窗口触顶时
  // `win.splice(0, win.length - cap)` 会把旧条目挤掉、索引整体前移 —— 按快照长度做前缀时，
  // 满窗下 `win.slice(cap)` 恒为空，刚到的消息会被整段丢弃，窗口反复清零。
  function dropSlangWindowMessages(key, messages) {
    let lastSeq = 0;
    for (const m of messages) {
      const s = Number(m?.seq) || 0;
      if (s > lastSeq) lastSeq = s;
    }
    const win = slangWindows.get(key) ?? [];
    slangWindows.set(key, win.filter((m) => (Number(m?.seq) || 0) > lastSeq));
    saveSlangWindowsSoon();
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, errorText(error));
      return;
    }

    // 主人 m01652：「黑话还是要在群聊里选出现次数多的词」。
    // 做法：先把这一窗消息的**本地词频**算出来喂给学习会话（它不用猜哪些是高频词），
    // 再给每个候选算一个 groupCount（= 这个词出现在多少条群消息里），窗口里出现
    // 不足 minGroupCount 次的**新词**直接不收 —— 一次性的用词不配进黑话库。
    const frequentTerms = topRepeatedTerms(messages, { limit: 40, minCount: 2 });
    const minGroupCount = Math.max(1, Number(cfg.slang?.minGroupCount) || 2);
    const promptText = buildExtractionPrompt(messages, { frequentTerms, minGroupCount });
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        dropSlangWindowMessages(key, messages);
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      // 门槛与复核都在 selectExtractionItems（纯函数，自检见 scripts/test-slang-frequency.mjs）：
      // 库里已有的词照旧更新，新词必须"群里反复出现过"。
      const { accepted: keptItems, skipped } = selectExtractionItems(items, messages, {
        minGroupCount,
        known: new Set(slangEntries.map((e) => e.content)),
      });
      for (const item of keptItems) {
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const existing = slangEntries.find((e) => e.content === item.content) ?? null;
        const result = upsertSlangEntry(slangEntries, item.content, {
          evidence,
          countIncrement: 1,
          groupCount: Math.max(Number(existing?.groupCount) || 0, item.groupCount),
        });
        if (result.created) added += 1; else updated += 1;
        // 研究门槛用 heat = max(count, groupCount)：count 是"被提取批次命中过几次"，
        // groupCount 是群聊真实热度 —— 群安静、批次少的时候，只靠 count 永远到不了 [2,4,8]。
        const heat = Math.max(Number(result.entry?.count) || 0, Number(result.entry?.groupCount) || 0);
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(heat) && heat > (Number(result.entry.lastInferenceCount) || 0)) {
          researchCandidates.push(result.entry);
        }
      }
      dropSlangWindowMessages(key, messages);
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条${skipped.length ? `，跳过 ${skipped.length} 条（窗口里出现不足 ${minGroupCount} 次：${skipped.slice(0, 6).map((s) => s.content).join('、')}）` : ''}`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (isSlangSessionGoneError(error)) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, errorText(error));
    }
  }

  // 把研究结果对回库里的词条。模型经常把名字改写：库里是「飞八分钱（张顺飞梗）」，
  // 它回「飞八分钱」；库里带空格/标点，它回干净版。旧实现要求 `e.content === r.content`
  // 严格相等，对不上就 `continue` **静默丢弃**（日志仍按模型返回条数报"已更新 N 条"）——
  // 实测 `烧心` / `飞八分钱` 的 `research` 字段一直都是 null，就是这个原因。
  function normalizeSlangKey(s) {
    return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }
  function findSlangEntryByContent(content) {
    const target = normalizeSlangKey(content);
    if (!target) return null;
    const exact = slangEntries.find((e) => normalizeSlangKey(e.content) === target);
    if (exact) return exact;
    // 别名兜底：互相包含，且**较短的一侧至少 2 个字**（否则「梗」这种单字会把整个库串起来）。
    return slangEntries.find((e) => {
      const c = normalizeSlangKey(e.content);
      if (c.length < 2 || target.length < 2) return false;
      return c.includes(target) || target.includes(c);
    }) ?? null;
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', errorText(error));
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      let applied = 0;
      const unmatched = [];
      for (const r of results) {
        const entry = findSlangEntryByContent(r.content);
        if (!entry) {
          unmatched.push(String(r.content ?? ''));
          continue;
        }
        // 未明确确认（confirmed !== true）的结果**也存成草稿**。
        // 以前这里直接 continue 丢掉，导致候选条目只有词、没有含义：控制台点「批量确认（有含义）」
        // 会被服务端以"缺少含义"跳过 —— 用户看到的就是"DSH 明明研究出结果了，我却在控制台确认不了"。
        // 草稿安全：注入给群里的黑话表只取 status === confirmed 的条目（见 confirmedSlangListV2），
        // 所以候选里带解释不会污染实际对话；同时用 entry.research.verified 标出「AI 考究过但没把握」。
        const isDraft = r.confirmed !== true;
        const fill = (key) => {
          // 草稿只填空位，避免把已有内容（可能是人工写的）覆盖掉；已确认结果允许覆盖更新。
          if (!r[key]) return;
          if (isDraft && entry[key]) return;
          entry[key] = r[key];
        };
        fill('meaning');
        fill('usage');
        fill('example');
        fill('risk');
        if (Array.isArray(r.sources) && r.sources.length && !(isDraft && Array.isArray(entry.sources) && entry.sources.length)) {
          entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        }
        entry.research = { verified: !isDraft, at: new Date().toISOString() };
        if (isDraft) log(`黑话研究：${entry.content} 未确认，已存草稿（含义/来源写入候选，可在控制台确认或再研究）`);
        // 门槛跟着"热度"走（见 runSlangExtraction 的 heat）：只记 count 会让群聊出现次数
        // 达标（groupCount ≥ 2）的候选每轮被重复排队研究一次。
        entry.lastInferenceCount = Math.max(Number(entry.count) || 0, Number(entry.groupCount) || 0);
        entry.updatedAt = new Date().toISOString();
        applied += 1;
      }
      saveSlangStore();
      if (applied) {
        log(`黑话研究：已更新 ${applied} 条候选解释（模型返回 ${results.length} 条）`);
      } else if (unmatched.length) {
        log(`黑话研究：模型返回 ${unmatched.length} 条，但没有一条能对上库里现有词条（${unmatched.slice(0, 8).join('、')}），未写入`);
      } else {
        log('黑话研究：模型没有返回可解析的结果');
      }
    } catch (error) {
      if (isSlangSessionGoneError(error)) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', errorText(error));
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  /** 某个词在所有**群**聊天窗口里出现在多少条消息中（主人 m01652：黑话只学群里高频的词）。
   *  只统计 group: 键 —— 私聊里教她的词不算群黑话，这也是她上次把私聊梗当群黑话提交的纠正点。 */
  function slangGroupHitCount(content) {
    let hits = 0;
    for (const [k, win] of slangWindows.entries()) {
      if (!k.startsWith('group:')) continue;
      hits += countTermOccurrences(win, content);
    }
    return hits;
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    // 冷却改成任务真正开始时才记账：以前在排队前就记账，任务若随后因 DSH 未就绪、
    // 学习会话创建失败等原因空跑，也会白白吃满 5 分钟冷却，静默降低学习频率。
    queueSlangTask(async () => {
      if (!dshReady) return;
      const cd = Number(cfg.slang?.extractCooldownMs ?? 300000);
      // 排队期间可能又排了一次（窗口也没清），这里再按冷却兜一次，避免同一份素材重复提取。
      if (Date.now() - (slangExtractionCooldowns.get(key) ?? 0) < cd) return;
      slangExtractionCooldowns.set(key, Date.now());
      await runSlangExtraction(key);
    });
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  // （slangWindowSeq / 窗口落盘与恢复见上方 slangWindows 附近的说明。）
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    slangWindowSeq += 1;
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now(), seq: slangWindowSeq });
    // 上限从写死的 80 提到配置项 slang.windowMax（默认 200）：窗口现在跨重启保留，
    // 便宜的多留一点素材，安静群也能慢慢攒到提取门槛。
    const cap = slangWindowMax();
    if (win.length > cap) win.splice(0, win.length - cap);
    saveSlangWindowsSoon();
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // ── DSH 端点自动发现 ──────────────────────────────────────────────────────
  //
  // 为什么需要（真实故障）：DSH 桌面版用 --port 0 启动，端口由系统分配、**每次重启都变**；
  // 而 config.json 的 dsh.baseUrl 是钉死的（19387）。端口一搬家，桥接就每 3 秒拨一个没人
  // 听的端口。更糟的是这个失败**完全没有报错**：WebSocket 在 open 之前被拒 → dsh-client
  // 的生成器正常 return（不是 throw）→ pumpMux 的 catch 不触发 → 日志里只剩一行行
  // 「连接 DSH 事件流…」，看起来像是在连。
  //
  // 这里改成：连之前先「确认端点」。发现顺序见 dsh-discovery.js —— 环境变量 → config →
  // 上次验证过的缓存（都便宜，端口没变时 4ms）→ 本机监听表（netstat + 身份校验，换端口时
  // 约 1.7s）。发现到的地址只影响运行时，**不改写 config.json**（那是用户手写的文件，程序
  // 不该覆盖它）；跨重启的记忆放在 state/dsh-endpoint.json。
  const DSH_ENDPOINT_STATE = path.join(STATE_DIR, 'dsh-endpoint.json');
  const dshEndpoint = {
    baseUrl: api.baseUrl,
    source: 'config',
    authOk: null,
    discoveredAt: 0,
    lastAttemptAt: 0,
    attempts: 0,
    lastError: ''
  };
  let dshEndpointPending = null;

  function cookieForBaseUrl(baseUrl) {
    // 只在「已经确认是 DSH 」之后用它复验鉴权；发现阶段不带 Cookie（见 dsh-discovery.js）。
    try {
      return mintBrowserSessionCookie(baseUrl, readBrowserSessionSecret()) ?? '';
    } catch {
      return '';
    }
  }

  /** 确保 api.baseUrl 指向当前真正在跑的 DSH；返回是否发生了切换。 */
  async function ensureDshEndpoint({ reason = '', force = false } = {}) {
    if (cfg.dsh.followDiscoveredEndpoint === false) return false;
    const now = Date.now();
    // 健康检查 5 秒一次、事件流 3 秒一轮：节流，别把 netstat 当心跳跑。
    if (!force && now - dshEndpoint.lastAttemptAt < 10000) return false;
    if (dshEndpointPending) return dshEndpointPending;
    dshEndpointPending = (async () => {
      dshEndpoint.lastAttemptAt = Date.now();
      dshEndpoint.attempts += 1;
      let found = null;
      try {
        found = await discoverDshEndpoint({
          current: api.baseUrl,
          stateFile: DSH_ENDPOINT_STATE,
          cookieFor: cookieForBaseUrl,
          log: (message) => log(message)
        });
      } catch (error) {
        dshEndpoint.lastError = String(errorText(error));
        log('⚠️ DSH 端点发现失败：' + dshEndpoint.lastError);
        return false;
      }
      if (!found) {
        dshEndpoint.lastError = '候选中没有 DSH';
        return false;
      }
      dshEndpoint.lastError = '';
      dshEndpoint.authOk = found.authOk;
      dshEndpoint.source = found.source;
      dshEndpoint.discoveredAt = Date.now();
      const previous = api.baseUrl;
      dshEndpoint.baseUrl = found.baseUrl;
      if (found.baseUrl === previous) return false;
      api.baseUrl = found.baseUrl;
      // 端口变了 ⇒ authority 变了 ⇒ 旧 Cookie 与 launch token 都要重来。
      try { api.invalidateAuth(); } catch {}
      log('🔎 DSH 端点已切到 ' + found.baseUrl + '（原 ' + previous + '，来源 ' + found.source +
        '，鉴权 ' + (found.authOk ? '正常' : '未确认') + (reason ? '，触发：' + reason : '') + '）');
      return true;
    })().finally(() => { dshEndpointPending = null; });
    return dshEndpointPending;
  }

  // dsh-client 在「WS 还没 open 就结束」时走这条回调。以前这里一声不吭 ——
  // 正是那个「永远在连、永远不报错」的死循环的另一半原因。
  api.onStreamFailure = (info) => {
    log('⚠️ DSH 事件流未建立（' + info.reason + (info.message ? '：' + info.message : '') + '）目标 ' + info.url);
  };

  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(errorText(error));
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  // ── 回合健康度（看门狗 / 上下文预算）──────────────────────────────────────
  // 这里全部只放内存：DSH 重启后回合本来就不存在了，把旧痕迹捞回来只会让新回合被判成"卡死"。
  const turnActivityAt = new Map(); // sessionId -> 最近一次收到该会话事件的时间
  const longWaitUntil = new Map(); // sessionId -> 长轮询工具预计返回的时间（期间不算卡死）
  const sessionPromptTokens = new Map(); // sessionId -> { at, tokens } 最近一步的提示词规模
  const pendingWakeSince = new Map(); // key -> 进入 pendingWakeKeys 的时间
  const contextResetAt = new Map(); // key -> 上次因上下文超限重开会话的时间（防抖）
  const lastTurnPromptTokens = new Map(); // key -> 上一回合的提示词规模（/api/status 与日志用）
  /**
   * 待审批的高危群管理动作 —— key -> 最近一条挂起请求。
   *
   * 刻意**只放内存不进 state/*.json**：kick 这类动作的有效期只有"这几秒"。进程重启后
   * 把几分钟前的踢人请求捞回来执行，比丢掉它危险得多（那时上下文早变了，管理员也不在屏幕前）。
   * 因此重启即作废，需要重新发起。
   */
  const pendingGroupAdmin = new Map();
  /** 挂起审批的有效期：超时即失效，防止"很久以前点过一次"变成现在的执行许可。 */
  const PENDING_GROUP_ADMIN_TTL_MS = 10 * 60 * 1000;
  /** 单条挂起申请的只读视图（给 MCP 工具 / 控制台展示，不含函数引用）。 */
  function groupAdminPendingView(key, entry) {
    // 两种形状都要吃得下：
    //   · 直接传 approval entry（`{op, params, action, risk, summary, requestedAt}`）；
    //   · 传 `pending` 表里的**包装记录**（`{kind:'group-admin', key, entry, resolve, reject, timer, expiresAt}`）。
    //     第二个漏了的话，模型看到的每条挂起审批都是 `op:null / params:null / summary:null`
    //     —— 它根本不知道自己提交的是什么、也没法向群友解释在等什么（实测就是这个症状）。
    const e = (entry && entry.entry) ? entry.entry : (entry ?? {});
    return {
      key,
      op: e.op ?? null,
      action: e.action ?? null,
      params: e.params ?? null,
      risk: e.risk ?? null,
      summary: e.summary ?? null,
      requestedAt: e.requestedAt ?? null,
      expiresAt: entry?.expiresAt ?? e.expiresAt ?? null,
      ageText: e.requestedAt ? humanDelta(Date.now() - e.requestedAt) : null,
      reason: e.reason ?? null
    };
  }
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  // ── 每日额度：今天的用量从账本的逐桶序列里现算 ────────────────────────────
  // 账本 series() 每次调用都要重建索引，而唤醒提示词可能一天拼几百次，
  // 所以这里缓存 60s：额度是「护栏」，晚一分钟知道无所谓，别为它拖慢每条回复。
  let budgetUsageCache = { at: 0, usage: { cost: 0, tokens: 0 } };
  function budgetUsageToday(now = Date.now()) {
    if (now - budgetUsageCache.at < 60 * 1000) return budgetUsageCache.usage;
    try {
      const series = tokenLedger.series({ hours: 26, maxBuckets: 26, at: now });
      const usage = sumSeriesSince(series?.buckets, localDayStart(now));
      budgetUsageCache = { at: now, usage };
      return usage;
    } catch (error) {
      log('[budget] 读取今日用量失败，按 0 处理：' + errorText(error));
      return budgetUsageCache.usage;
    }
  }

  /** 今日额度判定；80% 提醒每天只落一次盘、只记一条日志。 */
  function budgetEvaluation(now = Date.now()) {
    const usage = budgetUsageToday(now);
    const result = evaluateBudget(usage, budgetConfig);
    if (shouldAlert(result, budgetAlertDay, now)) {
      budgetAlertDay = dayKeyOf(now);
      saveBudgetState();
      log('[budget] ' + describeBudget(result));
    }
    return result;
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', errorText(error));
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', errorText(error));
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 重放的回合没有时间戳，只能从"恢复这一刻"开始计时：给看门狗一个期限，
    // 免得 DSH 重启时捞回来的幽灵回合让会话永久繁忙（10 分钟没有新事件就中止）。
    turnActivityAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeSince.set(key, Date.now());
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeSince.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
    pendingWakeSince.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
    pendingWakeSince.clear();
  }

  // DSH 重启（同一个桥接进程里 dshReady 由 false 变 true）意味着它进程里的回合已经不存在了。
  // 此时本地若还留着「进行中回合」的痕迹，isConversationBusyV2() 会把这个会话一直判为繁忙：
  // 新消息只进 pendingWakeReasons 暂存、永远不真正唤醒（实测：DSH 重启后群里 @ 机器人近半小时没人理，
  // 要等 30 分钟租约到期才自己醒）。所以 DSH 恢复后第一时间丢掉这些失联回合。
  function dropStaleTurnsAfterDshRestart() {
    const stale = new Set([...collectors.keys(), ...v2TurnStartAt.keys()]);
    if (stale.size) {
      for (const sid of stale) {
        collectors.delete(sid);
        v2TurnStartAt.delete(sid);
        turnActivityAt.delete(sid);
        longWaitUntil.delete(sid);
        sessionPromptTokens.delete(sid);
      }
      log(`DSH 重启：清理 ${stale.size} 个失联的进行中回合（${[...stale].join(', ')}）`);
    }
    // 唤醒的"下落"也只在这个进程里有意义：DSH 换了进程，旧回合永远不会有 turn/end。
    if (pendingWakeKeys.size) {
      log(`DSH 重启：解除 ${pendingWakeKeys.size} 个会话的繁忙标记（${[...pendingWakeKeys].join(', ')}）`);
      pendingWakeKeys.clear();
    }
    clearAllPendingWakeLeases();
  }

  // 把「繁忙期间暂存」的唤醒原因立刻补一次（DSH 重启后会走这条；正常回合结束走 turn/end 那条）。
  function drainPendingWakeReasonsV2(note = 'DSH 重启') {
    for (const key of socialV2.conversations.keys()) {
      const st = getSocialV2State(key);
      if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      const item = st.pendingWakeReasons.shift();
      if (!item || typeof item !== 'object') continue;
      const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
      if (stillRelevant) {
        log(`[reserved2] ${note}：补发暂存的唤醒 ${key}（${item.reason}@seq${item.seq}）`);
        scheduleWakeV2(key, item.reason);
      } else {
        log(`[reserved2] ${note}：暂存唤醒 ${key}（${item.reason}@seq${item.seq}）已过期，丢弃`);
      }
    }
  }

  // ── 回合健康度：看门狗 ──────────────────────────────────────────────────────
  // 两种卡死形态，后果一样：busy 标记回不来，这个会话从此对唤醒免疫（新消息只进暂存队列）。
  //  a) 孤儿 busy —— 唤醒已投递（pendingWakeKeys 里有它），但 DSH 那边根本没有回合在跑。
  //     2026-10-23 实测：一轮 aborted 之后 turn/end 永远不会来，群里 @ 她不回、控制台点唤醒也没用，
  //     最后是手动点一下才活过来；这条路径必须自动兜住。
  //  b) 卡死回合 —— turn/start 之后长时间没有任何事件（模型挂住 / 连接半死）。
  //     注意 qq_wait_for_messages 是合法的长时间安静，所以有长轮询在等时不算卡死。
  const TURN_WATCHDOG_INTERVAL_MS = 20_000;
  function stuckTurnMs() {
    return Math.max(60_000, Number(cfg.socialV2?.wake?.stuckTurnMs) || 10 * 60_000);
  }
  function orphanBusyMs() {
    return Math.max(15_000, Number(cfg.socialV2?.wake?.busyOrphanMs) || 60_000);
  }

  // 每收到一条会话事件就记一笔：谁在动、提示词多大、有没有在长轮询里等。
  function noteTurnProgress(sessionId, event) {
    if (!sessionId || !event) return;
    const now = Date.now();
    turnActivityAt.set(sessionId, now);
    try {
      const usage = usageOfEvent(event);
      if (usage) {
        const b = normalizeUsage(usage);
        const prompt = (b.cacheMiss ?? 0) + (b.cacheHit ?? 0) + (b.cacheWrite ?? 0);
        if (prompt > 0) {
          sessionPromptTokens.set(sessionId, { at: now, tokens: prompt });
          const key = reverse.get(sessionId);
          if (key) lastTurnPromptTokens.set(key, prompt);
        }
      }
    } catch { /* 统计失败不影响主流程 */ }
    if (event.type === 'tool/call') {
      const name = String(event.data?.name ?? event.data?.toolName ?? '');
      if (name.includes('wait_for_messages')) {
        const args = event.data?.arguments ?? event.data?.input ?? {};
        const timeout = Number(args?.timeoutMs ?? args?.timeout_ms ?? 0);
        if (Number.isFinite(timeout) && timeout > 0) {
          longWaitUntil.set(sessionId, now + Math.min(timeout, 10 * 60_000) + 60_000);
        }
      }
    }
  }

  let watchdogBusy = false;
  async function runTurnWatchdog() {
    if (watchdogBusy || !dshReady) return;
    watchdogBusy = true;
    const releasedKeys = [];
    try {
      const now = Date.now();
      // a) 孤儿 busy
      for (const key of [...pendingWakeKeys]) {
        const since = Number(pendingWakeSince.get(key) ?? 0);
        if (!since || now - since < orphanBusyMs()) continue;
        const sid = state.sessions[key];
        const live = !!sid && (v2TurnStartAt.has(sid) || isTurnCollectorLive(sid));
        if (live) continue;
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        if (sid) {
          turnActivityAt.delete(sid);
          longWaitUntil.delete(sid);
        }
        releasedKeys.push(key);
        log(`[watchdog] 唤醒失去下落：${key} 投递 ${Math.round((now - since) / 1000)}s 后既没有回合也没有结束事件，已解除繁忙`);
      }
      // b) 卡死回合
      for (const [sid, at] of [...turnActivityAt]) {
        const idleFor = now - Number(at ?? 0);
        if (idleFor < stuckTurnMs()) continue;
        if (now < Number(longWaitUntil.get(sid) ?? 0)) continue;
        const key = reverse.get(sid);
        log(`[watchdog] 回合卡死：${key ?? sid} 已 ${Math.round(idleFor / 1000)}s 没有任何事件，中止该回合`);
        try { await api.stopSessionWork(sid); } catch (error) { log(`[watchdog] 中止卡死回合失败 ${sid}：`, errorText(error)); }
        v2TurnStartAt.delete(sid);
        collectors.delete(sid);
        turnActivityAt.delete(sid);
        longWaitUntil.delete(sid);
        sessionPromptTokens.delete(sid);
        if (key) {
          pendingWakeKeys.delete(key);
          disarmPendingWakeLease(key);
          releasedKeys.push(key);
        }
      }
    } catch (error) {
      log('[watchdog] 巡检异常：', errorText(error));
    } finally {
      watchdogBusy = false;
    }
    if (releasedKeys.length) {
      // 解除繁忙后，把暂存的唤醒原因补一次（否则那几条消息就永远沉在队列里）
      try { drainPendingWakeReasonsV2('看门狗解除繁忙'); } catch (error) { log('[watchdog] 补发暂存唤醒失败：', errorText(error)); }
    }
  }

  /**
   * 清空一个会话的上下文：停掉并归档旧 DSH 会话，下次消息开新会话；二代记忆/未读/唤醒配置保留。
   *
   * HTTP /api/session/reset、QQ 里的 /reset、上下文超预算自愈都走这里 ——
   * 这段清理清单以前在三个地方各抄了一遍，加一个 map 就漏两处（漏掉的 map 会永久残留，
   * 让新会话被旧状态判定成繁忙或串台）。
   * 返回 { oldSessionId, keptV2State }；会话不存在返回 null。
   */
  async function resetSessionContext(key, { reason = '手动重置' } = {}) {
    const oldSessionId = state.sessions[key];
    if (!oldSessionId) return null;
    sessionEpoch++;
    delete state.sessions[key];
    modelAppliedSessions.delete(oldSessionId);
    // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
    delete state.sessionPolicies[key];
    reverse.delete(oldSessionId);
    collectors.delete(oldSessionId);
    sendToolSucceededSessions.delete(oldSessionId);
    pendingSendToolCalls.delete(oldSessionId);
    v2TurnStartAt.delete(oldSessionId);
    toolCallNames.delete(oldSessionId);
    turnActivityAt.delete(oldSessionId);
    longWaitUntil.delete(oldSessionId);
    sessionPromptTokens.delete(oldSessionId);
    const pe = pending.get(key);
    if (pe) {
      clearTimeout(pe.timer);
      cancelPendingEntry(pe).catch(() => {});
    }
    pending.delete(key);
    queued.delete(key);
    queuedHintAt.delete(key);
    sessionPromises.delete(key);
    drainPromptQueue(key, '会话已重置');
    social.recentMessages.delete(key);
    messageMediaStore.delete(key);
    social.pendingSummaries.delete(key);
    social.states.delete(key);
    social.silentContext.delete(key);
    social.silentTurns.delete(oldSessionId);
    social.exitingSessions.delete(oldSessionId);
    slangWindows.delete(key);
    saveSlangWindowsNow();
    slangExtractionCooldowns.delete(key);
    slangSubmitTimes.delete(key);
    cancelSocialTimers(key);
    clearSocialV2Timers(key);
    pendingWakeKeys.delete(key);
    disarmPendingWakeLease(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    wakeConfigMissCount.delete(key);
    // 只换 DSH 侧会话，不删二代记忆：进行中的话题/想说没说的话/对群友的印象、
    // 未读缓冲、最近消息、唤醒配置都留着（rebind 只把 bootstrapSent 置回 false，
    // 让下一轮走一次带新 preset 的引导唤醒）。以前这里是
    // socialV2.conversations.delete(key) —— 控制台点一次「清除会话上下文」
    // 或 QQ 里发一次 /reset，记忆表就被清空了。要连记忆一起清空用 POST /api/socialV2/reset。
    const keptV2State = rebindSocialV2Session(key);
    seenForwardIds.delete(key);
    saveSocialV2State();
    saveState();
    // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
    try { await api.stopSessionWork(oldSessionId); }
    catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${errorText(error)}；请在 DSH 检查旧任务`); }
    try { await api.workspace.archiveSession({ sessionId: oldSessionId }); }
    catch (error) { log(`⚠️ 归档旧会话失败 ${key}（${oldSessionId}）：${errorText(error)}；它可能仍出现在 DSH 会话列表里`); }
    log(`${reason}：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）${keptV2State ? '；记忆与未读保留' : ''}`);
    return { oldSessionId, keptV2State };
  }

  // ── 上下文预算 ──────────────────────────────────────────────────────────────
  // 为什么要有：单个 DSH 会话的提示词会随回合一路膨胀（10-23 那次到 87 万 token），
  // 越往后越慢越贵、模型还开始"变笨"。这里在回合结束时看一眼规模，超过预算就换新会话，
  // 记忆层（socialV2）原样保留，并在下一次唤醒里告诉它"上一个会话为什么重开"。
  function contextBudgetTokens() {
    return Math.max(20000, Number(cfg.socialV2?.context?.budgetTokens) || 250000);
  }
  function maybeResetContextAfterTurn(sessionId) {
    const key = reverse.get(sessionId);
    const info = sessionPromptTokens.get(sessionId);
    if (!key || !info) return;
    const budget = contextBudgetTokens();
    lastTurnPromptTokens.set(key, info.tokens);
    if (info.tokens < budget) return;
    const now = Date.now();
    if (now - Number(contextResetAt.get(key) ?? 0) < 10 * 60 * 1000) return;
    contextResetAt.set(key, now);
    log(`🧠 ${key} 上下文已到 ${info.tokens} token（预算 ${budget}），自动重开会话（记忆保留）`);
    resetSessionContext(key, { reason: `上下文超预算 ${info.tokens} token` })
      .then((result) => {
        if (!result) return;
        const st = getSocialV2State(key);
        st.contextResetNote = { at: now, tokens: info.tokens, budget, oldSessionId: result.oldSessionId };
        saveSocialV2State();
      })
      .catch((error) => log(`⚠️ 上下文超预算重开会话失败 ${key}：${errorText(error)}`));
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      const fromDsh = ns?.value ? normalizeModeInput(ns.value.mode) : null;
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${errorText(error)}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${errorText(error)}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  /**
   * 列出当前仍活着、且策略里用的就是这个预设的会话 key。
   *
   * 为什么要这个：预设正文是每条会话 prompt 的 system 前缀（DSH 侧由 dsh-persona 每步装配）。
   * 中途改写正文会让该会话已缓存的前缀全部作废——实测改一次【记忆卫生】段落，公共前缀从数万
   * 字符掉到 7213，而单轮 prompt 是 10 万+ token，全部按未命中重新计费。所以控制台保存前
   * 需要知道「谁在用」，先让操作者确认。
   */
  function sessionsUsingPreset(preset) {
    const wanted = resolvePresetName(preset);
    const used = [];
    for (const key of Object.keys(state.sessions ?? {})) {
      const policy = state.sessionPolicies?.[key];
      if (!policy) continue;
      try {
        const parsed = JSON.parse(policy);
        if (Array.isArray(parsed) && parsed[1] === wanted) used.push(key);
      } catch {}
    }
    return used;
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${errorText(error)}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${errorText(error)}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${errorText(error)}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      // 下面几步各自兜错：checkDsh 由定时器驱动，任何一处抛错以前都会变成
      // unhandledRejection，并把本轮剩下的就绪/定时器重建/补投步骤整段跳过。
      try {
        await refreshMode();
      } catch (error) {
        log('刷新桥接模式失败:', errorText(error));
      }
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      try {
        reconcileSessionPolicies();
      } catch (error) {
        log('校准会话策略失败:', errorText(error));
      }
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        // DSH 是刚重启回来的（同一个进程里 false→true）：它那边的回合全没了，
        // 先清掉本地失联标记，否则会话会被永久判为繁忙、只看不醒。
        dropStaleTurnsAfterDshRestart();
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
          startScheduleTickerV2();
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', errorText(error)); }
        // 解除繁忙后，把 DSH 重启期间只暂存、没投出去的唤醒补一次（补投队列之后做）。
        try { drainPendingWakeReasonsV2(); } catch (error) { log('补发暂存唤醒异常:', errorText(error)); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        try {
          for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
        } catch (error) {
          log('补触发黑话提取失败:', errorText(error));
        }
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
          startScheduleTickerV2();
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else {
      // 这里是 else（不是 else if (dshReady)）：桥接启动时若 DSH 已经换了端口，
      // dshReady 一开始就是 false，旧写法一声不吭 —— 恰好就是这次的故障形态。
      const wasReady = dshReady;
      if (wasReady) {
        dshReady = false;
        log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
      }
      const changed = await ensureDshEndpoint({ reason: wasReady ? '就绪后失联' : '启动后仍未就绪' });
      if (changed) {
        // 端点换了就当场重试一次，让「已就绪」尽快恢复，不用等下一个 5 秒。
        try { await api.settings.describe({}); } catch {}
      }
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    // checkDsh 是 async：直接交给 setInterval 时它返回的 promise 一旦 reject 就是
    // unhandledRejection（Node 默认会打警告、按配置甚至退出进程）。统一在这里挂 catch。
    const runCheckDsh = () => {
      checkDsh().catch((error) => log('DSH 健康检查异常:', errorText(error)));
    };
    runCheckDsh();
    setInterval(runCheckDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;

    /**
     * 自省：把「运行 / SnowLuma / 本会话 / 花费 / 额度 / 其它」聚合成一小段给模型看的摘要。
     *
     * 三条硬纪律（缺一条这个工具就会变成新的故障点）：
     *   ① 只读：不写状态、不发消息、不改文件 —— 它可能被每一轮唤醒调用；
     *   ② 缺字段就省略：每一段都单独包 try，任何一块取不到都不影响其余部分；
     *   ③ 花费是 **best-effort**：读账本要遍历采样文件，给不出就整段消失（绝不让工具挂住）。
     * 文本上限 1200 字（SELF_STATUS_MAX_CHARS），因为它是 prompt 的一部分，每个字都要按轮付费。
     */
    function buildSelfStatusSnapshot({ key = '', includeCost = true } = {}) {
      const input = {
        key: key || null,
        mode: currentMode,
        paused: socialV2.paused === true,
        dshReady,
        provider: cfg.dsh?.provider ?? null,
        model: cfg.dsh?.model ?? null,
        reasoningEffort: cfg.dsh?.reasoningEffort ?? null
      };

      // ── SnowLuma 链路（只读快照；取不到就整段省略）────────────────────────
      try {
        const snap = snowlumaHealthSnapshot();
        input.snowluma = {
          connected: snap.connected === true,
          accountOnline: snap.accountOnline,
          good: snap.good,
          degraded: snap.degraded === true,
          lastPacketAgoMs: snap.lastPacketAgoMs
        };
      } catch {
        // 健康快照不可用：省略【SnowLuma】段，不影响其余
      }

      // ── 本会话：唤醒额度 / 等待 / 忙 ───────────────────────────────────────
      if (key) {
        try {
          const st = getSocialV2State(key);
          const now = Date.now();
          const times = Array.isArray(st.wakeTimes) ? st.wakeTimes : [];
          input.sessionId = reverse.get(key) ?? null;
          input.wake = {
            usedMinute: times.filter((t) => now - t < 60000).length,
            capMinute: Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0,
            usedHour: times.filter((t) => now - t < 3600000).length,
            capHour: Number(cfg.socialV2?.wake?.maxWakePerHour) || 0,
            config: {
              mode: st.wakeConfig?.mode ?? null,
              infinite: st.wakeConfig?.infinite,
              sleepUntil: st.wakeConfig?.sleepUntil ?? null
            }
          };
          input.pendingWakeReasons = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.length : 0;
          input.waiting = activeWaits.has(key) && now - activeWaits.get(key) < ACTIVE_WAIT_LEASE_MS;
          input.busy = pendingWakeKeys.has(key);
        } catch {
          // 会话状态不可读（key 未在白名单/格式不合规）：省略这几段
        }
      }

      // ── 语音/图片额度：给的是"还剩几条"的直观数字 ──────────────────────────
      try {
        const vc = voiceCfg();
        if (vc?.enabled) {
          const now = Date.now();
          const times = voiceSendTimes.get(key) ?? [];
          input.voiceLimits = {
            usedMinute: times.filter((t) => now - t < 60000).length,
            capMinute: Number(vc.maxPerMinute) || 0,
            usedHour: times.filter((t) => now - t < 3600000).length,
            capHour: Number(vc.maxPerHour) || 0
          };
        }
      } catch {}
      try {
        const mc = mediaCfg(cfg, ROOT);
        if (mc?.enabled) {
          const now = Date.now();
          const times = imageSendTimes.get(key) ?? [];
          input.imageLimits = {
            usedMinute: times.filter((t) => now - t < 60000).length,
            capMinute: Number(mc.maxPerMinute) || 0,
            usedHour: times.filter((t) => now - t < 3600000).length,
            capHour: Number(mc.maxPerHour) || 0
          };
        }
      } catch {}

      // ── 多模态默认值 / 待触发提醒 ─────────────────────────────────────────
      try {
        const tc = ttsCfg();
        if (tc?.enabled) input.tts = { voice: tc.voice, provider: tc.provider };
      } catch {}
      try {
        const stats = remindersStoreInstance?.stats?.();
        if (stats) {
          input.reminders = { pending: stats.pending, nextDueAt: stats.nextDueAt };
          input.remindersExplicit = true;
        }
      } catch {}

      // ── 花费：best-effort，且允许操作者用 status.includeCost=false 关掉 ────
      // 读的是本会话的账本视图（turns/steps/cost/tokens），失败或无数据就整段省略。
      if (includeCost && key) {
        try {
          const view = tokenLedger.conversation(key, { turnLimit: 1 });
          if (view) {
            input.cost = {
              currency: view.currency ?? null,
              symbol: view.symbol ?? null,
              // conversation() 给的是**累计**花费；自省问的是「今天」，所以按当天已归集的
              // 逐轮花费重算，拿不到逐轮明细时退回累计值（宁可给个上界，也不要给 0 骗人）。
              todayCost: costTodayOfView(view),
              turns: view.turns ?? null,
              steps: view.steps ?? null,
              cacheHitTokens: view.buckets?.cacheHit ?? null,
              cacheMissTokens: view.buckets?.cacheMiss ?? null,
              outputTokens: view.buckets?.output ?? null,
              estimated: view.estimated === true
            };
          }
        } catch (error) {
          log(`[self-status] 读取花费失败（已省略花费段）：${errorText(error)}`);
        }
      }

      return buildSelfStatus(input);
    }

    /**
     * 会话视图里的「今天花费」。
     *
     * 逐轮明细带 endedAt，能按当天切片；没有明细（只剩投影累计值的历史）时退回累计花费，
     * 并让调用方标 estimated，避免把「历史总和」伪装成「今天」。
     */
    function costTodayOfView(view) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const from = startOfDay.getTime();
      const rows = Array.isArray(view?.turns) ? view.turns : [];
      const today = rows.filter((r) => Number(r?.endedAt) >= from);
      if (!today.length) return Number.isFinite(Number(view?.cost)) ? Number(view.cost) : null;
      const sum = today.reduce((acc, r) => acc + (Number(r?.cost) || 0), 0);
      return Number(sum.toFixed(6));
    }

    /**
     * 自省端点的公共闸门（AI 与操作者两条通道共用）。
     *
     * 返回 `{ok:true}` 或 `{ok:false,status,error}`；调用方直接照着 sendJson。
     * 把校验集中在一处，是为了不让"AI 通道多一条旁路"这类问题在两次复制粘贴里长出来。
     */
    function checkSelfStatusRequest({ key, agentCall }) {
      if (!isValidSessionKey(String(key ?? ''))) {
        return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
      }
      if (agentCall && !v2SessionAllowed(key)) {
        return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
      }
      if (agentCall && !v2ToolEnabled('status')) {
        return { ok: false, status: 403, error: '工具未启用：qq_bridge_status' };
      }
      if (agentCall && currentMode !== 'reserved2') {
        return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
      }
      return { ok: true };
    }
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      // 记忆大脑页面（public/memory-brain.html，前端由另一个 agent 维护）。
      // 和控制台外壳一样**不校验令牌**：页面本身不是机密，数据全走带令牌的 /api/*。
      // 只有文件缺失才回 404 —— 让「页面没装」和「功能没开」（API 回 disabled:true）可区分。
      const sendMemoryBrainPage = () => {
        let html = '';
        try { html = fs.readFileSync(path.join(ROOT, 'public', 'memory-brain.html'), 'utf8'); } catch { html = ''; }
        if (!html) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
          res.end('记忆大脑页面缺失：qq-bridge/public/memory-brain.html');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end(html);
      };
      // 记忆星系页面（public/galaxy.html）。同样不校验令牌：数据全走带令牌的 /api/memory-brain/galaxy。
      const sendGalaxyPage = () => {
        let html = '';
        try { html = fs.readFileSync(path.join(ROOT, 'public', 'galaxy.html'), 'utf8'); } catch { html = ''; }
        if (!html) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
          res.end('记忆星系页面缺失：qq-bridge/public/galaxy.html');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end(html);
      };
      // 静态插画（public/assets）：只放页面用的图片，免令牌（和页面外壳同款），
      // 可取的文件名压到 basename，扩展名走白名单 —— 挡住 ../ 穿越与非图片文件。
      const ASSET_TYPES = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
      };
      const sendAsset = () => {
        let raw = '';
        try { raw = decodeURIComponent(url.pathname); } catch { raw = ''; }
        const name = path.basename(raw);
        const type = ASSET_TYPES[path.extname(name).toLowerCase()];
        if (!type || raw !== '/assets/' + name || name.includes('\\')) {
          sendJson({ ok: false, error: '资源不存在' }, 404);
          return;
        }
        let buf;
        try { buf = fs.readFileSync(path.join(ROOT, 'public', 'assets', name)); } catch {
          sendJson({ ok: false, error: '资源不存在' }, 404);
          return;
        }
        res.writeHead(200, { 'content-type': type, 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS });
        res.end(buf);
      };
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        sendAsset();
        return;
      }
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        // 控制台**页面外壳**不校验令牌：令牌只保护数据接口（/api/*）。
        // 原因：页面 JS 会把 ?token= 从地址栏抹掉、只留在 localStorage（见 console.html 开头），
        // 浏览器刷新时地址栏里没有令牌——若连 HTML 都回 401，用户就掉进
        // 「刷新 → 401 → 被 prompt 要求重新输令牌（还会被浏览器拦截）」的死循环。
        // 外壳里没有任何机密：数据全靠带令牌的接口拿；这一段前端代码本身不是秘密。
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/console.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && (url.pathname === '/memory-brain' || url.pathname === '/memory-brain.html')) {
          sendMemoryBrainPage();
          return;
        }
        if (req.method === 'GET' && (url.pathname === '/galaxy' || url.pathname === '/galaxy.html')) {
          sendGalaxyPage();
          return;
        }
        sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1（缺令牌时 x-agent-token 为空串），这里只要看到
      // 这个声明就要求令牌必须命中某个活跃会话，端点自己漏写校验也不会退回管理端。
      if (req.headers['x-agent-call'] !== undefined) {
        if (!isLiveAgentToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '未授权：智能体调用必须携带有效的会话令牌' }, 403);
          return;
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/') || url.pathname.startsWith('/api/voice/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/') || url.pathname.startsWith('/api/voice/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/tools', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname.startsWith('/api/voice/')
            // 「读群里的 txt」与「点开卡片」（主人 2026-10-12）—— 这两个端点的返回值
            // 只可能是**当前会话里某条消息**的附件/卡片，key 由调用方给出且逐个校验
            // agentTokenOk，不会跨会话泄漏，所以放进智能体白名单。
            || url.pathname === '/api/files/message'
            || url.pathname === '/api/cards/message'
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // 记忆大脑页面：带令牌/免令牌都能开（见 sendMemoryBrainPage 注释）。
        if (req.method === 'GET' && (url.pathname === '/memory-brain' || url.pathname === '/memory-brain.html')) {
          sendMemoryBrainPage();
          return;
        }
        if (req.method === 'GET' && (url.pathname === '/galaxy' || url.pathname === '/galaxy.html')) {
          sendGalaxyPage();
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            dsh: {
              baseUrl: api.baseUrl,
              source: dshEndpoint.source,
              autoDiscover: cfg.dsh.followDiscoveredEndpoint !== false,
              authOk: dshEndpoint.authOk,
              attempts: dshEndpoint.attempts,
              lastError: dshEndpoint.lastError || null
            },
            // 回合健康度：卡死自愈看的是这几个数（控制台/运维排查时不用去翻日志）。
            turnHealth: {
              activeTurns: v2TurnStartAt.size,
              pendingWakes: pendingWakeKeys.size,
              contextBudget: contextBudgetTokens(),
              lastPromptTokens: Object.fromEntries(lastTurnPromptTokens),
              watchdogIntervalMs: TURN_WATCHDOG_INTERVAL_MS
            },
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${errorText(error)}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = resolvePresetName(url.searchParams.get('preset'));
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          let nextText;
          let currentPrefix = '';
          try {
            const { text, prefix } = readPresetPromptText(preset);
            currentPrefix = prefix;
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          // 两类「静默烧钱/静默删规则」防护，合并成一次确认：
          // ① 少节：控制台输入框里的内容可能是旧的、或被人裁过的，一次保存就会静默删掉整段规则。
          //    2026-10-11 实测：一次保存把【口语与长度】整节抹掉，而界面上只显示「已更新」。
          // ② 缓存：预设正文就是会话的 system 前缀，改写会让活跃会话已缓存的前缀全部作废
          //    （下一轮 10 万+ token 重新计费）。实测改一次【记忆卫生】段落，公共前缀掉到 7213。
          const sectionTitles = (t) => (String(t ?? '').match(/【[^】\n]{1,60}】/g) ?? []);
          const nextSections = sectionTitles(body.content);
          const missingSections = [...new Set(sectionTitles(currentPrefix))]
            .filter((title) => !nextSections.includes(title));
          const activeSessions = sessionsUsingPreset(preset);
          if (body.force !== true && (missingSections.length || activeSessions.length)) {
            const reasons = [];
            if (missingSections.length) reasons.push(`会删掉 ${missingSections.length} 个段落：${missingSections.join('、')}`);
            if (activeSessions.length) reasons.push(`有 ${activeSessions.length} 个活跃会话正在用它（${activeSessions.join('、')}），改写正文会让这些会话已缓存的前缀全部作废、下一轮重新计费`);
            sendJson({
              ok: false,
              needForce: true,
              error: `这次保存${reasons.join('；')}。确认要这样做就再保存一次。`,
              missingSections,
              affectedSessions: activeSessions,
              warnings,
              status: presetStatus(preset),
            }, 409);
            return;
          }
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${errorText(error)}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}${activeSessions.length ? `；${activeSessions.length} 个活跃会话的缓存前缀将在下一轮失效（${activeSessions.join('、')}）` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            affectedSessions: activeSessions,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          try {
            sendJson({ ok: true, backups: listPresetBackups(resolvePresetName(url.searchParams.get('preset'))) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            saveSlangWindowsNow();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          // 号码必须是纯十进制正整数：以前用 Number(String(x).trim())，空串/空白会变成 0
          // 并被保留，负数、1e3、0x10 也能通过，白名单会被静默写进无效号码。
          const toNum = (arr) => Array.isArray(arr)
            ? [...new Set(arr
              .map((x) => String(x).trim())
              .filter((s) => /^[1-9]\d*$/.test(s))
              .map(Number)
              .filter((n) => Number.isSafeInteger(n)))]
            : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          let catalogValue = null;
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            catalogValue = catalog;
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            // 不再用固定白名单过滤：DSH 各模型的档位词汇不同（light / xhigh / extra_high / medium…），
            // 过滤会把目录里真实支持的档位吞掉，控制台就只剩空列表。
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter(Boolean);
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(errorText(error));
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          // 供控制台「自由选择模型」用：把 DSH 的模型目录整理成 provider → models，
          // 并把「这个模型能不能调思考强度」直接标出来。判据是目录里有没有
          // `reasoning.efforts`：没有这一项就是**不支持**（trae 全系如此），传任何档位
          // 都会被 DSH 拒为 `session/model-unavailable: … does not support reasoning effort`，
          // 只能走哨兵值 'default'（不下发该字段）。这条信息必须让管理员看见，
          // 否则他会以为"思考强度没生效"。
          const providers = (catalogValue?.groups ?? [])
            .filter((g) => g?.id && Array.isArray(g.models))
            .map((g) => ({
              id: String(g.id),
              name: String(g.name ?? g.id),
              models: g.models.filter((m) => m?.id).map((m) => {
                const efforts = (m.reasoning?.efforts ?? [])
                  .map((e) => ({ id: String(e?.id ?? ''), name: String(e?.name ?? ''), description: String(e?.description ?? '') }))
                  .filter((e) => e.id);
                return {
                  id: String(m.id),
                  name: String(m.name ?? m.id),
                  supportsEffort: efforts.length > 0,
                  efforts,
                  defaultEffort: m.reasoning?.defaultEffort ?? null,
                };
              }),
            }));
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            providers,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        // 一次性改「提供方 + 模型 + 思考强度」：先按 DSH 真实模型目录校验，再写 config.json，
        // 最后递增 modelSelectionEpoch，让已存在的 QQ 会话在**下一条消息**重新 selectModel
        // （不用重启桥接，也不用重启 DSH）。
        if (req.method === 'POST' && url.pathname === '/api/dsh/model') {
          const body = await readBody();
          const nextProvider = String(body.provider ?? '').trim();
          const nextModel = String(body.model ?? '').trim();
          if (!nextProvider || !nextModel) {
            sendJson({ ok: false, error: 'provider 与 model 必填' }, 400);
            return;
          }
          let catalog;
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
          } catch (error) {
            // 目录读不到就**不改**：否则可能写进一个不存在的组合，之后每条消息都 selectModel 失败。
            sendJson({ ok: false, error: `读取 DSH 模型目录失败，未做修改：${errorText(error)}` }, 502);
            return;
          }
          const group = (catalog?.groups ?? []).find((g) => g?.id === nextProvider);
          const entry = (group?.models ?? []).find((m) => m?.id === nextModel);
          if (!group || !entry) {
            sendJson({ ok: false, error: `DSH 模型目录里没有 ${nextProvider}/${nextModel}` }, 400);
            return;
          }
          const advertised = (entry.reasoning?.efforts ?? []).map((e) => String(e?.id ?? '')).filter(Boolean);
          const supportsEffort = advertised.length > 0;
          let effort;
          if (!supportsEffort) {
            effort = 'default';
          } else {
            const raw = (body.reasoningEffort === undefined || body.reasoningEffort === null || body.reasoningEffort === '')
              ? String(cfg.dsh?.reasoningEffort || entry.reasoning?.defaultEffort || REASONING_EFFORT_DEFAULT)
              : String(body.reasoningEffort);
            try { effort = normalizeReasoningEffort(raw); }
            catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
            if (!advertised.includes(effort)) {
              sendJson({ ok: false, error: `${nextProvider}/${nextModel} 只支持 ${advertised.join(' / ')}` }, 400);
              return;
            }
          }
          const sameCombo = String(cfg.dsh?.provider ?? '') === nextProvider
            && String(cfg.dsh?.model ?? '') === nextModel
            && String(cfg.dsh?.reasoningEffort ?? REASONING_EFFORT_DEFAULT) === effort;
          // 切模型 = 活跃会话的缓存前缀全灭：preset 第 15 行的 {{model}} 每步替换（system 首行就变），
          // 加上 DSH 会往会话里插一条 [model changed: …]，整段前缀直接作废。实测 trae/Doubao 的
          // turn5/6/7 cacheRead=0，而没换过模型的 qodercn/qmodel_38max turn1-4 命中 100%。
          // 所以切换前先算清「谁会受影响」，让操作者确认。
          const activeSessions = sameCombo ? [] : Object.keys(state.sessions ?? {});
          if (activeSessions.length && body.force !== true) {
            sendJson({
              ok: false,
              needForce: true,
              affectedSessions: activeSessions,
              error: `有 ${activeSessions.length} 个活跃会话（${activeSessions.join('、')}）会因切模型而失去已缓存的前缀——下一轮 10 万+ token 将重新计费。确认要现在切就再点一次。`,
            }, 409);
            return;
          }
          const modelConfigFile = path.join(ROOT, 'config.json');
          const modelFile = readConfigObject(modelConfigFile);
          modelFile.dsh = { ...(modelFile.dsh ?? {}), provider: nextProvider, model: nextModel, reasoningEffort: effort };
          atomicWriteJson(modelConfigFile, modelFile);
          cfg.dsh = { ...(cfg.dsh ?? {}), provider: nextProvider, model: nextModel, reasoningEffort: effort };
          modelSelectionEpoch += 1;
          log(`控制台：DSH 模型已设为 ${nextProvider}/${nextModel}（思考强度 ${effort}${supportsEffort ? '' : '；该模型不支持思考强度，按"不下发该字段"处理'}）${activeSessions.length ? `；${activeSessions.length} 个活跃会话的前缀缓存已作废（${activeSessions.join('、')}）` : ''}`);
          sendJson({ ok: true, provider: nextProvider, model: nextModel, reasoningEffort: effort, supportsEffort, affectedSessions: activeSessions });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（角色卡全文与说话方式示例在 qq_get_prompt，本会话没调过就先调一次）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        // 「工具开关」和「MCP 进程真正注册了什么」的对账接口（只读，控制台用）。
        //
        // 为什么需要单独一个接口：MCP 进程的配置是**启动时读的一次快照**，
        // 工具开关是**热生效**的：保存后 MCP 进程收到 config.json 变化，当场 enable/disable
        // 并发 tools/list_changed，DSH 重新拉清单，通常不到 1 秒。桥接侧的 cfg 也是活的
        // （v2ToolEnabled 每次现查），所以配置值与模型实际拿到的清单之间，只可能在
        // 「刚保存的那一瞬间」短暂错位 —— 而这恰恰是肉眼最看不出来的（页面上勾已经变了，
        // 模型手里还是旧的）。这份数据把「配置值」和「MCP 的实际注册/启用状态」摊在一起。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tools') {
          // 每份快照按 PID 单独落盘，可能同时存在多份（DSH 重启交叠、手工探针），
          // 挑「活着且最新」的那一份；一份都不可信时 pickLiveSnapshot 返回 null。
          let snapshots = [];
          try {
            snapshots = fs.readdirSync(STATE_DIR)
              .filter((f) => /^mcp-tools\.\d+\.json$/.test(f))
              .map((f) => readJsonSafe(path.join(STATE_DIR, f), null))
              .filter(Boolean);
          } catch {}
          const snapshot = pickLiveSnapshot(snapshots);
          const { items, mismatch } = reconcileToolRegistry({
            registered: snapshot?.registered,
            disabled: snapshot?.disabled,
            flags: snapshot?.flags,
            tools: cfg.socialV2?.tools ?? {},
            snapshotUsable: snapshot !== null,
            hot: snapshot?.hot === true
          });
          const view = snapshot ? { at: snapshot.at, pid: snapshot.pid, hot: snapshot.hot === true } : null;
          sendJson({
            ok: true,
            snapshot: view,
            staleSnapshot: !snapshot,
            summary: describeToolRegistry({ staleSnapshot: !snapshot, mismatch, snapshot: view }),
            mismatch,
            items
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'schedule']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          //
          // `toolFlags` 是**允许被保存**的名单（顺序不重要，用它做白名单循环）；缺省值一律取自
          // `SOCIAL_V2_TOOL_DEFAULTS`。
          // ⚠️ 这里的回落曾经写成 `current.tools?.[k] !== false`，对一个配置文件里**从来没有过**的
          // 新开关（`undefined`）会算出 `true` —— 于是"没登记过"被固化成"开"，出厂默认被静默推翻。
          // 实测代价：新加的 sendMusic / groupAdmin（都该默认关）被一次控制台保存写成 true，
          // MCP 立刻把 qq_send_music 注册给了模型。**缺省必须回落到出厂默认，而不是回落到"没写就是开"。**
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'readFile', 'openCard', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice', 'listenVoice', 'sendImage', 'reminders', 'searchHistory', 'status', 'sendMusic', 'groupAdmin', 'repeatMessage', 'watchVideo'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = SOCIAL_V2_TOOL_DEFAULTS[k] === true;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs', 'softWakeCooldownMs', 'softWakePerHour', 'backlogWakeAfter']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // reply：接话冷却（她说完话后，被消息叫醒的唤醒至少隔多久才发）
          if (body.reply && typeof body.reply === 'object') {
            merged.reply = { ...(current.reply ?? {}), ...body.reply };
            for (const k of ['minGapMs', 'minGapDirectedMs']) {
              if (merged.reply[k] !== undefined) {
                const n = Number(merged.reply[k]);
                // 毫秒类字段：非负取整，上限 1 小时（再长就不是"冷却"而是静音了）
                merged.reply[k] = Number.isFinite(n)
                  ? Math.min(3600000, Math.max(0, Math.round(n)))
                  : current.reply?.[k] ?? 0;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          // voice：语音与 TTS 配置（控制台「换默认音色」走这里）。必须深合并：
          // body.voice 只带 tts.voice 时，浅合并会把 maxSeconds/maxBytes/tts.maxChars 一起抹掉。
          if (body.voice && typeof body.voice === 'object') {
            merged.voice = { ...(current.voice ?? {}), ...body.voice };
            if (body.voice.tts && typeof body.voice.tts === 'object') {
              merged.voice.tts = { ...(current.voice?.tts ?? {}), ...body.voice.tts };
              if (body.voice.tts.local && typeof body.voice.tts.local === 'object') {
                merged.voice.tts.local = { ...(current.voice?.tts?.local ?? {}), ...body.voice.tts.local };
              }
              if (merged.voice.tts.voice !== undefined) {
                // 先按音色表解析再落盘：写错一个字母不该把默认音色改成跑不出来的东西。
                try {
                  const resolved = resolveTtsVoice(String(merged.voice.tts.voice ?? '').trim());
                  merged.voice.tts.voice = resolved;
                  merged.voice.tts.provider = ttsVoiceProvider(resolved);
                } catch (error) {
                  sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
                  return;
                }
              }
              for (const [k, min, max] of [['maxChars', 1, TTS_LIMITS.hardMaxChars], ['timeoutMs', 1000, 120000]]) {
                if (merged.voice.tts[k] !== undefined) {
                  const n = Number(merged.voice.tts[k]);
                  merged.voice.tts[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : (current.voice?.tts?.[k] ?? 0);
                }
              }
              if (merged.voice.tts.enabled !== undefined) merged.voice.tts.enabled = merged.voice.tts.enabled === true;
            }
            for (const [k, min, max, fb, frac] of [
              ['maxSeconds', 1, 3600, 300, false],
              ['maxBytes', 1024, 200 * 1024 * 1024, 20971520, false],
              ['maxPerMinute', 0, 60, 2, false],
              ['maxPerHour', 0, 600, 10, false],
              ['defaultVolume', 0.1, 4, 1, true]
            ]) {
              if (merged.voice[k] !== undefined) {
                const n = Number(merged.voice[k]);
                merged.voice[k] = Number.isFinite(n)
                  ? Math.min(max, Math.max(min, frac ? n : Math.round(n)))
                  : (current.voice?.[k] ?? fb);
              }
            }
            if (merged.voice.enabled !== undefined) merged.voice.enabled = merged.voice.enabled === true;
            if (merged.voice.autoReadback !== undefined) merged.voice.autoReadback = merged.voice.autoReadback === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', errorText(error)); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        // 对话收束判定：控制台/运维用来"看她此刻觉得该不该停"，不参与出站、
        // 不写任何状态。AI 不直接调它——建议已经写进唤醒提示词了。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/closure') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const st = getSocialV2State(key);
          const result = analyzeClosure({ messages: st.recentMessages, now: Date.now(), config: closureConfig });
          sendJson({
            ok: true,
            key,
            action: result.action,
            score: result.score,
            openQuestion: result.openQuestion,
            signals: result.signals,
            summary: describeClosure(result),
            line: buildClosureLine(result, closureConfig),
            config: closureConfig
          });
          return;
        }
        // 每日额度：控制台/运维用来"看今天还能不能让她开口"。只读；当日用量来自 token 账本。
        if (req.method === 'GET' && url.pathname === '/api/budget') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          const now = Date.now();
          const result = budgetEvaluation(now);
          sendJson({
            ok: true,
            day: dayKeyOf(now),
            dayStart: localDayStart(now),
            usage: result.usage,
            level: result.level,
            ratios: result.ratios,
            hits: result.hits,
            blocked: result.blocked,
            summary: describeBudget(result),
            line: buildBudgetLine(result, budgetConfig),
            alertDay: budgetAlertDay,
            config: budgetConfig
          });
          return;
        }
        // 目的判定：控制台/运维用来"看她心里此刻惦记着什么、为什么没开口"。
        // 只读，不写 lastFireAt、不发出站；key 可省略（省略时只算候选，闸门里没有 lastIncomingAt）。
        if (req.method === 'GET' && url.pathname === '/api/purpose') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const st = key ? getSocialV2State(key) : null;
          const selection = st ? purposeSelectionFor(key, st) : purposeSelectionFor('', { lastIncomingAt: 0 });
          sendJson({
            ok: true,
            key: key || null,
            action: selection.action,
            score: selection.score,
            purpose: selection.purpose,
            blocked: selection.blocked,
            candidates: selection.candidates.map((c) => ({ id: c.id, kind: c.kind, text: c.text, owner: c.owner, score: c.score })),
            summary: describePurpose(selection),
            line: buildPurposeLine(selection, purposeConfig),
            state: purposeState,
            config: purposeConfig
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices',
            sendImage: 'qq_send_image',
            reminders: 'qq_set_reminder / qq_list_reminders',
            searchHistory: 'qq_search_history',
            status: 'qq_bridge_status',
            sendMusic: 'qq_send_music',
            groupAdmin: 'qq_group_admin / qq_list_requests',
            repeatMessage: 'qq_repeat_message'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 语音能力摘要：让 AI 一开始就知道「可以说话」——传 text 现场合成是最常用路径。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              tts: {
                enabled: voiceCfg().tts.enabled,
                default: voiceCfg().tts.voice,
                maxChars: voiceCfg().tts.maxChars,
                voices: TTS_VOICES.map((v) => `${v.label}=${v.name}`)
              },
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '想开口说话：qq_send_voice 传 text（桥接用免费 edge TTS 现场合成，最常用），也可传 voice 发语音库里已有的音频；别忘了 verified=true 才代表这条语音确实落地'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const rawMessages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          // 给每条未读标上「是不是在找我」，让模型一眼看出该先接谁（主人 m10890：
          // 两个人同时在跟自己说话时要引用具体信息回）。只加派生字段，不改原对象。
          const messages = rawMessages.map((m) => {
            const body = String(m.plain || m.text || '');
            const directed = !m.isSelf && (m.quoteTargetIsSelf === true || isDirectedAtAi(body));
            const quotedMe = m.quoteTargetIsSelf === true;
            if (!directed && !quotedMe) return m;
            return { ...m, directedToMe: directed, quotedMe, replyHint: '这条是在找你，回它时用 qq_reply 引用它（replyToMessageId 传这条的 messageId 或 seq）' };
          });
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          // 有几个不同的人在找我：≥2 时模型必须分开回、各自引用，别混着答。
          const askers = [...new Set(messages.filter((m) => m.directedToMe).map((m) => String(m.sender || m.userId || '?')))];
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq, askers, multiAsker: askers.length >= 2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        // ── 长期记忆卡：跨会话、会衰减的那张卡（按会话的轻量记忆另见 /api/memory）──
        if (req.method === 'GET' && url.pathname === '/api/memory-card') {
          const status = memoryCardStatus(memoryCard, memoryCardConfig, Date.now());
          const records = memoryCard.records
            .slice()
            .sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.importance - a.importance))
            .slice(0, 200)
            .map((r) => ({
              id: r.id, kind: r.kind, clarity: r.clarity, importance: r.importance,
              speaker: r.speaker, isOwner: r.isOwner, text: r.text, pinned: r.pinned,
              createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, recallCount: r.recallCount,
              conversationKey: r.conversationKey,
            }));
          sendJson({ ok: true, status, rendered: memoryCardPromptText, records, config: memoryCardConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory-card/maintain') {
          const result = maintainMemoryCardNow('手动');
          sendJson({ ok: true, ...result, status: memoryCardStatus(memoryCard, memoryCardConfig, Date.now()), rendered: memoryCardPromptText });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory-card/add') {
          const body = await readBody();
          const text = String(body.text ?? '').trim();
          if (!text) {
            sendJson({ ok: false, error: 'text 不能为空' }, 400);
            return;
          }
          const result = addMemoryRecord(memoryCard, {
            source: 'manual',
            kind: body.isOwner === true ? 'private' : 'note',
            text,
            speaker: String(body.speaker ?? '手动记下').slice(0, 30),
            isOwner: body.isOwner === true,
            pinned: body.pinned === true,
            manualImportance: body.importance,
          }, memoryCardConfig, Date.now());
          if (result.record) {
            saveMemoryCardState();
            refreshMemoryCardPrompt();
          }
          sendJson({ ok: true, added: result.added, record: result.record });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory-card/record') {
          const body = await readBody();
          const id = String(body.id ?? '');
          const record = memoryCard.records.find((r) => r.id === id);
          if (!record) {
            sendJson({ ok: false, error: '记录不存在' }, 404);
            return;
          }
          const action = String(body.action ?? '');
          if (action === 'pin') { record.pinned = true; record.clarity = 'vivid'; }
          else if (action === 'unpin') { record.pinned = false; }
          else if (action === 'delete') { memoryCard.records = memoryCard.records.filter((r) => r.id !== id); }
          else {
            sendJson({ ok: false, error: 'action 必须是 pin / unpin / delete' }, 400);
            return;
          }
          saveMemoryCardState();
          refreshMemoryCardPrompt();
          sendJson({ ok: true, action, id });
          return;
        }
        // ── 记忆表（控制台只读）：轻量记忆 + 记忆日志 + 附录一次性打包 ──────────
        // 与 /api/socialV2/states 一样只读内存状态（运行中的进程才是权威，文件可能滞后）。
        if (req.method === 'GET' && url.pathname === '/api/memory') {
          const rs = readRoleState();
          const conversations = [];
          for (const [key, st] of socialV2.conversations) {
            const topics = Array.isArray(st.activeTopics) ? st.activeTopics.slice(-30) : [];
            const thoughts = Array.isArray(st.pendingThoughts)
              ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)).slice(-30)
              : [];
            const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
            conversations.push({
              key,
              wakeConfig: st.wakeConfig || {},
              counts: {
                recent: Array.isArray(st.recentMessages) ? st.recentMessages.length : 0,
                unread: Array.isArray(st.unread) ? st.unread.length : 0,
                activeTopics: topics.length,
                pendingThoughts: thoughts.length,
                memberImpressions: Object.keys(impressions).length
              },
              lastIncomingAt: Number(st.lastIncomingAt) || 0,
              lastAiReplyAt: Number(st.lastAiReplyAt) || 0,
              lastActionAt: Number(st.lastActionAt) || 0,
              lastWakeReason: String(st.lastWakeReason ?? ''),
              lastReadThroughSeq: Number(st.lastReadThroughSeq) || 0,
              activeTopics: topics,
              pendingThoughts: thoughts,
              memberImpressions: impressions,
              formatted: formatMemoryV2(st),
              recentMessages: Array.isArray(st.recentMessages) ? st.recentMessages.slice(-30) : []
            });
          }
          // 最近有动静的会话排前面，方便一眼看到「她刚跟谁聊过」。
          conversations.sort((a, b) => Math.max(b.lastIncomingAt, b.lastAiReplyAt) - Math.max(a.lastIncomingAt, a.lastAiReplyAt));
          const slangList = Array.isArray(slangEntries) ? slangEntries : [];
          sendJson({
            ok: true,
            exportedAt: Date.now(),
            role: { name: rs.role ?? null, mode: rs.mode ?? 'active' },
            mode: currentMode,
            workspaceTitle: cfg.workspaceTitle ?? '',
            conversations,
            slang: {
              total: slangList.length,
              confirmed: slangList.filter((e) => e.status === SLANG_STATUS.CONFIRMED).length,
              candidate: slangList.filter((e) => e.status === SLANG_STATUS.CANDIDATE).length,
              injectMax: Number(cfg.slang?.injectMax) || 0
            },
            stickers: { total: Array.isArray(stickerEntries) ? stickerEntries.length : 0 },
            schedule: cfg.socialV2?.schedule ?? null,
            tools: cfg.socialV2?.tools ?? {}
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          // 操作者逃生门：手动唤醒必须能真的打破「会话繁忙」。否则一次丢失的 turn/end、
          // 或一次卡住的投递，就能让这个会话永久不理人，而控制台这边还收到 {ok:true}，
          // 以为唤醒成功了（2026-10-11 实测：14 次手动唤醒全被吞掉，群里半小时没人理）。
          const busySid = state.sessions[key];
          if (busySid) {
            const hadTurn = v2TurnStartAt.delete(busySid);
            const hadCollector = collectors.delete(busySid);
            if (hadTurn || hadCollector) log(`控制台：手动唤醒强制解除繁忙锁 ${key}（上一轮回合没有正常结束）`);
          }
          pendingWakeKeys.delete(key);
          disarmPendingWakeLease(key);
          const stuckQueue = promptQueues.get(key);
          if (stuckQueue?.running) {
            stuckQueue.cancelled = true;
            stuckQueue.running = false;
            log(`控制台：手动唤醒放弃卡住的投递队列 ${key}`);
          }
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, errorText(error)));
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          let messagesParseError = '';
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把 messages 序列化成 JSON 字符串：`["a","b"]` → 多条；`"你好"` → 单条。
            // 注意：解析失败**必须报错**。以前这里 catch 空吞，原始字符串会落进下面的
            // `typeof rawMessages === 'string'` 分支被当成一条正文发出去，群里就会出现
            // `["你好", "在吗"` 这种乱码。
            if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
                else if (typeof parsed === 'string') rawMessages = parsed;
                else messagesParseError = 'messages 是 JSON，但既不是数组也不是字符串';
              } catch {
                messagesParseError = 'messages 看起来是 JSON，但解析失败';
              }
            }
          }
          if (messagesParseError) {
            sendJson({ ok: false, error: `${messagesParseError}；请传数组（多条）或普通字符串（单条），不要传损坏的 JSON` }, 400);
            return;
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
            const guardMsg = identityGuardBlockReason(msg, key);
            if (guardMsg) {
              sendJson({ ok: false, error: guardMsg }, 403);
              return;
            }
          }
          // st/now 必须在 try 外：catch 里的额度回滚（sendTimes.indexOf(now)）也要用它们，
          // 声明在 try 内会让失败路径抛 ReferenceError，额度永不回滚（失败照样吃限流额度）。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          let messagesParseError = '';
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"、以及单条序列化成 "\"你好\""。
            // 解析失败必须报错：以前这里 catch 空吞，原串会落进下面的 isRawString 分支被当成一条
            // 正文发出去，群里就会出现 `["你好", "在吗"` 这种乱码（和 send-burst 同一个坑）。
            if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
                else if (typeof parsed === 'string') rawMessages = parsed;
                else messagesParseError = 'messages 是 JSON，但既不是数组也不是字符串';
              } catch {
                messagesParseError = 'messages 看起来是 JSON，但解析失败';
              }
            }
          }
          if (messagesParseError) {
            sendJson({ ok: false, error: `${messagesParseError}；请传数组（多条）或普通字符串（单条），不要传损坏的 JSON` }, 400);
            return;
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
            const guardMsg = identityGuardBlockReason(msg, key);
            if (guardMsg) {
              sendJson({ ok: false, error: guardMsg }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            // 查询被引用消息要打 OneBot，可能抛错。抛错也必须走和「解析不到」一样的回滚：
            // 这段 await 在 try 之外，漏出去就是 500 + 预占额度永不回滚（该会话假 429）。
            let resolved = null;
            try {
              resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            } catch (error) {
              log(`[reserved2] 解析被引用消息异常 ${key}: ${errorText(error)}`);
            }
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, errorText(error));
            sendJson({ ok: false, error: `拍一拍失败：${errorText(error)}` }, 500);
          }
          return;
        }
        // ── +1 复读（qq_repeat_message）────────────────────────────────────
        // 群聊里"复制别人的话再说一遍"。之所以是个**专用**端点而不是让模型自己抄：
        // 让模型手打原文，它一定会顺手改写/加字（"中秋快乐"→"中秋快乐呀"），那就不叫 +1 了。
        // 这里由桥接取出**原文**再原样发出去——文本来自本会话已存在的消息，不是模型现编的新内容。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/repeat-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const ref = String(body.messageId ?? body.seq ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式 +1 必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('repeatMessage')) { sendJson({ ok: false, error: '工具未启用：qq_repeat_message' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能 +1' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          // +1 是群聊行为：私聊里复读对方的话只会显得奇怪（一对一没有"跟队形"这回事）。
          if (kind !== 'group') {
            sendJson({ ok: false, error: '+1 只在群聊里有意义，私聊请正常回话' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许 +1' }, 403); return; }
          if (!/^-?[1-9]\d*$/.test(ref)) {
            sendJson({ ok: false, error: 'messageId 必须是非零整数（可用 qq_get_recent_messages 里的 seq 或 messageId）' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          // +1 自己的频率闸门：它比普通发言更容易变成复读机，所以除了共用 sendTimes，
          // 再单独限一道（默认 12 次/小时，0 或负数 = 不单独限）。
          const repeatCfg = cfg.socialV2?.repeat ?? {};
          const repeatMaxPerHour = Number(repeatCfg.maxPerHour);
          const repeatLimit = Number.isFinite(repeatMaxPerHour) ? repeatMaxPerHour : 12;
          if (!Array.isArray(st.repeatTimes)) st.repeatTimes = [];
          const recentRepeats = st.repeatTimes.filter((t) => now - t < 3600000).length;
          if (repeatLimit > 0 && recentRepeats + 1 > repeatLimit) {
            sendJson({ ok: false, error: `+1 太频繁了（1 小时最多 ${repeatLimit} 次），过一阵子再跟队形` }, 429);
            return;
          }
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 预占额度（与 send-message / send-poke 共用一份），失败时逐项回滚，避免假 429。
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          st.repeatTimes.push(now);
          if (st.repeatTimes.length > 500) st.repeatTimes = st.repeatTimes.slice(-500);
          const rollbackRepeat = () => {
            const drop = (list) => {
              const idx = list.indexOf(now);
              if (idx >= 0) list.splice(idx, 1);
              if (list.length > 500) list.splice(0, list.length - 500);
            };
            drop(st.sendTimes);
            drop(st.repeatTimes);
            saveSocialV2State();
            return undefined;
          };
          let resolved = null;
          try {
            resolved = await resolveReplyTargetV2(st, kind, id, ref);
          } catch (error) {
            log(`[reserved2] +1 解析目标消息异常 ${key}: ${errorText(error)}`);
          }
          // 兜底：本地 seq 命中的消息即使桥接没记到真实 messageId 也能复读 —— +1 不带引用，
          // 拿不到 id 不影响发送；而 resolveReplyTargetV2 是为「引用回复」写的，没有 id 时
          // 它会直接返回 null（引用必须有 id），所以这里自己补一条本地文本路径。
          if (!resolved) {
            const local = (st.recentMessages || []).find((m) => m && String(m.seq) === ref) || null;
            const localText = String(local?.text ?? local?.plain ?? '').trim();
            if (local && localText) {
              resolved = {
                info: { sender: String(local.sender ?? ''), text: localText, userId: local.userId ?? null },
                messageId: local.messageId ?? null
              };
            }
          }
          if (!resolved) {
            rollbackRepeat();
            sendJson({ ok: false, error: '找不到这条消息（可能太旧或已被撤回）；可以先用 qq_get_recent_messages 看一眼再试' }, 400);
            return;
          }
          const repeatText = String(resolved.info?.text ?? '').trim();
          if (!repeatText) {
            rollbackRepeat();
            sendJson({ ok: false, error: '这条消息里没有可以复读的文字（图片/表情/语音不能 +1）' }, 400);
            return;
          }
          if (repeatText.length > maxChars) {
            rollbackRepeat();
            sendJson({ ok: false, error: `这条消息太长（${repeatText.length} 字 > ${maxChars} 字上限），不适合复读` }, 400);
            return;
          }
          if (SENSITIVE_RE.test(repeatText)) {
            rollbackRepeat();
            sendJson({ ok: false, error: '这条消息含敏感信息，不复制' }, 403);
            return;
          }
          // 复读自己刚说的话不算 +1。两条判据：本地记录里的 isSelf，以及网关给回来的 userId。
          const localHit = (st.recentMessages || []).find((m) => m && (String(m.seq) === ref || String(m.messageId) === ref));
          const repeatFromId = String(resolved.info?.userId ?? '').trim();
          if (localHit?.isSelf === true || (selfUserId && repeatFromId && repeatFromId === selfUserId)) {
            rollbackRepeat();
            sendJson({ ok: false, error: '不能复读自己刚说的话（+1 是接别人的话）' }, 400);
            return;
          }
          try {
            // 不带引用、不带 @：真 +1 就是光秃秃地把同一句再发一遍。
            const sentMessages = await sendMessagesV2(key, [repeatText], [0], undefined, null);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            const preview = repeatText.slice(0, 30);
            log(`[reserved2] +1 复读 ${key}: ${preview}`);
            appendActivity(`${key} [reserved2] +1 复读：${preview}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({
              ok: true,
              key,
              repeated: repeatText,
              fromSender: String(resolved.info?.sender ?? ''),
              fromMessageId: String(resolved.messageId ?? ''),
              sent: sentMessages.length
            });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] +1 复读部分成功（已发出 ${error.sent.length} 条），已记录已发消息`);
            } else {
              rollbackRepeat();
            }
            log(`[reserved2] +1 复读失败 ${key}:`, errorText(error));
            sendJson({ ok: false, error: `+1 失败：${errorText(error)}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${errorText(error)}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          // /api/voice/send 对带 agent token 的请求是可达的（外层把 /api/voice/* 放给 agent，
          // 见 agent 路径白名单）。以前它一路按操作者通道走完：不查 v2SessionAllowed /
          // v2ToolEnabled('sendVoice') / socialV2.voice.enabled，还允许任意本机绝对路径音频，
          // 并且额度记在 'operator:cli' 桶里 —— 等于 AI 拿到 agent token 就能借这条通道
          // 给白名单内任意会话发本机任意音频、还绕开自己的语音额度。
          // 现在：带 agent token 时按 AI 规则判定，文件也必须落在语音库内，额度按会话记。
          const agentVoiceCall = url.pathname === '/api/voice/send' && Boolean(agentToken);
          if (agentVoiceCall) {
            if (!agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
            if (cfg.socialV2?.voice?.enabled === false) { sendJson({ ok: false, error: '语音功能已关闭（socialV2.voice.enabled=false）' }, 403); return; }
          }
          let resolved;
          try {
            resolved = agentVoiceCall
              ? resolveVoicePathForV2(body.file ?? body.path ?? '')
              : resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds, ffmpegPath: voice.ffmpegPath });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          // AI 借用这条通道时，额度要记在会话桶里（和 /api/socialV2/send-voice 同一个桶），
          // 否则 AI 的语音额度可以被这条通道整片绕过。
          const voiceScope = agentVoiceCall ? key : 'operator:cli';
          try {
            voiceBudgetCheck(voiceScope, voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit(voiceScope, now);
            log(`[voice] (${agentVoiceCall ? 'agent' : '操作者'}) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (${agentVoiceCall ? 'agent' : '操作者'}) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${errorText(error)}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          // 两条调用方：① AI（带 x-agent-token，只能发自己那个会话）② 控制台「合成并试发」
          // （只带 x-console-token）。以前这里无条件要 agent token，导致控制台按了按钮只会得到
          // 「reserved2 模式发送必须携带 agent token」——它本来就不该有 agent token。
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleHeader = String(req.headers['x-console-token'] ?? '').trim();
          const consoleOk = Boolean(consoleHeader) && consoleHeader === String(cfg.consoleToken ?? '');
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token（或控制台令牌）' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          // 工具开关与「静默模式」是给 AI 通道设的闸；控制台试发等同操作者通道，不受它们限制
          // （否则关掉 qq_send_voice 后，控制台连试听都做不了，跟 /api/voice/send 的口径也不一致）。
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 要念出来的那句话同样是出站文本：身份守卫先看一眼（TTS 合成有成本，拦在前面更省钱）。
          if (agentCall) {
            const guardMsg = identityGuardBlockReason(body.text ?? '', key);
            if (guardMsg) { sendJson({ ok: false, error: guardMsg }, 403); return; }
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          // text（TTS）在这里就会真的合成（有缓存，第二次是零成本），dryRun 也不例外。
          let prepared;
          try {
            prepared = await prepareVoiceForV2(key, {
              voice: body.voice ?? body.file ?? '',
              text: body.text ?? '',
              ttsVoice: body.ttsVoice ?? body.tts_voice ?? '',
              ttsRate: body.ttsRate ?? body.tts_rate ?? ''
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(prepared.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds, ffmpegPath: voice.ffmpegPath });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({
                ok: true,
                dryRun: true,
                key,
                file: path.basename(prepared.path),
                via: prepared.via,
                tts: prepared.tts,
                detail: describeAudio(probe)
              });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              text: body.text ?? '',
              ttsVoice: body.ttsVoice ?? body.tts_voice ?? '',
              ttsRate: body.ttsRate ?? body.tts_rate ?? '',
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // tts 非空表示这条语音是现场合成的：text 是真正被念出来的那句话
              tts: sent.tts ?? null,
              spoken: sent.tts?.text ?? null,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 图片发送（AI 通道 + 控制台试发） ────────────────────────────────────
        //
        // 双调用方与 /api/socialV2/send-voice 相同：
        //   ① AI（带 x-agent-token）：只能发自己那个会话，且只能取图片库内文件或公网图片 URL；
        //   ② 控制台（只带 x-console-token）：等同操作者通道，可以发库外文件（调试用）。
        // AI 侧多一道 tools.sendImage 闸门（默认 false）；控制台不受它限制 ——
        // 否则"默认关"会变成"连放张图试一下都做不到"，与 /api/voice/send 的口径也不一致。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const mc = mediaCfg(cfg, ROOT);
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleHeader = String(req.headers['x-console-token'] ?? '').trim();
          const consoleOk = Boolean(consoleHeader) && consoleHeader === String(cfg.consoleToken ?? '');
          if (!mc.enabled) { sendJson({ ok: false, error: '图片发送已关闭（socialV2.media.enabled=false）' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token（或控制台令牌）' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !sendImageToolEnabled(cfg)) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (agentCall && shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (agentCall) {
            const guardMsg = identityGuardBlockReason(body.text ?? '', key);
            if (guardMsg) { sendJson({ ok: false, error: guardMsg }, 403); return; }
          }
          try {
            sendJson(await performImageSend(key, body, { agentCall, operator: !agentCall }));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, error?.status ?? 400);
          }
          return;
        }

        // ── 图片发送（操作者通道：控制台 / CLI，凭 consoleToken） ────────────────
        //
        // 为什么单开 /api/media/send-image 而不是复用 /api/socialV2/send-image：
        //   ① 操作者可能不在任何 QQ 会话里，也不该受"仅 reserved2 + 图片工具开关"的限制；
        //   ② /api/media/ 不在上面的 agent 路径白名单里 —— 带 x-agent-token 的请求根本到不了
        //      这里，不像 /api/voice/send 那样还得补一段 agent 分支去堵"AI 借操作者通道发库外
        //      文件"。这里仍然显式再拒一次，防止以后有人顺手把 /api/media/ 加进白名单时，
        //      静默开出一条"AI 可发本机任意图片"的旁路。
        // 边界：这条通道**有意**允许库外文件（操作者本来就能读本机文件），但体积/格式/像素
        // 校验、外发审计、限流一个都不少；且不受 media.enabled / tools.sendImage 限制。
        if (req.method === 'POST' && url.pathname === '/api/media/send-image') {
          const body = await readBody();
          if (req.headers['x-agent-token']) {
            sendJson({ ok: false, error: 'AI 请改用 /api/socialV2/send-image（带 key + token）' }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          try {
            sendJson(await performImageSend(key, body, { agentCall: false, operator: true }));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, error?.status ?? 400);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-music') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const mc = cfg.socialV2?.music ?? {};
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleHeader = String(req.headers['x-console-token'] ?? '').trim();
          const consoleOk = Boolean(consoleHeader) && consoleHeader === String(cfg.consoleToken ?? '');
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token（或控制台令牌）' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendMusic')) { sendJson({ ok: false, error: '工具未启用：qq_send_music' }, 403); return; }
          if (agentCall && shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (agentCall) {
            const guardMsg = identityGuardBlockReason(body.text ?? '', key);
            if (guardMsg) { sendJson({ ok: false, error: guardMsg }, 403); return; }
          }
          try {
            sendJson(await performMusicSend(key, body, { agentCall, operator: !agentCall }));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, error?.status ?? 400);
          }
          return;
        }

        // ── 音乐卡片（操作者通道：控制台 / CLI，凭 consoleToken）────────────────
        //
        // 与 /api/media/send-image 同一条纪律：/api/media/ 不在 agent 路径白名单里，带
        // x-agent-token 的请求根本到不了这里；仍然显式再拒一次，防止以后有人顺手把
        // /api/media/ 加进白名单时静默开出一条 AI 旁路。
        // 操作者通道**有意**不受 tools.sendMusic 限制（否则关掉工具后连试发都做不了），
        // 但白名单、参数校验、限流、审计一个都不少。
        if (req.method === 'POST' && url.pathname === '/api/media/send-music') {
          const body = await readBody();
          if (req.headers['x-agent-token']) {
            sendJson({ ok: false, error: 'AI 请改用 /api/socialV2/send-music（带 key + token）' }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          try {
            sendJson(await performMusicSend(key, body, { agentCall: false, operator: true }));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, error?.status ?? 400);
          }
          return;
        }

        // ── 群管理（AI 通道）────────────────────────────────────────────────────
        //
        // 与 reminders / self-status / send-music 同构的闸门顺序，但**多一道**：
        // 「AI 只能操作自己那个会话对应的群」。原因是群管理的作用对象在别的群：
        // 一个群里的模型如果能凭 body.groupId 去踢另一个群的人，那 session 令牌就
        // 不再等于"这个会话的权力边界"了。所以 AI 通道的 groupId 一律由 key 推导，
        // body 里的 groupId 只用来**做一致性检查**（不一致就 403，不是静默覆盖 ——
        // 静默覆盖会让模型以为它操作的是自己写的那个群）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/group-admin') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleHeader = String(req.headers['x-console-token'] ?? '').trim();
          const consoleOk = Boolean(consoleHeader) && consoleHeader === String(cfg.consoleToken ?? '');
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: '未授权' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: '缺少会话令牌' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('groupAdmin')) { sendJson({ ok: false, error: '工具未启用：qq_group_admin' }, 403); return; }
          if (agentCall && shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许执行群管理', reason: 'silent-mode' }, 403); return; }
          const m = /^group:(\d+)$/.exec(key);
          if (!m) {
            sendJson({ ok: false, error: '群管理只能在群会话里发起（key 必须是 group:群号）；私聊会话没有可管理的群' }, 403);
            return;
          }
          const bodyGroupId = String(body.groupId ?? '').trim();
          if (bodyGroupId && bodyGroupId !== m[1]) {
            sendJson({ ok: false, error: `AI 只能管理自己所在的群（本会话 ${key}，请求里写的是 ${bodyGroupId}）` }, 403);
            return;
          }
          try {
            // 注意：**不能**在这里把 m[1] 塞进 body.groupId。performGroupAdmin 要靠
            // "调用方是否显式写了 groupId" 来判定高危动作该不该 400（见 assertGroupAdminShape），
            // 端点上硬塞会让 `{op:'kick'}` 被当成"参数齐全"送进审批闸门。推导交给它自己。
            sendJson(await performGroupAdmin(key, body, { operator: false, sourceLabel: agentCall ? 'AI' : '控制台' }));
          } catch (error) {
            // 分流顺序很重要：
            //   · `shapeError`（assertGroupAdminShape 抛的）= 参数写错了，**永远 400**。
            //   · needApproval 是**业务结果**（"要先找管理员批"），不是错误参数 —— 记 403。
            // 之所以不能用 `status === 400` 分流：groupAdminParamsFor 抛出的
            // 「需要审批」也带了一个 400 的默认状态，若按状态判就会把"要审批"说成"填错了"。
            if (error?.shapeError) { sendJson({ ok: false, error: error?.message ?? String(error) }, 400); return; }
            if (error?.needApproval) {
              sendJson({ ok: false, needApproval: true, error: error?.message ?? String(error) }, 403);
              return;
            }
            sendJson({ ok: false, error: error?.message ?? String(error) }, error?.status ?? 400);
          }
          return;
        }

        // ── 群管理（操作者通道：控制台 / CLI，凭 consoleToken）──────────────────
        //
        // 与 /api/media/send-music 同一条纪律：/api/ 下不在 agent 路径白名单里，
        // 但仍显式拒 x-agent-token —— 防止以后有人把 /api/group-admin 加进白名单时
        // 静默开出一条能踢人的 AI 旁路。
        // 操作者通道**有意**不受 tools.groupAdmin 限制（关掉工具的人仍然要能管理群），
        // 但白名单、参数校验、dryRun、审计一个都不少；且**只有这里**能传 allowDangerous:true。
        if (req.method === 'POST' && url.pathname === '/api/group-admin') {
          const body = await readBody();
          if (req.headers['x-agent-token']) {
            sendJson({ ok: false, error: 'AI 请改用 /api/socialV2/group-admin（带 key + token）' }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          try {
            sendJson(await performGroupAdmin(key, body, { operator: true, sourceLabel: '操作者' }));
          } catch (error) {
            if (error?.needApproval) {
              sendJson({ ok: false, needApproval: true, error: error?.message ?? String(error) }, 403);
              return;
            }
            sendJson({ ok: false, error: error?.message ?? String(error) }, error?.status ?? 400);
          }
          return;
        }

        // ── 群管理：待办申请 + 待审批动作（AI 通道，供 qq_list_requests）──────────
        //
        // 为什么必须存在：申请事件（bot.onRequest）只把记录写进 st.pendingRequests 与消息流。
        // 模型在提示词里能看到"收到一条入群申请"，但要拿到**flag**（approveFriend / approveGroup
        // 的必需参数）就只能靠这个端点 —— 猜不出来，也不该让模型去翻 state 文件。
        //
        // 只读：不发消息、不写状态。路径放在 /api/socialV2/ 下，因为 agent 路径白名单
        // （见全局鉴权那段）只放行这个前缀 + /api/status、/api/send/、/api/images/、
        // /api/voice/、/api/authorize/read。
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/group-requests') {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          // 与其他 AI 端点同一条纪律：会话令牌只认 x-agent-token 头（`?token=` 在外层是控制台令牌）。
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleHeader = String(req.headers['x-console-token'] ?? '').trim();
          const consoleOk = Boolean(consoleHeader) && consoleHeader === String(cfg.consoleToken ?? '');
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: '未授权' }, 403); return; }
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号（号码必须是正整数）' }, 400); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: '缺少会话令牌' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('groupAdmin')) { sendJson({ ok: false, error: '工具未启用：qq_list_requests' }, 403); return; }
          if (agentCall && currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const st = getSocialV2State(key);
          const requests = listPendingRequests(key);
          // 挂起中的高危审批也一并报出来：不然模型会以为"我发了 kick 但没有任何后续"。
          const approvals = [];
          for (const [pKey, p] of pending) {
            if (!p || p.kind !== 'group-admin' || pKey !== key) continue;
            approvals.push(groupAdminPendingView(pKey, p));
          }
          sendJson({
            ok: true,
            key,
            requests,
            requestsCount: requests.length,
            approvals,
            approvalsCount: approvals.length,
            hint: requests.length
              ? '用 qq_group_admin + op:"approveGroup"（或 approveFriend）并把 flag 原样回传即可批准/拒绝；flag 就来自上面的 requests。'
              : '当前没有待处理的好友/入群申请。'
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${errorText(error)}`);
            sendJson({ ok: false, error: `发送表情失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${errorText(error)}`);
            sendJson({ ok: false, error: `收藏表情失败：${errorText(error)}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds, ffmpegPath: voice.ffmpegPath });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            const tts = voiceCfg().tts;
            // 本地音色表：优先问 HoYo TTS 服务要全量 251 个（带 2s 缓存）；
            // 服务没起就退回 tts.js 里那 8 个兜底条目 —— 控制台至少还有东西可选。
            const remoteLocal = await localVoicesCached(tts.localUrl, { timeoutMs: 2500 });
            // RVC 变声音色（牧濑红莉栖）排在最前：它不依赖 HoYo 服务，只要 tools/rvc-local 在。
            const rvcVoices = TTS_RVC_VOICES.map((v) => ({ ...v }));
            const localVoices = [
              ...rvcVoices,
              ...(remoteLocal?.length ? [...remoteLocal, ...TTS_VOICES] : [...TTS_LOCAL_VOICES, ...TTS_VOICES])
            ];
            // AI 通道只发「常用的那几个」：全量 251 条 JSON 约 16KB（≈5K token / 次），
            // 而模型真正用得上的就是默认音色 + 几个常见角色；控制台面板（人挑冷门角色）
            // 仍然拿全量。想用冷门角色可以自己拼 local:hoyo:<编号>（0~250）。
            const curatedNames = new Set(TTS_LOCAL_VOICES.map((v) => v.name));
            const agentVoices = [
              ...rvcVoices,
              // 按精选表顺序排（派蒙在最前，模型更可能直接用默认那几个），拿不到远端条目就用精选兜底
              ...TTS_LOCAL_VOICES.map((c) => localVoices.find((v) => v.name === c.name) ?? c),
              ...TTS_VOICES.filter((v) => !curatedNames.has(v.name))
            ];
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // 文字转语音（edge + 本机 HoYo TTS）：不用准备语音包也能说任意一句话，这才是最常用的路径。
              tts: {
                enabled: tts.enabled,
                default: tts.voice,
                provider: tts.provider,
                rate: tts.rate,
                maxChars: tts.maxChars,
                cache: agentCall ? undefined : ttsCacheStats(tts.dir),
                voices: agentCall ? agentVoices : localVoices,
                local: {
                  url: agentCall ? undefined : tts.localUrl,
                  enabled: localVoices.length > 0,
                  speakers: localVoices.length,
                  hint: agentCall ? '' : (localVoices.length
                    ? '本地 HoYo TTS 角色音色可用：ttsVoice 传 local:hoyo:<编号>，如 local:hoyo:129（派蒙）'
                    : '本地 HoYo TTS 服务没起或连不上：先跑 tools/tts-local/start-tts.ps1，再试 local:hoyo:129')
                },
                hint: '想说话直接给 qq_send_voice 传 text（桥接现场合成）；ttsVoice 可选音色，不传就用 default'
              },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '最常用：传 text 让桥接现场合成一句话（TTS）；也可以传 voice 把语音库里已有的音频当语音发出去'
                : (agentCall
                  ? '语音库为空，但可以直接传 text 让桥接现场合成（TTS）'
                  : `语音库为空：把音频文件放进 ${voice.dir} 后重试（也可以直接用 text 走 TTS）`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${errorText(error)}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${errorText(error)}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          if (activeWaits.has(key) && Date.now() - activeWaits.get(key) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.set(key, Date.now());
          const finishWait = () => activeWaits.delete(key);
          // ⚠️ 必须挂 res 的 close，不能挂 req 的。
          //
          // 这里已经 await 过 readBody()：Node ≥16 下，请求体的 'close' 事件在 body 读完那一刻
          // 就发出（实测顺序 `1 end → 2 close → 3 续体`），所以 `req.on('close')` 注册在这之后
          // **永远不会触发** —— 租约只能靠 ACTIVE_WAIT_LEASE_MS 兜底过期，客户端断开也感知不到，
          // `aborted` 恒为 false。res 的 'close' 在响应结束或连接断开时触发，才是想要的那个信号。
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          // 同上：req 的 close 早就发过了，客户端断开只能靠 res 的 close 感知。
          res.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            // （这一条只对 reply 分支成立；下面的 messages 分支有意允许在 timeoutMs 之后再补一个
            //   quietMs 静默窗口，见 6630 附近的注释，两者不要混着看。）
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${errorText(error)}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, errorText(error));
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${errorText(error)}`);
            sendJson({ ok: false, error: `合并转发查询失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, errorText(error));
            sendJson({ ok: false, error: `转发媒体读取失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          // 主人 m01652：黑话要"在群聊里选出现次数多的词"。这里只做**提示**、不做拦截 ——
          // 硬拦会让她再收到一次"被桥接拒绝"（她已经被拒怕了），而且窗口可能刚被提取清空。
          // 真正的门槛在自动提取的 selectExtractionItems 里（新词 < minGroupCount 直接丢）。
          const groupHits = slangGroupHitCount(content);
          const minGroupHits = Math.max(1, Number(cfg.slang?.minGroupCount) || 2);
          const freqWarning = groupHits < minGroupHits
            ? `这个词最近在群聊窗口里只见到 ${groupHits} 次（群黑话一般要 ≥${minGroupHits} 次）：已按候选收录，但请只提交群里反复出现过的词。`
            : '';
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing), ...(freqWarning ? { warning: freqWarning } : {}) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing), ...(freqWarning ? { warning: freqWarning } : {}) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry), ...(freqWarning ? { warning: freqWarning } : {}) });
          return;
        }
        // ── 到点提醒（reminders）────────────────────────────────────────────
        // 双通道判定照抄 /api/socialV2/send-image：MCP 进程**同时**带 x-console-token 与
        // x-agent-token，所以「带 x-agent-token 就算 AI 调用」；只有控制台页面/CLI
        // （仅带 x-console-token）走操作者分支，操作者可以查/操作任意 key。
        // ── 自省（self-status）：让我在说话之前知道自己现在什么样、多贵、还能说几句 ──────
        //
        // 双通道，与 reminders / history 同构：
        //   ① AI（带 x-agent-token）：只能查**自己那个会话**，且受 tools.status（默认开）限制；
        //   ② 操作者（控制台令牌）：可查任意会话，不受工具开关限制 —— 否则关掉工具后
        //      连"看看它现在多重"都做不到。
        // 只读：不发消息、不写状态。花费读取失败只让【花费】段消失，不让整个接口失败。
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/self-status') {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          // 与 reminders 同一条纪律：会话令牌只认 x-agent-token 头。查询串里的 `token`
          // 在外层是**控制台令牌**（全局鉴权优先读它），把会话令牌塞进 `?token=` 会被
          // 拿去比控制台令牌而直接 401。
          const token = String(req.headers['x-agent-token'] ?? (req.method === 'GET' ? url.searchParams.get('token') : body.token) ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleOk = req.headers['x-console-token'] === cfg.consoleToken;
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: '未授权' }, 403); return; }
          // key 形状先判：不给 / 写错 key 是**参数问题（400）**，不是鉴权问题。
          // 顺序在这里是有意义的：`agentTokenOk(key, token)` 对一个格式非法的 key 必然返回 false，
          // 若先做令牌校验，`?key=abc` 会得到 403 `agent token 无效` —— 把「你参数写错了」
          // 说成「你没权限」，调模型的人会以为是令牌过期而反复重取令牌。先 400 把话说准。
          // 用 canonicalV2Key 而不是 isValidSessionKey：后者只认 `^(group|private):\d+$`，
          // `group:0` 能过它、却永远不可能对应任何会话，于是会掉进下面的 403 `agent token 无效`。
          if (!canonicalV2Key(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号（号码必须是正整数）' }, 400); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: '缺少会话令牌' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const gate = checkSelfStatusRequest({ key, agentCall });
          if (!gate.ok) { sendJson({ ok: false, error: gate.error }, gate.status); return; }
          const includeCost = !agentCall || cfg.socialV2?.status?.includeCost !== false;
          let status;
          try {
            status = buildSelfStatusSnapshot({ key, includeCost });
          } catch (error) {
            // 聚合层已经逐段兜底；真到这里说明连文本组装都失败了 —— 也要给出可读错误而不是 500 空白。
            log(`[self-status] 组装失败：${errorText(error)}`);
            sendJson({ ok: false, error: `自省组装失败：${errorText(error)}` }, 500);
            return;
          }
          sendJson({
            ok: true,
            key,
            text: status.text,
            data: status.data,
            warnings: status.warnings,
            truncated: status.truncated,
            maxChars: SELF_STATUS_MAX_CHARS
          });
          return;
        }

        // ── 自省（操作者通道：控制台 / CLI，凭 consoleToken）────────────────────
        //
        // 为什么单开 /api/self-status 而不是复用 /api/socialV2/self-status：
        //   ① 操作者可能不在任何 QQ 会话里，也不该受"仅 reserved2 + tools.status"的限制；
        //   ② /api/ 下不在 agent 路径白名单里 —— 带 x-agent-token 的请求根本到不了这里，
        //      不像 /api/voice/send 那样还得补一段 agent 分支。这里仍显式再拒一次，
        //      防止以后有人顺手把 /api/self-status 加进白名单时静默开出一条 AI 旁路。
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/self-status') {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          if (req.headers['x-agent-token']) {
            sendJson({ ok: false, error: 'AI 请改用 /api/socialV2/self-status（带 key + x-agent-token）' }, 403);
            return;
          }
          // 操作者**允许省略 key**（看"这台桥接整体怎么样"），此时给全局视角的摘要；
          // 给了 key 就一定是合法会话 key，否则明确 400 而不是悄悄退化。
          if (key && !isValidSessionKey(key)) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          let status;
          try {
            status = buildSelfStatusSnapshot({ key, includeCost: cfg.socialV2?.status?.includeCost !== false });
          } catch (error) {
            log(`[self-status] 组装失败：${errorText(error)}`);
            sendJson({ ok: false, error: `自省组装失败：${errorText(error)}` }, 500);
            return;
          }
          sendJson({
            ok: true,
            key: key || null,
            text: status.text,
            data: status.data,
            warnings: status.warnings,
            truncated: status.truncated,
            maxChars: SELF_STATUS_MAX_CHARS
          });
          return;
        }

        if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/socialV2/reminders') {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          // 会话令牌优先看头：`?token=` 在外层是**控制台令牌**（全局鉴权优先读它），
          // 智能体调用一律只走 x-agent-token 头，避免会话令牌被查询串顶掉后在外层 401。
          const token = String(req.headers['x-agent-token'] ?? (req.method === 'GET' ? url.searchParams.get('token') : body.token) ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleOk = req.headers['x-console-token'] === cfg.consoleToken;
          if (!isValidSessionKey(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: '未授权' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: '缺少会话令牌' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('reminders')) { sendJson({ ok: false, error: '工具未启用：qq_set_reminder / qq_list_reminders' }, 403); return; }
          const store = remindersStore();
          if (req.method === 'GET') {
            const includeDoneRaw = String(url.searchParams.get('includeDone') ?? '').trim().toLowerCase();
            const includeDone = includeDoneRaw === '1' || includeDoneRaw === 'true';
            const items = store.list({ key, includeDone });
            sendJson({ ok: true, key, count: items.length, items, stats: store.stats() });
            return;
          }
          const action = (String(body.action ?? '').trim() || 'add');
          if (!['add', 'cancel', 'cancelAll'].includes(action)) { sendJson({ ok: false, error: 'action 只能是 add / cancel / cancelAll' }, 400); return; }
          if (action === 'add') {
            const text = redactKnownTokensOnly(String(body.text ?? '')).trim();
            if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
            const due = resolveReminderDueAtV2(body);
            if (!due.ok) { sendJson({ ok: false, error: due.error }, 400); return; }
            const repeat = String(body.repeat ?? 'none').trim() || 'none';
            if (!REMINDER_REPEATS.includes(repeat)) { sendJson({ ok: false, error: `repeat 只能是 ${REMINDER_REPEATS.join(' / ')}` }, 400); return; }
            const res = store.add({ key, text, dueAt: due.value, createdBy: agentCall ? `agent:${key}`.slice(0, 64) : 'operator', repeat });
            if (!res.ok) { sendJson({ ok: false, error: res.error }, 400); return; }
            log(`[reserved2] 新增提醒 ${key}（${res.item.id}，${res.item.dueText}${repeat === 'none' ? '' : `，${repeat}`}）：${text.slice(0, 40)}`);
            sendJson({ ok: true, action: 'add', key, item: res.item, stats: store.stats() });
            return;
          }
          if (action === 'cancel') {
            const id = String(body.id ?? '').trim();
            if (!id) { sendJson({ ok: false, error: 'cancel 需要 id（用 qq_list_reminders 查）' }, 400); return; }
            const cancelled = store.cancel({ key, id });
            log(`[reserved2] 取消提醒 ${key}（${id}）：${cancelled} 条`);
            sendJson({ ok: true, action: 'cancel', key, id, cancelled, stats: store.stats() });
            return;
          }
          const cancelled = store.cancelAll({ key });
          log(`[reserved2] 清空提醒 ${key}：${cancelled} 条`);
          sendJson({ ok: true, action: 'cancelAll', key, cancelled, stats: store.stats() });
          return;
        }
        // ── 历史检索（history-archive）──────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/history/search') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleOk = req.headers['x-console-token'] === cfg.consoleToken;
          const query = redactKnownTokensOnly(String(body.query ?? '')).trim();
          if (!isValidSessionKey(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: '未授权' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: '缺少会话令牌' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('searchHistory')) { sendJson({ ok: false, error: '工具未启用：qq_search_history' }, 403); return; }
          if (!historyEnabledV2()) { sendJson({ ok: false, error: '历史检索已关闭（socialV2.history.enabled=false）' }, 403); return; }
          if (!query) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
          if (query.length > HISTORY_LIMITS.maxQueryChars) { sendJson({ ok: false, error: `query 过长（最多 ${HISTORY_LIMITS.maxQueryChars} 字）` }, 400); return; }
          let limit = 20;
          if (body.limit !== undefined && body.limit !== null && String(body.limit).trim() !== '') {
            const n = Number(body.limit);
            if (!Number.isFinite(n) || n < 1 || n > HISTORY_LIMITS.maxHits) { sendJson({ ok: false, error: `limit 必须是 1~${HISTORY_LIMITS.maxHits} 的整数` }, 400); return; }
            limit = Math.floor(n);
          }
          const since = optionalMsParamV2(body.sinceMs, 'sinceMs');
          if (!since.ok) { sendJson({ ok: false, error: since.error }, 400); return; }
          const until = optionalMsParamV2(body.untilMs, 'untilMs');
          if (!until.ok) { sendJson({ ok: false, error: until.error }, 400); return; }
          const res = await historyArchive().search({ key, query, sinceMs: since.value, untilMs: until.value, limit });
          if (res?.ok === false) { sendJson({ ok: false, error: res.error || '检索失败' }, 400); return; }
          sendJson({ ok: true, key, query, hits: res?.hits ?? [], scanned: res?.scanned ?? 0, truncated: res?.truncated === true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/history/stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          // 同 /api/socialV2/reminders：`?token=` 属于控制台令牌，会话令牌只认 x-agent-token 头。
          const token = String(req.headers['x-agent-token'] ?? url.searchParams.get('token') ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          const consoleOk = req.headers['x-console-token'] === cfg.consoleToken;
          if (!isValidSessionKey(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!agentCall && !consoleOk) { sendJson({ ok: false, error: '未授权' }, 403); return; }
          if (agentCall && !token) { sendJson({ ok: false, error: '缺少会话令牌' }, 403); return; }
          if (agentCall && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('searchHistory')) { sendJson({ ok: false, error: '工具未启用：qq_search_history' }, 403); return; }
          if (!historyEnabledV2()) { sendJson({ ok: false, error: '历史检索已关闭（socialV2.history.enabled=false）' }, 403); return; }
          const stats = await historyArchive().stats({ key });
          if (stats?.ok === false) { sendJson({ ok: false, error: stats.error || '读取失败' }, 400); return; }
          sendJson({ ok: true, key, stats });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${errorText(error)}`);
            sendJson({ ok: false, error: `图片查询失败：${errorText(error)}` }, 500);
          }
          return;
        }

        // ── 「听」语音：按需取某条语音消息的 QQ 转写 ──────────────────────────
        // 收到语音时桥接已经自动转过一次（转写可能要等 QQ 生成），这里是补取入口：
        // 自动那轮没赶上、或 AI 想重听某条时用。只允许读本会话最近消息里出现过的 id。
        if (req.method === 'GET' && url.pathname === '/api/voice/transcript') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取语音转写必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '语音转写工具仅 reserved2 / closed-agent 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('listenVoice')) {
            sendJson({ ok: false, error: '工具未启用：qq_listen_voice' }, 403);
            return;
          }
          // 只认本会话最近消息里的 id 或本地 seq（防止拿着别的会话的 id 乱问网关）
          const stVoice = getSocialV2State(key);
          const pool = [...(stVoice.recentMessages ?? []), ...(stVoice.unread ?? [])];
          const hit = pool.find((m) => m && (String(m.messageId ?? '') === messageId || String(m.seq) === messageId));
          if (!hit) {
            sendJson({ ok: false, error: `消息 ${messageId} 不在本会话的最近消息里，拒绝读取` }, 403);
            return;
          }
          const realId = hit.messageId ? String(hit.messageId) : messageId;
          const text = await fetchPttTextForMessage(realId);
          // 失败原因要具体（QQ 侧 error=9 / SnowLuma 20s 没等到推送 / 消息已过期），
          // 否则模型只能猜，容易回一句「你没开语音转文字」。
          const why = text ? '' : (voiceTranscriptError.get(String(realId)) || '网关没有返回文字');
          sendJson({
            ok: true,
            key,
            messageId: realId,
            seq: hit.seq,
            sender: hit.sender ?? '',
            text: text ?? '',
            note: text ? '' : `拿不到 QQ 转写：${why}`
          });
          return;
        }

        // ── 「读文件」：按需读取群聊/私聊里发过的文本文件 ────────────────────
        // 为什么不能收消息时就下载：文件可能很大（实测见过 1MB 的 txt），
        // 而绝大多数文件根本不会被问到。只在模型真的想读时再下载。
        if (req.method === 'GET' && url.pathname === '/api/files/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const maxCharsRaw = Number(url.searchParams.get('maxChars'));
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取文件必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '文件读取工具仅 reserved2 / closed-agent 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('readFile')) {
            sendJson({ ok: false, error: '工具未启用：qq_read_file' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId).filter((m) => m?.kind === 'file');
          if (!media.length) {
            sendJson({ ok: true, messageId, name: '', size: 0, text: '', note: '这条消息里没有文件（或文件元数据已过期）' });
            return;
          }
          const target = media[0];
          const fname = String(target.name ?? '').trim();
          const furl = String(target.url ?? '').trim();
          if (!furl) {
            sendJson({ ok: true, messageId, name: fname, size: Number(target.size) || 0, text: '', note: '这个文件没有可用的下载地址（QQ 直链会过期，太旧的文件就取不到了）' });
            return;
          }
          try {
            const maxBytes = Math.max(1024, Math.min(TEXT_FILE_MAX_BYTES, Number(cfg.socialV2?.media?.maxFileBytes) || TEXT_FILE_MAX_BYTES));
            // safeFetchBytes 返回的是 { url, statusCode, buffer }（和 safeFetchBuffer 同形），
            // 不是裸 Buffer —— 这里少写一个 .buffer 的话，下面会把 undefined 当字节流去解码，
            // 表现是「内容看起来不是文本（含二进制字节）」，一个看起来像文件坏了、其实是取错字段的错。
            const { buffer: buf } = await safeFetchBytes(furl, maxBytes, null, '');
            const parsed = extractTextFromFile(buf, { maxChars: Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? maxCharsRaw : TEXT_FILE_MAX_CHARS, name: fname });
            sendJson({
              ok: true,
              key,
              messageId,
              name: fname,
              size: Number(target.size) || buf.length,
              ext: fileExtension(fname),
              encoding: parsed.encoding,
              truncated: parsed.truncated,
              text: parsed.text,
              note: parsed.note
            });
          } catch (error) {
            log(`文件读取失败 ${key} ${messageId}: ${errorText(error)}`);
            sendJson({ ok: false, error: `文件下载失败：${errorText(error)}` }, 502);
          }
          return;
        }

        // ── 「点开卡片」：按 messageId 取回分享卡片的解析结果 ────────────────
        // 桥接只负责"把卡片里的链接和标题交出去"，真正的取内容（听歌/看视频）
        // 由 MCP 侧完成 —— 那边已经有 video-watch 和现成的 HTTP 抓取能力。
        if (req.method === 'GET' && url.pathname === '/api/cards/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取卡片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '卡片工具仅 reserved2 / closed-agent 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('openCard')) {
            sendJson({ ok: false, error: '工具未启用：qq_open_card' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId).filter((m) => m?.kind === 'card');
          if (!media.length) {
            sendJson({ ok: true, messageId, card: null, note: '这条消息里没有卡片（或卡片元数据已过期）' });
            return;
          }
          const card = media[0];
          // rich-card 的几个判定函数都要求 `ok:true` 且 `kind` 字段（存储里叫 cardKind），
          // 这里补成一个"正常的卡片对象"再复用它们，别在存储形状上另写一套判定。
          const shaped = {
            ok: true,
            kind: card.cardKind ?? 'card',
            title: card.title ?? '',
            desc: card.desc ?? '',
            url: card.url ?? '',
            audioUrl: card.audioUrl ?? '',
            image: card.image ?? '',
            source: card.source ?? '',
            extra: {}
          };
          sendJson({
            ok: true,
            key,
            messageId,
            card: {
              kind: shaped.kind,
              title: shaped.title,
              desc: shaped.desc,
              url: shaped.url,
              audioUrl: shaped.audioUrl,
              image: shaped.image,
              source: shaped.source
            },
            neteaseSongId: neteaseSongIdFromCard(shaped),
            bilibiliId: bilibiliIdFromCard(shaped),
            music: isMusicCard(shaped)
          });
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          // 身份守卫只拦智能体通道（带 token 的调用）；操作者用 CLI 发什么都不动。
          if (token) {
            const guardMsg = identityGuardBlockReason(message, key);
            if (guardMsg) { sendJson({ ok: false, error: guardMsg }, 403); return; }
          }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // st/now 必须在 try 外：catch 里的额度回滚（sendTimes.indexOf(now)）也要用它们。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          const result = await resetSessionContext(key, { reason: '控制台' });
          if (!result) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sendJson({ ok: true, key, archived: result.oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${errorText(error)}；请在 DSH 检查旧任务`); }
                try { await api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; }
                catch (error) { log(`⚠️ 归档会话失败 ${item.sessionId}：${errorText(error)}`); }
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          saveSlangWindowsNow();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', errorText(error)); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', errorText(error)); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        // ── 记忆大脑（memory-brain）：长期记忆库的只读视图 + 手动动作 ────────────
        // 统一约定：config.memoryBrain.enabled=false（或开库失败）时**所有** memory-brain 端点
        // 都回 {ok:false,disabled:true}，前端据此显示「未开启」——不要用 404，
        // 否则前端分不清「没这个功能」和「功能关着」。
        if (url.pathname === '/api/memory-brain' || url.pathname.startsWith('/api/memory-brain/')) {
          if (!memoryBrain) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '记忆大脑未开启（config.memoryBrain.enabled）' });
            return;
          }
          try {
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/overview') {
              sendJson(memoryBrainOverviewPayload());
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/list') {
              const result = memoryBrain.list({
                kind: String(url.searchParams.get('kind') || ''),
                status: String(url.searchParams.get('status') || ''),
                limit: Number(url.searchParams.get('limit')) || 50,
                offset: Number(url.searchParams.get('offset')) || 0
              });
              sendJson({ ok: true, total: result.total, items: result.items.map(memoryBrainListItem) });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/search') {
              const query = String(url.searchParams.get('q') || '').trim();
              if (!query) {
                sendJson({ ok: true, items: [] });
                return;
              }
              const group = String(url.searchParams.get('chatType') || '') === 'group';
              const round4 = (value) => Number((Number(value) || 0).toFixed(4));
              const items = memoryBrain.search({
                query,
                visibility: group ? 'group' : 'private',
                limit: 20,
                touch: false
              }).map((item) => ({
                id: item.id,
                kind: item.kind,
                text: item.text,
                score: round4(item.score),
                parts: {
                  semantic: round4(item.parts?.semantic),
                  keyword: round4(item.parts?.keyword),
                  graph: round4(item.parts?.graph),
                  importance: round4(item.parts?.importance),
                  freshness: round4(item.parts?.freshness)
                }
              }));
              sendJson({ ok: true, items });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/graph') {
              const graph = memoryBrain.exportGraph({ limit: Number(url.searchParams.get('limit')) || 60 });
              sendJson({ ok: true, nodes: graph.nodes, edges: graph.edges });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/galaxy') {
              // 记忆星系（public/galaxy.html 用）：三维投影由 memory-brain 自己算，这里只夹 limit。
              const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 600));
              const galaxy = memoryBrain.galaxy({ limit });
              sendJson({ ok: true, nodes: galaxy.nodes, links: galaxy.links, meta: galaxy.meta });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/health') {
              const detail = memoryBrain.healthDetail();
              sendJson({ ok: true, items: detail.counts, sample: detail.sample });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/memory-brain/eval') {
              // 自评：拿库里每条文本前缀当查询，看能不能召回自己（前端「跑一遍」带 run=1）。
              const run = String(url.searchParams.get('run') || '') === '1';
              const result = run
                ? memoryBrain.evalRecall({})
                : { caseCount: 0, recallAt1: 0, recallAt3: 0, mrr: 0, p50Ms: 0, hits: 0 };
              sendJson({ ok: true, ran: run, ...result });
              return;
            }
            if (req.method === 'POST' && url.pathname === '/api/memory-brain/action') {
              const body = await readBody();
              const action = String(body.action || '').trim();
              const ids = Array.isArray(body.ids)
                ? body.ids.map(Number).filter(Number.isFinite)
                : (Number.isFinite(Number(body.id)) ? [Number(body.id)] : []);
              let changed = 0;
              if (action === 'archive' || action === 'restore' || action === 'delete') {
                if (!ids.length) {
                  sendJson({ ok: false, error: '这个动作需要 id 或 ids' }, 400);
                  return;
                }
                if (action === 'archive') changed = memoryBrain.archive({ ids }).changed;
                else if (action === 'restore') changed = memoryBrain.restore({ ids }).changed;
                else changed = memoryBrain.remove({ ids }).changed;
              } else if (action === 'decay') {
                changed = memoryBrain.decay().changed || 0;
              } else if (action === 'purge') {
                changed = memoryBrain.purge().changed || 0;
              } else if (action === 'merge') {
                changed = memoryBrain.mergeSimilar().merged || 0;
              } else if (action === 'health-fix') {
                changed = memoryBrain.healthFix().changed || 0;
              } else if (action === 'distill') {
                const facts = memoryBrain.distillFacts();
                const lessons = memoryBrain.distillLessons();
                changed = (facts.inserted || 0) + (lessons.inserted || 0);
              } else if (action === 'reindex') {
                changed = memoryBrain.reindex().changed || 0;
              } else if (action === 'consolidate') {
                // 手动把「聊完但没攒满窗口」的会话立刻总结成 episode（星系里立刻长星）
                const result = consolidateIdleMemoryWindows('手动', { idleMs: 0 });
                sendJson({ ok: true, changed: result.summarized, sessions: result.sessions });
                return;
              } else {
                sendJson({ ok: false, error: 'action 只能是 archive / restore / delete / decay / purge / merge / health-fix / distill / reindex / consolidate' }, 400);
                return;
              }
              sendJson({ ok: true, changed });
              return;
            }
            sendJson({ ok: false, error: '记忆大脑接口不存在' }, 404);
            return;
          } catch (error) {
            sendJson({ ok: false, error: `记忆大脑接口失败：${errorText(error)}` }, 500);
            return;
          }
        }
        // ── 人物七层（情绪 / 画像 / 反思 / 技能 / 语感 / 自我语感 / 生活）──────────
        // 和 /api/memory-card 同一套鉴权：能走到这里说明已经过了控制台令牌校验。
        // 约定同记忆大脑：某一层没开（或创建失败）回 {ok:false,disabled:true}，不回 404。
        if (url.pathname === '/api/emotion' || url.pathname === '/api/emotion/action') {
          if (!personaState) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '情绪层未开启（config.personaState.enabled）' });
            return;
          }
          try {
            if (req.method === 'GET' && url.pathname === '/api/emotion') {
              sendJson({ ok: true, ...personaState.snapshot() });
              return;
            }
            if (req.method === 'POST' && url.pathname === '/api/emotion/action') {
              const body = await readBody();
              const action = String(body.action || '').trim();
              const at = Number(body.at) > 0 ? Number(body.at) : Date.now();
              let changed = false;
              if (action === 'adjustMood') {
                // adjustMood 的 delta 是对象 {pleasure,arousal,dominance}（标量入参只动 pleasure），
                // 直接 Number(result.delta) 会得到 NaN → changed 永远 false（端点看起来「没生效」）。
                const result = personaState.adjustMood({ delta: body.delta, reason: String(body.reason || '控制台微调'), at });
                const applied = Number(result?.delta);
                const total = Number.isFinite(applied)
                  ? Math.abs(applied)
                  : Math.abs(Number(result?.delta?.pleasure) || 0) + Math.abs(Number(result?.delta?.arousal) || 0) + Math.abs(Number(result?.delta?.dominance) || 0);
                changed = total > 0;
              } else if (action === 'addCore') {
                const result = personaState.addCore(String(body.text || ''), { by: String(body.by || 'console'), userId: String(body.userId || ''), source: 'console', at });
                changed = !!result?.created;
              } else if (action === 'removeCore') {
                const result = personaState.removeCore(String(body.id || ''));
                changed = !!result?.ok;
              } else if (action === 'resolveGrudge') {
                const result = personaState.resolveGrudge(String(body.id || ''));
                changed = !!result?.ok;
              } else if (action === 'reset') {
                const result = personaState.reset();
                changed = !!result?.ok;
              } else {
                sendJson({ ok: false, error: 'action 只能是 adjustMood / addCore / removeCore / resolveGrudge / reset' }, 400);
                return;
              }
              sendJson({ ok: true, changed });
              return;
            }
            sendJson({ ok: false, error: '情绪层接口不存在' }, 404);
          } catch (error) {
            sendJson({ ok: false, error: `情绪层接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/profile') {
          if (!profileBuilder) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '人物画像未开启（config.memoryProfile.enabled）' });
            return;
          }
          try {
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 20));
            const items = profileBuilder.list().slice(0, limit).map((item) => ({
              entityId: item.entityId,
              name: item.name,
              degree: item.degree,
              profile: item.profile,
              updatedAt: item.updatedAt
            }));
            sendJson({ ok: true, items });
          } catch (error) {
            sendJson({ ok: false, error: `人物画像接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/reflection') {
          if (!reflectionWriter) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '反思未开启（config.memoryReflection.enabled）' });
            return;
          }
          try {
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
            const items = reflectionWriter.list({ limit }).map((item) => ({
              date: item.date,
              summary: item.summary,
              highlights: item.highlights,
              createdAt: item.createdAt
            }));
            sendJson({ ok: true, items });
          } catch (error) {
            sendJson({ ok: false, error: `反思接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/procedural') {
          if (!proceduralStore) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '技能未开启（config.memoryProcedural.enabled）' });
            return;
          }
          try {
            const q = String(url.searchParams.get('q') || '').trim();
            const raw = q ? proceduralStore.match(q, { limit: 10 }) : proceduralStore.list({ limit: 50 });
            const items = (Array.isArray(raw) ? raw : []).map((item) => ({
              name: item.name,
              steps: item.steps,
              uses: item.uses,
              successRate: item.successRate,
              score: Number(item.score) || 0
            }));
            sendJson({ ok: true, items });
          } catch (error) {
            sendJson({ ok: false, error: `技能接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/style') {
          if (!styleGuard) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '语感层未开启（config.styleGuard.enabled）' });
            return;
          }
          try {
            sendJson({ ok: true, ...styleGuard.snapshot() });
          } catch (error) {
            sendJson({ ok: false, error: `语感层接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/self-style') {
          if (!selfStyle) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '自我语感未开启（config.selfStyle.enabled）' });
            return;
          }
          try {
            sendJson({ ok: true, ...selfStyle.snapshot() });
          } catch (error) {
            sendJson({ ok: false, error: `自我语感接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/life') {
          if (!lifeLoop) {
            sendJson({ ok: false, disabled: true, enabled: false, error: '生活线未开启（config.lifeLoop.enabled）' });
            return;
          }
          try {
            const date = String(url.searchParams.get('date') || '').trim();
            const today = date || layerDayKey(Date.now());
            const notes = date ? lifeLoop.list({ date }) : lifeLoop.todayNotes();
            sendJson({ ok: true, today, notes });
          } catch (error) {
            sendJson({ ok: false, error: `生活线接口失败：${errorText(error)}` }, 500);
          }
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${errorText(error)}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  // 一批消息的公共发送逻辑（sendToQQ 与 sendToQQResult 只差"结果怎么记账"）。
  // 每个 part 都排在全局 sendChain 上；由于 sendChain 严格串行，**本批次自己的失败
  // 只会落在本批次的 part 里**，不会混进前一批次的失败——这正是能按批次出回执的原因。
  function enqueueSendParts(key, parts, assertSendAllowed, onPartFailed) {
    const [kind, id] = key.split(':');
    let remaining = parts.length;
    let resolveDone;
    const done = parts.length ? new Promise((resolve) => { resolveDone = resolve; }) : Promise.resolve();
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          onPartFailed(error);
          log(`QQ 发送失败 (${key}):`, errorText(error));
        })
        .then(() => sleep(cfg.sendDelayMs))
        .then(() => {
          remaining -= 1;
          if (remaining === 0) resolveDone();
        });
    }
    return { done, chain: sendChain };
  }

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    const { chain } = enqueueSendParts(key, parts, assertSendAllowed, () => {
      lastSendFailed.set(key, true);
    });
    return chain;
  }

  /**
   * 与 sendToQQ 同构，但**回执由本批次自己给出**：`{ ok, parts, failed }`。
   *
   * 为什么需要它：`lastSendFailed` 是**每个会话一个共享槽**。同一 key 上如果有另一次发送
   * 并发（AI 正在回话、又或者别处的 sendToQQ），读共享槽就会串味——
   *   · 对方批次先 delete(key)、我们这批失败 → 可能被判成成功（提醒被 markFired → **永久丢失**）；
   *   · 反向 → 我们其实成功了却被判成失败（下个 tick 重发 → **重复提醒**）。
   * 提醒投递的兜底判定不能建在这种共享状态上，必须问"我这一批到底出去了没有"。
   *
   * 仍然会写共享槽（`lastSendFailed`），因为它还有别的消费者；只是**调用方不该再依赖它**。
   */
  function sendToQQResult(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    let failed = 0;
    const { done, chain } = enqueueSendParts(key, parts, assertSendAllowed, () => {
      failed += 1;
      lastSendFailed.set(key, true);
    });
    return { done: done.then(() => ({ ok: failed === 0 && parts.length > 0, parts: parts.length, failed })), chain };
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, errorText(error));
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  // 进提示词的预算：单条消息所有图片/帧的字节总和（4MB base64 ≈ 5.3MB 文本，再大就该省了）
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
  // 下载上限：比提示词预算宽松。动图必须先整段拿回来才能抽帧，抽出来的每帧只有几十~几百 KB；
  // 超过预算的静图由调用方跳过并说明原因（否则 QQ 表情包里 4~16MB 的 GIF 会被整条当成"获取失败"）。
  const MAX_MEDIA_FETCH_BYTES = 16 * 1024 * 1024;
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    let fetchError = '';
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_FETCH_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_FETCH_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        fetchError = errorText(error);
        log(`get_image 解析失败: ${fetchError}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_FETCH_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        fetchError = fetchError || errorText(error);
        log(`图片 URL 抓取失败: ${errorText(error)}`);
      }
    }
    // 把"为什么没图"带回给调用方：超限与下载失败对模型是两种事（前者重试也没用）。
    if (fetchError) return { error: /超过大小限制/.test(fetchError) ? 'too-large' : 'fetch-failed' };
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${errorText(error)}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${errorText(error)}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  // 动图抽帧：GIF 只有第一帧能进视觉通道的话，「会动的表情」和「一张静图」对模型没区别。
  // 返回 null 表示"不是动图/解不开"，调用方按普通静图处理（绝不能因为拆帧失败而丢图）。
  function extractAnimatedFrames(buf, maxFrames) {
    try {
      if (!buf || !isGifBuffer(buf) || !isAnimatedBuffer(buf)) return null;
      const limit = Math.max(1, Math.min(MAX_MEDIA_COUNT, Math.round(Number(maxFrames) || MAX_MEDIA_COUNT)));
      const r = extractGifFrames(buf, { count: limit, maxSide: 512 });
      if (!r?.ok || !r.frames?.length) return null;
      return { frames: r.frames, totalFrames: r.totalFrames, durationMs: r.durationMs || 0 };
    } catch {
      return null;
    }
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'file') {
        parts.push({ type: 'text', text: `[文件${media.name ? ` ${media.name}` : ''}（不是图片，用 qq_read_file 读）]` });
        continue;
      }
      if (media.kind === 'card') {
        parts.push({ type: 'text', text: `[卡片${media.title ? ` ${media.title}` : ''}（用 qq_open_card 点开）]` });
        continue;
      }
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          // 动图：只送第一帧等于把 GIF 当静态图看，等于白看。这里把动图拆成多帧，
          // 每帧一张 PNG 一起送进视觉通道（上限 MAX_MEDIA_COUNT，所以会二次裁）。
          const anim = extractAnimatedFrames(img.buffer, MAX_MEDIA_COUNT - parts.filter((p) => p.type === 'image').length);
          if (anim) {
            let skipped = false;
            for (const [i, frame] of anim.frames.entries()) {
              if (totalBytes + frame.png.length > MAX_MEDIA_BYTES) { skipped = true; break; }
              totalBytes += frame.png.length;
              parts.push({ type: 'text', text: `[动图第 ${i + 1}/${anim.frames.length} 帧]` });
              parts.push({ type: 'image', mediaType: 'image/png', data: frame.png.toString('base64'), name: `qq-gif-${index}-f${frame.index}.png` });
            }
            if (skipped) parts.push({ type: 'text', text: `[动图剩余帧（总大小超限，已跳过）]` });
            continue;
          }
          if (isAnimatedBuffer(img.buffer) && !isGifBuffer(img.buffer)) {
            // 动态 WebP / APNG：没有解码器，只能送第一帧 —— 至少让模型知道这是动图。
            parts.push({ type: 'text', text: `[动图${index}（WebP/APNG，以下只是第一帧）]` });
          }
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（${(img.buffer.length / 1024 / 1024).toFixed(1)}MB，超过单条 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB 图片预算，未加载）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-image-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          const why = img?.error === 'too-large'
            ? `超过下载上限 ${Math.round(MAX_MEDIA_FETCH_BYTES / 1024 / 1024)}MB，没加载`
            : img?.error === 'fetch-failed' ? '下载失败' : '获取失败';
          parts.push({ type: 'text', text: `[图片${index}（${why}）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      // 文件 / 卡片不是图片：它们没有可送进视觉通道的字节，硬走 fetchOneBotImage
      // 只会白等一次网络超时。这里直接给出「该用哪个工具」的指引。
      if (media.kind === 'file') {
        out.push({
          index,
          kind: 'file',
          file: media.name ? String(media.name) : undefined,
          text: `（文件，不是图片：请用 qq_read_file 读取内容${media.name ? `，文件名 ${media.name}` : ''}）`
        });
        continue;
      }
      if (media.kind === 'card') {
        out.push({
          index,
          kind: 'card',
          text: `（分享卡片：${media.title ? String(media.title) : '无标题'}${media.desc ? ` — ${media.desc}` : ''}；想点开请用 qq_open_card）`
        });
        continue;
      }
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          const anim = extractAnimatedFrames(img.buffer, MAX_MEDIA_COUNT - out.filter((o) => o.kind === 'image' || o.kind === 'frame').length);
          if (anim) {
            for (const [i, frame] of anim.frames.entries()) {
              if (totalBytes + frame.png.length > MAX_MEDIA_BYTES) break;
              totalBytes += frame.png.length;
              out.push({
                index,
                kind: 'frame',
                frameIndex: i + 1,
                frameTotal: anim.frames.length,
                mimeType: 'image/png',
                data: frame.png.toString('base64'),
                text: `动图第 ${i + 1}/${anim.frames.length} 帧`
              });
            }
            continue;
          }
          if (isAnimatedBuffer(img.buffer) && !isGifBuffer(img.buffer)) {
            out.push({ index, kind: 'image', text: '（动图 WebP/APNG：只能给第一帧）' });
          }
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: `（图片 ${(img.buffer.length / 1024 / 1024).toFixed(1)}MB，超过单条图片预算，未加载）` });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          const why = img?.error === 'too-large'
            ? `超过下载上限 ${Math.round(MAX_MEDIA_FETCH_BYTES / 1024 / 1024)}MB，未加载`
            : img?.error === 'fetch-failed' ? '下载失败' : '获取失败';
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: `（${why}）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 只数图片/表情：media 里现在还可能有 file / card，把一张分享卡算成「1 个图片/表情」
    // 会让模型去调 qq_get_message_images 扑个空。文件/卡片的指引各自写在自己的提示里。
    //
    // 工具名只在 reserved2（二代仿真）下才写出来：一代 / closed-agent 里模型手里根本没有这些
    // MCP 工具，提示它去调一个不存在的工具，比不提示更糟（它会照做、然后失败）。
    const visual = mediaList.filter((m) => m?.kind === 'image' || m?.kind === 'face');
    const files = mediaList.filter((m) => m?.kind === 'file');
    const cards = mediaList.filter((m) => m?.kind === 'card');
    const lines = [];
    if (visual.length) {
      lines.push(currentMode === 'reserved2'
        ? `【图片/表情】本条消息包含 ${visual.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`
        : `【图片/表情】本条消息包含 ${visual.length} 个图片/表情（消息ID=${messageRef}）。`);
    }
    if (files.length) {
      const names = files.map((f) => String(f.name ?? '')).filter(Boolean).join('、');
      lines.push(currentMode === 'reserved2'
        ? `【文件】本条消息附带 ${files.length} 个文件${names ? `（${names}）` : ''}（消息ID=${messageRef}）。要读内容请调用 mcp__snowluma__qq_read_file，参数 key="${key}", messageId="${messageRef}"。`
        : `【文件】本条消息附带 ${files.length} 个文件${names ? `（${names}）` : ''}（消息ID=${messageRef}）。`);
    }
    if (cards.length) {
      lines.push(currentMode === 'reserved2'
        ? `【分享卡片】本条消息包含 ${cards.length} 张卡片（消息ID=${messageRef}）。想知道卡片里到底是什么，请调用 mcp__snowluma__qq_open_card，参数 key="${key}", messageId="${messageRef}"。`
        : `【分享卡片】本条消息包含 ${cards.length} 张卡片（消息ID=${messageRef}）。`);
    }
    return lines.length ? `\n${lines.join('\n')}` : '';
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, errorText(error));
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    // 人物七层 · 出站：先记她自己这句话（自我语感基线），再按 cleanOutgoing 洗掉客服腔；
    // 清洗后的文本才是真正发往 QQ 的那一份，也是后面敏感信息检查要检查的那一份。
    if (selfStyle) {
      try { selfStyle.observe(String(text ?? '')); } catch (error) { layerWarnOnce('self-style-observe', error); }
    }
    text = cleanOutgoingText(key, text);
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    // 'default' = 不下发 reasoningEffort（见 REASONING_EFFORT_OPTIONS 注释）
    const selection = effort === 'default'
      ? { sessionId, provider, model }
      : { sessionId, provider, model, reasoningEffort: effort };
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel(selection), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${errorText(error)}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    // 费用护栏：锁不上模型时会退回 DSH 默认模型。实测 trae 全系 **0% 缓存命中**，
    // 单轮 ¥0.4~6；锁到 qodercn/qmodel_38max 或 deepseek-account/deepseek-flash 后
    // 命中 88~99%、单轮 ¥0.02~0.2（同一批会话、同样的活）。所以这里绝不能静默失败，
    // 否则界面上的命中率会莫名其妙地掉、钱照烧。
    log(`⛔ 会话 ${sessionId} 未能锁定到 ${provider}/${model}，将沿用 DSH 默认模型（缓存命中与费用都不受控，实测单轮可能贵 20~30 倍）：${message || '未知错误'}`);
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); }
        catch (error) { log(`⚠️ 归档被丢弃的会话失败 ${key}（${sessionId}）：${errorText(error)}；它可能仍出现在 DSH 会话列表里`); }
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
// 机器人自己的 QQ 号（同样在登录成功后写入）。只有 +1 复读要用它来判断
// "这条消息是不是我自己发的"——复读自己刚说的话不是 +1，是复读机。
let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        replyCheckChain: 0,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 好友/入群申请（bot.onRequest 收到、还没处理的）。默认空数组而不是 undefined：
        // 每个读取点都要能直接 .length / .slice，不必到处写 `?? []`。
        pendingRequests: []
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
          replyCheckChain: Number(val.replyCheckChain) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            softWakeTimes: Array.isArray(val.softWakeTimes) ? val.softWakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            // 申请待办：只留最近 20 条（有界）。这里**必须**显式列出，因为
            // saveSocialV2State 是白名单式序列化 —— 漏掉一行就等于"重启后申请全丢"。
            pendingRequests: Array.isArray(val.pendingRequests) ? val.pendingRequests.slice(-20) : []
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', errorText(error));
    }
  }

  // 会话重置（控制台「清除会话上下文」/ QQ 里的 /reset）只换 DSH 侧的会话：
  // 记忆（进行中的话题、想说没说的话、对群友的印象）、未读缓冲、最近消息、唤醒配置都保留 ——
  // 这些是「AI 的长期记忆」，不该因为一次上下文重置被顺手清掉（实测：这样重置一次，
  // 记忆表、未读、会话令牌全没了，她连刚才群友说什么都不知道）。
  // 只把 bootstrapSent 置回 false，让下一轮走一次带新 preset / 新工具清单的引导唤醒。
  // 真要连记忆一起清空，用 POST /api/socialV2/reset（控制台的「重置二代 AI 状态」）。
  function rebindSocialV2Session(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return false;
    st.bootstrapSent = false;
    st.lastWakeReason = '';
    st.pendingWakeReasons = [];
    st.pendingWakeTimer = null;
    st.sleepTimer = null;
    st.replyCheckTimer = null;
    st.proactiveTimer = null;
    st.softWakeSkipReason = '';
    return true;
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          softWakeTimes: Array.isArray(st.softWakeTimes) ? st.softWakeTimes.slice(-200) : [],
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          replyCheckChain: Number(st.replyCheckChain) || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          // 好友/入群申请的待办。**必须在这里列出来**：本函数是白名单式序列化，
          // 漏一行就等于重启后所有待批申请消失（AI 再也看不到"有人在申请加群"）。
          pendingRequests: Array.isArray(st.pendingRequests) ? st.pendingRequests.slice(-20) : [],
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', errorText(error));
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 会话类型措辞：私聊必须读到「私聊」，不能让 AI 在一对一里读到「群聊上下文」——
  // 那是历史 bug，会让私聊也端起群聊那套腔调（用户明确要求私聊更软、更可爱、更客气）。
  function isGroupKey(key) {
    return String(key ?? '').startsWith('group:');
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    const group = isGroupKey(key);
    const quietLine = group
      ? '群里安静了一会儿，你可以说点什么。'
      : '对方有一会儿没说话了，你可以轻轻说一句（也可以不说）。';
    return `【${group ? '群聊' : '私聊'}上下文】\n${buildContextBlock(key)}\n\n${quietLine}如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(errorText(error)).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.cancelled) promptQueues.delete(key);
        else if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${errorText(error)}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${errorText(error)}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${errorText(error)}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例块不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”
  // （实现在 role-card.js 的 rewriteExampleSpaces，标题式与列表式示例块都认）。
  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 先改写示例块里的中文空格（一代语义 → 二代语义），再整行过滤一代遗留指令。
    // 过滤器用 role-card.js 导出的那份：原先这里又抄了一份同源正则，两份一旦漂移，
    // 就会出现「selectRoleText 认为是二代内容、这里却把一代指令漏进二代提示词」的错。
    return rewriteExampleSpaces(raw)
      .split('\n')
      .filter((line) => !GEN1_ROLE_LINE_RE.test(line))
      .join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${errorText(error)}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', errorText(error));
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], replyToId = null) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 媒体白名单：这里每多认一种 kind，消息里就多留一份可定位信息。
    // 曾经只认 face/image，于是 file 段（带下载直链）和卡片段（带标题/链接）在入库时
    // 被静默丢掉 —— 收到的那一刻还有救，写进 state 之后就再也找不回来了。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : m?.kind === 'file' ? 'file' : m?.kind === 'card' ? 'card' : 'image';
      if (kind === 'face') return { kind, faceId: m?.faceId ? String(m.faceId) : undefined };
      if (kind === 'file') {
        return {
          kind,
          name: m?.name ? String(m.name) : undefined,
          fileId: m?.fileId ? String(m.fileId) : undefined,
          size: Number(m?.size) || 0,
          url: m?.url ? String(m.url) : undefined,
          hash: m?.hash ? String(m.hash) : undefined
        };
      }
      if (kind === 'card') {
        return {
          kind,
          cardKind: m?.cardKind ? String(m.cardKind) : 'card',
          title: m?.title ? String(m.title) : undefined,
          desc: m?.desc ? String(m.desc) : undefined,
          url: m?.url ? String(m.url) : undefined,
          audioUrl: m?.audioUrl ? String(m.audioUrl) : undefined,
          image: m?.image ? String(m.image) : undefined,
          source: m?.source ? String(m.source) : undefined
        };
      }
      return {
        kind,
        file: m?.file ? String(m.file) : undefined,
        url: m?.url ? String(m.url) : undefined
      };
    }).filter((m) => {
      if (m.kind === 'face') return !!m.faceId;
      if (m.kind === 'file') return !!(m.url || m.fileId);
      if (m.kind === 'card') return !!(m.title || m.url);
      return !!(m.file || m.url);
    }) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.replyCheckChain = 0; // 真人说话了：自说自话计数归零
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    // 历史归档：只记入站的真消息（自己发的走 recordSentMessagesV2 / recordSelfMessageV2）。
    // 本函数只在「真的收到一条新消息」时被调用（见 handleIncoming），不在唤醒/重放路径上；
    // 再加上 archive 内部按 messageId 去重，重复写入有双保险。
    appendHistoryInboundV2(key, {
      tsMs: msg.time,
      senderId: msg.userId,
      senderName: sender,
      text: String(plainContent ?? textContent ?? ''),
      media: safeMedia,
      messageId: msg.messageId,
      replyToId
    });
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.replyCheckChain = 0; // 真人说话了：自说自话计数归零
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      // 出站历史：只在这一处（文本发送）记 dir:'out'，媒体消息统一走 recordSelfMessageV2。
      recordHistoryOutboundV2(key, text);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', errorText(error));
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  // 积压计数（方案 B 的核心）。主人的要求（m07680 原话）：「思想还是一样不是每条都回但不能一条不回…
  // 但是如果攒了几条没回的信息挑最近的那一条回就好！」
  //
  // 定义：自她上次开口以来，未读缓冲里还攒着多少条**普通消息**（别人发的、非拍一拍）。
  // 为什么用未读缓冲而不是最近消息：
  //   ① 未读在她「看过并收尾」（qq_mark_read / qq_set_wake_config）后会按水位清空 —— 正好等价于
  //      「这一堆消息她已经处理过了」，不需要新加一个持久化计数器；
  //   ② 她真开口时 lastAiReplyAt 会兜底，把更早的都排除掉（双保险）；
  //   ③ 未读本来就是「还没接的话」的唯一权威来源，不会出现计数与缓冲各说各话。
  // 拍一拍不计入：拍一拍自己就是定向触发（triggers.poke），重复计入只会把积压提前。
  function backlogUnansweredV2(st) {
    if (!st) return 0;
    const floor = Number(st.lastAiReplyAt) || 0;
    const list = Array.isArray(st.unread) ? st.unread : [];
    let n = 0;
    for (const m of list) {
      if (!m || m.isSelf) continue;
      if (m.kind === 'poke') continue;
      if ((Number(m.time) || 0) <= floor) continue;
      n += 1;
    }
    return n;
  }

  // 引用 / @ 引导（主人 m10890）。
  //
  // 要解决的问题：以前的引用规则是「只在有歧义时才用」，结果她几乎从不引用，
  // 群里两三个人同时跟她说话时，她那条回复到底在答谁全靠猜。主人要的是**主动引用**：
  // 挑最有意思最有梗的那条，引用着回。
  //
  // 为什么放在桥接层而不是只写进角色卡：这段判断依赖「当前未读里有几条、有几个人在找她」，
  // 是**运行时**信息，角色卡（静态文本）算不出来；而且放这里改完即热生效，不用重建 preset。
  //
  // 只在群聊给：私聊是一对一，引用没有任何信息量，只会显得啰嗦。
  function quoteGuideV2(key, st) {
    if (!isGroupKey(key)) return '';
    const unread = Array.isArray(st?.unread)
      ? st.unread.filter((m) => m && !m.isSelf && m.kind !== 'poke')
      : [];
    // 「在找她的人」：明确 @/叫名字/提问的，以及引用她自己消息的。
    const directed = unread.filter((m) => m.quoteTargetIsSelf || isDirectedAtAi(String(m.plain || m.text || '')));
    const bySender = new Map();
    for (const m of directed) {
      const who = String(m.sender || m.userId || '?');
      if (!bySender.has(who)) bySender.set(who, 0);
      bySender.set(who, bySender.get(who) + 1);
    }
    const lines = [];
    // ★ 2026-10-13 收窄（主人：「你怎么在群里句句引用」「不是你怎么又在每句都引用你是人机？」）。
    //
    // 以前这里还有两支：`unread >= 3` 推【挑一条引用】、`unread >= 1` 推【该引用时就引用】。
    // 后果是**群里只要有任何一条未读就注入一条引用指令** ⇒ 实测群聊引用率从 0% 直接跳到 90%，
    // 每条短句都挂着引用，最像人机的就是这个。引用本身是有代价的（一条消息变两条气泡），
    // 真人只在「不引会答错人」时才用。
    //
    // 现在只剩**唯一必须引用**的场景（多人同时说话）；「默认不引」那条静态规则写在角色卡里，
    // 不再每轮重复注入。
    if (bySender.size >= 2) {
      // 唯一硬场景：两个（或更多）人同时在跟她说话。
      const names = [...bySender.keys()].slice(0, 4).join('、');
      lines.push(`【多人在找你】现在有 ${bySender.size} 个人同时在跟你说话（${names}）。**别混着回、别一条消息里同时应付两个人**：你每条回复都用 qq_reply（或 qq_send_message 的 replyToMessageId）**引用你正在回答的那一条**，让对方一眼看出你在答他；如果两个人都要回，就分两条、各自引用。`);
    }
    // @ 的用法：只在真的要点名时用，不是每条都挂。
    lines.push('【@ 怎么用】群聊里 qq_send_message / qq_reply / qq_send_sticker 都支持 atUserId（传对方 QQ 号，可从 qq_get_active_members 或 qq_get_message_detail 的 userId 拿到）。@ 是**点名**，只用在：他很久没理你、你想叫一下；你要回的是很早的一条、怕他刷过去没看见；或者你就是专门找某个人说话。**别每条都 @，一条消息里也最多 @ 一个人**——真人在群里很少 @ 人，动不动就 @ 才像机器人。');
    return `${lines.join('\n')}\n\n`;
  }

  // 普通消息（anyMessage / 概率）的“软闸门”：真人不会被群里每一句话叫起来。
  // 定向触发（@/名字/关键词/提问/指定成员/拍一拍）不受这里限制——被点名必须能唤醒。
  // 返回 'ok' 表示这次软唤醒放行（此刻也计一次额度），null 表示这次先不醒（消息照常进未读缓冲，
  // 下一轮唤醒时会一起看到，不丢消息）。
  function softWakeGateV2(st, kind) {
    if (kind === 'private') return 'ok';
    const w = cfg.socialV2?.wake ?? {};
    const now = Date.now();
    // ① 冷却：刚说过话就别被普通消息立刻再叫起来（群里连续闲聊时这是最大的噪音源）。
    const cooldownMs = Math.max(0, Number(w.softWakeCooldownMs) || 0);
    const lastReplyAt = Number(st?.lastAiReplyAt) || 0;
    if (cooldownMs > 0 && lastReplyAt > 0 && now - lastReplyAt < cooldownMs) {
      if (st) st.softWakeSkipReason = `刚说过话，冷却剩余 ${Math.ceil((cooldownMs - (now - lastReplyAt)) / 1000)}s`;
      return null;
    }
    // ② 每小时额度：软唤醒（普通消息）有上限，定向唤醒不吃这个额度。
    const perHour = Math.max(0, Number(w.softWakePerHour) || 0);
    if (perHour > 0) {
      const kept = (Array.isArray(st.softWakeTimes) ? st.softWakeTimes : [])
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && now - t < 3600000);
      if (kept.length >= perHour) {
        st.softWakeTimes = kept;
        st.softWakeSkipReason = `普通消息每小时额度已满（${kept.length}/${perHour}）`;
        return null;
      }
      kept.push(now);
      st.softWakeTimes = kept;
      return 'ok';
    }
    return 'ok';
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    st.softWakeSkipReason = '';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    // 普通消息路径：anyMessage（活跃模式）与「概率」都过软闸门。
    // 注意顺序——先掷概率再吃额度，免得掷失败也白白扣掉一次名额。
    if (tr.anyMessage && softWakeGateV2(st, kind) === 'ok') return 'anyMessage';
    // 积压兜底（方案 B）：自她上次开口后攒够 backlogWakeAfter 条还没接的普通消息，就不再掷骰子，
    // 直接叫醒一次 —— 主人的要求是「不是每条都回，但不能一条不回」。
    // 放在概率之前：攒够的时候原因就该是 'backlog'（提示词会引导「只挑最近的那一条回」），
    // 而不是被一次侥幸的骰子改写成 'probability'。攒不够时才轮到概率决定要不要早插一句。
    // 仍然走软闸门：刚说过话的冷却 + 每小时额度照旧生效，所以「必定醒」不会变成话痨。
    const backlogAfter = Math.max(0, Math.round(Number(cfg.socialV2?.wake?.backlogWakeAfter) || 0));
    if (backlogAfter > 0 && backlogUnansweredV2(st) >= backlogAfter && softWakeGateV2(st, kind) === 'ok') return 'backlog';
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability) && softWakeGateV2(st, kind) === 'ok') return 'probability';
    return null;
  }
  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 该会话此刻的目的判定：候选现算（记忆卡 + 轻量记忆），闸门的"刚聊过"取 st.lastIncomingAt。
  // 供唤醒提示词与主动机会检查共用，确保两处看到的是同一个判断。
  function purposeSelectionFor(key, st) {
    try {
      const now = Date.now();
      const candidates = buildPurposeCandidates({ memories: st, memoryCard, now, config: purposeConfig });
      return selectPurpose({
        candidates,
        state: { ...purposeState, lastIncomingAt: st?.lastIncomingAt || 0 },
        now,
        config: purposeConfig
      });
    } catch (error) {
      log('[purpose] 判定失败：' + errorText(error));
      return { action: 'wait', purpose: null, score: 0, candidates: [], blocked: ['error'] };
    }
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（角色卡全文与说话方式示例在 qq_get_prompt，本会话没调过就先调一次）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 长期记忆卡（跨会话、会衰减）：每次唤醒都带上一小段，最近整理的版本在 memoryCardPromptText。
    const memoryCardLine = memoryCardPromptText ? `${memoryCardPromptText}\n\n` : '';
    // 记忆大脑：按最近来信检索长期记忆，命中才出现（带 MB marker 的一块，见 src/memory-brain.js）。
    // 位置固定在长期记忆卡之后、目的引擎之前 —— 先「我记得什么」，再「我现在想干嘛」。
    const memoryBlockText = stripMemoryBlocks(memoryBlockForWake(key, st));
    const memoryBlockLine = memoryBlockText ? `${memoryBlockText}\n\n` : '';
    // 人物七层（情绪 / 画像 / 群聊语感 / 自我语感）：每块都先 strip 旧 marker 再拼 ——
    // 否则多轮唤醒会把同一段叠加成 N 份（P-011 的老毛病）。
    // 顺序 = 她此刻的心情 → 她记得谁 → 群里怎么说话 → 她最近说话变没变。
    const personaLine = personaLayerBlock(key);
    const profileLine = profileLayerBlock();
    const styleLine = styleLayerBlock(key);
    const selfStyleLine = selfStyleLayerBlock();
    // 对话收束（只给建议）：对方说了晚安 / 只回了个「嗯」/ 早就冷场时，提醒她这段可以打住，
    // 别再硬补一句。判定是纯函数（src/conversation-closure.js），这里只做取数与拼接。
    const closureResult = analyzeClosure({ messages: st.recentMessages, now: Date.now(), config: closureConfig });
    const closureText = buildClosureLine(closureResult, closureConfig);
    const closureLine = closureText ? `${closureText}\n\n` : '';
    // 目的引擎（主动）：把"心里惦记的事"写进提示词。只在真有事、且闸门全开时出现；
    // 出现也只是提醒（想提就提），不催她开口——沉默永远允许。
    const purposeSel = purposeSelectionFor(key, st);
    const purposeText = buildPurposeLine(purposeSel, purposeConfig);
    const purposeLine = purposeText ? `${purposeText}\n\n` : '';
    // 额度：到 80% 提醒收敛、到 100% 要求非必要不开口。ok/off 时这段是空串，不占提示词。
    const budgetText = buildBudgetLine(budgetEvaluation(), budgetConfig);
    const budgetLine = budgetText ? `${budgetText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    // 主人私聊是**唯一**允许谈后台/工具的会话（角色卡 §二十二.7）。这里显式点名，
    // 免得模型要靠 QQ 号去猜「这条私聊是不是主人自己的」——群里一个字都不许提。
    const ownerKeyForLine = ownerNotifyKey();
    const ownerLine = ownerKeyForLine && key === ownerKeyForLine
      ? '【会话身份】这是**主人（ikkk，ownerQQ）自己的私聊**：只有在这条会话里，你可以坦白后台/工具的存在（"我背后是 DSH""我在调工具""刚才哪个调用失败了""我在等消息"）——见角色卡 §二十二 第 7 条。群聊里、以及和任何别人私聊时，这些字一个都不许出现。\n\n'
      : '';
    // 主人 m04112：「潜水活跃和回复消息频率让她自己调整」——这里不能再催她参与。
    const proactiveLine = '【想不想说话由你定】看到感兴趣的就接一句，没兴趣就挂着；不用因为「有人在说话」就觉得该出现，也不用刻意找话题。潜水不是失礼，安静也正常。\n\n';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    // 收尾提示按配置切换：preSleepWaitEnabled=false 时不再要求干等观察窗口（真人也会聊完就走）。
    const preSleepGate = cfg.socialV2?.wake?.preSleepWaitEnabled !== false;
    const preSleepHead = preSleepGate ? '【沉睡前强制等待】' : '【收尾随你】';
    const sleepTailV2 = preSleepGate ? '按【沉睡前强制等待】走完观察窗口再收尾' : '直接设下一次唤醒收尾就行';
    const preSleepLine = preSleepGate
      ? `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`
      : `【收尾随你】不想说话了就直接设下一次唤醒收尾，不用为了流程干等；只是如果对方看起来还在打字/话没说完，等一会儿（qq_wait_for_messages，最多 ${Math.round(preSleepMs / 60000)} 分钟）更自然一点。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    // 积压引导（主人 m07680：「如果攒了几条没回的信息挑最近的那一条回就好」→
    // 主人 m10890 迭代：「自主选择最有意思最有梗的那条引用回复」）。
    // 只在**群聊 + 软唤醒**（积压/概率/任意消息/主动机会）时给：被 @/叫名字/提问叫起来时，
    // 该回的是那个点名的人，这时教她「挑最有梗那条」是错的引导（引用引导另有 quoteLine）。
    const backlogCount = backlogUnansweredV2(st);
    const softWake = reason === 'backlog' || reason === 'probability' || reason === 'anyMessage' || reason === 'proactiveCheck';
    const backlogLine = (isGroupKey(key) && softWake && backlogCount >= 2)
      ? `【攒了几条】你上次开口之后，群里已经攒了 ${backlogCount} 条你还没接的消息。**先扫一眼，挑最有意思、最有梗、最值得接的那一条接一句**（接最新那条就不用引用）——不要逐条补答，也不必非得是最新的那条；一口气把旧的补完反而最像机器人。挑不出想接的就安静收尾。\n\n`
      : '';
    // 引用/@ 引导（主人 m10890：「主动引用别人的消息回复」「挑最有意思最有梗的那条引用回复」
    // 「两个人都在和自己聊天时，引用回复具体信息」「也要会新的 @ 功能」）。
    const quoteLine = quoteGuideV2(key, st);
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 上下文超预算自动重开会话后的交接：不明说的话，模型会以为自己"失忆"了，
    // 在群里做出「刚说过又忘」的错乱反应。两小时内有效，之后不再提。
    const resetNote = st.contextResetNote;
    const handoffLine = resetNote && Number(resetNote.at) > 0 && Date.now() - Number(resetNote.at) < 2 * 60 * 60 * 1000
      ? `【交接】你上一个会话的上下文太长（约 ${Math.max(1, Math.round(Number(resetNote.tokens) / 1000))}k token），已自动换成新会话重新开始；记忆、未读、唤醒配置都还在，别表现成失忆。\n\n`
      : '';
    const base = roleLine + tokenLine + ownerLine + antiAiLine + handoffLine + proactiveLine + stickerLine + replyLine + statusLine + backlogLine + quoteLine + wakeLine + personaLine + memoryLine + memoryCardLine + memoryBlockLine + profileLine + styleLine + selfStyleLine + purposeLine + budgetLine + closureLine + participationLine + preSleepLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'backlog') {
      return `${base}【唤醒】${key}\n原因：你上次开口之后，群里已经攒了 ${backlogCount} 条还没人接的消息（系统把你叫起来了，不是催你补作业）。\n【怎么做】先扫一眼未读，**挑最有意思、最有梗、最值得接的那一条接一句**（接最新那条就不用引用）——不必非得是最新的那条，也不要逐条补答。挑不出想接的就安静收尾（qq_mark_read 或 qq_set_wake_config），这一轮就算过了。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里安静了一会儿，你正好闲下来看了一眼手机。\n想冒泡就冒（接上次没聊完的、开个话题、分享你刚看到的东西），也可以顺手去 B 站刷会儿视频、听听歌，看到好玩的再发；什么都不想干就继续挂着，不用勉强（安静的收尾也是收尾：qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    // 定时主动唤醒（作息 / 节日）：提示词里的指令来自 config.socialV2.schedule.items[].hint，
    // 这样「23:00 说晚安」「节日发祝福」的具体说法可以随时在配置里改，不用动代码。
    const schedMatch = /^schedule:([A-Za-z0-9_-]+)$/.exec(String(reason ?? ''));
    if (schedMatch) {
      const item = (Array.isArray(cfg.socialV2?.schedule?.items) ? cfg.socialV2.schedule.items : [])
        .find((it) => it && it.id === schedMatch[1]) ?? null;
      const title = item?.title || schedMatch[1];
      const hint = item?.hint || '这是一次定时主动唤醒。';
      return `${base}【定时唤醒：${title}】${key}\n原因：${hint}\n【注意】这是你给自己定下的作息/节日规矩，符合人设再发；不自然就别硬发（可以只留一句很轻的，或安静收尾）。决定不发也要${sleepTailV2}。`;
    }
    // 到点提醒：内容由提醒侧写在调用 sendWakePromptV2 **之前**（st.pendingReminderText /
    // st.pendingReminderDueText，只存在于内存状态，不进 social-v2.json），这里只负责生成提示词。
    // 用完立刻清掉：否则下一次无关唤醒（poke / proactiveCheck）会把旧提醒再念一遍。
    if (String(reason).startsWith('reminder:')) {
      // 优先按 id 回 store 查（reason 形如 reminder:<id>）：会话繁忙时多条提醒会先后进
      // pendingWakeReasons 队列，共享的 st.pendingReminderText 槽位会被后一条覆盖——排队轮到
      // 第一条时就会念出第二条的内容。按 id 查各自的原文才不会被串味。
      const reminderId = String(reason).slice('reminder:'.length).trim();
      let reminderText = '';
      let reminderDueText = '';
      try {
        const hit = remindersStore().list({ key, includeDone: true }).find((x) => x && x.id === reminderId) ?? null;
        if (hit) {
          reminderText = String(hit.text ?? '').trim();
          reminderDueText = String(hit.dueText ?? '').trim() || formatLocalTime(hit.dueAt);
        }
      } catch (error) {
        log(`[reserved2] 读取提醒内容失败 ${key}（${reminderId}）:`, errorText(error));
      }
      // 回查不到（已被 prune / 换了 store 文件）才用投递前写的槽位兜底。
      if (!reminderText) reminderText = String(st.pendingReminderText ?? '').trim();
      if (!reminderDueText) reminderDueText = String(st.pendingReminderDueText ?? '').trim();
      st.pendingReminderText = null;
      st.pendingReminderDueText = null;
      if (!reminderText) {
        return `${base}【唤醒】${key}\n原因：一个到点提醒被触发，但提醒内容已经读不到了（状态可能被重置）。可以自然地问一句“是不是有个事要提醒你”，但**不要编造**具体内容。`;
      }
      return `${base}【到点提醒】${key}\n原因：${reminderDueText ? `你在 ${reminderDueText} 给自己记的那件事` : '你之前给自己记的那件事'}到点了。\n内容：${reminderText}\n【怎么做】先分清这是哪种：\n- 如果是你**给自己安排的活**（打算去刷会儿视频、想看看群里聊到哪了、想找点东西分享、想歇一会儿再回来）——**不用跟谁宣布，直接去做就行**；做完/看完了再决定要不要说话，没人问就不用汇报“我做完了”。\n- 如果是**要说给某个人听的事**（答应过提醒他、约好的事）——用你自己的语气顺口带出来，像人自己想起来了，**不要像闹钟播报**（别用“叮！提醒事项：”这种腔调），可以口语化，但不要改内容、不要加戏。\n办完${sleepTailV2}。`;
    }
    // 会话类型决定「行动前」的引导语：群聊是挑谁值得接，私聊是先把对方接住。
    const preActionHint = isGroupKey(key)
      ? '【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。'
      : '【行动前】先判断：对方想说什么？是在问你事、随口闲聊，还是在等你回应？对方说完了吗？你有没有真正想说的？\n私聊态度要软一点、客气一点（是亲近不是客服腔）：先接住对方那句话，再决定说什么；不想说就用一句轻的收尾，别装死。';
    // ★ 引用口径（2026-10-13 收窄）：以前这里是【引用：主动挑一条】+「只有上下文唯一…才可以不引用」，
    // 等于**每轮唤醒都在催引用**（叠加 quoteGuideV2 的 unread>=1 分支），实测群聊引用率被推到 90%。
    // 现在反过来：默认**不引**，只有「不引会让人看不出你在答谁」时才引。
    const quoteHint = isGroupKey(key)
      ? '\n【引用：默认不引】直接把话接上就行，**不要每条都引用**（群里句句引用最像人机）。只有这两种情况才用 qq_reply / replyToMessageId：① 有两个人以上同时在跟你说话（这时必须引，免得答错人）；② 你要接的**不是最新那一条**（引一下别人才知道你在接谁）。接最新那条、且只有一个人在跟你说话时——不引。'
      : '\n【引用：私聊一般不引】私聊是一对一，引用没有信息量、只会显得啰嗦。只有你**一口气要连着说好几条**、需要点明其中某条在回应对方哪句话时，才挑着引一下；其余情况直接说。';
    return `${base}【唤醒】${key}\n原因：${reason}\n${preActionHint}${quoteHint}\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前${preSleepGate ? '必须按上面的【沉睡前强制等待】先等够观察窗口' : '不用硬等，觉得差不多就收尾'}。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（角色卡全文与说话方式示例在 qq_get_prompt，本会话没调过就先调一次）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  // 返回值是「这次唤醒到底怎么了」，供提醒这类**不能丢投递**的调用方判断：
  //   'sent'    真的投出去了（deliverPrompt 接受了）
  //   'queued'  会话繁忙，原因已进 pendingWakeReasons，稍后由补投路径真正唤醒
  //   'skipped' 静默跳过（总开关关/非 reserved2/已暂停/不在允许范围/频率超限/投递被拒）
  // 其余调用方都是 `void sendWakePromptV2(...).catch(...)`，不依赖返回值，改返回类型是安全的。
  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) { wakeSkipReasonV2.set(key, 'disabled'); return 'skipped'; }
    if (currentMode !== 'reserved2' || socialV2.paused) { wakeSkipReasonV2.set(key, socialV2.paused ? 'paused' : 'mode'); return 'skipped'; }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      wakeSkipReasonV2.set(key, 'notAllowed');
      return 'skipped';
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      wakeSkipReasonV2.set(key, 'busy');
      return 'queued';
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      wakeSkipReasonV2.set(key, 'ratelimit');
      return 'skipped';
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    let wakeStatus = 'skipped';
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        wakeSkipReasonV2.set(key, 'rejected');
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        wakeStatus = 'queued';
        wakeSkipReasonV2.set(key, 'busy');
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      } else {
        wakeStatus = 'sent';
        wakeSkipReasonV2.delete(key);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      wakeSkipReasonV2.set(key, 'error');
      log(`[reserved2] 唤醒投递失败 ${key}: ${errorText(error)}`);
    }
    return wakeStatus;
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    // 「自说自话」闸门：回复检查是机器人发完消息后自己排的。实测群里 5 小时有 88 次
    // 回复检查唤醒，而真人消息/拍一拍/被点名加起来只有 17 次——也就是说群里绝大部分
    // 发言是它对着自己的回声自问自答。连续几次都没等到真人新消息就停手，等真人开口再恢复。
    // 只对群聊生效：私聊是一对一，用户明确要求「私聊活跃度不变」。
    const isGroup = key.startsWith('group:');
    const chain = Number(st.replyCheckChain) || 0;
    const maxChain = Math.max(0, Number(cfg.socialV2?.autoReplyCheckMaxChain ?? 2));
    if (isGroup && chain >= maxChain) {
      log(`[reserved2] 已连续 ${chain} 次回复检查都没等到真人新消息，暂停自我唤醒 ${key}（等真人开口）`);
      return;
    }
    // 群聊的检查间隔单独一档（默认 = 私聊的 3 倍，且至少 15s）：群里晚一点回头看更自然，
    // 也不会因为「刚发完就回来」把自己叫醒第二次。私聊仍用 autoReplyCheckMs。
    const baseMs = isGroup
      ? (Number(cfg.socialV2?.autoReplyCheckMsGroup) || Math.max(15000, (Number(cfg.socialV2?.autoReplyCheckMs) || 30000) * 3))
      : (Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    let delay = Math.max(1000, baseMs);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      st.replyCheckChain = (Number(st.replyCheckChain) || 0) + 1;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, errorText(error)));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  // 回合看门狗：collector 只在 turn/start 建、只由配对的 turn/end 清。事件流在回合中途断线、
  // 或 DSH 侧那一轮被 interrupted，都可能让 turn/end 永远不到；再叠上「有没有回合在跑 = 看 collector
  // 在不在」的判据，会话就会**永久繁忙**：所有唤醒（含控制台手动唤醒）都被吞掉，HTTP 却依旧回 {ok:true}。
  // 2026-10-11 实测：group:2000000001 因此 30 分钟不理人。这里给收集器一个 20 分钟不看门就作废的上限
  // （可用 socialV2.wake.turnStaleMs 覆盖），过期即清掉，保证繁忙状态一定能自愈。
  const TURN_STALE_MS = Math.max(60000, Number(cfg.socialV2?.wake?.turnStaleMs) || 20 * 60 * 1000);
  function isTurnCollectorLive(sid) {
    const collector = collectors.get(sid);
    if (!collector) return false;
    const at = Number(collector.lastEventAt ?? collector.startedAt ?? 0);
    if (!at) return true; // 没有时间戳的旧对象：保守当活着（重建路径造的对象不该被误杀）
    if (Date.now() - at < TURN_STALE_MS) return true;
    collectors.delete(sid);
    log(`[reserved2] 清理过期回合收集器 ${sid}（${Math.round((Date.now() - at) / 1000)}s 无事件，判定该回合已死）`);
    return false;
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid && (v2TurnStartAt.has(sid) || isTurnCollectorLive(sid))) return true;
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    backlog: 55,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 唤醒延迟 = 合批窗口（**最短**时间）+ 随机抖动，抽成纯函数便于自检（scripts/test-wake-jitter.mjs）。
  // 为什么要抖：主人的要求是「不要有应就回，@ 了也别马上就回，可以装死一小会」。固定窗口
  // 意味着「每次都在第 N 秒开口」，那本身也是机器味；真人回应是散开的。
  // 抖动只给**被消息叫醒**的场合；固定时刻的唤醒（提醒 reminder: / 定时 schedule: / 睡眠到期
  // timeout / 首帧 bootstrap）一律不抖，否则提醒会迟到。窗口 < 4000ms 时也不抖，
  // 这样历史部署里的 batchWindowMs=2000 行为完全不变。
  function wakeDelayMsV2(reason, batchWindowMs, random = Math.random) {
    const base = Math.max(1000, Math.round(Number(batchWindowMs) || 8000));
    const r = String(reason || '');
    const fixedTime = r === 'bootstrap' || r === 'timeout' || r.startsWith('reminder:') || r.startsWith('schedule:');
    if (fixedTime || base < 4000) return { baseBatchMs: base, jitterMs: 0, batchMs: base, jittered: false };
    const jitterMs = Math.floor(random() * base);
    return { baseBatchMs: base, jitterMs, batchMs: base + jitterMs, jittered: true };
  }

  // 唤醒原因是不是"被点名"（@/叫名字/关键词/提问/指定成员/拍一拍）。
  // 被点名的场合用更短的接话冷却（reply.minGapDirectedMs）：她可以不秒回，但不能像没听见。
  function isDirectedWakeReasonV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return base === 'atMention' || base === 'nameMention' || base === 'keyword'
      || base === 'question' || base === 'speaker' || base === 'poke';
  }

  // 接话冷却（socialV2.reply.*）抽成纯函数便于自检（scripts/test-reply-gap.mjs）。
  // 返回 remainingMs = 还要再等多久才允许开口（0 = 不用等）。语义是**延迟**而不是丢弃：
  // 消息已经在未读缓冲里，等冷却结束那次唤醒会把它们一起看到（与"静默丢回复"完全不同）。
  function replyGapWaitMsV2(reason, lastAiReplyAt, replyCfg, now = Date.now()) {
    const r = String(reason || '');
    const fixedTime = r === 'bootstrap' || r === 'timeout' || r.startsWith('reminder:') || r.startsWith('schedule:');
    const directed = isDirectedWakeReasonV2(r);
    const raw = directed ? replyCfg?.minGapDirectedMs : replyCfg?.minGapMs;
    const gapMs = Math.max(0, Math.round(Number(raw) || 0));
    if (fixedTime || gapMs <= 0) return { gapMs, directed, waitMs: 0, skipped: fixedTime ? 'fixed-time' : 'disabled' };
    const last = Number(lastAiReplyAt) || 0;
    if (last <= 0) return { gapMs, directed, waitMs: 0, skipped: 'no-reply-yet' };
    return { gapMs, directed, waitMs: Math.max(0, last + gapMs - now), skipped: '' };
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const { baseBatchMs, jitterMs, batchMs: jitteredBatchMs } = wakeDelayMsV2(reason, st.wakeConfig?.batchWindowMs);
    // 接话冷却：刚说过话就把这次唤醒往后推，冷却结束才发（延迟、不丢消息）。
    const gap = replyGapWaitMsV2(reason, st.lastAiReplyAt, cfg.socialV2?.reply);
    const batchMs = Math.max(jitteredBatchMs, gap.waitMs);
    const gapApplied = batchMs > jitteredBatchMs;
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, errorText(error)));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送（窗口 ${Math.round(baseBatchMs / 1000)}s${jitterMs > 0 ? ` + 抖动 ${Math.round(jitterMs / 1000)}s` : ''}${gapApplied ? `，接话冷却 ${gap.directed ? '@/' : ''}${Math.round(gap.gapMs / 1000)}s 还没走完` : ''}）`);
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, errorText(error)));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, errorText(error)));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  // 额度用尽时不再安排主动机会检查（被动回复照常）：一条日志最多每小时一条，免得刷屏。
  let budgetStopLoggedAt = 0;
  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (budgetConfig.enabled && budgetConfig.gateProactive) {
      const budget = budgetEvaluation();
      if (budget.level === 'stop') {
        if (Date.now() - budgetStopLoggedAt > 60 * 60 * 1000) {
          budgetStopLoggedAt = Date.now();
          log('[budget] ' + describeBudget(budget) + ' → 今天不再安排主动机会检查（被动回复不受影响）');
        }
        return;
      }
    }
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      // 群聊主动冒泡单独打折（proactive.groupMultiplier，默认 0.5）；私聊保持不变。
      if (key.startsWith('group:')) {
        prob *= Math.min(1, Math.max(0, Number(p.groupMultiplier ?? 0.5)));
      }
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      // 目的引擎：手里有件具体该提的事时，主动机会就不该靠掷骰子——
      // 概率抬到 0.8（深夜 0.6，夜里仍更克制）。闸门（静默/日上限/刚聊过/冷却）已在 selectPurpose 挡过。
      const purposeSel = purposeSelectionFor(key, st);
      const purposeSpeak = purposeSel.action === 'speak';
      if (purposeSpeak) prob = Math.max(prob, hour >= 23 || hour < 8 ? 0.6 : 0.8);
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck')
          .then((status) => {
            // 只有真投出去了才记"提过"：被限流/忙排队时不算，否则这一轮机会就白丢了。
            if (status !== 'sent' || !purposeSpeak) return;
            markPurposeFired(purposeState, purposeSel.purpose, Date.now());
            savePurposeState();
            log('[purpose] 已提过：' + describePurpose(purposeSel));
          })
          .catch((error) => log('[reserved2] proactive 唤醒异常 ' + key + ':', errorText(error)));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  // ── 定时主动唤醒（作息 / 节日祝福） ────────────────────────────────────────
  // 与 proactiveCheck（随机机会）不同，这里是**到点必叫**：
  //   config.socialV2.schedule = { enabled, items: [{ id, at: "HH:MM", title, hint, graceMs?, maxStaleMs? }] }
  // 命中当天该时刻后，对每个「最近活跃过」的会话投一次 sendWakePromptV2(key, 'schedule:<id>')，
  // 提示词里带上 item.hint（见 buildWakePromptV2 的 schedule: 分支）。
  // 每个 item 每天只触发一次，日期落盘到 state/schedule-state.json，重启不重复发；
  // 迟到超过 graceMs（默认 30 分钟，例如刚开机）就不补发，避免半夜补一句「早上好」。
  function scheduleItems() {
    const s = cfg.socialV2?.schedule ?? {};
    if (s.enabled === false) return [];
    return (Array.isArray(s.items) ? s.items : [])
      .filter((it) => it && typeof it.id === 'string' && /^\d{1,2}:\d{2}$/.test(String(it.at ?? '')));
  }

  function activeScheduleKeys(maxStaleMs) {
    const out = [];
    for (const [key, st] of socialV2.conversations) {
      if (!isSessionAllowedInCurrentMode(key)) continue;
      const last = Math.max(Number(st.lastIncomingAt) || 0, Number(st.lastAiReplyAt) || 0);
      if (last && Date.now() - last <= maxStaleMs) out.push(key);
    }
    return out;
  }

  // ── 到点提醒（reminders）与历史保留清理：都挂在 60s 定时器上 ────────────────
  // 挂在 startScheduleTickerV2（60s）而不是 socialLoopTick（5s）：due() 虽然是纯读，
  // 但投递会走唤醒，5s 一查并不会让提醒更准，只会把重试/日志放大 12 倍。
  //
  // 跳过唤醒时的处理分两类（见 wakeSkipReasonV2）：
  //   · 自限性原因（唤醒额度超限）→ sendToQQ 直发兜底，别让提醒无声消失；
  //   · 人工意图原因（二代关闭 / 已暂停 / 非 reserved2 / 不在允许范围 / 投递被拒 / 静默模式）
  //     → 不兜底、也不标已触发，留待条件恢复后补投，超过 graceMs 再由 grace 分支收尾。
  const REMINDER_FALLBACK_SKIP_REASONS = new Set(['ratelimit']);
  const HISTORY_PRUNE_INTERVAL_MS = 30 * 60 * 1000;
  let historyPrunedAt = 0;

  /** 提醒时间参数：绝对 dueAt（毫秒或 ISO 字符串）或相对 afterMs（≥ minLeadMs）。失败给中文报错。 */
  function resolveReminderDueAtV2(body) {
    const rawAfter = body?.afterMs;
    const rawDue = body?.dueAt;
    const hasAfter = rawAfter !== undefined && rawAfter !== null && String(rawAfter).trim() !== '';
    const hasDue = rawDue !== undefined && rawDue !== null && String(rawDue).trim() !== '';
    if (hasAfter) {
      const afterMs = Number(rawAfter);
      if (!Number.isFinite(afterMs)) return { ok: false, error: 'afterMs 必须是毫秒数' };
      if (afterMs < REMINDER_LIMITS.minLeadMs) return { ok: false, error: `提醒时间太近：afterMs 至少要 ${REMINDER_LIMITS.minLeadMs}（1 秒）` };
      return { ok: true, value: Date.now() + Math.round(afterMs) };
    }
    if (hasDue) {
      const asText = String(rawDue).trim();
      if (typeof rawDue === 'number' || /^\d+$/.test(asText)) {
        const num = Number(rawDue);
        if (!Number.isFinite(num)) return { ok: false, error: 'dueAt 毫秒数不正确' };
        return { ok: true, value: Math.round(num) };
      }
      const parsed = Date.parse(asText);
      if (!Number.isFinite(parsed)) return { ok: false, error: 'dueAt 无法解析：请给毫秒时间戳，或 ISO 时间字符串（如 2026-05-01T08:30:00+08:00）' };
      return { ok: true, value: parsed };
    }
    return { ok: false, error: '缺少提醒时间：请给 dueAt（毫秒或 ISO 时间）或 afterMs（≥1000）' };
  }

  /** 可选毫秒参数：空 → undefined；给了但不是数字 → 报错（别把 NaN 传进模块）。 */
  function optionalMsParamV2(value, label) {
    if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: undefined };
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, error: `${label} 必须是毫秒数` };
    return { ok: true, value: Math.round(num) };
  }

  function markReminderFiredV2(item) {
    const res = remindersStore().markFired({ id: item.id, nowMs: Date.now() });
    if (res && res.ok === false) {
      log(`[reserved2] 提醒标记失败 ${item.id}：${res.error ?? '未知'}`);
      return null;
    }
    remindersSkipLogged.delete(item.id);
    return res;
  }

  async function deliverReminderV2(item, nowMs) {
    const key = item.key;
    const graceMs = Math.max(0, Number(cfg.socialV2?.reminders?.graceMs) || 600000);
    const lateMs = nowMs - Number(item.dueAt);
    // 迟到太多（半夜关机 / 进程没起）直接标掉、不补发：补偿一句「该吃药了」比不提醒更糟。
    if (lateMs > graceMs) {
      markReminderFiredV2(item);
      log(`[reserved2] 提醒已过补发窗口（迟到 ${Math.round(lateMs / 60000)} 分钟 > ${Math.round(graceMs / 60000)} 分钟），只标记不发送：${item.id}`);
      return;
    }
    if (shouldBlockSilentReply(key)) {
      if (!remindersSkipLogged.has(item.id)) {
        remindersSkipLogged.add(item.id);
        log(`[reserved2] 静默模式：提醒暂不投递（保留待发）${key}（${item.id}）`);
      }
      return;
    }
    const st = getSocialV2State(key);
    // 必须在调用 sendWakePromptV2 **之前**写：buildWakePromptV2 的 reminder: 分支要读它们。
    st.pendingReminderText = String(item.text);
    st.pendingReminderDueText = formatLocalTime(item.dueAt);
    let status = 'skipped';
    try {
      status = await sendWakePromptV2(key, `reminder:${item.id}`);
    } catch (error) {
      status = 'skipped';
      wakeSkipReasonV2.set(key, 'error');
      log(`[reserved2] 提醒唤醒异常 ${key}（${item.id}）:`, errorText(error));
    }
    if (status === 'sent' || status === 'queued') {
      // 两条都清：queued 只是「原因进了队列」，真正的提示词由补投路径按 id 回查，槽位不再有用。
      st.pendingReminderText = null;
      st.pendingReminderDueText = null;
      log(`[reserved2] 提醒已投递 ${key}（${item.id}，${status}）`);
      markReminderFiredV2(item);
      return;
    }
    const skipReason = wakeSkipReasonV2.get(key) ?? 'unknown';
    if (!REMINDER_FALLBACK_SKIP_REASONS.has(skipReason)) {
      st.pendingReminderText = null;
      st.pendingReminderDueText = null;
      if (!remindersSkipLogged.has(item.id)) {
        remindersSkipLogged.add(item.id);
        log(`[reserved2] 提醒唤醒被跳过（${skipReason}），不兜底、留待重试：${key}（${item.id}）`);
      }
      return;
    }
    // 自限性跳过（唤醒额度超限）：退化为直接发一条 QQ 文本（sendToQQ 自己会清洗/分条）。
    st.pendingReminderText = null;
    st.pendingReminderDueText = null;
    log(`[reserved2] 提醒唤醒被限流（${skipReason}），改用直发兜底：${key}（${item.id}）`);
    // 判定用**本批次的回执**（sendToQQResult.done），不读 lastSendFailed 那个按 key 的共享槽：
    // 并发发送时共享槽会把"没发出去"读成成功（markFired → 提醒永久丢失），
    // 或把"发出去了"读成失败（下个 tick 重发 → 重复提醒）。
    const receipt = sendToQQResult(key, `⏰ 提醒：${item.text}`);
    const sent = await receipt.done;
    if (sent.ok) {
      log(`[reserved2] 提醒直发兜底成功 ${key}（${item.id}，${sent.parts} 段）`);
      markReminderFiredV2(item);
    } else {
      log(`[reserved2] 提醒直发兜底失败，提醒不会丢、下个 tick 重试：${key}（${item.id}，${sent.parts} 段中 ${sent.failed} 段失败）`);
    }
  }

  function checkDueRemindersV2() {
    if (remindersCheckBusy) return;
    remindersCheckBusy = true;
    try {
      const nowMs = Date.now();
      const items = remindersStore().due(nowMs);
      if (!items.length) return;
      for (const item of items) {
        if (!item || !item.id || remindersInFlight.has(item.id)) continue;
        remindersInFlight.add(item.id);
        void deliverReminderV2(item, nowMs)
          .catch((error) => log(`[reserved2] 提醒投递异常 ${item.id}:`, errorText(error)))
          .finally(() => { remindersInFlight.delete(item.id); });
      }
    } catch (error) {
      log('[reserved2] 提醒检查异常:', errorText(error));
    } finally {
      remindersCheckBusy = false;
    }
  }

  /** 历史保留：30 分钟一次、按会话逐个 prune（模块的 prune 需要显式 key）。 */
  function maybePruneHistoryV2() {
    if (!historyEnabledV2()) return;
    const nowMs = Date.now();
    if (nowMs - historyPrunedAt < HISTORY_PRUNE_INTERVAL_MS) return;
    historyPrunedAt = nowMs;
    const retentionDays = Math.max(1, Number(cfg.socialV2?.history?.retentionDays) || HISTORY_LIMITS.retentionDays);
    const maxBytes = Math.max(1024 * 1024, Number(cfg.socialV2?.history?.maxBytes) || HISTORY_LIMITS.maxBytes);
    const beforeMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    const keys = [...socialV2.conversations.keys()];
    void (async () => {
      let removedLines = 0;
      let failed = 0;
      for (const key of keys) {
        if (!historyEnabledV2()) break;
        try {
          const res = await historyArchive().prune({ key, beforeMs, maxBytes });
          if (res?.ok === false) failed += 1;
          else removedLines += Number(res?.removedLines) || 0;
        } catch (error) {
          failed += 1;
          log(`[reserved2] 历史保留清理失败 ${key}:`, errorText(error));
        }
      }
      if (removedLines || failed) {
        log(`[reserved2] 历史保留清理：移除 ${removedLines} 行（保留 ${retentionDays} 天 / ${Math.round(maxBytes / 1048576)}MB）${failed ? `，${failed} 个会话失败` : ''}`);
      }
    })().catch((error) => log('[reserved2] 历史保留清理异常:', errorText(error)));
  }

  let scheduleTicker = null;
  function startScheduleTickerV2() {
    if (scheduleTicker) return;
    loadScheduleState();
    scheduleTicker = setInterval(() => {
      try {
        // 提醒到点检查与历史保留清理放在「暂停/模式」早退之前：
        //  · 提醒在暂停时不会真的发出去（唤醒会被跳过，走上面的不兜底分支），但 grace 过期
        //    的收尾与「条件恢复后补投」都需要 tick 继续跑；
        //  · 历史保留是纯本地维护，跟二代模式无关。
        checkDueRemindersV2();
        maybePruneHistoryV2();
        if (cfg.socialV2?.enabled === false || socialV2.paused || currentMode !== 'reserved2') return;
        const items = scheduleItems();
        if (!items.length) return;
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        for (const item of items) {
          const [hh, mm] = String(item.at).split(':').map((x) => Number(x));
          const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
          if (now < due) continue;
          if (now - due > (Number(item.graceMs) || 30 * 60 * 1000)) continue;
          if (scheduleState.fired[item.id] === today) continue;
          scheduleState.fired[item.id] = today;
          saveScheduleState();
          const stale = Number(item.maxStaleMs) || 3 * 24 * 60 * 60 * 1000;
          // 可选 `keys`：把这一条钉在指定会话上（例如「闲逛」只叫私聊，让她自己决定往哪分享）。
          // 不写就还是老行为：所有最近活跃的会话各叫一次。
          const pinned = (Array.isArray(item.keys) ? item.keys : [])
            .filter((k) => typeof k === 'string' && k.trim())
            .filter((k) => isSessionAllowedInCurrentMode(k));
          const keys = pinned.length ? pinned : activeScheduleKeys(stale);
          log(`[reserved2] 定时唤醒触发 ${item.id}（${item.at}，${item.title ?? ''}），目标会话 ${keys.length} 个${pinned.length ? '（指定）' : ''}`);
          for (const key of keys) {
            void sendWakePromptV2(key, `schedule:${item.id}`).catch((error) => log(`[reserved2] 定时唤醒异常 ${key}:`, errorText(error)));
          }
        }
      } catch (error) {
        log('定时唤醒检查异常:', errorText(error));
      }
    }, 60 * 1000);
    scheduleTicker.unref?.();
    log(`[reserved2] 定时唤醒已启用：${scheduleItems().map((i) => `${i.id}@${i.at}`).join('、') || '（未配置）'}`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    // 标记作废并放下 running：在途的那次投递可能永远不返回（DSH 卡住/重启），
    // 只删 map 条目会让「有没有回合在跑」永远为真，会话再也唤不醒。
    entry.cancelled = true;
    entry.running = false;
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    let textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    let plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    // 「听」语音：先标成「（转写中…）」，转写拿回来以后再补写进这条消息的文本里。
    // 这里刻意不 await：QQ 的转写是异步生成的，硬等会拖慢收消息并可能打乱落库顺序。
    if (currentMode !== 'gen1' && cfg.socialV2?.voice?.hear !== false) {
      const voices = extractVoiceFromSegments(event.message ?? []);
      if (voices.length) {
        const labels = voices.slice(0, 2);
        const swapVoicePlaceholders = (source) => {
          let i = 0;
          return String(source ?? '').replace(/\[语音\]/g, () => {
            const v = labels[i++];
            if (!v) return '[语音]';
            return v.duration ? `[语音 ${v.duration}s]（转写中…）` : '[语音]（转写中…）';
          });
        };
        textContent = swapVoicePlaceholders(textContent);
        plainContent = swapVoicePlaceholders(plainContent);
        if (messageRef) {
          void enrichVoiceTranscriptV2(key, messageRef, voices.length).catch((error) => {
            log(`[voice] 语音转写补写异常 ${key} ${messageRef}：${errorText(error)}`);
          });
        }
        log(`[voice] ${key} 收到 ${voices.length} 条语音，正在取 QQ 转写`);
      }
    }
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const result = await resetSessionContext(key, { reason: 'QQ /reset' });
        if (result) {
          await sendToQQ(key, result.keptV2State ? '已重置会话，下次消息开新上下文（记忆还留着）' : '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      const incomingReplyToId = Array.isArray(event.message)
        ? (event.message.find((seg) => seg?.type === 'reply' && seg.data?.id != null)?.data?.id ?? null)
        : null;
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), incomingReplyToId);
      // 跨会话长期记忆：先进 inbox，由维护任务统一打分/去重/衰减（命令、纯表情、太短的不记）
      rememberInboundForMemory({ key, kind, id, sender, isOwner, text: plainContent });
      // 人物七层：先情绪（要原话 + 说话人），再语感（只学群友），最后才进记忆大脑。
      // 三层各自 try/catch 且失败只提示一次——任何一层挂掉都不能挡住入库与唤醒。
      observeLayersInbound({ key, kind, sender, text: plainContent, userId: event.user_id ?? null });
      // 记忆大脑：原始消息入库（满 12 条窗口自动出 episode）；关掉开关时这个函数直接 return。
      rememberInboundForBrain(key, kind, sender, plainContent);
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        } else if (st.softWakeSkipReason) {
          appendActivity(`${key} [reserved2] 普通消息未唤醒（${st.softWakeSkipReason}）：消息已入未读 ${textContent.slice(0, 60)}`);
          st.softWakeSkipReason = '';
          return;
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 人物七层：与 reserved2 分支同一套（reserved2 已提前 return，两处互斥，不会重复计数）。
    observeLayersInbound({ key, kind, sender: event.sender?.card || event.sender?.nickname || String(event.user_id), text: plainContent, userId: event.user_id ?? null });
    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【${isGroupKey(key) ? '群聊' : '私聊'}上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(errorText(error)).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', errorText(error));
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    // 群管理审批：与"agent 请求审批"共用同一句「通过 / 拒绝」的回复链路，但它的放行
    // 后果是**真的调网关**（踢人/禁言），所以单独一条分支，且只有管理员能放行。
    if (p.kind === 'group-admin') {
      if (!isOwner) {
        await sendToQQ(key, '群管理审批仅管理员可操作');
        return;
      }
      await handleGroupAdminApproval(p, answerText, key);
      return;
    }
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）。
        // 移除时必须清掉超时定时器：否则那个 timer 会带着整个 entry 活到 questionTimeoutMs，
        // 到期回调因为 pending 已经不是它而什么都不做 —— 纯占着引用和内存。
        if (pending.get(key) === p) {
          clearTimeout(p.timer);
          pending.delete(key);
        }
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 同上：移除挂起时必须连带清掉超时定时器。
        if (pending.get(key) === p) {
          clearTimeout(p.timer);
          pending.delete(key);
        }
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        // 连之前先确认端点：DSH 换端口后能自己接上，而不是每 3 秒拨一个死端口。
        await ensureDshEndpoint({ reason: '事件流连接前' });
        // 日志带上目标地址：这次故障光看「连接 DSH 事件流…」根本看不出在连哪儿。
        log('连接 DSH 事件流…（' + api.baseUrl + '）');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            // 看门狗的心跳：谁刚动过、提示词多大、是不是正卡在长轮询里。
            noteTurnProgress(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                // 收集器只在 turn/start 创建（而不是「来任何事件就建」）：否则一条迟到的
                // 或重放的事件就会留下一个永远等不到 turn/end 的空收集器。
                if (frame.event.type === 'turn/start' && !learnerCollectors.has(frame.sessionId)) {
                  learnerCollectors.set(frame.sessionId, createTurnCollector());
                }
                const learnerCollector = learnerCollectors.get(frame.sessionId);
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  // 统计这个学习会话跑过多少轮，用于在上下文超限之前主动换一个干净会话。
                  if (frame.sessionId === slangLearnerSessionId) slangLearnerTurns += 1;
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 只在 turn/start 时创建：任何 stray / 重放的事件（比如重启前那一轮
            // 迟到的 assistant/message、end-seed）都不该造出一个永远等不到 turn/end 的收集器。
            if (frame.event.type === 'turn/start' && !collectors.has(frame.sessionId)) {
              collectors.set(frame.sessionId, createTurnCollector());
            }
            const collector = collectors.get(frame.sessionId);
            if (!collector) continue;
            const ended = collector.push(frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              // 上下文预算：这一轮提示词规模超护栏就重开会话（不阻塞本轮回帖，后台执行）。
              maybeResetContextAfterTurn(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                // 静默回合也必须收尾 pendingWake：否则下面的 continue 会跳过 pendingWakeKeys 的
                // 清理，会话被 30 分钟租约锁住，期间的 @/提问全被「会话繁忙」吞掉。
                // 只是不发唤醒条件提醒（静默回合本来就该闭嘴）。
                if (pendingWakeKeys.has(key)) {
                  pendingWakeKeys.delete(key);
                  disarmPendingWakeLease(key);
                  if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                    ensureWakeableV2(getSocialV2State(key), { key });
                    wakeConfigUpdatedKeys.delete(key);
                    markReadCalledKeys.delete(key);
                    wakeConfigMissCount.delete(key);
                  }
                }
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${errorText(error)}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
                    if (stillRelevant) {
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
                      scheduleWakeV2(key, item.reason);
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
                    }
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', errorText(error));
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', errorText(error));
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：事件流断开后那些等待拿不到任何新消息，
        // 只能等各自 timeoutMs 才结束；租约留着会用 429 卡住该会话最长 15 分钟的等待工具。
        // （handler 侧现在挂的是 res.on('close')，正常结束/客户端断开都会自己清租约；
        //   这里清的是「事件流重连」这种 handler 感知不到的情况。）
        activeWaits.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', errorText(error)); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', errorText(error)); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', errorText(error)); }
  });
  // 好友 / 入群申请（OneBot post_type:'request'）。SDK 1.14.x 的
  // WebSocketClient 有 onRequest（类型见 @snowluma/sdk dist/client/websocket-client.d.ts:48-49），
  // 但更老的运行时不保证有这个方法 —— 没有就退化（少收申请事件），绝不因为一次订阅
  // 失败让整个启动流程抛错。这与上面 onEvent / onBotStatus 的写法一致。
  try {
    bot.onRequest(async (event) => {
      try { await handleRequestEvent(event); } catch (error) { log('处理申请事件出错:', errorText(error)); }
    });
  } catch (error) {
    log(`（申请事件订阅不可用，好友/入群申请将收不到：${errorText(error)}）`);
  }

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${errorText(error)}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${errorText(error)}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) selfUserId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${errorText(error)}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      if (r.updated) log(`🔄 已把当前 token 写回 config.json（${String(r.from).slice(0, 4)}… → ${String(r.to).slice(0, 4)}…）`);
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${errorText(error)}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${errorText(error)}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', errorText(error)));
  }
  // 启动时先发现一次端点：DSH 可能刚重启换了端口，别等 5 秒后的健康检查。
  try {
    await ensureDshEndpoint({ reason: '启动', force: true });
  } catch (error) {
    log('启动时 DSH 端点发现失败:', errorText(error));
  }
  // 长期记忆卡：先把上次的记忆读回来（readRoleState 之后、任何唤醒之前），再挂定时维护。
  startMemoryCardMaintenance();
  // 记忆大脑：开库 + 每日治理。config.memoryBrain.enabled=false 时这里只打一行「未开启」。
  startMemoryBrainMaintenance();
  // 人物七层：各自 enabled 独立判断（只开一层也能跑），启动日志与 04:10 定时都在里面。
  startPersonaLayers();
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();
  // 回合看门狗：每 20 秒看一次「有没有唤醒投递后再无下落」「有没有回合卡住不动」。
  // 放在 pumpMux 之前启动没关系 —— 它自己会等 dshReady 才干活。
  const turnWatchdogTimer = setInterval(() => { void runTurnWatchdog(); }, TURN_WATCHDOG_INTERVAL_MS);
  turnWatchdogTimer.unref?.();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? errorText(error));
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? errorText(error)); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
