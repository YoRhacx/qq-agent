// 极简 GIF 解码 + 抽帧 + PNG 编码。
//
// 为什么要手写：桥接的 node_modules 里没有 sharp / jimp / omggif / gifuct-js / canvas，
// 机器上也没有 ffmpeg（既不在 PATH，也不在 D:\\qq-bot / D:\\bili-bot / whale-audio 下）。
// 而"读动图"本质上只需要：把 GIF 拆成几帧 → 挑几帧 → 编码成 PNG 交给多模态模型。
// 这三件事都是纯算法（LZW + 调色板合成 + zlib），node 内置 zlib 就够，不值得引依赖。
//
// 支持：GIF87a/89a、全局/局部调色板、透明色、隔行扫描、多帧、disposal 0/1/2/3、NETSCAPE 循环。
// 不支持：纯文本扩展块（跳过）、LZW 的某些畸形流（尽力而为，出错就少出一帧而不是整体失败）。

import zlib from 'node:zlib';

/* ------------------------------------------------------------------ *
 * GIF 解析
 * ------------------------------------------------------------------ */

/** 解析调色板：每个颜色 3 字节 RGB。 */
function readColorTable(buf, offset, count) {
  const table = new Uint8Array(count * 3);
  for (let i = 0; i < count * 3; i += 1) table[i] = buf[offset + i] ?? 0;
  return table;
}

/** LZW 解码：GIF 的变长码流。 */
function lzwDecode(minCodeSize, data, pixelCount) {
  const MAX_CODE = 4096;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  let bytePos = 0;

  const prefix = new Int32Array(MAX_CODE);
  const suffix = new Uint8Array(MAX_CODE);
  const initial = new Uint8Array(MAX_CODE);
  for (let i = 0; i < clearCode; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
    initial[i] = i;
  }

  const out = new Uint8Array(pixelCount);
  let outPos = 0;

  // 用显式栈展开"前缀链"，避免递归
  const stack = new Uint8Array(MAX_CODE + 1);

  let prevCode = -1;
  let firstByte = 0;

  while (outPos < pixelCount) {
    // 读一个 codeSize 位的码
    while (bitCount < codeSize) {
      if (bytePos >= data.length) return { pixels: out, complete: false };
      bitBuffer |= data[bytePos] << bitCount;
      bytePos += 1;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      prevCode = -1;
      continue;
    }
    if (code === endCode) break;

    let cur = code;
    let stackLen = 0;

    if (prevCode === -1) {
      // 首个码必须是单字节
      if (cur >= clearCode) break;
      firstByte = cur;
      out[outPos++] = cur;
      prevCode = cur;
      continue;
    }

    if (cur >= nextCode) {
      // KwKwK 情形：code 还没定义，等于 prevCode 展开 + firstByte
      if (cur > nextCode) break;
      stack[stackLen++] = firstByte;
      cur = prevCode;
    }

    while (cur >= clearCode) {
      if (cur >= nextCode || stackLen > MAX_CODE) return { pixels: out, complete: false };
      stack[stackLen++] = suffix[cur];
      cur = prefix[cur];
      if (cur < 0) break;
    }
    if (cur < 0) break;
    firstByte = cur & 0xff;
    stack[stackLen++] = firstByte;

    while (stackLen > 0 && outPos < pixelCount) {
      out[outPos++] = stack[--stackLen];
    }

    if (nextCode < MAX_CODE) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = firstByte;
      initial[nextCode] = initial[prevCode];
      nextCode += 1;
      // GIF 的码长增长比 TIFF 早一格
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prevCode = code;
  }

  return { pixels: out, complete: true };
}

/** 隔行扫描重排：GIF 的 4 段式交织。 */
function deinterlace(pixels, width, height) {
  const out = new Uint8Array(pixels.length);
  const passes = [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2]
  ];
  let src = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      out.set(pixels.subarray(src, src + width), y * width);
      src += width;
    }
  }
  return out;
}

