// 自主提醒存储/调度模块（src/reminders.js）自检：
// 全部在 os.tmpdir() 下的临时目录里跑，**绝不碰真实的 state/reminders.json**，不联网、不发 QQ 消息。
// 覆盖：新增/排序/取消/取消全部、到期判断、daily（含跨天）与 weekly 顺延、重复触发不二次返回、
//       非法 key / 过短文本 / 过去时间 / 超 90 天 / 条数上限被拒、损坏 JSON 降级 + 备份、
//       due() 只读不落盘、原子写不留 .part- 残渣、prune、stats。
//
// 跑法：node scripts/test-reminders.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemindersStore, isValidSessionKey, REMINDER_LIMITS, SESSION_KEY_RE } from '../src/reminders.js';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-test-'));
// 用「本地时间 2026-05-01 08:00」当基准：模块按本机本地时间理解，用本地构造函数才不会被时区带偏。
const base = new Date(2026, 4, 1, 8, 0, 0, 0).getTime();

/** 每个用例一个独立文件 + 可控假时钟。 */
function makeStore(tag, { limits, t0 = base } = {}) {
  const clock = { t: t0 };
  const file = path.join(dir, `${tag}.json`);
  const store = createRemindersStore({ file, now: () => clock.t, limits });
  return { store, file, clock };
}

console.log('## 空库与只读');
{
  const { store, file } = makeStore('empty');
  ok(store.list().length === 0, '文件不存在时 list() 返回空数组');
  ok(store.stats().total === 0 && store.stats().pending === 0 && store.stats().nextDueAt === null, '空库 stats 全 0 / nextDueAt 为 null');
  ok(store.warnings.length === 0, '文件不存在不算异常，无警告');
  ok(!fs.existsSync(file), '只读操作不会凭空创建状态文件');
  ok(store.due(base + DAY).length === 0, '空库 due() 返回空数组');
}

console.log('## 新增 / 列表排序 / 字段');
{
  const { store, file, clock } = makeStore('add');
  const later = base + 3 * HOUR;
  const sooner = base + 30 * 60 * 1000;
  const r1 = store.add({ key: 'group:100', text: '  该吃药了  ', dueAt: later, createdBy: 'agent' });
  const r2 = store.add({ key: 'group:100', text: '拿快递', dueAt: sooner, createdBy: 'user:1', repeat: 'daily' });
  ok(r1.ok && r2.ok, `两条都新增成功（实际：${r1.error ?? 'ok'} / ${r2.error ?? 'ok'}）`);
  ok(r1.item.text === '该吃药了', 'text 去掉首尾空白后落库');
  ok(r1.item.repeat === 'none' && r1.item.firedAt === null && r1.item.lastFiredAt === null, '默认 repeat=none，firedAt/lastFiredAt 为空');
  ok(r1.item.createdAt === base && r1.item.createdBy === 'agent', 'createdAt 用注入的 now()，createdBy 原样保留');
  ok(/^r[0-9a-z]{6}$/.test(r1.item.id), `id 是短的 r+6 位 base36（实际：${r1.item.id}）`);
  ok(r1.item.id !== r2.item.id, '两条 id 不同');
  const r3 = store.add({ key: 'group:100', text: '最晚那条', dueAt: base + 5 * HOUR });
  ok(r3.ok === true, '第三条（最晚）也加成功');

  const list = store.list({ key: 'group:100' });
  ok(list.length === 3, `list 返回 3 条（实际 ${list.length}）`);
  ok(list[0].dueAt <= list[1].dueAt && list[1].dueAt <= list[2].dueAt, '按 dueAt 升序');
  ok(list[2].id === r3.item.id && list[0].id === r2.item.id, '晚加的排后面，最早的那条排最前');
  ok(typeof list[0].inMs === 'number' && list[0].inMs === sooner - base, `每项带 inMs（实际 ${list[0].inMs}）`);
  ok(/^2026-05-01 08:30 周[日一二三四五六]$/.test(list[0].dueText), `dueText 是本地可读时间（实际：${list[0].dueText}）`);
  ok(typeof list[0].inText === 'string' && list[0].inText.length > 0, `每项带相对时间文案（实际：${list[0].inText}）`);
  ok(list.every((it) => it.done === false), '未完成项 done=false');

  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  store.list();
  store.list({ includeDone: true });
  store.due(base + 10 * DAY);
  store.stats();
  clock.t += 1000;
  store.list();
  ok(fs.readFileSync(file, 'utf8') === before, 'list/due/stats 不改文件内容（只读不落盘）');
  ok(fs.statSync(file).mtimeMs === mtime, '只读操作不刷新 mtime');
  ok(JSON.parse(before).version === 1 && Array.isArray(JSON.parse(before).items), '落盘形状是 { version: 1, items: [] }');
  ok(fs.readdirSync(dir).filter((f) => f.includes('.part-')).length === 0, '原子写没留下 .part- 临时文件');
  ok(store.add({ key: 'group:100', text: '  a\n\n b  ', dueAt: base + HOUR }).item.text === 'a b', '文本里的换行折成空格（避免一条 QQ 消息被拆段）');
}

