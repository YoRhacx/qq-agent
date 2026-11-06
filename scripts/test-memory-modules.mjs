// ─────────────────────────────────────────────────────────────────────────────
// scripts/test-memory-modules.mjs — 记忆层三件套（画像 / 每日反思 / 程序记忆）的单测。
//
// 只测纯函数 + 状态文件行为，全部写临时目录（fs.mkdtemp），绝不碰真 state/。
// 跑法：ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/test-memory-modules.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PROFILE_CONFIG,
  buildProfileText,
  collectInputsFromMemoryBrain,
  createProfileBuilder,
  normalizeProfileConfig
} from '../src/memory-profile.js';
import {
  DEFAULT_REFLECTION_CONFIG,
  buildReflectionText,
  createReflectionWriter,
  pickDayMemories
} from '../src/memory-reflection.js';
import {
  DEFAULT_PROCEDURAL_CONFIG,
  createProceduralStore,
  extractSkillsFromMemories,
  parseSkillText,
  skillSimilarity
} from '../src/memory-procedural.js';

const DAY = 86400000;
const T0 = Date.parse('2026-10-28T12:00:00+08:00');

function tmpDir(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-' + tag + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mem(id, text, entities, createdAt, extra = {}) {
  return { id, kind: 'episode', text, entities, createdAt, importance: 0.6, ...extra };
}

// 一个「够写画像」的实体：5 条记忆，覆盖称呼、偏好、雷点、时间跨度
function richMemories(base = T0) {
  return [
    mem('m1', '主人：小鲸鱼今天又把日志翻了一遍，说喜欢在夜里看群聊', ['小鲸鱼'], base - 30 * DAY, { importance: 0.8 }),
    mem('m2', '主人：小鲸鱼的外号是鱼鱼，叫起来顺口', ['小鲸鱼'], base - 20 * DAY, { importance: 0.7 }),
    mem('m3', '主人：小鲸鱼讨厌太甜的奶茶，说喝完嘴里发腻', ['小鲸鱼'], base - 10 * DAY, { importance: 0.9 }),
    mem('m4', '主人：小鲸鱼喜欢冰美式，早上要喝一杯才醒', ['小鲸鱼'], base - 2 * DAY, { importance: 0.85 }),
    mem('m5', '主人：小鲸鱼说下次别在群里 @ 所有人，会吓到人', ['小鲸鱼'], base - 1 * DAY, { importance: 0.75 })
  ];
}

// ── 画像 ─────────────────────────────────────────────────────────────────────

test('画像：实体只出现一次（degree=1）不生成', (t) => {
  const dir = tmpDir(t, 'p-threshold');
  const statePath = path.join(dir, 'profile.json');
  const builder = createProfileBuilder({ statePath, config: { minDegree: 2 }, now: () => T0 });
  const input = {
    memories: [
      mem('a1', '主人：阿澈今天来了', ['阿澈'], T0 - DAY),
      ...richMemories(T0)
    ]
  };
  const first = builder.build(input);
  assert.equal(first.ok, true);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].name, '小鲸鱼');
  assert.equal(first.created[0].degree, 5);

  // 补第二条阿澈的记忆 → 到阈值，这次就能生成（换一天，避开 7 天缓存）
  const later = T0 + 8 * DAY;
  const builder2 = createProfileBuilder({ statePath, config: { minDegree: 2 }, now: () => later });
  const second = builder2.build({
    memories: [
      mem('a1', '主人：阿澈今天来了', ['阿澈'], later - DAY),
      mem('a2', '主人：阿澈说想学怎么做饭', ['阿澈'], later - 3600000),
      ...richMemories(later)
    ]
  });
  assert.deepEqual(second.created.map((item) => item.name), ['阿澈']);
  assert.deepEqual(second.updated.map((item) => item.name), ['小鲸鱼']);
  assert.equal(second.total, 2);
});

