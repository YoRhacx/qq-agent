// 「发图」（qq_send_image / /api/socialV2/send-image / /api/media/send-image）自检。
//
// 分两层，两层都不碰真实 QQ：
//   一、src/send-image-lib.js 的纯函数：路径闸门、格式/体积/像素校验、URL 抓取拒绝面。
//   二、端到端：用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，
//       配一个临时 config（consolePort:0）与**假网关 fetch**，然后真的往控制台端口打 HTTP。
//       假网关会把每次出站调用记进 h.calls.http —— 于是「正常路径」也能断言到
//       真正交给 SnowLuma 的消息段，而不会发出任何一条真实 QQ 消息。
// 网络可选：公网图片 URL 的两条用例在无网环境下自动跳过，不算失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  DEFAULT_MAX_SEND_BYTES,
  HARD_MAX_SEND_BYTES,
  assertSendableImage,
  describeImage,
  fetchImageBytes,
  listImageFiles,
  mediaCfg,
  resolveImagePathForOperator,
  resolveImagePathInV2Library,
  sendImageToolEnabled,
  sniffImage
} from '../src/send-image-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}
function skipped(name, why) { skip += 1; console.log(`  ⏭️  ${name}（跳过：${why}）`); }

/** 断言某个 async 调用抛出错误且消息匹配（返回错误消息，便于打印）。 */
async function rejects(fn, pattern, name) {
  try {
    await fn();
    ok(false, name, '本应被拒绝，却成功了');
    return '';
  } catch (error) {
    const msg = String(error?.message ?? error);
    ok(pattern.test(msg), name, msg);
    return msg;
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP_1x1 = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const JPEG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

/** 造一个"魔数合法但体积/尺寸可随意指定"的 PNG 头（用来单独测体积与像素闸门）。 */
function fakePng(width, height, totalBytes = 128) {
  const head = Buffer.alloc(Math.max(24, Math.min(totalBytes, 24)), 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalBytes - head.length), 0)]);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-test-'));
const libDir = path.join(tmpRoot, 'media', 'images');
const outDir = path.join(tmpRoot, 'outside');
fs.mkdirSync(path.join(libDir, 'sub'), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(libDir, 'ok.png'), PNG_1x1);
fs.writeFileSync(path.join(libDir, 'sub', 'nested.png'), PNG_1x1);
fs.writeFileSync(path.join(libDir, 'fake.png'), Buffer.from('这其实是一段文本，只是被改名成了 .png\n'.repeat(20)));
fs.writeFileSync(path.join(libDir, 'huge.png'), fakePng(1, 1, 8000));
fs.writeFileSync(path.join(libDir, 'bomb.png'), fakePng(20000, 20000, 128));
fs.writeFileSync(path.join(libDir, 'notes.txt'), 'not an image');
fs.writeFileSync(path.join(libDir, '.hidden.png'), PNG_1x1);
fs.writeFileSync(path.join(outDir, 'secret.png'), PNG_1x1);

console.log('## 一、send-image-lib 纯函数');

console.log('### 魔数识别与尺寸');
{
  ok(sniffImage(PNG_1x1)?.format === 'png' && sniffImage(PNG_1x1)?.width === 1, 'PNG 识别（含尺寸）');
  ok(sniffImage(GIF_1x1)?.format === 'gif', 'GIF 识别');
  ok(sniffImage(JPEG_1x1)?.format === 'jpeg', 'JPEG 识别');
  ok(sniffImage(WEBP_1x1)?.format === 'webp', 'WebP 识别');
  ok(sniffImage(Buffer.from('hello, definitely not an image, padded to 32 bytes')) === null, '非图片内容返回 null');
  ok(sniffImage(Buffer.alloc(0)) === null, '空 buffer 返回 null');
  const d = describeImage({ format: 'png', bytes: 2048, width: 640, height: 480 });
  ok(/PNG/.test(d) && /2\.0 KB/.test(d) && /640x480/.test(d), `describeImage 描述可读（${d}）`);
}

console.log('### 体积 / 格式 / 像素闸门');
{
  ok(assertSendableImage(PNG_1x1, 1024 * 1024).bytes === PNG_1x1.length, '正常图片通过校验');
  await rejects(async () => assertSendableImage(Buffer.from('plain text, longer than twelve bytes'), 1024 * 1024), /不是有效图片/, '非图片内容被拒（改名成 .png 也没用）');
  await rejects(async () => assertSendableImage(fakePng(1, 1, 8000), 4096), /超过大小上限/, '超过 maxSendBytes 被拒');
  await rejects(async () => assertSendableImage(fakePng(20000, 20000, 128), 1024 * 1024), /像素过大/, '图片炸弹（像素超限）被拒');
  await rejects(async () => assertSendableImage(Buffer.alloc(0), 1024), /内容为空/, '空内容被拒');
}