/**
 * 解一个 GIF。
 * @param {Buffer|Uint8Array} input
 * @returns {{ ok:boolean, width:number, height:number, frames:Array, loop:number, note:string }}
 *   frames: [{ pixels:Uint8Array(RGBA), delayMs:number }]
 */
export function decodeGif(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  const empty = { ok: false, width: 0, height: 0, frames: [], loop: 0, note: '' };
  if (buf.length < 13) return { ...empty, note: '数据太短，不是 GIF' };
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return { ...empty, note: `不是 GIF（签名 ${JSON.stringify(sig)}）` };

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const bgIndex = buf[11];
  let pos = 13;

  const globalTableFlag = (packed & 0x80) !== 0;
  const globalTableSize = globalTableFlag ? 1 << ((packed & 0x07) + 1) : 0;
  let globalTable = null;
  if (globalTableFlag) {
    globalTable = readColorTable(buf, pos, globalTableSize);
    pos += globalTableSize * 3;
  }
  if (!width || !height) return { ...empty, note: 'GIF 尺寸为 0' };

  // 防御性上限：每帧都存一份整画布 RGBA 快照，200 帧 × 500×500×4 ≈ 200MB。
  // 按"总像素预算"决定最多解几帧（上限仍是 200），让 16MB 的大动图不会把进程撑爆。
  const FRAME_BYTES_BUDGET = 96 * 1024 * 1024;
  const frameCap = Math.max(1, Math.min(200, Math.floor(FRAME_BYTES_BUDGET / Math.max(1, width * height * 4))));

  // 画布（RGBA）
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let loop = 0;

  let gce = null; // 待生效的图形控制扩展
  let guard = 0;

  while (pos < buf.length && guard < 100000) {
    guard += 1;
    const block = buf[pos];
    pos += 1;

    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      // 扩展块
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9) {
        // 图形控制扩展
        const size = buf[pos];
        pos += 1;
        const flags = buf[pos];
        const delay = buf.readUInt16LE(pos + 1);
        const transparentIndex = buf[pos + 3];
        gce = {
          disposal: (flags >> 2) & 0x07,
          transparent: (flags & 0x01) !== 0,
          transparentIndex,
          delayMs: delay * 10
        };
        pos += size;
        // 块终止符
        while (buf[pos] !== 0x00 && pos < buf.length) pos += 1;
        pos += 1;
      } else if (label === 0xff) {
        // 应用扩展（NETSCAPE 循环）
        const size = buf[pos];
        pos += 1;
        const appId = buf.toString('latin1', pos, pos + Math.min(size, 11));
        pos += size;
        const subSize = buf[pos];
        pos += 1;
        if (subSize >= 3 && /NETSCAPE/i.test(appId)) {
          loop = buf.readUInt16LE(pos + 1);
        }
        pos += subSize;
        while (buf[pos] !== 0x00 && pos < buf.length) pos += 1;
        pos += 1;
      } else {
        // 其它扩展：按子块跳过
        while (pos < buf.length && buf[pos] !== 0x00) {
          pos += 1 + buf[pos];
        }
        pos += 1;
      }
      continue;
    }

    if (block !== 0x2c) {
      // 未知块：没法安全跳过，收工（已解出的帧照常返回）
      break;
    }

    // 图像描述符
    const left = buf.readUInt16LE(pos);
    const top = buf.readUInt16LE(pos + 2);
    const fw = buf.readUInt16LE(pos + 4);
    const fh = buf.readUInt16LE(pos + 6);
    const fPacked = buf[pos + 8];
    pos += 9;

    const localTableFlag = (fPacked & 0x80) !== 0;
    const interlace = (fPacked & 0x40) !== 0;
    const localTableSize = localTableFlag ? 1 << ((fPacked & 0x07) + 1) : 0;
    let table = globalTable;
    if (localTableFlag) {
      table = readColorTable(buf, pos, localTableSize);
      pos += localTableSize * 3;
    }
    if (!table) {
      // 没有调色板，这帧没法上色：跳过数据继续
      break;
    }

    // 图像数据：LZW 最小码长 + 数据子块
    const minCodeSize = buf[pos];
    pos += 1;
    const chunks = [];
    while (pos < buf.length && buf[pos] !== 0x00) {
      const len = buf[pos];
      pos += 1;
      chunks.push(buf.subarray(pos, pos + len));
      pos += len;
    }
    pos += 1; // 终止符
    const lzwData = Buffer.concat(chunks);

    const { pixels: indexed } = lzwDecode(minCodeSize, lzwData, fw * fh);
    const ordered = interlace ? deinterlace(indexed, fw, fh) : indexed;

    // 当前帧是"这一帧画完之后"的样子：GIF 的 disposal 语义作用在下一帧开始前
    const before = Buffer.from(canvas);

    const transparent = Boolean(gce?.transparent);
    const tIndex = gce?.transparentIndex ?? -1;

    for (let y = 0; y < fh; y += 1) {
      const cy = top + y;
      if (cy < 0 || cy >= height) continue;
      for (let x = 0; x < fw; x += 1) {
        const cx = left + x;
        if (cx < 0 || cx >= width) continue;
        const idx = ordered[y * fw + x];
        if (transparent && idx === tIndex) continue; // 透明像素：保留画布原值
        const o = (cy * width + cx) * 4;
        canvas[o] = table[idx * 3] ?? 0;
        canvas[o + 1] = table[idx * 3 + 1] ?? 0;
        canvas[o + 2] = table[idx * 3 + 2] ?? 0;
        canvas[o + 3] = 255;
      }
    }

    frames.push({
      pixels: new Uint8Array(canvas),
      delayMs: gce?.delayMs && gce.delayMs >= 20 ? gce.delayMs : 100
    });

    // 按 disposal 处理画布，供下一帧使用
    const disposal = gce?.disposal ?? 0;
    if (disposal === 2) {
      // 恢复背景色（此处按"透明"处理，比填背景色更接近主流浏览器观感）
      for (let y = 0; y < fh; y += 1) {
        const cy = top + y;
        if (cy < 0 || cy >= height) continue;
        for (let x = 0; x < fw; x += 1) {
          const cx = left + x;
          if (cx < 0 || cx >= width) continue;
          const o = (cy * width + cx) * 4;
          canvas[o] = 0;
          canvas[o + 1] = 0;
          canvas[o + 2] = 0;
          canvas[o + 3] = 0;
        }
      }
    } else if (disposal === 3) {
      canvas.set(before);
    }
    // disposal 0/1：保留，什么都不做

    gce = null;
    if (frames.length >= frameCap) break; // 防御性上限（按画布大小算，见 FRAME_BYTES_BUDGET）
  }

  if (!frames.length) return { ok: false, width, height, frames: [], loop, note: 'GIF 里没有可解的帧' };
  void bgIndex;
  const truncated = frames.length >= frameCap && frameCap < 200;
  return { ok: true, width, height, frames, loop, note: truncated ? `只解了前 ${frames.length} 帧（画布太大）` : '' };
}

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
export function encodePng(rgba, width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    const src = y * w * 4;
    const dst = y * (w * 4 + 1) + 1;
    for (let i = 0; i < w * 4; i += 1) raw[dst + i] = rgba[src + i] ?? 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ *
 * 抽帧
 * ------------------------------------------------------------------ */

/** 最近邻缩放（抽帧缩略图够用，且不会引入新依赖）。 */
export function scaleRgba(rgba, width, height, maxSide) {
  const limit = Math.max(16, Math.round(Number(maxSide) || 512));
  const longest = Math.max(width, height);
  if (longest <= limit) return { pixels: rgba, width, height };
  const ratio = limit / longest;
  const nw = Math.max(1, Math.round(width * ratio));
  const nh = Math.max(1, Math.round(height * ratio));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / nh));
    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / nw));
      const so = (sy * width + sx) * 4;
      const dof = (y * nw + x) * 4;
      out[dof] = rgba[so];
      out[dof + 1] = rgba[so + 1];
      out[dof + 2] = rgba[so + 2];
      out[dof + 3] = rgba[so + 3];
    }
  }
  return { pixels: out, width: nw, height: nh };
}