test('画像：正文是 200~400 字的第三人称描述', (t) => {
  const dir = tmpDir(t, 'p-length');
  const statePath = path.join(dir, 'profile.json');
  const builder = createProfileBuilder({ statePath, now: () => T0 });
  const result = builder.build({ memories: richMemories() });
  assert.equal(result.created.length, 1);
  const profile = result.created[0].profile;
  assert.ok(profile.length >= DEFAULT_PROFILE_CONFIG.minChars, '太短了：' + profile.length);
  assert.ok(profile.length <= DEFAULT_PROFILE_CONFIG.maxChars, '太长了：' + profile.length);
  assert.ok(profile.includes('小鲸鱼'));
  // 事实不够时不注水：只有两条短记忆 → 允许短于 minChars，但不能报错/编造
  const thin = buildProfileText(
    { name: '阿澈', type: 'person', degree: 2, memories: [mem('x1', '阿澈来了', ['阿澈'], T0), mem('x2', '阿澈走了', ['阿澈'], T0)] },
    DEFAULT_PROFILE_CONFIG
  );
  assert.ok(thin.length > 0 && thin.length < DEFAULT_PROFILE_CONFIG.minChars);
  assert.ok(thin.includes('阿澈'));
});

test('画像：每天最多生成 maxPerRun 个', (t) => {
  const dir = tmpDir(t, 'p-cap');
  const statePath = path.join(dir, 'profile.json');
  const builder = createProfileBuilder({ statePath, config: { maxPerRun: 2 }, now: () => T0 });
  const memories = [];
  for (let i = 0; i < 5; i += 1) {
    const name = '实体' + i;
    memories.push(mem('e' + i + 'a', '主人：' + name + '今天说了喜欢猫', [name], T0 - 3600000 * (i + 2)));
    memories.push(mem('e' + i + 'b', '主人：' + name + '昨天也在，讨厌下雨', [name], T0 - 7200000 * (i + 2)));
  }
  const result = builder.build({ memories });
  assert.equal(result.created.length, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.skipped.filter((item) => item.reason === 'budget').length, 3);
});

test('画像：同一天重跑幂等，7 天后才更新', (t) => {
  const dir = tmpDir(t, 'p-interval');
  const statePath = path.join(dir, 'profile.json');
  const input = { memories: richMemories() };

  const builder = createProfileBuilder({ statePath, now: () => T0 });
  const first = builder.build(input);
  assert.equal(first.created.length, 1);
  const snapshot = fs.readFileSync(statePath, 'utf8');

  // 同一天再跑：不重写、文件一个字节都不变
  const again = createProfileBuilder({ statePath, now: () => T0 + 3600000 }).build(input);
  assert.equal(again.created.length, 0);
  assert.equal(again.updated.length, 0);
  assert.equal(again.skipped[0].reason, 'today');
  assert.equal(fs.readFileSync(statePath, 'utf8'), snapshot);

  // 第 3 天：还没满 7 天 → 跳过
  const day3 = createProfileBuilder({ statePath, now: () => T0 + 3 * DAY }).build(input);
  assert.equal(day3.created.length, 0);
  assert.equal(day3.updated.length, 0);
  assert.equal(day3.skipped[0].reason, 'interval');

  // 第 8 天：满 7 天 → 更新同一条（不是新增）
  const day8 = createProfileBuilder({ statePath, now: () => T0 + 8 * DAY }).build(input);
  assert.equal(day8.created.length, 0);
  assert.equal(day8.updated.length, 1);
  assert.equal(day8.updated[0].name, '小鲸鱼');
  assert.equal(day8.updated[0].degree, 5);
});

test('画像：空输入不报错、也不建状态文件', (t) => {
  const dir = tmpDir(t, 'p-empty');
  const statePath = path.join(dir, 'profile.json');
  const builder = createProfileBuilder({ statePath, now: () => T0 });
  const result = builder.build({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.created, []);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(builder.render({ names: ['小鲸鱼'] }), '');
});

test('画像：开关关掉不建文件、不返回内容', (t) => {
  const dir = tmpDir(t, 'p-off');
  const statePath = path.join(dir, 'profile.json');
  const builder = createProfileBuilder({ statePath, config: { enabled: false }, now: () => T0 });
  const result = builder.build({ memories: richMemories() });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.created, []);
  assert.equal(fs.existsSync(statePath), false);
  assert.deepEqual(builder.list(), []);
  assert.equal(builder.render(), '');
});

