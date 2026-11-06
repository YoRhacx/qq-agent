// 历史消息归档与检索内核（AI 工具 qq_search_history 的底座）。
//
// 为什么需要它：既有记忆只有 qq_memory_* 的轻量 key-value 和摘要，回答不了「上礼拜你说的那个链接呢」。
// OneBot 网关**没有** search API，所以只能自建归档 + 自建检索。
//
// 三条设计边界：
//   1. **只写本地文件，不发 QQ 消息、不引 HTTP、不依赖 bridge.js** —— 纯逻辑模块，便于离线单测；
//   2. **每个会话一个 append-only JSONL 文件**（state/history/<key>.jsonl，一行一条 JSON）——
//      append 成本恒定、崩溃最多丢最后半行，不需要数据库；
//   3. **检索绝不把整库读进内存** —— 从文件尾部按块倒着读，扫到足够命中或撞到扫描上限就停
//      （默认最多回看最后 64MB / 20 万行 / 2000ms）。这是为了在 12k 行的桥接进程里
//      也能安全地被模型的工具调用频繁触发。
//
// CJK 友好：检索按**子串**匹配，不做分词、不依赖 ICU（Node 默认不带 full-icu 也照样工作）。
// ASCII 大小写不敏感；query 用空格分隔多个关键词时是 **AND**（都要出现才算命中）。
//
// 保留策略：默认每会话最多 30 天 / 64MB，超出按行删最旧的（重写用临时文件 + rename 原子替换）。
// append 里**不是每次都 prune**：每 500 次 append 或文件行数/体积超限时触发一次，
// 因为 prune 要全文重写，每条都做会把 append 变成 O(n)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 默认上限（都可在 createHistoryArchive({ limits }) 里覆盖，测试靠它压缩扫描预算）──
export const HISTORY_LIMITS = Object.freeze({
  /** 单条记录 text 上限（字符）。 */
  maxTextChars: 2000,
  /** 单条记录 media 数组上限。 */
  maxMediaItems: 8,
  /** query 长度上限（字符）。 */
  maxQueryChars: 100,
  /** 命中即可，stop 更早。 */
  maxHits: 50,
  /** 倒着读的总字节预算（默认 64MB）。 */
  maxScanBytes: 64 * 1024 * 1024,
  /** 倒着读的总行数预算（默认 20 万行）。 */
  maxScanLines: 200000,
  /** 单次检索耗时上限（毫秒）：超时返回已找到的部分并标 truncated。 */
  timeLimitMs: 2000,
  /** 倒着读的块大小（字节）；调小会让超时检查更密、吞吐更低（测试用它压缩预算）。 */
  chunkSize: 256 * 1024,
  /** snippet 里关键词前后各取多少字。 */
  snippetPad: 40,
  /** 时间戳最小值（早于此的 tsMs 视为缺失，用 now() 兜底）。 */
  tsFloorMs: 946684800000,
  /** prune 默认保留窗口（天）。 */
  retentionDays: 30,
  /** prune 默认体积上限（字节）。 */
  maxBytes: 64 * 1024 * 1024,
  /** append 触发一次保留检查的间隔（次）。 */
  pruneEvery: 500,
  /** 每次保留检查最多删多少行，兜住「重新上线后积压几十万行」的情况。 */
  pruneMaxScanLines: 200000,
  /** 去重只看文件最后多少字节（没有 messageId 的消息无法去重）。 */
  dedupeTailBytes: 16 * 1024
});

/** 记录里允许出现在 media[] 里的描述性字段。**绝不**存图片字节 / base64。 */
const MEDIA_FIELDS = ['type', 'file', 'url', 'name', 'bytes', 'mime', 'durationMs', 'desc'];

const DIRS = new Set(['in', 'out']);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/**
 * 会话 key 的规范化：`group:123` / `private:456` / 纯数字（当成群号）。
 * 数字原样传是常见笔误，这里兜住，免得写入 `state/history/123.jsonl` 这种谁也找不到的文件。
 */
export function resolveKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) throw new Error('history-archive: key 不能为空');
  if (/^\d+$/.test(key)) return `group:${key}`;
  return key;
}

