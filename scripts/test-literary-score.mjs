// 文学性尺子（src/literary-score.js）的离线单测 + 基准校准。
//
// 这把尺子的用途是**比较**：改人格卡、换风格块、加素材库之前/之后，分数有没有真的上去。
// 所以测试分两半：
//   ① 每个指标单独钉住（具体性认词、明喻算画面、AI 腔扣分、句长太齐扣分、最长优先匹配）；
//   ② 40 条基准必须仍然拉开顺序（good > flat > slop，各差 8 分以上）——尺子自己失真了，
//      拿它做的任何对比都不算数。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  LITERARY_VERSION,
  bandOf,
  bodyLength,
  matchTerms,
  metricImagery,
  metricRhythm,
  metricSlop,
  scoreBatch,
  scoreText
} from '../src/literary-score.js';

const FIXTURE = new URL('./fixtures/literary-eval.json', import.meta.url);
const loadSet = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('空文本与纯标点：0 分、干瘪、不抛错', () => {
  for (const t of ['', '   ', '\n\n', '。，、']) {
    const r = scoreText(t);
    assert.equal(r.version, LITERARY_VERSION);
    assert.ok(r.total >= 0 && r.total <= 100);
    assert.equal(r.band, '干瘪');
  }
  assert.equal(scoreText('').total, 0);
});

test('具体的东西比空泛的感受得分高', () => {
  const concrete = scoreText('锅里的水开了，咕嘟咕嘟，我把面条扔进去。');
  const vague = scoreText('这段时间的感受很复杂，需要认真思考。');
  assert.ok(concrete.total > vague.total + 15, '具体：' + concrete.total + ' 空泛：' + vague.total);
  assert.ok(concrete.metrics.concreteness.score > vague.metrics.concreteness.score);
  assert.ok(concrete.metrics.concreteness.hits.includes('锅'));
});

test('明喻算画面，「仿佛/不禁」算 AI 腔（两本账，不互相抵消）', () => {
  const fresh = metricImagery('雨点子砸在铁皮棚上，跟谁在楼上跳绳似的。');
  assert.ok(fresh.similes.length >= 1 || fresh.senses.length >= 1);
  assert.ok(fresh.score > 0.3);
  const slop = metricSlop('仿佛整个世界都安静了下来，我不禁陷入回忆。');
  assert.ok(slop.hits.includes('仿佛'));
  assert.ok(slop.hits.includes('不禁'));
  assert.ok(slop.score > 0.4);
});

test('带量词的数字算具体画面（三片肉 / 半根 / 四百三十二步）', () => {
  for (const text of ['肉三片，辣椒一盘。', '给它半根火腿肠。', '一共四百三十二步。']) {
    const im = metricImagery(text);
    assert.ok(im.measures.length >= 1, text + ' 应该认出量词数字，实际：' + JSON.stringify(im.measures));
  }
});

test('句长太齐扣分，长短交替加分', () => {
  const flat = metricRhythm('今天很好。今天不错。今天一般。今天还行。');
  const varied = metricRhythm('嗯。今天在地铁口看见一只橘猫，蹲在共享单车车筐里，谁都不让碰。');
  assert.ok(varied.score > flat.score, 'varied=' + varied.score + ' flat=' + flat.score);
  assert.ok(flat.cv < 0.25);
});

test('词表匹配最长优先、不重叠', () => {
  // '小猫猫' → 先吃 '小猫'，剩下的 '猫' 再算一次（贪心、不重叠、不全靠单字）
  const m = matchTerms('小猫猫和狗', ['猫', '小猫', '狗']);
  assert.deepEqual(m.hits, ['小猫', '猫', '狗']);
  assert.equal(m.chars, 4);
  // 重叠时取长的：'雪糕' 不该被拆成 '雪' + '糕'
  assert.deepEqual(matchTerms('雪糕化了', ['雪', '糕', '雪糕']).hits, ['雪糕']);
});

test('密度分母剥掉标点空白', () => {
  assert.equal(bodyLength('猫，狗。 鱼！'), 3);
  assert.equal(bodyLength(''), 0);
});

test('分档边界按配置走', () => {
  assert.equal(bandOf(100), '有画面');
  assert.equal(bandOf(70), '有画面');
  assert.equal(bandOf(69.9), '有味道');
  assert.equal(bandOf(55), '有味道');
  assert.equal(bandOf(40), '勉强');
  assert.equal(bandOf(25), '平');
  assert.equal(bandOf(24.9), '干瘪');
});

test('分数落在 0~100、同一输入两次一致', () => {
  const text = '她把伞收起来，水珠顺着伞骨往下淌，滴在脚背上，凉的。';
  const a = scoreText(text);
  const b = scoreText(text);
  assert.equal(a.total, b.total);
  assert.ok(a.total >= 0 && a.total <= 100);
});

test('长文本不炸（200 遍同一句）', () => {
  const text = '锅里的水开了，咕嘟咕嘟。'.repeat(200);
  const r = scoreText(text);
  assert.ok(r.total >= 0 && r.total <= 100);
  assert.ok(r.chars > 2000);
});

test('基准集结构完整：40 条、三类各 10 条以上、文本非空', () => {
  const set = loadSet();
  assert.ok(Array.isArray(set.items));
  assert.equal(set.items.length, 40);
  const labels = new Set(set.items.map((i) => i.label));
  for (const label of ['good', 'flat', 'slop']) {
    assert.ok(labels.has(label), '缺少分组 ' + label);
    assert.ok(set.items.filter((i) => i.label === label).length >= 10);
  }
  for (const item of set.items) {
    assert.ok(item.id && item.text, '条目缺 id/text：' + JSON.stringify(item).slice(0, 60));
    assert.ok(item.text.length >= 8);
  }
  // id 不能重复（否则最低五条/报表会对错条目）
  assert.equal(new Set(set.items.map((i) => i.id)).size, set.items.length);
});

test('基准校准：good > flat > slop，各差 8 分以上', () => {
  const rows = scoreBatch(loadSet().items);
  const mean = (label) => {
    const xs = rows.filter((r) => r.label === label).map((r) => r.score.total);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const good = mean('good');
  const flat = mean('flat');
  const slop = mean('slop');
  assert.ok(good > flat + 8, 'good ' + good.toFixed(1) + ' 没拉开 flat ' + flat.toFixed(1));
  assert.ok(flat > slop + 8, 'flat ' + flat.toFixed(1) + ' 没拉开 slop ' + slop.toFixed(1));
});

test('好的样本里没有一条掉进「干瘪」档', () => {
  const rows = scoreBatch(loadSet().items.filter((i) => i.label === 'good'));
  for (const row of rows) {
    assert.notEqual(row.score.band, '干瘪', row.id + ' 被判干瘪：' + row.text);
  }
});
