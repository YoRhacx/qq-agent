// 让机器人“看”视频：解析 B 站 BV/av/短链 → 视频信息 + 弹幕/字幕摘要 + 关键帧图片。
//
// 抓取策略（都是实测出来的）：
// 1. 元信息：`x/web-interface/view`（公开）。
// 2. 弹幕：`comment.bilibili.com/<cid>.xml`（公开）→ 统计高频文本，最能看出视频在讲什么/什么梗。
// 3. 字幕：`x/player/wbi/v2`（WBI 签名；多数视频需要登录，拿不到就为空）。
// 4. 画面（两条路，优先级从高到低）：
//    a. `x/player/playurl?...&platform=html5&high_quality=1` —— **不需要 WBI 签名、不需要 cookie**，
//       直接给 mp4 地址（360P/480P），下载后 ffmpeg 抽帧 → 真实关键帧。
//    b. `x/player/wbi/playurl`（WBI 签名，偶尔能给更高清晰度，也更容易被风控 412）。
//    c. 都不行时退回 `x/player/videoshot`（进度条预览图，10×10 拼图，公开无风控）→ ffmpeg crop 出
//       时间点快照。分辨率小（160×90），但**几乎每个视频都有**，比“什么都看不到”强太多。
// 5. ffmpeg 只探测本机已有的（剪映自带），不下载、不安装。
// 任何一步失败都只写进 streamNote，不整体失败——宁可“只看了文字”，也不能让工具报错。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { errorText } from './error-text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 从链接/文本里抠出 BV 号或 av 号。 */
export function parseVideoId(input) {
  const s = String(input ?? '').trim();
  const bv = /BV[0-9A-Za-z]{10}/.exec(s);
  if (bv) return { kind: 'bvid', id: bv[0] };
  const av = /\bav(\d{1,12})\b/i.exec(s);
  if (av) return { kind: 'aid', id: av[1] };
  if (/^\d{1,12}$/.test(s)) return { kind: 'aid', id: s };
  return null;
}

/** 抽帧上限。24 张已经能覆盖 2 小时视频的每 5 分钟，再多纯属浪费。 */
export const MAX_FRAMES = 24;
/** 默认抽几张（拼成一张联系表时，这个数量等于「从头到尾看几眼」）。 */
export const DEFAULT_FRAMES = 8;
/** 默认单格宽度（联系表里每一小格的像素宽）。 */
export const DEFAULT_TILE_WIDTH = 320;

/**
 * 取样时间点：**首尾都要**。
 *
 * 旧实现是 `duration * (i+1) / (n+1)` —— 4 帧就是 20%/40%/60%/80%，
 * 片头片尾永远看不到，而「开头讲了什么」「结尾什么结果」恰恰是最该看的。
 * 现在改成端点包含：n=1 取正中间，n≥2 时第一个是 0、最后一个是 duration。
 * @returns {number[]} 秒数（升序、去重）
 */
export function sampleTimes(durationSec, n) {
  const total = Math.max(1, Number(durationSec) || 1);
  const count = Math.max(1, Math.round(Number(n) || 1));
  if (count === 1) return [Math.max(0, Math.floor(total / 2))];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t = Math.round((total * i) / (count - 1));
    out.push(Math.max(0, Math.min(total, t)));
  }
  return [...new Set(out)];
}

/** 联系表的网格列数：尽量接近正方形。 */
export function sheetGrid(n) {
  const count = Math.max(1, Math.round(Number(n) || 1));
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows };
}

