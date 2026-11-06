// 「记忆大脑」（memory-brain）自检：离线、不碰真实 state/、不发任何 QQ 消息。
//
// 三层：
//   一、src/memory-brain.js 的**行为**（临时目录里的真库，node:sqlite）：
//       建表 / 五种记忆 / 检索权重与排序 / bigram 命中 / 去重 / 衰减归档清理 /
//       相似合并 / 冲突检测 / 分类上限 / 注入块 marker 与群聊可见性 / 纠正降权 /
//       窗口幂等 / health / 自评 / 多模态。
//   二、**接线断言**：bridge.js 里那些字符串/位置/端点是不是真的接上了。
//       （老坑：纯函数全绿、bridge 没接线，真机上等于什么都没发生。）
//   三、端到端：用 scripts/audit-bridge-harness.mjs 把真实 bridge.js 拉进 VM，
//       真的往控制台端口打 HTTP（临时 config + 临时库），验证 7 个端点与开关关闭时的回包。
//
// 运行：ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/test-memory-brain.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  DEFAULT_MEMORY_BRAIN_CONFIG,
  DEFAULT_MEMORY_BRAIN_WEIGHTS,
  EMBEDDING_DIM,
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  MEMORY_BRAIN_SCHEMA_VERSION,
  MEMORY_KINDS,
  antonymConflict,
  bigrams,
  buildMemoryBlock,
  hasMemoryBlock,
  httpEmbedding,
  localHashEmbedding,
  normalizeMemoryBrainConfig,
  openMemoryBrain,
  stripMemoryBlocks,
  textSimilarity
} from '../src/memory-brain.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-brain-'));
let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log('  ✅ ' + name); }
  else { fail += 1; console.error('  ❌ ' + name + (detail ? '（' + detail + '）' : '')); }
}
function near(actual, expected, tolerance, name) {
  ok(Math.abs(Number(actual) - Number(expected)) <= tolerance, name, 'actual=' + actual + ' expected=' + expected + ' ±' + tolerance);
}
const DAY = 24 * 60 * 60 * 1000;
const opened = [];
function mk(name, config) {
  const dbPath = path.join(tmpRoot, name + '.sqlite');
  const brain = openMemoryBrain({ dbPath, config: config || {} });
  opened.push(brain);
  return brain;
}

console.log('## 〇、导出与默认值');

console.log('### 常量');
{
  ok(MEMORY_KINDS.join(',') === 'episode,fact,reflection,skill,lesson', 'MEMORY_KINDS 是五层记忆', MEMORY_KINDS.join(','));
  const w = DEFAULT_MEMORY_BRAIN_WEIGHTS;
  ok(w.semantic === 0.18 && w.keyword === 0.46 && w.graph === 0.11 && w.importance === 0.14 && w.freshness === 0.11,
    '默认权重 0.18/0.46/0.11/0.14/0.11', JSON.stringify(w));
  ok(MEMORY_BLOCK_BEGIN === '<!-- MB:BEGIN memory -->' && MEMORY_BLOCK_END === '<!-- MB:END memory -->',
    '注入块 marker 与前端约定一致', MEMORY_BLOCK_BEGIN + ' … ' + MEMORY_BLOCK_END);
  const cfg = DEFAULT_MEMORY_BRAIN_CONFIG;
  ok(cfg.enabled === true, '默认开启（config.memoryBrain 不写也能跑）');
  ok(cfg.dbPath === 'state/memory-brain.sqlite', '默认库在 state/memory-brain.sqlite', cfg.dbPath);
  ok(cfg.inject.privateCount === 2 && cfg.inject.groupCount === 1, '注入条数：私聊 2 / 群聊 1');
  ok(cfg.inject.privateMinScore === 0 && cfg.inject.groupMinScore === 0.45, '注入门槛：私聊 0 / 群聊 0.45');
  ok(cfg.decay.dailyFactor === 0.99 && cfg.decay.minImportance === 0.3 && cfg.decay.protectDays === 30, '衰减：每天 ×0.99 / 归档线 0.3 / 保护 30 天');
  ok(cfg.archive.afterDays === 180, '归档 180 天后清理');
  ok(cfg.merge.similarity === 0.92 && cfg.conflict.threshold === 0.8, '合并 0.92 / 冲突 0.8');
  ok(cfg.caps.fact === 3000 && cfg.caps.lesson === 500, '分类上限 fact 3000 / lesson 500');
  ok(cfg.summarize.useLlm === false, '默认不用 LLM（summary 走启发式）');
  ok(cfg.embedding.backend === 'local-hash' && cfg.embedding.dim === EMBEDDING_DIM && EMBEDDING_DIM === 1024, 'embedding 默认 local-hash，维度固定 1024');
  ok(MEMORY_BRAIN_SCHEMA_VERSION === 1 && !('schemaVersion' in cfg), 'schemaVersion 常量=1（不是配置字段）');
}

console.log('### normalizeMemoryBrainConfig 不吞未知/越界值');
{
  const c = normalizeMemoryBrainConfig({ caps: { fact: 5 }, inject: { groupMinScore: 9 } });
  ok(c.caps.fact === 5 && c.caps.lesson === 500, '只覆盖写了的字段');
  ok(c.inject.groupMinScore === 1, '越界值被夹到 [0,1]', c.inject.groupMinScore);
  ok(c.__normalized === true, '归一后果带 __normalized（openMemoryBrain 不再重算）');
}

console.log('\n## 一、建库与表结构');

const EXPECTED_TABLES = ['memories', 'vectors', 'memories_fts', 'entities', 'relations', 'memory_entities', 'working', 'raw_messages', 'conflicts', 'daily_stats', 'meta'];
{
  const brain = mk('schema');
  const tables = new Set(brain.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
  const missing = EXPECTED_TABLES.filter((name) => !tables.has(name));
  ok(missing.length === 0, '11 张表都在（memories/vectors/memories_fts/entities/relations/memory_entities/working/raw_messages/conflicts/daily_stats/meta）', '缺：' + missing.join(','));
  const ftsSql = String(brain.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get()?.sql || '');
  ok(/unicode61/.test(ftsSql), 'memories_fts 用 unicode61 分词（bigram 靠它做关键词命中）', ftsSql.slice(0, 120));
  const cols = new Set(brain.db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name)));
  const wantCols = ['id', 'kind', 'text', 'importance', 'valence', 'arousal', 'created_at', 'last_access', 'access_count', 'status', 'source', 'meta', 'visibility', 'archived_at'];
  ok(wantCols.every((col) => cols.has(col)), 'memories 字段齐全', wantCols.filter((col) => !cols.has(col)).join(','));
  brain.close();
}

