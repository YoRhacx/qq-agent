// 语音发送的共享内核：独立工具（上级 voice-tool/ 的 voice-cli.mjs / voice-gui.mjs）与桥接都用同一套规则。
//
// 这里的函数是**纯工具**（无全局副作用、不读 config 单例），调用方把配置传进来：
//   - voice-cli.mjs / voice-gui.mjs（在 ../voice-tool/）：直连 SnowLuma，
//     经 `../qq-bridge/src/voice-core.js` 引本文件（唯一实现，不复制）；配置读 voice-tool/config.json
//   - src/bridge.js：自己管白名单/限流/审计，但音频解析与 ffprobe 探测复用这里
//
// 关键设计：ffprobe 结果**写临时文件**而不是走 stdout 管道。
// 在受限沙箱（DSH workspace-write / 只读模式）里 spawn 一个 stdio:pipe 的子进程会直接
// EPERM，而"继承 stdio + 写文件"是允许的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { errorText } from './error-text.js';

/** 网关能直接吃进去的音频扩展名（SnowLuma 会自动转 SILK）。 */
export const AUDIO_EXTS = [
  '.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac',
  '.amr', '.silk', '.slk', '.wma', '.spx'
];

/** 已经是 QQ 原生 SILK 的扩展名：跳过探测。 */
const SILK_EXTS = new Set(['.silk', '.slk']);

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SECONDS = 300;