/** 秒 → `M:SS` / `H:MM:SS`。 */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 一串时间点 → `0:00 / 3:20 / 6:40 …`（给模型说明每格对应片头片尾的哪个位置）。 */
export function formatClock(times, max = 24) {
  const list = (Array.isArray(times) ? times : []).slice(0, max);
  if (!list.length) return '未知';
  return list.map((t) => formatDuration(t)).join(' / ');
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...extraHeaders },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mixinKey(imgKey, subKey) {
  const orig = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

async function wbiKeys() {
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const img = String(nav?.data?.wbi_img?.img_url ?? '').split('/').pop().split('.')[0];
  const sub = String(nav?.data?.wbi_img?.sub_url ?? '').split('/').pop().split('.')[0];
  if (!img || !sub) throw new Error('拿不到 WBI 密钥');
  return mixinKey(img, sub);
}

function wbiSign(params, key) {
  const withTs = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 探测本机可用的 ffmpeg（剪映自带的那个也能用）。 */
export function findFfmpeg() {
  const roots = ['D:\\JianyingPro', 'C:\\JianyingPro', 'D:\\ffmpeg\\bin'];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      if (root.endsWith('bin')) {
        const direct = path.join(root, 'ffmpeg.exe');
        if (fs.existsSync(direct)) return direct;
        continue;
      }
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const candidate = path.join(root, e.name, 'ffmpeg.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -1, out, err: `${err}\n(超时)` }); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -2, out, err: String(e?.message ?? e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** 弹幕：公开 XML，取「重复次数最多 + 字数适中」的若干条。
 *  注意：热门视频的弹幕 XML 能到几十 MB（Rickroll 那条 15 万条弹幕），
 *  所以**边下边读、超过 capBytes 就停**，不能无脑 await res.text()。 */
async function fetchDanmaku(cid, limit = 40, capBytes = 8 * 1024 * 1024) {
  try {
    const res = await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
    if (!res.ok) return { ok: false, texts: [] };
    let xml = '';
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        xml += decoder.decode(value, { stream: true });
        if (got >= capBytes) { try { await reader.cancel(); } catch {} break; }
      }
    } else {
      xml = (await res.text()).slice(0, capBytes);
    }
    const counts = new Map();
    for (const m of xml.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const texts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
      .slice(0, limit)
      .map(([t, n]) => (n > 1 ? `${t}（×${n}）` : t));
    return { ok: true, texts };
  } catch {
    return { ok: false, texts: [] };
  }
}

/** 字幕：优先中文 CC（多数需要登录，拿不到就算了）。 */
async function fetchSubtitle(bvid, cid) {
  try {
    const key = await wbiKeys();
    const j = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?${wbiSign({ bvid, cid }, key)}`);
    const subs = j?.data?.subtitle?.subtitles ?? [];
    if (!subs.length) return { ok: false, text: '' };
    const target = subs.find((s) => /zh/i.test(s.lan)) ?? subs[0];
    const subUrl = String(target.subtitle_url ?? '');
    if (!subUrl) return { ok: false, text: '' };
    const body = await fetchJson(subUrl.startsWith('//') ? `https:${subUrl}` : subUrl);
    const text = (body?.body ?? []).map((l) => String(l.content ?? '')).join(' ');
    return { ok: !!text, text: text.slice(0, 4000) };
  } catch {
    return { ok: false, text: '' };
  }
}

/** 拿一条可下载的流：先 html5（无签名、免登录），再 WBI（可能更高清）。 */
async function resolveStreamUrl(bvid, cid) {
  const referer = `https://www.bilibili.com/video/${bvid}`;
  try {
    const j = await fetchJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&platform=html5&high_quality=1`,
      { Referer: referer },
    );
    const url = j?.data?.durl?.[0]?.url;
    if (j?.code === 0 && url) return { url: String(url), quality: j.data.quality, format: j.data.format, via: 'html5' };
  } catch {}
  try {
    const key = await wbiKeys();
    const query = wbiSign({ bvid, cid, qn: 32, fnval: 1, fourk: 0, fnver: 0 }, key);
    const j = await fetchJson(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { Referer: referer });
    const url = j?.data?.durl?.[0]?.url ?? j?.data?.durl?.[0]?.backup_url?.[0] ?? '';
    if (url) return { url: String(url), quality: j?.data?.quality ?? null, format: j?.data?.format ?? null, via: 'wbi' };
  } catch {}
  return { url: '', via: '' };
}

/** 下载视频流到本地。带字节上限：一个 2 小时 1080P 能到几个 G，不能无脑吃满磁盘。 */
async function download(url, dest, maxBytes = 300 * 1024 * 1024) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared && declared > maxBytes) throw new Error(`视频流 ${(declared / 1048576).toFixed(0)}MB 超过上限 ${(maxBytes / 1048576).toFixed(0)}MB`);
  // 边下边数，超了就断——content-length 可能缺失或撒谎。
  const chunks = [];
  let got = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`视频流超过上限 ${(maxBytes / 1048576).toFixed(0)}MB，已中断下载`);
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** 从下载好的视频里抽 n 张关键帧（时间点由 sampleTimes 给，含首尾）。 */
export async function framesFromVideo(ffmpeg, videoFile, dir, durationSec, n, tileWidth = 480) {
  const out = [];
  const picked = [];
  const times = sampleTimes(durationSec, n);
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    const file = path.join(dir, `frame${i + 1}.jpg`);
    const r = await run(ffmpeg, ['-y', '-ss', String(t), '-i', videoFile, '-frames:v', '1', '-vf', `scale=${tileWidth}:-2`, '-q:v', '4', file]);
    if (r.code === 0 && fs.existsSync(file) && fs.statSync(file).size > 512) { out.push(file); picked.push(t); }
  }
  return { out, picked };
}

/**
 * 把抽好的帧拼成一张「联系表」（contact sheet）—— 这是「从头看到尾」的关键。
 *
 * 为什么必须拼：每一张图都是一份独立的图像输入，16 张单图 = 16 份成本；
 * 拼成一张 4×4 网格就只有 **一份**图像成本，却能看到 16 个时间点。
 * 实测 16 帧拼一张 320px/格约 86KB，比单发 16 张（约 500KB）还小。
 * @returns {Promise<{ok:boolean, file?:string, note?:string}>}
 */
export async function buildContactSheet(ffmpeg, frames, dir, tileWidth = DEFAULT_TILE_WIDTH) {
  if (!ffmpeg || frames.length < 2) return { ok: false, note: '不足两张帧，拼不了联系表' };
  const { cols, rows } = sheetGrid(frames.length);
  const sheet = path.join(dir, 'sheet.jpg');
  // 用 glob 序列而不是 %d 模板：抽帧失败会让编号出现空洞，%d 会在第一个缺口处截断。
  const listFile = path.join(dir, 'frames.txt');
  try {
    fs.writeFileSync(listFile, frames.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  } catch (error) {
    return { ok: false, note: `联系表清单写入失败：${errorText(error)}` };
  }
  const r = await run(ffmpeg, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `scale=${tileWidth}:-2,tile=${cols}x${rows}:padding=3:margin=3`,
    '-frames:v', '1', '-q:v', '4', sheet,
  ]);
  try { fs.rmSync(listFile, { force: true }); } catch {}
  if (r.code !== 0 || !fs.existsSync(sheet) || fs.statSync(sheet).size < 1024) {
    return { ok: false, note: `联系表生成失败${r.err ? `：${String(r.err).slice(-160)}` : ''}` };
  }
  return { ok: true, file: sheet, cols, rows };
}

/** 兜底：进度条预览拼图（10×10，160×90 一格）→ 按时间点 crop 出快照。 */
async function framesFromSprite(bvid, cid, dir, durationSec, n) {
  const j = await fetchJson(`https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&cid=${cid}&index=1`);
  const d = j?.data;
  if (j?.code !== 0 || !d?.image?.length) return { out: [], note: `videoshot 不可用（code=${j?.code}）` };
  const spriteUrl = String(d.image[0]).startsWith('//') ? `https:${d.image[0]}` : String(d.image[0]);
  const xLen = Number(d.img_x_len) || 10;
  const yLen = Number(d.img_y_len) || 10;
  const cw = Number(d.img_x_size) || 160;
  const ch = Number(d.img_y_size) || 90;
  const stamps = Array.isArray(d.index) ? d.index : [];
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { out: [], note: '本机没找到 ffmpeg，连快照也切不出来' };
  fs.mkdirSync(dir, { recursive: true });
  const sprite = path.join(dir, 'sprite.jpg');
  await download(spriteUrl, sprite, 64 * 1024 * 1024);
  const total = Math.min(stamps.length, xLen * yLen);
  const out = [];
  const times = sampleTimes(durationSec, n);
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    // 找时间上最接近的一格
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < total; k += 1) {
      const delta = Math.abs(Number(stamps[k]) - t);
      if (delta < bestD) { bestD = delta; best = k; }
    }
    const col = best % xLen;
    const row = Math.floor(best / xLen);
    const file = path.join(dir, `shot${i + 1}.jpg`);
    const r = await run(ffmpeg, [
      '-y', '-i', sprite,
      '-vf', `crop=${cw}:${ch}:${col * cw}:${row * ch},scale=480:-2`,
      '-frames:v', '1', '-q:v', '4', file,
    ]);
    if (r.code === 0 && fs.existsSync(file) && fs.statSync(file).size > 512) out.push(file);
  }
  try { fs.rmSync(sprite, { force: true }); } catch {}
  return { out, note: out.length ? '' : '快照裁剪失败' };
}

/**
 * 主入口：看一个视频。
 * @param {string} input BV 号 / av 号 / 链接
 * @param {object} [opts]
 * @param {number} [opts.frames] 抽几张（默认 8，上限 24）
 * @param {'sheet'|'list'} [opts.layout] `sheet`=拼成一张联系表（默认，省额度、覆盖全片）；
 *        `list`=逐张返回（看得更清楚，但每张都算一份图像成本）
 * @param {number} [opts.maxDurationSec] 超过这个时长就不下视频了（默认 7200 = 2 小时）
 * @param {boolean} [opts.preferSprite] 强制走进度条快照
 * @returns {Promise<{ok:boolean, error?:string, info?:object, danmaku?:string[], subtitle?:string,
 *                    frames?:string[], streamOk?:boolean, frameSource?:string, streamNote?:string,
 *                    report?:string, layout?:string, pickedTimes?:number[]}>}
 */
export async function watchVideo(input, { frames = DEFAULT_FRAMES, outDir, maxDurationSec = 7200, preferSprite = false, layout = 'sheet' } = {}) {
  const parsed = parseVideoId(input);
  if (!parsed) return { ok: false, error: '没找到 BV 号 / av 号（也不认识这个链接）' };
  const bvid = parsed.kind === 'bvid' ? parsed.id : null;

  const viewUrl = bvid
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${parsed.id}`;
  const view = await fetchJson(viewUrl);
  if (view?.code !== 0 || !view?.data) return { ok: false, error: `B 站接口返回：${view?.message ?? '未知错误'}（code=${view?.code}）` };

  const d = view.data;
  const cid = d.pages?.[0]?.cid ?? d.cid;
  const finalBvid = d.bvid;
  const durationSec = Number(d.duration) || 1;
  const info = {
    bvid: finalBvid,
    aid: d.aid,
    title: d.title,
    desc: String(d.desc ?? '').slice(0, 600),
    durationSec,
    up: d.owner?.name,
    view: d.stat?.view,
    like: d.stat?.like,
    danmakuCount: d.stat?.danmaku,
    pubdate: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : '',
    cover: d.pic,
    pages: (d.pages ?? []).length,
  };

  const [dm, sub] = await Promise.all([fetchDanmaku(cid), fetchSubtitle(finalBvid, cid)]);

  const n = Math.max(1, Math.min(MAX_FRAMES, Number(frames) || DEFAULT_FRAMES));
  // 拼联系表时每格可以小一点（一格里只占 1/16 的画幅，给 640 也是浪费）；
  // 逐张返回时要看清楚，用 640。
  const useSheet = layout !== 'list';
  const frameWidth = useSheet ? DEFAULT_TILE_WIDTH : 640;
  // outDir 语义是「视频目录的父目录」，每个视频固定落在 <outDir>/<bvid>/ 下。
  const dir = path.join(outDir ?? path.join(process.cwd(), 'state', 'videos'), finalBvid);
  let framePaths = [];
  let streamOk = false;
  let frameSource = '';
  let streamNote = '';
  let pickedTimes = [];
  let sheetInfo = null;

  if (durationSec > maxDurationSec) {
    streamNote = `视频时长 ${durationSec}s 超过 ${maxDurationSec}s 上限，没抓画面`;
  } else {
    // 1) 真视频 → 抽帧（preferSprite 时跳过，直接走快照）
    try {
      if (preferSprite) throw new Error('按参数要求改用视频快照');
      const stream = await resolveStreamUrl(finalBvid, cid);
      if (!stream.url) throw new Error('playurl 没给出下载地址（可能被风控 412）');
      fs.mkdirSync(dir, { recursive: true });
      const videoFile = path.join(dir, 'video.m4s');
      await download(stream.url, videoFile);
      streamOk = true;
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) {
        streamNote = '视频流拿到了，但本机没找到 ffmpeg，抽不了帧';
      } else {
        const r = await framesFromVideo(ffmpeg, videoFile, dir, durationSec, n, frameWidth);
        framePaths = r.out;
        pickedTimes = r.picked;
        if (framePaths.length) frameSource = `关键帧（${stream.via === 'html5' ? 'html5 流' : 'WBI 流'}，质量码 ${stream.quality ?? '?'}）`;
        else streamNote = 'ffmpeg 抽帧失败';
        if (useSheet && framePaths.length >= 2) {
          sheetInfo = await buildContactSheet(ffmpeg, framePaths, dir, DEFAULT_TILE_WIDTH);
          if (!sheetInfo.ok) streamNote = `${streamNote}${streamNote ? '；' : ''}${sheetInfo.note}`;
        }
      }
      try { fs.rmSync(videoFile, { force: true }); } catch {}
    } catch (error) {
      streamNote = `拿不到视频流（${errorText(error)}）`;
    }
    // 2) 退路：进度条快照
    if (!framePaths.length) {
      try {
        const r = await framesFromSprite(finalBvid, cid, dir, durationSec, n);
        if (r.out.length) {
          framePaths = r.out;
          frameSource = '进度条快照（分辨率较低，但能看到画面）';
          streamNote = `${streamNote}${streamNote ? '；' : ''}已改用视频快照，画质是缩略图级别`;
          if (useSheet && framePaths.length >= 2) {
            const ffmpeg = findFfmpeg();
            sheetInfo = await buildContactSheet(ffmpeg, framePaths, dir, DEFAULT_TILE_WIDTH);
            if (!sheetInfo.ok) streamNote = `${streamNote}${streamNote ? '；' : ''}${sheetInfo.note}`;
          }
        } else if (r.note) {
          streamNote = `${streamNote}${streamNote ? '；' : ''}${r.note}`;
        }
      } catch (error) {
        streamNote = `${streamNote}${streamNote ? '；' : ''}快照也失败：${errorText(error)}`;
      }
    }
  }

  // 真正交给模型的图片：联系表模式下只给那一张拼图。
  const outputFrames = useSheet && sheetInfo?.ok ? [sheetInfo.file] : framePaths;
  const sheetNote = useSheet && sheetInfo?.ok
    ? `画面：已把全片 ${pickedTimes.length || framePaths.length} 个时间点拼成一张 ${sheetInfo.cols}×${sheetInfo.rows} 联系表（左→右、上→下按时间先后），每个时间点约 ${formatClock(pickedTimes)}。`
    : '';

  const lines = [
    `【视频】${info.title}`,
    `UP：${info.up} ｜ 时长 ${formatDuration(info.durationSec)}（${info.durationSec}s）｜ 发布 ${info.pubdate} ｜ 播放 ${info.view} ｜ 弹幕 ${info.danmakuCount}`,
    info.desc && info.desc !== '-' ? `简介：${info.desc}` : '',
    sub.text ? `字幕（节选）：${sub.text.slice(0, 1200)}` : '',
    dm.texts.length ? `弹幕高频（最能看出梗和观众情绪）：${dm.texts.slice(0, 30).join(' ｜ ')}` : '',
    sheetNote,
    !sheetNote && outputFrames.length ? `画面：${frameSource}，共 ${outputFrames.length} 张，已随本次工具结果一起给出（你可以直接看图）。` : '',
    streamNote,
  ].filter(Boolean);

  return {
    ok: true,
    info,
    danmaku: dm.texts,
    subtitle: sub.text,
    // frames = 真正交给模型的图（联系表模式下就是那一张拼图）
    frames: outputFrames,
    // tiles = 单帧文件（诊断用，模型一般不需要）
    tiles: framePaths,
    pickedTimes,
    layout: useSheet && sheetInfo?.ok ? 'sheet' : 'list',
    sheet: sheetInfo?.ok ? { cols: sheetInfo.cols, rows: sheetInfo.rows } : null,
    streamOk,
    frameSource,
    streamNote,
    report: lines.join('\n'),
  };
}

// CLI：node src/video-watch.js BV1xx411c7mD [帧数] [sheet|list]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  const layout = process.argv[4] === 'list' ? 'list' : 'sheet';
  watchVideo(arg, { frames: Number(process.argv[3]) || DEFAULT_FRAMES, layout })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error('watchVideo 异常:', e); process.exit(1); });
}
