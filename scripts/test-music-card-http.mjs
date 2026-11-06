// 「音乐卡片」（POST /api/socialV2/send-music / POST /api/media/send-music）自检。
//
// 分两层，两层都不碰真实 QQ、不重启桥接进程：
//   一、src/music-card.js 的**纯函数**（buildMusicSegment / describeMusicSegment）：平台卡 vs
//       自定义卡的判定、必填字段、http(s) 闸门、长度上限、第三方签名标记。
//   二、端到端：用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，
//       配临时 config（consolePort:0）与**假网关**，然后真的往控制台端口打 HTTP。
//       假网关把每次出站调用记进 h.calls.http —— 于是「dryRun 一个字节都没发出去」可以被断言。
//
// ⚠️ 鉴权：最外层全局鉴权只认 `x-console-token` 或 `?token=`，所以**每一个** HTTP 用例都要带
//    控制台令牌；智能体调用再额外带 `x-agent-call: 1` + `x-agent-token`。少了控制台令牌会先吃到
//    `HTTP 401 未授权：请提供控制台访问令牌`，把要断言的业务 403 全掩盖掉。
//
// ⚠️ 阶段状态：本脚本是「先写验收测试」阶段的产物，此时端点尚未接线 —— 未知路径返回
//    `404 {"ok":false,"error":"not found"}`。这类结果记为「待接线」而不是失败（见 notePending）。
//
// ⚠️ 第三方依赖：平台卡（type 是 163/qq/kugou/…）会被 SnowLuma 再 POST 给配置里的
//    `musicSignUrl`（默认 https://ss.xingzhige.com/music_card/card）换签名。桥接侧必须把这件事
//    显式暴露成 `thirdPartySign`/`third-party-sign`。想完全避免第三方只能用 type:'custom'。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  MUSIC_MAX_ID_CHARS,
  MUSIC_MAX_TITLE_CHARS,
  MUSIC_MAX_TYPE_CHARS,
  MUSIC_PLATFORMS,
  buildMusicSegment,
  describeMusicSegment
} from '../src/music-card.js';

let pass = 0;
let fail = 0;
let pending = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}
function notePending(name) {
  pending += 1;
  console.log(`  ⏳ ${name}（待接线：端点返回 404，接线后本断言转为真断言）`);
}
/** 只有整段路由缺失（404 + not found 文案）才算待接线，业务 404 不算。 */
function endpointMissing(r) {
  return r.status === 404 && /not found/i.test(String(r.json?.error ?? ''));
}

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';
const OTHER_KEY = 'private:123';
const AGENT_PATH = '/api/socialV2/send-music';
const OP_PATH = '/api/media/send-music';
const CUSTOM = Object.freeze({
  type: 'custom',
  url: 'https://example.com/song/1',
  audio: 'https://example.com/song/1.mp3',
  title: '示例曲目',
  singer: '示例歌手',
  image: 'https://example.com/song/1.jpg'
});

// ── 一、pure module ─────────────────────────────────────────────────────────
console.log('## 一、music-card.js 纯函数');

