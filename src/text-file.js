// 群聊/私聊「文件」消息的文本读取工具。
//
// 背景：OneBot 的 `file` 段在桥接里过去只被渲染成 `[文件 名字]` —— 名字之外一个字都拿不到，
// 而 SnowLuma 的 file 段 data 里其实带着 `url`（QQ 的 ftn 下载直链）。于是「让她读群里的
// txt」这件事缺的从来不是权限，而是一条数据通路。
//
// 这个模块只做**纯函数**部分：判名字像不像文本、判字节像不像文本、按编码解出字符串。
// 网络抓取交给 safe-fetch.js（那里有 SSRF 防护与字节上限），进程/端点接线在 bridge.js。
import { TextDecoder } from 'node:util';
import { errorText } from './error-text.js';

// 允许按扩展名直读的文本类后缀。刻意不含 .pdf/.docx/.xlsx —— 那些要真解析器，
// 假装能读比读不了更糟（模型会拿着二进制乱码当真内容引用）。
const TEXT_EXTS = new Set([
  '.txt', '.text', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env',
  '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.lua', '.sql',
  '.sh', '.bash', '.bat', '.cmd', '.ps1',
  '.srt', '.ass', '.vtt', '.lrc'
]);

/** 默认最多交给模型多少字符（超出截断并注明）。 */
export const DEFAULT_MAX_CHARS = 20000;
/** 默认最多下载多少字节（txt 通常远小于此；防的是"把一个 1GB 的 log 拖进来"）。 */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export function fileExtension(name) {
  const s = String(name ?? '').trim().toLowerCase();
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i) : '';
}

/** 扩展名是否属于「可以直接按文本读」的类别。 */
export function isTextFileName(name) {
  return TEXT_EXTS.has(fileExtension(name));
}

export function isTextExtensionList() {
  return [...TEXT_EXTS];
}

/** 人类可读的字节数。 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 字节看起来像不像文本：前 8KB 里不能有 NUL，且控制字符比例要低。
 * 这一层是给「扩展名骗人」用的（.txt 里塞了个 zip、.bin 里其实是纯文本）。
 */
export function looksLikeTextBuffer(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  let control = 0;
  for (const b of head) {
    if (b === 0) return false;
    // 允许 \t \n \r \f \x1b(ANSI) 与常见 UTF-8 高位字节
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control += 1;
  }
  return control / head.length < 0.02;
}

function decodeUtf16(buf, littleEndian) {
  const body = Buffer.from(buf.subarray(2));
  // Node 的 utf-16le 解码器只认小端；大端必须先按 16 位翻转字节。
  // （这里只该看 littleEndian —— 早先写成 `littleEndian !== (process.platform !== 'win32')`，
  //  在 Windows 上恰好把两个分支都反了：小端被翻转、大端被原样喂进去。）
  if (!littleEndian) {
    for (let i = 0; i + 1 < body.length; i += 2) {
      const t = body[i];
      body[i] = body[i + 1];
      body[i + 1] = t;
    }
  }
  return new TextDecoder('utf-16le').decode(body);
}

/**
 * 按 BOM → UTF-8(严格) → GBK 的顺序解文本。
 * 为什么不是「一律 UTF-8」：中文 Windows 上记事本存出来的 txt 至今仍是 GBK/GB18030，
 * 用 UTF-8 解会得到满屏 �，模型会以为文件是乱码而放弃。
 * @returns {{ text: string, encoding: string, ok: boolean }}
 */
export function decodeTextBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  if (!b.length) return { text: '', encoding: 'empty', ok: true };
  try {
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8-bom', ok: true };
    }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      return { text: decodeUtf16(b, true), encoding: 'utf-16le-bom', ok: true };
    }
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      return { text: decodeUtf16(b, false), encoding: 'utf-16be-bom', ok: true };
    }
    try {
      // fatal:true 是关键：默认的 UTF-8 解码器会把非法字节换成 U+FFFD 而**不报错**，
      // 那样就永远轮不到 GBK 分支，等于没做编码回退。
      const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
      return { text, encoding: 'utf-8', ok: true };
    } catch {
      // 落到中文 Windows 最常见的 GBK/GB18030
    }
    const text = new TextDecoder('gb18030').decode(b);
    return { text, encoding: 'gb18030', ok: true };
  } catch (error) {
    return { text: '', encoding: 'unknown', ok: false, error: String(errorText(error)) };
  }
}

/**
 * 从文件字节里抽出给模型看的正文。
 * @param {Buffer} buf
 * @param {{ maxChars?: number, name?: string }} [opts]
 * @returns {{ ok: boolean, text: string, encoding: string, truncated: boolean, note: string }}
 */
export function extractTextFromFile(buf, opts = {}) {
  const maxChars = Math.max(200, Math.round(Number(opts.maxChars) || DEFAULT_MAX_CHARS));
  if (!looksLikeTextBuffer(buf)) {
    return { ok: false, text: '', encoding: '', truncated: false, note: '内容看起来不是文本（含二进制字节）' };
  }
  const decoded = decodeTextBuffer(buf);
  if (!decoded.ok) {
    return { ok: false, text: '', encoding: decoded.encoding, truncated: false, note: `解码失败：${decoded.error ?? '未知编码'}` };
  }
  const text = decoded.text.replace(/\r\n?/g, '\n');
  if (text.length <= maxChars) {
    return { ok: true, text, encoding: decoded.encoding, truncated: false, note: '' };
  }
  return {
    ok: true,
    text: text.slice(0, maxChars),
    encoding: decoded.encoding,
    truncated: true,
    note: `文件较长，只读了前 ${maxChars} 字（全文 ${text.length} 字）`
  };
}
