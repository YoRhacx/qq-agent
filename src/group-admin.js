// 群管理动作构造与策略门（纯函数，不碰网络/桥接）。
//
// 为什么单独一个模块：群管理是**唯一一类会真正影响别人的操作**（踢人、禁言、删消息、批入群申请），
// 出错的代价不是"这条没发出去"，而是"群里少个人/某人被静音了"。所以这里做三件事：
//   ① 把「高层动作」翻成 SnowLuma 实际支持的 OneBot action + 字段（照 D:\qq-bot\snowluma\index.mjs
//      的用法对齐，见 :237226-237257），把"参数写错"在本地就变成人话错误；
//   ② 给每个动作标风险等级，高危动作默认**必须**显式放行（`allowDangerous:true`，由 owner 审批后传入）；
//   ③ 产出稳定的 `summary` / `audit` 文本，便于活动流与事后追责（谁在什么时候把谁踢了）。
//
// 能力边界（实测 SnowLuma 命中数为 0 的 action 一律不做，别写进工具里假装支持）：
//   支持：`set_group_kick`、`set_group_ban`、`delete_msg`、`set_friend_add_request`、
//         `set_group_add_request`、`get_group_member_info`
//   不支持：`set_group_card`、`set_group_leave`、`set_group_name`、`set_group_whole_ban`、`get_group_info`

/** 支持的动作及其 OneBot action 名。 */
export const GROUP_ADMIN_ACTIONS = Object.freeze({
  kick: 'set_group_kick',
  ban: 'set_group_ban',
  unban: 'set_group_ban',
  deleteMsg: 'delete_msg',
  approveFriend: 'set_friend_add_request',
  approveGroup: 'set_group_add_request'
});

/** 风险等级：high 默认必须显式放行；medium 也建议走审批；low 可自动执行。 */
export const GROUP_ADMIN_RISK = Object.freeze({
  kick: 'high',
  ban: 'medium',
  unban: 'low',
  deleteMsg: 'low',
  approveFriend: 'low',
  approveGroup: 'low'
});

/** 禁言上限：30 天（OneBot 惯例，也是 QQ 侧上限）。 */
export const MAX_BAN_SECONDS = 2592000;

/** 群申请的子类型白名单（OneBot v11）。 */
export const GROUP_REQUEST_SUBTYPES = Object.freeze(['add', 'invite']);

const isDigits = (v, { allowNegative = false } = {}) => {
  const s = String(v ?? '').trim();
  if (!s) return false;
  return allowNegative ? /^-?[1-9]\d*$/.test(s) : /^[1-9]\d*$/.test(s);
};
const trim = (v) => String(v ?? '').trim();
const cut = (v, n) => trim(v).slice(0, n);

/** 该动作是否必须由 owner 显式放行（默认策略：high 必须，medium 建议）。 */
export function requiresOwnerApproval(op) {
  return GROUP_ADMIN_RISK[String(op ?? '').trim()] === 'high';
}

/**
 * 构造一个群管理动作。
 *
 * @param {object} input
 *   - `op`：`kick` | `ban` | `unban` | `deleteMsg` | `approveFriend` | `approveGroup`
 *   - `allowDangerous`：高危动作（kick）必须显式 true；否则返回 `{ok:false, error:'…需要管理员审批…'}`
 *   - kick: `{ op:'kick', groupId, userId, rejectAddRequest?:boolean }`
 *   - ban:  `{ op:'ban', groupId, userId, durationSec }`（0 < durationSec ≤ 2592000）
 *   - unban:`{ op:'unban', groupId, userId }` → duration 0
 *   - deleteMsg: `{ op:'deleteMsg', messageId }`
 *   - approveFriend: `{ op:'approveFriend', flag, approve:boolean, remark? }`
 *   - approveGroup:  `{ op:'approveGroup', flag, subType:'add'|'invite', approve:boolean, reason? }`
 * @returns {{ok:true, op:string, action:string, params:object, risk:string, summary:string, audit:string}
 *          | {ok:false, error:string, needApproval?:boolean}}
 */
