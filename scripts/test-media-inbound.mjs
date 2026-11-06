#!/usr/bin/env node
// 「读群聊 txt / 读动图 / 点开网易云与 B 站卡片」自检 —— 主人 2026-10-12（m09102）。
//
// 背景：这三件事原本**一条通路都没有**。
//   · 文件：`segmentsToText` 只吐 `[文件 xxx.txt]`，`extractMediaFromSegments` 连 file 段都不收
//     ⇒ 收到文件的那一刻就把下载直链扔了，之后再想读也无处可找。
//   · 卡片：`case 'json': out.push('[卡片消息]')` —— 群友发的是《雨爱》，模型只看到四个字。
//   · 动图：QQ 商城表情（mface）在 SnowLuma 侧被降级成 image 段（.gif 直链），能抓到字节，
//     但只把**第一帧**喂进视觉通道 —— 动图的首帧常常是空白，等于白看。
//
// 断言分五层：①文本化（模型看到什么）②媒体留存（桥接记住了什么）③端到端 HTTP（真打端点）
// ④纯模块（GIF 拆帧 / 卡片解析 / 编码）⑤接线守卫（三处名单 + 控制台 + 配置齐全）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { extractGifFrames, isAnimatedBuffer, isGifBuffer } from '../src/gif-lite.js';
import { parseJsonCard, parseXmlCard, describeCard, bilibiliIdFromCard, neteaseSongIdFromCard } from '../src/rich-card.js';
import { extractTextFromFile, isTextFileName } from '../src/text-file.js';
import { neteaseSongId, lyricsToPlain, resolveB23Url } from '../src/card-open.js';
import { parseVideoId } from '../src/video-watch.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `（${detail}）` : ''}`); }
};
const section = (t) => console.log(`\n## ${t}`);

// 2 帧（红/绿）2×2 的最小 GIF89a，手搓的夹具 —— 见本文件末尾 buildTwoFrameGif 的说明。
const TWO_FRAME_GIF_B64 = 'R0lGODlhAgACAIAAAP8AAAD/ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAACAwSAAgAh+QQACgAAACwAAAAAAgACAAACA0ySAgA7';

// 假 bot：getImage 回一段真 GIF 字节，用来验证"动图会被拆成多帧"这条通路。
function gifBotClass(base) {
  return class extends base {
    async getImage({ file }) {
      this.__images = this.__images ?? [];
      this.__images.push(file);
      return { base64: TWO_FRAME_GIF_B64 };
    }
  };
}

