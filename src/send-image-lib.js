// 图片发送共享库：路径闸门 / 格式·体积·像素校验 / 公网 URL 抓取。
//
// 它与语音（voice-core.js + send-voice-lib.js）同构，但图片有三条自己的硬约束：
//
//   ① **AI 只能发「图片库」内的文件**（默认 `media/images/`，改 `socialV2.media.dir`）。
//      相对路径只能在库内解析；绝对路径也必须落在库内（safeJoinLibrary 的 realpath
//      复核顺带挡住 symlink 逃逸）。库外文件请走操作者通道（控制台 / CLI）。
//      理由与语音完全一致：群聊内容不可信，prompt injection 不能变成「本机任意图片外发」。
//
//   ② **URL 只能由 safe-fetch.js 抓**：仅 http(s)、禁内网/环回/链路本地/CGNAT、
//      DNS 先解析并钉住 IP、逐跳重新校验、响应体限量，且必须是真图片（PNG/JPEG/GIF/WebP
//      魔数），否则拒。**绝不把 URL 直接交给网关去抓** —— 那等于让 SnowLuma 变成 SSRF
//      出口，还绕过上面每一条校验。
//
//   ③ **一律限量**：单张 `maxSendBytes`（默认 5 MB，配置再大也有硬上限）与像素上限
//      （防「图片炸弹」把网关/QQ 解码拖垮）。
//
// 本模块只负责「拿到可信的图片字节 + 解析出可发送的引用」；发送、限流、外发审计、
// 活动日志全在 bridge.js —— 和语音的分工一样，避免两份实现各自演化。
import fs from 'node:fs';
import path from 'node:path';
import { formatBytes, safeJoinLibrary } from './voice-core.js';
import { looksLikeImageBuffer, safeFetchBuffer } from './safe-fetch.js';
import { errorText } from './error-text.js';

/** QQ/网关支持的四种图片格式（与 safe-fetch.js 的 looksLikeImageBuffer 一致）。 */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** `socialV2.media.maxSendBytes` 的默认值：5 MB。 */
export const DEFAULT_MAX_SEND_BYTES = 5 * 1024 * 1024;

/**
 * 配置再大也不放行的硬上限。
 * URL 来源的图片会以 `base64://` 内联进 OneBot 请求体（体积 ×1.34），且网关要整段解码，
 * 20 MB 原始图已经会变成 ~27 MB 的 JSON —— 再大就不是"配置问题"而是"配置写错了"。
 */
export const HARD_MAX_SEND_BYTES = 20 * 1024 * 1024;

/** 单张图片像素上限（与接收侧 MAX_MEDIA_PIXELS 同值，防图片炸弹）。 */
export const MAX_SEND_PIXELS = 64_000_000;

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/** 把 `socialV2.media` 归一化成运行时配置（缺项兜底、越界钳制，写错配置也不该让链路炸）。 */
export function mediaCfg(cfg, ROOT) {
  const m = cfg?.socialV2?.media ?? {};
  const rawMax = Number(m.maxSendBytes);
  const maxSendBytes = Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(Math.floor(rawMax), HARD_MAX_SEND_BYTES)
    : DEFAULT_MAX_SEND_BYTES;
  const perMinute = Number(m.maxPerMinute);
  const perHour = Number(m.maxPerHour);
  return {
    // enabled 只闸「AI 能不能发图」；操作者通道（控制台本身就要用它调试）不受它限制，
    // 与 socialV2.voice.enabled 的口径一致。
    enabled: m.enabled !== false,
    dir: path.resolve(ROOT, String(m.dir ?? path.join('media', 'images'))),
    maxSendBytes,
    // 频率口径：复用语音的「独立时间戳桶 + maxPerMinute/maxPerHour，只检查、发出后才记账」。
    // 图片没有并进文本发送的 sendTimes，理由是图片比文字重得多：一两次发图不该吃掉聊天额度，
    // 反过来刷图也不该把闲聊额度耗光。默认值与语音相同（2/分钟、10/小时）。
    maxPerMinute: Number.isFinite(perMinute) && perMinute >= 0 ? Math.floor(perMinute) : 2,
    maxPerHour: Number.isFinite(perHour) && perHour >= 0 ? Math.floor(perHour) : 10,
    maxPixels: MAX_SEND_PIXELS
  };
}