/**
 * 从 GIF 里均匀挑 count 帧（含首尾），编码成 PNG。
 * @param {Buffer|Uint8Array} input
 * @param {{ count?:number, maxSide?:number }} [opts]
 * @returns {{ ok:boolean, frames:Array<{png:Buffer,index:number,delayMs:number}>, width:number,
 *             height:number, totalFrames:number, animated:boolean, note:string }}
 */
export function extractGifFrames(input, opts = {}) {
  const count = Math.max(1, Math.min(12, Math.round(Number(opts.count) || 4)));
  const maxSide = Math.max(64, Math.min(2048, Math.round(Number(opts.maxSide) || 512)));
  const gif = decodeGif(input);
  if (!gif.ok) {
    return { ok: false, frames: [], width: gif.width, height: gif.height, totalFrames: 0, animated: false, note: gif.note };
  }
  const total = gif.frames.length;
  const animated = total > 1;

  // 均匀取样：0, n/(k-1), ... 保证首尾都在
  const picks = [];
  if (total <= count) {
    for (let i = 0; i < total; i += 1) picks.push(i);
  } else if (count === 1) {
    // 只要一帧就给中间那帧：动图的首帧常常是空白/黑场，中间帧信息量更大
    picks.push(Math.floor((total - 1) / 2));
  } else {
    for (let i = 0; i < count; i += 1) {
      picks.push(Math.round((i * (total - 1)) / (count - 1)));
    }
  }
  const uniq = [...new Set(picks)].filter((n) => Number.isInteger(n) && n >= 0 && n < total);

  const out = [];
  for (const index of uniq) {
    const frame = gif.frames[index];
    const scaled = scaleRgba(frame.pixels, gif.width, gif.height, maxSide);
    out.push({
      png: encodePng(scaled.pixels, scaled.width, scaled.height),
      index,
      delayMs: frame.delayMs,
      width: scaled.width,
      height: scaled.height
    });
  }

  const totalMs = gif.frames.reduce((a, f) => a + (Number(f.delayMs) || 0), 0);
  return {
    ok: true,
    frames: out,
    width: gif.width,
    height: gif.height,
    totalFrames: total,
    animated,
    durationMs: totalMs,
    note: ''
  };
}

/** 快速判断字节是不是 GIF。 */
export function isGifBuffer(buf) {
  if (!buf || buf.length < 6) return false;
  const sig = Buffer.from(buf.subarray(0, 6)).toString('latin1');
  return sig === 'GIF87a' || sig === 'GIF89a';
}

/** 快速判断字节是不是动图（GIF 且不止一帧，或 APNG/WebP 动画的粗略判据）。 */
export function isAnimatedBuffer(buf) {
  if (!buf) return false;
  if (isGifBuffer(buf)) {
    const gif = decodeGif(buf);
    return gif.ok && gif.frames.length > 1;
  }
  // 动画 WebP：RIFF....WEBP 且含 ANIM chunk
  const b = Buffer.from(buf);
  if (b.length > 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return b.includes(Buffer.from('ANIM', 'latin1'));
  }
  // APNG：PNG 签名 + acTL chunk
  if (b.length > 20 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') {
    return b.includes(Buffer.from('acTL', 'latin1'));
  }
  return false;
}

export default { decodeGif, encodePng, extractGifFrames, isGifBuffer, isAnimatedBuffer, scaleRgba };
