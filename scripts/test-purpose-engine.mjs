// 目的引擎（src/purpose-engine.js）的离线单测。
// 重点：①五类来源都能长出候选 ②硬闸门（刚聊过/静默时段/日上限/冷却/载体互斥）一个都不能漏
// ③候选分不够时宁可沉默 ④状态语义（跨日归零、提过冷却、了结不再提）⑤真的接上了 bridge.js。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  buildPurposeCandidates,
  buildPurposeLine,
  DEFAULT_PURPOSE_CONFIG,
  inQuietHours,
  markPurposeFired,
  normalizePurposeConfig,
  normalizePurposeState,
  resolvePurpose,
  selectPurpose,
} from '../src/purpose-engine.js';

const NOW = Date.parse('2026-10-28T21:00:00+08:00');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const CFG = normalizePurposeConfig({ quietStart: '23:30', quietEnd: '08:30' });

function record(over) {
  return { id: over.id || 'r1', text: over.text || '答应了帮她看看那台老电脑', kind: 'promise', importance: 60, clarity: 4, createdAt: iso(NOW - 6 * HOUR), isOwner: false, ...over };
}

test('五类来源都能长出候选', () => {
  const candidates = buildPurposeCandidates({
    memoryCard: { records: [
      record({ id: 'p1', kind: 'promise', text: '答应周末帮她修鼠标' }),
      record({ id: 'c1', kind: 'conflict', text: '昨晚为了抽卡吵了两句', createdAt: iso(NOW - 4 * HOUR) }),
      record({ id: 'e1', kind: 'emotion', text: '今天加班到十一点，好累', createdAt: iso(NOW - 8 * HOUR) }),
    ] },
    memories: {
      pendingThoughts: [{ text: '想问问她那个画到底画完没', at: NOW - 90 * MIN }],
      activeTopics: [{ text: '聊到一半的选课', at: NOW - 5 * HOUR, lastMentionAt: NOW - 3 * HOUR }],
    },
    now: NOW,
    config: CFG,
  });
  const kinds = candidates.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['care', 'followup', 'repair', 'share', 'topic']);
  for (let i = 1; i < candidates.length; i++) assert.ok(candidates[i - 1].score >= candidates[i].score, '候选应按 score 降序');
  for (const c of candidates) {
    assert.ok(c.confidence > 0 && c.value > 0 && c.risk >= 0, '每条候选都该带 confidence/value/risk');
    assert.ok(Number.isFinite(c.urgency), '每条候选都该有 urgency');
    assert.equal(c.carrier, 'qq', '默认载体是 qq');
  }
});

test('话题只在聊过又静了 2 小时到 2 天、且存在至少 1 小时时才算惦记', () => {
  const build = (topic) => buildPurposeCandidates({ memories: { activeTopics: [topic] }, now: NOW, config: CFG }).filter((c) => c.kind === 'topic');
  assert.equal(build({ text: '刚聊完', at: NOW - 3 * HOUR, lastMentionAt: NOW - 5 * MIN }).length, 0, '几分钟前还在聊，不算惦记');
  assert.equal(build({ text: '太久没提', at: NOW - 5 * DAY, lastMentionAt: NOW - 3 * DAY }).length, 0, '三天前就凉了，翻出来很怪');
  assert.equal(build({ text: '刚开个头', at: NOW - 20 * MIN, lastMentionAt: NOW - 3 * HOUR }).length, 0, '存在不到一小时，别急着回头');
  const ok = build({ text: '上次说到一半的话题', at: NOW - 4 * HOUR, lastMentionAt: NOW - 3 * HOUR });
  assert.equal(ok.length, 1, '两小时前聊过、之后没动静，正是该惦记的');
  const withQ = build({ text: '她问了我一个问题我没答', at: NOW - 4 * HOUR, lastMentionAt: NOW - 3 * HOUR, pendingQuestion: true });
  assert.ok(withQ[0].value > ok[0].value, '话题里悬着个没答的问题，价值更高');
});

