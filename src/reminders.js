// 自主提醒：独立的「存储 + 到期判断」模块。
//
// 这个文件**只做两件事**：把提醒记进 state/reminders.json、告诉你什么时候该响。
// 它不引 bridge.js、不发 QQ 消息、不碰 HTTP —— 怎么把「该响了」变成一条消息由调用方决定
// （接线说明见文件末尾注释）。
//
// 时间约定：全程按**本机本地时间**理解（桥接和用户都在东八区 → 即北京时间）。
// 这里不做时区换算、不处理夏令时与闰秒：中国没有夏令时，本地时间恒为 UTC+8，
// 所以 daily/weekly 直接用 +24h / +7d 毫秒顺延不会漂；真要跨时区部署再另说。
//
// 落盘形状（一份文件装全部会话的提醒）：
//   {
//     "version": 1,
//     "items": [ { id, key, text, dueAt, createdAt, createdBy, repeat, firedAt, lastFiredAt } ]
//   }
//   - id        : 短随机 id，例如 "r0a3f9x"（见 newId 的取舍说明）
//   - key       : 会话 key，group:<群号> 或 private:<QQ号>
//   - dueAt     : 下一次该响的毫秒时间戳（本地时间的绝对毫秒，和 Date.now() 同一坐标系）
//   - repeat    : 'none' | 'daily' | 'weekly'
//   - firedAt   : 仅「已完成」的一次性提醒有值（完成时间）；重复提醒永不置位
//   - lastFiredAt: 最近一次触发时间（重复提醒会不断更新）
//   「已完成」不额外存一个 done 字段，而是由 `repeat === 'none' && firedAt != null` 推导：
//   少一个字段就少一种「字段之间自相矛盾」的可能，读写两边的口径也天然一致。
//
// 写盘策略：原子写（tmp + rename，照抄 tts.js 的 writeFileAtomicSync 模式）+ 只在真改动时写。
// 读操作（list/due/stats）绝不落盘，否则 bridge 每秒 tick 一次 due() 会变成每秒一堆磁盘写。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText } from './error-text.js';

/** 默认状态文件：跟着模块走（src/../state/reminders.json），与进程 cwd 无关。 */
export const DEFAULT_REMINDERS_FILE = fileURLToPath(new URL('../state/reminders.json', import.meta.url));

/** 默认上限（每一项都能被 createRemindersStore({ limits }) 覆盖）。 */
export const REMINDER_LIMITS = Object.freeze({
  minTextChars: 1,
  maxTextChars: 200,
  minLeadMs: 1000,                          // 至少排在 1 秒之后
  maxLeadMs: 90 * 24 * 60 * 60 * 1000,      // 最多排到 90 天以内
  maxPerKey: 50,                            // 每个会话最多 50 条待触发
  maxTotal: 2000,                           // 全局最多 2000 条
  maxCreatedByChars: 64,                    // createdBy 只留 64 字，免得塞进一整段上下文
  doneKeepMs: 0                             // prune 时已完成项保留多久；0 = 立即清理
});

export const REMINDER_REPEATS = Object.freeze(['none', 'daily', 'weekly']);

/** 会话 key 白名单形状：group:123 / private:456 */
export const SESSION_KEY_RE = /^(group|private):\d+$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** key 形状是否合法（给 bridge 侧做前置校验用，不抛异常）。 */
export function isValidSessionKey(key) {
  return typeof key === 'string' && SESSION_KEY_RE.test(key.trim());
}

/** 本地时间字符串：`2026-05-01 08:30 周五`（桥接发消息时直接念给人听）。 */
export function formatLocalTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 周${'日一二三四五六'[d.getDay()]}`;
}

/** 相对时间的人话：`3 小时后` / `12 分钟后` / `已到点`。 */
export function formatInMs(inMs) {
  if (!Number.isFinite(inMs)) return '未知';
  if (inMs <= 0) return '已到点';
  const sec = Math.round(inMs / 1000);
  if (sec < 60) return `${sec} 秒后`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟后`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return min % 60 ? `${hour} 小时 ${min % 60} 分钟后` : `${hour} 小时后`;
  const day = Math.floor(hour / 24);
  return hour % 24 ? `${day} 天 ${hour % 24} 小时后` : `${day} 天后`;
}

