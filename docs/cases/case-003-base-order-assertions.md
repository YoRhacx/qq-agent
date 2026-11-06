# case-003 一条 base 拼接，三个测试轮流红

- **日期**：2026-10-28（一路到 10-28 晚）
- **影响**：每次往唤醒提示词里插一行，就有 2–3 个**不相关**的测试变红；改测试的时间比改功能多。
- **关联**：[PITFALLS P-003](../../PITFALLS.md)

## 现场

唤醒提示词是一条拼接表达式：

```js
const base = roleLine + tokenLine + … + memoryLine + memoryCardLine + closureLine + participationLine + preSleepLine;
```

测试里写的是相邻断言：

```js
assert.match(source, /memoryLine \+ memoryCardLine \+ closureLine/);
```

于是：

1. 插入 `purposeLine` → `test-conversation-closure` 红；
2. 改成 `(purposeLine \+ )?` → 插入 `budgetLine` 又红；
3. `test-purpose-engine` 同样写死 `memoryCardLine + purposeLine + closureLine` → 一起红。

## 根因

断言写的是**实现细节（相邻）**，而需求只是**语义（都在、顺序对）**。
拼接表达式天然会增长，相邻关系不是契约。

## 修复

三处统一成"同一条语句内、按序出现"：

```js
assert.match(source, /const base = [^;]*memoryCardLine[^;]*closureLine[^;]*;/);
```

## 教训

1. 断言要贴着**契约**写，不要贴着当前代码的排版写。
2. 顺序类需求优先 `indexOf(a) < indexOf(b)`，或"同一语句内按序"。
3. 一次改动让**多个不相关测试**变红，通常不是功能坏了，是断言太紧。

## 遗留

- 若将来 base 被拆成多行数组拼接，这几条断言需要再放宽（改成检查数组元素顺序）。