test('刚好聊过（activeChatMs 内）不主动开口：那是插嘴', () => {
  const candidate = { id: 'x', text: '想说的事', kind: 'share', confidence: 0.9, value: 90, urgency: 30, risk: 0, carrier: 'qq', score: 111 };
  const sel = selectPurpose({ candidates: [candidate], state: { lastIncomingAt: NOW - 5 * MIN }, now: NOW, config: CFG });
  assert.equal(sel.action, 'wait');
  assert.ok(sel.blocked.includes('conversation-active'));
  const later = selectPurpose({ candidates: [candidate], state: { lastIncomingAt: NOW - 40 * MIN }, now: NOW, config: CFG });
  assert.equal(later.action, 'speak');
});

test('静默时段跨零点：01:00 不开口，12:00 开口', () => {
  const midnight = Date.parse('2026-10-29T01:00:00+08:00');
  const noon = Date.parse('2026-10-29T12:00:00+08:00');
  assert.equal(inQuietHours(midnight, CFG), true);
  assert.equal(inQuietHours(noon, CFG), false);
  assert.equal(inQuietHours(Date.parse('2026-10-29T23:40:00+08:00'), CFG), true, '23:40 也在静默里');
  assert.equal(inQuietHours(Date.parse('2026-10-29T08:00:00+08:00'), CFG), true, '08:00 还没过 08:30');
  assert.equal(inQuietHours(Date.parse('2026-10-29T09:00:00+08:00'), CFG), false);
  const flipped = normalizePurposeConfig({ quietStart: '09:00', quietEnd: '18:00' });
  assert.equal(inQuietHours(noon, flipped), true);
  assert.equal(inQuietHours(midnight, flipped), false);
});

test('三种节奏闸门：太近 / 今天够了 / 这个目的刚提过', () => {
  const strong = { id: 'p1', text: '答应的事', kind: 'followup', owner: '群友', confidence: 0.8, value: 90, urgency: 30, risk: 5, carrier: 'qq', score: 97 };
  const tooSoon = selectPurpose({ candidates: [strong], state: { lastFireAt: NOW - 10 * MIN }, now: NOW, config: CFG });
  assert.ok(tooSoon.blocked.includes('min-gap'), '十分钟前刚开过口');
  const d = new Date(NOW);
  const localDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const capped = selectPurpose({ candidates: [strong], state: { dailyDate: localDate, dailyCount: 4 }, now: NOW, config: CFG });
  assert.ok(capped.blocked.includes('daily-max'), '一天四次的额度用完了');
  const cooled = selectPurpose({ candidates: [strong], state: { tried: { p1: NOW - 1 * HOUR } }, now: NOW, config: CFG });
  assert.ok(cooled.blocked.includes('cooldown'), '同一个目的一小时前提过');
  const fine = selectPurpose({ candidates: [strong], state: {}, now: NOW, config: CFG });
  assert.equal(fine.action, 'speak');
  assert.equal(fine.purpose.id, 'p1');
});

test('载体互斥：B 站长出来的目的，不在 QQ 里发作', () => {
  const qq = { id: 'q1', text: 'QQ 里的事', kind: 'share', confidence: 0.8, value: 80, urgency: 20, risk: 0, carrier: 'qq', score: 84 };
  const bili = { id: 'b1', text: 'B 站看到的事', kind: 'share', confidence: 0.9, value: 95, urgency: 30, risk: 0, carrier: 'bilibili', score: 100 };
  const sel = selectPurpose({ candidates: [bili, qq], state: {}, now: NOW, config: CFG });
  assert.equal(sel.action, 'speak');
  assert.equal(sel.purpose.id, 'q1', '分更高的 B 站目的要被载体闸门挡掉');
  assert.ok(sel.blocked.includes('carrier-mismatch'));
});

test('分不够就沉默：宁可不说，也别硬找话', () => {
  const weak = { id: 'w1', text: '随便聊聊', kind: 'topic', confidence: 0.4, value: 30, urgency: 0, risk: 10, carrier: 'qq', score: 2 };
  const sel = selectPurpose({ candidates: [weak], state: {}, now: NOW, config: CFG });
  assert.equal(sel.action, 'wait');
  assert.ok(sel.blocked.includes('weak'));
  assert.equal(buildPurposeLine(sel, CFG), '', '没有该提的事就不该有这段提示词');
});

