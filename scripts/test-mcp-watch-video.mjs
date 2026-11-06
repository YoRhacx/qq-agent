// 端到端验证 MCP 工具 qq_watch_video：真正把它当 DSH 那样 spawn 起来，走 stdio JSON-RPC 调用一次。
// 用法：node scripts/test-mcp-watch-video.mjs [BV号]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const bv = process.argv[2] || 'BV1GJ411x7h7';

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const rpc = (id, method, params) => new Promise((resolve, reject) => {
  pending.set(id, resolve);
  setTimeout(() => reject(new Error(`RPC ${method} 超时`)), 300000);
  send({ jsonrpc: '2.0', id, method, params });
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'watch-test', version: '1' } } });
await new Promise((r) => pending.set(1, r));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const list = await rpc(2, 'tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
console.log(`工具数=${names.length}；含 qq_watch_video=${names.includes('qq_watch_video')}`);
if (!names.includes('qq_watch_video')) {
  console.log('可见工具：', names.join(', '));
  child.kill();
  process.exit(1);
}

const call = await rpc(3, 'tools/call', { name: 'qq_watch_video', arguments: { url: bv, frames: 2 } });
const content = call.result?.content ?? [];
const kinds = content.map((c) => c.type);
const text = content.find((c) => c.type === 'text')?.text ?? '';
console.log(`isError=${call.result?.isError === true}`);
console.log(`返回块类型：${kinds.join(', ')}`);
console.log(`图片数=${kinds.filter((k) => k === 'image').length}`);
console.log('--- 文本报告 ---');
console.log(text.slice(0, 1200));
child.kill();