console.log('### 配置归一化（socialV2.media）');
{
  const base = mediaCfg({ socialV2: {} }, ROOT);
  ok(base.dir === path.join(ROOT, 'media', 'images'), 'dir 默认 media/images');
  ok(base.maxSendBytes === DEFAULT_MAX_SEND_BYTES && DEFAULT_MAX_SEND_BYTES === 5 * 1024 * 1024, 'maxSendBytes 默认 5MB');
  ok(base.maxPerMinute === 2 && base.maxPerHour === 10, '频率默认 2/分钟、10/小时');
  ok(mediaCfg({ socialV2: { media: { maxSendBytes: 999 * 1024 * 1024 } } }, ROOT).maxSendBytes === HARD_MAX_SEND_BYTES, 'maxSendBytes 超大时被钳到硬上限');
  ok(mediaCfg({ socialV2: { media: { maxSendBytes: 'abc' } } }, ROOT).maxSendBytes === DEFAULT_MAX_SEND_BYTES, 'maxSendBytes 非法时回落默认值');
  ok(mediaCfg({ socialV2: { media: { enabled: false } } }, ROOT).enabled === false, 'media.enabled=false 生效');
}

console.log('### 工具开关（AI 侧闸门）');
{
  ok(sendImageToolEnabled({ socialV2: {} }) === true, '未配置时按开（与 v2ToolEnabled 的 !== false 口径一致）');
  ok(sendImageToolEnabled({ socialV2: { tools: { sendImage: false } } }) === false, 'tools.sendImage=false ⇒ 关闭');
  ok(sendImageToolEnabled({ socialV2: { tools: { sendImage: true }, media: { enabled: false } } }) === false, 'media.enabled=false ⇒ 关闭');
}

console.log('### AI 通道路径闸门（只能取库内文件）');
{
  const r = resolveImagePathInV2Library(libDir, 'ok.png');
  ok(r.path === path.join(libDir, 'ok.png') && r.name === 'ok.png', '库内相对名解析成功');
  ok(resolveImagePathInV2Library(libDir, 'sub/nested.png').name === 'sub/nested.png', '库内子目录解析成功');
  ok(resolveImagePathInV2Library(libDir, 'ok').name === 'ok.png', '省略扩展名可解析');
  await rejects(async () => resolveImagePathInV2Library(libDir, path.join(outDir, 'secret.png')), /只能从图片库/, '库外绝对路径被拒');
  await rejects(async () => resolveImagePathInV2Library(libDir, '..\\secret.png'), /只能从图片库|\.\./, '「..」穿越被拒');
  await rejects(async () => resolveImagePathInV2Library(libDir, '../outside/secret.png'), /只能从图片库|\.\./, '库外相对路径被拒');
  await rejects(async () => resolveImagePathInV2Library(libDir, 'https://example.com/a.png'), /url 参数/, 'http(s):// 当 file 传入被拒');
  await rejects(async () => resolveImagePathInV2Library(libDir, 'data:image/png;base64,AAAA'), /url 参数/, 'data: 被拒');
  await rejects(async () => resolveImagePathInV2Library(libDir, 'file:///C:/Windows/win.ini'), /url 参数/, 'file:// 被拒');
  await rejects(async () => resolveImagePathInV2Library(libDir, ''), /缺少图片/, '空参数被拒');
  const notFound = await rejects(async () => resolveImagePathInV2Library(libDir, 'nope.png'), /找不到/, '库里没有时报错');
  ok(/图片库里现有/.test(notFound), '  报错里附带库内清单（模型据此自我纠正）');
  ok(!notFound.includes(tmpRoot), '  报错里不含库外/本机绝对路径');
  try {
    const link = path.join(libDir, 'escape.png');
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(outDir, 'secret.png'), link, 'file');
    await rejects(async () => resolveImagePathInV2Library(libDir, 'escape.png'), /只能从图片库|找不到/, 'symlink 逃逸被拒');
  } catch (error) {
    skipped('symlink 逃逸被拒', `本机不允许创建符号链接：${error?.code ?? error?.message}`);
  }
}

