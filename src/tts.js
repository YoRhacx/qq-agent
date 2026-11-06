// 文字转语音（TTS）内核：把 AI 想说的话现场合成成音频，再走既有的语音发送链路。
//
// 为什么用它：语音库（audio/）里只有预先准备好的固定音频，AI 没法「说任意一句话」。
// 现在有两条路线（provider）：
//   - edge（默认）：微软 Edge 的 Read Aloud 接口（即社区常说的免费 edge-tts，包 msedge-tts），
//     不需要 API key、不花钱、中文音色够用（zh-CN-XiaoyiNeural 之类），本机实测一次合成 ~0.3s；
//   - local：本机常驻的 HoYo TTS 服务（原神/星穹铁道 251 个角色音色，见 tools/tts-local/），
//     音色名写成 `local:hoyo:129`（129 = 派蒙）。CPU 推理一句 3 秒的话约 5 秒。
//
// 设计边界（与 voice-core.js 的既有安全口径一致）：
//   - 只产出本地文件，且**只落在语音库目录的子目录里**（默认 audio/tts/），
//     这样它天然满足「AI 只能发语音库内文件」的约束，不需要放宽任何路径闸门；
//   - 合成结果按内容哈希缓存：同一句话第二次发是零成本（既省钱也省时间）；
//   - 合成串行化（单条 WS 连接 / 单条本地推理），并带超时；失败一律抛可读错误，绝不静默产出空文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import msedgePkg from 'msedge-tts';
import { errorText } from './error-text.js';

// msedge-tts 是 CJS 包（dist/*.js 用 __exportStar 再导出），Node ESM 下具名导入
// 不一定被 cjs-module-lexer 识别，所以走 default 导入再解构。
const { MsEdgeTTS, OUTPUT_FORMAT } = msedgePkg;

/** 默认音色：小鲸鱼（女声、年轻、偏可爱），中文里最接近人设的一个。 */
export const TTS_DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';

/**
 * 精选音色表（只列中文相关的，避免把 300+ 个音色灌进模型上下文）。
 * name 是 edge 的 ShortName；label 给人看；hint 说明适合什么场景。
 */
export const TTS_VOICES = [
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊（女·年轻·默认）', hint: '默认，可爱俏皮，适合日常闲聊' },
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温柔）', hint: '更温柔稳重，适合安慰/认真说话' },
  { name: 'zh-CN-YunxiNeural', label: '云希（男·年轻）', hint: '少年音，适合切换成男声' },
  { name: 'zh-CN-YunxiaNeural', label: '云夏（男·少年）', hint: '更稚气的男声' },
  { name: 'zh-CN-YunjianNeural', label: '云健（男·解说）', hint: '体育解说腔，适合念梗' },
  { name: 'zh-CN-YunyangNeural', label: '云扬（男·播报）', hint: '新闻播报腔，正经场合' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（东北话·女）', hint: '整活/搞笑' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（陕西话·女）', hint: '整活/搞笑' },
  { name: 'zh-HK-HiuGaaiNeural', label: '曉佳（粤语·女）', hint: '粤语' },
  { name: 'zh-HK-WanLungNeural', label: '雲龍（粤语·男）', hint: '粤语' },
  { name: 'zh-TW-HsiaoChenNeural', label: '曉臻（台湾腔·女）', hint: '台湾腔' },
  { name: 'zh-TW-YunJheNeural', label: '雲哲（台湾腔·男）', hint: '台湾腔' }
];

// ── local provider（HoYo TTS）─────────────────────────────────────────────────────
/** 本地服务默认地址；可用 config.json 的 socialV2.voice.tts.local.url 覆盖。 */
export const TTS_LOCAL_DEFAULT_URL = 'http://127.0.0.1:5199';

/** local 音色名前缀：`local:hoyo:<角色编号或名字>`。 */
const LOCAL_VOICE_RE = /^local:hoyo:([0-9]{1,4}|[\p{Script=Han}A-Za-z()（）·\s]{1,12})$/u;

/**
 * 兜底用的本地音色小表（服务没起来 / 列不出来时仍让控制台有东西可选）。
 * 编号与名字来自 tools/tts-local/hoyo_speakers.txt（251 个里的「可爱女声」一批）。
 */
