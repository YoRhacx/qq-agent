// 长期记忆卡（src/memory-card.js）的离线单测。
// 覆盖：打分 → 脱敏 → 去重 → 衰减 → 压缩 → 渲染预算 → 容量上限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  addMemoryRecord,
  applyDailyDecay,
  compactMemoryCard,
  createEmptyCard,
  detectEmotionScore,
  maintainMemoryCard,
  memoryCardStatus,
  normalizeMemoryCardConfig,
  redactForMemory,
  renderMemoryCard,
  scoreMemory,
  targetClarity,
} from '../src/memory-card.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-28T12:00:00+08:00');

function cardWith(events, config = {}, at = NOW) {
  const card = createEmptyCard(at);
  for (const event of events) addMemoryRecord(card, event, config, event.at ?? at);
  return card;
}

test('打分：主人私聊 > 主人群里 > 群友；情绪/承诺/矛盾/第一次都会加分', () => {
  const ownerPrivate = scoreMemory({ text: '我今天有点累', isOwner: true, kind: 'private' }, {});
  const ownerGroup = scoreMemory({ text: '我今天有点累', isOwner: true, kind: 'group' }, {});
  const member = scoreMemory({ text: '我今天有点累', isOwner: false, kind: 'group' }, {});
  assert.ok(ownerPrivate.importance > ownerGroup.importance, '主人私聊应比主人在群里重要');
  assert.ok(ownerGroup.importance > member.importance, '主人在群里应比群友重要');
  assert.equal(member.kind, 'event');

  const emotional = scoreMemory({ text: '我崩溃了，哭了一晚上！！' }, {});
  assert.ok(emotional.emotional >= 14, '强情绪词应被识别');
  assert.equal(emotional.kind, 'emotion');

  const promise = scoreMemory({ text: '说好了下次请我喝奶茶' }, {});
  assert.equal(promise.kind, 'promise');
  assert.ok(promise.importance > member.importance);

  const conflict = scoreMemory({ text: '对不起，刚才凶你了' }, {});
  assert.equal(conflict.kind, 'conflict');

  const first = scoreMemory({ text: '你好呀', isFirst: true, isOwner: true, kind: 'private' }, {});
  assert.equal(first.importance, 100);
  assert.equal(first.pinned, true, '和主人的第一次见面应被钉住');

  const tooShort = scoreMemory({ text: '嗯' }, {});
  assert.ok(tooShort.importance < member.importance, '太短的消息应降权');
});

test('脱敏：QQ号/手机号/密码/链接都不会原样写进记忆', () => {
  const text = redactForMemory('我的QQ是123456789，手机 13800138000，密码 abc12345，看 https://example.com/x');
  assert.doesNotMatch(text, /123456789/);
  assert.doesNotMatch(text, /13800138000/);
  assert.doesNotMatch(text, /abc12345/);
  assert.doesNotMatch(text, /example\.com/);
  assert.match(text, /\[号码已隐藏\]/);
  assert.match(text, /\[密码|已隐藏/);
});

test('去重：两分钟内重复的一句话只占一条，且 recallCount 会涨', () => {
  const card = cardWith([{ text: '今天加班到十一点，好累啊', speaker: '主人', isOwner: true, kind: 'private', conversationKey: 'private:1' }]);
  const again = addMemoryRecord(card, { text: '今天加班到十一点，好累啊', speaker: '主人', isOwner: true, kind: 'private', conversationKey: 'private:1' }, {}, NOW + 60_000);
  assert.equal(again.added, false);
  assert.equal(card.records.length, 1);
  assert.equal(card.records[0].recallCount, 1);
});

test('衰减：久远的琐事会被忘掉，主人的重要记忆还记得', () => {
  const old = NOW - 120 * DAY;
  const card = cardWith([
    { text: '群里有人问今天吃什么好呢', speaker: '路人甲', conversationKey: 'group:9', at: old },
    { text: '记住，我最讨厌别人骗我', speaker: '主人', isOwner: true, kind: 'private', conversationKey: 'private:1', at: old },
  ]);
  const trivia = card.records.find((r) => !r.isOwner);
  const owner = card.records.find((r) => r.isOwner);
  assert.equal(targetClarity(trivia, {}, NOW), 'forgotten');
  assert.notEqual(targetClarity(owner, {}, NOW), 'forgotten');
  maintainMemoryCard(card, {}, NOW);
  // 一天只降一档：120 天前的琐事这一轮只掉一档（清晰→模糊），不会立刻消失
  const still = card.records.find((r) => r.id === trivia.id);
  assert.ok(!still || still.clarity === 'fuzzy', '久远的琐事应开始变模糊');
  assert.ok(card.records.some((r) => r.id === owner.id), '主人的记忆不该被删');
  assert.notEqual(card.records.find((r) => r.id === owner.id).clarity, 'forgotten');
});

test('衰减一天只走一档，同一天重复调用不重复降级', () => {
  const old = NOW - 30 * DAY;
  const card = cardWith([{ text: '那天在群里聊了很久的游戏本配置', speaker: '群友B', conversationKey: 'group:3', at: old }], {});
  const before = card.records[0].clarity;
  applyDailyDecay(card, {}, NOW, { force: true, steps: 1 });
  const after = card.records[0].clarity;
  assert.notEqual(after, before, '30 天前的记忆应该降档');
  const second = applyDailyDecay(card, {}, NOW + 1000);
  assert.equal(second, false, '同一天不应再跑一轮');
});

test('压缩：容量超了先丢不重要/老的，pinned 与主人重要记忆不动', () => {
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, { text: '和主人第一次说话，记一辈子', isOwner: true, kind: 'private', isFirst: true, conversationKey: 'private:1' }, {}, NOW - 200 * DAY);
  for (let i = 0; i < 30; i += 1) {
    addMemoryRecord(card, { text: '群里随口的第 ' + i + ' 句闲话内容', speaker: '路人' + i, conversationKey: 'group:5', at: NOW - (60 + i) * DAY }, {}, NOW - (60 + i) * DAY);
  }
  const before = card.records.length;
  const charsBefore = card.records.reduce((sum, r) => sum + r.text.length + 12, 0);
  const changed = compactMemoryCard(card, { warnChars: 600, autoCompact: true }, { targetRatio: 0.5, now: NOW });
  const charsAfter = card.records.reduce((sum, r) => sum + r.text.length + 12, 0);
  assert.ok(changed > 0, '超容量时应发生压缩');
  assert.ok(card.records.length < before, '压缩应真的删掉一些记忆');
  assert.ok(charsAfter < charsBefore, '压缩后总字数应下降');
  assert.ok(card.records.some((r) => r.pinned), 'pinned 不能被压掉');
});