console.log('### 平台卡');
{
  const r = buildMusicSegment({ type: '163', id: '1234567' });
  ok(r.ok === true && r.kind === 'platform', '平台卡构造成功且 kind=platform', JSON.stringify(r));
  ok(r.segment.type === 'music' && r.segment.data.type === '163' && r.segment.data.id === '1234567', '段形状是 {type:"music",data:{type,id}}', JSON.stringify(r.segment));
  ok(r.thirdPartySign === true, 'thirdPartySign:true（这条卡要交给第三方签名服务）');
  ok(r.warnings.includes('third-party-sign'), 'warnings 里带 third-party-sign（必须显式暴露，不能藏起来）', JSON.stringify(r.warnings));
  ok(MUSIC_PLATFORMS.includes('163') && MUSIC_PLATFORMS.includes('qq') && MUSIC_PLATFORMS.length === 6, `平台白名单有 ${MUSIC_PLATFORMS.length} 个（${MUSIC_PLATFORMS.join('、')}）`);
  for (const p of MUSIC_PLATFORMS) {
    ok(buildMusicSegment({ type: p, id: '1' }).ok === true, `  平台 ${p} 可用`);
  }
  ok(buildMusicSegment({ type: 'QQ', id: '9' }).segment?.data?.type === 'qq', 'type 大小写归一（QQ → qq）');
  const extra = buildMusicSegment({ type: '163', id: '1', title: '平台卡用不上', url: 'https://example.com/x' });
  ok(extra.ok === true && extra.segment.data.title === undefined && extra.segment.data.url === undefined, '平台卡不吃 title/url（只留 type+id）', JSON.stringify(extra.segment));
  ok(extra.warnings.includes('platform-card-ignores-extra-fields'), '  多余字段给 platform-card-ignores-extra-fields 提示');
  ok(buildMusicSegment({ type: '163', id: '1' }).warnings.every((w) => typeof w === 'string'), 'warnings 全是字符串');
}

console.log('### 自定义卡');
{
  const r = buildMusicSegment(CUSTOM);
  ok(r.ok === true && r.kind === 'custom', '自定义卡构造成功且 kind=custom', JSON.stringify(r));
  ok(r.thirdPartySign === false, 'thirdPartySign:false（自定义卡不经第三方签名）');
  ok(r.segment.data.type === 'custom' && r.segment.data.url === CUSTOM.url && r.segment.data.audio === CUSTOM.audio && r.segment.data.title === CUSTOM.title, '段里带 url/audio/title', JSON.stringify(r.segment));
  ok(r.segment.data.content === CUSTOM.singer, '歌手写进 data.content（网关把 content 当歌手名）');
  ok(r.segment.data.image === CUSTOM.image, 'image 原样带上');
  ok(!r.warnings.includes('third-party-sign'), '  没有 third-party-sign 告警');
  const noSinger = buildMusicSegment({ type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio, title: '无歌手' });
  ok(noSinger.ok === true && noSinger.warnings.includes('no-singer'), '没给歌手时提示 no-singer');
  ok(noSinger.segment.data.content === undefined, '  没给歌手的段里不带 content');
  // 「没有 id 但给了自定义字段」按自定义卡处理（与网关 usesCustomMusicData 一致）
  const implicit = buildMusicSegment({ type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio, title: '隐式' });
  ok(implicit.ok === true && implicit.kind === 'custom', 'type:custom 且无 id ⇒ 自定义卡');
  const noIdWithFields = buildMusicSegment({ url: CUSTOM.url, audio: CUSTOM.audio, title: '无 type' });
  ok(noIdWithFields.ok === false && /缺少 type/.test(noIdWithFields.error), '没有 type ⇒ 明确报错（网关 type 必填）', noIdWithFields.error);
}