export const TTS_LOCAL_VOICES = [
  { name: 'local:hoyo:129', label: '派蒙（原神·活泼）', hint: '默认推荐，活泼可爱，最贴小鲸鱼人设' },
  { name: 'local:hoyo:179', label: '胡桃（原神·俏皮）', hint: '俏皮拖腔，适合整活' },
  { name: 'local:hoyo:82', label: '宵宫（原神·元气）', hint: '元气少女，语速偏快' },
  { name: 'local:hoyo:48', label: '可莉（原神·稚气）', hint: '小孩子音，奶声奶气' },
  { name: 'local:hoyo:172', label: '纳西妲（原神·温柔）', hint: '温柔软糯，适合安慰' },
  { name: 'local:hoyo:9', label: '三月七（星铁·清爽）', hint: '清爽活泼，适合日常' },
  { name: 'local:hoyo:239', label: '雷电将军（原神·御姐）', hint: '低沉御姐，反差萌' },
  { name: 'local:hoyo:220', label: '钟离（原神·男）', hint: '沉稳男声' }
];

// ── rvc provider（变声：先用别的音色把话说出来，再用 RVC 换成目标角色） ──────────────
//
// 为什么不做成「服务常驻 + HTTP」：实测 rvc-local 的 HTTP 服务在**工作线程**里跑 FAISS 检索会死锁
// （faiss 的 LLVM libomp 与 torch 的 libiomp5md 冲突，CLI 单线程没事、服务里 90s 不返回）。
// 所以这里直接用 **CLI 子进程**：每次冷启动约 7~12 秒（含模型 1s + RMVPE 4s），稳定优先。
/** 默认解释器/脚本：tools/rvc-local 里的独立 venv（CUDA 版 torch 2.11.0+cu128）。 */
export const TTS_RVC_DEFAULT_PYTHON = 'D:\\qq-bot\\qq-bridge\\tools\\rvc-local\\.venv\\Scripts\\python.exe';
export const TTS_RVC_DEFAULT_SCRIPT = 'D:\\qq-bot\\qq-bridge\\tools\\rvc-local\\infer_kurisu.py';
/** local:rvc:<角色> —— 角色名会被交给 RVC 模型目录里同名子目录。 */
const RVC_VOICE_RE = /^local:rvc:([A-Za-z0-9_-]{1,24})$/;

/** 可选的 RVC 角色音色（模型目录 tools/rvc-local/models/<key>/）。 */
export const TTS_RVC_VOICES = [
  // 已停用（2026-10-11）：RVC 变声出来的牧濑红莉栖「不像本人」，用户决定放弃，
  // 模型与 venv 已删除。留空数组即可让音色表/下拉框里不再出现它；
  // provider 代码保留成死路径，将来真有像样的音色再往这里加条目即可。
];

/** 是不是 RVC 音色。 */
export function isRvcVoice(name) {
  return RVC_VOICE_RE.test(String(name ?? '').trim());
}

function rvcVoiceKey(name) {
  const m = String(name ?? '').trim().match(RVC_VOICE_RE);
  return m ? m[1].toLowerCase() : '';
}

/** local 音色名是否合法（能跑出编号/名字即可，具体存在性由服务端判断）。 */
export function isLocalTtsVoice(name) {
  return LOCAL_VOICE_RE.test(String(name ?? '').trim());
}

function isLocalVoice(name) {
  // local:rvc:* 是另一个 provider（变声），不能落进 HoYo 分支
  return /^local:/i.test(String(name ?? '').trim()) && !isRvcVoice(name);
}

function localVoiceKey(name) {
  const raw = String(name ?? '').trim();
  const m = raw.match(/^local:hoyo:(.+)$/i);
  return m ? m[1].trim() : raw;
}

/** 本地服务拉回来的全量音色表（speakerId → 角色名），用来给合成产物取名字。 */
const LOCAL_SPEAKER_NAMES = new Map();

