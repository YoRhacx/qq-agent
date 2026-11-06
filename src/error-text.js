// 把任何「错误值」变成一行人能读懂的文本。
//
// 为什么要有这个文件：以前各处统一写 `${error?.message ?? error}`。当 error 是
// **普通对象**（provider 返回的 { code, message }、桥接回包里的 error 字段、undici 的
// { message, cause } …）时，模板字符串会把它变成 "[object Object]" —— 模型看到的就是
// `Error: [object Object]`，等于没告诉它发生了什么，它只能瞎猜或直接放弃这一轮。
// 2026-10-23 实测：qq_wait_for_messages 抛出的正是这种错误，模型当场把回合搞挂。
//
// 约定：调用方只关心「一句话」，长文本会被截断；结构化细节尽量按 key=value 摊平，
// 让模型和人都能一眼看出是鉴权、限流还是网络。
function pickText(value, depth = 0) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message || value.name || 'Error';
  if (typeof value !== 'object') return String(value);
  if (depth >= 3) return '';
  // 顺序有讲究：先取「像原因」的字段，最后才回落 code/status（它们单独出现时说明不了问题）。
  const order = ['message', 'error', 'error_description', 'msg', 'wording', 'detail', 'reason', 'cause'];
  const tail = ['code', 'status', 'statusCode', 'retcode'];
  const parts = [];
  for (const key of order) {
    if (!(key in value)) continue;
    const text = pickText(value[key], depth + 1);
    if (!text) continue;
    parts.push(key === 'message' ? text : `${key}=${text}`);
  }
  for (const key of tail) {
    if (!(key in value)) continue;
    const text = pickText(value[key], depth + 1);
    if (text) parts.push(`${key}=${text}`);
  }
  if (parts.length) return parts.join('；');
  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? json : '';
  } catch {
    return '';
  }
}

/**
 * @param {unknown} error 任意错误值
 * @param {{ maxLength?: number }} [options]
 * @returns {string} 非空的单行说明
 */
export function errorText(error, { maxLength = 800 } = {}) {
  let text = pickText(error);
  if (!text) text = '未知错误（对方没有给出原因）';
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) text = text.slice(0, maxLength) + '…';
  return text;
}
