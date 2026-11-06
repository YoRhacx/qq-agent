// 富媒体卡片（分享卡片）解析。
//
// 背景：QQ 里发出来的网易云音乐、B 站视频、公众号文章、小程序等等，在 OneBot 里都是
// `json` 段或 `xml` 段。桥接过去把 `json` 直接渲染成 `[卡片消息]`、`xml` 更是落进 default
// 变成 `[xml]` —— 于是她只看得见「这里有个卡片」，看不见卡片是什么。
//
// 这个模块把两种载荷都归一化成同一份结构：
//   { ok, kind, title, desc, url, audioUrl, image, source, extra }
// kind: 'music' | 'video' | 'article' | 'card'
//
// 纯函数，无网络、无副作用 —— 便于自检。
import { XMLParser } from './xml-lite.js';
import { errorText } from './error-text.js';

const MUSIC_APP_RE = /music|qqmusic|kugou|kuwo|migu|netease/i;

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function pickMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  // meta 通常是 { music: {...} } / { news: {...} } / { detail_1: {...} }，取第一个对象值。
  for (const v of Object.values(meta)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

/** 内容站域名：卡片里真正指向内容的那条链接。 */
const CONTENT_HOST_RE = /(bilibili\.com|b23\.tv|music\.163\.com|163cn\.tv|y\.qq\.com|kugou\.com|kuwo\.cn|migu\.cn|iqiyi\.com|youku\.com|douyin\.com|weibo\.com|zhihu\.com|xiaohongshu\.com)/i;
/** QQ 自己的中转页（小程序落地页 / 短链）：点开也到不了内容，不该优先选它。 */
const QQ_RELAY_HOST_RE = /(^|\.)m\.q\.qq\.com|(^|\.)url\.cn|qq\.com\/a\/s/i;

/**
 * 从卡片里挑出「最像真内容」的那条链接。
 *
 * 为什么不能按固定字段顺序取：QQ 小程序卡片（`com.tencent.miniapp_01`）里
 * `url` 是 `m.q.qq.com/a/s/<hash>` 这种**中转落地页**，而**真链接在 `qqdocurl`**
 * ——B 站卡就是 `https://b23.tv/xxxx?share_medium=...`。过去按
 * jumpUrl → url → sourceUrl → qqdocurl 的顺序取，恰好取到没用的中转页，
 * 真链接被丢掉，于是「点开卡片」只能念标题和封面（主人 2026-10-12 报的正是这个）。
 * 现在按「内容站优先」排序，中转页只当最后的兜底。
 */
export function pickCardUrl(node, root) {
  return pickBestUrl([node?.jumpUrl, node?.qqdocurl, node?.url, node?.sourceUrl, root?.qqdocurl]);
}

/** 从一串候选链接里挑最像真内容的（内容站 > 非中转 > 第一条）。 */
export function pickBestUrl(list) {
  const candidates = (Array.isArray(list) ? list : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
  if (!candidates.length) return '';
  const content = candidates.find((u) => CONTENT_HOST_RE.test(u));
  if (content) return content;
  const nonRelay = candidates.find((u) => !QQ_RELAY_HOST_RE.test(u));
  return nonRelay || candidates[0];
}

function classify(app, view, node, root) {
  const a = String(app ?? '').toLowerCase();
  const v = String(view ?? '').toLowerCase();
  if (MUSIC_APP_RE.test(a) || v === 'music') return 'music';
  const jump = `${node?.jumpUrl ?? ''} ${node?.qqdocurl ?? ''} ${node?.url ?? ''} ${root?.qqdocurl ?? ''}`.toLowerCase();
  if (/bilibili\.com|b23\.tv/.test(jump)) return 'video';
  if (/music\.163\.com|y\.qq\.com|kugou|kuwo|migu/.test(jump)) return 'music';
  if (v === 'news' || v === 'video' || node?.video) return 'video';
  return 'article';
}

/** XML 卡片的类型判定：URL 域名最可靠，其次是标题里的关键词。 */
function classifyXml(attrs, rootAttrs, info) {
  const hay = `${info.url} ${info.title} ${info.desc} ${attrs.servicetype ?? ''} ${attrs.action ?? ''} ${attrs.appid ?? ''} ${rootAttrs?.serviceID ?? ''}`.toLowerCase();
  if (/bilibili\.com|b23\.tv/.test(hay)) return 'video';
  if (/music\.163\.com|y\.qq\.com|kugou|kuwo|migu|qqmusic|网易云|酷狗|酷我|咪咕/.test(hay)) return 'music';
  if (/\bvideo\b|视频|番剧|直播/.test(hay)) return 'video';
  return 'article';
}

/**
 * 解析 `json` 段的 data（可能是字符串也可能是对象）。
 * @returns {{ ok:boolean, kind:string, title:string, desc:string, url:string, audioUrl:string,
 *             image:string, source:string, extra:object, note:string }}
 */
export function parseJsonCard(payload) {
  const empty = { ok: false, kind: 'card', title: '', desc: '', url: '', audioUrl: '', image: '', source: '', extra: {}, note: '' };
  let root = payload;
  if (typeof root === 'string') {
    const s = root.trim();
    if (!s) return { ...empty, note: '卡片内容为空' };
    try {
      root = JSON.parse(s);
    } catch {
      return { ...empty, note: '卡片 JSON 解析失败' };
    }
  }
  if (!root || typeof root !== 'object') return { ...empty, note: '卡片内容不是对象' };
  // 有些实现多包了一层 { data: "..." }
  if (typeof root.data === 'string' && root.data.trim().startsWith('{')) {
    try {
      const inner = JSON.parse(root.data);
      if (inner && typeof inner === 'object') root = inner;
    } catch {}
  }

  const node = pickMeta(root.meta);
  const kind = classify(root.app, root.view, node, root);
  const title = firstString(node?.title, root.prompt, root.desc);
  const desc = firstString(node?.desc, node?.summary, root.desc);
  const url = pickCardUrl(node, root);
  const audioUrl = firstString(node?.musicUrl, node?.audio, node?.voiceUrl);
  const image = firstString(node?.preview, node?.picUrl, node?.imageUrl, node?.thumbUrl);
  const source = firstString(node?.tag, root.app, root.view);

  // 剥掉 QQ 分享链接里的跟踪参数前先留原样 —— 有些卡片（B 站）就靠 jumpUrl 里的
  // 短链/带参 URL 才能定位到具体视频，清理反而会丢信息。
  return {
    ok: Boolean(title || desc || url),
    kind,
    title,
    desc,
    url,
    audioUrl,
    image,
    source,
    extra: node && typeof node === 'object' ? node : {},
    note: title || desc || url ? '' : '卡片里没有可读的标题/链接'
  };
}

/**
 * 解析 `xml` 段的 data（QQ 老式 XML 卡片 / 小程序卡片）。
 * 典型的 <msg><item><title>..</title><summary>..</summary><url>..</url></item></msg>。
 */
export function parseXmlCard(payload) {
  const empty = { ok: false, kind: 'card', title: '', desc: '', url: '', audioUrl: '', image: '', source: '', extra: {}, note: '' };
  const raw = typeof payload === 'string' ? payload.trim() : '';
  if (!raw) return { ...empty, note: '卡片内容为空' };
  if (!raw.startsWith('<')) return { ...empty, note: '不是 XML 卡片' };
  let doc = null;
  try {
    doc = XMLParser.parse(raw);
  } catch (error) {
    return { ...empty, note: `卡片 XML 解析失败：${String(errorText(error))}` };
  }
  if (!doc) return { ...empty, note: '卡片 XML 解析为空' };

  // 找一个"最像卡片正文"的节点：优先 <item>，其次任何带 title/summary/url 属性的节点。
  // 注意 QQ 的卡片两种写法都有：老式把内容放子元素文本里（<item><title>..</title></item>），
  // 新式直接堆在属性上（<item title=".." summary=".." url=".."/>）。两种都要吃。
  const itemNode = XMLParser.find(doc, 'item');
  let best = itemNode;
  if (!best) {
    const stack = [doc];
    while (stack.length) {
      const n = stack.shift();
      if (!n || typeof n !== 'object') continue;
      if (firstString(n.attrs?.title, n.attrs?.summary, n.attrs?.url, n.attrs?.brief)) { best = n; break; }
      for (const child of n.children ?? []) stack.push(child);
    }
  }
  const attrs = best?.attrs ?? {};
  // 同名子元素可能出现在 <item> 下，也可能出现在根下（<msg> 直挂）
  const childText = (name) => {
    for (const holder of [best, doc]) {
      const hit = (holder?.children ?? []).find((c) => String(c?.name ?? '').toLowerCase() === name);
      const v = firstString(hit?.text, XMLParser.text(hit));
      if (v) return v;
    }
    return '';
  };
  const title = firstString(attrs.title, childText('title'), doc.attrs?.brief, doc.attrs?.title);
  const desc = firstString(attrs.summary, attrs.desc, childText('summary'), childText('desc'));
  // 同样按「内容站优先」挑链接：XML 卡里 attrs.url 也常是 QQ 中转页，
  // 真链接藏在 qqdocurl / url 子元素里。
  const url = pickBestUrl([attrs.qqdocurl, attrs.url, childText('qqdocurl'), childText('url'), doc.attrs?.url]);
  const image = firstString(attrs.picture, attrs.cover, childText('picture'), childText('cover'));
  const rawSource = firstString(attrs.source, attrs.servicetype, doc.attrs?.serviceName);
  // 纯数字的 serviceID/servicetype 对模型毫无意义（"[卡片·1]"），不如不给
  const source = /^\d+$/.test(rawSource) ? '' : rawSource;

  const kind = classifyXml(attrs, doc.attrs, { title, desc, url, image, source });
  return {
    ok: Boolean(title || desc || url),
    kind,
    title,
    desc,
    url,
    audioUrl: firstString(attrs.musicurl, childText('musicurl')),
    image,
    source,
    extra: attrs,
    note: title || desc || url ? '' : '卡片 XML 里没有可读的标题/链接'
  };
}

/** 统一入口：按段类型选解析器。 */
export function parseCardSegment(seg) {
  const type = String(seg?.type ?? '');
  const data = seg?.data ?? {};
  if (type === 'json') return parseJsonCard(data.data ?? data.text ?? data);
  if (type === 'xml') return parseXmlCard(data.data ?? data.text);
  return { ok: false, kind: 'card', title: '', desc: '', url: '', audioUrl: '', image: '', source: '', extra: {}, note: '不是卡片段' };
}

/**
 * 把卡片渲染成给模型看的一行摘要（会写进消息文本）。
 * 例：`[卡片·网易云音乐] 雨爱 (司凤版) — 阿成哥/霓虹兔`
 */
export function describeCard(card) {
  if (!card?.ok) return '[卡片消息]';
  const bits = [];
  if (card.kind === 'music') bits.push('音乐');
  else if (card.kind === 'video') bits.push('视频');
  else if (card.kind === 'article') bits.push('图文');
  const label = card.source && !/^com\./.test(card.source) ? card.source : '';
  const head = `[卡片${label ? `·${label}` : bits.length ? `·${bits[0]}` : ''}]`;
  const body = [card.title, card.desc && card.desc !== card.title ? card.desc : ''].filter(Boolean).join(' — ');
  return body ? `${head} ${body}` : head;
}

/** 卡片是不是「音乐」类（决定要不要顺带去取歌词/音频信息）。 */
export function isMusicCard(card) {
  return Boolean(card?.ok && card.kind === 'music');
}

/** 从卡片里认出 B 站视频标识（BV 号 / av 号 / 短链）。 */
export function bilibiliIdFromCard(card) {
  if (!card?.ok) return '';
  // extra 里的 qqdocurl 必须一起扫：QQ 小程序卡片（com.tencent.miniapp_01）的
  // `url` 是 m.q.qq.com 中转页，真链接（b23.tv）只在 qqdocurl 里。
  const hay = `${card.url} ${card.extra?.jumpUrl ?? ''} ${card.extra?.qqdocurl ?? ''} ${card.extra?.url ?? ''} ${card.title}`;
  const bv = /\b(BV[0-9A-Za-z]{10})\b/.exec(hay);
  if (bv) return bv[1];
  const av = /\bav(\d{1,12})\b/i.exec(hay);
  if (av) return `av${av[1]}`;
  const short = /https?:\/\/b23\.tv\/[0-9A-Za-z]+/.exec(hay);
  if (short) return short[0];
  return '';
}

/** 从卡片里认出网易云歌曲 id。 */
export function neteaseSongIdFromCard(card) {
  if (!card?.ok) return '';
  const hay = `${card.url} ${card.audioUrl} ${card.extra?.qqdocurl ?? ''} ${card.extra?.jumpUrl ?? ''}`;
  const m = /[?&]id=(\d{1,15})/.exec(hay);
  return m ? m[1] : '';
}