console.log('### 操作者通道路径闸门（有意放开库外）');
{
  ok(resolveImagePathForOperator(libDir, path.join(outDir, 'secret.png')).via === 'absolute', '库外绝对路径允许（操作者口径）');
  ok(resolveImagePathForOperator(libDir, 'ok.png').via === 'image-library-safe', '库内相对名优先按图片库解析');
  await rejects(async () => resolveImagePathForOperator(libDir, 'https://example.com/a.png'), /url 参数/, '操作者通道仍不接受 http(s) 当路径');
  await rejects(async () => resolveImagePathForOperator(libDir, ''), /缺少图片路径/, '操作者通道空参数被拒');
}

console.log('### 图片库清单');
{
  const list = listImageFiles(libDir).map((f) => path.basename(f));
  ok(list.includes('ok.png') && list.includes('nested.png'), '列出库内图片（含子目录）');
  ok(!list.includes('notes.txt'), '非图片扩展名被排除');
  ok(!list.some((n) => n.startsWith('.')), '点文件被排除');
}

console.log('### URL 抓取拒绝面（SSRF 防护）');
{
  await rejects(async () => fetchImageBytes('not-a-url', 1024 * 1024), /必须是 http\(s\)/, '非 URL 被拒');
  await rejects(async () => fetchImageBytes('file:///C:/Windows/win.ini', 1024 * 1024), /必须是 http\(s\)/, 'file:// 被拒');
  await rejects(async () => fetchImageBytes('data:image/png;base64,AAAA', 1024 * 1024), /必须是 http\(s\)/, 'data: 被拒');
  await rejects(async () => fetchImageBytes('http://127.0.0.1:9/a.png', 1024 * 1024), /内网|本机/, '环回地址被拒');
  await rejects(async () => fetchImageBytes('http://localhost/a.png', 1024 * 1024), /内网|本机/, 'localhost 被拒');
  await rejects(async () => fetchImageBytes('http://10.1.2.3/a.png', 1024 * 1024), /内网|本机/, '私网 IPv4 被拒');
  await rejects(async () => fetchImageBytes('http://169.254.169.254/latest/meta-data/', 1024 * 1024), /内网|本机/, '云元数据地址（链路本地）被拒');
  await rejects(async () => fetchImageBytes('http://[::1]/a.png', 1024 * 1024), /内网|本机/, 'IPv6 环回被拒');
  await rejects(async () => fetchImageBytes('', 1024 * 1024), /缺少图片 URL/, '空 URL 被拒');
}

// ── 二、端到端（真实 bridge.js + 假网关） ─────────────────────────────────────
console.log('\n## 二、端到端（真实 bridge.js + 假网关，HTTP 走控制台端口）');

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';
const PRIVATE_KEY = 'private:123';

