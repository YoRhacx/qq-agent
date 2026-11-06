// 对话收束判定（src/conversation-closure.js）的离线单测。
// 重点：①「对方还在问」永远不能被判成收尾 ②告别单独就该收 ③含蓄信号要凑够分
// ④她自己刚问了一句时不能收（等于把问题吞了）⑤只给建议、不写状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  analyzeClosure,
  buildClosureLine,
  DEFAULT_CLOSURE_CONFIG,
  describeClosure,
  normalizeClosureConfig,
} from '../src/conversation-closure.js';

const NOW = Date.parse('2026-10-28T21:00:00+08:00');
const MIN = 60 * 1000;

// 造一段对话：字符串 = 对方说的，{ self: true } = 她说的；at 缺省按分钟往前排
function conversation(lines) {
  return lines.map((line, i) => {
    const item = typeof line === 'string' ? { text: line } : line;
    return {
      sender: item.self ? '我' : '群友',
      plain: item.text,
      text: item.text,
      isSelf: !!item.self,
      time: item.time ?? NOW - (lines.length - i) * MIN,
    };
  });
}

test('对方最后一句是问句：永远 continue，且标出 openQuestion', () => {
  const messages = conversation(['在吗', '刚下班，累死了', '你睡了吗？']);
  const r = analyzeClosure({ messages, now: NOW, config: {} });
  assert.equal(r.action, 'continue');
  assert.equal(r.openQuestion, true);
  assert.equal(r.score, 0);
  assert.match(buildClosureLine(r, {}), /对方最后一句是提问/);
});

test('问句优先于告别：对方说「那晚安？」仍然要回，不能判成收尾', () => {
  const r = analyzeClosure({ messages: conversation(['那晚安？']), now: NOW, config: {} });
  assert.notEqual(r.action, 'close');
  assert.equal(r.openQuestion, true);
});

test('明确告别：单独一条就收（不用凑分），提示里带「别补晚安」和留尾巴的办法', () => {
  const r = analyzeClosure({ messages: conversation(['今天先这样', '晚安']), now: NOW, config: {} });
  assert.equal(r.action, 'close');
  assert.deepEqual(r.signals.map((s) => s.id), ['farewell']);
  const line = buildClosureLine(r, {});
  assert.match(line, /已经到站/);
  assert.match(line, /别硬找新话题/);
  assert.match(line, /qq_memory_append/);
});

test('短确认 + 冷场：先 linger（可再等一条），加上越说越短才 close', () => {
  const linger = analyzeClosure({
    messages: conversation([
      { text: '今天加班到十点半，饭都没吃', time: NOW - 20 * MIN },
      { text: '嗯', time: NOW - 10 * MIN },
    ]),
    now: NOW,
    config: {},
  });
  assert.equal(linger.action, 'linger');
  assert.ok(linger.signals.some((s) => s.id === 'short-ack'));
  assert.ok(linger.signals.some((s) => s.id === 'cooling'));
  assert.match(buildClosureLine(linger, {}), /先别急着收/);

  const close = analyzeClosure({
    messages: conversation([
      { text: '最近在玩什么游戏，推荐一下呗', time: NOW - 30 * MIN },
      { text: '一些小游戏', time: NOW - 20 * MIN },
      { text: '哦', time: NOW - 10 * MIN },
    ]),
    now: NOW,
    config: {},
  });
  assert.equal(close.action, 'close', describeClosure(close));
  assert.ok(close.signals.some((s) => s.id === 'shrinking'));
});

test('冷场单独不够：只过了五分钟、没有告别没有短确认，仍然 continue（不占提示词）', () => {
  const r = analyzeClosure({
    messages: conversation([
      { text: '我刚看到一个新出的显卡测评，说功耗压得挺好', time: NOW - 6 * MIN },
    ]),
    now: NOW,
    config: {},
  });
  assert.equal(r.action, 'continue');
  assert.equal(buildClosureLine(r, {}), '', 'continue 且非提问时不应占用提示词');
});