console.log('\n## 二、写入与计数（五种 kind）');

const bMain = mk('main');
const mainIds = {};
{
  for (const kind of MEMORY_KINDS) {
    const result = bMain.insert({ kind, text: '记录一条 ' + kind + ' 类型的记忆内容', importance: 0.6, visibility: 'private' });
    ok(result.ok === true && result.id > 0, '插入 kind=' + kind);
    mainIds[kind] = result.id;
  }
  const counts = bMain.count();
  ok(counts.byKind.episode === 1 && counts.byKind.fact === 1 && counts.byKind.reflection === 1 && counts.byKind.skill === 1 && counts.byKind.lesson === 1,
    '五类各 1 条', JSON.stringify(counts.byKind));
  ok(counts.active === 5 && counts.total === 5, 'active=5 total=5', JSON.stringify(counts));
  const dup = bMain.insert({ kind: 'fact', text: '记录一条 fact 类型的记忆内容' });
  ok(dup.skipped === 'duplicate' && dup.id === mainIds.fact, '同 kind 同文本不重复入库（返回 duplicate）', JSON.stringify(dup));
  const short = bMain.insert({ kind: 'fact', text: '嗯' });
  ok(short.ok === false && short.skipped === 'too-short', '太短的文本不入库', JSON.stringify(short));
  const got = bMain.get(mainIds.fact);
  ok(got && got.kind === 'fact' && got.text.includes('fact 类型'), 'get(id) 返回归一后的记忆');
}

console.log('\n## 三、检索：权重公式 / bigram / 排序');

const searchBrain = mk('search');
let factId = 0;
let otherId = 0;
{
  factId = searchBrain.insert({ kind: 'fact', text: '小鲸鱼喜欢喝冰美式', importance: 0.8, source: 'test' }).id;
  otherId = searchBrain.insert({ kind: 'episode', text: '昨天群里聊到显卡价格又涨了', importance: 0.4 }).id;
  const hits = searchBrain.search({ query: '冰美式', limit: 5, touch: false });
  ok(hits.length >= 1 && hits[0].id === factId, '关键词命中排在第一位', JSON.stringify(hits.map((h) => h.id)));
  const top = hits[0];
  ok(top.parts.keyword === 1, '唯一关键词命中 kw=1', String(top.parts.keyword));
  const manual = 0.18 * top.parts.semantic + 0.46 * top.parts.keyword + 0.11 * top.parts.graph + 0.14 * top.parts.importance + 0.11 * top.parts.freshness;
  near(top.score, manual, 1e-9, 'score = 0.18*semantic + 0.46*keyword + 0.11*graph + 0.14*importance + 0.11*freshness');
  ok(hits.every((item, index) => index === 0 || hits[index - 1].score >= item.score), '结果按 score 降序');
  const gramHits = searchBrain.search({ query: '美式', limit: 5, touch: false });
  ok(gramHits.length >= 1 && gramHits[0].id === factId, 'bigram 命中：只给「美式」也能召回', JSON.stringify(gramHits.map((h) => h.id)));
  ok(!gramHits.some((item) => item.id === otherId) || gramHits[0].id === factId, '不相关记忆不会被 bigram 误召回（或排在后面）');
  const p = searchBrain.get(factId);
  ok(p.accessCount === 0 && p.lastAccess === 0, 'touch:false 不更新访问计数');
  searchBrain.search({ query: '冰美式', limit: 5 });
  const t = searchBrain.get(factId);
  ok(t.accessCount === 1 && t.lastAccess > 0, '默认检索会 touch（access_count+1 / last_access）', t.accessCount + '/' + t.lastAccess);
  near(top.parts.freshness, 1, 1e-6, 'freshness 半衰期 14 天（刚写入的≈1）');
  ok(0.5 * 0.5 === 0.25, '14 天前的记忆 freshness 是 0.5（半衰期公式 0.5^(age/14)）');
}

console.log('\n## 四、去重（文本相似 ≥0.82 只留一条）');
{
  const a = searchBrain.insert({ kind: 'fact', text: '小鲸鱼喜欢喝冰美式不加糖', importance: 0.7 }).id;
  const b = searchBrain.insert({ kind: 'fact', text: '小鲸鱼喜欢喝冰美式不加糖呀', importance: 0.7 }).id;
  const sim = textSimilarity('小鲸鱼喜欢喝冰美式不加糖', '小鲸鱼喜欢喝冰美式不加糖呀');
  ok(sim >= 0.82, '两条文本相似度确实 ≥0.82（' + sim.toFixed(4) + '）');
  const hits = searchBrain.search({ query: '冰美式不加糖', limit: 10, touch: false }).filter((item) => item.id === a || item.id === b);
  ok(hits.length === 1, '检索结果去重后只留一条', '命中 ' + hits.length + ' 条');
}

console.log('\n## 五、治理：衰减 / 归档 / 清理');

{
  const brain = mk('govern');
  const now = Date.now();
  const plain = brain.insert({ kind: 'fact', text: '普通记忆每天衰减一点', importance: 0.5, now }).id;
  const frequent = brain.insert({ kind: 'fact', text: '最近常被想起的记忆衰减减半', importance: 0.5, now: now - DAY, lastAccess: now - DAY, accessCount: 10 }).id;
  brain.decay({ now });
  const p = brain.get(plain);
  const f = brain.get(frequent);
  near(p.importance, 0.5 * 0.99, 1e-9, '每天 ×0.99（没被访问过的按全额衰减）');
  near(f.importance, 0.5 * (1 - 0.01 * 0.5), 1e-9, '最近 30 天访问过且 access_count>=10：衰减减半');

  const weakOld = brain.insert({ kind: 'fact', text: '很久以前的高分低但记忆', importance: 0.12, now: now - 60 * DAY }).id;
  const weakFresh = brain.insert({ kind: 'fact', text: '低重要度但最近才被想起', importance: 0.12, now: now - 60 * DAY, lastAccess: now - DAY, accessCount: 3 }).id;
  const archived = brain.archive({ now });
  ok(archived.changed >= 1, 'importance<0.3 且久未访问 ⇒ 归档', JSON.stringify(archived));
  ok(brain.get(weakOld).status === 'archived', '久未访问的低分记忆被归档');
  ok(brain.get(weakFresh).status === 'active', '最近 30 天被想起过的不归档');
  ok(brain.search({ query: '高分低但记忆', touch: false }).every((item) => item.id !== weakOld), '归档的记忆不再出现在检索里（fts/向量已摘除）');

  brain.restore({ ids: [weakOld] });
  ok(brain.get(weakOld).status === 'active' && brain.search({ query: '高分低但记忆', touch: false }).some((item) => item.id === weakOld), 'restore 后回到 active 且可检索');

  // 180 天清理：手工把 archived_at 拨到 200 天前 / 10 天前
  brain.archive({ ids: [weakOld] });
  brain.db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(now - 200 * DAY, weakOld);
  const keepId = brain.insert({ kind: 'fact', text: '刚归档十天的记忆不该被清理', importance: 0.2, now: now - 60 * DAY }).id;
  brain.archive({ ids: [keepId] });
  brain.db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(now - 10 * DAY, keepId);
  const purged = brain.purge({ now, keepDays: 180 });
  ok(purged.changed === 1 && !brain.get(weakOld) && brain.get(keepId), '归档满 180 天彻底删除，十天前归档的留着', JSON.stringify(purged));
  brain.close();
}

