// 黑话"只在群聊里学、按出现次数挑词"的自检（主人 m01652）。
//
// 为什么需要它：桥接的黑话学习曾经**一次都没跑起来过**——
//   ① 待学习窗口是纯内存态，而桥接进程换得勤（桌面一键启动 + 手动重启，实测 6 小时 29 次），
//      每次重启都把攒了一半的素材清零；群一安静，单进程寿命内最多只攒到 10 条 < extractMinMessages(12)，
//      于是 bridge.log 里 6 小时零条「黑话提取」，候选 count 永远停在 1；
//   ② 研究结果写回的 `entry.research` 字段被 normalizeSlangEntry 的字段白名单 strip 掉；
//   ③ 研究结果按 `content` 严格相等匹配词条，对不上就静默丢弃（日志却说"已更新 N 条"）。
// 这个脚本把这三条的修复钉住：窗口跨重启存活、词频门槛真的过滤新词、研究元数据能落盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSlangEntry,
  createSlangEntry,
  saveSlang,
  loadSlang,
  topRepeatedTerms,
  countTermOccurrences,
  selectExtractionItems,
  buildExtractionPrompt,
} from '../src/slang-learner.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

// 群里真实聊过的一段：`烧心` 出现在 3 条不同消息里（>= minGroupCount），`一次性梗` 只有 1 条。
const groupWindow = [
  { sender: '甲', text: '我十一点睡烧心', time: 1, seq: 1 },
  { sender: '乙', text: '烧心是哪门子说法', time: 2, seq: 2 },
  { sender: '丙', text: '睡了 烧心的自己早点躺', time: 3, seq: 3 },
  { sender: '丁', text: '哇这个一次性梗好好笑', time: 4, seq: 4 },
  { sender: '戊', text: '哈哈哈哈', time: 5, seq: 5 },
];

console.log('词频统计（topRepeatedTerms / countTermOccurrences）');
{
  const terms = topRepeatedTerms(groupWindow, { limit: 40, minCount: 2 });
  const hits = Object.fromEntries(terms.map((t) => [t.term, t.count]));
  ok(hits['烧心'] === 3, `烧心 出现在 3 条消息里（实际 ${hits['烧心']}）`);
  ok(!('哈哈哈哈' in hits), '口水词（哈哈哈哈）不进词频表');
  ok(countTermOccurrences(groupWindow, '烧心') === 3, 'countTermOccurrences 复核为 3');
  ok(countTermOccurrences(groupWindow, '一次性梗') === 1, '一次性梗 只出现 1 次');

  const prompt = buildExtractionPrompt(groupWindow, { frequentTerms: terms, minGroupCount: 2 });
  ok(prompt.includes('本地词频统计'), '提取提示词里带本地词频表');
  ok(prompt.includes('烧心×3'), '词频表里烧心×3');
  ok(prompt.includes('群里反复出现过') && prompt.includes('2 次以上'), '提示词里写明"只挑群里反复出现的词"');
}

console.log('新词门槛（selectExtractionItems：只学群里反复出现过的词）');
{
  const items = [
    { content: '烧心', source_id: 1 },
    { content: '一次性梗', source_id: 4 },
    { content: '烧心', source_id: 2 }, // 同一个词重复出现，只能算一次
  ];
  const fresh = selectExtractionItems(items, groupWindow, { minGroupCount: 2 });
  ok(fresh.accepted.length === 1 && fresh.accepted[0].content === '烧心', '新词里只有烧心被接受');
  ok(fresh.accepted[0].groupCount === 3, '接受时带上 groupCount=3');
  ok(fresh.skipped.length === 1 && fresh.skipped[0].content === '一次性梗', '一次性梗被跳过（不进黑话库）');

  // 库里已有的词不受门槛影响：这一窗它只出现一次也要照旧更新，不能把学过的词丢掉。
  const known = selectExtractionItems([{ content: '一次性梗', source_id: 4 }], groupWindow, { minGroupCount: 2, known: new Set(['一次性梗']) });
  ok(known.accepted.length === 1 && !known.skipped.length, '库里已有的词即使这一窗只出现 1 次也照旧更新');
}