console.log('## 到期判断（due 只读）');
{
  const { store, clock } = makeStore('due');
  const soon = store.add({ key: 'group:200', text: '一分钟后', dueAt: base + 60 * 1000 });
  const far = store.add({ key: 'group:200', text: '一小时后', dueAt: base + HOUR });
  ok(store.due(base).length === 0, '还没到点 → due() 为空');
  ok(store.due(base + 60 * 1000).length === 1, '刚好到点 → 返回 1 条');
  ok(store.due(base + 60 * 1000)[0].id === soon.item.id, '返回的是到点的那条');
  ok(store.due(base + HOUR).length === 2, '两条都到点时返回 2 条，且按 dueAt 升序');
  ok(store.due(base + HOUR)[0].id === soon.item.id, '升序第一条是最早的');
  ok(store.due(base + HOUR)[1].id === far.item.id, '升序第二条是后到的');
  ok(store.due(base + 10 * DAY).length === 2, 'due() 不改状态：反复调用仍返回同两条');
  ok(store.stats().pending === 2 && store.stats().nextDueAt === base + 60 * 1000, 'stats.nextDueAt 是最早的待触发时间');
  clock.t = base + HOUR;
  const late = store.due(base + HOUR)[0];
  ok(late.inMs <= 0 && late.lateMs >= 0, '过期项 inMs<=0 且 lateMs>0');
  ok(store.raw().items.length === 2, 'raw() 快照与内存一致（2 条）');
}

console.log('## 取消 / 取消全部');
{
  const { store } = makeStore('cancel');
  const a = store.add({ key: 'group:300', text: 'A', dueAt: base + HOUR });
  const b = store.add({ key: 'group:300', text: 'B', dueAt: base + 2 * HOUR });
  const c = store.add({ key: 'private:9', text: 'C', dueAt: base + 3 * HOUR });
  ok(store.cancel({ key: 'group:301', id: a.item.id }) === 0, 'key 不匹配 → 取消 0 条（防串会话误删）');
  ok(store.list({ key: 'group:300' }).length === 2, 'key 不匹配时条目还在');
  ok(store.cancel({ key: 'group:300', id: a.item.id }) === 1, 'id+key 都对 → 取消 1 条');
  ok(store.list({ key: 'group:300' }).length === 1, '取消后只剩 1 条');
  ok(store.cancel({ key: 'group:300', id: a.item.id }) === 0, '重复取消同一条返回 0（幂等）');
  ok(store.cancel({ id: b.item.id }) === 1, '只给 id 也能取消');
  ok(store.cancelAll({ key: 'group:300' }) === 0, 'group:300 已经空了 → 取消全部 0 条');
  ok(store.cancelAll({ key: 'private:9' }) === 1, 'cancelAll 清掉该会话的条目');
  ok(store.cancelAll({ key: 'private:9' }) === 0, '再取消全部返回 0');
  ok(store.list().length === 0 && store.stats().total === 0, '全部取消后库里空了');
  ok(store.cancelAll({ key: '' }) === 0, '空 key 不做任何事');
}

