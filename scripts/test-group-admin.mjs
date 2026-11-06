// 自检：src/group-admin.js（纯函数：动作构造 + 策略门 + 风险提示）
import {
  buildGroupAdminAction, requiresOwnerApproval, riskHint,
  GROUP_ADMIN_ACTIONS, GROUP_ADMIN_RISK, MAX_BAN_SECONDS, GROUP_REQUEST_SUBTYPES
} from '../src/group-admin.js';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => { if (cond) pass++; else fails.push(`${name}${extra ? ` :: ${extra}` : ''}`); };
const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1) 白名单与风险表一致性
{
  ok('动作表非空', Object.keys(GROUP_ADMIN_ACTIONS).length >= 6);
  ok('每个动作都有风险等级', Object.keys(GROUP_ADMIN_ACTIONS).every((k) => GROUP_ADMIN_RISK[k]));
  ok('kick 是 high', GROUP_ADMIN_RISK.kick === 'high');
  ok('requiresOwnerApproval(kick)', requiresOwnerApproval('kick') === true);
  ok('requiresOwnerApproval(ban)', requiresOwnerApproval('ban') === false);
  ok('riskHint 三档都有', /高危/.test(riskHint('kick')) && /中等/.test(riskHint('ban')) && /低危/.test(riskHint('unban')));
}

// 2) 高危动作默认被策略门拦住
{
  const r = buildGroupAdminAction({ op: 'kick', groupId: '2000000001', userId: '10001' });
  ok('kick 默认被拒', r.ok === false && r.needApproval === true, JSON.stringify(r));
  ok('kick 拒绝文案提到管理员', /管理员/.test(r.error ?? ''), r.error);
  const okr = buildGroupAdminAction({ op: 'kick', groupId: '2000000001', userId: '10001', allowDangerous: true, rejectAddRequest: true });
  ok('kick 放行后 ok', okr.ok === true, JSON.stringify(okr));
  ok('kick action 名', okr.action === 'set_group_kick');
  ok('kick 参数', deep(okr.params, { group_id: 2000000001, user_id: 10001, reject_add_request: true }), JSON.stringify(okr.params));
  ok('kick summary', /移出群/.test(okr.summary), okr.summary);
  ok('audit 含 action', okr.audit.includes('set_group_kick'));
}

