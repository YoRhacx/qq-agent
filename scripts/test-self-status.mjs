// 自检：src/self-status.mjs（纯函数，不碰网络/磁盘/桥接）
import { buildSelfStatus, humanDelta, SELF_STATUS_MAX_CHARS } from '../src/self-status.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${extra ? ` :: ${extra}` : ''}`);
}
const has = (text, bit) => String(text).includes(bit);

const now = Date.now();

// 1) 空输入不炸，且给出兜底建议
{
  const r = buildSelfStatus({});
  ok('空输入 ok', r.ok === true);
  ok('空输入建议兜底', has(r.text, '一切正常'), r.text);
  ok('空输入不截断', r.truncated === false);
  ok('空输入无告警', Array.isArray(r.warnings) && r.warnings.length === 0, JSON.stringify(r.warnings));
}

// 2) 完整输入：各段都出现
{
  const r = buildSelfStatus({
    key: 'group:2000000001', mode: 'reserved2', role: '小鲸鱼', dshReady: true, paused: false,
    sessionId: 'f19e8408-aad0-45e4-ad90-3d4cbf8dcb58', provider: 'qodercn', model: 'kmodel_latest', reasoningEffort: 'medium',
    snowluma: { connected: true, accountOnline: true, good: true, degraded: false, lastPacketAgoMs: 17007 },
    wake: { usedMinute: 1, capMinute: 12, usedHour: 3, capHour: 60, config: { mode: 'diving', infinite: false, sleepUntil: new Date(now + 3600000).toISOString() } },
    voiceLimits: { usedMinute: 0, capMinute: 2, usedHour: 0, capHour: 10 },
    imageLimits: { usedMinute: 0, capMinute: 2, usedHour: 1, capHour: 10 },
    waiting: false, busy: false, pendingWakeReasons: 0,
    tts: { voice: 'local:hoyo:48', provider: 'local' },
    reminders: { pending: 2, nextDueAt: now + 4800000 },
    cost: { symbol: '¥', todayCost: 1.23, turns: 12, steps: 88, cacheHitTokens: 8400000, cacheMissTokens: 1200000, outputTokens: 45000, estimated: true },
    now
  });
  for (const bit of ['【运行】', '【SnowLuma】', '【本会话】', '【花费】', '【额度与等待】', '【其它】', '【建议】',
    '模式 reserved2', '角色 小鲸鱼', 'DSH 就绪', '模型 qodercn/kmodel_latest（medium）',
    '账号在线', '上次心跳 17 秒前', '今天 ¥1.23（估）', '12 轮 / 88 步', '缓存命中 88%',
    '唤醒/分 1/12（剩 11）', '语音/时 0/10（剩 10）', '图片/时 1/10（剩 9）',
    '默认音色 local:hoyo:48（local）', '待触发提醒 2 条']) {
    ok(`完整输入含「${bit}」`, has(r.text, bit), r.text.slice(0, 200));
  }
  ok('完整输入 data.cacheHitRate=88', r.data.cacheHitRate === 88, String(r.data.cacheHitRate));
  ok('完整输入不截断', r.truncated === false, `len=${r.text.length}`);
}

// 3) provider 不缓存友好 → 告警 + 建议里点名
{
  const r = buildSelfStatus({ provider: 'trae', model: 'some-model', cost: { turns: 1 } });
  ok('provider 告警', r.warnings.includes('provider-not-cache-friendly'), JSON.stringify(r.warnings));
  ok('provider 建议文案', has(r.text, 'qodercn/deepseek'), r.text);
}

// 4) 缓存命中低（且轮数足够）→ low-cache-hit
{
  const r = buildSelfStatus({ provider: 'qodercn', model: 'm', cost: { turns: 5, cacheHitTokens: 250000, cacheMissTokens: 750000 } });
  ok('低命中告警', r.warnings.includes('low-cache-hit'), JSON.stringify(r.warnings));
  ok('低命中率=25', r.data.cacheHitRate === 25, String(r.data.cacheHitRate));
  // 轮数不足时不告警（避免刚开会话就唠叨）
  const r2 = buildSelfStatus({ provider: 'qodercn', model: 'm', cost: { turns: 1, cacheHitTokens: 0, cacheMissTokens: 100000 } });
  ok('轮数不足不告警', !r2.warnings.includes('low-cache-hit'), JSON.stringify(r2.warnings));
}

// 5) 花费与额度告警
{
  const r = buildSelfStatus({ provider: 'qodercn', model: 'm', cost: { todayCost: 4.5, turns: 1 }, wake: { usedMinute: 9, capMinute: 10 } });
  ok('花费告警', r.warnings.includes('cost-warn'), JSON.stringify(r.warnings));
  ok('额度告警', r.warnings.includes('wake-quota-low'), JSON.stringify(r.warnings));
  ok('花费文案', has(r.text, '今天已经花了'));
}
{
  const r = buildSelfStatus({ paused: true, dshReady: false });
  ok('未就绪告警', r.warnings.includes('bridge-not-ready'), JSON.stringify(r.warnings));
  ok('暂停文案', has(r.text, '⚠ 已暂停'), r.text);
}

// 6) 上限为 0 / 缺字段 → 不显示该段
{
  const r = buildSelfStatus({ wake: { usedMinute: 3, capMinute: 0, capHour: 0 } });
  ok('不限流不显示', !has(r.text, '唤醒/分') && !has(r.text, '唤醒/时'), r.text);
  const r2 = buildSelfStatus({ wake: { capHour: 10 } });
  ok('缺 used 视为 0', has(r2.text, '唤醒/时 0/10（剩 10）'), r2.text);
}

// 7) 硬上限：超长输入被截断
{
  const r = buildSelfStatus({ role: '角'.repeat(2000), mode: 'm'.repeat(50), cost: { todayCost: 9.9, turns: 99 } });
  ok('超长被截断', r.truncated === true);
  ok('截断后长度受限', r.text.length <= SELF_STATUS_MAX_CHARS, `len=${r.text.length}`);
}

// 8) humanDelta
{
  ok('humanDelta 过去', humanDelta(-3 * 60000) === '3 分钟前', humanDelta(-3 * 60000));
  ok('humanDelta 未来', humanDelta(2 * 3600000) === '2 小时后', humanDelta(2 * 3600000));
  ok('humanDelta 刚刚', humanDelta(-500) === '刚刚', humanDelta(-500));
  ok('humanDelta 非法', humanDelta(NaN) === '', humanDelta(NaN));
}

console.log(fails.length ? `FAIL:\n - ${fails.join('\n - ')}` : '');
console.log(`结果：${pass} 通过，${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
