// 每日额度（src/token-budget.js）的离线回归 + 接线断言。
// 保证：双单位各自独立比较、80% 提醒 / 100% 停、跨天重置、提示词只在到线时才说话。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  buildBudgetLine,
  dayKeyOf,
  DEFAULT_BUDGET_CONFIG,
  describeBudget,
  evaluateBudget,
  localDayStart,
  normalizeBudgetConfig,
  parseCnyText,
  parseTokenText,
  shouldAlert,
  sumSeriesSince
} from '../src/token-budget.js';

const BRIDGE = new URL('../src/bridge.js', import.meta.url);

test('金额输入：¥8 / 8.5元 都认，空串=不限，乱写=undefined', () => {
  assert.equal(parseCnyText('¥8'), 8);
  assert.equal(parseCnyText('8.5元'), 8.5);
  assert.equal(parseCnyText(' 1,000 CNY '), 1000);
  assert.equal(parseCnyText(''), null);
  assert.equal(parseCnyText('随便'), undefined);
});

test('token 输入：8M / 2万 / 1.5亿 都认，空串=不限', () => {
  assert.equal(parseTokenText('8M'), 8000000);
  assert.equal(parseTokenText('2万'), 20000);
  assert.equal(parseTokenText('1.5亿'), 150000000);
  assert.equal(parseTokenText('8000000'), 8000000);
  assert.equal(parseTokenText(''), null);
  assert.equal(parseTokenText('x'), undefined);
});

test('配置归一化：裸数字按元解释，阈值越界收敛，默认值兜底', () => {
  assert.equal(normalizeBudgetConfig(10).dailyCny, 10);
  assert.equal(normalizeBudgetConfig('¥12').dailyCny, 12);
  const cfg = normalizeBudgetConfig({ dailyCny: 0, dailyTokens: '5M', warnRatio: 2, stopRatio: 0.1, promptMaxChars: 5 });
  assert.equal(cfg.dailyCny, null);
  assert.equal(cfg.dailyTokens, 5000000);
  assert.equal(cfg.warnRatio, 0.99);
  assert.equal(cfg.stopRatio, 0.5);
  assert.equal(cfg.promptMaxChars, 80);
  assert.equal(normalizeBudgetConfig(null).dailyCny, DEFAULT_BUDGET_CONFIG.dailyCny);
});

test('两个单位都不设 = 关闭，判定 off 且不拦', () => {
  const cfg = normalizeBudgetConfig({ dailyCny: null, dailyTokens: null });
  const r = evaluateBudget({ cost: 100, tokens: 1e9 }, cfg);
  assert.equal(r.level, 'off');
  assert.equal(r.blocked, false);
  assert.equal(buildBudgetLine(r, cfg), '');
});

test('未到线是 ok；80% 提醒但不拦；100% 才拦', () => {
  const cfg = normalizeBudgetConfig({ dailyCny: 8 });
  assert.equal(evaluateBudget({ cost: 0.4 }, cfg).level, 'ok');
  const warn = evaluateBudget({ cost: 6.4 }, cfg);
  assert.equal(warn.level, 'warn');
  assert.equal(warn.blocked, false);
  assert.match(buildBudgetLine(warn, cfg), /额度快到了/);
  assert.doesNotMatch(buildBudgetLine(warn, cfg), /非必要不要再开口/);
  const stop = evaluateBudget({ cost: 8 }, cfg);
  assert.equal(stop.level, 'stop');
  assert.equal(stop.blocked, true);
  assert.match(buildBudgetLine(stop, cfg), /额度用完了/);
  assert.match(buildBudgetLine(stop, cfg), /非必要不要再开口/);
});

test('两个单位各自独立比较：谁先到线谁说话（token 紧就用 token）', () => {
  const cfg = normalizeBudgetConfig({ dailyCny: 100, dailyTokens: 1000 });
  const r = evaluateBudget({ cost: 1, tokens: 1300 }, cfg);
  assert.equal(r.level, 'stop');
  assert.equal(r.hits[0].unit, 'tokens');
  assert.equal(r.hits[0].percent, 130);
  assert.match(describeBudget(r), /token/);
});

test('提示词：inject=false 时即使超了也不注入', () => {
  const cfg = normalizeBudgetConfig({ dailyCny: 1, inject: false });
  const r = evaluateBudget({ cost: 9 }, cfg);
  assert.equal(r.level, 'stop');
  assert.equal(buildBudgetLine(r, cfg), '');
});

test('80% 提醒每天只提一次，跨天自动重置', () => {
  const cfg = normalizeBudgetConfig({ dailyCny: 8 });
  const warn = evaluateBudget({ cost: 7 }, cfg);
  const now = new Date('2026-10-28T22:00:00+08:00').getTime();
  assert.equal(shouldAlert(warn, '', now), true);
  assert.equal(shouldAlert(warn, '2026-10-28', now), false);
  assert.equal(shouldAlert(warn, '2026-10-27', now), true);
  const ok = evaluateBudget({ cost: 1 }, cfg);
  assert.equal(shouldAlert(ok, '', now), false);
});

test('「今天」按本地自然日切：零点前的桶不算进今天', () => {
  const noon = new Date('2026-10-28T12:00:00+08:00').getTime();
  const start = localDayStart(noon);
  const buckets = [
    { t: start - 3600000, cost: 5, tokens: 5000 },
    { t: start, cost: 1, tokens: 1000 },
    { t: start + 3600000, cost: 2, tokens: 2000 }
  ];
  assert.deepEqual(sumSeriesSince(buckets, start), { cost: 3, tokens: 3000 });
  assert.equal(dayKeyOf(noon), '2026-10-28');
  assert.equal(dayKeyOf(start - 1000), '2026-10-27');
});

test('接线：桥接确实按 config.tokenBudget 建额度、拼进提示词、拦住主动机会', () => {
  const source = fs.readFileSync(BRIDGE, 'utf8');
  assert.match(source, /import \{[^}]*buildBudgetLine[^}]*\} from '\.\/token-budget\.js'/, '要 import 额度模块');
  assert.match(source, /budgetConfig = normalizeBudgetConfig\(cfg\.tokenBudget \?\? \{\}\)/, '要从 config.tokenBudget 读配置');
  assert.match(source, /purposeLine \+ budgetLine \+ closureLine/, '额度行要拼在 purposeLine 之后、closureLine 之前');
  assert.match(source, /budgetConfig\.gateProactive/, '主动机会检查要走 gateProactive 闸门');
  assert.match(source, /url\.pathname === '\/api\/budget'/, '要有只读端点 /api/budget');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(example.tokenBudget.dailyCny, 8);
  assert.equal(example.tokenBudget.gateProactive, true);
});