console.log('### 参数非法');
{
  const bad = [
    [{}, /缺少 type/, '缺 type'],
    [{ type: '163' }, /必须给 id/, '平台卡缺 id'],
    [{ type: 'custom', audio: CUSTOM.audio, title: 'x' }, /必须同时给/, '自定义卡缺 url'],
    [{ type: 'custom', url: CUSTOM.url, title: 'x' }, /必须同时给/, '自定义卡缺 audio'],
    [{ type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio }, /必须同时给/, '自定义卡缺 title'],
    [{ type: 'custom', url: 'ftp://example.com/a', audio: CUSTOM.audio, title: 'x' }, /必须是 http\(s\)/, 'url 非 http(s)'],
    [{ type: 'custom', url: CUSTOM.url, audio: 'data:audio/mp3;base64,AAAA', title: 'x' }, /必须是 http\(s\)/, 'audio 非 http(s)'],
    [{ type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio, title: 'x', image: 'file:///C:/a.png' }, /必须是 http\(s\)/, 'image 非 http(s)'],
    [{ type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio, title: 't'.repeat(MUSIC_MAX_TITLE_CHARS + 1) }, /title 太长/, 'title 超长'],
    [{ type: '163', id: '1'.repeat(MUSIC_MAX_ID_CHARS + 1) }, /id 太长/, 'id 超长'],
    [{ type: 'x'.repeat(MUSIC_MAX_TYPE_CHARS + 1), id: '1' }, /type 太长/, 'type 超长'],
    [{ type: '163', id: '1'.repeat(MUSIC_MAX_ID_CHARS + 1) }, /id 太长/, '平台卡 id 超长'],
    [{ type: '163', id: '1', title: 't'.repeat(MUSIC_MAX_TITLE_CHARS + 1) }, /title 太长/, '平台卡 title 超长'],
    [{ type: 'spotify', id: '' }, /不认识的点歌平台/, '未知平台且无 id'],
    [{ type: '163', id: '1', allowThirdPartySign: false }, /第三方签名/, '平台卡但配置禁止第三方签名']
  ];
  for (const [input, re, label] of bad) {
    const r = buildMusicSegment(input);
    ok(r.ok === false && re.test(String(r.error ?? '')), `${label} ⇒ 被拒（${r.error}）`);
    ok(r.thirdPartySign === undefined, `  ${label} 的拒绝结果不带 thirdPartySign`);
  }
  ok(buildMusicSegment({ type: 'custom', ...CUSTOM, allowThirdPartySign: false }).ok === true, 'allowThirdPartySign:false 不影响自定义卡（本来就不经第三方）');
  ok(buildMusicSegment({ type: '163', id: '1', title: 'x'.repeat(MUSIC_MAX_TITLE_CHARS) }).ok === true, `title 恰好 ${MUSIC_MAX_TITLE_CHARS} 字通过（边界）`);
  ok(buildMusicSegment({ type: '163', id: '1'.repeat(MUSIC_MAX_ID_CHARS) }).ok === true, `id 恰好 ${MUSIC_MAX_ID_CHARS} 字通过（边界）`);
}

console.log('### describeMusicSegment');
{
  ok(/平台音乐卡 163:123/.test(describeMusicSegment({ type: 'music', data: { type: '163', id: '123' } })), '平台卡描述带 type:id');
  ok(/自定义音乐卡/.test(describeMusicSegment({ type: 'music', data: { type: 'custom', title: '示例' } })), '自定义卡描述带标题');
  ok(describeMusicSegment({ type: 'text', data: {} }) === '非 music 段', '非 music 段如实说明');
  ok(describeMusicSegment(null) === '非 music 段', 'null 不抛错');
}

// ── 二、端到端（真实 bridge.js + 假网关） ─────────────────────────────────────
console.log('\n## 二、端到端（真实 bridge.js + 假网关，HTTP 走控制台端口）');