export function isAudioFile(file) {
  return AUDIO_EXTS.includes(path.extname(String(file)).toLowerCase());
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds) {
  const raw = Math.max(0, Number(seconds) || 0);
  // 不足 1 秒不要四舍五入成「0秒」：TTS 短句、被截断的音频都可能落在亚秒区间，
  // 报「时长 0秒超过上限」会让人以为代码坏了。
  if (raw > 0 && raw < 1) return `${Math.round(raw * 1000)} 毫秒`;
  const s = Math.round(raw);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${String(r).padStart(2, '0')}秒` : `${s}秒`;
}

/** 递归列出语音库里的音频（按相对路径排序，结果稳定）。 */
export function listAudioFiles(dir, { maxDepth = 4 } = {}) {
  const out = [];
  const walk = (cur, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && isAudioFile(e.name)) out.push(full);
    }
  };
  walk(path.resolve(dir), 0);
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 解析「音频来源」为用户实际想指的那个文件。
 *
 * 顺序：绝对路径/file:// → 相对 cwd → 语音库同名路径 → 补扩展名 → 语音库 basename 模糊匹配。
 * 返回 { path, via, candidates }（找不到时 path=null，candidates 是模糊候选）。
 */
export function resolveAudioSource(input, { voiceDir = null, cwd = process.cwd() } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return { path: null, via: 'empty', candidates: [] };
  const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };

  const cands = [];
  const add = (p, via) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!cands.some((c) => c.path === abs)) cands.push({ path: abs, via });
  };

  if (/^file:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      add(p, 'file-url');
    } catch {}
  } else if (path.isAbsolute(raw) || raw.startsWith('~')) {
    add(raw.startsWith('~') ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', raw.slice(1)) : raw, 'absolute');
  } else {
    add(path.resolve(cwd, raw), 'cwd');
  }
  const dir = voiceDir ? path.resolve(voiceDir) : null;
  if (dir && !path.isAbsolute(raw) && !/^file:\/\//i.test(raw)) add(path.join(dir, raw), 'voice-dir');

  for (const c of cands) {
    const st = stat(c.path);
    if (st?.isFile()) return { path: c.path, via: c.via, candidates: [], size: st.size };
  }
  if (!path.extname(raw)) {
    for (const c of cands) {
      for (const ext of AUDIO_EXTS) {
        const st = stat(c.path + ext);
        if (st?.isFile()) return { path: c.path + ext, via: `${c.via}+ext`, candidates: [], size: st.size };
      }
    }
  }
  const fuzzy = [];
  if (dir) {
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    for (const f of listAudioFiles(dir)) {
      const base = path.basename(f).toLowerCase();
      if (base === want || base.replace(/\.[^.]+$/, '') === wantNoExt) fuzzy.push({ path: f, via: 'voice-dir-fuzzy' });
    }
  }
  return { path: null, via: 'not-found', candidates: fuzzy };
}

/**
 * 安全解析「语音库内的相对路径」→ 绝对路径（拒绝路径穿越与符号链接逃逸）。
 * GUI 的上传/删除/播放接口都必须走这里。
 */
export function safeJoinLibrary(voiceDir, relPath) {
  const root = path.resolve(voiceDir);
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  const within = abs === root || abs.startsWith(root + path.sep);
  if (!within) return null;
  // 符号链接可能指向库外：用 realpath 再校验一次（文件不存在时按父目录判）
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch {
    return abs;
  }
}

/**
 * ffprobe 探测（时长/编码/sampleRate/channels）。
 * 结果写临时文件回传，stdout/stderr 一律 ignore（受限沙箱下 pipe 会 EPERM）。
 */
export async function probeAudio(file, { ffprobePath = 'ffprobe', timeoutMs = 10000, tmpDir = null } = {}) {
  const dirs = [tmpDir, path.join(os.tmpdir(), 'voice-probe')].filter(Boolean);
  let dir = null;
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); dir = d; break; } catch {}
  }
  if (!dir) return { ok: false, reason: '没有可写的临时目录用于 ffprobe 输出' };

  const outFile = path.join(dir, `p-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const run = () => new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name',
        '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels',
        '-of', 'json', '-o', outFile, file
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ code: -1, error: `ffprobe 启动失败：${errorText(error)}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffprobe 超时' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: `ffprobe 不可用：${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  try {
    const res = await run();
    if (res.error) return { ok: false, reason: res.error };
    let raw = '';
    try { raw = fs.readFileSync(outFile, 'utf8'); }
    catch (error) { return { ok: false, reason: `ffprobe 未产出结果（退出码 ${res.code}，${errorText(error)}）` }; }
    if (!raw.trim()) return { ok: false, reason: `ffprobe 结果为空（退出码 ${res.code}）` };
    const j = JSON.parse(raw);
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio');
    return {
      ok: true,
      duration: Number(j.format?.duration) || 0,
      formatName: j.format?.format_name ?? '',
      codec: audio?.codec_name ?? '',
      sampleRate: Number(audio?.sample_rate) || 0,
      channels: Number(audio?.channels) || 0
    };
  } catch (error) {
    return { ok: false, reason: `ffprobe 输出解析失败：${errorText(error)}` };
  } finally {
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/** 探测过一次「本机没有 ffprobe」之后就一直走 ffmpeg，不再每次白起一个失败的进程。 */
let ffprobeMissing = false;

/** 校验音频是否适合当 QQ 语音发。返回 { ok, size, duration, codec, warnings[], error }。 */
export async function inspectAudio(file, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxSeconds = DEFAULT_MAX_SECONDS,
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  ffmpegPath = null
} = {}) {
  const warnings = [];
  let st;
  try { st = fs.statSync(file); } catch (error) { return { ok: false, error: `文件不存在或不可读：${errorText(error)}` }; }
  if (!st.isFile()) return { ok: false, error: '不是文件（目录？）' };
  if (st.size === 0) return { ok: false, error: '文件为空' };
  if (st.size > maxBytes) return { ok: false, size: st.size, error: `文件过大（${formatBytes(st.size)} > 上限 ${formatBytes(maxBytes)}）` };
  if (!isAudioFile(file)) warnings.push(`扩展名 ${path.extname(file) || '(无)'} 不在常见音频列表内，将交给网关自行识别`);

  if (SILK_EXTS.has(path.extname(file).toLowerCase())) {
    return { ok: true, size: st.size, duration: null, codec: 'silk', formatName: 'silk', warnings };
  }
  const p = ffprobeMissing
    ? { ok: false, reason: '本机没有 ffprobe（已跳过探测）' }
    : await probeAudio(file, { ffprobePath });
  // 本机只有 ffmpeg、没有 ffprobe（剪映自带的那种）时，记住一次就够了：不然每次探测都要
  // 先白起一个必然 ENOENT 的 ffprobe 进程，再去问 ffmpeg。
  if (!p.ok && /不可用|ENOENT|not found|spawn/i.test(String(p.reason ?? '')) && ffprobePath === 'ffprobe') {
    ffprobeMissing = true;
  }
  // 第二选择：ffmpeg 自己也能报时长/编码（本机就只有剪映带的 ffmpeg，没有 ffprobe）。
  const probed = p.ok ? p : await probeAudioWithFfmpeg(file, { ffmpegPath });
  if (!probed.ok) {
    // 两个都探不到（连 ffmpeg 都没有）时退到纯 JS 估算：先按真实容器类型选估算器，
    // 别拿 WAV 去猜 MP3 帧（实测会把 1.46 秒算成 17 秒）。
    const wav = estimateWavDuration(file, st.size);
    const guessed = wav ?? estimateMp3Duration(file, st.size);
    if (guessed && guessed.duration > 0) {
      const kind = wav ? 'WAV' : 'MP3';
      const codec = wav ? 'wav' : 'mp3';
      if (guessed.duration > maxSeconds) {
        return { ok: false, size: st.size, duration: guessed.duration, codec, error: `时长 ${formatDuration(guessed.duration)}（按 ${kind} 头估算）超过上限 ${formatDuration(maxSeconds)}` };
      }
      if (guessed.duration > 60) warnings.push(`时长 ${formatDuration(guessed.duration)} 较长，QQ 会显示为长语音`);
      warnings.push(`时长按 ${kind} 帧头估算（${probed.reason}）：${formatDuration(guessed.duration)}，与真实时长可能有出入`);
      return {
        ok: true, size: st.size, duration: guessed.duration, codec, formatName: codec,
        sampleRate: guessed.sampleRate, channels: guessed.channels ?? 0, warnings
      };
    }
    warnings.push(`无法探测时长（${probed.reason}）：将不做时长校验，直接交给网关`);
    return { ok: true, size: st.size, duration: null, codec: '', formatName: '', warnings };
  }
  if (probed.duration > maxSeconds) {
    return { ok: false, size: st.size, duration: probed.duration, codec: probed.codec, error: `时长 ${formatDuration(probed.duration)} 超过上限 ${formatDuration(maxSeconds)}` };
  }
  if (probed.duration > 60) warnings.push(`时长 ${formatDuration(probed.duration)} 较长，QQ 会显示为长语音`);
  if (!probed.codec) warnings.push('没找到音频流，网关转码可能失败');
  return {
    ok: true, size: st.size, duration: probed.duration, codec: probed.codec,
    formatName: probed.formatName, sampleRate: probed.sampleRate, channels: probed.channels, warnings
  };
}

/**
 * 纯 JS 的 MP3 时长估算 —— ffprobe 不可用时的兜底。
 *
 * 为什么需要：本机（以及任何只装了 ffmpeg 没装 ffprobe 的机器）探测一律失败，
 * 而旧行为是「探测失败就放行」，等于把 `maxSeconds` 关掉（bridge.js 里对此有专门注释）。
 * MP3 的时长可以从帧头推出来，所以先自己算一遍再决定放不放行。
 *
 * 算法：跳过 ID3v2 → 找帧同步 → 顺着帧走最多 64 帧拿到「平均每毫秒字节数」，
 * 再按剩余字节数外推总时长。CBR/VBR 都能给出可用近似值；解析不出来返回 null。
 */
const MP3_BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 Layer III
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]      // MPEG2 / 2.5 Layer III
];
const MP3_SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