/**
 * 原子写：先写 .part-* 临时文件再 rename，避免进程/写盘中断在状态文件里留下半截 JSON。
 * （与 src/tts.js 的 writeFileAtomicSync 同一套路，独立实现避免为了一个函数去 import 整个 TTS 模块。）
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

function byDue(a, b) {
  return (a.dueAt - b.dueAt) || String(a.id).localeCompare(String(b.id));
}

/**
 * 创建提醒库。
 * @param {{ file?: string, now?: () => number, limits?: object }} [options]
 *   file  状态文件路径（测试传临时目录；默认 state/reminders.json）
 *   now   取当前时间的函数（测试注入假时钟；默认 Date.now）
 *   limits 覆盖 REMINDER_LIMITS 里的任意字段
 */
export function createRemindersStore(options = {}) {
  const file = options.file ? path.resolve(String(options.file)) : DEFAULT_REMINDERS_FILE;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limits = { ...REMINDER_LIMITS, ...(options.limits ?? {}) };

  const state = { version: 1, items: [] };
  const warnings = [];         // 读盘/写盘异常都记在这里（不抛给调用方，避免一次坏文件把 tick 打炸）
  let loaded = false;
  let corruptBackup = null;

  const isDone = (item) => item.repeat === 'none' && Number.isFinite(item.firedAt);
  const pendingItems = () => state.items.filter((it) => !isDone(it));

  function decorate(item, nowMs) {
    const inMs = item.dueAt - nowMs;
    return {
      ...item,
      done: isDone(item),
      inMs,
      lateMs: inMs < 0 ? -inMs : 0,
      dueText: formatLocalTime(item.dueAt),
      inText: formatInMs(inMs)
    };
  }

  /** 读盘时逐条清洗：字段缺胳膊少腿的记录直接丢弃（宁可少一条，也不要一条 undefined 的定时器）。 */
  function sanitizeLoaded(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!id || !text.trim() || !SESSION_KEY_RE.test(key)) return null;
    if (typeof raw.dueAt !== 'number' || !Number.isFinite(raw.dueAt)) return null;
    const repeat = REMINDER_REPEATS.includes(raw.repeat) ? raw.repeat : 'none';
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      id,
      key,
      text,
      dueAt: Math.round(raw.dueAt),
      createdAt: num(raw.createdAt) ?? 0,
      createdBy: typeof raw.createdBy === 'string' ? raw.createdBy.slice(0, limits.maxCreatedByChars) : '',
      repeat,
      firedAt: num(raw.firedAt),
      lastFiredAt: num(raw.lastFiredAt)
    };
  }

  /** 文件坏掉时的降级：先备份成 reminders.json.corrupt-<ts>，再重建空库，并留下警告标志。 */
  function degrade(reason) {
    const backup = `${file}.corrupt-${Date.now()}`;
    let backed = false;
    try {
      fs.renameSync(file, backup);           // 首选改名：坏文件原样留档，也不会再被读到
      backed = true;
    } catch {
      try { fs.copyFileSync(file, backup); backed = true; } catch {}
    }
    if (backed) corruptBackup = backup;
    warnings.push(`提醒状态文件损坏（${reason}），已${backed ? `备份为 ${path.basename(backup)} 并` : '（备份失败）'}重建空库`);
    state.items = [];
  }

  function load() {
    if (loaded) return;                       // 只读一次；之后以内存为准（写盘时整份覆盖）
    loaded = true;
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;   // 文件不存在 = 空库，且不主动创建文件
      warnings.push(`读取 ${file} 失败，按空库启动：${errorText(error)}`);
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      degrade(`JSON 解析失败：${errorText(error)}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      degrade('顶层结构不是 { version, items: [] }');
      return;
    }
    if (typeof parsed.version === 'number' && parsed.version > state.version) {
      warnings.push(`提醒状态文件 version=${parsed.version} 高于本模块支持的 ${state.version}，只保留能认出来的字段`);
    }
    const kept = [];
    let dropped = 0;
    for (const item of parsed.items) {
      const clean = sanitizeLoaded(item);
      if (clean) kept.push(clean);
      else dropped += 1;
    }
    state.items = kept;
    if (dropped) warnings.push(`读取时丢弃了 ${dropped} 条字段不完整的提醒记录`);
  }

  function flush() {
    // 落盘时按 dueAt 排序：文件本身可读、diff 稳定；内存顺序不动（list/due 各自排序）。
    const payload = { version: state.version, items: [...state.items].sort(byDue) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
  }

  /**
   * 提交一次不可变更新：先换内存，写盘失败再回滚。
   * 返回 null 表示成功，返回字符串表示失败原因（已进 warnings）。
   * 为什么要回滚：内存说有、磁盘上没有，重启后提醒就凭空消失，是最难查的那种 bug。
   */
  function commit(nextItems) {
    const prev = state.items;
    state.items = nextItems;
    try {
      flush();
      return null;
    } catch (error) {
      state.items = prev;
      const msg = `写入 ${file} 失败：${errorText(error)}`;
      warnings.push(msg);
      return msg;
    }
  }

  /** 短随机 id：`r` + 6 位 base36（固定 7 字符）。选它而不是 randomUUID：取消要能在 QQ 里手打
   *  （`取消 r0a3f9x`），36^6 ≈ 22 亿的空间对「2000 条上限」绰绰有余，撞了就重试，
   *  重试 50 次还撞再退回完整 UUID。 */
  function newId() {
    const used = new Set(state.items.map((it) => it.id));
    const space = 36 ** 6;
    for (let i = 0; i < 50; i += 1) {
      const id = `r${crypto.randomInt(0, space).toString(36).padStart(6, '0')}`;
      if (!used.has(id)) return id;
    }
    return crypto.randomUUID();
  }

  /** dueAt 校验（数字 + 时间窗）。返回中文错误串或 null。 */
  function checkDueAt(dueAt, nowMs) {
    if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) {
      return 'dueAt 必须是毫秒时间戳数字（Date.now() 那种），不接受字符串';
    }
    if (dueAt < nowMs + limits.minLeadMs) {
      return `提醒时间太近：至少要排在 ${formatInMs(limits.minLeadMs)}（现在是 ${formatLocalTime(nowMs)}）`;
    }
    if (dueAt > nowMs + limits.maxLeadMs) {
      return `提醒时间太远：最多只能排到 ${Math.round(limits.maxLeadMs / DAY_MS)} 天以内`;
    }
    return null;
  }

  // 立刻读一次盘：坏文件/写盘问题的警告要能在创建 store 时就拿到（调用方还能顺势 log 一条），
  // 而不是等第一次 list() 才冒出来。读操作不写盘，所以这一步不会创建任何文件。
  load();

  return {
    file,
    limits,
    warnings,                                 // 读盘/写盘异常的可读中文记录（数组，实时追加）
    get corruptBackup() { return corruptBackup; },

    isDone,
    /** 强制重新读盘（换进程改过文件、或测试想重放时用）。 */
    reload() { loaded = false; state.items = []; corruptBackup = null; load(); return this; },
    /** 落盘用的原始快照（深拷贝），调试/备份用。 */
    raw() { load(); return { version: state.version, items: state.items.map((it) => ({ ...it })) }; },

    /**
     * 新增一条提醒。
     * @returns {{ ok: true, item: object } | { ok: false, error: string }}
     */
    add({ key, text, dueAt, createdBy, repeat } = {}) {
      load();
      const k = typeof key === 'string' ? key.trim() : '';
      if (!SESSION_KEY_RE.test(k)) return { ok: false, error: '会话 key 不合法：应为 group:<群号> 或 private:<QQ号>' };

      // 按「码点」数长度：'😀'.length === 2 会让人白丢额度，用 Array.from 数真实字符。
      const trimmed = typeof text === 'string' ? text.trim() : String(text ?? '').trim();
      const length = Array.from(trimmed).length;
      if (length < limits.minTextChars || length > limits.maxTextChars) {
        return { ok: false, error: `提醒内容去掉首尾空白后必须是 ${limits.minTextChars}~${limits.maxTextChars} 字（当前 ${length} 字）` };
      }
      // 换行会把一条 QQ 消息拆成好几段，落库前折成单个空格，免得存进去才在发送端出问题。
      const body = trimmed.replace(/\s*\n+\s*/g, ' ');

      const rep = repeat === undefined || repeat === null || repeat === '' ? 'none' : String(repeat);
      if (!REMINDER_REPEATS.includes(rep)) {
        return { ok: false, error: `repeat 只能是 ${REMINDER_REPEATS.join(' / ')}（当前 ${rep || '(空)'}）` };
      }

      const nowMs = now();
      const dueErr = checkDueAt(dueAt, nowMs);
      if (dueErr) return { ok: false, error: dueErr };

      const sameKeyPending = state.items.filter((it) => it.key === k && !isDone(it)).length;
      if (sameKeyPending >= limits.maxPerKey) {
        return { ok: false, error: `${k} 的待触发提醒已达上限 ${limits.maxPerKey} 条，先取消几条再新增` };
      }
      if (state.items.length >= limits.maxTotal) {
        return { ok: false, error: `提醒总数已达上限 ${limits.maxTotal} 条（含已完成未清理的），先清理一些再新增` };
      }

      const item = {
        id: newId(),
        key: k,
        text: body,
        dueAt: Math.round(dueAt),
        createdAt: nowMs,
        createdBy: String(createdBy ?? '').trim().slice(0, limits.maxCreatedByChars),
        repeat: rep,
        firedAt: null,
        lastFiredAt: null
      };
      const err = commit([...state.items, item]);
      if (err) return { ok: false, error: err };
      return { ok: true, item: decorate(item, nowMs) };
    },

    /**
     * 列出提醒（默认不含已完成的一次性提醒），按 dueAt 升序。
     * 每项附加 inMs / dueText（本地时间）/ inText / done，方便直接念给用户听。
     */
    list({ key, includeDone = false } = {}) {
      load();
      const nowMs = now();
      const k = key ? String(key).trim() : '';
      return state.items
        .filter((it) => (includeDone ? true : !isDone(it)))
        .filter((it) => !k || it.key === k)
        .sort(byDue)
        .map((it) => decorate(it, nowMs));
    },

    /**
     * 取消一条（按 id；给了 key 就必须对得上，避免串会话误删）。
     * @returns {number} 实际取消条数（0 = 没这条 / 已完成 / key 不匹配 / 写盘失败见 warnings）
     */
    cancel({ key, id } = {}) {
      load();
      const wantId = id === undefined || id === null ? '' : String(id).trim();
      if (!wantId) return 0;
      const k = key ? String(key).trim() : '';
      const next = state.items.filter((it) => !(it.id === wantId && (!k || it.key === k) && !isDone(it)));
      const removed = state.items.length - next.length;
      if (!removed) return 0;
      return commit(next) ? 0 : removed;
    },

    /** 取消某个会话的全部待触发提醒。@returns {number} 取消条数 */
    cancelAll({ key } = {}) {
      load();
      const k = String(key ?? '').trim();
      if (!k) return 0;
      const next = state.items.filter((it) => it.key !== k || isDone(it));
      const removed = state.items.length - next.length;
      if (!removed) return 0;
      return commit(next) ? 0 : removed;
    },

    /**
     * 到点该触发的提醒（dueAt <= nowMs），按 dueAt 升序。
     * **只读**：不修改状态、不落盘 —— bridge 的 ticker 可以放心高频调用。
     * 触发后请务必调 markFired，否则下一 tick 还会返回同一批。
     */
    due(nowMs) {
      load();
      const t = Number.isFinite(nowMs) ? nowMs : now();
      return state.items
        .filter((it) => !isDone(it) && it.dueAt <= t)
        .sort(byDue)
        .map((it) => decorate(it, t));
    },

    /**
     * 标记「已触发」：
     *   repeat 'none'          → 记 firedAt（视为完成，之后 due()/list() 不再返回它，等 prune 清理）
     *   repeat 'daily'|'weekly'→ dueAt 顺延到「第一个还没到的时刻」（跨天/隔周都对）
     * 幂等：对已完成的项再调一次不会重复计数，也不会重复写盘（changed: false）。
     */
    markFired({ id, nowMs } = {}) {
      load();
      const t = Number.isFinite(nowMs) ? nowMs : now();
      const index = state.items.findIndex((it) => it.id === String(id ?? '').trim());
      if (index < 0) return { ok: false, error: '没有找到这条提醒（可能已被取消）' };
      const current = state.items[index];
      if (isDone(current)) {
        return { ok: true, item: decorate(current, t), done: true, alreadyFired: true, changed: false };
      }

      let updated;
      if (current.repeat === 'none') {
        updated = { ...current, firedAt: t, lastFiredAt: t };
      } else {
        const step = current.repeat === 'weekly' ? WEEK_MS : DAY_MS;
        let nextDueAt = current.dueAt + step;
        // 桥接没跑/机器关机导致积压多次触发时**不补发**：一口气顺延到第一个未来时刻，
        // 只算这一次（否则开机瞬间会对着同一条提醒连发 N 条消息）。
        while (nextDueAt <= t) nextDueAt += step;
        updated = { ...current, dueAt: nextDueAt, lastFiredAt: t };
      }

      const next = state.items.slice();
      next[index] = updated;
      const err = commit(next);
      if (err) return { ok: false, error: err };
      return {
        ok: true,
        item: decorate(updated, t),
        done: isDone(updated),
        nextDueAt: updated.dueAt,
        changed: true
      };
    },

    /**
     * 清理「已完成的过期项」。doneKeepMs 默认 0 → 已完成的一次性提醒立刻清掉；
     * 想留痕就把它调大（例如 7 * 86400000）。
     * @returns {number} 清理条数
     */
    prune({ nowMs } = {}) {
      load();
      const t = Number.isFinite(nowMs) ? nowMs : now();
      const keep = Math.max(0, Number(limits.doneKeepMs) || 0);
      const next = state.items.filter((it) => !(isDone(it) && it.firedAt + keep <= t));
      const removed = state.items.length - next.length;
      if (!removed) return 0;
      return commit(next) ? 0 : removed;
    },

    /** @returns {{ total: number, pending: number, nextDueAt: number|null }} */
    stats() {
      load();
      const pending = pendingItems();
      return {
        total: state.items.length,
        pending: pending.length,
        nextDueAt: pending.length ? Math.min(...pending.map((it) => it.dueAt)) : null
      };
    }
  };
}

export default createRemindersStore;

// ── 接线时要注意的坑（给改 bridge.js 的人看，本文件不参与） ────────────────────
// 1) 调用点：bridge.js 已有的 scheduleTicker（setInterval 60s，见 10854 行附近的 startScheduleTickerV2）
//    就是为「到点必叫」准备的，把 due()/markFired() 挂进去最省事；socialLoopTick 是 5s 但偏「随机机会」，
//    两个都挂会重复触发（markFired 幂等能兜住，但日志会很吵）。选一个。
// 2) 触发顺序必须是 due() → 发消息 → markFired()：先 mark 再发，发失败就永久丢了；
//    先发再 mark，最坏情况重复发一条（QQ 侧更烦）。建议在 try 里发、成功或明确失败后再 mark，
//    并且对同一批 due 加一个「本次 tick 已处理」的内存集合，防止一次 tick 里重复进入。
// 3) 发送用现有 sendWakePromptV2(key, `reminder:${id}`) 更贴现有架构（提醒要走完整 agent 回合，
//    而不是直接甩一条固定文本），模板里带上 item.text / dueText；如果只是想「原话说出来」，
//    直接走 sendVoiceForV2/发消息那条路也行，但别在 reminders.js 里发。
// 4) 每 tick 都调 stats() 看 nextDueAt 来决定要不要 return（省一次数组遍历），但别据此跳过 due()：
//    nextDueAt 是分钟级精度，边界那一秒会漏。
// 5) state/ 目录有 ACL 加固脚本（scripts/harden-state-acl.mjs / src/state-acl.mjs），
//    新增 state/reminders.json 后建议把文件名加进它们的清单，否则文件权限和 social-v2.json 不一致。
// 6) 本模块内存缓存读一次文件；如果桥接开了第二个实例，两边会互相覆盖。
//    bridge 对 social-v2.json 有「加载期间被改写就跳过回写」的保护（8904 行附近），提醒这边没做，
//    真要多实例得在 commit 前比对 mtime。
// 7) 重启不补发：due() 只看 dueAt <= now，迟到多久都算「现在该发」。
//    如果不想半夜补发白天错过的提醒，触发前自己判一下 `Date.now() - item.dueAt > graceMs` 就跳过并 markFired。