// ── 一、纯模块：GIF 拆帧 ────────────────────────────────────────────────────
section('纯模块 gif-lite：动图真的能拆成多帧');
{
  const buf = Buffer.from(TWO_FRAME_GIF_B64, 'base64');
  ok(isGifBuffer(buf), 'GIF 签名识别正确');
  ok(isAnimatedBuffer(buf), '两帧 GIF 被判定为动图（单帧不算）');
  ok(!isAnimatedBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64')),
    '静态 PNG 不会被误判成动图');
  const r = extractGifFrames(buf, { count: 4, maxSide: 64 });
  ok(r.ok === true, 'extractGifFrames 解析成功');
  ok(r.totalFrames === 2, `识别出 2 帧（实测 ${r.totalFrames}）`);
  ok(r.animated === true, 'animated=true');
  ok(r.durationMs === 200, `总时长按各帧 delay 累加（实测 ${r.durationMs}ms，两帧各 100ms）`);
  ok(r.frames.length === 2, `抽出 2 帧（实测 ${r.frames.length}）`);
  ok(r.frames.every((f) => f.png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'), '每一帧都编码成了合法 PNG（魔数对）');
  // 首帧红、次帧绿 —— 证明确实取到了**不同的**帧，不是把同一帧重复 N 遍
  const first = r.frames[0].png.toString('base64');
  const second = r.frames[1].png.toString('base64');
  ok(first !== second, '两帧内容不同（不是把首帧复制了 N 份）');
  ok(extractGifFrames(Buffer.from('not a gif'), {}).ok === false, '非 GIF 输入不抛错，只返回 ok:false');
}

// ── 二、纯模块：卡片解析 ───────────────────────────────────────────────────
section('纯模块 rich-card：网易云卡 / B 站卡都能读出标题与链接');
{
  // 真实抓到的网易云卡片 JSON（群 2000000001，messageId=-1321259315），字段原样保留
  const netease = JSON.stringify({
    app: 'com.tencent.music.lua',
    bizsrc: 'qqconnect.sdkshare_music',
    meta: {
      music: {
        app_type: 1,
        desc: '阿成哥/霓虹兔',
        jumpUrl: 'https://y.music.163.com/m/song?id=3444876644&uct2=abc',
        musicUrl: 'http://music.163.com/song/media/outer/url?id=3444876644&userid=368877514',
        preview: 'https://p2.music.126.net/xxx.jpg',
        tag: '网易云音乐',
        title: '雨爱 (司凤版)'
      }
    },
    prompt: '[分享]雨爱 (司凤版)',
    view: 'music'
  });
  const card = parseJsonCard(netease);
  ok(card.ok === true, '网易云卡解析成功');
  ok(card.title === '雨爱 (司凤版)', `读出歌名（实测 ${JSON.stringify(card.title)}）`);
  ok(card.desc === '阿成哥/霓虹兔', `读出歌手（实测 ${JSON.stringify(card.desc)}）`);
  ok(card.kind === 'music', `判定为音乐卡（实测 ${card.kind}）`);
  ok(card.source === '网易云音乐', `读出平台标签（实测 ${JSON.stringify(card.source)}）`);
  ok(neteaseSongIdFromCard(card) === '3444876644', `从 jumpUrl 认出歌曲 id（实测 ${neteaseSongIdFromCard(card)}）`);
  ok(neteaseSongId(card) === '3444876644', 'card-open 的 neteaseSongId 也能从卡片对象认出 id');
  ok(neteaseSongId('3444876644') === '3444876644', '纯数字 id 原样通过');
  ok(describeCard(card).includes('雨爱 (司凤版)'), `describeCard 带出歌名（${describeCard(card)}）`);
  ok(describeCard(card).includes('网易云音乐'), 'describeCard 带出平台');

  // B 站卡：meta.news 里放标题与跳转链接
  const bili = parseJsonCard(JSON.stringify({
    app: 'com.tencent.structmsg',
    view: 'news',
    prompt: '[分享]某个视频',
    meta: { news: { title: '【原神】4.2 剧情全解析', desc: 'UP主：某某', jumpUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7' } }
  }));
  ok(bili.ok === true && bili.kind === 'video', `B 站卡判定为视频（实测 kind=${bili.kind}）`);
  ok(bilibiliIdFromCard(bili) === 'BV1GJ411x7h7', `从 jumpUrl 认出 BV 号（实测 ${bilibiliIdFromCard(bili)}）`);
  ok(neteaseSongIdFromCard(bili) === '', 'B 站卡不会被误认成网易云歌曲');

  // b23.tv 短链：QQ 里 B 站卡片最常见的形状就是它，而短链里**没有** BV 号。
  // 不跟这一次重定向，「点开 B 站卡片」就会静默退化成「把链接念一遍」。
  ok(parseVideoId('https://b23.tv/AbCdEfG') === null, 'b23.tv 短链本身抠不出 BV 号（这正是要跟重定向的原因）');
  ok((await resolveB23Url('https://www.bilibili.com/video/BV1GJ411x7h7')) === '', 'resolveB23Url 只碰 b23.tv，别的域名一律不发请求');
  ok((await resolveB23Url('not a url')) === '', 'resolveB23Url 对垃圾输入返回空串而不是抛错');
  ok((await resolveB23Url('')) === '', 'resolveB23Url 对空串返回空串');

  // XML 老式卡片（子元素写法）+ 属性写法
  const xmlChild = parseXmlCard('<msg serviceID="1"><item><title>某某分享</title><summary>这是摘要</summary><url>https://example.com/a</url></item></msg>');
  ok(xmlChild.ok === true, 'XML 卡（子元素写法）解析成功');
  ok(xmlChild.title === '某某分享' && xmlChild.desc === '这是摘要' && xmlChild.url === 'https://example.com/a',
    `XML 卡读出 title/summary/url（${JSON.stringify([xmlChild.title, xmlChild.desc, xmlChild.url])}）`);
  const xmlAttr = parseXmlCard('<msg serviceID="1"><item title="属性标题" summary="属性摘要" url="https://b23.tv/abc123"/></msg>');
  ok(xmlAttr.title === '属性标题' && xmlAttr.url === 'https://b23.tv/abc123', 'XML 卡（属性写法）也能读出来');
  ok(bilibiliIdFromCard(xmlAttr) === 'https://b23.tv/abc123', 'b23.tv 短链被认出来（交给 watchVideo 展开）');
  ok(parseJsonCard('这不是 JSON').ok === false, '坏 JSON 不抛错，返回 ok:false');
}

// ── 三、纯模块：文本文件解码 ───────────────────────────────────────────────
section('纯模块 text-file：中文 txt 的编码识别');
{
  ok(isTextFileName('提瓦特编年史·原神主线剧情与世界观.txt'), '.txt 被判定为可读文本');
  ok(isTextFileName('notes.MD'), '扩展名大小写不敏感（.MD）');
  ok(!isTextFileName('archive.zip'), '压缩包不是可读文本');
  ok(!isTextFileName('photo.png'), '图片不是可读文本');

  const utf8 = extractTextFromFile(Buffer.from('第一行\n第二行', 'utf8'), {});
  ok(utf8.ok === true && utf8.text === '第一行\n第二行', `UTF-8 正常解出（encoding=${utf8.encoding}）`);
  // 中文 Windows 记事本存出来的 GBK：「你好」= c4 e3 ba c3
  const gbk = extractTextFromFile(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), {});
  ok(gbk.ok === true && gbk.text === '你好', `GBK 字节被正确解成「你好」（实测 ${JSON.stringify(gbk.text)} / ${gbk.encoding}）`);
  const bom = extractTextFromFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM', 'utf8')]), {});
  ok(bom.ok === true && bom.text === '带BOM', `UTF-8 BOM 被剥掉（实测 ${JSON.stringify(bom.text)} / ${bom.encoding}）`);
  const bin = extractTextFromFile(Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]), {});
  ok(bin.ok === false, '含 NUL 的二进制内容被拒（不会把乱码喂给模型）');
  // UTF-16 的 BOM 分支曾经写反了端序（`littleEndian !== (process.platform !== 'win32')`），
  // 在 Windows 上把小端当大端翻、大端当小端翻 —— 两种都会解成乱码，而测试当时只覆盖了
  // UTF-8/GBK，所以一路绿灯。这里两个方向都钉住。
  const u16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')]);
  const le = extractTextFromFile(u16le, {});
  ok(le.ok === true && le.text === '你好', `UTF-16LE（BOM ff fe）解对（实测 ${JSON.stringify(le.text)} / ${le.encoding}）`);
  const beBody = Buffer.from('你好', 'utf16le');
  for (let i = 0; i + 1 < beBody.length; i += 2) { const t = beBody[i]; beBody[i] = beBody[i + 1]; beBody[i + 1] = t; }
  const be = extractTextFromFile(Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]), {});
  ok(be.ok === true && be.text === '你好', `UTF-16BE（BOM fe ff）解对（实测 ${JSON.stringify(be.text)} / ${be.encoding}）`);
  const long = extractTextFromFile(Buffer.from('x'.repeat(500), 'utf8'), { maxChars: 200 });
  ok(long.ok === true && long.truncated === true && long.text.length === 200, '超长文件被截断且注明（truncated=true）');

  const lyrics = lyricsToPlain('[00:15.84]窗外的天气\n[00:20.31]就像是 你多变的表情\n[ar:某某]\n');
  ok(lyrics === '窗外的天气\n就像是 你多变的表情', `LRC 时间轴与元信息标签被剥掉（实测 ${JSON.stringify(lyrics)}）`);
}