function parseMp3Frame(buf, at) {
  if (at + 4 > buf.length) return null;
  const b0 = buf[at];
  const b1 = buf[at + 1];
  const b2 = buf[at + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03; // 0=MPEG2.5, 1=保留, 2=MPEG2, 3=MPEG1
  const layerBits = (b1 >> 1) & 0x03;   // 1=Layer III
  if (versionBits === 1 || layerBits !== 1) return null;
  const version = versionBits === 3 ? 1 : (versionBits === 2 ? 2 : 25);
  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  const rateIndex = (b2 >> 2) & 0x03;
  if (rateIndex === 3) return null;
  const bitrate = MP3_BITRATES[version === 1 ? 0 : 1][bitrateIndex] * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version][rateIndex];
  const padding = (b2 >> 1) & 0x01;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const frameBytes = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + padding;
  if (frameBytes < 24) return null;
  return { frameBytes, ms: (samplesPerFrame / sampleRate) * 1000, bitrate, sampleRate };
}

/**
 * ffmpeg 探测（ffprobe 不可用时的第二选择）。
 *
 * 为什么需要：本机只装了剪映自带的 ffmpeg，没有 ffprobe（`spawn ffprobe ENOENT`），
 * 于是所有时长都退到纯 JS 估算。实测后果：一个 **1.46 秒的 WAV** 被 MP3 帧头估成
 * **17 秒**（PCM 数据里凑巧出现 0xFF 0xEx 就被当成帧同步），还会被标成「mp3 · 32.0kHz」——
 * 报告给用户/AI 的时长是错的，长音频的 `maxSeconds` 闸门也不可靠。
 *
 * 做法：`ffmpeg -i <file>` 会把 `Duration: 00:00:01.46` 和音频流信息打到 **stderr**。
 * 受限沙箱下 pipe 会 EPERM，所以这里把 stderr 直接重定向到临时**文件**再读回来
 * （stdio 传 fd 不是 pipe，不受该限制）。ffmpeg 没有输出文件时会以非 0 退出，这是正常的。
 */