console.log('## repeat:daily 顺延（含跨天）');
{
  const { store } = makeStore('daily');
  const d0 = base + 60 * 1000;                                   // 第一天 08:01
  const r = store.add({ key: 'group:400', text: '喝水', dueAt: d0, repeat: 'daily' });
  ok(r.ok && r.item.repeat === 'daily', 'daily 提醒新增成功');
  ok(store.due(d0).length === 1 && store.due(d0)[0].id === r.item.id, '到点被 due() 返回');
  const fired = store.markFired({ id: r.item.id, nowMs: d0 });
  ok(fired.ok && fired.done === false && fired.changed === true, 'markFired 成功且不是「完成」（重复项仍在）');
  ok(fired.nextDueAt === d0 + DAY, `顺延到 +24h（实际 ${new Date(fired.nextDueAt).toString()}）`);
  ok(new Date(fired.nextDueAt).getHours() === 8 && new Date(fired.nextDueAt).getMinutes() === 1, '顺延后本地时刻不变（仍是 08:01）');
  ok(fired.item.lastFiredAt === d0 && fired.item.firedAt === null, '重复项只更新 lastFiredAt，不置 firedAt');
  ok(store.due(d0 + DAY - 1).length === 0, '顺延后还没到点 → due() 不再返回它');
  ok(store.due(d0 + DAY).length === 1, '第二天同一时刻重新到点');
  ok(store.due(d0 + DAY)[0].dueAt === d0 + DAY, '重新到点的 dueAt 就是顺延后的值');

  // 跨天（桥接整天没跑）：不补发积压的多次，直接顺延到第一个未来时刻
  const lateNow = d0 + DAY + HOUR;                               // 第二天 09:01（第二天的 08:01 也早过了）
  const late = store.markFired({ id: r.item.id, nowMs: lateNow });
  ok(late.ok && late.nextDueAt === d0 + 2 * DAY, `跨天补触发只顺延一次到第三天 08:01（实际 ${new Date(late.nextDueAt).toString()}）`);
  const d2 = new Date(late.nextDueAt);
  ok(d2.getHours() === 8 && d2.getMinutes() === 1, '跨天后本地时刻仍然不变（本机本地时间，无夏令时漂移）');
  ok(d2.getDate() === new Date(d0).getDate() + 2, '日期正好推进 2 天（没有补发第二天那条）');
  ok(store.due(lateNow).length === 0, '跨天 markFired 后 due() 不再返回它');
}

console.log('## repeat:weekly 顺延');
{
  const { store } = makeStore('weekly');
  const w0 = base + 2 * DAY + 30 * 60 * 1000;
  const r = store.add({ key: 'private:7', text: '交周报', dueAt: w0, repeat: 'weekly' });
  const fired = store.markFired({ id: r.item.id, nowMs: w0 });
  ok(fired.ok && fired.nextDueAt === w0 + 7 * DAY, 'weekly 顺延 +7d');
  const d = new Date(fired.nextDueAt);
  ok(d.getDay() === new Date(w0).getDay() && d.getHours() === new Date(w0).getHours(), '顺延后本地「周几 + 时刻」不变');
  const late = store.markFired({ id: r.item.id, nowMs: w0 + 8 * DAY });
  ok(late.nextDueAt === w0 + 14 * DAY, '迟到 8 天后仍然只顺延到下一个未来周（不补发）');
}