/** 从本地服务拉全量音色表（251 个）；拿不到就返回 null，由调用方退回小表。 */
export async function fetchLocalTtsVoices(options = {}) {
  const url = String(options.localUrl ?? options.url ?? TTS_LOCAL_DEFAULT_URL).replace(/\/+$/, '');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 3000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/speakers`, { signal: ac.signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.ok || !Array.isArray(body.speakers)) return null;
    for (const s of body.speakers) LOCAL_SPEAKER_NAMES.set(Number(s.id), String(s.name));
    return body.speakers.map((s) => ({
      name: `local:hoyo:${s.id}`,
      label: `${s.name}（HoYo ${s.id}）`,
      hint: '本地 HoYo TTS 角色音色',
      provider: 'local',
      speakerId: s.id,
      speakerName: s.name
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 文件名里能用的短标签（去掉空格与路径敏感字符）。 */
function safeLabel(s) {
  return String(s ?? '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 12);
}

// 名字表是异步拉回来的：没拉到的时候 voiceDisplayName 只能给 `hoyo129`，拉到后给「派蒙」，
// 同一句话就会分裂成两份缓存文件。落盘前先确保表就绪；拉不到就一分钟内不再重试（别每次都白等 3 秒）。
let localNamesLastTry = 0;
async function ensureLocalVoiceNames(localUrl) {
  if (LOCAL_SPEAKER_NAMES.size > 0) return;
  const now = Date.now();
  if (now - localNamesLastTry < 60000) return;
  localNamesLastTry = now;
  try {
    const list = await fetchLocalTtsVoices({ localUrl });
    if (!list || LOCAL_SPEAKER_NAMES.size === 0) {
      // 表都拉不到通常意味着服务没起来。先把它拉起来再拉一次，否则产物会退回
      // `hoyo48-…` 这种编号名，和之后拉表成功时的 `可莉-…` 分裂成两份缓存。
      if (await ensureLocalTtsService(localUrl, { waitMs: 30000 })) {
        await fetchLocalTtsVoices({ localUrl });
      }
    }
  } catch {}
}

/**
 * 音色的**人类可读名字**，例如 `local:hoyo:129` → `派蒙`、`zh-CN-XiaoyiNeural` → `晓伊`。
 *
 * 用途：合成产物落盘时带上名字（`audio/tts/派蒙-c4384388.wav`），否则控制台的语音库
 * 全是 sha1 文件名，看不出这条是谁说的。名字来自本地服务拉回来的全量表 → 精选小表 →
 * 编号兜底，三级都能给出一个可读的标签。
 */
export function voiceDisplayName(voice) {
  const raw = String(voice ?? '').trim();
  if (!raw) return '';
  const edge = TTS_VOICES.find((v) => v.name === raw);
  if (edge) return safeLabel(String(edge.label).split('（')[0]);
  const m = raw.match(/^local:hoyo:(.+)$/i);
  if (m) {
    const key = m[1].trim();
    const num = Number(key);
    if (Number.isFinite(num) && LOCAL_SPEAKER_NAMES.has(num)) return safeLabel(LOCAL_SPEAKER_NAMES.get(num));
    const curated = TTS_LOCAL_VOICES.find((v) => v.name === `local:hoyo:${key}`);
    if (curated) return safeLabel(String(curated.label).split('（')[0]);
    if (LOCAL_SPEAKER_NAMES.has(key)) return safeLabel(LOCAL_SPEAKER_NAMES.get(key));
    return safeLabel(`hoyo${key}`);
  }
  if (isRvcVoice(raw)) {
    const hit = TTS_RVC_VOICES.find((v) => v.name.toLowerCase() === raw.toLowerCase());
    return safeLabel(String(hit?.label ?? rvcVoiceKey(raw)).split('（')[0] || rvcVoiceKey(raw));
  }
  return safeLabel(raw.replace(/^local:/i, ''));
}

const VOICE_NAME_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}-[A-Za-z0-9]+Neural$/;

export const TTS_LIMITS = {
  /** 默认合成上限（字）。超长的语音没人听完，也会把一次唤醒拖很久。 */
  maxChars: 80,
  /** 硬上限：即使调用方把 maxChars 调大也不越过它。 */
  hardMaxChars: 200,
  /** 单次合成超时。edge 实测 ~0.3s；local（CPU 推理）一句 3 秒的话约 5s，20s 也够。 */
  timeoutMs: 20000,
  /** 缓存目录里最多保留多少个音频文件（超出按 mtime 删最旧）。 */
  maxCacheFiles: 400
};

const DEFAULT_OUTPUT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/** 一次合成里的可读参数（把 undefined/空串统统收敛成默认值）。 */
function normalizeOptions(options = {}) {
  const out = {
    voice: String(options.voice ?? '').trim() || TTS_DEFAULT_VOICE,
    rate: String(options.rate ?? '').trim() || '+0%',
    pitch: String(options.pitch ?? '').trim() || '+0Hz',
    volume: String(options.volume ?? '').trim() || '+0%',
    localUrl: String(options.localUrl ?? options.ttsLocalUrl ?? TTS_LOCAL_DEFAULT_URL).replace(/\/+$/, ''),
    localParams: options.localParams && typeof options.localParams === 'object' ? options.localParams : {},
    // 连不上本地服务时是否自动拉起一次（tools/tts-local/start-tts.ps1）。默认开。
    autoStartLocal: options.autoStartLocal !== false,
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TTS_LIMITS.timeoutMs
  };
  out.provider = isRvcVoice(out.voice) ? 'rvc' : (isLocalVoice(out.voice) ? 'local' : 'edge');
  if (out.provider === 'rvc') {
    const rvc = options.rvc && typeof options.rvc === 'object' ? options.rvc : {};
    out.voice = `local:rvc:${rvcVoiceKey(out.voice)}`;
    out.rvc = {
      python: String(rvc.python ?? TTS_RVC_DEFAULT_PYTHON),
      script: String(rvc.script ?? TTS_RVC_DEFAULT_SCRIPT),
      device: String(rvc.device ?? 'cuda:0'),
      f0Method: String(rvc.f0Method ?? 'rmvpe'),
      indexRate: Number.isFinite(Number(rvc.indexRate)) ? Number(rvc.indexRate) : 0.5,
      // 源音色：RVC 只变声不朗读，得先有个「说话的人」。三月七语速清亮，变完不容易糊。
      sourceVoice: String(rvc.sourceVoice ?? 'local:hoyo:9'),
      timeoutMs: Number(rvc.timeoutMs) > 0 ? Number(rvc.timeoutMs) : 180000,
      workDir: String(rvc.workDir ?? '').trim()
    };
  } else if (out.provider === 'local') {
    if (!isLocalTtsVoice(out.voice)) {
      throw new Error(`本地音色名不合法：${out.voice}（要 local:hoyo:<编号或名字>，如 local:hoyo:129 派蒙）`);
    }
    out.voice = `local:hoyo:${localVoiceKey(out.voice)}`;
  } else if (!VOICE_NAME_RE.test(out.voice)) {
    throw new Error(`音色名不合法：${out.voice}（要 edge 的 ShortName，如 ${TTS_DEFAULT_VOICE}，或本地音色 local:hoyo:129；可用 qq_list_voices 看可选音色）`);
  }
  return out;
}

/**
 * 把「AI 写出来的一行字」清洗成适合朗读的文本。
 *
 * 语音里念不出来或念出来很怪的东西都要去掉：CQ 码、markdown 标记、链接、
 * @某人、换行、零宽字符、连续空白。emoji 保留（edge 会跳过或读成描述，不影响），
 * 但连续 emoji 会压缩。
 *
 * 返回 { text, truncated, originalLength }；text 可能为空（调用方要当错误处理）。
 */
export function normalizeSpeechText(input, maxChars = TTS_LIMITS.maxChars) {
  const raw = String(input ?? '');
  const limit = Math.min(
    TTS_LIMITS.hardMaxChars,
    Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : TTS_LIMITS.maxChars
  );
  let text = raw
    // CQ 码（[CQ:image,...] / [CQ:at,qq=...] 之类）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    // markdown 链接/图片 → 只留可读文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 裸链接
    .replace(/https?:\/\/\S+/gi, ' ')
    // @昵称 / #频道
    .replace(/@[^\s，。！？、]{1,20}/g, ' ')
    // markdown 标记符号
    .replace(/[*_`~>#|]+/g, ' ')
    // 零宽字符与不可见控制符
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 连续重复的标点收成一个（「！！！」念出来很怪）
  text = text.replace(/([，。！？、；：,.!?;:])\1+/g, '$1');

  const originalLength = text.length;
  let truncated = false;
  if (text.length > limit) {
    // 尽量在标点处断开，且不要截得太短（至少取 60% 上限）
    const head = text.slice(0, limit);
    const cut = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('，'),
      head.lastIndexOf('、')
    );
    text = cut >= Math.floor(limit * 0.6) ? head.slice(0, cut + 1) : head;
    text = text.trim();
    truncated = true;
  }
  return { text, truncated, originalLength };
}