test('状态语义：提过要记（跨日归零），了结要忘（不再提）', () => {
  const state = normalizePurposeState(null);
  markPurposeFired(state, { id: 'p1', text: '答应的事' }, NOW);
  assert.equal(state.dailyCount, 1);
  assert.ok(state.tried.p1);
  markPurposeFired(state, { id: 'p2', text: '另一件' }, NOW + 5 * MIN);
  assert.equal(state.dailyCount, 2, '同一天累加');
  markPurposeFired(state, { id: 'p3', text: '第三件' }, NOW + DAY);
  assert.equal(state.dailyCount, 1, '跨日归零');
  assert.equal(state.tried.p1, NOW, '旧的 tried 记录还在（冷却靠它）');
  resolvePurpose(state, 'p1');
  assert.equal(state.tried.p1, undefined, '了结后从冷却表里摘掉');
  assert.deepEqual(state.resolved, ['p1']);
});

test('提示词：最多两条、带身份标签、措辞是提醒不是命令', () => {
  const candidates = [
    { id: 'a', text: '答应帮她修鼠标', kind: 'followup', confidence: 0.8, value: 90, urgency: 20, risk: 0, carrier: 'qq', score: 92 },
    { id: 'b', text: '她说最近很难受', kind: 'care', confidence: 0.7, value: 70, urgency: 10, risk: 0, carrier: 'qq', score: 59 },
    { id: 'c', text: '第三个不该出现', kind: 'topic', confidence: 0.8, value: 80, urgency: 10, risk: 0, carrier: 'qq', score: 74 },
  ];
  const sel = selectPurpose({ candidates, state: {}, now: NOW, config: CFG });
  const line = buildPurposeLine(sel, CFG);
  assert.match(line, /【心里惦记的事】/);
  assert.match(line, /答应帮她修鼠标/);
  assert.match(line, /答应了还没做的事/, '要标出这是哪一类惦记');
  assert.equal(line.split('\n').filter((l) => l.startsWith('- ') && !l.includes('想提就提')).length, 2, '默认最多两条');
  assert.match(line, /想提就提，不想提就放着/, '是提醒，不是催办');
  assert.doesNotMatch(line, /必须|立刻|马上/, '不要命令式措辞');
  assert.equal(buildPurposeLine(sel, normalizePurposeConfig({ inject: false })), '', 'inject=false 时整段不出现');
});

test('配置归一化：坏值不炸、边界夹紧', () => {
  const cfg = normalizePurposeConfig({ maxItems: 99, dailyMax: 0, minScore: 'x', quietStart: '25:99', minGapMs: 1 });
  assert.equal(cfg.maxItems, 4);
  assert.equal(cfg.dailyMax, 1);
  assert.equal(cfg.minScore, DEFAULT_PURPOSE_CONFIG.minScore, 'NaN 回落到默认值');
  assert.equal(cfg.quietStart, DEFAULT_PURPOSE_CONFIG.quietStart, '非法时钟回落');
  assert.equal(cfg.minGapMs, 30 * MIN, '最小间隔有下限（不能每 1ms 就去撩一下）');
  assert.equal(normalizePurposeConfig({}).enabled, true);
  assert.equal(normalizePurposeConfig({ enabled: false }).enabled, false);
});

test('接线：bridge.js 真的接上了目的引擎（纯函数全绿但没接线等于没做）', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/purpose-engine\.js'/, 'bridge.js 应 import 目的引擎');
  assert.match(source, /purposeConfig = normalizePurposeConfig\(cfg\.purpose \?\? \{\}\);/, '应读取 config.purpose');
  assert.match(source, /const purposeLine = purposeText \?/, '唤醒提示词应带目的');
  assert.match(source, /const base = [^;]*memoryCardLine[^;]*purposeLine[^;]*closureLine[^;]*;/, '目的提示要拼进 base 提示词（记忆卡之后、收束之前）');
  assert.match(source, /if \(purposeSpeak\) prob = Math\.max\(prob,/, '有具体该提的事时应抬高主动机会概率');
  assert.match(source, /markPurposeFired\(purposeState, purposeSel\.purpose/, '真投递后应记一次提过');
  assert.match(source, /'\/api\/purpose'/, '应提供只读端点');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.ok(example.purpose && typeof example.purpose === 'object', 'config.example.json 应包含 purpose 配置块');
  assert.equal(example.purpose.quietStart, DEFAULT_PURPOSE_CONFIG.quietStart);
});