test('她自己刚问了一句、对方还没答：最多 linger，绝不 close', () => {
  const messages = conversation([
    { text: '今天好累', time: NOW - 30 * MIN },
    { text: '嗯', time: NOW - 20 * MIN },
    { text: '那你要不要说说是怎么累的？', self: true, time: NOW - 10 * MIN },
  ]);
  const r = analyzeClosure({ messages, now: NOW, config: {} });
  assert.notEqual(r.action, 'close');
  assert.ok(r.signals.some((s) => s.id === 'awaiting-answer'));
});

test('阈值与窗口可配：closeScore 调高后同一段对话从 close 变 linger', () => {
  const messages = conversation([
    { text: '最近在玩什么游戏，推荐一下呗', time: NOW - 30 * MIN },
    { text: '一些小游戏', time: NOW - 20 * MIN },
    { text: '哦', time: NOW - 10 * MIN },
  ]);
  assert.equal(analyzeClosure({ messages, now: NOW, config: {} }).action, 'close');
  const strict = analyzeClosure({ messages, now: NOW, config: { closeScore: 12 } });
  assert.equal(strict.action, 'linger');

  // window 收窄到只看最后一句后，前面的长短对比就不存在了
  const narrow = analyzeClosure({ messages, now: NOW, config: { window: 4 } });
  assert.equal(narrow.action, 'close');
  const oneLine = analyzeClosure({ messages, now: NOW, config: { window: 4, closeScore: 12 } });
  assert.equal(oneLine.action, 'linger');
});

test('关闭开关：enabled=false 不判定，inject=false 不写提示词', () => {
  const messages = conversation(['晚安']);
  assert.equal(analyzeClosure({ messages, now: NOW, config: { enabled: false } }).action, 'continue');
  const r = analyzeClosure({ messages, now: NOW, config: {} });
  assert.equal(r.action, 'close');
  assert.equal(buildClosureLine(r, { inject: false }), '');
});

test('配置归一化：坏值回落默认，数字被夹到合理区间', () => {
  const cfg = normalizeClosureConfig({ closeScore: 999, lingerScore: -3, idleMs: 1, window: 'x' });
  assert.equal(cfg.closeScore, 20);
  assert.equal(cfg.lingerScore, 1);
  assert.equal(cfg.idleMs, 30000);
  assert.equal(cfg.window, DEFAULT_CLOSURE_CONFIG.window);
  assert.equal(normalizeClosureConfig(null).closeScore, DEFAULT_CLOSURE_CONFIG.closeScore);
});

test('接线：bridge.js 真的接上了收束判定（纯函数全绿但没接线等于没做）', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/conversation-closure\.js'/, 'bridge.js 应 import 收束模块');
  assert.match(source, /let closureConfig = normalizeClosureConfig\(\{\}\);/, '应有模块级 closureConfig');
  assert.match(source, /closureConfig = normalizeClosureConfig\(cfg\.conversationClosure \?\? \{\}\);/, '应读取 config.conversationClosure');
  assert.match(source, /const closureLine = closureText \?/, '唤醒提示词应带上收束建议');
  // 2026-10-28 第四轮在两者之间插入了 purposeLine（目的引擎），这里允许它存在
  // 只断言「在 base 里、且在 memoryCardLine 之后」——中间以后可能再插 purposeLine/budgetLine
  assert.match(source, /const base = [^;]*memoryCardLine[^;]*closureLine[^;]*;/, '收束建议要拼进 base 提示词（排在记忆卡之后）');
  assert.match(source, /'\/api\/socialV2\/closure'/, '应提供只读端点供控制台查看');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.ok(example.conversationClosure && typeof example.conversationClosure === 'object', 'config.example.json 应包含 conversationClosure 配置块');
  assert.equal(example.conversationClosure.closeScore, DEFAULT_CLOSURE_CONFIG.closeScore);
});