test('画像：状态文件能读回（重建实例后 list/get 还在）', (t) => {
  const dir = tmpDir(t, 'p-persist');
  const statePath = path.join(dir, 'profile.json');
  createProfileBuilder({ statePath, now: () => T0 }).build({ memories: richMemories() });
  const reopened = createProfileBuilder({ statePath, now: () => T0 });
  const items = reopened.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].entityId, '小鲸鱼');
  assert.ok(reopened.get('小鲸鱼'));
  assert.equal(reopened.get('不存在的人'), null);
  const block = reopened.render({ maxChars: 200 });
  assert.ok(block.includes('【人物印象】'));
  assert.ok(block.includes('小鲸鱼'));
});

test('画像：配置同时认驼峰与蛇形别名', () => {
  const cfg = normalizeProfileConfig({
    profile_min_degree: 3,
    profile_max_per_run: 7,
    profile_interval_days: 5
  });
  assert.equal(cfg.minDegree, 3);
  assert.equal(cfg.maxPerRun, 7);
  assert.equal(cfg.intervalDays, 5);
});

// ── 每日反思 ─────────────────────────────────────────────────────────────────

test('反思：只取当天记忆，摘要里不出现昨天的事', (t) => {
  const dir = tmpDir(t, 'r-day');
  const statePath = path.join(dir, 'reflection.json');
  const writer = createReflectionWriter({ statePath, now: () => T0 });
  const result = writer.run({
    memories: [
      mem('y1', '主人：昨天在聊生日蛋糕', [], T0 - DAY),
      mem('t1', '主人：今天把 3100 端口修好了', [], T0 - 3600000, { importance: 0.9 }),
      mem('t2', '主人：晚上一起看了会儿番', [], T0 - 1800000)
    ]
  });
  assert.equal(result.created, true);
  assert.equal(result.memoryCount, 2);
  assert.ok(result.summary.includes('端口'));
  assert.ok(!result.summary.includes('生日'));
  assert.equal(result.highlights.length, 2);
  assert.ok(pickDayMemories([
    { createdAt: T0 }, { createdAt: T0 - DAY }
  ], '2026-10-28').length === 1);
});

test('反思：同一天只写一条（第二次原样返回）', (t) => {
  const dir = tmpDir(t, 'r-once');
  const statePath = path.join(dir, 'reflection.json');
  const memories = [mem('t1', '主人：今天在改 memory 模块', [], T0 - 3600000)];
  const first = createReflectionWriter({ statePath, now: () => T0 }).run({ memories });
  assert.equal(first.created, true);
  const snapshot = fs.readFileSync(statePath, 'utf8');

  const second = createReflectionWriter({ statePath, now: () => T0 + 7200000 }).run({ memories });
  assert.equal(second.created, false);
  assert.equal(second.reason, 'already');
  assert.equal(second.summary, first.summary);
  assert.equal(fs.readFileSync(statePath, 'utf8'), snapshot);
});

test('反思：只保留最近 30 天', (t) => {
  const dir = tmpDir(t, 'r-keep');
  const statePath = path.join(dir, 'reflection.json');
  const items = [];
  for (let i = 1; i <= 30; i += 1) {
    const date = '2026-09-' + String(i).padStart(2, '0');
    items.push({ date, summary: '第 ' + i + ' 天的回想', highlights: [], createdAt: '', memoryCount: 3 });
  }
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, items, updatedAt: '' }), 'utf8');

  const result = createReflectionWriter({ statePath, now: () => T0 }).run({
    memories: [mem('n1', '主人：今天新写了一条', [], T0 - 60000)]
  });
  assert.equal(result.created, true);
  const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(stored.items.length, 30);
  assert.equal(stored.items[0].date, '2026-09-02');
  assert.equal(stored.items[stored.items.length - 1].date, '2026-10-28');
});

test('反思：当天没有记忆就不写；空输入不报错', (t) => {
  const dir = tmpDir(t, 'r-empty');
  const statePath = path.join(dir, 'reflection.json');
  const writer = createReflectionWriter({ statePath, now: () => T0 });
  const result = writer.run({ memories: [mem('y1', '昨天的事', [], T0 - DAY)] });
  assert.equal(result.created, false);
  assert.equal(result.reason, 'empty');
  assert.equal(fs.existsSync(statePath), false);
  assert.deepEqual(buildReflectionText([], DEFAULT_REFLECTION_CONFIG), { summary: '', highlights: [] });
});

