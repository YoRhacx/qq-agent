// scripts/test-persona-state.mjs — 情绪层 / 好感 / 识海 / 旧账的纯函数与持久化测试。
//
// 运行：ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/test-persona-state.mjs
// 说明：不读写真 state/，每个用例自己 fs.mkdtemp()；时间与 rng 全部可注入，结果可复现。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CORE_MARKER,
  CORE_TRIGGERS,
  DEFAULT_PAD_BASELINE,
  EMOTION_LABELS,
  GRUDGE_MARKER,
  PERSONA_BLOCK_BEGIN,
  PERSONA_BLOCK_END,
  STATE_MARKER,
  addCoreEntry,
  affinityLevel,
  appraiseEmotion,
  createPersonaState,
  extractCoreTrigger,
  isSoothe,
  makeGrudgeEvent,
  normalizePersonaStateConfig,
  pickGrudge,
  renderCoreBlock,
  scoreGrudgeCandidates,
  similarity,
  stripPersonaBlocks,
} from '../src/persona-state.js';

const NOW = Date.parse('2026-10-28T12:00:00+08:00');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-state-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'persona.json');
}

function open(t, config = {}, options = {}) {
  const stateFile = options.stateFile || tempFile(t);
  let clock = options.now ?? NOW;
  const ps = createPersonaState({
    stateFile,
    config,
    now: () => clock,
    rng: options.rng,
  });
  return {
    ps,
    stateFile,
    now: () => clock,
    setClock(value) { clock = value; },
    advance(ms) { clock += ms; },
  };
}

