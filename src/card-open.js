// 「点开卡片」：把群友分享的音乐卡/视频卡变成**真内容**，而不是只念一遍标题。
//
// 分工：
//   · 桥接只负责在收到卡片时把标题/链接存下来（rich-card.js 解析，存进消息 media），
//     并提供 /api/cards/message 按 messageId 取回；
//   · 真正"点开"（取歌曲信息+歌词、取 B 站视频信息+画面）在这里做。
//
// 为什么音乐走 music.163.com 的公开接口：卡片里的 `musicUrl` 是带 rkey 的临时直链，
// 过期就废；而歌曲 id 是稳定的，用它去查 song/detail + song/lyric 能拿到歌名/歌手/专辑/歌词，
// 这几个字段才是"她真的听过这首歌"所需要的。接口是公开的，不需要登录、不需要 cookie。
import { parseVideoId, watchVideo } from './video-watch.js';
import { errorText } from './error-text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 网易云歌曲页/接口都要 Referer，缺了会被拒。 */
const NETEASE_HEADERS = Object.freeze({
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Accept: 'application/json, text/plain, */*'
});

async function fetchJson(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { ...NETEASE_HEADERS, ...extraHeaders }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 从各种形态的输入里抠出网易云歌曲 id（纯数字 / URL / 卡片对象）。 */
export function neteaseSongId(input) {
  if (input == null) return '';
  if (typeof input === 'number') return String(input);
  if (typeof input === 'object') {
    const hay = [input.url, input.audioUrl, input.jumpUrl, input.extra?.jumpUrl, input.extra?.musicUrl, input.extra?.qqdocurl]
      .filter(Boolean).join(' ');
    return neteaseSongId(hay);
  }
  const s = String(input).trim();
  if (/^\d{1,15}$/.test(s)) return s;
  const m = /[?&]id=(\d{1,15})/.exec(s);
  if (m) return m[1];
  const m2 = /song\/(\d{1,15})/.exec(s);
  if (m2) return m2[1];
  return '';
}

/** 把 LRC 文本削成纯歌词行（去掉时间轴/元信息标签）。 */
export function lyricsToPlain(lrc, maxLines = 60) {
  const raw = String(lrc ?? '');
  if (!raw.trim()) return '';
  const out = [];
  for (const line of raw.split('\n')) {
    const text = line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').replace(/^\[[a-z]+:.*?\]$/i, '').trim();
    if (text) out.push(text);
    if (out.length >= maxLines) break;
  }
  return out.join('\n');
}

/**
 * 取网易云歌曲信息（歌名/歌手/专辑/时长）+ 歌词。
 * @param {string|number|object} input 歌曲 id、URL 或卡片对象
 * @returns {Promise<{ok:boolean, id:string, name:string, artists:string, album:string,
 *                    durationSec:number, cover:string, lyrics:string, report:string, error:string}>}
 */
export async function openNeteaseSong(input) {
  const id = neteaseSongId(input);
  const empty = { ok: false, id, name: '', artists: '', album: '', durationSec: 0, cover: '', lyrics: '', report: '', error: '' };
  if (!id) return { ...empty, error: '认不出网易云歌曲 id（卡片里没有可用的歌曲链接）' };
  let song = null;
  try {
    const detail = await fetchJson(`https://music.163.com/api/song/detail/?ids=[${id}]`);
    song = detail?.songs?.[0] ?? null;
  } catch (error) {
    return { ...empty, error: `取歌曲信息失败：${errorText(error)}` };
  }
  if (!song) return { ...empty, error: `网易云查不到这首歌（id=${id}，可能已下架）` };

  const name = String(song.name ?? '');
  const alias = Array.isArray(song.alias) ? song.alias.filter(Boolean) : [];
  const artists = (Array.isArray(song.artists) ? song.artists : []).map((a) => String(a?.name ?? '')).filter(Boolean).join('/');
  const album = String(song.album?.name ?? '');
  const durationSec = Math.round((Number(song.duration) || 0) / 1000);
  const cover = String(song.album?.picUrl ?? song.artists?.[0]?.picUrl ?? '');

  // 歌词拿不到不算失败——纯音乐/新歌经常没有词。
  let lyrics = '';
  let lyricNote = '';
  try {
    const lyr = await fetchJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);
    lyrics = lyricsToPlain(lyr?.lrc?.lyric ?? '');
    if (!lyrics) lyricNote = '这首歌没有歌词（纯音乐或网易云未收录）';
  } catch (error) {
    lyricNote = `歌词没取到：${errorText(error)}`;
  }

  const lines = [
    `【网易云音乐】${name}${alias.length ? `（${alias.join(' / ')}）` : ''}`,
    `歌手：${artists || '未知'}${album ? ` ｜ 专辑：${album}` : ''}${durationSec ? ` ｜ 时长 ${durationSec}s` : ''}`,
    `链接：https://music.163.com/song?id=${id}`,
    lyrics ? `歌词（节选）：\n${lyrics.slice(0, 1500)}` : '',
    lyricNote
  ].filter(Boolean);

  return { ok: true, id, name, artists, album, durationSec, cover, lyrics, report: lines.join('\n'), error: '' };
}