test('反思：开关关掉不建文件', (t) => {
  const dir = tmpDir(t, 'r-off');
  const statePath = path.join(dir, 'reflection.json');
  const writer = createReflectionWriter({ statePath, config: { enabled: false }, now: () => T0 });
  const result = writer.run({ memories: [mem('t1', '今天的事', [], T0)] });
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(statePath), false);
  assert.deepEqual(writer.list(), []);
  assert.equal(writer.render(), '');
});

// ── 程序记忆 ─────────────────────────────────────────────────────────────────

test('技能：解析「任务：1. …；2. …」格式的 skill 记忆', () => {
  const parsed = parseSkillText('部署服务：1. 重启 bridge；2. 检查 3100 端口');
  assert.ok(parsed);
  assert.equal(parsed.name, '部署服务');
  assert.deepEqual(parsed.steps, ['重启 bridge', '检查 3100 端口']);
  assert.equal(parseSkillText('只有一句话没有冒号'), null);
});

test('技能：从「做了一串事 + 被认可」的流程里抽出来', (t) => {
  const dir = tmpDir(t, 's-flow');
  const statePath = path.join(dir, 'procedural.json');
  const store = createProceduralStore({ statePath, now: () => T0 });
  const result = store.extract({
    memories: [
      mem('f1', '主人：帮我把 bridge 重启一下', [], T0 - 600000),
      mem('f2', '主人：然后查一下 3100 端口有没有起来', [], T0 - 540000),
      mem('f3', '主人：搞定了，谢谢', [], T0 - 480000)
    ]
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].steps.length, 2);
  assert.equal(result.added[0].uses, 0);
  assert.equal(result.total, 1);
});

test('技能：没被认可的流程不抽；空输入不报错也不建文件', (t) => {
  const dir = tmpDir(t, 's-noapproval');
  const statePath = path.join(dir, 'procedural.json');
  const store = createProceduralStore({ statePath, now: () => T0 });
  const none = store.extract({
    memories: [
      mem('n1', '主人：帮我重启 bridge', [], T0 - 300000),
      mem('n2', '主人：再查一下端口', [], T0 - 240000)
    ]
  });
  assert.equal(none.added.length, 0);
  assert.equal(fs.existsSync(statePath), false);

  const empty = store.extract({ memories: [] });
  assert.deepEqual(empty.added, []);
  assert.equal(fs.existsSync(statePath), false);
});

test('技能：use({name, ok}) 更新使用次数与成功率', (t) => {
  const dir = tmpDir(t, 's-use');
  const statePath = path.join(dir, 'procedural.json');
  const store = createProceduralStore({ statePath, now: () => T0 });
  store.extract({ memories: [mem('k1', '部署服务：1. 重启 bridge；2. 检查 3100 端口', [], T0, { kind: 'skill' })] });

  const okOnce = store.use({ name: '部署服务', ok: true });
  assert.equal(okOnce.found, true);
  assert.equal(okOnce.uses, 1);
  assert.equal(okOnce.successes, 1);
  assert.equal(okOnce.successRate, 1);

  const failOnce = store.use({ name: '部署服务', ok: false });
  assert.equal(failOnce.uses, 2);
  assert.equal(failOnce.successes, 1);
  assert.equal(failOnce.failures, 1);
  assert.equal(failOnce.successRate, 0.5);

  const missing = store.use({ name: '根本没记过的事', ok: true });
  assert.equal(missing.found, false);
  assert.equal(missing.reason, 'not-found');
});

test('技能：命中相似任务时返回可复用步骤', (t) => {
  const dir = tmpDir(t, 's-match');
  const statePath = path.join(dir, 'procedural.json');
  const store = createProceduralStore({ statePath, now: () => T0 });
  store.extract({ memories: [mem('k1', '部署服务：1. 重启 bridge；2. 检查 3100 端口', [], T0, { kind: 'skill' })] });

  const hits = store.match('部署服务要怎么做');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, '部署服务');
  assert.deepEqual(hits[0].steps, ['重启 bridge', '检查 3100 端口']);
  assert.ok(hits[0].score >= DEFAULT_PROCEDURAL_CONFIG.matchMinScore);
  assert.deepEqual(store.match('今天天气不错呀'), []);

  const block = store.render({ query: '部署服务要怎么做' });
  assert.ok(block.includes('【这样做过】'));
  assert.ok(block.includes('重启 bridge'));
  assert.ok(skillSimilarity('部署服务', '部署服务') > 0.9);
  assert.equal(skillSimilarity('部署服务', ''), 0);
});

