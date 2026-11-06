// DSH 端点自动发现的自测（不需要真的跑着 DSH）。
//
// 为什么值得单测：这段逻辑的存在理由是「DSH 桌面版用 --port 0 启动、每次重启换端口」，
// 而它的失败形态是**静默的**（拨一个没人听的端口，日志只剩一行行"连接…"）。
// 单测钉住三件事：① 能认出 DSH（靠 401 正文的独有标记，而不是"像是个 HTTP 服务"）；
// ② 认错时不会把 DSH 会话 Cookie 发给本机别的程序；③ 候选顺序与缓存写回。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  discoverDshEndpoint,
  listLoopbackListeners,
  parseWindowsNetstat,
  probeDshEndpoint,
  readEndpointCache
} from '../src/dsh-discovery.js';
import { mintBrowserSessionCookie, readBrowserSessionSecret } from '../src/dsh-client.js';

// 从 DSH 派生的终端里跑测试会继承 DSH_WEB_URL；它会让「候选顺序」这类断言失去意义。
delete process.env.DSH_WEB_URL;

const DSH_401 = 'dsh web authentication required; reopen the URL printed by dsh web.';
let passed = 0;
const ok = (cond, label) => {
  if (!cond) throw new Error('断言失败: ' + label);
  passed += 1;
  console.log('  ✓ ' + label);
};

const serve = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});

let otherSawCookie = null;
const fakeDsh = await serve((req, res) => {
  if (req.headers.cookie) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><script>window.__DSH_BOOT__={}</script></html>');
    return;
  }
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end(DSH_401);
});
const fakeOther = await serve((req, res) => {
  otherSawCookie = req.headers.cookie ?? null;
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('some other local service');
});
const dshUrl = 'http://127.0.0.1:' + fakeDsh.address().port;
const otherUrl = 'http://127.0.0.1:' + fakeOther.address().port;
const stateFile = path.join(os.tmpdir(), 'dsh-endpoint-test-' + process.pid + '.json');

try {
  console.log('probe：');
  {
    const r = await probeDshEndpoint(dshUrl);
    ok(r.ok === true && r.reason === 'unauth-marker', '未认证的 DSH 靠 401 正文被认出');
  }
  {
    const r = await probeDshEndpoint(otherUrl);
    ok(r.ok === false, '普通 200 服务不会被当成 DSH');
  }
  {
    const r = await probeDshEndpoint('http://127.0.0.1:19387');
    ok(r.ok === false, '没人在听的端口返回失败而不是抛错');
  }

  console.log('discover：');
  {
    const found = await discoverDshEndpoint({ current: dshUrl, stateFile });
    ok(found?.baseUrl === dshUrl, '知道地址时直接用它');
    ok(readEndpointCache(stateFile) === dshUrl, '命中后写入缓存');
  }
  {
    fs.rmSync(stateFile, { force: true });
    const found = await discoverDshEndpoint({ current: 'http://127.0.0.1:19387', extraCandidates: [dshUrl], stateFile });
    ok(found?.baseUrl === dshUrl, '旧端口失效时从候选里找回来');
  }
  {
    fs.rmSync(stateFile, { force: true });
    const found = await discoverDshEndpoint({
      current: otherUrl,
      extraCandidates: [dshUrl],
      stateFile,
      cookieFor: (base) => mintBrowserSessionCookie(base, readBrowserSessionSecret())
    });
    ok(found?.baseUrl === dshUrl, '当前值不是 DSH 时继续往下找');
    ok(found?.authOk === true, '找到后带 Cookie 复验鉴权');
    ok(otherSawCookie === null, '非 DSH 服务收不到会话 Cookie');
  }

  console.log('解析：');
  {
    const sample = [
      '  TCP    127.0.0.1:51144        0.0.0.0:0              LISTENING       4524',
      '  TCP    [::1]:3100             [::]:0                 LISTENING       10024',
      '  TCP    127.0.0.1:19387        0.0.0.0:0              ESTABLISHED     1234'
    ].join('\r\n');
    const parsed = parseWindowsNetstat(sample);
    ok(parsed.length === 2, '只留 LISTENING');
    ok(parsed[0].port === 51144 && parsed[0].pid === 4524, 'IPv4 监听解析');
    ok(parsed[1].port === 3100 && parsed[1].pid === 10024, 'IPv6 监听解析');
  }
  {
    const listeners = await listLoopbackListeners({ timeoutMs: 5000 });
    ok(Array.isArray(listeners), '监听表可读（读不到时应当是空数组而不是抛错）');
  }
} finally {
  fakeDsh.close();
  fakeOther.close();
  fs.rmSync(stateFile, { force: true });
}
console.log('\n' + passed + ' 项通过');