function labelOf(snapshot, name) {
  return (snapshot.state.labels.find((label) => label.name === name) || {}).intensity ?? 0;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

test('配置归一化：接受 snake_case 别名、名单/下限字符串与范围夹取', (t) => {
  const cfg = normalizePersonaStateConfig({
    state_file: 'state/custom-persona.json',
    inject_in_group: false,
    core_max_chars: 99999,
    emotional_memory: false,
    allowed_ids: '1001:主人, 1002:小明',
    floors: '1001:25,1002=40',
    grudge: 130,
    baseline: { p: -0.2, a: 0.1, d: 0.3 },
  });
  assert.equal(cfg.stateFile, 'state/custom-persona.json');
  assert.equal(cfg.injectInGroup, false);
  assert.equal(cfg.coreMaxChars, 20000);
  assert.equal(cfg.emotionalMemory, false);
  assert.deepEqual(cfg.allowed, { 1001: '主人', 1002: '小明' });
  assert.deepEqual(cfg.floors, { 1001: 25, 1002: 40 });
  assert.equal(cfg.grudge, 100);
  assert.deepEqual(cfg.baseline, { pleasure: -0.2, arousal: 0.1, dominance: 0.3 });
  assert.equal(cfg.inject, true);
  assert.equal(cfg.enabled, true);
});

test('情绪标签固定为参考包十个；appraise 最多命中两个且都在标签表内', (t) => {
  assert.deepEqual(
    [...EMOTION_LABELS].sort(),
    ['开心', '生气', '难过', '害怕', '委屈', '害羞', '得意', '感动', '焦虑', '无聊'].sort(),
  );
  const hits = appraiseEmotion('滚，闭嘴，烦死，吓死了，好难过');
  assert.ok(hits.length <= 2);
  for (const hit of hits) assert.ok(EMOTION_LABELS.includes(hit.name));
  assert.equal(hits[0].name, '生气');
});

test('单条消息情绪冲击单轴封顶 0.12，标签强度封顶 0.6', (t) => {
  const { ps } = open(t, { inject: false });
  const before = ps.snapshot(NOW).state;
  const result = ps.observeMessage({
    userId: 'u-anger',
    text: '滚 闭嘴 蠢 笨 烦死 骗子 敷衍 讨厌 吓 怕 危险 恐怖 报警 难过 伤心',
    chatType: 'private',
    at: NOW,
  });
  assert.ok(Math.abs(result.delta.pleasure) <= 0.12 + 1e-9);
  assert.ok(Math.abs(result.delta.arousal) <= 0.12 + 1e-9);
  assert.ok(Math.abs(result.delta.dominance) <= 0.12 + 1e-9);
  const after = ps.snapshot(NOW).state;
  assert.ok(Math.abs(after.valence - before.valence) <= 0.12 + 1e-9);
  for (const label of after.labels) assert.ok(label.intensity <= 0.6 + 1e-9);
});

test('标签 45 分钟半衰期，90 分钟后剩四分之一；PAD 6 小时半衰期回基线', (t) => {
  const { ps, setClock } = open(t, { inject: false });
  ps.observeMessage({
    userId: 'u-happy',
    text: '哈哈 笑死 好笑 可爱 喜欢 好棒 厉害 开心',
    at: NOW,
  });
  const first = ps.snapshot(NOW);
  const intensity = labelOf(first, '开心');
  assert.ok(intensity > 0.2, '开心标签应该被点起来');

  setClock(NOW + 45 * MIN);
  ps.tick(NOW + 45 * MIN);
  const half = labelOf(ps.snapshot(NOW + 45 * MIN), '开心');
  assert.ok(Math.abs(half - intensity * 0.5) <= 0.002, '45 分钟后应剩一半');

  setClock(NOW + 90 * MIN);
  ps.tick(NOW + 90 * MIN);
  const quarter = labelOf(ps.snapshot(NOW + 90 * MIN), '开心');
  assert.ok(Math.abs(quarter - intensity * 0.25) <= 0.002, '90 分钟后应剩四分之一');

  const { ps: ps2, setClock: setClock2 } = open(t, { inject: false });
  ps2.observeMessage({ userId: 'u-sad', text: '滚 闭嘴 烦死', at: NOW });
  const sad = ps2.snapshot(NOW).state.valence;
  assert.ok(sad < DEFAULT_PAD_BASELINE.pleasure - 0.1);
  setClock2(NOW + 6 * HOUR);
  ps2.tick(NOW + 6 * HOUR);
  const recovered = ps2.snapshot(NOW + 6 * HOUR).state.valence;
  const expected = DEFAULT_PAD_BASELINE.pleasure + (sad - DEFAULT_PAD_BASELINE.pleasure) * 0.5;
  assert.ok(Math.abs(recovered - expected) <= 0.002, '6 小时后 PAD 应走完一半回基线');
});

test('被哄/被夸的正向变化只按 0.08 计（道歉与夸奖都算）', (t) => {
  const { ps } = open(t, { inject: false });
  const apology = ps.observeMessage({ userId: 'u1', text: '对不起，别生气了', at: NOW });
  assert.equal(apology.delta.pleasure, 0.08);
  assert.ok(Math.abs(ps.snapshot(NOW).state.valence - 0.13) < 1e-9);
  assert.equal(labelOf(ps.snapshot(NOW), '感动'), 0.08);

  const { ps: ps2 } = open(t, { inject: false });
  const praise = ps2.observeMessage({ userId: 'u2', text: '你好棒，我真的很喜欢你', at: NOW });
  assert.equal(praise.delta.pleasure, 0.08);
  assert.ok(Math.abs(ps2.snapshot(NOW).state.valence - 0.13) < 1e-9);
  assert.equal(isSoothe('你好棒，我真的很喜欢你'), true);
});

test('好感随互动涨落：夸奖每日封顶 +6，辱骂扣 3.5', (t) => {
  const { ps } = open(t, { inject: false });
  for (let i = 0; i < 5; i += 1) {
    ps.observeMessage({ userId: 'u1', text: '谢谢你，好棒', at: NOW });
  }
  let score = ps.snapshot(NOW).affinity[0];
  assert.equal(score.score, 36);
  assert.equal(score.trend, 'up');
  assert.equal(score.level, '眼熟');

  ps.observeMessage({ userId: 'u1', text: '谢谢你，好棒', at: NOW });
  assert.equal(ps.snapshot(NOW).affinity[0].score, 36, '每日正向封顶后不再上涨');

  ps.observeMessage({ userId: 'u1', text: '滚，烦死', at: NOW + 1 });
  const afterInsult = ps.snapshot(NOW + 1).affinity[0];
  assert.equal(afterInsult.score, 32.5);
  assert.equal(afterInsult.trend, 'down');
});

test('好感 floors 下限生效，单次手动调整封顶 ±10', (t) => {
  const { ps } = open(t, { inject: false, floors: { u1: 20 } });
  const first = ps.adjustAffinity({ userId: 'u1', delta: -100, at: NOW });
  assert.equal(first.score, 20);
  assert.equal(first.floor, 20);
  for (let i = 0; i < 5; i += 1) ps.adjustAffinity({ userId: 'u1', delta: -100, at: NOW + i + 1 });
  assert.equal(ps.snapshot(NOW + 10).affinity[0].score, 20, '下限之下扣不动');
  const raised = ps.adjustAffinity({ userId: 'u1', delta: 100, at: NOW + 11 });
  assert.equal(raised.delta, 10);
  assert.equal(raised.score, 30);
  assert.equal(affinityLevel(30), '眼熟');
});

test('久不联系缓慢回落：7 天宽限后每天 -1，floor 拦得住', (t) => {
  const start = NOW - 20 * DAY;
  const { ps } = open(t, { inject: false });
  ps.observeMessage({ userId: 'u1', text: '今天天气不错', at: start });
  const before = ps.snapshot(start).affinity[0].score;
  assert.ok(Math.abs(before - 30.35) < 1e-9);
  ps.tick(NOW);
  const after = ps.snapshot(NOW).affinity[0].score;
  assert.ok(Math.abs(after - (before - 13)) < 0.02, '20 天只扣 13 天，每天 1 分');

  const { ps: floored } = open(t, { inject: false, floors: { u1: 20 } });
  floored.observeMessage({ userId: 'u1', text: '今天天气不错', at: start });
  floored.tick(NOW);
  assert.equal(floored.snapshot(NOW).affinity[0].score, 20);
});

test('识海触发词：永远记住 / 记住这个 / 别忘了；普通「记住」不算', (t) => {
  assert.equal(extractCoreTrigger('记住带伞'), null);
  assert.equal(extractCoreTrigger('今天天气不错'), null);
  assert.deepEqual(extractCoreTrigger('永远记住 我对芒果过敏'), { trigger: '永远记住', text: '我对芒果过敏' });
  assert.deepEqual(extractCoreTrigger('记住这个：猫叫咪咪'), { trigger: '记住这个', text: '猫叫咪咪' });
  assert.deepEqual(extractCoreTrigger('别忘了，我讨厌香菜'), { trigger: '别忘了', text: '我讨厌香菜' });
  assert.ok(CORE_TRIGGERS.includes('永远记住'));
  assert.ok(CORE_TRIGGERS.includes('别忘了'));
});

test('识海捕获、去重、删除；群里按 captureInGroup 开关', (t) => {
  const { ps } = open(t, { inject: false });
  const one = ps.observeMessage({ userId: '1001', name: '主人', text: '永远记住 我对芒果过敏', at: NOW });
  assert.equal(one.core.added, true);
  assert.equal(one.core.entry.by, '主人');
  const two = ps.observeMessage({ userId: '1001', text: '永远记住，我对芒果过敏！', at: NOW + 1 });
  assert.equal(two.core.added, false, '去标点后同一条不重复记');
  assert.equal(ps.snapshot(NOW + 1).core.items.length, 1);
  const id = ps.snapshot(NOW + 1).core.items[0].id;
  assert.equal(ps.removeCore(id).ok, true);
  assert.equal(ps.snapshot(NOW + 1).core.items.length, 0);

  const { ps: groupOff } = open(t, { inject: false, captureInGroup: false });
  groupOff.observeMessage({ userId: '1001', chatType: 'group', text: '永远记住 群里的秘密', at: NOW });
  assert.equal(groupOff.snapshot(NOW).core.items.length, 0);
  const { ps: groupOn } = open(t, { inject: false, captureInGroup: true });
  groupOn.observeMessage({ userId: '1001', chatType: 'group', text: '永远记住 群里的秘密', at: NOW });
  assert.equal(groupOn.snapshot(NOW).core.items.length, 1);
});

test('coreFromAllowedOnly：名单外的人写不进识海', (t) => {
  const { ps } = open(t, {
    inject: false,
    coreFromAllowedOnly: true,
    allowed: { 1001: '主人' },
  });
  ps.observeMessage({ userId: '9999', name: '陌生人', text: '永远记住 我的秘密', at: NOW });
  assert.equal(ps.snapshot(NOW).core.items.length, 0);
  ps.observeMessage({ userId: '1001', text: '永远记住 我的秘密', at: NOW + 1 });
  const snap = ps.snapshot(NOW + 1);
  assert.equal(snap.core.items.length, 1);
  assert.equal(snap.core.items[0].by, '主人');
});

test('识海注入总预算 2400 字：超了截断并注明，不超 2400', (t) => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    text: '第' + (index + 1) + '条' + '记'.repeat(290),
    by: '主人',
    date: '2026-10-28',
  }));
  const block = renderCoreBlock(entries, { coreMaxChars: 2400 });
  assert.ok(block.length <= 2400, '注入块长度必须 <= 2400');
  assert.ok(block.includes(CORE_MARKER));
  assert.match(block, /未展开|已截断/);

  const { ps } = open(t, { inject: true });
  for (let i = 0; i < 12; i += 1) {
    ps.addCore('第' + i + '条' + '记'.repeat(290), { by: '主人', userId: '1001', at: NOW });
  }
  assert.ok(ps.snapshot(NOW).core.chars > 2400);
  const full = ps.buildPersonaBlock({ chatType: 'private', at: NOW });
  assert.ok(full.includes(CORE_MARKER));
  assert.match(full, /未展开|已截断/);
});