test('渲染：置顶在前，按预算裁剪，超预算时提示还有多少条', () => {
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, { text: '主人说以后叫我一声就行', isOwner: true, kind: 'private', isFirst: true, conversationKey: 'private:1' }, {}, NOW);
  addMemoryRecord(card, { text: '主人今天心情不好，别惹他', isOwner: true, kind: 'private', conversationKey: 'private:1' }, {}, NOW);
  for (let i = 0; i < 8; i += 1) {
    addMemoryRecord(card, { text: '群友' + i + '说了一个很长的故事，讲的是他今天上班遇到的破事', speaker: '群友' + i, conversationKey: 'group:7' }, {}, NOW - i * 1000);
  }
  const full = renderMemoryCard(card, { config: { injectMaxChars: 2000 }, now: NOW });
  assert.match(full, /【记忆卡】/);
  assert.match(full, /◆ 最初/);
  assert.match(full, /主人/);

  const tight = renderMemoryCard(card, { config: { injectMaxChars: 120 }, now: NOW });
  assert.ok(tight.length < full.length, '预算收紧后应更短');
  assert.match(tight, /另有 \d+ 条/);
  // 预算只看正文，标题和「最初」这类固定块不会被裁，所以整体允许比预算略长
  assert.ok(tight.length <= 320, `收紧后的长度应可接受，实际 ${tight.length}`);
});

test('容量上限：maxRecords 生效，但不会挤掉 pin 住的记忆', () => {
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, { text: '这是被钉住的一条重要记忆', pinned: true }, {}, NOW);
  for (let i = 0; i < 40; i += 1) {
    addMemoryRecord(card, { text: '普通第' + i + '条记忆内容', speaker: 's' + i, conversationKey: 'g:' + i }, {}, NOW + i);
  }
  const cfg = normalizeMemoryCardConfig({ maxRecords: 20 });
  const trimmed = createEmptyCard(NOW);
  addMemoryRecord(trimmed, { text: '这是被钉住的一条重要记忆', pinned: true }, cfg, NOW);
  for (let i = 0; i < 40; i += 1) {
    addMemoryRecord(trimmed, { text: '普通第' + i + '条记忆内容', speaker: 's' + i, conversationKey: 'g:' + i }, cfg, NOW + i);
  }
  assert.ok(trimmed.records.length <= 20);
  assert.ok(trimmed.records.some((r) => r.pinned), 'pinned 记忆不能被条数上限挤掉');
});

test('接线：bridge.js 真的接上了记忆卡（纯函数全绿但没接线等于没做）', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/memory-card\.js'/, 'bridge.js 应 import 记忆卡模块');
  assert.match(source, /startMemoryCardMaintenance\(\);/, '启动时应读回记忆卡并挂定时维护');
  assert.match(source, /rememberInboundForMemory\(\{ key, kind, id, sender, isOwner, text: plainContent \}\)/, '入站消息应进记忆 inbox');
  assert.match(source, /const memoryCardLine = memoryCardPromptText/, '唤醒提示词应带上记忆卡');
  assert.match(source, /memoryLine \+ memoryCardLine/, '记忆卡要拼进 base 提示词');
  assert.match(source, /'\/api\/memory-card'/, '控制台应有读取端点');
  assert.match(source, /'\/api\/memory-card\/maintain'/, '控制台应能手动触发维护');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.ok(example.memoryCard && typeof example.memoryCard === 'object', 'config.example.json 应包含 memoryCard 配置块');
});

test('状态统计：条数、清晰度分布、渲染长度都对得上', () => {
  const card = cardWith([
    { text: '主人说他喜欢喝冰美式', isOwner: true, kind: 'private', conversationKey: 'private:1' },
    { text: '群里在聊新出的显卡价格', speaker: '群友C', conversationKey: 'group:1' },
  ]);
  const status = memoryCardStatus(card, {}, NOW);
  assert.equal(status.total, 2);
  assert.equal(status.owner, 1);
  assert.equal(status.byClarity.vivid + status.byClarity.clear + status.byClarity.fuzzy + status.byClarity.trace, 2);
  assert.ok(status.renderedChars > 0);
  assert.equal(status.injectMaxChars, 1200);
});