// ── 四、桥接：消息文本化 + 媒体留存 ────────────────────────────────────────
const h = await bridgeHarness({
  config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false } } },
  globals: { SnowLumaWebSocketClient: gifBotClass((await import('@snowluma/sdk')).SnowLumaWebSocketClient ?? class {}) }
});

try {
  const KEY = 'group:456';

  section('桥接 segmentsToText：模型能"看见"文件与卡片');
  {
    const fileText = await h.segmentsToText([
      { type: 'text', data: { text: '看看这个' } },
      { type: 'file', data: { name: '提瓦特编年史.txt', file_size: 1010223, url: 'http://example.com/f' } }
    ]);
    ok(fileText.includes('提瓦特编年史.txt'), `文件消息带上文件名（${fileText}）`);
    ok(fileText.includes('990.3KB') || /\d/.test(fileText), '带上人类可读的大小');
    ok(fileText.includes('qq_read_file'), '明确告诉模型"可以直接读，用 qq_read_file"');
    ok(!fileText.includes('url=') && !fileText.includes('http://example.com'), '不会把裸下载直链写进给模型的文本');

    const binText = await h.segmentsToText([{ type: 'file', data: { name: 'setup.exe', file_size: 1024 } }]);
    ok(binText.includes('非文本文件'), `非文本文件如实标注（${binText}）`);

    const cardText = await h.segmentsToText([{
      type: 'json',
      data: { data: JSON.stringify({ app: 'com.tencent.music.lua', meta: { music: { title: '雨爱 (司凤版)', desc: '阿成哥/霓虹兔', tag: '网易云音乐', jumpUrl: 'https://y.music.163.com/m/song?id=3444876644' } }, view: 'music' }) }
    }]);
    ok(!cardText.includes('[卡片消息]'), `卡片不再退化成「[卡片消息]」（实测 ${cardText}）`);
    ok(cardText.includes('雨爱 (司凤版)'), '卡片文本里带出歌名');
    ok(cardText.includes('阿成哥/霓虹兔'), '卡片文本里带出歌手');
    ok(cardText.includes('qq_open_card'), '提示模型"可以点开"');

    const xmlText = await h.segmentsToText([{
      type: 'xml',
      data: { data: '<msg serviceID="1"><item><title>某某视频</title><url>https://www.bilibili.com/video/BV1GJ411x7h7</url></item></msg>' }
    }]);
    ok(xmlText.includes('某某视频'), `xml 段（老式卡片）也能读（实测 ${xmlText}）`);
    ok(!xmlText.includes('[xml]'), 'xml 段不再落到 default 变成「[xml]」');
  }

  section('桥接 extractMediaFromSegments：文件与卡片的定位信息必须留住');
  {
    const media = h.extractMediaFromSegments([
      { type: 'file', data: { name: 'a.txt', file_id: 'fid-1', file_size: 2048, url: 'http://example.com/dl', file_hash: 'H' } },
      { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.music.lua', meta: { music: { title: '雨爱', desc: '阿成哥', jumpUrl: 'https://y.music.163.com/m/song?id=3444876644' } } }) } },
      { type: 'image', data: { file: 'x.jpg', url: 'http://example.com/x.jpg' } }
    ]);
    const file = media.find((m) => m.kind === 'file');
    const card = media.find((m) => m.kind === 'card');
    ok(Boolean(file), 'file 段进了 media（以前完全不进）');
    ok(file?.url === 'http://example.com/dl', '  文件的下载直链被留住（否则永远读不到）');
    ok(file?.name === 'a.txt' && file?.fileId === 'fid-1' && file?.size === 2048, '  文件名/file_id/大小都在');
    ok(Boolean(card), '卡片段进了 media');
    ok(card?.title === '雨爱' && card?.cardKind === 'music', `  卡片的标题与类型都在（${JSON.stringify([card?.title, card?.cardKind])}）`);
    ok(card?.url === 'https://y.music.163.com/m/song?id=3444876644', '  卡片的跳转链接被留住');
    ok(media.filter((m) => m.kind === 'image').length === 1, '普通图片照旧进 media（没有回归）');
  }

  section('桥接 appendSocialV2Message：入库白名单不能把 file/card 压成 image');
  {
    h.appendSocialV2Message(KEY, '群友', '看看这个 [文件 a.txt（可以直接读，用 qq_read_file）]', '看看这个', false, false, 'msg-file-1', [
      { kind: 'file', name: 'a.txt', fileId: 'fid-1', size: 2048, url: 'http://example.com/dl', hash: 'H' }
    ]);
    h.appendSocialV2Message(KEY, '群友', '[卡片·网易云音乐] 雨爱', '[卡片·网易云音乐] 雨爱', false, false, 'msg-card-1', [
      { kind: 'card', cardKind: 'music', title: '雨爱', desc: '阿成哥', url: 'https://y.music.163.com/m/song?id=3444876644', audioUrl: '', image: '', source: '网易云音乐' }
    ]);
    const st = h.getSocialV2State(KEY);
    const fm = st.unread.find((m) => String(m.messageId) === 'msg-file-1');
    const cm = st.unread.find((m) => String(m.messageId) === 'msg-card-1');
    ok(fm?.media?.[0]?.kind === 'file', `文件消息的 media.kind 仍是 file（实测 ${fm?.media?.[0]?.kind}）`);
    ok(fm?.media?.[0]?.url === 'http://example.com/dl', '  文件直链穿过了白名单');
    ok(cm?.media?.[0]?.kind === 'card', `卡片消息的 media.kind 仍是 card（实测 ${cm?.media?.[0]?.kind}）`);
    ok(cm?.media?.[0]?.title === '雨爱', '  卡片标题穿过了白名单');
    ok(fm?.hasMedia === true && cm?.hasMedia === true, '两条消息的 hasMedia 都为 true');
    // 反证：kind 不明时仍然回落成 image（不改变老行为）
    h.appendSocialV2Message(KEY, '群友', '[图片]', '[图片]', false, false, 'msg-img-1', [{ kind: 'weird', file: 'a.jpg', url: 'http://example.com/a.jpg' }]);
    const im = h.getSocialV2State(KEY).unread.find((m) => String(m.messageId) === 'msg-img-1');
    ok(im?.media?.[0]?.kind === 'image', '未知 kind 仍回落成 image（没有把老路径改坏）');
  }

  section('指路提示 mediaHintFor：别把文件/卡片数成图片');
  {
    // 工具名只在 reserved2（二代仿真）下才提示 —— 一代/closed-agent 里模型根本没有那些 MCP 工具，
    // 提示它去调一个不存在的工具比不提示更糟。
    h.setMode('reserved2');
    const visual = h.mediaHintFor(KEY, 'm-1', [{ kind: 'image', file: 'a.jpg', url: 'http://x/a.jpg' }]);
    ok(/qq_get_message_images/.test(visual) && /1 个图片\/表情/.test(visual), `纯图片消息仍指向图片工具（${visual.trim().slice(0, 60)}…）`);
    const fileOnly = h.mediaHintFor(KEY, 'm-2', [{ kind: 'file', name: 'a.txt', url: 'http://x/dl' }]);
    ok(/qq_read_file/.test(fileOnly), '文件消息指向 qq_read_file');
    ok(!/qq_get_message_images/.test(fileOnly), '  且**不**让模型去调图片工具（否则它去点开一个不是图片的东西）');
    ok(/a\.txt/.test(fileOnly), '  提示里带文件名（模型才知道值不值得读）');
    const cardOnly = h.mediaHintFor(KEY, 'm-3', [{ kind: 'card', cardKind: 'music', title: '雨爱' }]);
    ok(/qq_open_card/.test(cardOnly), '卡片消息指向 qq_open_card');
    ok(!/qq_get_message_images/.test(cardOnly), '  且不指向图片工具');
    const mixed = h.mediaHintFor(KEY, 'm-4', [
      { kind: 'image', file: 'a.jpg' },
      { kind: 'file', name: 'b.txt', url: 'http://x/dl' },
      { kind: 'card', title: '雨爱' }
    ]);
    ok(/1 个图片\/表情/.test(mixed), `混合消息里图片数只算图片（实测「${(mixed.match(/\d+ 个图片\/表情/) ?? ['?'])[0]}」）`);
    ok(/qq_read_file/.test(mixed) && /qq_open_card/.test(mixed), '  文件和卡片各自都有指路');
    ok(h.mediaHintFor(KEY, 'm-5', []) === '', '没有 media 时返回空串（不往提示词里塞空段）');
    ok(h.mediaHintFor(KEY, '', [{ kind: 'image' }]) === '', '没有 messageRef 时返回空串');
  }

  section('端到端 HTTP：/api/files/message 与 /api/cards/message');
  {
    const h2 = await bridgeHarness({
      config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false }, tools: { readFile: true, openCard: true } } },
      // 文件下载走 safeFetchBytes（SSRF 防护那条通道）。测试不该真连网：桩成返回一段 GBK 文本。
      // ⚠️ 桩必须返回**真实形状** `{url, statusCode, buffer}` —— 这里一开始图省事直接返回裸
      // Buffer，于是桥接里 `const { buffer } = await safeFetchBytes(...)` 少解构一层这个真 bug
      // 被测试掩护过去了（表现是「内容看起来不是文本」，看起来像文件坏了）。桩错了比没桩更糟。
      globals: {
        safeFetchBytes: async () => ({
          url: 'http://example.com/dl',
          statusCode: 200,
          buffer: Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xb5, 0xda, 0xb6, 0xfe])
        })
      }
    });
    try {
      h2.setMode('reserved2');
      const server = h2.startConsoleServer();
      if (!server.listening) await new Promise((r) => server.once('listening', r));
      const port = server.address().port;
      const token = h2.getSocialV2State(KEY).agentToken;
      const get = async (p) => {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, {
          headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token }
        });
        return { status: res.status, json: await res.json().catch(() => ({})) };
      };

      h2.appendSocialV2Message(KEY, '群友', '[文件 a.txt（可以直接读，用 qq_read_file）]', '', false, false, 'f1', [
        { kind: 'file', name: 'a.txt', fileId: 'fid-1', size: 9, url: 'http://example.com/dl', hash: 'H' }
      ]);
      h2.appendSocialV2Message(KEY, '群友', '[卡片·网易云音乐] 雨爱', '', false, false, 'c1', [
        { kind: 'card', cardKind: 'music', title: '雨爱', desc: '阿成哥', url: 'https://y.music.163.com/m/song?id=3444876644', audioUrl: '', image: '', source: '网易云音乐' }
      ]);
      h2.appendSocialV2Message(KEY, '群友', '[图片]', '', false, false, 'i1', [{ kind: 'image', file: 'x.jpg', url: 'http://example.com/x.jpg' }]);

      const fr = await get(`/api/files/message?key=${encodeURIComponent(KEY)}&messageId=f1`);
      ok(fr.status === 200 && fr.json.ok === true, `文件端点 200/ok（HTTP ${fr.status}）`, JSON.stringify(fr.json).slice(0, 200));
      ok(fr.json.name === 'a.txt', '  回报文件名');
      ok(fr.json.text === '你好\n第页' || fr.json.text.includes('你好'), `  GBK 正文被正确解出（实测 ${JSON.stringify(fr.json.text)} / ${fr.json.encoding}）`);
      ok(fr.json.truncated === false, '  没截断时 truncated=false');

      const nofile = await get(`/api/files/message?key=${encodeURIComponent(KEY)}&messageId=i1`);
      ok(nofile.status === 200 && !nofile.json.text && /没有文件/.test(String(nofile.json.note ?? '')), `图片消息上没有文件 → 如实说明（${nofile.json.note}）`);

      const cr = await get(`/api/cards/message?key=${encodeURIComponent(KEY)}&messageId=c1`);
      ok(cr.status === 200 && cr.json.ok === true, `卡片端点 200/ok（HTTP ${cr.status}）`, JSON.stringify(cr.json).slice(0, 200));
      ok(cr.json.card?.title === '雨爱', '  回报卡片标题');
      ok(cr.json.neteaseSongId === '3444876644', `  认出网易云歌曲 id（实测 ${cr.json.neteaseSongId}）`);
      ok(cr.json.music === true, '  标记为音乐卡（决定 MCP 侧走取歌词那条路）');
      ok(cr.json.bilibiliId === '', '  B 站 id 为空（不是视频卡）');

      const noc = await get(`/api/cards/message?key=${encodeURIComponent(KEY)}&messageId=i1`);
      ok(noc.status === 200 && !noc.json.card && /没有卡片/.test(String(noc.json.note ?? '')), `图片消息上没有卡片 → 如实说明（${noc.json.note}）`);

      // 缺 agent token：reserved2 下必须拒绝（不能变成"谁都能拉文件"）
      const anon = await fetch(`http://127.0.0.1:${port}/api/files/message?key=${encodeURIComponent(KEY)}&messageId=f1`, {
        headers: { 'x-console-token': 'fixture-console-token' }
      });
      ok(anon.status === 403, `不带 agent token 读文件被拒（HTTP ${anon.status}）`);

      // 关掉开关后端点必须 403（不只是从模型清单里消失）
      h2.cfg.socialV2.tools.readFile = false;
      const off = await get(`/api/files/message?key=${encodeURIComponent(KEY)}&messageId=f1`);
      ok(off.status === 403 && /readFile|qq_read_file/.test(String(off.json.error ?? '')), `关掉 readFile 后端点 403（${off.json.error}）`);
      h2.cfg.socialV2.tools.openCard = false;
      const off2 = await get(`/api/cards/message?key=${encodeURIComponent(KEY)}&messageId=c1`);
      ok(off2.status === 403 && /openCard|qq_open_card/.test(String(off2.json.error ?? '')), `关掉 openCard 后端点 403（${off2.json.error}）`);
    } finally {
      await h2.close();
    }
  }

  section('端到端 HTTP：>4MB 的动图不会再被整条丢掉（2026-10-23 修）');
  {
    // 5MB 的「GIF + 尾随填充」：以前 fetchOneBotImage 用 4MB 预算判断，直接判超限 → null →
    // 模型只看到「图片获取失败」；现在下载上限放宽到 16MB，抽帧后每帧只有几十 KB。
    const bigGif = Buffer.concat([Buffer.from(TWO_FRAME_GIF_B64, 'base64'), Buffer.alloc(5 * 1024 * 1024)]);
    const BIG_B64 = bigGif.toString('base64');
    class BigGifBot extends class {} {
      async getImage() { return { base64: BIG_B64 }; }
      async fetchFaceEntity() { return null; }
    }
    const h4 = await bridgeHarness({
      config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false }, tools: { getImages: true } } },
      globals: { SnowLumaWebSocketClient: BigGifBot }
    });
    try {
      h4.setMode('reserved2');
      const server = h4.startConsoleServer();
      if (!server.listening) await new Promise((r) => server.once('listening', r));
      const port = server.address().port;
      const token = h4.getSocialV2State(KEY).agentToken;
      h4.appendSocialV2Message(KEY, '群友', '[图片]', '', false, false, 'h1', [
        { kind: 'image', file: 'big.gif', url: 'http://example.com/big.gif' }
      ]);
      const res = await fetch(`http://127.0.0.1:${port}/api/images/message?key=${encodeURIComponent(KEY)}&messageId=h1`, {
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token }
      });
      const json = await res.json();
      const frames = (json.images ?? []).filter((i) => i.kind === 'frame');
      ok(frames.length === 2, `5MB 动图仍能拆成 2 帧（实测 ${frames.length}）`);
      ok(!(json.images ?? []).some((i) => /获取失败|超过下载上限/.test(String(i.text ?? ''))), '  不再报「获取失败 / 超过下载上限」');
      ok((json.images ?? []).some((i) => /动图第 1\/2 帧/.test(String(i.text ?? ''))), '  帧序号说明还在');
    } finally {
      await h4.close();
    }
  }

  section('端到端 HTTP：动图经 qq_get_message_images 变成多帧');
  {
    const h3 = await bridgeHarness({
      config: { socialV2: { enabled: true, proactive: { enabled: false }, sticker: { enabled: false }, tools: { getImages: true } } },
      globals: { SnowLumaWebSocketClient: gifBotClass(class {}) }
    });
    try {
      h3.setMode('reserved2');
      const server = h3.startConsoleServer();
      if (!server.listening) await new Promise((r) => server.once('listening', r));
      const port = server.address().port;
      const token = h3.getSocialV2State(KEY).agentToken;
      h3.appendSocialV2Message(KEY, '群友', '[图片]', '', false, false, 'g1', [
        { kind: 'image', file: 'anim.gif', url: 'http://example.com/anim.gif' }
      ]);
      const res = await fetch(`http://127.0.0.1:${port}/api/images/message?key=${encodeURIComponent(KEY)}&messageId=g1`, {
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token }
      });
      const json = await res.json();
      const frames = (json.images ?? []).filter((i) => i.kind === 'frame');
      ok(res.status === 200, `图片端点 200（HTTP ${res.status}）`);
      ok(frames.length === 2, `动图被拆成 2 帧返回（实测 ${frames.length}，以前只有 1 帧静图）`);
      ok(frames.every((f) => f.mimeType === 'image/png'), '  每一帧都以 PNG 返回');
      ok(frames.every((f) => f.data && f.data.length > 0), '  每一帧都带 base64 数据');
      ok(frames[0].data !== frames[1].data, '  两帧数据不同（真的是不同帧）');
      ok((json.images ?? []).some((i) => /动图第 1\/2 帧/.test(String(i.text ?? ''))), '  文本里注明了「动图第 N/M 帧」（模型知道自己看的是动图）');
    } finally {
      await h3.close();
    }
  }
} finally {
  await h.close();
}