/**
 * AI 侧的图片工具总闸：`socialV2.tools.sendImage` 且 `socialV2.media.enabled`。
 * bridge.js 的 403 判定与 MCP 的**热折算**（`desiredToolStates()`：全部注册后按活配置 enable/disable，
 * 见 mcp-snowluma-safe.js 的 `TOOL_PARENT_GATES`）都读它，保证「控制台显示关闭」与「调用被拒」永远一致。
 */
export function sendImageToolEnabled(cfg) {
  return cfg?.socialV2?.tools?.sendImage !== false && cfg?.socialV2?.media?.enabled !== false;
}

/** 递归列出图片库里的图片（相对路径排序，结果稳定），供"库里有什么"的提示使用。 */
export function listImageFiles(dir, { maxDepth = 4 } = {}) {
  const root = path.resolve(dir);
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
      else if (e.isFile() && IMAGE_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 库内绝对路径 → 相对名（永远用 `/` 分隔，方便模型照抄）。 */
export function imageLibraryName(dir, absPath) {
  return path.relative(path.resolve(dir), absPath).split(path.sep).join('/');
}

/**
 * 解析「AI 给的图片引用」→ 图片库内的绝对路径。
 *
 * 安全边界（这里每一条都对应一次真实事故模式，别顺手放宽）：
 *   - 绝对路径必须落在图片库目录之内（`socialV2.media.dir`），否则拒绝；
 *   - 相对路径**只**在图片库内解析，绝不落到 process.cwd()，否则 `..\..\x.png` 就能读库外文件；
 *   - realpath 复核由 safeJoinLibrary 负责，symlink 指到库外同样拒绝。
 * 报错里只出现**目录名**，不出现绝对路径：这条消息会经 MCP 回给模型，而模型面对的是
 * 不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
 */
export function resolveImagePathInV2Library(dir, input) {
  const root = path.resolve(dir);
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('缺少图片：给图片库里的文件名（file，不知道有什么就随便传一个名字，报错里会列出库内清单），或传 url 发一张公网图片');
  }
  if (/^(base64:\/\/|data:|file:|https?:\/\/)/i.test(raw)) {
    throw new Error('file 参数只接受图片库内的本地文件；公网图片请用 url 参数（由桥接抓取并校验），不接受 base64://、data:、file:// 或 http(s):// 直接当路径');
  }

  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const confined = safeJoinLibrary(root, rel);
      if (confined && isFile(confined)) {
        return { path: confined, via: 'image-library-confined', name: imageLibraryName(root, confined) };
      }
    }
    throw new Error(`图片只能从图片库取文件（图片库目录：${path.basename(root)}）；即使是绝对路径也必须位于图片库之内。请把图片放进图片库，或用操作者通道（控制台 / CLI）发送库外文件。`);
  }

  const joined = safeJoinLibrary(root, raw);
  if (joined && isFile(joined)) {
    return { path: joined, via: 'image-library-safe', name: imageLibraryName(root, joined) };
  }
  // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出图片库）
  if (!path.extname(raw)) {
    for (const ext of IMAGE_EXTS) {
      const cand = safeJoinLibrary(root, `${raw}${ext}`);
      if (cand && isFile(cand)) {
        return { path: cand, via: 'image-library-safe+ext', name: imageLibraryName(root, cand) };
      }
    }
  }
  const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw);
  if (looksLikeEscape) {
    throw new Error('图片只能从图片库取文件：路径里出现了「..」，已拒绝（防止读到库外的本机文件）');
  }

  // 模糊提示：只列库内文件（绝不回显库外路径）
  const library = listImageFiles(root);
  const hint = library.length
    ? `图片库里现有：${library.slice(0, 12).map((f) => imageLibraryName(root, f)).join('、')}${library.length > 12 ? ` 等 ${library.length} 张` : ''}`
    : `图片库（${path.basename(root)}）目前是空的，先把图片文件放进去`;
  const want = path.basename(raw).toLowerCase();
  const wantNoExt = want.replace(/\.[^.]+$/, '');
  const fuzzyHits = library
    .filter((f) => {
      const base = path.basename(f).toLowerCase();
      return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
    })
    .map((f) => imageLibraryName(root, f));
  const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
  throw new Error(`图片库里找不到「${raw}」${fuzzy}。${hint}`);
}