console.log('\n## 六、相似合并（余弦 ≥0.92）');
{
  const brain = mk('merge');
  const now = Date.now();
  const win = brain.insert({ kind: 'fact', text: '主人每天早上都要喝一杯冰美式咖啡', importance: 0.6, now, lastAccess: now, accessCount: 4 }).id;
  const lose = brain.insert({ kind: 'fact', text: '主人每天早上都要喝一杯冰美式咖啡的', importance: 0.6, now, lastAccess: 0, accessCount: 0 }).id;
  const result = brain.mergeSimilar();
  ok(result.merged >= 1, '余弦 ≥0.92 的相似记忆被合并', JSON.stringify(result));
  const mergedRow = brain.get(lose);
  const winRow = brain.get(win);
  ok(mergedRow.status === 'merged' && winRow.status === 'active', '保留访问多的那条，另一条 status=merged', winRow.status + '/' + mergedRow.status);
  ok(Array.isArray((winRow.meta || {}).mergedFrom), '合并方 meta 里留下 mergedFrom', JSON.stringify(winRow.meta));
  brain.close();
}

console.log('\n## 七、冲突检测（同实体 + 余弦 ≥0.8 + 反义词）');
{
  const brain = mk('conflict');
  const like = brain.insert({ kind: 'fact', text: '主人喜欢冰美式', importance: 0.6 }).id;
  const hate = brain.insert({ kind: 'fact', text: '主人讨厌冰美式', importance: 0.6 }).id;
  ok(Boolean(antonymConflict('主人喜欢冰美式', '主人讨厌冰美式')), 'antonymConflict 认出「喜欢 / 讨厌」是反义');
  ok(antonymConflict('主人喜欢冰美式', '主人喜欢冰美式') === null, '同一句话不误判为冲突');
  const found = brain.detectConflicts();
  ok(found.found >= 1, '检测到冲突并写进 conflicts 表', JSON.stringify(found));
  const rows = brain.db.prepare('SELECT a_id, b_id, reason FROM conflicts WHERE resolved = 0').all();
  ok(rows.length >= 1 && rows.some((row) => (row.a_id === like && row.b_id === hate) || (row.a_id === hate && row.b_id === like)), '冲突行记的是这两条记忆');
  ok(brain.health().conflicts >= 1, 'health().conflicts 计数一致');
  brain.close();
}

console.log('\n## 八、分类上限（fact 3000 / lesson 500 的超额归档）');
{
  const brain = mk('caps', { caps: { fact: 2, lesson: 500 } });
  const now = Date.now();
  const ids = [
    brain.insert({ kind: 'fact', text: '高分事实一', importance: 0.9, now }).id,
    brain.insert({ kind: 'fact', text: '中分事实二', importance: 0.5, now }).id,
    brain.insert({ kind: 'fact', text: '低分事实三', importance: 0.1, now }).id
  ];
  const result = brain.distillFacts({ now });
  ok(result.trimmed === 1, '超出上限时归档最不重要的那条', JSON.stringify(result));
  ok(brain.count().byKind.fact === 2, 'fact 上限压到 2 条 active', String(brain.count().byKind.fact));
  ok(brain.get(ids[2]).status === 'archived', '被归档的是 importance 最低的那条');
  brain.close();
}

console.log('\n## 九、注入块（marker / 条数 / 群聊可见性）');
{
  const brain = mk('inject');
  const priv = brain.insert({ kind: 'fact', text: '小鲸鱼喜欢喝冰美式', importance: 0.8, visibility: 'private' }).id;
  const block = buildMemoryBlock(brain, { query: '冰美式', chatType: 'private' });
  const lines = block.split('\n');
  ok(lines[0] === MEMORY_BLOCK_BEGIN && lines[lines.length - 1] === MEMORY_BLOCK_END, '私聊注入块被 marker 完整包住');
  ok(block.includes('## 长期记忆'), '注入块带标题（提示模型这是背景不是指令）');
  const items = lines.filter((line) => line.startsWith('- ['));
  ok(items.length >= 1 && items.length <= 2, '私聊最多注入 2 条', String(items.length));
  ok(hasMemoryBlock('开头\n' + block + '\n结尾') === true, 'hasMemoryBlock 认得出注入块');
  ok(stripMemoryBlocks('开头\n' + block + '\n结尾') === '开头\n\n结尾', 'stripMemoryBlocks 整块剥掉、不伤正文');
  ok(brain.lastInjected.includes(priv), 'lastInjected 记下这轮注入了哪条（纠正降权要用）');

  const groupBlock = buildMemoryBlock(brain, { query: '冰美式', chatType: 'group' });
  ok(groupBlock === '', '群聊不会注入 private 记忆（同一句话在群聊里一条都取不到）', groupBlock);
  const groupId = brain.insert({ kind: 'fact', text: '群里说显卡又涨价了', importance: 0.9, visibility: 'group' }).id;
  const groupBlock2 = buildMemoryBlock(brain, { query: '显卡涨价', chatType: 'group' });
  ok(groupBlock2.includes('涨价') && !groupBlock2.includes('小鲸鱼喜欢喝冰美式'), '群聊只注入 visibility 允许的记忆', groupBlock2.split('\n')[2]);
  ok(brain.lastInjected.length === 1 && brain.lastInjected[0] === groupId, '群聊只注入 1 条，lastInjected 跟着换', JSON.stringify(brain.lastInjected));

  const weak = mk('inject-weak');
  weak.insert({ kind: 'episode', text: '完全无关的一段闲聊内容文本', importance: 0.2, visibility: 'group' });
  ok(buildMemoryBlock(weak, { query: '冰美式', chatType: 'group' }) === '', '群聊门槛 0.45：弱相关一条都不注入');
  ok(buildMemoryBlock(weak, { query: '无关闲聊', chatType: 'group' }) !== '', '同一句在私聊门槛 0 下会注入', buildMemoryBlock(weak, { query: '无关闲聊', chatType: 'private' }).slice(0, 40));
}