// 3) 禁言/解禁
{
  const r = buildGroupAdminAction({ op: 'ban', groupId: '2000000001', userId: '10001', durationSec: 600 });
  ok('ban ok', r.ok === true && r.action === 'set_group_ban', JSON.stringify(r));
  ok('ban 参数', deep(r.params, { group_id: 2000000001, user_id: 10001, duration: 600 }), JSON.stringify(r.params));
  ok('ban 人话', r.summary.includes('禁言 10 分钟'), r.summary);
  const u = buildGroupAdminAction({ op: 'unban', groupId: '2000000001', userId: '10001' });
  ok('unban duration=0', u.ok === true && u.params.duration === 0, JSON.stringify(u.params));
  ok('unban 人话', u.summary.includes('解除禁言'), u.summary);
}
{
  const bad = [
    [{ op: 'ban', groupId: '2000000001', userId: '10001', durationSec: 0 }, 'ban durationSec=0'],
    [{ op: 'ban', groupId: '2000000001', userId: '10001', durationSec: -5 }, 'ban 负数'],
    [{ op: 'ban', groupId: '2000000001', userId: '10001', durationSec: 1.5 }, 'ban 小数'],
    [{ op: 'ban', groupId: '2000000001', userId: '10001', durationSec: MAX_BAN_SECONDS + 1 }, 'ban 超 30 天'],
    [{ op: 'ban', groupId: '0', userId: '10001', durationSec: 60 }, 'groupId 为 0'],
    [{ op: 'ban', groupId: '2000000001', userId: '-1', durationSec: 60 }, 'userId 负数'],
    [{ op: 'ban', groupId: 'abc', userId: '10001', durationSec: 60 }, 'groupId 非数字'],
    [{ op: 'ban', groupId: '  ', userId: '10001', durationSec: 60 }, 'groupId 空白']
  ];
  for (const [input, name] of bad) {
    const r = buildGroupAdminAction(input);
    ok(`拒绝：${name}`, r.ok === false && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
  }
}

// 4) 撤消息
{
  const r = buildGroupAdminAction({ op: 'deleteMsg', messageId: '-123456' });
  ok('deleteMsg 负数 id 放行', r.ok === true && r.params.message_id === -123456, JSON.stringify(r));
  ok('deleteMsg action', r.action === 'delete_msg');
  ok('deleteMsg 拒绝 0', buildGroupAdminAction({ op: 'deleteMsg', messageId: 0 }).ok === false);
  ok('deleteMsg 拒绝缺参', buildGroupAdminAction({ op: 'deleteMsg' }).ok === false);
}

// 5) 好友申请 / 入群申请
{
  const r = buildGroupAdminAction({ op: 'approveFriend', flag: 'F'.repeat(10), approve: true, remark: '同学' });
  ok('approveFriend ok', r.ok === true && r.params.flag === 'F'.repeat(10), JSON.stringify(r));
  ok('approveFriend remark', r.params.remark === '同学', JSON.stringify(r.params));
  ok('approveFriend 无 remark 时不带键', !('remark' in buildGroupAdminAction({ op: 'approveFriend', flag: 'x', approve: false }).params));
  const g = buildGroupAdminAction({ op: 'approveGroup', flag: 'g1', subType: 'invite', approve: true, reason: '一起玩' });
  ok('approveGroup ok', g.ok === true && g.params.sub_type === 'invite', JSON.stringify(g));
  ok('approveGroup reason', g.params.reason === '一起玩');
  const g2 = buildGroupAdminAction({ op: 'approveGroup', flag: 'g1', subType: 'add', approve: false });
  ok('approveGroup 缺 reason 时不带键', g2.ok === true && !('reason' in g2.params), JSON.stringify(g2.params));
  ok('subType 白名单', GROUP_REQUEST_SUBTYPES.includes('add') && GROUP_REQUEST_SUBTYPES.includes('invite'));
}
{
  const bad = [
    [{ op: 'approveFriend', flag: '', approve: true }, 'flag 为空'],
    [{ op: 'approveFriend', flag: 'x' }, 'approve 缺失'],
    [{ op: 'approveFriend', flag: 'x', approve: 'yes' }, 'approve 非布尔'],
    [{ op: 'approveGroup', flag: 'x', subType: 'bogus', approve: true }, 'subType 非法']
  ];
  for (const [input, name] of bad) {
    ok(`拒绝：${name}`, buildGroupAdminAction(input).ok === false, JSON.stringify(buildGroupAdminAction(input)));
  }
}

// 6) 未支持/未实现动作
{
  const r = buildGroupAdminAction({ op: 'setCard', groupId: '1', userId: '2' });
  ok('不支持的 action 被拒（SnowLuma 没有 set_group_card）', r.ok === false && /不支持的群管理动作/.test(r.error), JSON.stringify(r));
  ok('空 op 被拒', buildGroupAdminAction({}).ok === false);
  ok('错误信息列可用动作', /kick/.test(buildGroupAdminAction({ op: 'nope' }).error ?? ''));
}

// 7) 截断保护
{
  const r = buildGroupAdminAction({ op: 'approveGroup', flag: 'f'.repeat(500), subType: 'add', approve: true, reason: 'r'.repeat(200) });
  ok('flag 截断到 200', r.ok === true && r.params.flag.length === 200, String(r.params.flag.length));
  ok('reason 截断到 60', r.params.reason.length === 60, String(r.params.reason.length));
}

console.log(fails.length ? `FAIL:\n - ${fails.join('\n - ')}` : '');
console.log(`结果：${pass} 通过，${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