/**
 * 操作者通道（控制台 / CLI）的路径解析：允许库外文件。
 *
 * 边界写清楚：这条通道由控制台令牌鉴权，操作者本来就能读本机文件，所以「库外」是
 * **有意放开**的；但 base64/data/http(s) 来源仍然禁止 —— 想发公网图片请走 url 参数
 * （那条路上有 SSRF 防护与格式校验），别让操作者入口变成任意 URL 的外发口子。
 */
export function resolveImagePathForOperator(dir, input, { cwd = process.cwd() } = {}) {
  const root = path.resolve(dir);
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('缺少图片路径');
  if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
    throw new Error('图片路径只接受本地文件；公网图片请用 url 参数（由桥接抓取并校验）');
  }
  if (path.isAbsolute(raw)) {
    if (isFile(raw)) return { path: fs.realpathSync(raw), via: 'absolute', name: path.basename(raw) };
  } else {
    // 两种直觉写法都成立：先按图片库解析，再按当前工作目录解析。
    const inLib = safeJoinLibrary(root, raw);
    if (inLib && isFile(inLib)) {
      return { path: inLib, via: 'image-library-safe', name: imageLibraryName(root, inLib) };
    }
    const inCwd = path.resolve(cwd, raw);
    if (isFile(inCwd)) return { path: fs.realpathSync(inCwd), via: 'cwd', name: raw };
    if (!path.extname(raw)) {
      for (const ext of IMAGE_EXTS) {
        const cand = safeJoinLibrary(root, `${raw}${ext}`);
        if (cand && isFile(cand)) {
          return { path: cand, via: 'image-library-safe+ext', name: imageLibraryName(root, cand) };
        }
      }
    }
  }
  throw new Error(`找不到图片「${raw}」`);
}

/**
 * 图片字节 → 类型与尺寸。**不接受**「扩展名说是 png 就当真」：只看魔数。
 * 返回 null 表示不是这四种图片。
 */
export function sniffImage(buffer) {
  if (!looksLikeImageBuffer(buffer)) return null;
  const buf = buffer;
  if (buf.toString('ascii', 0, 4) === 'RIFF') {
    const fourcc = buf.toString('ascii', 12, 16);
    let width = null;
    let height = null;
    try {
      if (fourcc === 'VP8X' && buf.length >= 30) {
        width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
      } else if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      } else if (fourcc === 'VP8 ' && buf.length >= 30) {
        width = buf.readUInt16LE(26) & 0x3fff;
        height = buf.readUInt16LE(28) & 0x3fff;
      }
    } catch { /* 尺寸解析失败不影响"这是 WebP"这个结论 */ }
    return { format: 'webp', mimeType: 'image/webp', ext: '.webp', width, height };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    let width = null;
    let height = null;
    try {
      if (buf.length >= 24) { width = buf.readUInt32BE(16); height = buf.readUInt32BE(20); }
    } catch {}
    return { format: 'png', mimeType: 'image/png', ext: '.png', width, height };
  }
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    let width = null;
    let height = null;
    try {
      if (buf.length >= 10) { width = buf.readUInt16LE(6); height = buf.readUInt16LE(8); }
    } catch {}
    return { format: 'gif', mimeType: 'image/gif', ext: '.gif', width, height };
  }
  // JPEG：扫 SOF 段拿尺寸（拿不到也不影响"这是 JPEG"）
  let width = null;
  let height = null;
  try {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const len = buf.readUInt16BE(offset + 2);
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = buf.readUInt16BE(offset + 5);
        width = buf.readUInt16BE(offset + 7);
        break;
      }
      offset += 2 + len;
    }
  } catch {}
  return { format: 'jpeg', mimeType: 'image/jpeg', ext: '.jpg', width, height };
}