/**
 * 跟一次 b23.tv 短链重定向，拿到真实的 bilibili.com 链接。
 *
 * 为什么要专门做这一步：B 站卡片在 QQ 里绝大多数是 `https://b23.tv/xxxx` 短链，
 * 里面**没有** BV 号，`parseVideoId()` 对它是返回 null 的 —— 不跟这一次重定向，
 * 「点开 B 站卡片」就会静默退化成「只把链接念一遍」，而这恰恰是最常见的形状。
 * 只对 b23.tv 主机发请求（别的域名一律不碰），并限制重定向次数。
 */
export async function resolveB23Url(url) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\/b23\.tv\/[0-9A-Za-z]+/i.test(s)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(s, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: controller.signal
    });
    // 只要最终地址，正文丢掉（否则会白下一整个视频页）。
    try { await res.body?.cancel(); } catch {}
    const finalUrl = String(res.url ?? '');
    return /bilibili\.com/i.test(finalUrl) ? finalUrl : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 「点开」一张卡片：音乐 → 歌曲信息+歌词；B 站视频 → watchVideo；其它 → 只回链接。
 * @param {{kind?:string,title?:string,desc?:string,url?:string,audioUrl?:string,source?:string}} card
 * @param {{frames?:number, outDir?:string}} [opts]
 */
export async function openCard(card, opts = {}) {
  // extra.qqdocurl 是 QQ 小程序卡片里真正的目标链接（`url` 往往是 m.q.qq.com 中转页），
  // 解析层已经优先选它了，这里再兜一层，免得上游哪天又变了。
  const docUrl = String(card?.extra?.qqdocurl ?? '').trim();
  const rawUrl = String(card?.url ?? '').trim();
  const url = docUrl && (!rawUrl || /(^|\.)m\.q\.qq\.com|qq\.com\/a\/s/i.test(rawUrl)) ? docUrl : (rawUrl || docUrl);
  const title = String(card?.title ?? '').trim();
  const hay = `${url} ${docUrl} ${card?.audioUrl ?? ''} ${card?.source ?? ''} ${title}`;

  // 1) B 站视频卡：复用「看视频」（有画面、有弹幕、有字幕）
  //    短链先跟一次重定向再解析 —— 见 resolveB23Url 的注释。
  let videoId = parseVideoId(url) || parseVideoId(hay);
  let videoUrl = url;
  if (!videoId && /b23\.tv/i.test(hay)) {
    const resolved = await resolveB23Url(url || hay);
    if (resolved) {
      videoId = parseVideoId(resolved);
      videoUrl = resolved;
    }
  }
  if (videoId && /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}|\bav\d+/i.test(`${videoUrl} ${hay}`)) {
    // 默认走联系表（覆盖全片、只占一份图像成本）；opts.frames 可调，上限 24。
    const r = await watchVideo(videoId.id, {
      frames: Math.max(1, Math.min(24, Number(opts.frames) || 8)),
      layout: opts.layout === 'list' ? 'list' : 'sheet',
      outDir: opts.outDir,
    });
    if (r?.ok) return { ok: true, type: 'video', report: r.report, frames: r.frames ?? [], error: '' };
    return { ok: false, type: 'video', report: '', frames: [], error: r?.error ?? '看视频失败' };
  }

  // 2) 网易云音乐卡（或任何带歌曲 id 的链接）
  if (/music\.163\.com|163cn\.tv|网易云|netease/i.test(hay) || neteaseSongId(url)) {
    const song = await openNeteaseSong(card);
    if (song.ok) return { ok: true, type: 'music', report: song.report, frames: [], error: '' };
    // 认得出是音乐卡但查不到歌：至少把卡片本身的信息给出去，别整个失败
    const fallback = [title ? `【音乐卡片】${title}` : '【音乐卡片】', card?.desc ? `歌手：${card.desc}` : '', url ? `链接：${url}` : '', song.error].filter(Boolean);
    return { ok: Boolean(fallback.length), type: 'music', report: fallback.join('\n'), frames: [], error: song.error };
  }

  // 3) 其它卡片：能给的只有标题/简介/链接
  const lines = [
    title ? `【卡片】${title}` : '【卡片】',
    card?.desc ? `说明：${card.desc}` : '',
    card?.source ? `来源：${card.source}` : '',
    url ? `链接：${url}` : '',
    '（这类卡片没有可直接读取的正文，只能把链接给你。）'
  ].filter(Boolean);
  return { ok: true, type: 'card', report: lines.join('\n'), frames: [], error: '' };
}