/** 解析用户给的音色名：支持 ShortName、label 里的中文别名、以及 local:hoyo:<角色>。 */
export function resolveTtsVoice(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return TTS_DEFAULT_VOICE;
  if (isRvcVoice(raw)) return `local:rvc:${rvcVoiceKey(raw)}`;
  const byRvc = TTS_RVC_VOICES.find((v) => raw.length >= 2 && (v.name.toLowerCase() === raw.toLowerCase() || v.label.includes(raw) || v.hint.includes(raw)));
  if (byRvc) return byRvc.name;
  if (isLocalVoice(raw)) {
    if (!isLocalTtsVoice(raw)) {
      throw new Error(`本地音色名不合法：${raw}（要 local:hoyo:<编号或名字>，如 local:hoyo:129 派蒙）`);
    }
    return `local:hoyo:${localVoiceKey(raw)}`;
  }
  const byName = TTS_VOICES.find((v) => v.name.toLowerCase() === raw.toLowerCase());
  if (byName) return byName.name;
  const byLocal = TTS_LOCAL_VOICES.find(
    (v) => raw.length >= 2 && (v.name.toLowerCase() === raw.toLowerCase() || v.label.includes(raw) || v.hint.includes(raw))
  );
  if (byLocal) return byLocal.name;
  const byLabel = TTS_VOICES.find((v) => raw.length >= 2 && (v.label.includes(raw) || v.hint.includes(raw)));
  if (byLabel) return byLabel.name;
  if (VOICE_NAME_RE.test(raw)) return raw; // 表外的 edge 音色也允许（比如别的语言）
  throw new Error(`不认识这个音色：${raw}（可选：${[...TTS_LOCAL_VOICES, ...TTS_VOICES].map((v) => `${v.label}=${v.name}`).join('、')}）`);
}

