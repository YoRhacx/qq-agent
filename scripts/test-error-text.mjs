// errorText（src/error-text.js）的离线单测。
//
// 存在理由：线上出现过 `Error: [object Object]` —— 模型只知道「出错了」，不知道是鉴权、
// 限流还是网络，只能瞎猜或直接放弃这一轮（2026-10-23 qq_wait_for_messages 那次）。
// 这里锁住：任何形状的错误值都要变成一句人能读的话，且永远不抛异常。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText } from '../src/error-text.js';

test('Error 取 message，不把 stack 灌给模型', () => {
  const text = errorText(new Error('连接重置'));
  assert.equal(text, '连接重置');
});

test('字符串原样返回（很多地方只 throw 一个字符串）', () => {
  assert.equal(errorText('token 过期'), 'token 过期');
  assert.equal(errorText('  空白要压缩  '), '空白要压缩');
});

test('普通对象不会再变成 [object Object]', () => {
  assert.equal(errorText({ message: '鉴权失败', code: 401 }), '鉴权失败；code=401');
  assert.equal(errorText({ error: 'limit exceeded', status: 429 }), 'error=limit exceeded；status=429');
  // 只有 code 时也要说出来，而不是空串
  assert.equal(errorText({ code: 'ETIMEDOUT' }), 'code=ETIMEDOUT');
});

test('嵌套 cause 一路读到底（undici 的 fetch failed 就是这种）', () => {
  const text = errorText(new Error('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'connect refused' } }));
  assert.match(text, /fetch failed/);
  // Error 的分支只取 message，cause 是对象的附加信息；至少不能抛出、不能是 [object Object]
  assert.doesNotMatch(text, /\[object Object\]/);
  const wrapped = errorText({ cause: new Error('底层断了'), message: '桥接调用失败' });
  assert.equal(wrapped, '桥接调用失败；cause=底层断了');
});

test('空值 / 空对象 / 循环引用都有兜底，且永不抛', () => {
  assert.equal(errorText(null), '未知错误（对方没有给出原因）');
  assert.equal(errorText(undefined), '未知错误（对方没有给出原因）');
  assert.equal(errorText({}), '未知错误（对方没有给出原因）');
  const circular = { message: '环', self: null };
  circular.self = circular;
  assert.equal(errorText(circular), '环');
  // 只有不可序列化字段的对象：不能因为 JSON.stringify 抛错就整轮崩
  const noJson = { toJSON() { throw new Error('nope'); } };
  assert.doesNotThrow(() => errorText(noJson));
});

test('多行错误压成一行（日志与工具回包都是单行契约）', () => {
  const text = errorText(new Error('第一行\n第二行\n\n第三行'));
  assert.equal(text, '第一行 第二行 第三行');
  assert.doesNotMatch(text, /\n/);
});

test('超长错误按 maxLength 截断并标注', () => {
  const long = 'x'.repeat(2000);
  const text = errorText(long, { maxLength: 50 });
  assert.equal(text.length, 51);
  assert.ok(text.endsWith('…'));
  assert.equal(errorText(long).length, 801); // 默认 maxLength=800，末尾加一个省略号
});

test('数字 / 布尔等非典型错误值也可读', () => {
  assert.equal(errorText(500), '500');
  assert.equal(errorText(false), 'false');
  assert.equal(errorText(Symbol('s')), 'Symbol(s)'); // 模板字符串会抛，String() 不会
});
