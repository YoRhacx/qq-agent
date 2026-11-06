// 「群管理」（POST /api/socialV2/group-admin / POST /api/group-admin）自检。
//
// 分两层，两层都不碰真实 QQ、不重启桥接进程：
//   一、src/group-admin.js 的**纯函数**（buildGroupAdminAction / requiresOwnerApproval / riskHint）：
//       动作映射、风险分级、参数字段、kick 必须先放行。
//   二、端到端：用 scripts/audit-bridge-harness.mjs 把**真实的 src/bridge.js** 拉进 VM，
//       配临时 config（consolePort:0）与**假网关**，然后真的往控制台端口打 HTTP。
//       假网关把每次出站调用记进 h.calls.http —— 于是「dryRun / 被审批拦住的动作一个字节都没发出去」
//       可以被断言，而不是靠返回值自称。
//
// ⚠️ 鉴权：最外层全局鉴权只认 `x-console-token` 或 `?token=`，所以**每一个** HTTP 用例都要带
//    控制台令牌；智能体调用再额外带 `x-agent-call: 1` + `x-agent-token`。少了控制台令牌会先吃到
//    `HTTP 401 未授权：请提供控制台访问令牌`，把要断言的业务 403 全掩盖掉。
//
// ⚠️ 阶段状态：本脚本是「先写验收测试」阶段的产物，此时端点尚未接线 —— 未知路径返回
//    `404 {"ok":false,"error":"not found"}`。这类结果记为「待接线」而不是失败（见 notePending）。
//
// ⚠️ 高危 kick：默认必须由管理员放行（allowDangerous:true）后才执行；未放行时必须返回
//    "需要审批"（403 或 {ok:false,needApproval:true}），并且**绝不能**已经调用过网关。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  GROUP_ADMIN_ACTIONS,
  GROUP_ADMIN_RISK,
  GROUP_REQUEST_SUBTYPES,
  MAX_BAN_SECONDS,
  buildGroupAdminAction,
  requiresOwnerApproval,
  riskHint
} from '../src/group-admin.js';