export async function probeAudioWithFfmpeg(file, { ffmpegPath = null, timeoutMs = 10000, tmpDir = null } = {}) {
  const dirs = [tmpDir, path.join(os.tmpdir(), 'voice-probe')].filter(Boolean);
  let dir = null;
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); dir = d; break; } catch {}
  }
  if (!dir) return { ok: false, reason: '没有可写的临时目录用于 ffmpeg 输出' };

  const bin = resolveFfmpeg({ ffmpegPath });
  const logFile = path.join(dir, `ff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
  let fd = null;
  try { fd = fs.openSync(logFile, 'w'); }
  catch (error) { return { ok: false, reason: `临时日志不可写：${errorText(error)}` }; }

  const run = () => new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['-hide_banner', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', fd] });
    } catch (error) {
      resolve({ error: `ffmpeg 启动失败：${errorText(error)}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ error: 'ffmpeg 超时' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: `ffmpeg 不可用：${e.message}` }); });
    child.on('close', () => { clearTimeout(timer); resolve({}); });
  });

  let text = '';
  try {
    const res = await run();
    try { fs.closeSync(fd); } catch {}
    fd = null;
    try { text = fs.readFileSync(logFile, 'utf8'); } catch {}
    if (res.error) return { ok: false, reason: res.error };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(logFile); } catch {}
  }

  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return { ok: false, reason: 'ffmpeg 输出里没有 Duration（文件可能不是音频）' };
  const duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const rateM = /,\s*(\d+)\s*Hz/.exec(text);
  const chM = /,\s*(mono|stereo)\b/.exec(text);
  const codecM = /Stream #\d+:\d+.*?: Audio:\s*([A-Za-z0-9_]+)/.exec(text);
  const fmtM = /Input #0,\s*([a-z0-9_,]+)/.exec(text);
  return {
    ok: true,
    duration,
    // ffmpeg 打印的是 `Input #0, wav, from '...'`：正则会把结尾的逗号一起吃掉，这里剪掉。
    formatName: (fmtM?.[1] ?? '').replace(/[,\s]+$/, ''),
    codec: codecM?.[1] ?? '',
    sampleRate: Number(rateM?.[1]) || 0,
    channels: chM ? (chM[1] === 'mono' ? 1 : 2) : 0
  };
}

