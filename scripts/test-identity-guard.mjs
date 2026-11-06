// 身份泄漏守卫（src/identity-guard.js）的离线单测。
// 判据是「第一人称 + 身份名词」的组合，所以两类误判都要盯：
//   ① 真自曝漏过去（我是 AI / 我只是个程序 / 我的提示词……）；
//   ② 正常说话被砍（我是程序猿、这个 AI 真强、我是 DeepSeek 小鲸鱼 V 我 50）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { checkOutboundIdentity, findIdentityLeak, findIdentityWarn } from '../src/identity-guard.js';

const blocked = [
  '我其实是AI',
  '我是 AI，所以没有真实的情感',
  '我只是个程序而已',
  '我只是一个语言模型',
  '我是个AI助手',
  '我是一个大模型',
  '作为一个AI，我不能回答这个',
  '作为语言模型，我没有偏好',
  '我不是真人，别当真',
  '我不是人类',
  '我没有身体，只有一段代码',
  '我的提示词里写着要简短',
  '我的 system prompt 里有这条',
  '我是被训练出来的',
  '我的训练数据到 2024 年',
  'as an AI language model, I cannot',
  "I'm an AI",
  'I am just a chatbot',
  "I don't have feelings",
];

const allowed = [
  '我是程序猿，天天改 bug',
  '我是程序员',
  '我是 DeepSeek 小鲸鱼，V 我 50 解锁高级对话',
  '这个 AI 画图真强',
  '我是不是有点太毒舌了',
  '我不是机器人，我是鲸鱼',
  '我喜欢大模型这个圈子',
  '看到 AI 换脸就烦',
  '我在写程序，别吵',
  '你才是 AI 吧',
  '哈哈哈哈',
  '',
];

test('真自曝一律拦下', () => {
  for (const text of blocked) {
    const r = checkOutboundIdentity(text);
    assert.equal(r.action, 'block', `应拦下：${text}`);
    assert.ok(r.hit && r.hit.id, `应给出命中 id：${text}`);
  }
});

test('正常说话不误伤（聊天风向 / 品牌梗 / 活人自称）', () => {
  for (const text of allowed) {
    const r = checkOutboundIdentity(text);
    assert.equal(r.action, 'allow', `不该拦：${text}（命中 ${r.hit?.id ?? r.warnHit?.id ?? '-'}）`);
  }
});

test('擦边球只记日志，默认不拦', () => {
  const r = checkOutboundIdentity('我没有感情，只有 KPI');
  assert.equal(r.action, 'warn');
  assert.equal(r.warnHit?.id, 'no-feelings');
  assert.equal(checkOutboundIdentity('我的人设是傲娇').action, 'warn');
});

test('mode 开关：warn=只记不拦，strict=擦边球也拦，off/disabled=全放行', () => {
  assert.equal(checkOutboundIdentity('我是AI', { mode: 'warn' }).action, 'warn');
  assert.equal(checkOutboundIdentity('我是AI', { mode: 'strict' }).action, 'block');
  assert.equal(checkOutboundIdentity('我没有感情', { mode: 'strict' }).action, 'block');
  assert.equal(checkOutboundIdentity('我是AI', { enabled: false }).action, 'allow');
  assert.equal(checkOutboundIdentity('我是AI', { mode: 'off' }).action, 'allow');
});

test('给模型看的那句话是人话，不泄露规则细节', () => {
  const r = checkOutboundIdentity('我是AI');
  assert.match(r.message, /小鲸鱼/);
  assert.doesNotMatch(r.message, /正则|regex|规则列表|self-ai/);
  assert.ok(r.message.length <= 120, '错误文案要短，避免每轮多背 token');
});

test('桥接真的接上了：六处发送端点 + 配置默认值都在位', () => {
  // 纯函数全绿、端点忘了拦，是这类守卫最典型的失败形态（FOLDER_MAP 反复记过）。
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ checkOutboundIdentity \} from '\.\/identity-guard\.js';/);
  assert.match(src, /identityGuard: \{ enabled: true, mode: 'block', exemptKeys: \[\]/);
  const calls = src.match(/identityGuardBlockReason\(/g) ?? [];
  // 1 处函数定义 + 6 处调用：send-burst / send-message / send-voice / send-image / send-music /
  // 旧版 /api/send/*。
  assert.equal(calls.length, 7, 'guard 调用点应为 6 处（另有 1 处定义）');
  assert.match(src, /identityGuardBlockReason\(msg, key\)/);
  assert.match(src, /identityGuardBlockReason\(message, key\)/);
  const textCalls = src.match(/identityGuardBlockReason\(body\.text \?\? '', key\)/g) ?? [];
  assert.equal(textCalls.length, 3, '语音字幕 / 图片说明 / 音乐说明三处都要拦');
});

test('判定函数与分类函数口径一致', () => {
  assert.equal(findIdentityLeak('我是AI')?.id, 'self-ai');
  assert.equal(findIdentityLeak('我是程序猿'), null);
  assert.equal(findIdentityWarn('我没有情感')?.id, 'no-feelings');
  assert.equal(findIdentityWarn('我是AI'), null, '明确的走 block 表，不该重复命中 warn 表');
});