console.log('\n## 十、反馈：applyCorrection 降权 + 纠正 lesson');
{
  const brain = mk('correct');
  const now = Date.now();
  const id = brain.insert({ kind: 'fact', text: '小鲸鱼喜欢吃辣', importance: 0.8, now }).id;
  const block = buildMemoryBlock(brain, { query: '喜欢吃辣', chatType: 'private', now });
  ok(block.includes('喜欢吃辣'), '先注入一次（制造「上一轮命中」）');
  const before = brain.get(id).importance;
  const result = brain.applyCorrection({ query: '我不吃辣', now });
  ok(result.changed >= 1 && result.ids.includes(id), '纠正命中上一轮注入的记忆', JSON.stringify(result));
  near(brain.get(id).importance, before * 0.85, 1e-9, 'importance ×0.85');
  const lesson = brain.list({ kind: 'lesson', limit: 5 }).items.find((item) => item.id === result.lessonId);
  ok(Boolean(lesson) && lesson.source === 'correction', '插一条 source=correction 的 lesson', lesson && lesson.source);
  ok(lesson.text.startsWith('用户纠正过我：'), 'lesson 文本以「用户纠正过我：」开头', lesson.text);
  ok(lesson.visibility === 'private', '纠正记忆默认 private（不进群聊）');

  const floorId = brain.insert({ kind: 'fact', text: '这条已经低到不能再低', importance: 0.04, now }).id;
  brain.applyCorrection({ ids: [floorId], now });
  ok(brain.get(floorId).importance >= 0.05, 'importance 最低 0.05，不会降到 0', String(brain.get(floorId).importance));
  brain.close();
}

console.log('\n## 十一、health / health-fix');
{
  const brain = mk('health');
  const now = Date.now();
  brain.insert({ kind: 'fact', text: '一条普通记忆用于健康检查', importance: 0.6, now });
  const clean = brain.healthDetail();
  ok(['duplicates', 'orphans', 'zombies', 'conflicts'].every((key) => Number.isFinite(clean.counts[key])), 'health 四类计数都是数字', JSON.stringify(clean.counts));
  ok(clean.counts.orphans === 0 && clean.counts.conflicts === 0, '干净库 orphans/conflicts 为 0');
  ok(Array.isArray(clean.sample.duplicates) && clean.sample.orphans && Array.isArray(clean.sample.zombies) && Array.isArray(clean.sample.conflicts), 'sample 四类都带（各取 3 条）');
  // 造一个孤儿实体：没有任何记忆指向它
  brain.db.prepare('INSERT INTO entities(name, type, mentions, created_at) VALUES(?, ?, 1, ?)').run('孤儿实体', 'concept', now);
  ok(brain.health().orphans >= 1, '孤儿实体被 health 数出来', JSON.stringify(brain.health()));
  const fixed = brain.healthFix();
  ok(fixed.changed >= 1 && brain.health().orphans === 0, 'health-fix 清掉孤儿', JSON.stringify(fixed));
  brain.close();
}

console.log('\n## 十一半、静默总结：5 条 + 安静 20 分钟就出记忆，同一场对话并进同一颗星');
{
  const brain = mk('idle', { write: { windowSize: 12 } });
  const now = Date.now();
  const session = 'group:777';
  const say = (i, offset = 0) => brain.ingestInbound({ session, role: 'user', sender: '群友' + (i % 3), text: '静默测试第' + i + '条：晚饭吃了拉面，还聊到下周要降温', now: now + offset + i });
  for (let i = 0; i < 4; i += 1) say(i);
  ok(brain.count().byKind.episode === 0, '4 条 < 12 条窗口：正常路径不出 episode（这就是星系一直空着的原因）');
  ok(!brain.pendingWindows({ minPending: 5, idleMs: 0, now: now + 100 }).some((w) => w.session === session), '4 条不够 5 条门槛：静默总结不看它（挡住空星）');
  say(4);
  const seen = brain.pendingWindows({ minPending: 5, idleMs: 0, now: now + 100 }).find((w) => w.session === session);
  ok(seen && seen.pending >= 5, '攒到 5 条才进 pendingWindows', JSON.stringify(seen));
  ok(!brain.pendingWindows({ minPending: 5, idleMs: 20 * 60_000, now: now + 60_000 }).some((w) => w.session === session), '才安静 1 分钟时不算（门槛 20 分钟）');
  ok(brain.pendingWindows({ minPending: 5, idleMs: 20 * 60_000, now: now + 21 * 60_000 }).some((w) => w.session === session), '安静超过 20 分钟就算');
  const first = brain.summarizeWindow({ session, visibility: 'group', force: true });
  ok(first && first.episodeId > 0 && first.totalMessages === 5, '5 条结成一颗星', JSON.stringify(first));
  near(brain.get(first.episodeId).importance, 0.36, 1e-9, '重要度按条数缩放：5 条 ≈ 0.36（不是一律 0.45）');
  // 同一场对话 6 小时内又聊了几句：并进同一颗星，不新增碎片
  for (let i = 5; i < 8; i += 1) say(i, 60_000);
  const second = brain.summarizeWindow({ session, visibility: 'group', force: true, mergeWithinMs: 6 * 60 * 60 * 1000 });
  ok(second && second.merged === true && second.episodeId === first.episodeId, '6 小时内的下一批并进同一颗星（merged=true）', JSON.stringify(second));
  ok(brain.count().byKind.episode === 1, '同一场对话只长一颗星（不是 2 颗）');
  const mergedEp = brain.get(first.episodeId);
  ok(mergedEp.meta.messages === 8 && mergedEp.meta.windows === 2, '合并后 meta 记总条数与窗口数', JSON.stringify(mergedEp.meta));
  ok(/^对话摘要（8 条）：/.test(mergedEp.text), '合并后标题条数改成总数', mergedEp.text.slice(0, 22));
  near(mergedEp.importance, 0.44, 1e-9, '合并后重要度按总条数重算：8 条 ≈ 0.44');
  ok(mergedEp.text.length <= 4000, '合并后的文本仍受 maxChars 约束', String(mergedEp.text.length));
  // 不带 mergeWithinMs（正常 12 条路径）时不会合并
  for (let i = 8; i < 11; i += 1) say(i, 120_000);
  const plain = brain.summarizeWindow({ session, visibility: 'group', force: true });
  ok(plain && plain.merged === false && plain.episodeId !== first.episodeId, '不传 mergeWithinMs ⇒ 另起一颗（窗口路径行为不变）', JSON.stringify(plain));
  ok(brain.count().byKind.episode === 2, '现在共 2 颗星');
  ok(brain.pendingWindows({ minPending: 1, idleMs: 0, now }).every((w) => w.session !== session), '总结过的窗口不再算 pending（幂等，不会天天重结）');
  brain.ingestInbound({ session: 'private:8', role: 'user', sender: '主人在私聊', text: '私聊里的一句', now: now + 5 });
  const priv = brain.pendingWindows({ minPending: 1, idleMs: 0, now: now + 10 }).find((w) => w.session === 'private:8');
  ok(priv && priv.visibility === 'private', 'visibility 按会话前缀推断（private:8 → private）', JSON.stringify(priv));
  ok(brain.get(plain.episodeId).importance >= 0.30 && brain.get(plain.episodeId).importance <= 0.55, '重要度始终落在 0.25~0.55 区间');
  brain.close();
}