/** 音色属于哪个 provider（'edge' | 'local'），给桥接的 via 字段用。 */
export function ttsVoiceProvider(voice) {
  if (isRvcVoice(voice)) return 'rvc';
  return isLocalVoice(voice) ? 'local' : 'edge';
}

const synthQueue = { chain: Promise.resolve() };

function cacheKeyFor(opts, text) {
  // localParams / localUrl 会直接改变本地 TTS 的实际输出（noise_scale、length_scale、sdp_ratio…），
  // 必须并进 key：否则控制台调完参数，同样文本仍命中旧音频，听起来「调音没生效」且毫无提示。
  const localShape = opts.provider === 'local'
    ? `|${opts.localUrl ?? ''}|${JSON.stringify(opts.localParams ?? {})}`
    : '';
  return crypto.createHash('sha1')
    .update(`${opts.provider}|${opts.voice}|${opts.rate}|${opts.pitch}|${opts.volume}|${text}${localShape}`, 'utf8')
    .digest('hex');
}

/**
 * 原子写：先写临时文件再 rename，避免进程/写盘中断在缓存路径留下半截文件
 * （半截文件 >512 字节就会被当合法缓存，之后一直发出坏音频）。
 */
function writeFileAtomicSync(filePath, buf) {
  const tmp = `${filePath}.part-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function extFor(provider) {
  // edge 出 mp3，本地 HoYo 与 RVC 变声都出 wav
  return provider === 'edge' ? '.mp3' : '.wav';
}

/** 清理缓存目录：超过 maxCacheFiles 就按 mtime 删最旧的（先删旧的，绝不动刚写的那份）。 */
function pruneCache(dir, keepFile) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(mp3|wav)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        let st = null;
        try { st = fs.statSync(p); } catch {}
        return { p, mtimeMs: st?.mtimeMs ?? 0 };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const overflow = files.length - TTS_LIMITS.maxCacheFiles;
    // 跳过 keepFile 时不算删除数，否则删够 overflow 条就收手会留下超量文件（off-by-one）。
    let removed = 0;
    for (let i = 0; i < files.length && removed < overflow; i += 1) {
      if (path.resolve(files[i].p) === path.resolve(keepFile)) continue;
      try { fs.unlinkSync(files[i].p); removed += 1; } catch {}
    }
  } catch {
    // 清理失败不影响这次合成
  }
}

/** edge provider：打微软 Read Aloud 的 WS 接口。 */
function synthEdgeToFile(opts, text, filePath) {
  return new Promise((resolve, reject) => {
    const tts = new MsEdgeTTS();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { tts.close(); } catch {}
      reject(new Error(`TTS 合成超时（>${opts.timeoutMs}ms）`));
    }, opts.timeoutMs);
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { tts.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    (async () => {
      await tts.setMetadata(opts.voice, DEFAULT_OUTPUT_FORMAT);
      const { audioStream } = tts.toStream(text, { rate: opts.rate, pitch: opts.pitch, volume: opts.volume });
      const chunks = [];
      for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
      const buf = Buffer.concat(chunks);
      if (buf.length < 512) throw new Error('TTS 返回的音频太小（合成失败或音色不支持该文本）');
      writeFileAtomicSync(filePath, buf);
      finish(null, buf.length);
    })().catch((error) => finish(error));
  });
}

/** 把 edge 风格的 `-20%` / `+30%` 换成 HoYo TTS 的 length_scale（越小越快）。 */
function rateToLengthScale(rate, fallback = 1.0) {
  const m = String(rate ?? '').match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (!m) return fallback;
  const pct = Number(m[1]);
  const scale = 1 / (1 + pct / 100);
  return Math.min(2, Math.max(0.5, scale));
}

// ── 本地服务保活 ────────────────────────────────────────────────────────────────
/** 服务启动脚本（仓库内 tools/tts-local/start-tts.ps1）：幂等，活着就直接退出。 */
const TTS_LOCAL_LAUNCHER = path.resolve(fileURLToPath(new URL('../tools/tts-local/start-tts.ps1', import.meta.url)));

/** 上一次「拉起尝试失败」的时间：一分钟内不再重复拉起，避免每句话都白等一分钟。 */
let localEnsureFailedAt = 0;
/** 同一时刻只允许一次拉起尝试（并发合成共享同一次）。 */
let localEnsurePromise = null;

/** 探一次 /health；活着返回 true。 */
async function localTtsAlive(localUrl, timeoutMs = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${localUrl}/health`, { signal: ac.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 确保本地 TTS 服务在跑：连不上就调用 start-tts.ps1 拉起，然后轮询 /health 等它就绪。
 *
 * 为什么要有这个：服务是常驻进程，**静默死掉时 AI 完全无感**，只有用户点「合成并试发」
 * 才会看到「连不上本地 TTS 服务」（2026-10 实测发生过一次：进程被杀，日志最后一条是
 * 一次正常合成，既无 traceback 也无退出记录）。所以合成路径自己负责把它拉回来一次。
 *
 * @returns {Promise<boolean>} true = 已就绪，调用方可以重试合成。
 */
export async function ensureLocalTtsService(localUrl, options = {}) {
  const url = String(localUrl ?? TTS_LOCAL_DEFAULT_URL).replace(/\/+$/, '');
  if (await localTtsAlive(url)) return true;
  if (localEnsurePromise) return localEnsurePromise;
  if (Date.now() - localEnsureFailedAt < 60000) return false;
  const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 60000;
  localEnsurePromise = (async () => {
    try {
      await new Promise((resolve) => {
        let child;
        try {
          child = spawn('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TTS_LOCAL_LAUNCHER],
            { windowsHide: true, stdio: 'ignore' });
        } catch {
          resolve();
          return;
        }
        child.on('exit', resolve);
        child.on('error', resolve);
        const give = setTimeout(resolve, 20000);
        if (typeof give.unref === 'function') give.unref();
      });
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (await localTtsAlive(url)) return true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      localEnsureFailedAt = Date.now();
      return false;
    } finally {
      localEnsurePromise = null;
    }
  })();
  return localEnsurePromise;
}

/** local provider：POST 本机 HoYo TTS 服务，拿 wav 字节落盘。 */
async function synthLocalToFile(opts, text, filePath) {
  // 每次尝试单独计时：拉起服务可能要等几十秒，不能算进合成超时里。
  const attempt = async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const body = {
        text,
        speaker: localVoiceKey(opts.voice),
        length_scale: rateToLengthScale(opts.rate, 1.0),
        ...opts.localParams
      };
      const res = await fetch(`${opts.localUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch {}
        throw new Error(`本地 TTS 服务返回 ${res.status}${detail ? `：${detail}` : ''}（服务地址 ${opts.localUrl}，启动方式见 tools/tts-local/README.md）`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error('本地 TTS 返回的音频太小（合成失败或音色不支持该文本）');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let buf;
    try {
      buf = await attempt();
    } catch (error) {
      const connFailed = error?.name !== 'AbortError' && error instanceof Error
        && /fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(error.message + String(error.cause ?? ''));
      // 只对「连不上」自动拉起一次；服务返回了错误状态码是它自己的问题，别去反复重启它。
      if (!connFailed || opts.autoStartLocal === false) throw error;
      const up = await ensureLocalTtsService(opts.localUrl);
      if (!up) throw error;
      buf = await attempt();
    }
    writeFileAtomicSync(filePath, buf);
    return buf.length;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`本地 TTS 合成超时（>${opts.timeoutMs}ms，服务 ${opts.localUrl}）`);
    if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(error.message + String(error.cause ?? ''))) {
      throw new Error(`连不上本地 TTS 服务（${opts.localUrl}）：${error.message}。已尝试自动拉起 tools/tts-local/start-tts.ps1 仍未就绪，可手动执行该脚本或改用 edge 音色`);
    }
    throw error;
  }
}

/**
 * 调 RVC CLI 做一次变声。stdio 一律 ignore（受限沙箱下 pipe 会 EPERM），
 * 失败只靠退出码 + 产物是否存在判断，成功与否不看 stdout。
 */
function runRvcCli(cfg, inputWav, outputWav) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cfg.python, [
        cfg.script, '--wav', inputWav, '--out', outputWav,
        '--device', cfg.device, '--f0-method', cfg.f0Method, '--index-rate', String(cfg.indexRate)
      ], { windowsHide: true, stdio: 'ignore', cwd: path.dirname(cfg.script) });
    } catch (error) {
      reject(new Error(`RVC 变声启动失败：${errorText(error)}`));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`RVC 变声超时（>${cfg.timeoutMs}ms）`));
    }, cfg.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e?.code === 'ENOENT'
        ? `找不到 RVC 的解释器：${cfg.python}（改 config.json 的 socialV2.voice.tts.rvc.python）`
        : `RVC 不可用：${e?.message ?? e}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputWav)) resolve();
      else reject(new Error(`RVC 变声失败（退出码 ${code}）；想排查就在终端手动跑：${cfg.python} ${cfg.script} --wav <in.wav> --out <out.wav>`));
    });
  });
}

