// 历史消息归档与检索（src/history-archive.mjs）的离线自检。
// 全程只用 os.tmpdir() 下的临时目录，绝不碰真实 state/。
// 覆盖：append/stats、中文子串、ASCII 大小写、多关键词 AND、时间范围、limit 与倒序、
//       snippet 标注、坏行跳过、保留策略 prune、扫描/时间上限的 truncated、
//       并发 append 不交错、以及 key → 文件名的防撞与防穿越。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistoryArchive, filePathFor, keyToFileName } from '../src/history-archive.mjs';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}
function section(title) {
  console.log(`\n## ${title}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-'));
const KEY = 'group:2000000001';
const day = 24 * 60 * 60 * 1000;
let caseNo = 0;
function freshDir() {
  caseNo += 1;
  const dir = path.join(tmpRoot, `case-${caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

try {
  // ── 1. append + stats ───────────────────────────────────────────────────────
  section('append 与 stats');
  {
    const dir = freshDir();
    const now = () => Date.parse('2024-05-01T12:00:00Z');
    const archive = createHistoryArchive({ dir, now });
    const first = await archive.append({
      key: KEY,
      record: { dir: 'in', senderId: '1000000001', senderName: '阿草', text: '在吗', messageId: 101 }
    });
    const second = await archive.append({
      key: KEY,
      record: { dir: 'out', text: '在的', messageId: 102, media: [{ type: 'image', file: 'a.png', bytes: 1234 }] }
    });
    ok(first.ok === true && first.seq === 1, `首条 append 成功且 seq=1（实际：${JSON.stringify(first)}）`);
    ok(second.ok === true && second.seq === 2, '第二条 seq=2（连续）');

    const stats = await archive.stats({ key: KEY });
    ok(stats.lines === 2, `stats.lines=2（实际：${stats.lines}）`);
    ok(stats.bytes > 0 && stats.files.length === 1, `stats.bytes/files 正确（bytes=${stats.bytes}, files=${stats.files.join(',')}）`);
    ok(stats.oldestTsMs === stats.newestTsMs && stats.oldestTsMs === now(), '时间范围来自 tsMs（未传时用 now() 兜底）');

    const line = JSON.parse(readLines(filePathFor(dir, KEY))[0]);
    ok(line.seq === 1 && line.dir === 'in' && line.senderName === '阿草' && line.text === '在吗', '落盘记录形状正确');
    ok(Array.isArray(line.media) && line.media.length === 0, '没媒体时 media 是空数组而不是 undefined');
    const mediaLine = JSON.parse(readLines(filePathFor(dir, KEY))[1]);
    ok(mediaLine.media[0].type === 'image' && mediaLine.media[0].bytes === 1234, 'media 只留描述性元数据');
    ok(!/base64|data:image/i.test(readLines(filePathFor(dir, KEY))[1]), '落盘内容里没有图片字节/base64');

    // 缺字段允许 undefined（序列化后键消失），不塞一堆 null
    ok(!('replyToId' in line) && !('groupId' in line), '缺的字段不写成 null，而是直接省掉');

    // 重试去重：同 messageId + 同方向不重复落盘
    const again = await archive.append({ key: KEY, record: { dir: 'in', text: '在吗', messageId: 101 } });
    ok(again.ok === true && again.deduped === true && again.seq === 1, '同 messageId 重复 append 被去重');
    const stats2 = await archive.stats({ key: KEY });
    ok(stats2.lines === 2, `去重后行数不变（实际：${stats2.lines}）`);
    archive.close();
  }

  // 时间戳异常时的兜底
  section('tsMs 兜底与 text 截断');
  {
    const dir = freshDir();
    const now = () => 1714564800000;
    const archive = createHistoryArchive({ dir, now, limits: { maxTextChars: 50 } });
    await archive.append({ key: KEY, record: { text: '甲', tsMs: 'not-a-number' } });
    const s = await archive.stats({ key: KEY });
    ok(s.oldestTsMs === now(), 'tsMs 非法时用 now() 兜底（否则时间范围会变成 NaN）');

    const long = await archive.append({ key: KEY, record: { text: '字'.repeat(500) } });
    ok(long.textTruncated === true, 'append 回报 textTruncated');
    const raw = JSON.parse(readLines(filePathFor(dir, KEY))[1]);
    ok(Array.from(raw.text).length === 50, `text 截断到上限（实际：${Array.from(raw.text).length}）`);
    archive.close();
  }

  // ── 2. 中文子串检索 ─────────────────────────────────────────────────────────
  section('中文子串检索（CJK，不分词）');
  {
    const dir = freshDir();
    let t = Date.parse('2024-03-01T00:00:00Z');
    const archive = createHistoryArchive({ dir, now: () => (t += 60000) });
    await archive.append({ key: KEY, record: { dir: 'in', text: '你看过 https://b23.tv/abc 这个视频吗' } });
    await archive.append({ key: KEY, record: { dir: 'in', text: '今天天气不错' } });
    await archive.append({ key: KEY, record: { dir: 'out', text: '那个视频我看了，还行' } });

    const res = await archive.search({ key: KEY, query: '视频' });
    ok(res.ok === true && res.hits.length === 2, `「视频」命中 2 条（实际：${res.hits.length}）`);
    ok(res.hits[0].snippet.includes('视频'), `snippet 里含关键词：${res.hits[0].snippet}`);
    // 中文中间的子串也要能命中（不是按词匹配）
    const mid = await archive.search({ key: KEY, query: '天气不错' });
    ok(mid.hits.length === 1, '中文词组中间的子串可以命中');
    const link = await archive.search({ key: KEY, query: 'b23.tv/abc' });
    ok(link.hits.length === 1 && link.hits[0].dir === 'in', 'URL 片段可以命中');
    ok(res.scanned === 3, `scanned 反映实际扫描行数（实际：${res.scanned}）`);
    archive.close();
  }

  // ── 3. ASCII 大小写不敏感 ───────────────────────────────────────────────────
  section('ASCII 大小写不敏感');
  {
    const dir = freshDir();
    const archive = createHistoryArchive({ dir });
    await archive.append({ key: KEY, record: { text: '去看 Docker Compose 配置' } });
    ok((await archive.search({ key: KEY, query: 'docker' })).hits.length === 1, '小写 query 命中大写正文');
    ok((await archive.search({ key: KEY, query: 'COMPOSE' })).hits.length === 1, '大写 query 命中');
    ok((await archive.search({ key: KEY, query: 'DOCKER compose' })).hits.length === 1, '混大小写多词仍命中');
    ok((await archive.search({ key: KEY, query: 'DOCKER' })).hits[0].snippet.includes('【Docker】'),
      'snippet 用【】标出命中的原文（保留原大小写）');
    archive.close();
  }

  // ── 4. 多关键词 AND ────────────────────────────────────────────────────────
  section('多关键词是 AND');
  {
    const dir = freshDir();
    const archive = createHistoryArchive({ dir });
    await archive.append({ key: KEY, record: { text: '小鲸鱼 喜欢 吃 小鱼干' } });
    await archive.append({ key: KEY, record: { text: '小鲸鱼 今天 潜水' } });
    await archive.append({ key: KEY, record: { text: '小鱼干 真香' } });
    const both = await archive.search({ key: KEY, query: '小鲸鱼 小鱼干' });
    ok(both.hits.length === 1, `两词都出现才命中（实际：${both.hits.length}）`);
    ok(both.hits[0].snippet.includes('小鲸鱼'), 'AND 命中时 snippet 至少标出一个关键词');
    ok((await archive.search({ key: KEY, query: '小鲸鱼 不存在词' })).hits.length === 0, '有一个词不出现就整条不命中');
    const spaced = await archive.search({ key: KEY, query: '  小鲸鱼   潜水  ' });
    ok(spaced.hits.length === 1, '多余空格被折叠，不产生空关键词');
    const empty = await archive.search({ key: KEY, query: '   ' });
    ok(empty.ok === false && empty.hits.length === 0, '空 query 返回 ok:false 而不是全库命中');
    archive.close();
  }

  // ── 5. 时间范围过滤 ────────────────────────────────────────────────────────
  section('时间范围过滤（sinceMs / untilMs）');
  {
    const dir = freshDir();
    const base = Date.parse('2024-04-01T00:00:00Z');
    let t = base;
    const archive = createHistoryArchive({ dir, now: () => (t += 1000) });
    for (let i = 0; i < 10; i += 1) {
      await archive.append({ key: KEY, record: { text: `第${i}条 进度`, tsMs: base + i * day } });
    }
    const windowed = await archive.search({ key: KEY, query: '进度', sinceMs: base + 3 * day, untilMs: base + 5 * day });
    ok(windowed.hits.length === 3, `闭区间 [3,5] 命中 3 条（实际：${windowed.hits.length}）`);
    ok(windowed.hits.every((h) => h.tsMs >= base + 3 * day && h.tsMs <= base + 5 * day), '所有命中都落在范围内');
    ok(windowed.hits[0].tsMs === base + 5 * day, '范围内仍是最近的先返回');

    const openEnd = await archive.search({ key: KEY, query: '进度', sinceMs: base + 8 * day });
    ok(openEnd.hits.length === 2, `只给 sinceMs 时命中其后 2 条（实际：${openEnd.hits.length}）`);
    const openStart = await archive.search({ key: KEY, query: '进度', untilMs: base + 1 * day });
    ok(openStart.hits.length === 2, `只给 untilMs 时命中其前 2 条（实际：${openStart.hits.length}）`);
    ok((await archive.search({ key: KEY, query: '进度', sinceMs: base + 50 * day })).hits.length === 0, '范围外为空');
    ok((await archive.search({ key: KEY, query: '进度' })).hits.length === 10, '不给范围时全部可见');
    archive.close();
  }

  // ── 6. limit 与倒序 ───────────────────────────────────────────────────────
  section('limit 与时间倒序');
  {
    const dir = freshDir();
    const base = Date.parse('2024-06-01T00:00:00Z');
    const archive = createHistoryArchive({ dir });
    for (let i = 0; i < 60; i += 1) {
      await archive.append({ key: KEY, record: { seq: i, text: `记录${i}`, tsMs: base + i * 1000 } });
    }
    const def = await archive.search({ key: KEY, query: '记录' });
    ok(def.hits.length === 20, `默认 limit=20（实际：${def.hits.length}）`);
    ok(def.hits[0].tsMs > def.hits[1].tsMs && def.hits[19].tsMs === base + 40 * 1000,
      '按时间倒序：第一条最新，limit 截断的是更旧的一头');
    ok(def.truncated === true, '还有更旧的命中没返回时 truncated=true');

    const five = await archive.search({ key: KEY, query: '记录', limit: 5 });
    ok(five.hits.length === 5 && five.hits[0].tsMs === base + 59 * 1000, 'limit=5 取最近 5 条');
    const over = await archive.search({ key: KEY, query: '记录', limit: 999 });
    ok(over.hits.length <= 50, `limit 上限锁在 50（实际：${over.hits.length}）`);
    const bad = await archive.search({ key: KEY, query: '记录', limit: -3 });
    ok(bad.ok === true && bad.hits.length === 1, 'limit 非法时钳到 1 而不是返回全部');

    const all = await archive.search({ key: KEY, query: '记录', limit: 50, sinceMs: base });
    ok(all.hits.length === 50 && all.truncated === true, '50 条满额且还有剩余时仍标 truncated');
    for (let i = 1; i < all.hits.length; i += 1) {
      assert.ok(all.hits[i - 1].tsMs >= all.hits[i].tsMs, '时序必须单调不增');
    }
    ok(true, '全部命中时序单调不增');
    archive.close();
  }

  // ── 7. snippet 细节 ───────────────────────────────────────────────────────
  section('snippet 生成');
  {
    const dir = freshDir();
    const archive = createHistoryArchive({ dir });
    const long = '前面' + '废'.repeat(200) + '目标词' + '话'.repeat(200) + '后面';
    await archive.append({ key: KEY, record: { text: long } });
    const res = await archive.search({ key: KEY, query: '目标词' });
    const snip = res.hits[0].snippet;
    ok(snip.includes('【目标词】'), '命中词被【】包住');
    ok(Array.from(snip).length < 120, `长消息只取命中附近（实际 ${Array.from(snip).length} 字）`);
    ok(snip.startsWith('…') && snip.endsWith('…'), '两侧被截断时补省略号');

    await archive.append({ key: KEY, record: { text: '目标词就在开头' } });
    const shortRes = await archive.search({ key: KEY, query: '目标词' });
    ok(shortRes.hits[0].snippet === '【目标词】就在开头', `命中词贴边时既不加前置省略号也不丢字符（实际：${shortRes.hits[0].snippet}）`);

    // 发送者名也能搜到（否则「某人说过的话」没法查）
    await archive.append({ key: KEY, record: { text: '无关内容', senderName: '阿草' } });
    ok((await archive.search({ key: KEY, query: '阿草' })).hits.length === 1, '发送者名参与检索');
    archive.close();
  }

  // ── 8. 坏行容错 ───────────────────────────────────────────────────────────
  section('坏行跳过不炸');
  {
    const dir = freshDir();
    const file = filePathFor(dir, KEY);
    fs.mkdirSync(dir, { recursive: true });
    const good = (seq, text, tsMs) => JSON.stringify({ seq, tsMs, dir: 'in', text, media: [] });
    fs.writeFileSync(file, [
      good(1, '好行一号', 1000),
      '{这不是 JSON',
      '',
      good(2, '好行二号', 2000),
      '{"seq":3,"tsMs":3000,',
      good(4, '好行四号', 4000)
    ].join('\n') + '\n', 'utf8');

    const archive = createHistoryArchive({ dir });
    const res = await archive.search({ key: KEY, query: '好行' });
    ok(res.ok === true && res.hits.length === 3, `坏行不影响好行检索（实际：${res.hits.length}）`);
    ok(res.hits[0].seq === 4 && res.hits[0].snippet.includes('四号'),
      `坏行之后的行照样能读到，且仍是最近的先返回（首条：${res.hits[0].snippet}）`);
    ok(res.badLines === 2, `坏行被计数（实际：${res.badLines}）`);

    const stats = await archive.stats({ key: KEY });
    // 总行数按换行符计（含坏行、不含空行）：好行 3 + 坏行 2 = 5；badLines 单独告诉调用方有多少行解析不了。
    ok(stats.lines === 5 && stats.badLines === 2,
      `stats 按换行符计总行数并单独报坏行（lines=${stats.lines}, bad=${stats.badLines}）`);

    // 坏行之后 append 仍拿到正确的 seq（不会被坏行卡住）
    const appended = await archive.append({ key: KEY, record: { text: '新的一条' } });
    ok(appended.ok === true && appended.seq === 5, `坏行之后 seq 继续（实际：${appended.seq}）`);
    const after = await archive.search({ key: KEY, query: '新的一条' });
    ok(after.hits.length === 1, '新写入的行立即可检索');
    archive.close();
  }

  // ── 9. 空库 / 不存在 / 非法 key ────────────────────────────────────────────
  section('空库与边界');
  {
    const dir = freshDir();
    const archive = createHistoryArchive({ dir });
    const s = await archive.stats({ key: 'private:999' });
    ok(s.lines === 0 && s.bytes === 0 && s.oldestTsMs === null, '文件不存在 = 空库，不报错');
    const r = await archive.search({ key: 'private:999', query: '任何' });
    ok(r.ok === true && r.hits.length === 0 && r.truncated === false, '空库检索返回空结果且不算 truncated');
    const badKey = await archive.append({ key: '   ', record: { text: 'x' } });
    ok(badKey.ok === false && /key 不能为空/.test(badKey.error), '空 key 返回可读错误');
    archive.close();
    const afterClose = await archive.append({ key: KEY, record: { text: 'x' } });
    ok(afterClose.ok === false && /close/.test(afterClose.error), 'close 之后 append 被拒且返回可读错误');
  }

  // ── 10. 写失败的降级（把 history 目录占成一个文件） ─────────────────────────
  section('写失败降级');
  {
    const dir = freshDir();
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a dir', 'utf8');
    const archive = createHistoryArchive({ dir: blocked });
    const res = await archive.append({ key: KEY, record: { text: '写不进去' } });
    ok(res.ok === false && /追加失败/.test(res.error) && res.error.includes('blocked'),
      `写失败返回可读错误而不是抛异常（实际：${res.error}）`);
    archive.close();
  }

  // ── 11. 保留策略 prune ────────────────────────────────────────────────────
  section('保留策略 prune');
  {
    const dir = freshDir();
    const base = Date.parse('2024-01-01T00:00:00Z');
    const now = () => base + 100 * day;
    const archive = createHistoryArchive({ dir, now });
    for (let i = 0; i < 10; i += 1) {
      await archive.append({ key: KEY, record: { text: `第${i}天`, tsMs: base + i * day } });
    }
    // 保留最近 5 天：第 0~4 天应被删掉
    const pruned = await archive.prune({ key: KEY, beforeMs: base + 5 * day });
    ok(pruned.ok === true && pruned.removedLines === 5, `按时间删掉 5 行（实际：${pruned.removedLines}）`);
    const rest = await archive.search({ key: KEY, query: '第', limit: 50, sinceMs: 0 });
    ok(rest.hits.length === 5, `删后剩 5 条（实际：${rest.hits.length}）`);
    ok(rest.hits.every((h) => h.tsMs >= base + 5 * day), '最旧的行消失、最新的一批全部保留');
    ok(rest.hits[0].tsMs === base + 9 * day, '最新的那条还在');
    const st = await archive.stats({ key: KEY });
    ok(st.lines === 5 && st.bytes === fs.statSync(filePathFor(dir, KEY)).size, 'stats 与重写后的文件一致');
    ok(!fs.readdirSync(dir).some((f) => f.includes('.part-')), '重写用的临时文件已被 rename 掉，没有残留');

    // 默认保留窗口（不传 beforeMs）：用 limits.retentionDays 兜底
    const dir2 = freshDir();
    const archive2 = createHistoryArchive({ dir: dir2, now, limits: { retentionDays: 3 } });
    for (let i = 0; i < 6; i += 1) {
      await archive2.append({ key: KEY, record: { text: `d${i}`, tsMs: now() - (i + 1) * day } });
    }
    const defPrune = await archive2.prune({ key: KEY });
    ok(defPrune.ok === true && defPrune.removedLines === 3, `不传 beforeMs 时用默认保留天数（实际删 ${defPrune.removedLines}）`);
    archive2.close();

    // maxBytes：从最旧开始削到体积上限内
    const dir3 = freshDir();
    const archive3 = createHistoryArchive({ dir: dir3 });
    for (let i = 0; i < 40; i += 1) {
      await archive3.append({ key: KEY, record: { text: `体积测试第${i}条 ` + 'x'.repeat(100), tsMs: base + i * 1000 } });
    }
    const before = (await archive3.stats({ key: KEY })).bytes;
    const byBytes = await archive3.prune({ key: KEY, beforeMs: 0, maxBytes: Math.floor(before / 4) });
    ok(byBytes.ok === true && byBytes.bytesAfter <= Math.floor(before / 4), `maxBytes 生效（${before} → ${byBytes.bytesAfter}）`);
    const keptNewest = await archive3.search({ key: KEY, query: '体积测试第39条' });
    ok(keptNewest.hits.length === 1, '削体积时保留的是最新的那批');
    ok((await archive3.search({ key: KEY, query: '体积测试第0条' })).hits.length === 0, '最旧的已被削掉');
    archive3.close();

    // 坏行在 prune 时被清掉，且不抛
    const dir4 = freshDir();
    const file4 = filePathFor(dir4, KEY);
    fs.mkdirSync(dir4, { recursive: true });
    fs.writeFileSync(file4, '{"seq":1,"tsMs":' + (base + 9 * day) + ',"dir":"in","text":"新的","media":[]}\n坏行\n', 'utf8');
    const archive4 = createHistoryArchive({ dir: dir4, now });
    const p4 = await archive4.prune({ key: KEY, beforeMs: base + 5 * day });
    ok(p4.ok === true && p4.badLines === 1 && p4.removedLines === 1, 'prune 顺手清掉坏行并计数');
    ok(readLines(file4).length === 1, '重写后只剩好行');
    archive4.close();
  }

  // ── 12. append 触发保留检查 ───────────────────────────────────────────────
  section('append 触发保留检查（pruneEvery）');
  {
    const dir = freshDir();
    const retentionArchive = createHistoryArchive({
      dir,
      limits: { pruneEvery: 5, maxBytes: 4096, retentionDays: 3650, pruneMaxScanLines: 100000 }
    });
    for (let i = 0; i < 200; i += 1) {
      await retentionArchive.append({ key: KEY, record: { text: `充数第${i}条 ` + 'y'.repeat(60) } });
    }
    await new Promise((resolve) => setTimeout(resolve, 150)); // 后台保留检查排在写队列里
    const size = (await retentionArchive.stats({ key: KEY })).bytes;
    ok(size <= 4096 * 1.5, `超过 maxBytes 后 append 自己触发了裁剪（实际 ${size} 字节）`);
    const newest = await retentionArchive.search({ key: KEY, query: '充数第199条' });
    ok(newest.hits.length === 1, '裁剪不会把刚写的最新记录删掉');
    // close 之后残留的后台保留任务不能变成 unhandled rejection
    retentionArchive.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterClose = await retentionArchive.append({ key: KEY, record: { text: 'x' } });
    ok(afterClose.ok === false && /close/.test(afterClose.error), 'close 之后 append 被拒且返回可读错误');
  }

  // ── 13. 扫描上限 / 时间上限 → truncated ───────────────────────────────────
  section('扫描上限与时间上限');
  {
    const dir = freshDir();
    const archive = createHistoryArchive({
      dir, limits: { chunkSize: 128, maxScanBytes: 400, maxScanLines: 20 }
    });
    for (let i = 0; i < 60; i += 1) {
      await archive.append({ key: KEY, record: { text: `扫描${i} 关键词`, tsMs: 1700000000000 + i * 1000 } });
    }
    const res = await archive.search({ key: KEY, query: '关键词', limit: 50 });
    ok(res.ok === true && res.truncated === true, '撞到扫描预算时 truncated=true');
    ok(res.scanned <= 20, `行数上限生效（实际扫了 ${res.scanned} 行）`);
    ok(res.hits.length > 0 && res.hits.length < 60, `返回了已找到的部分（${res.hits.length} 条）`);
    ok(res.hits[0].tsMs === 1700000000000 + 59 * 1000, '部分结果仍是最近的先返回');

    // 每条 ~110 字节、预算 1024 字节 → 只能看到最近约 9 条，必然标 truncated 且拿不到更旧的。
    const dir2 = freshDir();
    const a2 = createHistoryArchive({ dir: dir2, limits: { maxScanBytes: 1024, chunkSize: 64 } });
    for (let i = 0; i < 60; i += 1) {
      await a2.append({ key: KEY, record: { text: `字节${i} 命中词 ` + 'x'.repeat(60), tsMs: 1700000000000 + i * 1000 } });
    }
    const r2 = await a2.search({ key: KEY, query: '命中词' });
    ok(r2.truncated === true && r2.hits.length > 0 && r2.hits[0].tsMs === 1700000000000 + 59 * 1000
      && r2.hits.length < 60,
      `字节预算耗尽时返回已找到的部分（扫 ${r2.scanned} 行 / ${r2.hits.length} 条）并标 truncated`);
    ok((await a2.search({ key: KEY, query: '字节0 命中词' })).hits.length === 0,
      '预算之外的最旧记录确实没被读到（truncated 不是谎报）');
    a2.close();

    // 时间上限（timeLimitMs 允许按次覆盖，测试不必真等 2 秒）
    const dir3 = freshDir();
    const a3 = createHistoryArchive({ dir: dir3, limits: { chunkSize: 64, maxScanBytes: 1024 * 1024 } });
    for (let i = 0; i < 4000; i += 1) {
      await a3.append({ key: KEY, record: { text: `时间${i} 命中词 ` + 'z'.repeat(40), tsMs: 1700000000000 + i } });
    }
    const r3 = await a3.search({ key: KEY, query: '命中词', timeLimitMs: 1 });
    ok(r3.ok === true && r3.truncated === true, '耗时上限被触发时返回已找到的部分并标 truncated');
    ok(r3.hits.every((h) => Number.isFinite(h.tsMs) && typeof h.snippet === 'string'), '部分结果结构完整');
    a3.close();
  }

  // ── 14. 并发 append 不交错 ────────────────────────────────────────────────
  section('并发 append 不交错');
  {
    const dir = freshDir();
    const archive = createHistoryArchive({ dir, limits: { pruneEvery: 100000 } });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        archive.append({ key: KEY, record: { dir: i % 2 ? 'out' : 'in', text: `并发第${i}条`, messageId: 1000 + i } }))
    );
    ok(results.every((r) => r.ok === true), '20 条并发 append 全部成功');
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    ok(seqs.length === new Set(seqs).size, `seq 无重复（${seqs.join(',')}）`);
    ok(seqs[0] === 1 && seqs[seqs.length - 1] === 20, 'seq 连续覆盖 1..20');
    const lines = readLines(filePathFor(dir, KEY));
    ok(lines.length === 20, `落盘 20 行（实际：${lines.length}）`);
    let allParse = true;
    const seenTexts = new Set();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (typeof rec.text !== 'string') allParse = false;
        seenTexts.add(rec.text);
      } catch { allParse = false; }
    }
    ok(allParse, '每一行都是完整可解析的 JSON（写没有交错）');
    ok(seenTexts.size === 20, '20 条内容各不相同、没有互相覆盖');

    // 跨会话并发也不能串文件
    const other = 'private:1000000001';
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => archive.append({ key: KEY, record: { text: `群${i}` } })),
      ...Array.from({ length: 5 }, (_, i) => archive.append({ key: other, record: { text: `私聊${i}` } }))
    ]);
    const groupHits = await archive.search({ key: KEY, query: '群' , limit: 50 });
    const privHits = await archive.search({ key: other, query: '私聊', limit: 50 });
    ok(groupHits.hits.length === 5 && privHits.hits.length === 5, '两个会话各写各的文件（不串历史）');
    ok((await archive.search({ key: KEY, query: '私聊' })).hits.length === 0, '群会话搜不到私聊内容');
    archive.close();
  }

  // ── 15. key → 文件名 ──────────────────────────────────────────────────────
  section('key 到文件名的映射');
  {
    const g = keyToFileName('group:2000000001');
    const p = keyToFileName('private:2000000001');
    ok(!g.includes(':') && g.endsWith('.jsonl'), `文件名不含冒号（${g}）`);
    ok(g !== p, '同号不同前缀不撞同一文件（否则会跨会话串历史）');
    ok(keyToFileName('group:2000000001') === g, '同一 key 映射稳定（可以幂等重算）');
    ok(keyToFileName('123456') === keyToFileName('group:123456'), '纯数字 key 归一化成群号');
    ok(!keyToFileName('../../etc/passwd').includes('/') && !keyToFileName('..\\..\\evil').includes('\\'),
      '路径穿越字符被消掉');
    ok(keyToFileName('a'.repeat(500)).length < 80, '超长 key 的文件名仍然短');
    const dir = freshDir();
    let threw = false;
    try { filePathFor(dir, 'group:1'); } catch { threw = true; }
    ok(threw === false, '合法 key 不误报越界');
    const outside = filePathFor(path.join(dir, 'sub'), 'group:1');
    ok(outside.startsWith(path.join(dir, 'sub') + path.sep) || outside.startsWith(path.join(dir, 'sub') + '/'),
      '生成的文件路径一定落在给定目录内');
  }

  // ── 16. 回归：尾部倒读的行边界（曾经 shift() 丢掉最旧一行 → 检索漏命中） ──────
  section('回归：倒读行边界与跨块检索');
  {
    // 16a. 复现「最早一行也必须能被搜到」：手写两行合法 JSON，第一行就是文件最旧的一行。
    //      文件只有 ~70 字节而块大小压到 24，逼出「第一行单独落在更早的块里」的边界。
    const srcDir = freshDir();
    const srcFile = filePathFor(srcDir, 'group:1');
    const rec = (seq, text, tsMs) => JSON.stringify({ seq, tsMs, dir: 'in', text, media: [] });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(srcFile, [
      rec(1, 'OLDEST 进度', 1700000000000),
      rec(2, 'NEWEST 进度', 1700000001000)
    ].join('\n') + '\n', 'utf8');
    const archive = createHistoryArchive({ dir: srcDir, limits: { chunkSize: 24 } });
    const srcStats = await archive.stats({ key: 'group:1' });
    ok(srcStats.lines === 2, `文件确实有 2 行（实际 ${srcStats.lines}）`);
    const sixHits = await archive.search({ key: 'group:1', query: '进度', limit: 50 });
    ok(sixHits.hits.length === 2, `最早一行也命中（实际 ${sixHits.hits.length} 条）`);
    ok(sixHits.hits[0].snippet.includes('NEWEST') && sixHits.hits[1].snippet.includes('OLDEST'),
      '倒序：新的在前、最旧的一行在末尾也没被丢掉');

    // 16b. 跨块边界：单块只覆盖 64 字节，第 1 行与最后一行都命中，两条都要返回。
    const dir = freshDir();
    const archive2 = createHistoryArchive({ dir, limits: { chunkSize: 64 } });
    const total = 240;
    for (let i = 1; i <= total; i += 1) {
      const text = i === 1
        ? 'HEAD 边界词 文件最旧的一行'
        : `${i === total ? 'TAIL 边界词 文件最新的一行' : `中间第${i}行`} 填充` + '填'.repeat(40);
      await archive2.append({ key: KEY, record: { text, tsMs: 1700000000000 + i * 1000 } });
    }
    const boundary = await archive2.search({ key: KEY, query: '边界词', limit: 50 });
    ok(boundary.hits.length === 2, `跨块边界时首行+末行都命中（实际 ${boundary.hits.length}）`);
    ok(boundary.hits[0].snippet.includes('TAIL'), '较新的一条（末行）排在前面');
    ok(boundary.hits[1].snippet.includes('HEAD'), '较旧的一条（首行）排在后面，没有被块切分丢掉');
    ok(boundary.scanned === total, `scanned = 检查过的行数 = ${total}（实际 ${boundary.scanned}）`);

    // 16c. 多关键词 AND 也要能跨越多个块命中同一条记录。
    const dir2 = freshDir();
    const archive3 = createHistoryArchive({ dir: dir2, limits: { chunkSize: 64 } });
    await archive3.append({ key: KEY, record: { text: '苹果' + '垫'.repeat(80) } });
    await archive3.append({ key: KEY, record: { text: '苹果 和 香蕉 同时出现在第 2 行 ' + '垫'.repeat(60) } });
    for (let i = 3; i <= 60; i += 1) {
      await archive3.append({ key: KEY, record: { text: (i % 2 ? '苹果' : '香蕉') + ` 第${i}行 ` + '垫'.repeat(60) } });
    }
    const andHits = await archive3.search({ key: KEY, query: '苹果 香蕉', limit: 50 });
    ok(andHits.hits.length === 1, `跨块时 AND 只命中同时含两词的那条（实际 ${andHits.hits.length}）`);
    ok(andHits.hits[0].snippet.includes('苹果') && andHits.hits[0].snippet.includes('香蕉'),
      `AND 命中的 snippet 标出了关键词：${andHits.hits[0].snippet}`);
    ok(andHits.scanned === 60, `AND 检索也扫描了全部 60 行（实际 ${andHits.scanned}）`);

    // 16d. 多块（>1 个 chunk）时最旧与最新都能命中，且 scanned 与总行数一致。
    const dir3 = freshDir();
    const archive4 = createHistoryArchive({ dir: dir3, limits: { chunkSize: 256 } });
    await archive4.append({ key: KEY, record: { text: 'OLDEST 跨块词 ' + '垫'.repeat(200) } });
    for (let i = 2; i <= 199; i += 1) {
      await archive4.append({ key: KEY, record: { text: `第${i}行 ` + '垫'.repeat(100) } });
    }
    await archive4.append({ key: KEY, record: { text: 'NEWEST 跨块词 ' + '垫'.repeat(200) } });
    const two = await archive4.search({ key: KEY, query: '跨块词', limit: 50 });
    ok(two.hits.length === 2, `200 行 4 块以上时首尾两条都命中（实际 ${two.hits.length}）`);
    ok(two.hits[0].snippet.includes('NEWEST') && two.hits[1].snippet.includes('OLDEST'), '两条命中顺序仍是新的在前');
    ok(two.scanned === 200, `scanned = 200（实际 ${two.scanned}）`);

    // 16e. appended 后 stats 与文件真实行数一致（曾因丢行少 1）。
    const dir4 = freshDir();
    const archive5 = createHistoryArchive({ dir: dir4 });
    for (let i = 0; i < 7; i += 1) await archive5.append({ key: KEY, record: { text: `行${i}` } });
    const realLines = readLines(filePathFor(dir4, KEY)).length;
    const st = await archive5.stats({ key: KEY });
    ok(st.lines === realLines && realLines === 7, `stats.lines 与文件真实行数一致（${st.lines} / ${realLines}）`);
    archive5.close();

    // 16f. 文件最后一行没有尾随换行（句柄被 kill / 半截写入 / 外部工具改写）：
    //      这一行仍是一条真记录，不能被当成「不完整的尾巴」丢掉——曾经整库都变成坏行。
    const dir5 = freshDir();
    const file5 = filePathFor(dir5, KEY);
    fs.mkdirSync(dir5, { recursive: true });
    const lastRec = JSON.stringify({ seq: 2, tsMs: 1700000003000, dir: 'in', text: 'LAST 无换行结尾', media: [] });
    fs.writeFileSync(file5, rec(1, '第一行 关键词A', 1700000001000) + '\n' + lastRec, 'utf8');
    const archive6 = createHistoryArchive({ dir: dir5, limits: { chunkSize: 32 } });
    const noNewline = await archive6.search({ key: KEY, query: '无换行结尾', limit: 50 });
    ok(noNewline.hits.length === 1 && noNewline.hits[0].seq === 2,
      `没有尾随换行的最后一行仍被读到（实际 ${noNewline.hits.length} 条）`);
    const bothLines = await archive6.stats({ key: KEY });
    ok(bothLines.lines === 2 && bothLines.badLines === 0,
      `无换行结尾时两行都算数、一条都不坏（lines=${bothLines.lines}, bad=${bothLines.badLines}）`);
    // 往「最后一行没有尾随换行」的老文件里 append：必须自愈补一个换行，
    // 否则新记录会粘在旧记录尾巴上，两条一起变成坏行（真实数据丢失）。
    const healed = await archive6.append({ key: KEY, record: { text: '自愈后写进来的新记录' } });
    ok(healed.ok === true && healed.seq === 3, `无换行老文件里 append 拿到续号 ${healed.seq}`);
    const afterHeal = await archive6.search({ key: KEY, query: '记录', limit: 50 });
    ok(afterHeal.hits.length === 1 && afterHeal.hits[0].seq === 3 && afterHeal.badLines === 0,
      `自愈后新记录可检索、且没有粘连坏行（命中 ${afterHeal.hits.length} 条 / bad ${afterHeal.badLines}）`);
    const healedAll = await archive6.stats({ key: KEY });
    ok(fs.readFileSync(file5, 'utf8').endsWith('\n') && healedAll.lines === 3,
      `append 之后文件以换行结尾且行数为 3（实际 ${healedAll.lines}）`);
    archive6.close();

    archive.close(); archive2.close(); archive3.close(); archive4.close();
  }
} catch (error) {
  fail += 1;
  console.error('  ❌ 用例抛异常：', error?.stack ?? error);
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
