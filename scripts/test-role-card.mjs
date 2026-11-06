// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseRoleSections, rewriteExampleSpaces, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  // 公共内容两边都有
  for (const text of [v1, v2]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(v2, /qq_send_message/);
  assert.doesNotMatch(v2, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'v1'), /〔一代〕|〔二代〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'v2'), /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'v2'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(v2, /- b/); assert.match(v2, /- c/);
  assert.doesNotMatch(v2, /- a/); assert.doesNotMatch(v2, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'v1'), legacy);
  assert.equal(selectRoleText(legacy, 'v2'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'v2'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'v2'), /- x/);
  assert.match(selectRoleText(card, 'v2'), /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0, '应能统计出两代各自专属的字符数');
  assert.ok(stats.v1 < stats.total && stats.v2 < stats.total, '筛选后应短于原文');
  assert.notEqual(stats.v1, stats.v2, '两代内容不同，长度不应相等');
  const report = roleSectionReport(CARD, 'v1');
  const v2Section = report.find((r) => r.heading === '三、发言方式');
  assert.equal(v2Section.injected, false, '二代专属小节在一代下应标为不注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

test('回复示例：标题式小节里的中文空格改写成逗号（二代不靠空格分条）', () => {
  const card = [
    '## 回复示例',
    '- 群友：今天好累 →「累了就睡 醒了继续累」',
    '## 下一节',
    '- 这段不动：中文 空格',
  ].join('\n');
  const out = rewriteExampleSpaces(card);
  assert.match(out, /「累了就睡，醒了继续累」/);
  assert.match(out, /## 下一节/);
  // 块外原样保留
  assert.match(out, /- 这段不动：中文 空格/);
});

test('回复示例：列表项写法也认，且不动 bullet 本身与英文后空格', () => {
  const card = [
    '## 九、看聊天状态',
    '- 回复示例（先看状态）：',
    '  - 群友：来点推荐 →「？ 你要啥推荐」/「刚吃完饭 别问我」',
    '  - 群友：我是DeepSeek 小鲸鱼 →「嗯」',
    '- **不记仇**：同一件事最多回一句。',
  ].join('\n');
  const out = rewriteExampleSpaces(card);
  // bullet 标记与「？」后的空格原样（那是口语停顿，不是分条）
  assert.match(out, /^- 回复示例（先看状态）：$/m);
  assert.match(out, /「？ 你要啥推荐」/);
  // 中文之间的空格改成逗号
  assert.match(out, /「刚吃完饭，别问我」/);
  // 英文/数字后的一侧空格不动（DeepSeek 小鲸鱼 是一个名字，不是两句话）
  assert.match(out, /我是DeepSeek 小鲸鱼/);
  // 列表块结束后原样
  assert.match(out, /- \*\*不记仇\*\*：同一件事最多回一句。/);
});

test('真实人格卡的回复示例块改完后不再有中文-中文空格', () => {
  const raw = fs.readFileSync(new URL('../roles/小鲸鱼.md', import.meta.url), 'utf8');
  const out = rewriteExampleSpaces(raw);
  // 只取示例条目本身（`  - 群友：…`）；正文里 `[引用 某群友：原文]` 这类语法占位符不算示例
  const exampleLines = out.split('\n').filter((line) => /^\s*-\s*群友：/.test(line));
  assert.ok(exampleLines.length > 0, '真实卡片里应有回复示例');
  for (const line of exampleLines) {
    assert.doesNotMatch(line, /[\u4e00-\u9fff][ \t]+[\u4e00-\u9fff]/, `示例行仍有中文空格：${line}`);
  }
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../roles/小鲸鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const v2 = selectRoleText(raw, 'v2');
  const v1 = selectRoleText(raw, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
});