async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        media: { dir: libDir, maxSendBytes: 4096, maxPerMinute: 5, maxPerHour: 50 },
        tools: { sendImage: true },
        ...(overrides.socialV2 ?? {})
      },
      ...(overrides.top ?? {})
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  // 每个会话有自己的 agentToken（agentTokenOk 按 key 比对），所以按 key 取，不能混用。
  const tokens = {
    [AGENT_KEY]: h.getSocialV2State(AGENT_KEY).agentToken,
    [PRIVATE_KEY]: h.getSocialV2State(PRIVATE_KEY).agentToken
  };
  return {
    h,
    port,
    tokens,
    async post(pathname, body, useAgent = false) {
      const tokenKey = String(body?.key ?? body?.target ?? AGENT_KEY);
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-token': CONSOLE_TOKEN,
          ...(useAgent ? { 'x-agent-token': tokens[tokenKey] ?? tokens[AGENT_KEY] } : {})
        },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    },
    gatewayCalls(action) {
      return h.calls.http.filter((c) => c.url.endsWith(`/${action}`));
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

try {
  const f = await startFixture();

  console.log('### AI 通道：/api/socialV2/send-image');
  {
    // ① dryRun：只校验不发送
    const before = f.gatewayCalls('send_group_msg').length;
    const dry = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', text: '看这个', dryRun: true }, true);
    ok(dry.status === 200 && dry.json.ok === true && dry.json.dryRun === true, `dryRun 返回 200/ok/dryRun（HTTP ${dry.status}）`, JSON.stringify(dry.json));
    ok(dry.json.file === 'ok.png' && dry.json.bytes === PNG_1x1.length && /PNG/.test(dry.json.detail), `dryRun 回报 file/bytes/detail（${dry.json.file} · ${dry.json.bytes}B · ${dry.json.detail}）`);
    ok(dry.json.messageId === undefined, 'dryRun 不返回 messageId');
    ok(f.gatewayCalls('send_group_msg').length === before, 'dryRun 没有向网关发任何消息');

    // ② 正常路径：真的走一遍发送（目标是假网关，不碰 QQ）
    const sent = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', text: '看这个' }, true);
    ok(sent.status === 200 && sent.json.ok === true && sent.json.messageId === 9001, `正常路径成功（HTTP ${sent.status}, messageId=${sent.json.messageId}）`, JSON.stringify(sent.json));
    ok(sent.json.file === 'ok.png' && sent.json.bytes === PNG_1x1.length, '返回值含 file/bytes/detail');
    const calls = f.gatewayCalls('send_group_msg');
    const last = calls[calls.length - 1];
    const segs = last?.body?.message ?? [];
    ok(last?.body?.group_id === 456, '发往正确的群（group_id=456）');
    ok(segs[0]?.type === 'text' && segs[0]?.data?.text === '看这个', '文字段在前（附图说一句）');
    ok(segs[1]?.type === 'image' && String(segs[1]?.data?.file) === path.join(libDir, 'ok.png'), '图片段用库内绝对路径（不落 base64）');

    // ③ 库外文件必须被拒
    const escapeAbs = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: path.join(outDir, 'secret.png'), dryRun: true }, true);
    ok(escapeAbs.status === 400 && /只能从图片库/.test(escapeAbs.json.error ?? ''), `库外绝对路径被拒（HTTP ${escapeAbs.status}）`, JSON.stringify(escapeAbs.json));
    const escapeRel = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: '../outside/secret.png', dryRun: true }, true);
    ok(escapeRel.status === 400 && /只能从图片库|\.\./.test(escapeRel.json.error ?? ''), `「..」穿越被拒（HTTP ${escapeRel.status}）`);

    // ④ 非图片 / 超限 / 像素炸弹
    const fake = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'fake.png', dryRun: true }, true);
    ok(fake.status === 400 && /不是有效图片/.test(fake.json.error ?? ''), `非图片内容被拒（HTTP ${fake.status}）`);
    const huge = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'huge.png', dryRun: true }, true);
    ok(huge.status === 400 && /超过大小上限/.test(huge.json.error ?? ''), `超过 maxSendBytes 被拒（HTTP ${huge.status}）`);
    const bomb = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'bomb.png', dryRun: true }, true);
    ok(bomb.status === 400 && /像素过大/.test(bomb.json.error ?? ''), `像素炸弹被拒（HTTP ${bomb.status}）`);

    // ⑤ URL 拒绝面
    const intranet = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, url: 'http://127.0.0.1:9/a.png', dryRun: true }, true);
    ok(intranet.status === 400 && /内网|本机/.test(intranet.json.error ?? ''), `内网 URL 被拒（HTTP ${intranet.status}）`);
    const badUrl = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, url: 'ftp://example.com/a.png', dryRun: true }, true);
    ok(badUrl.status === 400 && /必须是 http\(s\)/.test(badUrl.json.error ?? ''), `非 http(s) URL 被拒（HTTP ${badUrl.status}）`);

    // ⑥ 参数组合与长度
    const both = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', url: 'https://example.com/a.png', dryRun: true }, true);
    ok(both.status === 400 && /只能给一个/.test(both.json.error ?? ''), `file 与 url 同时给被拒（HTTP ${both.status}）`);
    const none = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, dryRun: true }, true);
    ok(none.status === 400 && /缺少图片/.test(none.json.error ?? ''), `两者都不给被拒（HTTP ${none.status}）`);
    const longText = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', text: '啊'.repeat(501), dryRun: true }, true);
    ok(longText.status === 400 && /说明过长/.test(longText.json.error ?? ''), `附图说明过长被拒（HTTP ${longText.status}）`);

    // ⑦ 目标与模式闸门
    const notAllowed = await f.post('/api/socialV2/send-image', { key: 'group:999', file: 'ok.png', dryRun: true }, true);
    ok(notAllowed.status === 403, `白名单外目标被拒（HTTP ${notAllowed.status}）`);
    const badKey = await f.post('/api/socialV2/send-image', { key: 'nonsense', file: 'ok.png', dryRun: true }, true);
    ok(badKey.json.ok === false && (badKey.status === 400 || badKey.status === 403), `key 格式错误被拒（HTTP ${badKey.status}）`, JSON.stringify(badKey.json));
    const noToken = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', dryRun: true }, false);
    ok(noToken.status === 200 && noToken.json.dryRun === true, '控制台令牌调用（无 agent token）按操作者口径放行');
    const outViaConsole = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: path.join(outDir, 'secret.png'), dryRun: true }, false);
    ok(outViaConsole.status === 200 && outViaConsole.json.file === path.join(outDir, 'secret.png'), '控制台试发可发库外文件（与 /api/voice/send 同口径，且在返回值里回报绝对路径）');
    f.h.setMode('reserved');
    const wrongMode = await f.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', dryRun: true }, true);
    ok(wrongMode.status === 403, `非 reserved2 模式被拒（HTTP ${wrongMode.status}）`);
    f.h.setMode('reserved2');
  }

  console.log('### 操作者通道：/api/media/send-image');
  {
    const dry = await f.post('/api/media/send-image', { target: AGENT_KEY, file: path.join(outDir, 'secret.png'), dryRun: true });
    ok(dry.status === 200 && dry.json.ok === true && dry.json.dryRun === true && dry.json.via === 'absolute', `库外文件 dryRun 通过（HTTP ${dry.status}, via=${dry.json.via}）`, JSON.stringify(dry.json));
    ok(dry.json.file === path.join(outDir, 'secret.png'), '操作者通道回报绝对路径');
    const lib = await f.post('/api/media/send-image', { target: AGENT_KEY, file: 'ok.png', dryRun: true });
    ok(lib.status === 200 && lib.json.file === path.join(libDir, 'ok.png') && lib.json.via === 'image-library-safe', `库内文件名同样可用且回报绝对路径（via=${lib.json.via}）`, JSON.stringify(lib.json));
    const bad = await f.post('/api/media/send-image', { target: AGENT_KEY, file: 'fake.png', dryRun: true });
    ok(bad.status === 400 && /不是有效图片/.test(bad.json.error ?? ''), `非图片内容被拒（HTTP ${bad.status}）`);
    const denied = await f.post('/api/media/send-image', { target: 'group:999', file: 'ok.png', dryRun: true });
    ok(denied.status === 403, `白名单外目标被拒（HTTP ${denied.status}）`);
    const beforeAgent = f.gatewayCalls('send_group_msg').length;
    const withAgent = await f.post('/api/media/send-image', { target: AGENT_KEY, file: 'ok.png', dryRun: true }, true);
    ok(withAgent.status === 403 && withAgent.json.ok === false, `带 agent token 打到操作者通道被拒（HTTP ${withAgent.status}：${withAgent.json.error}）`);
    ok(f.gatewayCalls('send_group_msg').length === beforeAgent, '  该请求没有触达网关（在路径白名单层就被挡下）');
    const priv = await f.post('/api/media/send-image', { target: PRIVATE_KEY, file: 'ok.png', dryRun: true });
    ok(priv.status === 200, '私聊目标可用（dryRun）');
  }

  // 说明：f.setMode 用 reserved2 时 shouldBlockSilentReply 只对非 owner 私聊生效；静默模式
  // 需要在 state/role.json 里改 roleMode，属于控制台职责，这里不覆盖（见 docs/guides/SEND_IMAGE.md）。

  await f.stop();

  console.log('### 开关关闭 / 频率上限（各起一个独立实例）');
  {
    const off = await startFixture({ socialV2: { tools: { sendImage: false } } });
    const r = await off.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', dryRun: true }, true);
    ok(r.status === 403 && /工具未启用：qq_send_image/.test(r.json.error ?? ''), `tools.sendImage=false ⇒ 403 工具未启用（HTTP ${r.status}）`, JSON.stringify(r.json));
    const viaConsole = await off.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', dryRun: true }, false);
    ok(viaConsole.status === 200, '开关关闭只拦 AI，控制台试发仍可用');
    await off.stop();

    const mediaOff = await startFixture({ socialV2: { media: { enabled: false, dir: libDir } } });
    const r2 = await mediaOff.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', dryRun: true }, true);
    ok(r2.status === 403 && /图片发送已关闭/.test(r2.json.error ?? ''), `media.enabled=false ⇒ 403（HTTP ${r2.status}）`);
    await mediaOff.stop();

    const limited = await startFixture({ socialV2: { media: { dir: libDir, maxSendBytes: 4096, maxPerMinute: 1, maxPerHour: 1 } } });
    const first = await limited.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png' }, true);
    const second = await limited.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png' }, true);
    ok(first.status === 200, `第一次发送成功（HTTP ${first.status}）`);
    ok(second.status === 429 && /发图频率超限/.test(second.json.error ?? ''), `超过频率上限被拒（HTTP ${second.status}）`, JSON.stringify(second.json));
    // 额度只记在会话桶：另一个会话不受影响
    const other = await limited.post('/api/socialV2/send-image', { key: PRIVATE_KEY, file: 'ok.png' }, true);
    ok(other.status === 200, '额度按会话独立计数（另一个会话不受影响）');
    const dryAfterLimit = await limited.post('/api/socialV2/send-image', { key: AGENT_KEY, file: 'ok.png', dryRun: true }, true);
    ok(dryAfterLimit.status === 429, 'dryRun 也如实报告"会被限流"（只检查、不占额度）');
    await limited.stop();
  }

  console.log('### 公网图片 URL（网络可选）');
  {
    const URL_PNG = 'https://www.python.org/static/img/python-logo.png';
    // 无外网环境：safe-fetch 报"域名解析/超时/连接失败"，此时整块跳过（不算失败）。
    const noNet = (r) => /抓取失败：.*(解析|超时|timeout|ENOTFOUND|EAI_AGAIN|fetch failed|socket|连接)/i.test(r.json.error ?? '');

    // ① 体积闸门对小额度的实例仍然生效（python 的 logo 远大于 4096B）
    const small = await startFixture();
    const tooBig = await small.post('/api/socialV2/send-image', { key: AGENT_KEY, url: URL_PNG, dryRun: true }, true);
    if (/超过大小限制/.test(tooBig.json.error ?? '')) {
      ok(true, 'URL 图片超过 maxSendBytes 被拒（抓取时按字节上限截断/报错）');
    } else if (noNet(tooBig)) {
      skipped('URL 图片超过 maxSendBytes 被拒', '当前环境无外网');
    } else {
      ok(false, 'URL 图片超过 maxSendBytes 被拒', JSON.stringify(tooBig.json));
    }
    await small.stop();

    // ② 正常抓取 + 非图片内容被拒（额度放到默认 5MB）
    const net = await startFixture({ socialV2: { media: { dir: libDir, maxSendBytes: DEFAULT_MAX_SEND_BYTES, maxPerMinute: 5, maxPerHour: 50 } } });
    const good = await net.post('/api/socialV2/send-image', { key: AGENT_KEY, url: URL_PNG, dryRun: true }, true);
    if (good.status === 200 && good.json.dryRun === true) {
      ok(/PNG|GIF|WEBP|JPEG/.test(good.json.detail ?? ''), `公网图片可抓取并识别（${good.json.detail}）`);
      const urlSend = await net.post('/api/socialV2/send-image', { key: AGENT_KEY, url: URL_PNG }, true);
      const calls = net.gatewayCalls('send_group_msg');
      const last = calls[calls.length - 1];
      const imgSeg = (last?.body?.message ?? []).find((s) => s.type === 'image');
      ok(urlSend.status === 200 && String(imgSeg?.data?.file ?? '').startsWith('base64://'), 'URL 来源以 base64:// 内联发送（不让网关去抓 URL）');
      ok(!/python\.org/.test(JSON.stringify(last?.body?.message ?? [])), '发给网关的段里不含原始 URL');
    } else if (noNet(good)) {
      skipped('公网图片可抓取并识别', '当前环境无外网');
      skipped('URL 来源以 base64:// 内联发送', '当前环境无外网');
    } else {
      ok(false, '公网图片可抓取并识别', JSON.stringify(good.json));
    }
    const html = await net.post('/api/socialV2/send-image', { key: AGENT_KEY, url: 'https://example.com/', dryRun: true }, true);
    if (/不是有效图片/.test(html.json.error ?? '')) {
      ok(true, '公网取回的 HTML（非图片）被拒');
    } else if (noNet(html)) {
      skipped('公网取回的 HTML（非图片）被拒', '当前环境无外网');
    } else {
      ok(false, '公网取回的 HTML（非图片）被拒', JSON.stringify(html.json));
    }
    await net.stop();
  }
} catch (error) {
  fail += 1;
  console.error('  ❌ 端到端用例异常：', error?.stack ?? error);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
if (fail > 0) {
  console.error('一行结论：发图能力自检失败 —— 见上面 ❌。');
  process.exit(1);
}
console.log(`一行结论：发图能力自检通过 —— ${pass} 项断言全绿（库外路径/内网 URL/非图片/超限/开关关闭全部被拒，dryRun 只校验不发送，正常路径真发出 image 段），${skip} 项因环境跳过。`);
