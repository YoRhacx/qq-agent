// DSH 端点发现：**端口不能写死**。
//
// 为什么需要这个模块（真实故障，2026-10-18）：
//   桌面版 DSH 的监听端口是启动器传进来的（cordis.yml 的 webserver 行
//   `port: ctx.webStartup.port ?? 3080`，CLI 还支持 `--port 0` 让系统分配），
//   所以**每次启动都可能不一样**。桥接原来把 `config.json` 里的
//   `dsh.baseUrl = http://127.0.0.1:19387` 当作事实，DSH 某次更新后端口从
//   19387 变成 51144，于是：
//     · ensureAuth() 走的是**离线铸造 Cookie**（纯本地 HMAC，不碰网络），永远成功；
//     · 然后 WebSocket 连 ws://127.0.0.1:19387/api/remote.mux 被拒（ECONNREFUSED）；
//     · 'error'/'close' → endStream() → 生成器**正常返回**，for await 正常结束，
//       pumpMux 的 catch 不触发 ⇒ 日志里只有每 3 秒一行的「连接 DSH 事件流…」，
//       **一句错误都没有**，看起来像在连、其实在空转。
//   所以根本修法不是「把端口改对」，而是让桥接自己去问「DSH 现在在哪个端口」。
//
// 发现顺序（按优先级，从上到下）：
//   ① 环境变量 DSH_WEB_URL（桥接若由 DSH 派生的进程启动，DSH 会注入它）；
//   ② 当前使用的 baseUrl（config.json 里那个，可能过时，但先把便宜的路走完）；
//   ③ state/dsh-endpoint.json 里上次验证通过的地址（跨重启记忆）；
//   ④ 本机回环监听表（netstat -ano）：把**进程名像 DSH** 的排前面；
//   ⑤ 历史端口 19387 / 3080（旧配置与 cordis.yml 的兜底默认值）。
//   每个候选都要先过 {@link probeDshEndpoint} 的**身份校验**才可能被采用，
//   所以「端口上恰好有别的服务」不会被误连。
//
// 身份校验为什么可靠：DSH 的 HTTP 服务对未认证请求在 `/` 上回
// `401 dsh web authentication required; reopen the URL printed by dsh web.`；
// 带合法 Cookie 时回 200 + 含 __DSH_ 标记的前端 HTML。两者都是 DSH 特有的文本。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { errorText } from './error-text.js';

/** 历史默认端口（旧 config 与 cordis.yml 的兜底值）。只作最后的候选，绝不视为事实。 */
export const LEGACY_DSH_PORTS = [19387, 3080];

/** 单次 HTTP 探测超时：本机回环，1.2s 已经非常宽裕。 */
const PROBE_TIMEOUT_MS = 1200;
/** 身份校验时最多读这么多字节的响应体（前端 HTML 有几十 KB，够判定了）。 */
const PROBE_BODY_LIMIT = 4096;

const DSH_UNAUTH_MARKER = /dsh web authentication required|reopen the URL printed by dsh web/i;
const DSH_HTML_MARKERS = [/__DSH_BOOT__/, /__DSH_/, /dsh-boot/];

/** 规范化 baseUrl：只留 origin；非法时返回 ''（绝不抛，调用方常拿它做容错）。 */
export function normalizeDshBaseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.hostname) return '';
  // 只保留 origin：DSH 的基址永远没有路径部分，配置里带了 /xxx 一定是笔误。
  return url.origin;
}

/** 取 baseUrl 的端口；解析失败返回 0。 */
export function portOfBaseUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl));
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

/** 是否回环地址（只有回环才允许带 Cookie 去探测，避免把会话凭据发给别处）。 */
export function isLoopbackBaseUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '[::1]') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/** 读响应体但最多留 4KB（前端 HTML 很大，不需要全读）。 */
async function readHead(res, limit = PROBE_BODY_LIMIT) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // 读一半断开也无所谓：已经拿到的部分够判定就够用。
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, limit).toString('utf8');
}