test('旧账：普通消息不记，大情绪才记；关掉 emotionalMemory 不记', (t) => {
  const { ps } = open(t, { inject: false });
  ps.observeMessage({ userId: 'u1', text: '今天吃了饭', at: NOW });
  assert.equal(ps.snapshot(NOW).grudges.length, 0);
  const result = ps.observeMessage({ userId: 'u1', text: '滚，烦死', at: NOW + 1 });
  assert.equal(result.grudge.recorded, true);
  assert.equal(result.recall, null, '刚记下的旧账不能在同一条消息里立刻翻出来');
  const grudge = ps.snapshot(NOW + 2).grudges[0];
  assert.ok(grudge);
  assert.equal(typeof grudge.topic, 'string');
  assert.equal(typeof grudge.weight, 'number');
  assert.equal(typeof grudge.ageDays, 'number');

  const { ps: off } = open(t, { inject: false, emotionalMemory: false });
  off.observeMessage({ userId: 'u1', text: '滚，烦死', at: NOW });
  assert.equal(off.snapshot(NOW).grudges.length, 0);
});

test('旧账触发概率：同话题 45–60%，只是情绪差 15–20%，rng 可决定翻不翻', (t) => {
  const event = makeGrudgeEvent({
    userId: 'u1',
    userName: '主人',
    text: '你说过不会丢下我',
    delta: -0.12,
    now: NOW,
  });
  const sameTopic = scoreGrudgeCandidates([event], {
    userId: 'u1',
    currentText: '你说过不会丢下我',
    currentDelta: -0.02,
    currentPleasure: -0.3,
    grudge: 45,
    now: NOW + DAY,
  });
  assert.equal(sameTopic.length, 1);
  assert.ok(sameTopic[0].probability >= 45 && sameTopic[0].probability <= 60);
  assert.ok(sameTopic[0].similarity >= 0.9);

  const emotionOnly = scoreGrudgeCandidates([event], {
    userId: 'u1',
    currentText: '今天好热',
    currentDelta: -0.05,
    currentPleasure: -0.3,
    grudge: 45,
    now: NOW + DAY,
  });
  assert.equal(emotionOnly.length, 1);
  assert.ok(emotionOnly[0].probability >= 15 && emotionOnly[0].probability <= 20);

  const highGrudge = scoreGrudgeCandidates([event], {
    userId: 'u1',
    currentText: '你说过不会丢下我',
    currentDelta: -0.02,
    currentPleasure: -0.3,
    grudge: 100,
    now: NOW + DAY,
  });
  assert.ok(highGrudge[0].probability > sameTopic[0].probability);
  assert.ok(highGrudge[0].probability <= 60);

  assert.ok(pickGrudge(sameTopic, () => 0));
  assert.equal(pickGrudge(emotionOnly, () => 0.19), null);
  assert.ok(pickGrudge(emotionOnly, () => 0.18));
});