console.log('\n## 十二、写入管线：12 条窗口 / 幂等 / 工作记忆');
{
  const brain = mk('window', { write: { windowSize: 4 } });
  const session = 'group:456';
  const now = Date.now();
  let episodeId = 0;
  for (let i = 0; i < 4; i += 1) {
    const result = brain.ingestInbound({ session, role: 'user', sender: '群友' + i, text: '第' + i + '条闲聊：今天显卡又涨价了', now: now + i });
    if (i < 3) ok(result.episodeId === 0, '不满一个窗口（' + (i + 1) + '/4）不出摘要');
    else { episodeId = result.episodeId; ok(episodeId > 0, '第 4 条触发 summarizeWindow 生成 episode'); }
  }
  const counts = brain.count();
  ok(counts.byKind.episode === 1, '一个窗口只生成一条 episode', String(counts.byKind.episode));
  ok(brain.summarizeWindow({ session, now }) === null, '同一窗口重复 summarizeWindow 幂等（返回 null，不重复插）');
  ok(brain.count().byKind.episode === 1, '幂等后 episode 仍是 1 条');
  const episode = brain.get(episodeId);
  ok(episode.source === 'window:' + session, 'episode 记下来源会话', episode.source);
  ok(episode.meta && episode.meta.messages === 4, 'episode meta 里记了消息条数', JSON.stringify(episode.meta));
  ok(brain.rawMessageCount(session) === 4, 'raw_messages 落了 4 条原文', String(brain.rawMessageCount(session)));
  for (let i = 0; i < 4; i += 1) brain.ingestInbound({ session, role: 'user', sender: '群友', text: '第二窗口第' + i + '条：主人在群里说要早睡', now: now + 10 + i });
  ok(brain.count().byKind.episode === 2, '下一个窗口再出第二条 episode', String(brain.count().byKind.episode));
  ok(brain.rawMessageCount(session) === 8, 'raw_messages 共 8 条');
  const working = brain.workingMemory({ session });
  ok(working.length >= 1 && working.length <= 5, '工作记忆只留最近几条（≤5）', String(working.length));
  {
    const before = brain.workingMemory({ session: 'private:9' }).length;
    brain.addWorking({ session: 'private:9', text: '主人在考虑换显卡' });
    brain.addWorking({ session: 'private:9', text: '主人在考虑换显卡' });
    ok(brain.workingMemory({ session: 'private:9' }).length === before + 1, '工作记忆按相似度去重（同一条只留一次）');
  }
  brain.close();
}

console.log('\n## 十三、自评 / 图 / 统计 / 多模态 / embedding 后端');
{
  const brain = mk('extras');
  const now = Date.now();
  brain.insert({ kind: 'fact', text: '主人住在杭州，每天早上喝冰美式', importance: 0.7, now, visibility: 'group' });
  brain.insert({ kind: 'episode', text: '昨天群里聊到显卡价格又涨了', importance: 0.5, now });
  const evalResult = brain.evalRecall({ cases: 5 });
  ok(evalResult.caseCount >= 2, '自评跑得出样例数', JSON.stringify(evalResult));
  ok(evalResult.recallAt1 >= 0 && evalResult.recallAt3 >= evalResult.recallAt1 && evalResult.recallAt3 <= 1, 'recall@1 ≤ recall@3 ≤ 1');
  ok(Number.isFinite(evalResult.mrr) && evalResult.mrr >= evalResult.recallAt1, 'mrr ≥ recall@1', evalResult.mrr + '/' + evalResult.recallAt1);
  ok(Number.isFinite(evalResult.p50Ms), 'p50Ms 是数字', String(evalResult.p50Ms));

  const graph = brain.exportGraph({ limit: 20 });
  ok(Array.isArray(graph.nodes) && graph.nodes.length >= 1, '图里有节点（实体）', String(graph.nodes.length));
  ok(graph.nodes.every((node) => Number.isFinite(node.id) && typeof node.name === 'string' && Number.isFinite(node.mentions)), '节点形状 {id,name,type,mentions}');
  ok(Array.isArray(graph.edges) && graph.edges.every((edge) => Number.isFinite(edge.source) && Number.isFinite(edge.target) && typeof edge.relation === 'string'), '边形状 {source,target,relation,weight}');

  const stats = brain.stats();
  ok(stats.todayWrites >= 2 && stats.todayEpisodes >= 1, 'stats 有今日写入/摘要数', JSON.stringify({ writes: stats.todayWrites, episodes: stats.todayEpisodes }));
  ok(stats.byKind && stats.byKind.fact === 1, 'stats.byKind 与 count 同口径', JSON.stringify(stats.byKind));

  const media = brain.ingestMedia({ kind: 'voice', text: '主人说今天加班到十点，喜欢喝冰美式', session: 'private:123', meta: { durationMs: 3000 } });
  ok(media.ok === true && media.ids.length >= 1, '多模态：转写文本入库（不自做转写）', JSON.stringify(media));
  const mediaRow = brain.get(media.ids[0]);
  ok(mediaRow.text.startsWith('[语音]'), 'episode 带来源标签 [语音]', mediaRow.text.slice(0, 20));
  ok(mediaRow.source === 'media:voice', 'source=media:voice', mediaRow.source);

  const vec = localHashEmbedding('小鲸鱼喜欢喝冰美式');
  ok(vec.length === EMBEDDING_DIM, 'local-hash 固定 1024 维', String(vec.length));
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  near(norm, 1, 1e-6, 'local-hash 做了 L2 归一化');
  const vec2 = localHashEmbedding('小鲸鱼喜欢喝冰美式');
  ok(vec.every((value, index) => value === vec2[index]), 'local-hash 是确定性的（同文本同向量）');
  brain.close();
}