export function estimateMp3Duration(file, knownSize = null) {
  let buf;
  let bytes = knownSize;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return null;
    if (bytes == null) bytes = st.size;
    const want = Math.min(st.size, 256 * 1024);
    buf = Buffer.alloc(want);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, want, 0); } finally { fs.closeSync(fd); }
  } catch { return null; }

  let off = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + tagSize;
  }
  while (off + 4 <= buf.length && !parseMp3Frame(buf, off)) off += 1;
  if (off + 4 > buf.length) return null;

  let p = off;
  let walkedMs = 0;
  let walkedBytes = 0;
  for (let i = 0; i < 64; i += 1) {
    const frame = parseMp3Frame(buf, p);
    if (!frame || p + frame.frameBytes > buf.length) break;
    walkedMs += frame.ms;
    walkedBytes += frame.frameBytes;
    p += frame.frameBytes;
  }
  if (!walkedMs || !walkedBytes) return null;
  const dataBytes = Math.max(0, bytes - off);
  const duration = (dataBytes / walkedBytes) * (walkedMs / 1000);
  return duration > 0 ? { duration, sampleRate: parseMp3Frame(buf, off)?.sampleRate ?? 0 } : null;
}

/**
 * 纯 JS 的 WAV 时长估算 —— RIFF 头是自描述的，比从 PCM 里瞎猜 MP3 帧靠谱得多。
 *
 * 背景见 probeAudioWithFfmpeg 的注释：本地 TTS（HoYo TTS）产出的就是 WAV，
 * 以前会被 mp3 估算器算成十几倍时长。这里按 `fmt ` 的 byteRate 与 `data` 块大小算。
 */
export function estimateWavDuration(file, knownSize = null) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = Number(knownSize) > 0 ? Number(knownSize) : fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let fmt = null;
    let dataBytes = null;
    const chunk = Buffer.alloc(8);
    while (offset + 8 <= size) {
      if (fs.readSync(fd, chunk, 0, 8, offset) < 8) break;
      const id = chunk.toString('ascii', 0, 4);
      const len = chunk.readUInt32LE(4);
      const body = offset + 8;
      if (id === 'fmt ' && len >= 16) {
        const b = Buffer.alloc(Math.min(len, 40));
        const got = fs.readSync(fd, b, 0, b.length, body);
        if (got >= 16) {
          fmt = { channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), bits: b.readUInt16LE(14) };
        }
      } else if (id === 'data') {
        // 流式写出来的 WAV 可能把长度写成 0 或 0xFFFFFFFF，那就按文件剩余字节算。
        dataBytes = (len === 0 || len === 0xffffffff) ? Math.max(0, size - body) : len;
        break;
      }
      offset = body + len + (len % 2); // RIFF 块按偶数字节对齐
    }
    if (!fmt || !fmt.sampleRate || !fmt.channels || !fmt.bits) return null;
    const byteRate = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
    if (!byteRate) return null;
    const bytes = dataBytes == null ? Math.max(0, size - offset) : dataBytes;
    const duration = bytes / byteRate;
    return duration > 0
      ? { duration, sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, codec: 'wav' }
      : null;
  } catch {
    return null;
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
  }
}

/** 人类可读音频摘要。 */
export function describeAudio(info) {
  const b = [];
  if (info?.duration) b.push(formatDuration(info.duration));
  if (info?.size) b.push(formatBytes(info.size));
  if (info?.codec) b.push(info.codec);
  if (info?.sampleRate) b.push(`${(info.sampleRate / 1000).toFixed(1)}kHz`);
  if (info?.channels) b.push(info.channels === 1 ? '单声道' : `${info.channels}声道`);
  return b.join(' · ') || '未知音频';
}