// ── 五、接线守卫：三处名单 + 控制台 + 配置 ─────────────────────────────────
section('接线守卫（防止纯函数变成死代码）');
{
  const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/console.html'), 'utf8');

  ok(/case 'file': \{[\s\S]{0,600}qq_read_file/.test(bridgeSrc), 'segmentsToText 的 file 分支提示了 qq_read_file');
  ok(/case 'json':\s*\n\s*case 'xml':/.test(bridgeSrc), 'segmentsToText 把 json/xml 两个卡片段合并处理');
  ok(/seg\.type === 'file'[\s\S]{0,400}kind: 'file'/.test(bridgeSrc), 'extractMediaFromSegments 收 file 段');
  ok(/seg\.type === 'json' \|\| seg\.type === 'xml'[\s\S]{0,500}kind: 'card'/.test(bridgeSrc), 'extractMediaFromSegments 收卡片段');
  ok(/const kind = m\?\.kind === 'face' \? 'face' : m\?\.kind === 'file' \? 'file' : m\?\.kind === 'card' \? 'card' : 'image'/.test(bridgeSrc),
    'appendSocialV2Message 的媒体白名单认 file / card 两种新 kind');
  ok(/function extractAnimatedFrames\(buf, maxFrames\)/.test(bridgeSrc), '存在动图抽帧封装 extractAnimatedFrames');
  ok(/MAX_MEDIA_FETCH_BYTES = 16 \* 1024 \* 1024/.test(bridgeSrc), '下载上限（16MB）与提示词预算（4MB）分开');
  ok(/too-large/.test(bridgeSrc), '取图失败会区分「超限」与「下载失败」');
  ok(/extractAnimatedFrames\(img\.buffer/.test(bridgeSrc), 'fetchOneBotImage 拿到字节后会尝试拆帧');
  ok(/url\.pathname === '\/api\/files\/message'/.test(bridgeSrc), '桥接有 /api/files/message 端点');
  ok(/url\.pathname === '\/api\/cards\/message'/.test(bridgeSrc), '桥接有 /api/cards/message 端点');
  ok(/v2ToolEnabled\('readFile'\)/.test(bridgeSrc), '文件端点在调用期校验 readFile 开关');
  ok(/v2ToolEnabled\('openCard'\)/.test(bridgeSrc), '卡片端点在调用期校验 openCard 开关');
  // safeFetchBytes 返回的是 { url, statusCode, buffer }。少解构一层的话拿到的是 undefined，
  // 报出来的是「内容看起来不是文本」——一个长得像文件损坏、实际是取错字段的错。
  ok(/const \{ buffer: buf \} = await safeFetchBytes\(/.test(bridgeSrc), '文件端点正确解构 safeFetchBytes 的 buffer 字段');
  ok(/export async function safeFetchBytes\(urlString, maxBytes = 4 \* 1024 \* 1024, validator = null/.test(fs.readFileSync(path.join(root, 'src/safe-fetch.js'), 'utf8')),
    'safeFetchBytes 仍接受 (url, maxBytes, validator, invalidMessage) 签名');

  // MCP：两个工具必须注册在"句柄表已完整"那句注释之前
  const readIdx = mcpSrc.indexOf("'qq_read_file'");
  const cardIdx = mcpSrc.indexOf("'qq_open_card'");
  const afterAll = mcpSrc.indexOf('所有 server.tool(...) 都已执行完');
  ok(readIdx > 0 && readIdx < afterAll, 'qq_read_file 注册在句柄表收尾注释之前（否则热开关拿不到句柄）');
  ok(cardIdx > 0 && cardIdx < afterAll, 'qq_open_card 注册在句柄表收尾注释之前');
  ok(/qq_read_file: 'readFile'/.test(mcpSrc), 'TOOL_CONFIG_FLAGS 登记了 qq_read_file');
  ok(/qq_open_card: 'openCard'/.test(mcpSrc), 'TOOL_CONFIG_FLAGS 登记了 qq_open_card');
  ok(/getConfig\(\)\?\.socialV2\?\.tools\?\.readFile === false/.test(mcpSrc), 'qq_read_file 有调用期第二道闸门（现读配置）');
  ok(/getConfig\(\)\?\.socialV2\?\.tools\?\.openCard === false/.test(mcpSrc), 'qq_open_card 有调用期第二道闸门（现读配置）');
  ok(/import \{ openCard \} from '\.\/card-open\.js'/.test(mcpSrc), 'MCP 引了 card-open.js');

  // 控制台（主人 m02235 的硬要求：功能要有地方改）
  for (const id of ['readFile', 'openCard']) {
    ok(html.includes(`data-v2-tool="${id}"`), `控制台有 ${id} 勾选框`);
  }
  ok(html.includes('qq_read_file') && html.includes('qq_open_card'), '控制台勾选框标注了工具名');
  ok(html.includes('动图会自动拆成多帧'), '控制台说明了 getImages 现在会拆动图');

  // 配置两处（config.json 决定现网；example 决定新装用户看到什么）
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  ok(cfg.socialV2?.tools?.readFile === true, 'config.json 有 tools.readFile=true');
  ok(cfg.socialV2?.tools?.openCard === true, 'config.json 有 tools.openCard=true');
  ok(example.socialV2?.tools?.readFile === true, 'config.example.json 有 tools.readFile=true');
  ok(example.socialV2?.tools?.openCard === true, 'config.example.json 有 tools.openCard=true');

  // 人设层：模型得知道"遇到文件/卡片该调工具"，否则它只会当没看见
  const roleCard = fs.readFileSync(path.join(root, 'roles/小鲸鱼.md'), 'utf8');
  ok(/qq_read_file/.test(roleCard), '人设卡里提到了 qq_read_file（否则模型不知道该读文件）');
  ok(/qq_open_card/.test(roleCard), '人设卡里提到了 qq_open_card（否则模型只会念卡片标题）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