let pass = 0;
let fail = 0;
let pending = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? `（${detail}）` : ''}`); }
}
function notePending(name) {
  pending += 1;
  console.log(`  ⏳ ${name}（待接线：端点返回 404，接线后本断言转为真断言）`);
}
/** 只有整段路由缺失（404 + not found 文案）才算待接线，业务 404 不算。 */
function endpointMissing(r) {
  return r.status === 404 && /not found/i.test(String(r.json?.error ?? ''));
}
/** 「需要审批」的两种合法表达：403，或 200/4xx 且 body 里带 needApproval。 */
function saysNeedApproval(r) {
  if (r.status === 403) return true;
  return r.json?.needApproval === true || /审批|放行|allowDangerous/.test(String(r.json?.error ?? ''));
}

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';
const OTHER_KEY = 'private:123';
const GROUP_ID = '456';
const TARGET_USER = '999';
const AGENT_PATH = '/api/socialV2/group-admin';
const OP_PATH = '/api/group-admin';

// ── 一、pure module ─────────────────────────────────────────────────────────
console.log('## 一、group-admin.js 纯函数');

console.log('### 动作映射与风险分级');
{
  ok(Object.keys(GROUP_ADMIN_ACTIONS).length === 6, `登记 6 个动作（${Object.keys(GROUP_ADMIN_ACTIONS).join('、')}）`);
  ok(GROUP_ADMIN_ACTIONS.kick === 'set_group_kick' && GROUP_ADMIN_ACTIONS.ban === 'set_group_ban', 'kick→set_group_kick / ban→set_group_ban');
  ok(GROUP_ADMIN_ACTIONS.deleteMsg === 'delete_msg', 'deleteMsg→delete_msg');
  ok(GROUP_ADMIN_ACTIONS.approveFriend === 'set_friend_add_request' && GROUP_ADMIN_ACTIONS.approveGroup === 'set_group_add_request', '申请类走 set_friend_add_request / set_group_add_request');
  ok(GROUP_ADMIN_RISK.kick === 'high' && GROUP_ADMIN_RISK.ban === 'medium', 'kick=high / ban=medium');
  ok(GROUP_ADMIN_RISK.deleteMsg === 'low' && GROUP_ADMIN_RISK.unban === 'low', 'deleteMsg/unban=low');
  ok(requiresOwnerApproval('kick') === true, 'requiresOwnerApproval(kick)=true');
  ok(requiresOwnerApproval('ban') === false && requiresOwnerApproval('deleteMsg') === false, 'ban/deleteMsg 不强制 owner 审批');
  ok(requiresOwnerApproval('nope') === false, '未知动作不误判为需审批');
  ok(MAX_BAN_SECONDS === 2592000, '禁言上限 2592000 秒（30 天）');
  ok(GROUP_REQUEST_SUBTYPES.join('/') === 'add/invite', '申请子类型白名单是 add/invite');
  ok(/高危/.test(riskHint('kick')) && /中等/.test(riskHint('ban')) && /低危/.test(riskHint('deleteMsg')), 'riskHint 给出人话风险提示');
  ok(riskHint('nope') === '未知动作', 'riskHint 未知动作如实说');
}

console.log('### 低危动作');
{
  const del = buildGroupAdminAction({ op: 'deleteMsg', messageId: '12345' });
  ok(del.ok === true && del.action === 'delete_msg' && del.params.message_id === 12345, 'deleteMsg 生成 {message_id}', JSON.stringify(del));
  ok(del.risk === 'low' && /撤回消息 12345/.test(del.summary), '  带 risk/summary');
  ok(/^deleteMsg → delete_msg \{/.test(del.audit), '  audit 一行可用于活动流', del.audit);
  const neg = buildGroupAdminAction({ op: 'deleteMsg', messageId: '-987' });
  ok(neg.ok === true && neg.params.message_id === -987, 'messageId 允许负数（QQ 消息 id 可能为负）');
  const unban = buildGroupAdminAction({ op: 'unban', groupId: GROUP_ID, userId: TARGET_USER });
  ok(unban.ok === true && unban.params.duration === 0, 'unban 生成 duration:0（解除禁言）');
  const af = buildGroupAdminAction({ op: 'approveFriend', flag: 'flag-abc', approve: true, remark: '群友' });
  ok(af.ok === true && af.action === 'set_friend_add_request' && af.params.flag === 'flag-abc' && af.params.approve === true && af.params.remark === '群友', 'approveFriend 原样回传 flag 并带 remark', JSON.stringify(af.params));
  const ag = buildGroupAdminAction({ op: 'approveGroup', flag: 'flag-x', subType: 'invite', approve: false, reason: '满员' });
  ok(ag.ok === true && ag.params.sub_type === 'invite' && ag.params.approve === false && ag.params.reason === '满员', 'approveGroup 带 sub_type/approve/reason', JSON.stringify(ag.params));
  const agDefault = buildGroupAdminAction({ op: 'approveGroup', flag: 'f', approve: true });
  ok(agDefault.ok === true && agDefault.params.sub_type === 'add', 'approveGroup 的 subType 缺省为 add');
}

console.log('### 高危 kick 必须先放行');
{
  const blocked = buildGroupAdminAction({ op: 'kick', groupId: GROUP_ID, userId: TARGET_USER });
  ok(blocked.ok === false, '不带 allowDangerous 的 kick ⇒ ok:false（不构造动作）');
  ok(blocked.needApproval === true, '  带 needApproval:true（调用方据此走审批通道）', JSON.stringify(blocked));
  ok(/管理员显式放行/.test(String(blocked.error ?? '')), '  错误信息说明必须管理员放行', blocked.error);
  const stillBlocked = buildGroupAdminAction({ op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, allowDangerous: false });
  ok(stillBlocked.ok === false && stillBlocked.needApproval === true, 'allowDangerous:false 同样被拦');
  const allowed = buildGroupAdminAction({ op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, allowDangerous: true });
  ok(allowed.ok === true && allowed.action === 'set_group_kick' && allowed.risk === 'high', '放行后才构造出 set_group_kick', JSON.stringify(allowed));
  ok(allowed.params.group_id === 456 && allowed.params.user_id === 999 && allowed.params.reject_add_request === false, '  参数字段照 OneBot 口径（group_id/user_id/reject_add_request）', JSON.stringify(allowed.params));
  const withReject = buildGroupAdminAction({ op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, allowDangerous: true, rejectAddRequest: true });
  ok(withReject.params.reject_add_request === true, 'rejectAddRequest:true 如实传递');
}

console.log('### 参数非法');
{
  const bad = [
    [{}, /不支持的群管理动作/, '缺 op'],
    [{ op: 'set_group_card', groupId: GROUP_ID }, /不支持的群管理动作/, 'SnowLuma 不支持的 set_group_card'],
    [{ op: 'set_group_leave', groupId: GROUP_ID }, /不支持的群管理动作/, '不支持的 set_group_leave'],
    [{ op: 'set_group_name', groupId: GROUP_ID }, /不支持的群管理动作/, '不支持的 set_group_name'],
    [{ op: 'set_group_whole_ban', groupId: GROUP_ID }, /不支持的群管理动作/, '不支持的 set_group_whole_ban'],
    [{ op: 'get_group_info', groupId: GROUP_ID }, /不支持的群管理动作/, '不支持的 get_group_info'],
    [{ op: 'get_friend_list' }, /不支持的群管理动作/, '不支持的 get_friend_list'],
    [{ op: 'ban', userId: TARGET_USER, durationSec: 60 }, /groupId/, 'ban 缺 groupId'],
    [{ op: 'ban', groupId: GROUP_ID, durationSec: 60 }, /userId/, 'ban 缺 userId'],
    [{ op: 'ban', groupId: GROUP_ID, userId: 'abc', durationSec: 60 }, /userId/, 'ban 的 userId 非数字'],
    [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: 0 }, /正整数秒/, 'ban durationSec=0'],
    [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: -60 }, /正整数秒/, 'ban durationSec 负数'],
    [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: 1.5 }, /正整数秒/, 'ban durationSec 小数'],
    [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER }, /正整数秒/, 'ban 缺 durationSec'],
    [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: MAX_BAN_SECONDS + 1 }, /超过上限/, 'ban 超过 30 天'],
    [{ op: 'deleteMsg', messageId: '0' }, /messageId/, 'deleteMsg 的 messageId=0'],
    [{ op: 'deleteMsg' }, /messageId/, 'deleteMsg 缺 messageId'],
    [{ op: 'approveFriend', approve: true }, /flag/, 'approveFriend 缺 flag'],
    [{ op: 'approveFriend', flag: '   ', approve: true }, /flag/, 'approveFriend 的 flag 只有空白'],
    [{ op: 'approveFriend', flag: 'f' }, /approve/, 'approveFriend 缺 approve'],
    [{ op: 'approveFriend', flag: 'f', approve: 'yes' }, /approve/, 'approveFriend 的 approve 非布尔（字符串）'],
    [{ op: 'approveFriend', flag: 'f', approve: 1 }, /approve/, 'approveFriend 的 approve 非布尔（数字）'],
    [{ op: 'approveGroup', flag: 'f', subType: 'nuke', approve: true }, /subType/, 'approveGroup 的 subType 非法'],
    [{ op: 'approveGroup', flag: '', approve: true }, /flag/, 'approveGroup 的 flag 为空']
  ];
  for (const [input, re, label] of bad) {
    const r = buildGroupAdminAction(input);
    ok(r.ok === false && re.test(String(r.error ?? '')), `${label} ⇒ 被拒（${r.error}）`);
  }
  const ban = buildGroupAdminAction({ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: MAX_BAN_SECONDS });
  ok(ban.ok === true && ban.params.duration === MAX_BAN_SECONDS, 'ban 恰好 30 天通过（边界）');
  const flagCut = buildGroupAdminAction({ op: 'approveFriend', flag: 'f'.repeat(500), approve: true });
  ok(flagCut.ok === true && flagCut.params.flag.length === 200, 'flag 超长被截到 200（留个活路而不是直接拒）', String(flagCut.params.flag.length));
  const remarkCut = buildGroupAdminAction({ op: 'approveFriend', flag: 'f', approve: true, remark: 'r'.repeat(100) });
  ok(remarkCut.ok === true && remarkCut.params.remark.length === 30, 'remark 超长被截到 30');
}

// ── 二、端到端（真实 bridge.js + 假网关） ─────────────────────────────────────
console.log('\n## 二、端到端（真实 bridge.js + 假网关，HTTP 走控制台端口）');

async function startFixture(overrides = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        tools: { groupAdmin: true },
        groupAdmin: { enabled: true, requireApprovalForKick: true },
        ...(overrides.socialV2 ?? {})
      },
      ...(overrides.top ?? {})
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const tokens = {
    [AGENT_KEY]: h.getSocialV2State(AGENT_KEY).agentToken,
    [OTHER_KEY]: h.getSocialV2State(OTHER_KEY).agentToken
  };
  async function raw(method, pathname, { body, agentToken, consoleToken, agentCall } = {}) {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (agentCall) headers['x-agent-call'] = '1';
    if (agentToken !== undefined) headers['x-agent-token'] = agentToken;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  const gatewayActionCalls = () => h.calls.http.filter((c) => /set_group_kick|set_group_ban|delete_msg|set_friend_add_request|set_group_add_request/.test(String(c.url)));
  return {
    h,
    port,
    tokens,
    // AI 通道：控制台令牌 + agent 声明 + 会话令牌（与真实 MCP 进程的发法一致）。
    ai: (body, token = tokens[AGENT_KEY]) => raw('POST', AGENT_PATH, { body, agentToken: token, consoleToken: CONSOLE_TOKEN, agentCall: true }),
    // 操作者通道：只带控制台令牌（允许 allowDangerous 放行）。
    op: (body) => raw('POST', OP_PATH, { body, consoleToken: CONSOLE_TOKEN }),
    anon: (body) => raw('POST', AGENT_PATH, { body }),
    gatewayActions: gatewayActionCalls,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

try {
  const f = await startFixture();
  try {
    console.log('### AI 通道：低危 dryRun 正常路径');
    {
      const before = f.gatewayActions().length;
      const dry = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'deleteMsg', messageId: '12345', dryRun: true });
      if (endpointMissing(dry)) {
        notePending('低危 dryRun 只校验不发送');
      } else {
        ok(dry.status === 200 && dry.json.ok === true && dry.json.dryRun === true, `低危 dryRun 返回 200/ok/dryRun（HTTP ${dry.status}）`, JSON.stringify(dry.json).slice(0, 240));
        ok(dry.json.action === 'delete_msg' || dry.json.summary, '  回报将要执行的动作/摘要', JSON.stringify(dry.json).slice(0, 200));
        ok(f.gatewayActions().length === before, 'dryRun 没有向网关发任何群管理调用');
        ok(dry.json.needApproval !== true, '  低危动作不需要审批');
      }
      // 策略（2026-10 用户决定）：ban **不需要 confirm、也不需要管理员审批** —— 机器人自主决定时长。
      const dryBan = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: 600, dryRun: true });
      if (endpointMissing(dryBan)) notePending('中危 ban dryRun');
      else {
        ok(dryBan.status === 200 && dryBan.json.dryRun === true, `ban 无需 confirm 即可 dryRun（HTTP ${dryBan.status}）`, JSON.stringify(dryBan.json).slice(0, 200));
        ok(dryBan.json.needApproval !== true, 'ban 不需要管理员审批（机器人自主禁言）');
      }
    }

    console.log('### ⑥ 审批：kick 未获放行必须"需要审批"，且不能真的调用网关');
    {
      const before = f.gatewayActions().length;
      const blocked = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'kick', groupId: GROUP_ID, userId: TARGET_USER });
      if (endpointMissing(blocked)) {
        notePending('AI 通道 kick 未放行 ⇒ 需要审批');
      } else {
        ok(blocked.status === 403 || blocked.status === 400 || blocked.json.ok === false, `kick 未放行 ⇒ 未执行（HTTP ${blocked.status}）`, JSON.stringify(blocked.json).slice(0, 240));
        ok(saysNeedApproval(blocked), '  响应明确表示"需要审批/放行"（403 或 needApproval:true）', JSON.stringify(blocked.json).slice(0, 200));
        ok(f.gatewayActions().length === before, '  ⚠️ 最关键：审批未通过时**没有**调用网关（没有真的踢人）');
        const withFlag = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, allowDangerous: true, dryRun: true });
        ok(f.gatewayActions().length === before, '  就算 AI 自己传 allowDangerous:true + dryRun，也仍然不触达网关');
        if (!endpointMissing(withFlag)) {
          ok(withFlag.status === 200 || withFlag.status === 403,
            `  AI 传 allowDangerous:true：要么被端点拒（AI 无权放行）、要么只做 dryRun（HTTP ${withFlag.status}）`,
            JSON.stringify(withFlag.json).slice(0, 200));
        }
      }
      // 操作者通道：放行后才构造成功（dryRun，仍然不发真消息）
      const opAllowed = await f.op({ key: AGENT_KEY, op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, allowDangerous: true, dryRun: true });
      if (endpointMissing(opAllowed)) notePending('操作者通道 kick 放行后成功（dryRun）');
      else {
        ok(opAllowed.status === 200 && opAllowed.json.ok === true, `操作者放行后 kick 构造成功（HTTP ${opAllowed.status}）`, JSON.stringify(opAllowed.json).slice(0, 240));
        ok(opAllowed.json.action === 'set_group_kick', '  动作是 set_group_kick', JSON.stringify(opAllowed.json).slice(0, 200));
        ok(f.gatewayActions().length === before, '  操作者 dryRun 也没有真的调用网关');
      }
      const opBlocked = await f.op({ key: AGENT_KEY, op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, dryRun: true });
      if (endpointMissing(opBlocked)) notePending('操作者通道 kick 未放行同样需要审批');
      else ok(saysNeedApproval(opBlocked), `操作者未放行同样被拦（HTTP ${opBlocked.status}）`, JSON.stringify(opBlocked.json).slice(0, 200));
    }

    console.log('### 参数非法 → 400');
    {
      const cases = [
        [{ op: 'nuke', groupId: GROUP_ID }, '未知 op'],
        [{ op: 'set_group_card', groupId: GROUP_ID }, 'SnowLuma 不支持的 set_group_card'],
        [{ op: 'get_friend_list' }, 'SnowLuma 不支持的 get_friend_list'],
        // 注意：AI 通道的 `kick` 不带 groupId **不再是 400** —— 见下面单独的两条断言。
        [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: 0 }, 'ban durationSec=0'],
        [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: -1 }, 'ban durationSec 负数'],
        [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: 1.5 }, 'ban durationSec 小数'],
        [{ op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: MAX_BAN_SECONDS + 1 }, 'ban 超过 30 天'],
        [{ op: 'approveFriend', flag: 'f', approve: 'yes' }, 'approve 非布尔'],
        [{ op: 'approveFriend', flag: '   ', approve: true }, 'flag 为空'],
        [{ op: 'approveGroup', flag: 'f', subType: 'nuke', approve: true }, 'approveGroup 的 subType 非法']
      ];
      for (const [body, label] of cases) {
        const r = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], ...body, dryRun: true });
        if (endpointMissing(r)) { notePending(`${label} ⇒ 400`); continue; }
        ok(r.status === 400, `${label} ⇒ 400（HTTP ${r.status}：${r.json.error}）`, JSON.stringify(r.json).slice(0, 200));
      }
      // 危险动作的参数非法：不能被"需要审批"这条更早的闸门掩盖成 403/needApproval。
      const danger400 = await f.op({ key: AGENT_KEY, op: 'ban', groupId: GROUP_ID, userId: TARGET_USER, durationSec: MAX_BAN_SECONDS + 1, allowDangerous: true, dryRun: true });
      if (!endpointMissing(danger400)) ok(danger400.status === 400, `放行后的 ban 参数非法仍 400（HTTP ${danger400.status}）`, JSON.stringify(danger400.json).slice(0, 200));

      // AI 通道的 kick **不带 groupId**：群号由会话 key 推导，这不是"漏填参数"。
      // 回归意义重大 —— `qq_group_admin` 这个 MCP 工具**根本不暴露 groupId**，
      // 若这里判 400，模型就永远踢不了人（实战症状："群管理一直说用不了"）。
      const aiKickNoGid = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'kick', userId: TARGET_USER, dryRun: true });
      if (endpointMissing(aiKickNoGid)) notePending('AI kick 不带 groupId ⇒ 可走审批');
      else {
        ok(aiKickNoGid.status !== 400, `AI kick 不带 groupId 不再 400（HTTP ${aiKickNoGid.status}）`, JSON.stringify(aiKickNoGid.json).slice(0, 220));
        ok(aiKickNoGid.json.needApproval === true, '  仍然标记 needApproval（真要执行还是要管理员放行）', JSON.stringify(aiKickNoGid.json).slice(0, 220));
        ok(String(aiKickNoGid.json.action ?? '') === 'set_group_kick', '  动作仍是 set_group_kick，群号由会话 key 推导', String(aiKickNoGid.json.action));
      }
      // 而**操作者**通道仍要求显式 groupId：那条通道能管多个群，不能靠 key 兜底。
      const opKickNoGid = await f.op({ key: AGENT_KEY, op: 'kick', userId: TARGET_USER, dryRun: true });
      if (!endpointMissing(opKickNoGid)) ok(opKickNoGid.status === 400, `操作者通道 kick 缺 groupId ⇒ 400（HTTP ${opKickNoGid.status}）`, JSON.stringify(opKickNoGid.json).slice(0, 200));
    }

    console.log('### 越权 / 缺凭据');
    {
      const cross = await f.ai({ key: OTHER_KEY, token: f.tokens[AGENT_KEY], op: 'deleteMsg', messageId: '2', dryRun: true }, f.tokens[AGENT_KEY]);
      if (endpointMissing(cross)) notePending('跨会话越权被拒（403）');
      else {
        ok(cross.status === 403, `AI 用 A 会话 token 操作 B 会话 ⇒ 403（HTTP ${cross.status}）`, JSON.stringify(cross.json));
        ok(/agent token 无效/.test(String(cross.json.error ?? '')), '  错误信息是 agent token 无效（agentTokenOk 产生）', cross.json.error);
      }
      const noTok = await f.ai({ key: AGENT_KEY, op: 'deleteMsg', messageId: '2', dryRun: true }, '');
      if (endpointMissing(noTok)) notePending('AI 通道缺会话令牌 ⇒ 403');
      else ok(noTok.status === 403, `AI 通道令牌为空 ⇒ 403（HTTP ${noTok.status}）`, JSON.stringify(noTok.json));

      const anon = await f.anon({ key: AGENT_KEY, op: 'deleteMsg', messageId: '2', dryRun: true });
      ok(anon.status === 401, `什么令牌都不带 ⇒ 401（HTTP ${anon.status}）`, JSON.stringify(anon.json));
      ok(/未授权/.test(String(anon.json.error ?? '')), '  错误信息是全局鉴权层的「未授权：请提供控制台访问令牌」', anon.json.error);

      const badKey = await f.ai({ key: 'nonsense', token: f.tokens[AGENT_KEY], op: 'deleteMsg', messageId: '2', dryRun: true });
      if (endpointMissing(badKey)) notePending('key 格式非法 ⇒ 400');
      else ok(badKey.status === 400, `key 格式非法 ⇒ 400（HTTP ${badKey.status}）`, JSON.stringify(badKey.json));
    }

    console.log('### AI 只能操作自己会话对应的那个群');
    {
      const before = f.gatewayActions().length;
      const otherGroup = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'ban', groupId: '789', userId: TARGET_USER, durationSec: 60, dryRun: true });
      if (endpointMissing(otherGroup)) notePending('AI 操作非本会话的群被拒');
      else {
        ok(otherGroup.status === 403 || otherGroup.status === 400, `AI 对非本会话的群操作被拒（HTTP ${otherGroup.status}）`, JSON.stringify(otherGroup.json).slice(0, 200));
        ok(f.gatewayActions().length === before, '  该请求没有触达网关');
      }
      const bannedUser = await f.ai({ key: AGENT_KEY, token: f.tokens[AGENT_KEY], op: 'ban', groupId: GROUP_ID, userId: 'not-a-number', durationSec: 60, dryRun: true });
      if (!endpointMissing(bannedUser)) ok(bannedUser.status === 400, `userId 非数字 ⇒ 400（HTTP ${bannedUser.status}）`, JSON.stringify(bannedUser.json).slice(0, 200));
    }
  } finally {
    await f.stop();
  }

  console.log('### 开关关闭：socialV2.tools.groupAdmin=false（出厂默认）');
  {
    const off = await startFixture({ socialV2: { tools: { groupAdmin: false } } });
    try {
      const r = await off.ai({ key: AGENT_KEY, token: off.tokens[AGENT_KEY], op: 'deleteMsg', messageId: '2', dryRun: true });
      if (endpointMissing(r)) notePending('工具关闭时 AI 通道 ⇒ 403');
      else {
        ok(r.status === 403, `tools.groupAdmin=false ⇒ AI 通道 403（HTTP ${r.status}）`, JSON.stringify(r.json));
        ok(/工具未启用/.test(String(r.json.error ?? '')), '  错误信息是「工具未启用：qq_group_admin」', r.json.error);
      }
      const viaConsole = await off.op({ key: AGENT_KEY, op: 'deleteMsg', messageId: '2', dryRun: true });
      if (endpointMissing(viaConsole)) notePending('开关关闭只拦 AI：操作者通道仍可用');
      else ok(viaConsole.status === 200, `开关只拦 AI 工具，操作者通道仍可用（HTTP ${viaConsole.status}）`, JSON.stringify(viaConsole.json).slice(0, 160));
      const kickViaConsole = await off.op({ key: AGENT_KEY, op: 'kick', groupId: GROUP_ID, userId: TARGET_USER, allowDangerous: true, dryRun: true });
      if (endpointMissing(kickViaConsole)) notePending('操作者通道的 kick 放行不受工具开关限制');
      else ok(kickViaConsole.status === 200, `操作者通道放行的 kick 不受工具开关限制（HTTP ${kickViaConsole.status}）`, JSON.stringify(kickViaConsole.json).slice(0, 160));
    } finally {
      await off.stop();
    }
  }
} catch (error) {
  fail += 1;
  console.error('  ❌ 端到端用例异常：', error?.stack ?? error);
}

console.log(`\n== 群管理自检：${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待接线` : ''} ==`);
if (pending) {
  console.log(`说明：${pending} 条断言因端点尚未接线（HTTP 404 not found）而记为「待接线」——不是测试脚本写错；`);
  console.log('      第二阶段接线完成后重跑本脚本，这些断言会自动转为真实断言。');
}
if (fail > 0) {
  console.error('一行结论：群管理能力自检失败 —— 见上面 ❌（纯函数层应当全绿；HTTP 层失败即为真问题）。');
  process.exitCode = 1;
} else {
  console.log('一行结论：群管理纯函数层全绿（kick 未放行必返回需要审批、ban 上限 30 天、SnowLuma 不支持的动作与非法参数全部被拒）。');
}
