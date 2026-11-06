// QQ 音乐卡片段构造（OneBot v11 music 段）。
//
// 为什么单独一个模块：music 段是唯一一个**会由网关再发一次外部请求**的消息段——
// SnowLuma 收到 `{type:'music', data:{type,id}}` 后会把 `{type,id}` POST 到它配置里的
// `musicSignUrl`（默认 `https://ss.xingzhige.com/music_card/card`，第三方签名服务）换取
// QQ 能认的卡片 JSON；失败才退化成普通 JSON 卡片。也就是说：**发一张平台音乐卡片＝把这条
// 点歌信息交给一个第三方域名**。这件事必须显式暴露给调用方（`warnings` 里的
// `third-party-sign`），而不是藏在发送逻辑里。
//
// 另外，网关侧对字段的要求（见 D:\qq-bot\snowluma\index.mjs:4195-4242）是：
//   - `data.type` 必须是非空字符串；
//   - 自定义卡片（`type:'custom'` 或"没有 id 但有自定义字段"）必须给 `url` + `audio` + `title`；
//   - 平台卡片否则必须有 `id`。
// 这里在桥接侧先做一遍同样的校验 + 更严的 scheme/长度限制：错误在本地就能给出人话，
// 不用等网关抛 MessageElementValidationError。

/** 常见的平台卡 `type` 取值（网关只要求非空字符串，这里给出白名单便于纠错）。 */
export const MUSIC_PLATFORMS = Object.freeze(['qq', '163', 'kugou', 'kuwo', 'migu', 'bilibili']);

/** `data.type` 上限（网关不限，这里防超长 JSON 灌进消息段）。 */
export const MUSIC_MAX_TYPE_CHARS = 16;

/** 标题上限：卡片只显示一行，太长会被 QQ 截断还占 token。 */
export const MUSIC_MAX_TITLE_CHARS = 60;

/** `data.id` 上限。 */
export const MUSIC_MAX_ID_CHARS = 32;

const HTTP_RE = /^https?:\/\//i;
const trim = (v) => String(v ?? '').trim();
const isHttp = (v) => HTTP_RE.test(trim(v));

/**
 * 构造一个 music 消息段。
 *
 * @param {object} input
 *   - 平台卡：`{ type:'163'|'qq'|'kugou'|'kuwo'|'migu'|'bilibili', id:'<歌曲 id>' }`
 *   - 自定义卡：`{ type:'custom', url, audio, title, image?, singer? }`
 *     （`type` 是**必填**：网关侧 `requireNonEmptyStringField(..., "type")` 直接拒空，
 *      见 D:\qq-bot\snowluma\index.mjs:4196；给了 url/audio/title 但没有 id 时按自定义卡处理，
 *      与网关的 `usesCustomMusicData` 判定一致。）
 *   - 可选 `allowThirdPartySign`：平台卡会经第三方签名，默认 true；显式传 false 时平台卡被拒
 *     （想完全避免第三方就不该发平台卡，应改用自定义卡）。
 * @returns {{ok:true, segment:object, kind:'platform'|'custom', warnings:string[], thirdPartySign:boolean}
 *          | {ok:false, error:string}}
 */
export function buildMusicSegment(input = {}) {
  const type = trim(input.type).toLowerCase();
  const id = trim(input.id);
  const url = trim(input.url);
  const audio = trim(input.audio);
  const title = trim(input.title).replace(/[\r\n]+/g, ' ');
  const image = trim(input.image);
  const singer = trim(input.singer ?? input.content);

  // 判定与网关一致：type==='custom'，或「没有 id 但给了自定义字段」→ 自定义卡。
  const hasCustomField = Boolean(url || audio || title || image || singer);
  const usesCustom = type === 'custom' || (!id && hasCustomField);

  if (!type) {
    return { ok: false, error: 'music 段缺少 type（平台卡写 163/qq/kugou/kuwo/migu/bilibili，自定义卡写 custom）' };
  }
  if (type.length > MUSIC_MAX_TYPE_CHARS) {
    return { ok: false, error: `music 的 type 太长（${type.length} > ${MUSIC_MAX_TYPE_CHARS}）` };
  }
  if (type !== 'custom' && MUSIC_PLATFORMS.length && !MUSIC_PLATFORMS.includes(type) && !id) {
    // 未知平台且没给 id：一定是漏填，直接纠错而不是让它去猜。
    return { ok: false, error: `不认识的点歌平台：${type}（可用：${MUSIC_PLATFORMS.join('、')}，或 type:'custom' 给 url/audio/title）` };
  }

  const warnings = [];

  if (usesCustom) {
    if (!url || !audio || !title) {
      return { ok: false, error: '自定义音乐卡片必须同时给 url（卡片跳转）、audio（音频直链）和 title' };
    }
    for (const [label, value] of [['url', url], ['audio', audio], ['image', image]]) {
      if (value && !isHttp(value)) {
        return { ok: false, error: `${label} 必须是 http(s) 链接（收到：${value.slice(0, 40)}）` };
      }
    }
    if (title.length > MUSIC_MAX_TITLE_CHARS) {
      return { ok: false, error: `title 太长（${title.length} > ${MUSIC_MAX_TITLE_CHARS}）` };
    }
    if (!singer) warnings.push('no-singer');
    const data = { type: 'custom', url, audio, title };
    if (image) data.image = image;
    if (singer) data.content = singer; // 网关把 data.content 当歌手名
    return { ok: true, kind: 'custom', segment: { type: 'music', data }, warnings, thirdPartySign: false };
  }

  // 平台卡
  if (!id) return { ok: false, error: `平台音乐卡片必须给 id（例如 { type:'163', id:'1234567' }）` };
  if (id.length > MUSIC_MAX_ID_CHARS) {
    return { ok: false, error: `id 太长（${id.length} > ${MUSIC_MAX_ID_CHARS}）` };
  }
  if (input.allowThirdPartySign === false) {
    return { ok: false, error: '平台音乐卡片需要第三方签名服务（默认 https://ss.xingzhige.com/music_card/card），当前配置禁止；要避免第三方请改用 type:\'custom\' 的自定义卡片' };
  }
  warnings.push('third-party-sign');
  if (title && title.length > MUSIC_MAX_TITLE_CHARS) {
    return { ok: false, error: `title 太长（${title.length} > ${MUSIC_MAX_TITLE_CHARS}）` };
  }
  const data = { type, id };
  // title/singer 平台卡用不上（由签名服务按 id 查回真实信息），给了就提示一声别误会。
  if (title || singer || image || url || audio) warnings.push('platform-card-ignores-extra-fields');
  return { ok: true, kind: 'platform', segment: { type: 'music', data }, warnings, thirdPartySign: true };
}

/** 给日志/活动流用的一句话描述（别把整段 JSON 写进日志）。 */
export function describeMusicSegment(segment) {
  const s = segment && segment.type === 'music' ? segment : null;
  if (!s) return '非 music 段';
  const d = s.data ?? {};
  if (String(d.type) === 'custom') return `自定义音乐卡「${String(d.title ?? '').slice(0, 30)}」`;
  return `平台音乐卡 ${d.type}:${d.id}`;
}

export default buildMusicSegment;