console.log('## 重复触发不会二次返回');
{
  const { store } = makeStore('idempotent');
  const one = store.add({ key: 'group:500', text: '一次性', dueAt: base + 1000 });
  ok(store.due(base + 1000).length === 1, '第一次 due() 返回它');
  const first = store.markFired({ id: one.item.id, nowMs: base + 1000 });
  ok(first.ok && first.done === true && first.changed === true, 'markFired 把一次性提醒标记为完成');
  ok(first.item.firedAt === base + 1000, 'firedAt 记录触发时间');
  ok(store.due(base + 1000).length === 0, 'markFired 后 due() 不再返回它');
  ok(store.due(base + 10 * DAY).length === 0, '很久以后再 due() 也不会复活');
  const second = store.markFired({ id: one.item.id, nowMs: base + 2000 });
  ok(second.ok && second.alreadyFired === true && second.changed === false, '对已完成项再 markFired → alreadyFired/changed:false');
  ok(store.list().length === 0, '默认 list 不显示已完成项');
  const withDone = store.list({ includeDone: true });
  ok(withDone.length === 1 && withDone[0].done === true, 'includeDone:true 能看到已完成项且 done=true');
  ok(store.stats().total === 1 && store.stats().pending === 0, 'stats 把已完成项算进 total、不算进 pending');
  ok(store.markFired({ id: 'r-not-exist', nowMs: base }).ok === false, 'markFired 未知 id → ok:false');
  ok(store.cancel({ key: 'group:500', id: one.item.id }) === 0, '已完成项不可再取消（返回 0）');
}

console.log('## prune 清理已完成项');
{
  const { store } = makeStore('prune');
  const done1 = store.add({ key: 'group:600', text: '已完成甲', dueAt: base + 1000 });
  const done2 = store.add({ key: 'group:600', text: '已完成乙', dueAt: base + 2000 });
  const stay = store.add({ key: 'group:600', text: '还早', dueAt: base + DAY, repeat: 'daily' });
  store.markFired({ id: done1.item.id, nowMs: base + 1000 });
  store.markFired({ id: done2.item.id, nowMs: base + 2000 });
  ok(store.prune({ nowMs: base + 3000 }) === 2, 'prune 清掉 2 条已完成项');
  ok(store.list({ includeDone: true }).length === 1, '待触发的重复项没被误删');
  ok(store.list({ includeDone: true })[0].id === stay.item.id, '留下的是那条 daily');
  ok(store.prune({ nowMs: base + 3000 }) === 0, '没有可清理的 → 返回 0');

  // doneKeepMs 覆盖：留痕 7 天
  const keep = makeStore('prune-keep', { limits: { doneKeepMs: 7 * DAY } });
  const k1 = keep.store.add({ key: 'group:601', text: '留痕', dueAt: base + 1000 });
  keep.store.markFired({ id: k1.item.id, nowMs: base + 1000 });
  ok(keep.store.prune({ nowMs: base + 1000 + DAY }) === 0, 'doneKeepMs=7d 时当天不清理');
  ok(keep.store.prune({ nowMs: base + 1000 + 8 * DAY }) === 1, '超过保留期后才清理');
}