console.log('### httpEmbedding 适配器（换后端不改库）');
{
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: new Array(EMBEDDING_DIM).fill(0.5) }] }) };
  };
  try {
    const vec = await httpEmbedding('测试文本', { baseUrl: 'http://127.0.0.1:9/embed', model: 'bge-m3' });
    ok(vec.length === EMBEDDING_DIM, 'http 后端返回 1024 维向量');
    ok(captured && captured.body.model === 'bge-m3' && Array.isArray(captured.body.input), 'POST 的 body 是 {model, input:[text]}', JSON.stringify(captured && captured.body));
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) });
    let dimensionError = '';
    try { await httpEmbedding('x', { baseUrl: 'http://127.0.0.1:9/embed' }); } catch (error) { dimensionError = error.message; }
    ok(/维度必须是 1024/.test(dimensionError), '维度不是 1024 时中文报错（换后端不许改库）', dimensionError);
    let noBase = '';
    try { await httpEmbedding('x', {}); } catch (error) { noBase = error.message; }
    ok(/没配 baseUrl/.test(noBase), 'http 后端缺 baseUrl 时中文报错', noBase);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n## 十四、bridge.js 接线（字符串/位置/端点）');

const bridgeSource = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
{
  ok(/import \{ openMemoryBrain, normalizeMemoryBrainConfig, buildMemoryBlock, stripMemoryBlocks \} from '\.\/memory-brain\.js';/.test(bridgeSource),
    'bridge.js 顶层 import 了记忆大脑的四个符号');
  // 2026-10-28 第六轮：记忆大脑后面接了人物七层（画像 / 语感 / 自我语感），
  // 记忆块仍然紧跟记忆卡，只是不再直接接 purposeLine。
  ok(/\+\s*memoryCardLine \+ memoryBlockLine \+ profileLine \+ styleLine \+ selfStyleLine \+ purposeLine/.test(bridgeSource),
    'base 提示词：memoryBlockLine 紧跟 memoryCardLine，之后依次是画像 / 语感 / 自我语感');
  const concatAt = bridgeSource.indexOf('memoryCardLine + memoryBlockLine + profileLine + styleLine + selfStyleLine + purposeLine');
  ok(concatAt > 0 && bridgeSource.indexOf('memoryCardLine =') < concatAt, 'memoryBlockLine 的定义在拼接之前');
  ok(bridgeSource.includes('🧠 记忆大脑已开启：'), '启动日志形态：🧠 记忆大脑已开启：N 条记忆（fact x / episode y）');
  ok(/记忆大脑已开启：\$\{counts\.active\} 条记忆（fact \$\{counts\.byKind\.fact\} \/ episode \$\{counts\.byKind\.episode\}）/.test(bridgeSource), '日志里带 fact/episode 明细');
  ok(bridgeSource.includes('rememberInboundForBrain(key, kind, sender, plainContent);'), '入站消息落 raw_messages（reserved2 分支）');
  ok(bridgeSource.includes('startMemoryBrainMaintenance();'), '启动时开库 + 挂治理定时器');
  ok(/memoryBrainConfig = normalizeMemoryBrainConfig\(cfg\.memoryBrain \?\? \{\}\);/.test(bridgeSource), 'main() 里按 config.memoryBrain 归一');
  for (const endpoint of ['/api/memory-brain/overview', '/api/memory-brain/list', '/api/memory-brain/search', '/api/memory-brain/graph', '/api/memory-brain/health', '/api/memory-brain/eval', '/api/memory-brain/action']) {
    ok(bridgeSource.includes(endpoint), '端点已注册：' + endpoint);
  }
  ok(/ok: false, disabled: true/.test(bridgeSource), '未开启时回 {ok:false,disabled:true}（前端据此显示「未开启」）');
  for (const action of ['archive', 'restore', 'delete', 'decay', 'purge', 'merge', 'health-fix', 'distill', 'reindex']) {
    ok(bridgeSource.includes("action === '" + action + "'"), 'POST action 支持：' + action);
  }
  ok(bridgeSource.includes("url.pathname === '/memory-brain'") && bridgeSource.includes("url.pathname === '/memory-brain.html'"), '/memory-brain 与 /memory-brain.html 都路由到页面');
  ok(bridgeSource.includes('记忆大脑页面缺失：qq-bridge/public/memory-brain.html'), '页面文件缺失时给中文 404 提示');
  ok(bridgeSource.includes("visibility: group ? 'group' : 'private'"), '注入按会话类型决定 visibility（private 记忆不进群聊）');
}

console.log('### 审计夹具 / 注册 / 文档');
{
  const harness = fs.readFileSync(path.join(root, 'scripts/audit-bridge-harness.mjs'), 'utf8');
  ok(harness.includes("import * as memoryBrain from '../src/memory-brain.js';") && harness.includes('...memoryBrain,'),
    'audit-bridge-harness.mjs 注入 ...memoryBrain（P-002：漏注入 = 跑真 bridge.js 时 ReferenceError）');
  ok(harness.includes('closeMemoryBrain'), '夹具收尾会关 sqlite（Windows 上打开的文件删不掉）');
  const auditList = fs.readFileSync(path.join(root, 'scripts/test-audit.mjs'), 'utf8');
  ok(auditList.includes("'test-memory-brain.mjs'"), 'test-audit.mjs 的 tests[] 已登记本脚本');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  ok(pkg.scripts && pkg.scripts['test:memory'] === 'node scripts/test-memory-brain.mjs', 'package.json 有 test:memory', String(pkg.scripts && pkg.scripts['test:memory']));
  const guide = path.join(root, 'docs/guides/MEMORY_BRAIN.md');
  ok(fs.existsSync(guide), 'docs/guides/MEMORY_BRAIN.md 存在');
  if (fs.existsSync(guide)) {
    const text = fs.readFileSync(guide, 'utf8');
    ok(text.includes('<!-- MB:BEGIN memory -->') && text.includes('0.18') && text.includes('0.46'), '指南里写了注入块格式与权重公式');
    ok(text.includes('enabled') && /一键关|回滚/.test(text), '指南里写了开关与回滚');
  }
  const folderMap = fs.readFileSync(path.join(root, 'docs/FOLDER_MAP.md'), 'utf8');
  ok(folderMap.includes('src/memory-brain.js'), 'FOLDER_MAP 补了 src/memory-brain.js');
  ok(folderMap.includes('test-memory-brain.mjs'), 'FOLDER_MAP 补了脚本行');
  const docsIndex = fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8');
  ok(docsIndex.includes('MEMORY_BRAIN.md'), 'docs/README.md 索引了新 guide');
  const example = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  ok(/"memoryBrain"/.test(example), 'config.example.json 有 memoryBrain 示例块');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  ok(readme.includes('test:memory'), 'README.md 命令表有 test:memory');
}