export function buildGroupAdminAction(input = {}) {
  const op = trim(input.op);
  const action = GROUP_ADMIN_ACTIONS[op];
  const risk = GROUP_ADMIN_RISK[op] ?? 'unknown';
  if (!action) {
    return { ok: false, error: `不支持的群管理动作：${op || '(空)'}（可用：${Object.keys(GROUP_ADMIN_ACTIONS).join('、')}）` };
  }
  if (requiresOwnerApproval(op) && input.allowDangerous !== true) {
    return { ok: false, needApproval: true, error: `「${op}」是高危操作（会真的把人移出群），必须由管理员显式放行后才执行` };
  }

  const finish = (params, summary) => ({
    ok: true, op, action, params, risk, summary,
    audit: `${op} → ${action} ${JSON.stringify(params)}`
  });

  if (op === 'kick') {
    if (!isDigits(input.groupId)) return { ok: false, error: 'groupId 必须是正整数（群号）' };
    if (!isDigits(input.userId)) return { ok: false, error: 'userId 必须是正整数（QQ 号）' };
    const params = {
      group_id: Number(input.groupId),
      user_id: Number(input.userId),
      reject_add_request: input.rejectAddRequest === true
    };
    return finish(params, `把 ${params.user_id} 移出群 ${params.group_id}${params.reject_add_request ? '（并拒绝再申请）' : ''}`);
  }

  if (op === 'ban' || op === 'unban') {
    if (!isDigits(input.groupId)) return { ok: false, error: 'groupId 必须是正整数（群号）' };
    if (!isDigits(input.userId)) return { ok: false, error: 'userId 必须是正整数（QQ 号）' };
    const seconds = op === 'unban' ? 0 : Number(input.durationSec);
    if (op === 'ban') {
      if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
        return { ok: false, error: 'durationSec 必须是正整数秒（解除禁言请用 op:"unban"）' };
      }
      if (seconds > MAX_BAN_SECONDS) return { ok: false, error: `durationSec 超过上限（${seconds} > ${MAX_BAN_SECONDS} 秒 = 30 天）` };
    }
    const params = { group_id: Number(input.groupId), user_id: Number(input.userId), duration: seconds };
    const human = seconds === 0 ? '解除禁言' : `禁言 ${Math.round(seconds / 60)} 分钟`;
    return finish(params, `${human}：群 ${params.group_id} 的 ${params.user_id}`);
  }

  if (op === 'deleteMsg') {
    if (!isDigits(input.messageId, { allowNegative: true })) {
      return { ok: false, error: 'messageId 必须是非零整数（QQ 消息 id 可能为负数）' };
    }
    const params = { message_id: Number(input.messageId) };
    return finish(params, `撤回消息 ${params.message_id}`);
  }

  if (op === 'approveFriend' || op === 'approveGroup') {
    const flag = cut(input.flag, 200);
    if (!flag) return { ok: false, error: 'flag 不能为空（来自申请事件，必须原样回传）' };
    if (typeof input.approve !== 'boolean') return { ok: false, error: 'approve 必须是 true/false' };
    if (op === 'approveFriend') {
      const params = { flag, approve: input.approve };
      const remark = cut(input.remark, 30);
      if (remark) params.remark = remark;
      return finish(params, `${input.approve ? '同意' : '拒绝'}好友申请${remark ? `（备注：${remark}）` : ''}`);
    }
    const subType = trim(input.subType || 'add');
    if (!GROUP_REQUEST_SUBTYPES.includes(subType)) {
      return { ok: false, error: `subType 必须是 ${GROUP_REQUEST_SUBTYPES.join(' 或 ')}（收到：${subType}）` };
    }
    const params = { flag, sub_type: subType, approve: input.approve };
    const reason = cut(input.reason, 60);
    if (reason) params.reason = reason;
    return finish(params, `${input.approve ? '同意' : '拒绝'}入群申请（${subType}）${reason ? `：${reason}` : ''}`);
  }

  return { ok: false, error: `未实现的动作：${op}` };
}

/** 是否需要「先告知管理员再执行」的风险提示（给端点/工具描述用）。 */
export function riskHint(op) {
  const risk = GROUP_ADMIN_RISK[String(op ?? '').trim()] ?? 'unknown';
  if (risk === 'high') return '高危：会真的把人移出群，必须管理员放行';
  if (risk === 'medium') return '中等：会限制他人发言，建议先说明原因';
  if (risk === 'low') return '低危：可撤销或影响很小';
  return '未知动作';
}

export default buildGroupAdminAction;