/**
 * 判断一个 baseUrl 上跑的是不是 DSH。
 *
 * @param baseUrl - 候选基址（http(s)://host:port）。
 * @param options.cookie - 可选：已铸造的 DSH 会话 Cookie（只对回环地址发送）。
 * @param options.timeoutMs - 单次请求超时。
 * @returns { ok, status, authOk, reason }：ok 表示**确认是 DSH**；authOk 为 true/false 表示
 *   用给定 Cookie 能否通过鉴权，null 表示未验证（没给 Cookie，或未认证探测已足够）。
 */
export async function probeDshEndpoint(baseUrl, { cookie = '', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeDshBaseUrl(baseUrl);
  if (!base) return { ok: false, status: 0, authOk: null, reason: 'invalid-url' };
  const sendCookie = cookie && isLoopbackBaseUrl(base) ? cookie : '';
  let res;
  try {
    res = await fetch(base + '/', {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: sendCookie ? { cookie: sendCookie } : undefined
    });
  } catch (error) {
    // ECONNREFUSED / 超时 / DNS：端口上没人（或不是 HTTP）。
    return { ok: false, status: 0, authOk: null, reason: error?.cause?.code || error?.name || 'fetch-failed' };
  }
  const text = await readHead(res);
  if (DSH_UNAUTH_MARKER.test(text)) {
    // 未认证也能认出来：这个 401 的正文是 DSH 独有的。
    // 带 Cookie 的请求若仍是 401，说明换端口后旧 Cookie 的 authority 不匹配 —— 提前暴露。
    if (!sendCookie) return { ok: true, status: res.status, authOk: null, reason: 'unauth-marker' };
    const authOk = res.status === 200;
    return { ok: true, status: res.status, authOk, reason: authOk ? 'cookie-ok' : 'cookie-rejected' };
  }
  if (res.status === 200 && DSH_HTML_MARKERS.some((re) => re.test(text))) {
    return { ok: true, status: res.status, authOk: sendCookie ? true : null, reason: 'html-marker' };
  }
  return { ok: false, status: res.status, authOk: null, reason: 'not-dsh(' + res.status + ')' };
}

/** 跑一个子进程，返回 stdout 字符串；失败返回空串（发现流程不该因为 shell 问题整体失败）。 */
function runCapture(file, args, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error && !stdout ? '' : String(stdout ?? ''));
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * 列出本机所有**回环** TCP 监听端口（含 PID）。
 *
 * 为什么用系统监听表而不是扫端口：扫 1~65535 既慢又吵（防火墙/IDS 会记一堆连接尝试），
 * 而 netstat 一次就把「哪些端口真有人听」给全了 —— 通常只有几十个，逐个做身份校验很快。
 *
 * @returns Array<{ port, pid, process, host }>；拿不到时返回空数组。
 */
export async function listLoopbackListeners({ timeoutMs = 4000 } = {}) {
  if (process.platform === 'win32') {
    const out = await runCapture('netstat.exe', ['-ano', '-p', 'tcp'], { timeoutMs });
    return withProcessNames(parseWindowsNetstat(out), timeoutMs);
  }
  // POSIX：ss 优先（快），lsof 兜底。
  const ss = await runCapture('ss', ['-ltnp'], { timeoutMs });
  const parsed = parseSs(ss);
  if (parsed.length) return parsed;
  return parseLsof(await runCapture('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeoutMs }));
}

/** 解析 netstat -ano -p tcp 的 LISTENING 行（只留回环）。导出以便自测。 */
export function parseWindowsNetstat(text) {
  const seen = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/^TCP/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[cols.length - 2];
    const pid = Number(cols[cols.length - 1]);
    if (!/^LISTEN/i.test(state)) continue;
    // 只关心回环：127.0.0.1:PORT / [::1]:PORT
    const m = /^(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(local);
    if (!m) continue;
    const port = Number(m[1]);
    if (!port) continue;
    if (!seen.has(port)) {
      seen.set(port, {
        port,
        pid: Number.isFinite(pid) ? pid : 0,
        process: '',
        host: local.startsWith('[') ? '::1' : '127.0.0.1'
      });
    }
  }
  return [...seen.values()];
}

/** 解析 ss -ltnp。导出以便自测（非 Windows 平台使用）。 */
export function parseSs(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    if (!/^LISTEN/i.test(rawLine.trim())) continue;
    const m = /127\.0\.0\.1:(\d+)|\[::1\]:(\d+)|\*:(\d+)/.exec(rawLine);
    if (!m) continue;
    const port = Number(m[1] || m[2] || m[3]);
    const pidMatch = /pid=(\d+)/.exec(rawLine);
    const procMatch = /users:\[\("([^"]+)"/.exec(rawLine);
    if (port) out.push({ port, pid: pidMatch ? Number(pidMatch[1]) : 0, process: procMatch?.[1] ?? '', host: '127.0.0.1' });
  }
  return out;
}

/** 解析 lsof -nP -iTCP -sTCP:LISTEN。导出以便自测。 */
export function parseLsof(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(\d+).*?(?:127\.0\.0\.1|\*):(\d+)\s+\(LISTEN\)/.exec(line);
    if (!m) continue;
    out.push({ port: Number(m[3]), pid: Number(m[2]), process: m[1], host: '127.0.0.1' });
  }
  return out;
}

/** 给监听项补进程名（Windows：一次 tasklist 全量，几十毫秒）。 */
async function withProcessNames(listeners, timeoutMs) {
  if (!listeners.length || process.platform !== 'win32') return listeners;
  const out = await runCapture('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeoutMs });
  const byPid = new Map();
  for (const line of String(out ?? '').split(/\r?\n/)) {
    // "node.exe","10024","Console","1","123,456 K"
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) byPid.set(Number(m[2]), m[1]);
  }
  return listeners.map((l) => ({ ...l, process: byPid.get(l.pid) ?? '' }));
}

/** 进程名像不像 DSH（桌面端是 DeepSeek Harness.exe，CLI/无头是 node）。 */
export function looksLikeDshProcess(name) {
  return /deepseek|dsh|harness/i.test(String(name ?? ''));
}

/**
 * 读上次验证通过的端点（跨重启记忆）。文件损坏/缺失都返回 ''。
 * @param stateFile - 例如 state/dsh-endpoint.json。
 */
export function readEndpointCache(stateFile) {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const base = normalizeDshBaseUrl(doc?.baseUrl);
    return base || '';
  } catch {
    return '';
  }
}