/** rvc provider：① 用源音色合成一句话 ② RVC 变声成目标角色 ③ 落到缓存路径。 */
async function synthRvcToFile(opts, text, filePath) {
  const cfg = opts.rvc;
  // 工作目录必须在仓库内：实测往 %TEMP%\qq-bridge-rvc 写音频会被拒
  // （scipy wavfile.write → PermissionError: [Errno 13]，ACL/防护问题），仓库内路径正常。
  const workDir = cfg.workDir || path.resolve(fileURLToPath(new URL('../state/rvc-work', import.meta.url)));
  fs.mkdirSync(workDir, { recursive: true });
  // ① 源音色：这里**绝对不能再调 synthesizeSpeech** —— 那会把任务排回同一个串行队列，
  //    而当前任务已经在队列里，内外互相等待 ⇒ 死锁（实测：控制台试听卡满 120s、一点产物都没有）。
  //    直接走 provider 级函数，绕过队列与缓存。
  const srcOpts = normalizeOptions({
    voice: cfg.sourceVoice,
    rate: opts.rate,
    localUrl: opts.localUrl,
    localParams: opts.localParams,
    timeoutMs: Math.min(opts.timeoutMs, 60000)
  });
  const srcPath = path.join(workDir, `src-${crypto.randomBytes(6).toString('hex')}${extFor(srcOpts.provider)}`);
  await synthToFile(srcOpts, text, workDir, srcPath);
  if (!fs.existsSync(srcPath) || fs.statSync(srcPath).size < 512) {
    throw new Error(`RVC：源音色（${cfg.sourceVoice}）没有产出可用音频`);
  }
  // ② 变声
  const tmpOut = path.join(workDir, `kurisu-${crypto.randomBytes(6).toString('hex')}.wav`);
  try {
    await runRvcCli(cfg, srcPath, tmpOut);
    const bytes = fs.statSync(tmpOut).size;
    if (bytes < 512) throw new Error('RVC 变声产物太小（<512 字节），多半是模型没加载起来');
    writeFileAtomicSync(filePath, fs.readFileSync(tmpOut));
    return bytes;
  } finally {
    // 源音频与变声产物都不留：以前只删 tmpOut，src-*.wav 每次调用都往工作目录里堆一份。
    try { fs.unlinkSync(tmpOut); } catch {}
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

/** 真·合成（不含缓存的网络部分）：串行执行，避免同时开一堆连接 / 一堆本地推理。 */
function synthToFile(opts, text, outDir, filePath) {
  if (opts.provider === 'rvc') return synthRvcToFile(opts, text, filePath);
  if (opts.provider === 'local') return synthLocalToFile(opts, text, filePath);
  return synthEdgeToFile(opts, text, filePath);
}

/**
 * 合成一句话 → 返回本地音频路径（edge 是 .mp3，local 是 .wav）。
 *
 * @param {string} input 要说的话（会自动清洗 + 截断）
 * @param {object} options { voice, rate, pitch, volume, outDir, maxChars, timeoutMs, localUrl, localParams }
 * @returns {Promise<{path:string, bytes:number, text:string, voice:string, provider:string, cached:boolean, truncated:boolean, ms:number}>}
 */
export async function synthesizeSpeech(input, options = {}) {
  const opts = normalizeOptions(options);
  const { text, truncated, originalLength } = normalizeSpeechText(input, options.maxChars);
  if (!text) throw new Error('没有可合成的文字（清洗后是空的）');
  // 只剩标点/emoji 的文字 edge 会返回 0 字节音频，最后报成「音频太小」很误导 —— 提前讲清楚。
  if (!/[\p{L}\p{N}]/u.test(text)) throw new Error('这段话没有可朗读的内容（清洗后只剩标点或表情）');
  const outDir = path.resolve(String(options.outDir ?? path.join('audio', 'tts')));
  fs.mkdirSync(outDir, { recursive: true });

  const key = cacheKeyFor(opts, text);
  // 名字表没就绪时先补一次，否则文件名前缀会从 `hoyo129` 变成「派蒙」，缓存身份跟着分叉。
  if (LOCAL_SPEAKER_NAMES.size === 0 && (opts.provider === 'local' || opts.provider === 'rvc')) {
    await ensureLocalVoiceNames(opts.localUrl);
  }
  // 文件名带音色名（`派蒙-c43843881efe.wav`）：控制台的语音库列表直接能看出这条是谁说的。
  // 名字只是前缀，缓存身份仍是 key（同音色同文本 → 同名 → 命中缓存）。
  const label = voiceDisplayName(opts.voice);
  const filePath = path.join(outDir, `${label ? `${label}-` : ''}${key.slice(0, 16)}${extFor(opts.provider)}`);
  const started = Date.now();
  try {
    const st = fs.statSync(filePath);
    if (st.isFile() && st.size > 512) {
      return { path: filePath, bytes: st.size, text, voice: opts.voice, provider: opts.provider, cached: true, truncated, originalLength, ms: Date.now() - started };
    }
  } catch {}

  // 串行化：把这次合成挂到队列尾部
  const run = synthQueue.chain.then(async () => {
    // 队首等待期间可能已经有别的调用写好了同一个缓存
    try {
      const st = fs.statSync(filePath);
      if (st.isFile() && st.size > 512) return { bytes: st.size, cached: true };
    } catch {}
    const bytes = await synthToFile(opts, text, outDir, filePath);
    return { bytes, cached: false };
  });
  synthQueue.chain = run.then(() => undefined, () => undefined);
  const result = await run;
  if (!result.cached) pruneCache(outDir, filePath);
  return {
    path: filePath,
    bytes: result.bytes,
    text,
    voice: opts.voice,
    provider: opts.provider,
    cached: result.cached,
    truncated,
    originalLength,
    ms: Date.now() - started
  };
}

/** 缓存目录现状（给控制台/排查用）。 */
export function ttsCacheStats(dir) {
  const outDir = path.resolve(String(dir ?? path.join('audio', 'tts')));
  try {
    const files = fs.readdirSync(outDir).filter((f) => /\.(mp3|wav)$/i.test(f));
    let bytes = 0;
    for (const f of files) {
      try { bytes += fs.statSync(path.join(outDir, f)).size; } catch {}
    }
    return { dir: outDir, files: files.length, bytes };
  } catch {
    return { dir: outDir, files: 0, bytes: 0 };
  }
}