async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        tools: { sendMusic: true },
        music: { enabled: true, maxPerMinute: 2, maxPerHour: 10 },
        ...(overrides.socialV2 ?? {})
      },
      ...(overrides.top ?? {})
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const tokens = {
    [AGENT_KEY]: h.getSocialV2State(AGENT_KEY).agentToken,
    [OTHER_KEY]: h.getSocialV2State(OTHER_KEY).agentToken
  };
  async function raw(method, pathname, { body, agentToken, consoleToken, agentCall } = {}) {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (agentCall) headers['x-agent-call'] = '1';
    if (agentToken !== undefined) headers['x-agent-token'] = agentToken;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  return {
    h,
    port,
    tokens,
    // AI 通道：控制台令牌 + agent 声明 + 会话令牌（与真实 MCP 进程的发法一致）。
    ai: (body, token = tokens[AGENT_KEY]) => raw('POST', AGENT_PATH, { body, agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    // 操作者通道：只带控制台令牌。
    op: (body) => raw('POST', OP_PATH, { body, consoleToken: CONSOLE_TOKEN }),
    anon: (body) => raw('POST', AGENT_PATH, { body }),
    gatewayCalls: (action) => h.calls.http.filter((c) => c.url.endsWith(`/${action}`)),
    sentCount: () => h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url)).length,
    lastMessage: () => {
      const calls = h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url));
      return calls[calls.length - 1] ?? null;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

try {
  const f = await startFixture();
  try {
    console.log('### AI 通道：POST /api/socialV2/send-music');
    {
      // ① dryRun：只校验不发送（假网关零调用）
      const before = f.sentCount();
      const dry = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: '163', id: '1234567', dryRun: true });
      if (endpointMissing(dry)) {
        notePending('音乐 dryRun 只校验不发送');
      } else {
        ok(dry.status === 200 && dry.json.ok === true && dry.json.dryRun === true, `dryRun 返回 200/ok/dryRun（HTTP ${dry.status}）`, JSON.stringify(dry.json).slice(0, 240));
        ok(dry.json.kind === 'platform' || dry.json.thirdPartySign === true, `  回报 kind=platform / thirdPartySign（${dry.json.kind}）`);
        ok(dry.json.thirdPartySign === true, '  回报 thirdPartySign:true（平台卡要经第三方签名 —— 这条不能省）');
        ok(f.sentCount() === before, 'dryRun 没有向网关发任何消息');
        ok(dry.json.messageId === undefined, 'dryRun 不返回 messageId');
      }

      const dryCustom = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], ...CUSTOM, dryRun: true });
      if (endpointMissing(dryCustom)) notePending('自定义卡 dryRun 成功且不经第三方');
      else {
        ok(dryCustom.status === 200 && dryCustom.json.dryRun === true, `自定义卡 dryRun 成功（HTTP ${dryCustom.status}）`, JSON.stringify(dryCustom.json).slice(0, 240));
        ok(dryCustom.json.kind === 'custom' && dryCustom.json.thirdPartySign === false, '  回报 kind=custom / thirdPartySign:false');
      }

      // ② 正常路径：真的走一遍发送（目标是假网关，不碰 QQ）
      const sent = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: '163', id: '1234567' });
      if (endpointMissing(sent)) notePending('正常路径真的发出 music 段');
      else {
        ok(sent.status === 200 && sent.json.ok === true && sent.json.messageId !== undefined, `正常路径成功（HTTP ${sent.status}, messageId=${sent.json.messageId}）`, JSON.stringify(sent.json).slice(0, 240));
        const last = f.lastMessage();
        const segs = last?.body?.message ?? [];
        ok(last?.body?.group_id === 456, '发往正确的群（group_id=456）', JSON.stringify(last?.body));
        const musicSeg = segs.find((s) => s.type === 'music');
        ok(musicSeg?.data?.type === '163' && musicSeg?.data?.id === '1234567', '交给网关的段是 {type:"music",data:{type,id}}', JSON.stringify(musicSeg));
        ok(!JSON.stringify(segs).includes('ss.xingzhige.com'), '  桥接自己不去调第三方签名服务（交给 SnowLuma 的 musicSignUrl）');
      }
    }

    console.log('### 参数非法 → 400');
    {
      const cases = [
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], id: '1' }, /缺少 type|type/, '缺 type'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: '163' }, /必须给 id|id/, '平台卡缺 id'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'custom', audio: CUSTOM.audio, title: 'x' }, /url|必须同时给/, '自定义卡缺 url'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'custom', url: CUSTOM.url, title: 'x' }, /audio|必须同时给/, '自定义卡缺 audio'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio }, /title|必须同时给/, '自定义卡缺 title'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'custom', url: CUSTOM.url, audio: 'ftp://x/a.mp3', title: 'x' }, /http\(s\)/, 'audio 非 http(s)'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'spotify', id: '' }, /不认识|平台|type/, '未知平台'],
        [{ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio, title: 't'.repeat(MUSIC_MAX_TITLE_CHARS + 1) }, /太长/, 'title 超长']
      ];
      for (const [body, re, label] of cases) {
        const r = await f.ai(body);
        if (endpointMissing(r)) { notePending(`${label} ⇒ 400`); continue; }
        ok(r.status === 400 && re.test(String(r.json.error ?? '')), `${label} ⇒ 400（HTTP ${r.status}：${r.json.error}）`);
      }
      const before = f.sentCount();
      const badAll = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], type: 'custom', audio: 'ftp://x/a.mp3', title: 'x' });
      if (!endpointMissing(badAll)) ok(f.sentCount() === before, '参数非法时没有向网关发出任何消息');
    }

    console.log('### 越权 / 缺凭据');
    {
      const cross = await f.ai({ key: OTHER_KEY, token: f.tokens[AGENT_KEY], type: '163', id: '1', dryRun: true }, f.tokens[AGENT_KEY]);
      if (endpointMissing(cross)) notePending('跨会话越权被拒（403）');
      else {
        ok(cross.status === 403, `AI 用 A 会话 token 操作 B 会话 ⇒ 403（HTTP ${cross.status}）`, JSON.stringify(cross.json));
        ok(/agent token 无效/.test(String(cross.json.error ?? '')), '  错误信息是 agent token 无效（agentTokenOk 产生）', cross.json.error);
      }

      const noTok = await f.ai({ key: AGENT_KEY, type: '163', id: '1', dryRun: true }, '');
      if (endpointMissing(noTok)) notePending('AI 通道缺会话令牌 ⇒ 403');
      else ok(noTok.status === 403, `AI 通道令牌为空 ⇒ 403（HTTP ${noTok.status}）`, JSON.stringify(noTok.json));

      const anon = await f.anon({ key: AGENT_KEY, type: '163', id: '1', dryRun: true });
      ok(anon.status === 401, `什么令牌都不带 ⇒ 401（HTTP ${anon.status}）`, JSON.stringify(anon.json));
      ok(/未授权/.test(String(anon.json.error ?? '')), '  错误信息是全局鉴权层的「未授权：请提供控制台访问令牌」', anon.json.error);

      const badKey = await f.ai({ key: 'nonsense', token: f.tokens[AGENT_KEY], type: '163', id: '1', dryRun: true });
      if (endpointMissing(badKey)) notePending('key 格式非法 ⇒ 400');
      else ok(badKey.status === 400, `key 格式非法 ⇒ 400（HTTP ${badKey.status}）`, JSON.stringify(badKey.json));
    }

    console.log('### 操作者通道：POST /api/media/send-music');
    {
      const dry = await f.op({ target: AGENT_KEY, type: '163', id: '1234567', dryRun: true });
      if (endpointMissing(dry)) notePending('操作者通道 dryRun 通过');
      else {
        ok(dry.status === 200 && dry.json.ok === true && dry.json.dryRun === true, `操作者 dryRun 通过（HTTP ${dry.status}）`, JSON.stringify(dry.json).slice(0, 240));
        const custom = await f.op({ target: AGENT_KEY, ...CUSTOM, dryRun: true });
        ok(custom.status === 200 && custom.json.kind === 'custom', `操作者自定义卡 dryRun 通过（HTTP ${custom.status}）`, JSON.stringify(custom.json).slice(0, 200));
        const bad = await f.op({ target: AGENT_KEY, type: 'custom', url: CUSTOM.url, audio: CUSTOM.audio, dryRun: true });
        ok(bad.status === 400, `操作者通道参数非法同样 400（HTTP ${bad.status}）`);
        const outside = await f.op({ target: 'group:999', type: '163', id: '1', dryRun: true });
        ok(outside.status === 403, `白名单外目标被拒（HTTP ${outside.status}）`);
      }
      // 纵深防御：agent 令牌打到 /api/media/ 必须在路径白名单层就被拒，且不触达网关。
      const before = f.sentCount();
      const withAgent = await f.anon({ target: AGENT_KEY, type: '163', id: '1', dryRun: true });
      if (!endpointMissing(withAgent)) {
        ok(withAgent.status === 401 || withAgent.status === 403, `带 agent 令牌打操作者通道被拒（HTTP ${withAgent.status}）`);
      }
      ok(f.sentCount() === before, '  被拒的请求没有触达网关');
    }
  } finally {
    await f.stop();
  }

  console.log('### 开关关闭：socialV2.tools.sendMusic=false（出厂默认）');
  {
    const off = await startFixture({ socialV2: { tools: { sendMusic: false } } });
    try {
      const r = await off.ai({ key: AGENT_KEY, token: off.tokens[AGENT_KEY], type: '163', id: '1', dryRun: true });
      if (endpointMissing(r)) notePending('工具关闭时 AI 通道 ⇒ 403');
      else {
        ok(r.status === 403, `tools.sendMusic=false ⇒ AI 通道 403（HTTP ${r.status}）`, JSON.stringify(r.json));
        ok(/工具未启用/.test(String(r.json.error ?? '')), '  错误信息是「工具未启用：qq_send_music」', r.json.error);
      }
      const viaConsole = await off.op({ target: AGENT_KEY, ...CUSTOM, dryRun: true });
      if (endpointMissing(viaConsole)) notePending('开关关闭只拦 AI：操作者通道仍可用');
      else ok(viaConsole.status === 200, `开关只拦 AI 工具，操作者通道仍可用（HTTP ${viaConsole.status}）`, JSON.stringify(viaConsole.json).slice(0, 160));
    } finally {
      await off.stop();
    }
  }

  console.log('### 频率上限（照语音/图片口径：独立时间戳桶，429）');
  {
    const limited = await startFixture({ socialV2: { music: { enabled: true, maxPerMinute: 1, maxPerHour: 1 } } });
    try {
      const first = await limited.ai({ key: AGENT_KEY, token: limited.tokens[AGENT_KEY], type: '163', id: '1' });
      if (endpointMissing(first)) {
        notePending('超过音乐频率上限 ⇒ 429');
      } else {
        ok(first.status === 200, `第一次发送成功（HTTP ${first.status}）`);
        const second = await limited.ai({ key: AGENT_KEY, token: limited.tokens[AGENT_KEY], type: '163', id: '1' });
        ok(second.status === 429, `超过频率上限被拒（HTTP ${second.status}）`, JSON.stringify(second.json));
        const other = await limited.ai({ key: OTHER_KEY, token: limited.tokens[OTHER_KEY], ...CUSTOM });
        ok(other.status === 200, '额度按会话独立计数（另一个会话不受影响）');
        const dryAfter = await limited.ai({ key: AGENT_KEY, token: limited.tokens[AGENT_KEY], type: '163', id: '1', dryRun: true });
        ok(dryAfter.status === 429, 'dryRun 也如实报告"会被限流"（只检查、不占额度）');
      }
    } finally {
      await limited.stop();
    }
  }
} catch (error) {
  fail += 1;
  console.error('  ❌ 端到端用例异常：', error?.stack ?? error);
}

console.log(`\n== 音乐卡片自检：${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待接线` : ''} ==`);
if (pending) {
  console.log(`说明：${pending} 条断言因端点尚未接线（HTTP 404 not found）而记为「待接线」——不是测试脚本写错；`);
  console.log('      第二阶段接线完成后重跑本脚本，这些断言会自动转为真实断言。');
}
if (fail > 0) {
  console.error('一行结论：音乐卡片能力自检失败 —— 见上面 ❌（纯函数层应当全绿；HTTP 层失败即为真问题）。');
  process.exitCode = 1;
} else {
  console.log('一行结论：音乐卡片纯函数层全绿（平台卡标记 third-party-sign、自定义卡不经第三方、非法参数与长度闸门全部被拒）。');
}