console.log('词条字段（research / groupCount 必须能落盘）');
{
  const raw = {
    content: '烧心',
    meaning: '胃里泛酸、心里堵得慌，也用来形容熬夜后的难受',
    groupCount: '3',
    research: { verified: true, at: '2026-10-11T22:45:00.000Z', junk: 'drop-me' },
  };
  const entry = normalizeSlangEntry(raw);
  ok(entry.groupCount === 3, `groupCount 归一化为数字（实际 ${entry.groupCount}）`);
  ok(entry.research && entry.research.verified === true, 'research.verified 保留');
  ok(entry.research && entry.research.at === '2026-10-11T22:45:00.000Z', 'research.at 保留');
  ok(entry.research && !('junk' in entry.research), 'research 只留白名单字段（junk 被丢）');

  const file = path.join(os.tmpdir(), `slang-roundtrip-${process.pid}.json`);
  saveSlang(file, [entry]);
  const back = loadSlang(file);
  fs.rmSync(file, { force: true });
  ok(back.length === 1 && back[0].research?.verified === true, 'save→load 之后 research 还在（旧实现在这里被 strip）');
  ok(back.length === 1 && back[0].groupCount === 3, 'save→load 之后 groupCount 还在');

  const noResearch = normalizeSlangEntry(createSlangEntry({ content: '无研究' }));
  ok(noResearch.research === null, '没研究过的词 research 是 null，不是 undefined/{}');
}

console.log('窗口跨重启存活（state/slang-window.json）');
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-slang-window-'));
  const cfg = { slang: { enabled: true, windowMax: 200, extractMinMessages: 12, extractCooldownMs: 1 } };
  const h1 = await bridgeHarness({ config: cfg, tempDir });
  h1.setReady(true);
  for (const m of groupWindow) h1.feedSlangWindow('group:456', m.sender, m.text);
  h1.feedSlangWindow('private:123', '主人', '烧心');
  ok(h1.slangWindows.get('group:456').length === 5, '窗口收下 5 条群消息');
  ok(h1.slangGroupHitCount('烧心') === 3, '群命中文数只数 group: 窗口（私聊里那句不算）');
  ok(h1.slangGroupHitCount('一次性梗') === 1, '私聊窗口不参与群黑话词频');
  h1.saveSlangWindowsNow();
  const windowFile = path.join(tempDir, 'state', 'slang-window.json');
  ok(fs.existsSync(windowFile), '窗口已落盘到 state/slang-window.json');
  const saved = JSON.parse(fs.readFileSync(windowFile, 'utf8'));
  ok(saved.windows['group:456'].length === 5 && Number.isFinite(saved.seq), '落盘内容含 5 条素材与 seq');
  await h1.close();

  // 同一个目录再起一个 harness = 桥接重启
  const h2 = await bridgeHarness({ config: cfg, tempDir });
  const restored = h2.slangWindows.get('group:456') ?? [];
  ok(restored.length === 5, `重启后读回 5 条素材（实际 ${restored.length}）`);
  ok(restored[0]?.text === '我十一点睡烧心' && restored[4]?.text === '哈哈哈哈', '读回的素材顺序与内容正确');
  ok(restored.every((m) => Number.isFinite(m.seq) && m.seq > 0), '每条素材都有 seq（dropSlangWindowMessages 靠它切片）');
  ok(h2.slangGroupHitCount('烧心') === 3, '重启后词频复核依然算得出 3');
  // 提取完把素材摘掉之后，落盘也要跟着变小（否则重启会把已学过的素材再喂一遍）
  h2.dropSlangWindowMessages('group:456', restored.slice(0, 3));
  h2.saveSlangWindowsNow();
  const after = JSON.parse(fs.readFileSync(windowFile, 'utf8'));
  ok((after.windows['group:456'] ?? []).length === 2, '提取后剩下的素材落盘为 2 条');
  await h2.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