/**
 * 目标 key 解析：group:123 / private:123。
 *
 * 号码必须是**正整数**（不以 0 开头）：QQ 号与群号都不可能是 0，
 * 放 `group:0` 过去只会让一个必然失败的请求走到网关。
 * 非零开头同时也挡住了 `group:007` 这种写法。
 */
export function parseTargetKey(key) {
  const m = /^(group|private):([1-9]\d*)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  return { kind: m[1], id: m[2], key: `${m[1]}:${m[2]}` };
}

/** 上传文件名净化：去掉路径、控制字符、Windows 保留字符，保留中文。 */
export function sanitizeUploadName(name) {
  let base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  base = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = 'audio';
  if (!isAudioFile(base)) base += '.mp3';
  if (base.length > 120) {
    const ext = path.extname(base);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/** 在语音库里为 filename 找一个不冲突的名字（foo.mp3 → foo-2.mp3）。 */
export function uniqueLibraryPath(voiceDir, filename) {
  const root = path.resolve(voiceDir);
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(root, filename);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${stem}-${n}${ext}`);
    n += 1;
    if (n > 999) throw new Error('同名文件太多，换个名字再传');
  }
  return candidate;
}

// ── 音量调节 ────────────────────────────────────────────────────────────────
//
// 为什么在**本地**做：SnowLuma 只接受「音频文件」并自己转 SILK，没有音量参数
// （record 段只有 file/magic/url 之类，没有增益字段）。所以音量必须在交给网关之前
// 用 ffmpeg 调好，再把处理后的文件当普通音频发出去。
//
// 两种模式：
//   · volume 倍数/分贝 —— volume=2.0 或 volume=3dB。直观，可复现。
//   · loudnorm（智能音量）—— EBU R128 响度归一，把整体响度拉到目标 LUFS。
//     对"录音忽大忽小/整体太小"最有效；但它会**大幅改变动态**，不适合有音乐/音效的内容。
//     （曾经考虑 speechnorm，但它对非语音内容会过度抬升噪声，故不作为默认智能模式。）

/** 音量倍数范围（1.0 = 原样）。QQ 语音常见需求是"调大"，所以上限给到 4 倍。 */
export const VOLUME_MIN = 0.1;
export const VOLUME_MAX = 4;
/** 智能音量（loudnorm）的目标响度，单位 LUFS。 */
export const LOUDNESS_TARGETS = { quiet: -20, normal: -16, loud: -13 };

/** 解析语音处理选项；返回 { volume, loudness }（两者互斥，loudness 优先）。 */
export function resolveAudioProcessing({ volume = 1, normalize = false, loudness = 'normal' } = {}) {
  if (normalize === true) {
    // 允许两种写法：档位名（quiet/normal/loud）或直接的 LUFS 数字。
    // 注意顺序：**先判数字**再查档位表 —— 否则 -18 这种数字会被当成"未知档位"拒掉。
    if (typeof loudness === 'number') {
      if (!Number.isFinite(loudness) || loudness < -40 || loudness > -5) {
        throw new Error(`目标响度需在 -40 ~ -5 LUFS 之间，收到 ${loudness}`);
      }
      return { volume: 1, loudness, loudnessKey: String(loudness) };
    }
    const key = String(loudness ?? 'normal');
    if (!Object.hasOwn(LOUDNESS_TARGETS, key)) {
      throw new Error(`未知的响度档位「${key}」（可选：${Object.keys(LOUDNESS_TARGETS).join(' / ')}，或直接给 -40~-5 的 LUFS 数字）`);
    }
    return { volume: 1, loudness: LOUDNESS_TARGETS[key], loudnessKey: key };
  }
  const v = Number(volume);
  if (!Number.isFinite(v)) throw new Error(`音量必须是数字，收到「${volume}」`);
  if (v < VOLUME_MIN || v > VOLUME_MAX) {
    throw new Error(`音量倍数需在 ${VOLUME_MIN}~${VOLUME_MAX} 之间（1.0 = 原样），收到 ${v}`);
  }
  return { volume: v, loudness: null, loudnessKey: null };
}

/**
 * 常见安装位置 —— 只在显式配置与环境变量都没有时才用。
 *
 * 为什么需要这层兜底：本机 ffmpeg **不在 PATH**，唯一一份在剪映目录里
 * （`D:\JianyingPro\<版本号>\ffmpeg.exe`），而版本号会随剪映升级变化。
 * 没有这层时，配置一过期就会静默退回「找不到 ffmpeg」——音量/响度功能看起来还在，
 * 实际什么都没做。带 `'*'` 的条目表示"下面是版本号子目录，取最高的那个"。
 */
const FFMPEG_KNOWN_DIRS = [
  ['C:\\ffmpeg\\bin'],
  ['C:\\Program Files\\ffmpeg\\bin'],
  ['D:\\ffmpeg\\bin'],
  [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links')],
  ['D:\\JianyingPro', '*']
];
let discoveredFfmpeg; // undefined = 还没找过；null = 找过，没有

/** 在常见安装位置里找 ffmpeg；找不到返回 null（结果记忆化）。 */
export function discoverFfmpeg() {
  if (discoveredFfmpeg !== undefined) return discoveredFfmpeg;
  discoveredFfmpeg = null;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  for (const [dir, mode] of FFMPEG_KNOWN_DIRS) {
    if (!dir) continue;
    if (mode !== '*') {
      const bin = path.join(dir, 'ffmpeg.exe');
      if (isFile(bin)) { discoveredFfmpeg = bin; break; }
      continue;
    }
    try {
      const subs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      const hit = subs.map((s) => path.join(dir, s, 'ffmpeg.exe')).find(isFile);
      if (hit) { discoveredFfmpeg = hit; break; }
    } catch {}
  }
  return discoveredFfmpeg;
}

/**
 * 定位 ffmpeg：显式参数 → 环境变量 → 常见安装位置 → PATH。
 *
 * 优先级按**实现**写文档：config.json 的 socialV2.voice.ffmpegPath 是"这台机器上 ffmpeg 在哪"的
 * 显式配置，比环境变量更具体，所以参数优先（旧注释写成"环境变量 → 参数"，与代码相反，
 * 照着注释去改代码就会把用户的显式配置降级成环境变量兜底）。
 *
 * 只返回**确实存在**的文件路径。前面几个候选都没 stat 成功时返回裸命令名 'ffmpeg'，交给 spawn 按 PATH
 * 解析；旧实现在这种情况下返回 `candidates[0]`，哪怕那个路径根本不存在 —— 调用方于是拿到一句
 * 无信息量的"启动失败"，而不是 ENOENT 分支里那句"请设置 FFMPEG_PATH 或在 config.json 里指定"。
 */
export function resolveFfmpeg({ ffmpegPath = null, envVar = 'FFMPEG_PATH', discover = true } = {}) {
  const candidates = [ffmpegPath, process.env[envVar]].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  if (discover) {
    const found = discoverFfmpeg();
    if (found) return found;
  }
  // PATH 里找（不真正执行，交给 spawn 时再报错）；绝不再回退到不存在的候选路径。
  return 'ffmpeg';
}

/**
 * 用 ffmpeg 调整音量/响度，产出**新文件**。
 * 返回 { path, converted, volume, loudness, mode, detail, applied }。
 * 调用方负责在用完后删除 converted=true 的临时文件。
 *
 * @param {string} file 输入音频
 * @param {object} opts
 *   volume    音量倍数（1 = 原样）
 *   normalize 是否启用 loudnorm 智能音量
 *   loudness  响度档位 quiet/normal/loud 或直接给 LUFS 数字
 *   tmpDir    输出目录（默认系统临时目录下的 voice-processed）
 *   ffmpegPath 指定 ffmpeg 可执行文件
 */
export async function processAudioVolume(file, {
  volume = 1,
  normalize = false,
  loudness = 'normal',
  tmpDir = null,
  ffmpegPath = null,
  timeoutMs = 120000
} = {}) {
  // 参数校验统一交给 resolveAudioProcessing（单一入口，避免两处规则漂移）
  const plan = resolveAudioProcessing({ volume, normalize, loudness });

  // 原样：不产生新文件，省一次转码
  if (!plan.loudness && Math.abs(plan.volume - 1) < 1e-9) {
    return { path: file, converted: false, applied: false, volume: 1, loudness: null, mode: 'original', detail: '原始音量' };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath });
  const dir = tmpDir
    ? path.resolve(tmpDir)
    : path.join(os.tmpdir(), 'voice-processed');
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(file);
  // 输出统一用 m4a/mp3 这类"确定有损但体积小"的容器没必要：保留原扩展名，
  // 交给 ffmpeg 按扩展名挑编码器（mp3→libmp3lame、wav→pcm、ogg→libvorbis…）。
  // 风险是某些扩展名可能没有可用编码器，所以兜底用 wav（无损、编码器必然存在）。
  let outPath = path.join(dir, `vol-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || '.wav'}`);

  const filters = plan.loudness !== null
    ? [`loudnorm=I=${plan.loudness}:TP=-1.5:LRA=11`]
    : [`volume=${plan.volume}`];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', filters.join(','), '-ac', '1', outPath];

  const run = () => new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ code: -1, error: `ffmpeg 启动失败：${errorText(error)}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffmpeg 超时' }); }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, error: e.code === 'ENOENT' ? '找不到 ffmpeg（请设置 FFMPEG_PATH 或在 config.json 里指定 socialV2.voice.ffmpegPath）' : `ffmpeg 不可用：${e.message}` });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  let res = await run();
  // 原扩展名可能没有可用编码器（如 .amr/.silk 只读）→ 退回 wav 再试一次
  if ((res.error || res.code !== 0 || !fs.existsSync(outPath)) && ext && ext.toLowerCase() !== '.wav') {
    const wavPath = outPath.replace(/\.[^.]+$/, '.wav');
    const wavArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', filters.join(','), '-ac', '1', wavPath];
    res = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffmpeg, wavArgs, { windowsHide: true, stdio: 'ignore' });
      } catch (error) {
        resolve({ code: -1, error: `ffmpeg 启动失败：${errorText(error)}` });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffmpeg 超时' }); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: `ffmpeg 不可用：${e.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
    });
    if (!res.error && res.code === 0 && fs.existsSync(wavPath)) outPath = wavPath;
  }

  if (res.error) throw new Error(res.error);
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`ffmpeg 音量处理失败（退出码 ${res.code}）`);
  }
  const st = fs.statSync(outPath);
  if (st.size === 0) {
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error('ffmpeg 输出为空文件（源音频可能损坏）');
  }

  const detail = plan.loudness !== null
    ? `智能音量（响度归一 ${plan.loudness} LUFS）`
    // 提升与压低必须分开说明。旧写法 `plan.volume > 1 ? A : A` 两个分支字面相同，把本来要表达的
    // "放大 / 衰减"区别写没了：操作者看到"音量 30%"时分不清是配置生效了还是根本没生效，
    // 排查语音太轻/太响时会白白绕一圈。
    : (plan.volume > 1
      ? `音量提升至 ${Math.round(plan.volume * 100)}%`
      : `音量压低至 ${Math.round(plan.volume * 100)}%`);
  return {
    path: outPath,
    converted: true,
    applied: true,
    volume: plan.volume,
    loudness: plan.loudness,
    mode: plan.loudness !== null ? 'loudnorm' : 'volume',
    detail,
    bytes: st.size
  };
}

/** 删除临时处理文件（失败不抛）。 */
export function cleanupTemp(file, isTemp) {
  if (!isTemp) return;
  try { fs.unlinkSync(file); } catch {}
}