console.log('## 校验：key / 文本 / 时间 / repeat');
{
  const { store } = makeStore('validate');
  const good = (dueAt = base + HOUR) => ({ key: 'group:700', text: '合法', dueAt });
  const bad = (patch) => store.add({ ...good(), ...patch });

  ok(isValidSessionKey('group:123') && isValidSessionKey('private:456'), 'isValidSessionKey 接受合法 key');
  ok(!isValidSessionKey('group:abc') && !isValidSessionKey('GROUP:1') && !isValidSessionKey(''), 'isValidSessionKey 拒绝非法 key');
  ok(SESSION_KEY_RE.source === '^(group|private):\\d+$', 'key 正则与约定一致');

  for (const key of ['foo:1', 'group:abc', 'group:', 'group:12x', 'GROUP:1', '', 'group:1:2', 'group:-1']) {
    const r = bad({ key });
    ok(r.ok === false && /key 不合法/.test(r.error ?? ''), `非法 key 被拒且报中文错：${JSON.stringify(key)}（${r.error}）`);
  }
  ok(store.list({ includeDone: true }).length === 0, '非法 key 一条都没落库');
  const padded = store.add({ text: '首尾带空格的 key', key: '  group:700  ', dueAt: base + 2 * HOUR });
  ok(padded.ok === true && padded.item.key === 'group:700', 'key 首尾空白被 trim 后落库（不是直接拒绝）');

  for (const text of ['', '   ', '\n\t ', null, undefined]) {
    const r = bad({ text });
    ok(r.ok === false && /1~200 字/.test(r.error ?? ''), `空/纯空白文本被拒：${JSON.stringify(text)}（${r.error}）`);
  }
  ok(bad({ text: 'a'.repeat(200) }).ok === true, '正好 200 字可以通过');
  const tooLong = bad({ text: 'a'.repeat(201) });
  ok(tooLong.ok === false && /当前 201 字/.test(tooLong.error ?? ''), `201 字被拒且报出实际字数（${tooLong.error}）`);
  ok(bad({ text: '😀'.repeat(200) }).ok === true, '200 个 emoji 按码点计数算 200 字（不被 UTF-16 双字节坑到）');

  const tooSoon = bad({ dueAt: base });
  ok(tooSoon.ok === false && /太近/.test(tooSoon.error ?? ''), `过去/此刻的时间被拒（${tooSoon.error}）`);
  ok(bad({ dueAt: base + 999 }).ok === false, '不足 1 秒（999ms）被拒');
  ok(bad({ dueAt: base + 1000 }).ok === true, '正好 1 秒后可以通过');
  ok(bad({ dueAt: base + 90 * DAY }).ok === true, '正好 90 天可以通过');
  const tooFar = bad({ dueAt: base + 90 * DAY + 1 });
  ok(tooFar.ok === false && /太远/.test(tooFar.error ?? ''), `超过 90 天被拒（${tooFar.error}）`);
  for (const dueAt of ['123', 'NaN', NaN, Infinity, null, undefined, {}, []]) {
    const r = bad({ dueAt });
    ok(r.ok === false && /dueAt/.test(r.error ?? ''), `非数字 dueAt 被拒：${JSON.stringify(dueAt)}（${r.error}）`);
  }

  const badRepeat = bad({ repeat: 'hourly' });
  ok(badRepeat.ok === false && /repeat 只能是/.test(badRepeat.error ?? ''), `非法 repeat 被拒（${badRepeat.error}）`);
  ok(bad({ repeat: 'weekly' }).ok === true, 'weekly 合法');
  const emptyRepeat = bad({ repeat: '' });
  ok(emptyRepeat.ok === true && emptyRepeat.item.repeat === 'none', 'repeat 传空串按 none 处理');
}

console.log('## 上限：每会话 50 / 全局 2000（可被 limits 覆盖）');
{
  const { store } = makeStore('limits-small', { limits: { maxPerKey: 3, maxTotal: 5 } });
  const add = (key, i) => store.add({ key, text: `第${i}条`, dueAt: base + (i + 1) * 1000 });
  ok(add('group:800', 1).ok && add('group:800', 2).ok && add('group:800', 3).ok, '每会话前 3 条可以加');
  const over = add('group:800', 4);
  ok(over.ok === false && /上限 3 条/.test(over.error ?? ''), `第 4 条被每会话上限拒绝（${over.error}）`);
  ok(add('group:801', 1).ok, '换一个会话还能加（说明是「每会话」不是「全局」）');
  ok(add('group:802', 1).ok, '全局还没到 5 条时仍可加');
  const overTotal = add('group:803', 1);
  ok(overTotal.ok === false && /总数已达上限 5 条/.test(overTotal.error ?? ''), `到全局上限后被拒（${overTotal.error}）`);
  ok(store.stats().total === 5 && store.stats().pending === 5, '被拒的没有进库');
  ok(store.cancelAll({ key: 'group:800' }) === 3, '取消该会话 3 条后腾出配额');
  ok(add('group:804', 1).ok, '腾出配额后又能加了');

  const def = makeStore('limits-default');
  ok(def.store.limits.maxPerKey === 50 && def.store.limits.maxTotal === 2000, '默认上限是每会话 50 / 全局 2000');
  ok(REMINDER_LIMITS.maxTextChars === 200 && REMINDER_LIMITS.minLeadMs === 1000, '默认上限常量：文本 200 字、最短 1 秒');
  ok(/^(group|private):\d+$/.test('private:10001'), '（对照）private:10001 是合法形状');
}