test('技能：重复抽取是幂等的（不重复记、不重写文件）', (t) => {
  const dir = tmpDir(t, 's-idem');
  const statePath = path.join(dir, 'procedural.json');
  const memories = [mem('k1', '部署服务：1. 重启 bridge；2. 检查 3100 端口', [], T0, { kind: 'skill' })];
  const first = createProceduralStore({ statePath, now: () => T0 }).extract({ memories });
  assert.equal(first.added.length, 1);
  const snapshot = fs.readFileSync(statePath, 'utf8');

  const second = createProceduralStore({ statePath, now: () => T0 + 1000 }).extract({ memories });
  assert.equal(second.added.length, 0);
  assert.equal(second.total, 1);
  assert.equal(fs.readFileSync(statePath, 'utf8'), snapshot);
});

test('技能：开关关掉不建文件；抽取纯函数可以直接调', (t) => {
  const dir = tmpDir(t, 's-off');
  const statePath = path.join(dir, 'procedural.json');
  const store = createProceduralStore({ statePath, config: { enabled: false }, now: () => T0 });
  const result = store.extract({ memories: [mem('k1', '部署服务：1. a；2. b', [], T0, { kind: 'skill' })] });
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(statePath), false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.match('部署服务'), []);
  assert.equal(store.render(), '');

  const pure = extractSkillsFromMemories(
    [mem('k2', '清理缓存：1. 停服务；2. 删 temp；3. 起服务', [], T0, { kind: 'skill' })],
    DEFAULT_PROCEDURAL_CONFIG
  );
  assert.equal(pure.length, 1);
  assert.equal(pure[0].steps.length, 3);
  assert.equal(pure[0].source, 'skill-memory');
});

// ── 适配器：从 memory-brain 只读取一份快照 ───────────────────────────────────

test('适配器：用 list() 翻页取记忆 + 只读 SELECT 补实体名', () => {
  const rows = [
    { id: 1, kind: 'episode', text: '主人：今天在改模块', importance: 0.7, valence: -0.2, createdAt: T0 - 1000, status: 'active' },
    { id: 2, kind: 'fact', text: '主人：小鲸鱼怕冷', importance: 0.9, valence: 0, createdAt: T0 - 2000, status: 'active' }
  ];
  const prepared = [];
  const brain = {
    list(opts) {
      assert.equal(opts.status, 'active');
      return { total: rows.length, items: rows.slice(opts.offset, opts.offset + opts.limit) };
    },
    db: {
      prepare(sql) {
        prepared.push(sql);
        assert.ok(sql.includes('FROM memory_entities'));
        return {
          all(...ids) {
            return ids.map((id) => ({ mid: id, name: id === 1 ? '小鲸鱼' : '阿澈', type: 'person' }));
          }
        };
      }
    }
  };

  const snapshot = collectInputsFromMemoryBrain(brain);
  assert.equal(snapshot.memories.length, 2);
  assert.equal(snapshot.source, 'memory-brain');
  assert.deepEqual(snapshot.memories[0].entities, [{ name: '小鲸鱼', type: 'person' }]);
  assert.equal(snapshot.memories[1].entities[0].name, '阿澈');
  assert.equal(snapshot.memories[0].valence, -0.2);
  assert.equal(prepared.length, 1);

  // 库没有 db / prepare 坏掉时降级为「没有实体名」，但不抛
  const noDb = { list: () => ({ total: 1, items: [rows[0]] }) };
  assert.deepEqual(collectInputsFromMemoryBrain(noDb).memories[0].entities, []);
  const brokenDb = {
    list: () => ({ total: 1, items: [rows[0]] }),
    db: { prepare() { throw new Error('no such table'); } }
  };
  assert.deepEqual(collectInputsFromMemoryBrain(brokenDb).memories[0].entities, []);

  assert.throws(() => collectInputsFromMemoryBrain(null), /需要一个带 list\(\)/);
});