/** 一行可读描述（进 `detail` 字段与活动日志，风格对齐 describeAudio）。 */
export function describeImage(info) {
  const parts = [info.format ? info.format.toUpperCase() : '图片', formatBytes(info.bytes ?? 0)];
  if (info.width && info.height) parts.push(`${info.width}x${info.height}`);
  return parts.join(' · ');
}

/**
 * 发送前统一校验：非空 → 体积 → 真图片 → 像素。
 * 顺序有意为之：先看体积（最便宜，也最可能拦住"把视频改名成 .png"），再看魔数。
 */
export function assertSendableImage(buffer, maxBytes, label = '图片') {
  if (!buffer || buffer.length === 0) throw new Error(`${label}内容为空`);
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : DEFAULT_MAX_SEND_BYTES;
  if (buffer.length > limit) {
    throw new Error(`${label}超过大小上限（上限 ${formatBytes(limit)}，实际 ${formatBytes(buffer.length)}）`);
  }
  const info = sniffImage(buffer);
  if (!info) throw new Error(`${label}不是有效图片（只支持 PNG / JPEG / GIF / WebP）`);
  const pixels = Number(info.width) * Number(info.height);
  if (Number.isFinite(pixels) && pixels > MAX_SEND_PIXELS) {
    throw new Error(`${label}像素过大（${info.width}x${info.height}，上限 ${MAX_SEND_PIXELS} 像素），已拒绝发送`);
  }
  return { ...info, bytes: buffer.length };
}

/** 读库内/库外本地图片并校验（先 stat 再读，避免把超大文件整段读进内存）。 */
export function readLocalImage(filePath, maxBytes, label = '图片') {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label}不是文件：${path.basename(filePath)}`);
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : DEFAULT_MAX_SEND_BYTES;
  if (stat.size > limit) {
    throw new Error(`${label}超过大小上限（上限 ${formatBytes(limit)}，实际 ${formatBytes(stat.size)}）`);
  }
  const buffer = fs.readFileSync(filePath);
  return { buffer, ...assertSendableImage(buffer, limit, label) };
}

/**
 * 抓公网图片并校验（SSRF 防护 + 体积 + 真图片）。
 * 注意 safeFetchBuffer 自己已经做了「仅 http(s) / 禁内网 / DNS 钉住 / 逐跳校验 / 限量读取 /
 * 魔数校验」，这里只补上像素上限与统一的报错前缀。
 */
export async function fetchImageBytes(url, maxBytes = DEFAULT_MAX_SEND_BYTES) {
  const raw = String(url ?? '').trim();
  if (!raw) throw new Error('缺少图片 URL');
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('图片 URL 必须是 http(s):// 开头（不接受 base64://、data:、file:// 等其它来源）');
  }
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : DEFAULT_MAX_SEND_BYTES;
  let fetched;
  try {
    fetched = await safeFetchBuffer(raw, limit);
  } catch (error) {
    throw new Error(`图片抓取失败：${errorText(error)}`);
  }
  const info = assertSendableImage(fetched.buffer, limit, '抓取到的内容');
  return { buffer: fetched.buffer, url: fetched.url, ...info };
}