test('旧账注入有 marker，注入一次后消费掉，不会每次都说', (t) => {
  const { ps } = open(t, { inject: true }, { rng: () => 0 });
  ps.observeMessage({ userId: 'u1', text: '滚，烦死', at: NOW });
  const recalled = ps.observeMessage({ userId: 'u1', text: '滚，烦死', at: NOW + MIN });
  assert.ok(recalled.recall, 'rng=0 时应该翻出旧账');
  const block = ps.buildPersonaBlock({ chatType: 'private', at: NOW + MIN });
  assert.ok(block.includes(GRUDGE_MARKER));
  assert.ok(block.includes(PERSONA_BLOCK_BEGIN) && block.includes(PERSONA_BLOCK_END));
  const again = ps.buildPersonaBlock({ chatType: 'private', at: NOW + MIN + 1 });
  assert.equal(again.includes(GRUDGE_MARKER), false, '旧账块只注入一次');
});

test('注入块 marker、识海最高优先级、好感前 3、stripPersonaBlocks 清理', (t) => {
  const { ps } = open(t, { inject: true });
  ps.observeMessage({ userId: 'u1', name: '主人', text: '谢谢你，好棒', at: NOW });
  ps.addCore('我对芒果过敏', { by: '主人', userId: '1001', at: NOW });
  const block = ps.buildPersonaBlock({ chatType: 'private', at: NOW });
  assert.ok(block.startsWith(PERSONA_BLOCK_BEGIN));
  assert.ok(block.endsWith(PERSONA_BLOCK_END));
  assert.ok(block.includes(STATE_MARKER));
  assert.ok(block.includes(CORE_MARKER));
  assert.ok(block.indexOf(CORE_MARKER) < block.indexOf(STATE_MARKER), '识海要排在状态前面');

  const wrapped = '前文\n\n' + block + '\n\n后文';
  const stripped = stripPersonaBlocks(wrapped);
  assert.equal(stripped.includes(PERSONA_BLOCK_BEGIN), false);
  assert.ok(stripped.includes('前文'));
  assert.ok(stripped.includes('后文'));
  assert.equal(stripPersonaBlocks(stripped), stripped, '清理应幂等');
  assert.equal(stripPersonaBlocks('a\n' + PERSONA_BLOCK_BEGIN + '\nb'), 'a', '残块也要清');

  const { ps: top } = open(t, { inject: true });
  for (let i = 1; i <= 4; i += 1) top.adjustAffinity({ userId: 'u' + i, delta: 5 + i, at: NOW });
  const topBlock = top.buildPersonaBlock({ chatType: 'private', at: NOW });
  const affinityLine = topBlock.split('\n').find((line) => line.startsWith('好感：'));
  assert.ok(affinityLine);
  assert.equal(affinityLine.split('、').length, 3, '只注入好感前 3');
  assert.ok(affinityLine.includes('u4'));
  assert.equal(affinityLine.includes('u1'), false);
});