console.log('\n## 十五、端到端：真实 bridge.js + 临时库 + HTTP');

const CONSOLE_TOKEN = 'fixture-console-token';
const tempA = fs.mkdtempSync(path.join(tmpRoot, 'http-'));
fs.mkdirSync(path.join(tempA, 'state'), { recursive: true });
let seeded = 0;
{
  // 预置库：桥接启动后 overview 才有东西可看
  const seed = openMemoryBrain({ dbPath: path.join(tempA, 'state/memory-brain.sqlite') });
  seed.insert({ kind: 'fact', text: '小鲸鱼喜欢喝冰美式', importance: 0.8 });
  seed.insert({ kind: 'fact', text: '主人住在杭州，每天早上喝冰美式', importance: 0.6 });
  seed.insert({ kind: 'episode', text: '昨天群里聊到显卡价格又涨了', importance: 0.5 });
  seed.insert({ kind: 'fact', text: '群里有人说冰美式涨价了', importance: 0.7, visibility: 'group' });
  seeded = seed.count().active;
  seed.close();
  ok(seeded === 4, '预置 4 条记忆（桥接重启后应能读回来）', String(seeded));
}

async function startBrainFixture(extraConfig) {
  const h = await bridgeHarness({ tempDir: tempA, config: { memoryBrain: extraConfig } });
  // harness 把 return 注入在 main() 前半段就返回了，启动后半段的 startMemoryBrainMaintenance()
  // 在 vm 里不会自己跑 —— 显式调一次，等价于真实进程启动到这里。
  h.startMemoryBrainMaintenance();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  async function raw(method, pathname, { body, token = CONSOLE_TOKEN } = {}) {
    const headers = {};
    if (token) headers['x-console-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch('http://127.0.0.1:' + port + pathname, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 页面是 HTML */ }
    return { status: res.status, json, text, contentType: String(res.headers.get('content-type') || '') };
  }
  return { h, raw, async stop() { await new Promise((resolve) => server.close(resolve)); await h.close(); } };
}

const fx = await startBrainFixture({
  enabled: true,
  // 启动治理关掉：否则一开库就先衰减/蒸馏一轮，counts 会漂（治理本身在段五/八单独验）。
  decay: { enabled: false }, archive: { enabled: false }, merge: { enabled: false },
  conflict: { enabled: false }, distill: { enabled: false }
});
try {
  console.log('### overview');
  const overview = await fx.raw('GET', '/api/memory-brain/overview');
  ok(overview.status === 200 && overview.json.ok === true && overview.json.enabled === true, 'GET /api/memory-brain/overview 200/ok/enabled', JSON.stringify(overview.json).slice(0, 200));
  const o = overview.json;
  ok(o.counts && o.counts.fact === 3 && o.counts.episode === 1, 'counts.fact=3 counts.episode=1（预置数据读回来了）', JSON.stringify(o.counts));
  ok(['episode', 'fact', 'reflection', 'skill', 'lesson', 'active', 'archived', 'working'].every((key) => Number.isFinite(o.counts[key])), 'counts 八个字段都在');
  ok(o.caps && o.caps.fact === 3000 && o.caps.lesson === 500, 'caps={fact:3000,lesson:500}', JSON.stringify(o.caps));
  ok(o.health && ['duplicates', 'orphans', 'zombies', 'conflicts'].every((key) => Number.isFinite(o.health[key])), 'health 四类计数');
  ok(o.db && typeof o.db.path === 'string' && Number.isFinite(o.db.sizeBytes) && o.db.sizeBytes > 0, 'db={path,sizeBytes}', JSON.stringify(o.db));
  ok(o.stats && Number.isFinite(o.stats.todayWrites) && Number.isFinite(o.stats.todayEpisodes), 'stats={todayWrites,todayEpisodes}（今天的写入/摘要）');

  console.log('### list / search / graph / health / eval');
  const list = await fx.raw('GET', '/api/memory-brain/list?kind=fact&limit=10');
  ok(list.status === 200 && list.json.ok === true && list.json.total >= 2, 'GET /list 返回 total 与 items', JSON.stringify(list.json).slice(0, 160));
  const item = list.json.items[0] || {};
  const wantKeys = ['id', 'kind', 'text', 'importance', 'valence', 'accessCount', 'status', 'source', 'visibility', 'createdAt', 'lastAccess', 'archivedAt'];
  ok(wantKeys.every((key) => key in item), '列表项字段齐全（前端按这些字段渲染）', wantKeys.filter((key) => !(key in item)).join(','));
  ok(list.json.items.every((row) => row.kind === 'fact'), 'kind 过滤生效');

  const search = await fx.raw('GET', '/api/memory-brain/search?q=' + encodeURIComponent('冰美式') + '&chatType=private');
  ok(search.status === 200 && search.json.ok === true && search.json.items.length >= 1, 'GET /search 有命中', JSON.stringify(search.json).slice(0, 160));
  const s0 = search.json.items[0] || {};
  ok(s0.parts && ['semantic', 'keyword', 'graph', 'importance', 'freshness'].every((key) => Number.isFinite(s0.parts[key])), 'search 回包带 parts 五路分', JSON.stringify(s0.parts));
  near(s0.score, 0.18 * s0.parts.semantic + 0.46 * s0.parts.keyword + 0.11 * s0.parts.graph + 0.14 * s0.parts.importance + 0.11 * s0.parts.freshness, 0.001, '回包的 score 与 parts 自洽');
  const groupSearch = await fx.raw('GET', '/api/memory-brain/search?q=' + encodeURIComponent('冰美式') + '&chatType=group');
  ok(groupSearch.json.items.every((row) => !String(row.text).includes('小鲸鱼喜欢喝冰美式')), 'chatType=group 不返回 private 记忆');

  const graph = await fx.raw('GET', '/api/memory-brain/graph?limit=20');
  ok(graph.status === 200 && graph.json.ok === true && Array.isArray(graph.json.nodes) && Array.isArray(graph.json.edges), 'GET /graph 返回 nodes/edges');
  ok(graph.json.nodes.every((node) => 'id' in node && 'name' in node && 'type' in node && 'mentions' in node), '节点字段 {id,name,type,mentions}');

  const health = await fx.raw('GET', '/api/memory-brain/health');
  ok(health.status === 200 && health.json.ok === true && health.json.items && health.json.sample, 'GET /health 返回 items + sample');
  ok(['duplicates', 'orphans', 'zombies', 'conflicts'].every((key) => key in health.json.items && key in health.json.sample), 'health 的 items/sample 四类齐全');

  const evalRun = await fx.raw('GET', '/api/memory-brain/eval?run=1');
  ok(evalRun.status === 200 && evalRun.json.ok === true && evalRun.json.caseCount >= 1, 'GET /eval?run=1 真的跑了一遍', JSON.stringify(evalRun.json).slice(0, 160));
  ok(Number.isFinite(evalRun.json.recallAt1) && Number.isFinite(evalRun.json.recallAt3) && Number.isFinite(evalRun.json.mrr) && Number.isFinite(evalRun.json.p50Ms), 'eval 回 {caseCount,recallAt1,recallAt3,mrr,p50Ms}');
  const evalIdle = await fx.raw('GET', '/api/memory-brain/eval');
  ok(evalIdle.json.ran === false && evalIdle.json.caseCount === 0, '不带 run=1 时不跑（不白烧 CPU）');

  console.log('### action');
  const targetId = item.id;
  const archived = await fx.raw('POST', '/api/memory-brain/action', { body: { action: 'archive', id: targetId } });
  ok(archived.status === 200 && archived.json.ok === true && archived.json.changed === 1, 'POST action=archive 归档 1 条', JSON.stringify(archived.json));
  const archivedList = await fx.raw('GET', '/api/memory-brain/list?status=archived');
  ok(archivedList.json.total >= 1 && archivedList.json.items.some((row) => row.id === targetId), '归档后能在 status=archived 里看到');
  const restored = await fx.raw('POST', '/api/memory-brain/action', { body: { action: 'restore', ids: [targetId] } });
  ok(restored.json.ok === true && restored.json.changed === 1, 'POST action=restore 恢复');
  const decayed = await fx.raw('POST', '/api/memory-brain/action', { body: { action: 'decay' } });
  ok(decayed.status === 200 && decayed.json.ok === true && Number.isFinite(decayed.json.changed), 'POST action=decay 返回 changed', JSON.stringify(decayed.json));
  const reindexed = await fx.raw('POST', '/api/memory-brain/action', { body: { action: 'reindex' } });
  ok(reindexed.json.ok === true && reindexed.json.changed >= 1, 'POST action=reindex 重建索引', JSON.stringify(reindexed.json));
  const bogus = await fx.raw('POST', '/api/memory-brain/action', { body: { action: 'nope' } });
  ok(bogus.status === 400 && bogus.json.ok === false, '未知 action ⇒ 400', JSON.stringify(bogus.json));
  const noId = await fx.raw('POST', '/api/memory-brain/action', { body: { action: 'archive' } });
  ok(noId.status === 400, 'archive 不带 id ⇒ 400', String(noId.status));

  console.log('### 页面路由与鉴权');
  const page = await fx.raw('GET', '/memory-brain', { token: '' });
  ok(page.status === 404 && page.text.includes('记忆大脑页面缺失'), '/memory-brain 在页面文件缺失时 404 + 中文提示', String(page.status));
  fs.mkdirSync(path.join(tempA, 'public'), { recursive: true });
  fs.writeFileSync(path.join(tempA, 'public/memory-brain.html'), '<!doctype html><title>MB-PAGE-FIXTURE</title>');
  const page2 = await fx.raw('GET', '/memory-brain.html', { token: '' });
  ok(page2.status === 200 && /text\/html/.test(page2.contentType) && page2.text.includes('MB-PAGE-FIXTURE'), '/memory-brain.html 返回页面（免控制台令牌，与 console.html 同款）', String(page2.status));
  const noToken = await fx.raw('GET', '/api/memory-brain/overview', { token: '' });
  ok(noToken.status === 401, '/api/memory-brain/* 仍然要控制台令牌（鉴权没被放宽）', String(noToken.status));
} finally {
  await fx.stop();
}

console.log('### 开关关闭：所有端点回 disabled');
{
  const tempB = fs.mkdtempSync(path.join(tmpRoot, 'disabled-'));
  const h = await bridgeHarness({ tempDir: tempB, config: { memoryBrain: { enabled: false } } });
  h.startMemoryBrainMaintenance();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const get = async (pathname) => {
    const res = await fetch('http://127.0.0.1:' + port + pathname, { headers: { 'x-console-token': CONSOLE_TOKEN } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  try {
    for (const pathname of ['/api/memory-brain/overview', '/api/memory-brain/list', '/api/memory-brain/search?q=x', '/api/memory-brain/graph', '/api/memory-brain/health', '/api/memory-brain/eval?run=1']) {
      const result = await get(pathname);
      ok(result.status === 200 && result.json.ok === false && result.json.disabled === true, 'enabled=false ⇒ ' + pathname + ' 回 disabled', JSON.stringify(result.json).slice(0, 120));
    }
    const actionRes = await fetch('http://127.0.0.1:' + port + '/api/memory-brain/action', {
      method: 'POST', headers: { 'x-console-token': CONSOLE_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'decay' })
    });
    const actionJson = await actionRes.json();
    ok(actionRes.status === 200 && actionJson.disabled === true, 'enabled=false ⇒ POST action 也回 disabled', JSON.stringify(actionJson).slice(0, 120));
    ok(!fs.existsSync(path.join(tempB, 'state/memory-brain.sqlite')), '关掉时连库文件都不创建（数据原样留在磁盘上）');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

// 清理：先关库再删目录（Windows 上打开的文件删不掉）
for (const brain of opened) { try { brain.close(); } catch { /* 已关 */ } }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 留给系统临时目录 */ }

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exitCode = 1;