/** 写端点缓存（原子写：先写临时文件再 rename，避免半个 JSON）。 */
export function writeEndpointCache(stateFile, baseUrl, { source = '', at = Date.now() } = {}) {
  const base = normalizeDshBaseUrl(baseUrl);
  if (!base) return;
  const tmp = stateFile + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ baseUrl: base, source, verifiedAt: new Date(at).toISOString() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    // 缓存写不进去不影响本次发现，只是下次启动少一条快路径。
  }
}

/**
 * 走完所有候选，返回**第一个**身份校验通过的 DSH 地址。
 *
 * @param options.current - 当前使用的 baseUrl（config.json 里的，可能已过时）。
 * @param options.stateFile - 端点缓存文件路径（可省略）。
 * @param options.cookieFor - (baseUrl) => cookie：按端口铸造 Cookie（Cookie 绑定 authority，
 *   所以换端口必须重新铸造）。返回空串则退化为未认证探测。
 * @param options.extraCandidates - 额外的候选（如控制台手工指定）。
 * @param options.timeoutMs - 单次探测超时。
 * @param options.log - 诊断日志（可省略）。
 * @returns { baseUrl, port, source, authOk, candidates, probes }；全都不通时返回 null。
 */
export async function discoverDshEndpoint({
  current = '',
  stateFile = '',
  cookieFor = null,
  extraCandidates = [],
  timeoutMs = PROBE_TIMEOUT_MS,
  log = () => {}
} = {}) {
  const candidates = [];
  const add = (base, source) => {
    const normalized = normalizeDshBaseUrl(base);
    if (!normalized) return;
    if (candidates.some((c) => c.baseUrl === normalized)) return;
    candidates.push({ baseUrl: normalized, source, port: portOfBaseUrl(normalized) });
  };

  // ① 环境变量：DSH 派生的子进程会带 DSH_WEB_URL（实测 DSH 0.2.x 桌面版就是这么注入的）。
  //    它可能是**上一轮** DSH 留下的陈旧值（桥接从旧会话的终端里启动时），
  //    所以它只是候选，仍要过身份校验。
  if (process.env.DSH_WEB_URL) add(process.env.DSH_WEB_URL, 'env:DSH_WEB_URL');
  // ② 当前配置值：最便宜也最常见（端口没变时第一轮就结束了）。
  add(current, 'config');
  // ③ 上次验证通过的地址（跨重启记忆）。
  if (stateFile) add(readEndpointCache(stateFile), 'cache');
  for (const base of extraCandidates) add(base, 'extra');

  // 探测**不带 Cookie**：身份校验靠 DSH 401 正文里的独有标记就够了；而把会话 Cookie
  // 发给本机其它服务（QQ / Steam / 各种常驻程序都开着回环端口）是不必要的凭据扩散
  // —— 只有确认是 DSH 之后才带着 Cookie 再验一次鉴权。
  const probeBatch = (batch) => Promise.all(batch.map(async (c) => ({
    ...c,
    ...(await probeDshEndpoint(c.baseUrl, { timeoutMs }))
  })));

  // 第一轮（便宜）：只探 env / config / cache / extra。端口没变时 10ms 量级就返回
  // —— 健康检查每 5 秒会走这条路径，不能每次都跑 netstat。
  let probes = await probeBatch(candidates);
  let hit = probes.find((p) => p.ok);

  if (!hit) {
    // 第二轮（贵）：本机回环监听表。进程名像 DSH 的排前面，其余排后面但仍要试
    // —— 监听可能落在 Electron 的某个子进程里，名字不一定含 dsh。
    let listeners = [];
    try {
      listeners = await listLoopbackListeners({ timeoutMs: Math.max(timeoutMs, 3000) });
    } catch (error) {
      log('端点发现：读本机监听表失败（' + (errorText(error)) + '）');
    }
    const hinted = listeners.filter((l) => looksLikeDshProcess(l.process));
    const others = listeners.filter((l) => !looksLikeDshProcess(l.process));
    const before = candidates.length;
    for (const l of hinted) add('http://127.0.0.1:' + l.port, 'listen:' + (l.process || l.pid));
    for (const l of others) add('http://127.0.0.1:' + l.port, 'listen:' + (l.process || l.pid));
    // 历史端口兜底（监听表可能漏：权限、IPv6-only、或进程刚起还没 listen）。
    for (const port of LEGACY_DSH_PORTS) add('http://127.0.0.1:' + port, 'legacy-port');
    probes = probes.concat(await probeBatch(candidates.slice(before)));
    hit = probes.find((p) => p.ok);
  }

  if (!hit) {
    log('端点发现：' + probes.length + ' 个候选都不是 DSH（' + probes.map((p) => p.port + ':' + p.reason).join(', ') + '）');
    return null;
  }

  // 确认是 DSH 之后才拿 Cookie 验一次鉴权：Cookie 绑定 authority，换端口后旧 Cookie
  // 必然无效 —— 这里能提前把「端口找对了、鉴权没跟上」这种更难查的形态暴露出来。
  let authOk = hit.authOk;
  if (cookieFor) {
    let cookie = '';
    try { cookie = cookieFor(hit.baseUrl) ?? ''; } catch { cookie = ''; }
    if (cookie) {
      const verified = await probeDshEndpoint(hit.baseUrl, { cookie, timeoutMs });
      authOk = verified.ok ? verified.authOk : false;
    }
  }

  if (stateFile) writeEndpointCache(stateFile, hit.baseUrl, { source: hit.source });
  return { baseUrl: hit.baseUrl, port: hit.port, source: hit.source, authOk, candidates, probes };
}