test('群聊按 injectInGroup 开关：关掉返回空串，私聊不受影响', (t) => {
  const { ps } = open(t, { inject: true, injectInGroup: false });
  ps.observeMessage({ userId: 'u1', text: '谢谢你，好棒', at: NOW });
  assert.ok(ps.buildPersonaBlock({ chatType: 'private', at: NOW }).length > 0);
  assert.equal(ps.buildPersonaBlock({ chatType: 'group', at: NOW }), '');
});

test('enabled=false：所有方法空转，不建状态文件', (t) => {
  const { ps, stateFile } = open(t, { enabled: false });
  const observed = ps.observeMessage({ userId: 'u1', text: '永远记住 我的秘密', at: NOW });
  assert.equal(observed.disabled, true);
  assert.equal(ps.adjustMood({ delta: 0.2, at: NOW }).disabled, true);
  assert.equal(ps.adjustAffinity({ userId: 'u1', delta: 5, at: NOW }).disabled, true);
  assert.equal(ps.tick(NOW).disabled, true);
  assert.equal(ps.addCore('测试', { at: NOW }).disabled, true);
  assert.equal(ps.reset().disabled, true);
  assert.equal(ps.buildPersonaBlock({ chatType: 'private', at: NOW }), '');
  const snap = ps.snapshot(NOW);
  assert.equal(snap.enabled, false);
  assert.deepEqual(snap.affinity, []);
  assert.deepEqual(snap.core.items, []);
  assert.equal(fs.existsSync(stateFile), false, '关掉时不能建文件');
});