/** 文件名用的哈希后缀：保证不同 key 永不撞同一个文件。 */
function keyHash(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** 干净的短 key（纯 ASCII 单词字符）才允许「文件名即 key」，否则一律加哈希后缀。 */
const CLEAN_KEY_RE = /^[A-Za-z0-9_-]{1,48}$/;

/**
 * 会话 key → 文件名。
 * Windows 上 `:` 不合法，所以要替换；但只替换会让 `group:2000000001` 和 `private:2000000001`
 * 撞成同一个文件（跨会话串历史）。所以凡是做过替换的 key 都追加 key 的哈希后缀。
 */
export function keyToFileName(key) {
  const resolved = resolveKey(key);
  const base = resolved.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'key';
  if (base === resolved && CLEAN_KEY_RE.test(resolved)) return `${base}.jsonl`;
  return `${base}-${keyHash(resolved)}.jsonl`;
}

/**
 * 目录 + key → 文件路径，并做路径穿越兜底。
 * 文件名是拼出来的，正常不可能穿越；但 dir 若被误传成 `..\\..\\x`，这里直接拒绝而不是写到库外。
 */
export function filePathFor(dir, key) {
  const base = path.resolve(String(dir ?? '.'));
  const file = path.join(base, keyToFileName(key));
  const root = `${base}${path.sep}`;
  if (!file.startsWith(root)) throw new Error(`history-archive: key 越界（${key}）`);
  return file;
}

/** 句子/片段截断（按码点切，避免把 emoji 的代理对劈开）。 */
function cutChars(text, max) {
  const chars = Array.from(String(text));
  if (chars.length <= max) return { text: chars.join(''), dropped: 0 };
  return { text: chars.slice(0, max).join(''), dropped: chars.length - max };
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasText(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

function typeText(value) {
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * 把外来的 record 收敛成固定形状。
 * 缺的字段保持 undefined（序列化后键会消失）—— 记一条纯文本入站消息时不该塞一堆 null。
 */
function normalizeRecord(record, seq, nowMs, limits) {
  const src = record && typeof record === 'object' ? record : {};
  const { text, dropped } = cutChars(src.text ?? '', limits.maxTextChars);
  const tsMs = Number.isFinite(Number(src.tsMs)) && Number(src.tsMs) >= limits.tsFloorMs
    ? Math.floor(Number(src.tsMs))
    : nowMs;
  const media = [];
  for (const item of toArray(src.media).slice(0, limits.maxMediaItems)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kept = {};
    for (const field of MEDIA_FIELDS) if (hasText(item[field])) kept[field] = item[field];
    if (Object.keys(kept).length) media.push(kept);
  }
  const out = {
    seq,
    tsMs,
    dir: DIRS.has(src.dir) ? src.dir : 'in',
    senderId: hasText(src.senderId) ? String(src.senderId) : undefined,
    senderName: hasText(src.senderName) ? String(src.senderName) : undefined,
    text,
    media,
    messageId: hasText(src.messageId) ? src.messageId : undefined,
    replyToId: hasText(src.replyToId) ? src.replyToId : undefined,
    groupId: hasText(src.groupId) ? String(src.groupId) : undefined
  };
  return { record: out, textTruncated: dropped > 0 };
}

/** JSONL 行解析：坏行返回 null，绝不抛 —— 一行坏了不该整库报废。 */
function parseLine(line) {
  const trimmed = line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line;
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 文件大小；不存在按 0。 */
function statBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 目录大小写不敏感的文件系统上，列目录找本 key 的文件。 */
function statFiles(dir, key) {
  try {
    const wanted = keyToFileName(key);
    return fs.readdirSync(dir).filter((name) => name.toLowerCase() === wanted.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * 原子写：先写临时文件再 rename（照抄 src/tts.js 的 writeFileAtomicSync）。
 * prune 重写整库时必须用它，否则进程/写盘中断会在历史路径留下半截文件。
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

/** 纯逻辑模块不发起后台任务：保留检查排进同一条写队列，close() 后自然停下。 */
function chainSafely(prev, task) {
  return prev.then(() => task()).then(() => undefined, () => undefined);
}

/**
 * 创建归档实例。
 *
 * @param {object} [options]
 * @param {string} [options.dir]   历史目录（默认 state/history；测试传 os.tmpdir() 下的临时目录）
 * @param {() => number} [options.now] 时间源（测试注入，便于构造时间范围）
 * @param {object} [options.limits] 覆盖 HISTORY_LIMITS 的任意键
 */
export function createHistoryArchive({ dir, now = () => Date.now(), limits = {} } = {}) {
  const baseDir = path.resolve(String(dir ?? path.join('state', 'history')));
  const cfg = { ...HISTORY_LIMITS };
  for (const [k, v] of Object.entries(limits ?? {})) {
    if (!(k in cfg)) continue;
    if (k === 'snippetPad') cfg[k] = clampInt(v, 4, 200, cfg[k]);
    else cfg[k] = clampInt(v, 1, Number.MAX_SAFE_INTEGER, cfg[k]);
  }

  let tail = Promise.resolve();
  let closed = false;
  /** 每个 key 距上次保留检查的 append 计数。 */
  const appendSinceCheck = new Map();
  /** 每个 key 已知的最大 seq（避免每次都回读文件尾部）。 */
  const seqCache = new Map();

  /**
   * 把写操作排进单一串行链。
   * 单一队列（而非 per-key 队列）的好处：prune 重写和 append 不可能交错，
   * 跨会话也不会互踩同一个 rename 临时文件名。
   */
  function enqueue(task) {
    const run = tail.then(() => {
      if (closed) throw new Error('history-archive: 已 close，不再接受写入');
      return task();
    });
    tail = chainSafely(tail, () => run);
    return run;
  }

  // close 之后必须**降级**而不是抛：调用方（bridge）是按返回值判 ok 的，
  // 抛出去就成了未捕获异常，会把刚处在关闭流程里的桥接进程掀掉。
  function closedResult(extra) {
    return { ok: false, error: 'history-archive: 已 close，不再接受写入', ...extra };
  }

  function resolveDir(callDir) {
    return callDir === undefined || callDir === null ? baseDir : path.resolve(String(callDir));
  }

  /**
   * 从文件尾部往前按块读，按「新 → 旧」逐行交给 onLine(line, frag)。
   * 两个坑都在这一个函数里处理掉：
   *  ① 块边界：不能整块 split 了就 yield——位于块开头的那一段属于更早的块，必须留给下一轮拼；
   *  ② 文件末尾没有换行：最后给 onLine 的 frag 只被 flush 一次，且仅在真的读到文件开头时
   *     （reachedStart=true）才 flush，否则会把还没读到的那一段误报成一条「坏行」。
   */
  function backwardScan(file, { maxScanBytes, shouldStop, onLine }) {
    const out = { bytesRead: 0, endOffset: 0, reachedStart: false, stopped: false };
    const size = statBytes(file);
    if (!size) { out.reachedStart = true; return out; }
    let fd = null;
    let frag = '';
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(Math.min(cfg.chunkSize, Math.max(4096, size)));
      while (out.bytesRead < size && out.bytesRead < maxScanBytes) {
        if (shouldStop?.()) { out.stopped = true; break; }
        const chunkLen = Math.min(Math.min(cfg.chunkSize, size - out.bytesRead), maxScanBytes - out.bytesRead);
        const read = fs.readSync(fd, buf, 0, chunkLen, size - out.bytesRead - chunkLen);
        if (read <= 0) break;
        const chunkStart = size - out.bytesRead - read;
        out.bytesRead += read;
        out.endOffset = chunkStart;
        // 左端（parts[0]）留给下一轮；parts 是「本块完整行 + 上一轮留下来待拼接的段」。
        const parts = (buf.toString('utf8', 0, read) + frag).split('\n');
        frag = parts.shift() ?? '';
        for (let i = parts.length - 1; i >= 0; i -= 1) {
          const line = parts[i];
          if (!line) continue;
          if (onLine(line) === true) { out.stopped = true; break; }
        }
        if (out.stopped) break;
        if (chunkStart <= 0) {
          // 读到文件开头了：此刻 frag 就是「文件第一行且没有换行」的残留，它是一条真记录，必须收尾。
          out.reachedStart = true;
          if (frag) onLine(frag);
          break;
        }
      }
    } catch (error) {
      out.error = error;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
    return out;
  }

  /**
   * 读文件尾部、按行倒着解析，直到找到 seq 最大的那条或撞上预算。
   * 用途：① append 时确定下一个 seq；② messageId 去重。
   */
  function readTailRecords(file, limitsForScan) {
    const records = [];
    const outcome = backwardScan(file, {
      maxScanBytes: limitsForScan.maxBytes,
      shouldStop: () => records.length >= limitsForScan.maxRecords,
      onLine: (line) => {
        const rec = parseLine(line);
        if (rec) records.push(rec);
        return records.length >= limitsForScan.maxRecords;
      }
    });
    return { records, complete: outcome.reachedStart, bytesRead: outcome.bytesRead, error: outcome.error };
  }

  /** 建立/修正某 key 的 seq 基线（只回看文件尾部一小段）。 */
  function ensureNextSeq(key, file) {
    const cached = seqCache.get(key);
    if (cached !== undefined) return cached;
    const { records, complete } = readTailRecords(file, { maxRecords: 64, maxBytes: 256 * 1024 });
    let maxSeq = 0;
    for (const rec of records) {
      const s = Number(rec?.seq);
      if (Number.isFinite(s) && s > maxSeq) maxSeq = Math.floor(s);
    }
    if (!complete && records.length) maxSeq += 1000; // 尾部窗口不够，往后跳一段更安全
    const next = maxSeq + 1;
    seqCache.set(key, next);
    return next;
  }

  /** 倒着扫描文件尾部，返回 { lines, valid, bad, complete, bytesRead, endOffset }。 */
  function scanTail(file, { maxScanBytes, maxScanLines, yieldLine, shouldStop }) {
    const out = { lines: 0, valid: 0, bad: 0, complete: false, bytesRead: 0, endOffset: 0 };
    const outcome = backwardScan(file, {
      maxScanBytes,
      shouldStop: () => shouldStop?.() === true || out.lines >= maxScanLines,
      onLine: (line) => {
        out.lines += 1;
        const rec = parseLine(line);
        if (rec) out.valid += 1; else out.bad += 1;
        // yieldLine 返回 true 表示「够了，别再往前读了」
        return yieldLine(rec, line, out) === true || out.lines >= maxScanLines;
      }
    });
    out.complete = outcome.reachedStart;
    out.bytesRead = outcome.bytesRead;
    out.endOffset = outcome.endOffset;
    if (outcome.error) out.error = outcome.error;
    return out;
  }

  /** 正向逐行读（时间范围检索走这条，因为倒着读没法在「更早的一定更旧」时提前收手会漏）。 */
  async function scanForward(file, { yieldLine }) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return { lines: 0, valid: 0, bad: 0 };
    }
    const stats = { lines: 0, valid: 0, bad: 0 };
    try {
      const buf = Buffer.allocUnsafe(Math.min(cfg.chunkSize, 1024 * 1024));
      let pending = '';
      let offset = 0;
      for (;;) {
        const read = fs.readSync(fd, buf, 0, buf.length, offset);
        if (read <= 0) break;
        offset += read;
        pending += buf.toString('utf8', 0, read);
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const line of parts) {
          if (!line) continue;
          stats.lines += 1;
          const rec = parseLine(line);
          if (rec) stats.valid += 1; else stats.bad += 1;
          // yieldLine 返回 true 表示「后面不用看了」（例如已经越过 untilMs）
          if (yieldLine(rec, line, stats) === true) { pending = ''; return stats; }
        }
      }
      if (pending) {
        stats.lines += 1;
        const rec = parseLine(pending);
        if (rec) stats.valid += 1; else stats.bad += 1;
        yieldLine(rec, pending, stats);
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    return stats;
  }

  // ── 检索核心 ────────────────────────────────────────────────────────────────

  /** 把整个文本小写并建一次码点索引，供 CJK 子串匹配用（中文原样、ASCII 折叠大小写）。 */
  function prepareHaystack(text) {
    const chars = Array.from(String(text ?? ''));
    let lower = '';
    for (const c of chars) lower += c.toLowerCase();
    return { lower, chars };
  }

  function fieldHaystack(value) {
    if (value === undefined || value === null || Array.isArray(value)) return '';
    if (typeof value === 'object') return '';
    return String(value);
  }

  /** 记录里所有可检索的文本拼接（text + 发送者名 + 媒体描述 + id）。 */
  function recordHaystack(rec) {
    const parts = [rec?.text ?? '', rec?.senderName ?? '', rec?.senderId ?? ''];
    for (const item of toArray(rec?.media)) {
      if (!item || typeof item !== 'object') continue;
      for (const field of MEDIA_FIELDS) {
        const v = fieldHaystack(item[field]);
        if (v && field !== 'bytes' && field !== 'durationMs') parts.push(v);
      }
    }
    return parts.join('\n');
  }

  function recordSnippet(rec, needleKeys, pad) {
    const { chars } = prepareHaystack(recordHaystack(rec));
    let pos = -1;
    let matched = '';
    for (const nk of needleKeys) {
      const charsN = Array.from(nk);
      const span = Math.min(chars.length, charsN.length);
      for (let i = 0; i + span <= chars.length; i += 1) {
        let same = true;
        for (let j = 0; j < span; j += 1) {
          if (chars[i + j].toLowerCase() !== charsN[j]) { same = false; break; }
        }
        if (same) {
          if (pos < 0 || i < pos) { pos = i; matched = nk; }
          break;
        }
      }
      if (pos === 0) break; // 已经是最靠前的位置，不用再找
    }
    const len = Array.from(matched).length;
    if (pos < 0) return cutChars(recordHaystack(rec).replace(/\s+/g, ' ').trim(), pad * 2).text;
    // 命中词用【】包起来；两侧按「切出来之后再掐掉首尾空白」重新算省略号，
    // 否则空白一 trim，false 的省略号就会挂在一个其实贴边的片段上。
    const from = Math.max(0, pos - pad);
    const to = Math.min(chars.length, pos + len + pad);
    const head = chars.slice(from, pos).join('').replace(/\s+/g, ' ').trimStart();
    const hit = chars.slice(pos, pos + len).join('');
    const back = chars.slice(pos + len, to).join('').replace(/\s+/g, ' ').trimEnd();
    return `${from > 0 && head ? '…' : ''}${head}【${hit}】${back}${to < chars.length && back ? '…' : ''}`;
  }

  return {
    dir: baseDir,
    limits: cfg,
    keyToFileName,
    filePathFor: (key, callDir) => filePathFor(resolveDir(callDir), key),

    /**
     * 追加一条记录。
     * @returns {Promise<{ok:boolean, seq?:number, bytes?:number, deduped?:boolean, textTruncated?:boolean, error?:string}>}
     */
    async append({ key, record } = {}) {
      let resolved;
      let file;
      try {
        resolved = resolveKey(key);
        file = filePathFor(baseDir, resolved);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      // 关闭之后一律走返回值降级，绝不 throw（bridge 是按 ok 判定的）。
      if (closed) return closedResult();
      return enqueue(async () => {
        try {
          const nowMs = Number(now());
          const fm = Number(record?.messageId);
          const hasMid = Number.isFinite(fm) && fm !== 0;
          // dedupe 只扫尾部窗口（append 已串行，窗口内足够挡住重试导致的重复写入）
          if (hasMid) {
            const { records } = readTailRecords(file, {
              maxRecords: 64, maxBytes: Math.max(4096, cfg.dedupeTailBytes)
            });
            for (const rec of records) {
              if (Number(rec?.messageId) === fm && rec?.dir === (DIRS.has(record?.dir) ? record.dir : 'in')) {
                return { ok: true, seq: rec.seq, deduped: true };
              }
            }
          }
          const seq = ensureNextSeq(resolved, file);
          const { record: out, textTruncated } = normalizeRecord(record, seq, nowMs, cfg);
          fs.mkdirSync(baseDir, { recursive: true });
          let fd = null;
          let bytes = 0;
          try {
            fd = fs.openSync(file, 'a+');
            // 自愈：老文件可能没有尾随换行（外部工具改写 / 上次写到一半被 kill）。
            // 直接 'a' 追加会把新记录粘在旧记录尾巴上，两条一起变成坏行。
            let needsNewline = false;
            try {
              const size = fs.fstatSync(fd).size;
              if (size > 0) {
                const one = Buffer.allocUnsafe(1);
                const got = fs.readSync(fd, one, 0, 1, size - 1);
                needsNewline = got === 1 && one[0] !== 0x0a;
              }
            } catch { /* 读不到尾部就按「不需要」处理，保持原有行为 */ }
            const payload = `${needsNewline ? '\n' : ''}${JSON.stringify(out)}\n`;
            bytes = fs.writeSync(fd, payload);
          } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch {} }
          }
          seqCache.set(resolved, seq + 1);
          maybeEnforceRetention(resolved, file);
          return { ok: true, seq, bytes, textTruncated };
        } catch (error) {
          return {
            ok: false,
            error: `history-archive: 追加失败（${file}）：${String(error?.message ?? error)}`
          };
        }
      });
    },

    /**
     * 倒序检索某会话的历史（最近的先返回）。
     * @returns {Promise<{ok:boolean, hits:Array, scanned:number, truncated:boolean, badLines?:number, error?:string}>}
     */
    async search({ key, query, sinceMs, untilMs, limit = 20, dir: callDir, timeLimitMs } = {}) {
      let resolved;
      let file;
      try {
        resolved = resolveKey(key);
        file = filePathFor(resolveDir(callDir), resolved);
      } catch (error) {
        return { ok: false, hits: [], scanned: 0, truncated: false, error: String(error?.message ?? error) };
      }
      const rawQuery = String(query ?? '').trim();
      if (!rawQuery) {
        return { ok: false, hits: [], scanned: 0, truncated: false, error: 'history-archive: query 不能为空' };
      }
      const queryTruncated = Array.from(rawQuery).length > cfg.maxQueryChars;
      const clipped = cutChars(rawQuery, cfg.maxQueryChars).text;
      const keywords = clipped.split(/\s+/).filter(Boolean);
      if (!keywords.length) {
        return { ok: false, hits: [], scanned: 0, truncated: false, error: 'history-archive: query 里没有有效关键词' };
      }
      const needleKeys = keywords.map((w) => Array.from(w.toLowerCase()));
      const want = clampInt(limit, 1, cfg.maxHits, 20);
      const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : null;
      const until = Number.isFinite(Number(untilMs)) ? Number(untilMs) : null;
      const budgetMs = clampInt(timeLimitMs, 1, 600000, cfg.timeLimitMs);
      const deadline = Date.now() + budgetMs;

      let scanned = 0;
      let badLines = 0;
      let truncated = queryTruncated;
      const hits = [];
      const seen = new Set();
      const textCache = new Map();

      function evalRecord(rec) {
        if (!rec) return null;
        const tsMs = Number(rec.tsMs);
        if (!Number.isFinite(tsMs)) return null;
        if (since !== null && tsMs < since) return null;
        if (until !== null && tsMs > until) return null;
        const hay = textCache.get(rec);
        const source = hay === undefined ? recordHaystack(rec) : hay;
        if (hay === undefined) textCache.set(rec, source);
        const { lower } = prepareHaystack(source);
        const found = [];
        for (const cps of needleKeys) {
          const needle = cps.join('');
          if (!lower.includes(needle)) return null;
          found.push(needle);
        }
        return { rec, found };
      }

      function pushHit(found) {
        const { rec } = found;
        const key0 = rec.seq !== undefined ? `s${rec.seq}` : `m${rec.messageId}:${rec.tsMs}`;
        if (seen.has(key0)) return true;
        seen.add(key0);
        hits.push({
          seq: rec.seq,
          tsMs: Number(rec.tsMs),
          dir: rec.dir,
          senderId: rec.senderId,
          senderName: rec.senderName,
          snippet: recordSnippet(rec, found.found, cfg.snippetPad),
          messageId: rec.messageId
        });
        return hits.length >= want;
      }

      try {
        if (since !== null) {
          // 正向读：只有「从 sinceMs 开始」的位置才需要越过文件前面的一大段。
          const stats = await scanForward(file, {
            yieldLine: (rec) => {
              if (!rec) return false;
              const tsMs = Number(rec.tsMs);
              if (Number.isFinite(tsMs) && until !== null && tsMs > until) return true;
              if (Date.now() > deadline) { truncated = true; return true; }
              const found = evalRecord(rec);
              if (found && pushHit(found)) { truncated = true; return true; }
              return false;
            }
          });
          scanned = stats.lines;
          badLines = stats.bad;
          hits.reverse(); // 正向收集，返回时按时间倒序
        } else {
          const stats = scanTail(file, {
            maxScanBytes: cfg.maxScanBytes,
            maxScanLines: cfg.maxScanLines,
            shouldStop: () => Date.now() > deadline,
            yieldLine: (rec) => {
              if (!rec) return false;
              const found = evalRecord(rec);
              if (found && pushHit(found)) { truncated = true; return true; }
              return false;
            }
          });
          scanned = stats.lines;
          badLines = stats.bad;
          if (!stats.complete && !truncated) truncated = true;
          if (stats.bytesRead >= cfg.maxScanBytes && !stats.complete) truncated = true;
          if (Date.now() > deadline) truncated = true;
        }
      } catch (error) {
        return { ok: false, hits: [], scanned, truncated, error: String(error?.message ?? error) };
      }

      return { ok: true, hits, scanned, truncated, badLines };
    },

    /** 会话归档概况。lines 是文件总行数（含坏行）。 */
    async stats({ key } = {}) {
      let resolved;
      let file;
      try {
        resolved = resolveKey(key);
        file = filePathFor(baseDir, resolved);
      } catch (error) {
        return { key: String(key ?? ''), lines: 0, bytes: 0, oldestTsMs: null, newestTsMs: null, files: [], error: String(error?.message ?? error) };
      }
      const bytes = statBytes(file);
      const out = {
        key: resolved,
        lines: 0,
        bytes,
        oldestTsMs: null,
        newestTsMs: null,
        files: statFiles(baseDir, resolved),
        badLines: 0,
        truncated: false
      };
      if (!bytes) return out;
      const scan = scanTail(file, {
        maxScanBytes: cfg.maxScanBytes,
        maxScanLines: cfg.maxScanLines,
        yieldLine: (rec, _line, acc) => {
          out.lines = acc.lines;
          out.badLines = acc.bad;
          if (!rec) return false; // 坏行只计数，不影响时间范围
          const tsMs = Number(rec.tsMs);
          if (Number.isFinite(tsMs)) {
            if (out.newestTsMs === null) out.newestTsMs = tsMs;
            out.oldestTsMs = tsMs;
          }
          return false;
        }
      });
      out.lines = scan.lines;
      out.badLines = scan.bad;
      out.truncated = !scan.complete;
      return out;
    },

    /**
     * 保留策略：先按 beforeMs（缺省用 limits.retentionDays 往前推）删旧行，
     * 再按 maxBytes（缺省用 limits.maxBytes）从最旧开始削到符合上限。
     * @returns {Promise<{ok:boolean, removedLines:number, badLines:number, bytesAfter:number, error?:string}>}
     */
    async prune({ key, beforeMs, maxBytes } = {}) {
      let resolved;
      let file;
      try {
        resolved = resolveKey(key);
        file = filePathFor(baseDir, resolved);
      } catch (error) {
        return { ok: false, removedLines: 0, badLines: 0, bytesAfter: 0, error: String(error?.message ?? error) };
      }
      if (closed) return closedResult({ removedLines: 0, badLines: 0, bytesAfter: 0 });
      return enqueue(async () => {
        try {
          const size = statBytes(file);
          if (!size) {
            return { ok: true, removedLines: 0, badLines: 0, bytesAfter: 0 };
          }
          const nowMs = Number(now());
          const cutoff = Number.isFinite(Number(beforeMs))
            ? Number(beforeMs)
            : nowMs - cfg.retentionDays * 24 * 60 * 60 * 1000;
          const byteLimit = Number.isFinite(Number(maxBytes))
            ? Number(maxBytes)
            : cfg.maxBytes;

          const text = fs.readFileSync(file, 'utf8');
          const lines = text.split('\n');
          if (lines.length && lines[lines.length - 1] === '') lines.pop();
          const kept = [];
          let removedLines = 0;
          let badLines = 0;
          for (const line of lines) {
            if (line === '') continue;
            const rec = parseLine(line);
            if (!rec) {
              // 坏行不参与「保留」判断，重写时直接丢；宁可留干净的库也不要一直扛着它
              removedLines += 1;
              badLines += 1;
              continue;
            }
            const tsMs = Number(rec.tsMs);
            if (Number.isFinite(tsMs) && tsMs < cutoff) { removedLines += 1; continue; }
            kept.push({ rec, line });
          }

          let bytesAfter = kept.reduce((sum, item) => sum + Buffer.byteLength(item.line), 0) + kept.length;
          if (bytesAfter > byteLimit) {
            let dropCount = 0;
            while (dropCount < kept.length && bytesAfter > byteLimit) {
              bytesAfter -= Buffer.byteLength(kept[dropCount].line) + 1;
              dropCount += 1;
            }
            removedLines += dropCount;
            kept.splice(0, dropCount);
          }

          const body = kept.length ? `${kept.map((item) => item.line).join('\n')}\n` : '';
          writeFileAtomicSync(file, Buffer.from(body, 'utf8'));
          let maxSeq = 0;
          for (const item of kept) {
            const s = Number(item.rec?.seq);
            if (Number.isFinite(s) && s > maxSeq) maxSeq = Math.floor(s);
          }
          if (kept.length) seqCache.set(resolved, maxSeq + 1);
          else seqCache.delete(resolved);
          return {
            ok: true,
            removedLines,
            badLines,
            bytesAfter: Buffer.byteLength(body, 'utf8')
          };
        } catch (error) {
          return {
            ok: false,
            removedLines: 0,
            badLines: 0,
            bytesAfter: statBytes(file),
            error: `history-archive: prune 失败（${file}）：${String(error?.message ?? error)}`
          };
        }
      });
    },

    /** 停止接受写入；已在队列里的操作会跑完。 */
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    }
  };

  /** 每 cfg.pruneEvery 次 append（或行数/体积超限）触发一次保留检查。不 await：写路径不能被重写阻塞。 */
  function maybeEnforceRetention(key, file) {
    const n = (appendSinceCheck.get(key) ?? 0) + 1;
    const size = statBytes(file);
    if (n < cfg.pruneEvery && size <= cfg.maxBytes) {
      appendSinceCheck.set(key, n);
      return;
    }
    appendSinceCheck.set(key, 0);
    const run = () => enqueue(async () => {
      try {
        // 只看行数就够判断「要不要真 prune」，避免为每次检查都全文重写
        const lines = countLines(file);
        if (lines > cfg.pruneMaxScanLines || size > cfg.maxBytes) {
          pruneOnQueue(key, file);
        }
      } catch {
        // 保留策略失败不该让 append 结果变形
      }
    });
    // 后台任务必须自己吃掉错误：close() 之后再排队的保留检查会被队列拒掉，
    // 那个 rejection 若不接住会变成 unhandled rejection 直接掀掉桥接进程。
    run().catch(() => {});
  }

  /** 数行数（以换行符计，坏行也计）。 */
  function countLines(file) {
    let fd = null;
    let count = 0;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(Math.min(cfg.chunkSize, 1024 * 1024));
      let offset = 0;
      for (;;) {
        const read = fs.readSync(fd, buf, 0, buf.length, offset);
        if (read <= 0) break;
        offset += read;
        for (let i = 0; i < read; i += 1) if (buf[i] === 10) count += 1;
      }
    } catch {
      return count;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
    return count;
  }

  /**
   * 队列内的保留检查（不重新 enqueue）。
   * 行数超 cfg.pruneMaxScanLines 时只削到该上限的 90%，避免把用户刚聊完的历史全砍光。
   */
  function pruneOnQueue(key, file) {
    const nowMs = Number(now());
    const cutoff = nowMs - cfg.retentionDays * 24 * 60 * 60 * 1000;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const keepLimit = Math.floor(cfg.pruneMaxScanLines * 0.9);
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      if (line === '') continue;
      const rec = parseLine(line);
      const tsMs = Number(rec?.tsMs);
      if (!rec || (Number.isFinite(tsMs) && tsMs < cutoff)) { removed += 1; continue; }
      kept.push({ rec, line });
    }
    let bytesAfter = kept.reduce((sum, item) => sum + Buffer.byteLength(item.line), 0) + kept.length;
    const dropByLines = Math.max(0, kept.length - keepLimit);
    let dropCount = dropByLines;
    let cursor = dropByLines;
    while (cursor < kept.length && bytesAfter > cfg.maxBytes) {
      bytesAfter -= Buffer.byteLength(kept[cursor].line) + 1;
      dropCount += 1;
      cursor += 1;
    }
    if (!removed && !dropCount) return;
    removed += dropCount;
    const survivors = kept.slice(dropCount);
    const body = survivors.length ? `${survivors.map((item) => item.line).join('\n')}\n` : '';
    writeFileAtomicSync(file, Buffer.from(body, 'utf8'));
    let maxSeq = 0;
    for (const item of survivors) {
      const s = Number(item.rec?.seq);
      if (Number.isFinite(s) && s > maxSeq) maxSeq = Math.floor(s);
    }
    if (survivors.length) seqCache.set(key, maxSeq + 1);
    else seqCache.delete(key);
  }
}

export default createHistoryArchive;