console.log('## 损坏 JSON 降级路径');
{
  const file = path.join(dir, 'corrupt.json');
  fs.writeFileSync(file, '{ "version": 1, "items": [ 这不是 JSON ');
  const store = createRemindersStore({ file, now: () => base });
  ok(store.warnings.length === 1, `解析失败留下 1 条警告（实际 ${store.warnings.length}：${store.warnings.join(' | ')}）`);
  ok(/损坏/.test(store.warnings[0] ?? '') && /重建空库/.test(store.warnings[0] ?? ''), `警告文案说明已降级重建（${store.warnings[0]}）`);
  ok(store.list().length === 0 && store.stats().total === 0, '坏文件不静默清空内容而是当空库用');
  const backup = store.corruptBackup;
  ok(typeof backup === 'string' && fs.existsSync(backup), `坏文件被备份下来了（${backup ? path.basename(backup) : 'null'}）`);
  ok(/^corrupt\.json\.corrupt-\d+$/.test(path.basename(backup ?? '')), '备份名形如 reminders.json.corrupt-<ts>');
  ok(fs.readFileSync(backup, 'utf8').includes('这不是 JSON'), '备份内容就是那份坏文件（没被改写）');
  const r = store.add({ key: 'group:900', text: '降级后还能加', dueAt: base + HOUR });
  ok(r.ok === true, '降级后可以正常新增');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(onDisk.version === 1 && onDisk.items.length === 1, '重建后的文件是合法 JSON（version 1 + 1 条）');
  ok(fs.readdirSync(dir).filter((f) => f.includes('.part-')).length === 0, '备份/重建过程没留下 .part- 残渣');

  // 合法 JSON 但结构不对
  const file2 = path.join(dir, 'shape.json');
  fs.writeFileSync(file2, JSON.stringify({ hello: 'world' }));
  const store2 = createRemindersStore({ file: file2, now: () => base });
  ok(store2.warnings.some((w) => /顶层结构/.test(w)), `结构不对也降级并告警（${store2.warnings[0]}）`);
  ok(store2.list().length === 0, '结构不对时按空库用');

  // 合法 JSON、结构对，但个别记录字段缺失 → 只丢坏的那条
  const file3 = path.join(dir, 'partial.json');
  fs.writeFileSync(file3, JSON.stringify({
    version: 1,
    items: [
      { id: 'rgood', key: 'group:1', text: '好的', dueAt: base + HOUR, createdAt: base, repeat: 'none', firedAt: null, lastFiredAt: null },
      { id: 'rbad1', key: 'group:1', text: '缺 dueAt' },
      { id: 'rbad2', key: 'wrong:key', text: 'key 不合法', dueAt: base + HOUR },
      { key: 'group:1', text: '缺 id', dueAt: base + HOUR }
    ]
  }));
  const store3 = createRemindersStore({ file: file3, now: () => base });
  ok(store3.list().length === 1 && store3.list()[0].id === 'rgood', '只保留字段完整的记录');
  ok(store3.warnings.some((w) => /丢弃了 3 条/.test(w)), `丢弃条数写进警告（${store3.warnings[0]}）`);
  ok(store3.add({ key: 'group:1', text: '新加的', dueAt: base + 2 * HOUR }).ok === true, '清洗后仍可继续写盘');
  ok(JSON.parse(fs.readFileSync(file3, 'utf8')).items.length === 2, '写盘后文件里只剩清洗过的 + 新增的');
}

console.log('## 重新加载（进程重启语义）');
{
  const file = path.join(dir, 'reload.json');
  const a = createRemindersStore({ file, now: () => base });
  const r = a.add({ key: 'group:999', text: '重启也不丢', dueAt: base + HOUR, repeat: 'daily' });
  const b = createRemindersStore({ file, now: () => base });
  ok(b.list().length === 1, '新 store 能读到上一次落盘的数据（重启不丢）');
  ok(b.list()[0].id === r.item.id && b.list()[0].text === '重启也不丢', '读回来的 id/文本一致');
  ok(b.due(base + HOUR).length === 1, '重启后到期判断照常');
  b.reload();
  ok(b.list().length === 1, 'reload() 后数据仍在');
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过，${fail} 失败`);
console.log(`临时目录：${dir}`);
if (fail) {
  console.error('用例有失败，保留临时目录便于排查。');
  process.exitCode = 1;
} else {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
}