test('inject=false 仍记录（灰度）：有状态、有快照，但不生成注入块', (t) => {
  const { ps, stateFile } = open(t, { inject: false });
  ps.observeMessage({ userId: 'u1', text: '谢谢你，好棒', at: NOW });
  assert.equal(ps.buildPersonaBlock({ chatType: 'private', at: NOW }), '');
  assert.equal(ps.snapshot(NOW).affinity[0].score, 31.2);
  assert.ok(fs.existsSync(stateFile));
});

test('affinity=false：不记好感、不注入好感（已有历史仍可查）', (t) => {
  const { ps } = open(t, { inject: true, affinity: false });
  ps.observeMessage({ userId: 'u1', text: '谢谢你，好棒', at: NOW });
  assert.equal(ps.snapshot(NOW).affinity.length, 0);
  assert.equal(ps.buildPersonaBlock({ chatType: 'private', at: NOW }).includes('好感：'), false);
});

test('coreCapture=false：只停自动捕获，手动识海仍能注入', (t) => {
  const { ps } = open(t, { inject: true, coreCapture: false });
  ps.observeMessage({ userId: 'u1', text: '永远记住 我的秘密', at: NOW });
  assert.equal(ps.snapshot(NOW).core.items.length, 0);
  ps.addCore('手动写进去的条目', { by: '测试', at: NOW + 1 });
  assert.ok(ps.buildPersonaBlock({ chatType: 'private', at: NOW + 1 }).includes('手动写进去的条目'));
});

test('重启后续存：情绪/好感/识海/旧账都从同一个 JSON 恢复', (t) => {
  const stateFile = tempFile(t);
  const config = { inject: false };
  const first = createPersonaState({ stateFile, config, now: () => NOW });
  first.observeMessage({ userId: '1001', name: '主人', text: '你好棒，谢谢你', at: NOW });
  first.observeMessage({ userId: '1001', text: '永远记住 我对芒果过敏', at: NOW + 1 });
  first.observeMessage({ userId: '1001', text: '滚，烦死', at: NOW + 2 });
  first.adjustAffinity({ userId: '1001', delta: 5, at: NOW + 3 });
  const before = first.snapshot(NOW + 3);
  assert.ok(fs.existsSync(stateFile));

  const second = createPersonaState({ stateFile, config, now: () => NOW + 3 });
  const after = second.snapshot(NOW + 3);
  assert.deepEqual(after.state.labels, before.state.labels);
  assert.equal(after.core.items[0].text, '我对芒果过敏');
  assert.equal(after.affinity[0].score, before.affinity[0].score);
  assert.equal(after.grudges.length, 1);
  assert.equal(after.grudges[0].topic, '滚，烦死');
});

test('snapshot 字段齐全：state/affinity/core/grudges 的形状与类型', (t) => {
  const { ps } = open(t, { inject: false });
  ps.observeMessage({ userId: '1001', name: '主人', text: '你好棒，谢谢你', at: NOW });
  ps.observeMessage({ userId: '1001', text: '永远记住 我对芒果过敏', at: NOW + 1 });
  ps.observeMessage({ userId: '1001', text: '滚，烦死', at: NOW + 2 });
  const snap = ps.snapshot(NOW + 2);

  assert.deepEqual(Object.keys(snap).sort(), ['affinity', 'config', 'core', 'enabled', 'generatedAt', 'grudges', 'state']);
  assert.equal(typeof snap.enabled, 'boolean');
  assert.equal(typeof snap.generatedAt, 'string');

  assert.deepEqual(
    Object.keys(snap.state).sort(),
    ['arousal', 'description', 'dominance', 'labels', 'mood', 'trigger', 'updatedAt', 'valence'],
  );
  for (const axis of ['valence', 'arousal', 'dominance']) {
    assert.ok(Number.isFinite(snap.state[axis]));
    assert.ok(snap.state[axis] >= -1 && snap.state[axis] <= 1);
  }
  assert.equal(typeof snap.state.mood, 'string');
  assert.ok(Array.isArray(snap.state.labels));
  for (const label of snap.state.labels) {
    assert.deepEqual(Object.keys(label).sort(), ['intensity', 'name']);
  }

  assert.equal(snap.affinity.length, 1);
  const affinity = snap.affinity[0];
  assert.equal(affinity.userId, '1001');
  assert.equal(affinity.name, '主人');
  assert.ok(affinity.score >= 0 && affinity.score <= 100);
  assert.ok(['up', 'down', 'flat'].includes(affinity.trend));

  assert.ok(Number.isInteger(snap.core.chars));
  assert.equal(snap.core.chars, 6);
  assert.ok(Array.isArray(snap.core.items));
  assert.equal(snap.core.items[0].text, '我对芒果过敏');

  assert.equal(snap.grudges.length, 1);
  const grudge = snap.grudges[0];
  assert.ok(Number.isInteger(grudge.id));
  assert.equal(typeof grudge.topic, 'string');
  assert.ok(grudge.weight >= 0 && grudge.weight <= 100);
  assert.ok(grudge.ageDays >= 0);
  assert.equal(typeof grudge.emotion, 'string');
  assert.equal(grudge.resolved, false);
});

test('adjustMood 手动调整封顶 ±0.2，reset 清空全部状态', (t) => {
  const { ps } = open(t, { inject: false });
  const raised = ps.adjustMood({ delta: 1, reason: '测试', at: NOW });
  assert.equal(round3(raised.state.valence), 0.25);
  const vector = ps.adjustMood({ delta: { pleasure: 1, arousal: -1, dominance: 0.5 }, at: NOW + 1 });
  assert.equal(vector.delta.pleasure, 0.2);
  assert.equal(vector.delta.arousal, -0.2);
  assert.equal(vector.delta.dominance, 0.2);

  ps.observeMessage({ userId: 'u1', text: '永远记住 我对芒果过敏', at: NOW + 2 });
  ps.observeMessage({ userId: 'u1', text: '滚，烦死', at: NOW + 3 });
  assert.ok(ps.snapshot(NOW + 3).core.items.length > 0);
  ps.reset({ at: NOW + 4 });
  const snap = ps.snapshot(NOW + 4);
  assert.deepEqual(snap.affinity, []);
  assert.deepEqual(snap.core.items, []);
  assert.deepEqual(snap.grudges, []);
  assert.deepEqual(snap.state.labels, []);
  assert.equal(snap.state.valence, DEFAULT_PAD_BASELINE.pleasure);
  assert.equal(JSON.stringify(snap).includes('我对芒果过敏'), false);
});

test('纯函数：相似度与默认配置边界', (t) => {
  assert.equal(similarity('你说过不会丢下我', '你说过不会丢下我'), 1);
  assert.ok(similarity('你说过不会丢下我', '今天好热') < 0.2);
  const defaults = normalizePersonaStateConfig({});
  assert.equal(defaults.stateFile, 'state/persona-state.json');
  assert.equal(defaults.coreMaxChars, 2400);
  assert.equal(defaults.grudge, 45);
  assert.equal(defaults.labelHalfLifeMin, 45);
  assert.equal(defaults.soothePositive, 0.08);
  assert.equal(defaults.maxStep, 0.12);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.inject, true);
  assert.equal(defaults.injectInGroup, true);
});
