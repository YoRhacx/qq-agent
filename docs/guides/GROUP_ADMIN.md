# 群管理全解（GROUP_ADMIN）

> 两个入口，共用同一个动作构造器（`src/group-admin.js` 的 `buildGroupAdminAction()`）：
> **AI 工具** `qq_group_admin`（→ `POST /api/socialV2/group-admin`，带 `key` + 会话令牌）与
> **操作者通道** `POST /api/group-admin`（控制台 / CLI，凭 `x-console-token`）。
>
> ⚠️ 出厂默认**关**：`socialV2.tools.groupAdmin=false`。
> ⚠️ 高危动作（`kick`）**无论如何都要管理员显式放行**：`allowDangerous:true`，AI 通道拿不到这个放行。
>
> **状态：已上线**。MCP 工具 `qq_group_admin` / `qq_list_requests`、两条 HTTP 通道、
> `bot.onRequest` 申请事件通道、以及"管理员在私聊回「通过/拒绝」"的审批流都已接进
> `src/bridge.js` 与 `src/mcp-snowluma-safe.js`；开关保持出厂默认关，要用得显式打开。

---

## 一、这个能力干什么

这是桥接里**唯一一类会真正影响别人**的操作：踢人、禁言、撤回消息、批好友/入群申请。
出错的代价不是"这条没发出去"，而是"群里少个人 / 某人被静音了"，所以设计上刻意保守。

| `op` | OneBot action | 风险 | 参数 |
| --- | --- | --- | --- |
| `deleteMsg` | `delete_msg` | 低 | `messageId`（非零整数，QQ 消息 id 可能为负） |
| `unban` | `set_group_ban` | 低 | `groupId`、`userId`（解除禁言，内部 `duration:0`） |
| `approveFriend` | `set_friend_add_request` | 低 | `flag`、`approve`（布尔）、`remark?` |
| `approveGroup` | `set_group_add_request` | 低 | `flag`、`subType: add\|invite`、`approve`（布尔）、`reason?` |
| `ban` | `set_group_ban` | **中** | `groupId`、`userId`、`durationSec`（正整数，≤ 2592000 = 30 天） |
| `kick` | `set_group_kick` | **高** | `groupId`、`userId`、`rejectAddRequest?` |

`kick` 与 `ban` 的 `groupId` 必须与调用会话自己的群一致（AI 通道），否则 403/400；
操作者通道可以管任意白名单内的群。

**朋友申请 / 入群申请怎么处理**：申请事件到达时带一个一次性的 `flag`，桥接把它透出来，
调用方**原样回传**：

```json
{ "op": "approveFriend", "flag": "<申请事件的 flag>", "approve": true, "remark": "群友" }
{ "op": "approveGroup",  "flag": "<申请事件的 flag>", "subType": "add", "approve": false, "reason": "满员" }
```

`flag` 不能为空（空/只有空白 → 400）且**不能自己编**——它是 QQ 侧的一次性凭据；超过 200 字会被截断。
`approve` 必须是**布尔真值**（`'yes'`、`1` 都会被拒，避免"字符串真值"被 QQ 当成同意）。
`subType` 只认 `add` / `invite`（缺省 `add`）。

## 二、为什么默认关闭

1. **不可撤销**：踢人、批好友申请都没有"撤回"接口。
2. **动作面太大**：这是唯一能"代操作者做管理决定"的工具；prompt injection 若拿到它，
   可以诱导模型把群友踢出去。
3. **审批是能力的一部分**：`kick` 默认必须由管理员放行（`allowDangerous:true`），
   而 AI 通道**不提供**这个放行（见第三节）——所以即使工具被打开，AI 也踢不了人。

按与 `sendImage` / `sendVoice` / `sendStickerRemark` 相同的出厂口径：强副作用的能力默认关。
要开在控制台勾一下（写进 `config.json` 的 `socialV2.tools.groupAdmin`）。

**只有一个开关（这一点踩过坑）**：`socialV2.tools.groupAdmin` 既是"模型看不看得见这两个工具"，
也是"端点允不允许执行"。代码里原本还有第二个硬开关 `socialV2.groupAdmin.enabled`，与工具开关
出厂默认都是 `false`，于是"在控制台把工具勾上"之后调用仍 403「群管理已关闭」—— 用户看不到
第二个闸门，表现就是"明明开了却说没开"。现在 `enabled` **跟随工具开关**；只有显式写
`socialV2.groupAdmin.enabled=false` 时才作为**紧急熔断**关掉 AI 通道（操作者通道不受影响）。

## 三、审批：`kick` 永远先问管理员

- AI 通道调用 `kick`（不带 `allowDangerous`）→ **不执行**，返回"需要审批"
  （HTTP 403，或 `{ok:false, needApproval:true, error:'「kick」是高危操作（会真的把人移出群），必须由管理员显式放行后才执行'}`）。
  关键在于：**网关侧零调用**——这不是"发出去才报错"，而是**根本没构造动作**。
- 只有**操作者通道**能传 `allowDangerous:true` 放行（控制台 / CLI 的调用者就是管理员本人）。
  放行后先 `dryRun:true` 看一遍将要执行的 action 与参数，再真正执行。
- `ban` 风险为"中"（会限制他人发言），但**不需要管理员批准**：机器人可以自主禁言、**自己选时长**
  （1 秒 ~ 30 天）。执行后往 owner 私聊留一条通知并记活动日志 —— 是**事后可见**，不是事前批准
  （`socialV2.groupAdmin.notifyOwnerOnBan=false` 可关掉那条通知）。
- 事后可追责：每个成功构造的动作都产出稳定的 `audit` 行（`op → action {params}`），
  适合写进活动流。

**接线的实况**（这段描述的是**已经跑在代码里**的流程，不是设想）：

- 审批走的是桥接既有的**挂起问答通道**（和"要不要执行某个操作"那套同一个 `pending` 表）：
  AI 提交 `kick` 后，桥接给**管理员的私聊**（`config.json` 的 `ownerQQ`）发一条
  「有人要执行 kick … 回复「通过」或「拒绝」」。管理员在私聊里回**「通过」**才构造动作并调网关；
  回**「拒绝」**则丢弃。
- **审批只在被批准的那一刻执行一次**：处理函数一进门就 `clearTimeout` 并把自己的条目从 `pending` 里删掉，
  所以重复回「通过」不会重复踢人。
- **30 分钟没人回 → 自动作废**（`GROUP_ADMIN_APPROVAL_TTL_MS`），超时后动作不会补执行，
  且会给管理员发一条超时通知。没配 `ownerQQ` 时高风险操作**直接拒绝**（403），
  因为"没人能批"就不该假装排进了队列。
- AI 通道带来的 `allowDangerous` **一律被丢弃**（`groupAdminParamsFor` 只在 `approval === 'owner'`
  时才拼 `allowDangerous:true`）：模型没有办法给自己发权限，这一条是硬编码的，不是靠提示词纪律。
- 没走审批的动作（低危 + `ban`）是**直连网关**执行的，**不经过消息发送链**
  （不走 `sendChain`、不占发言配额、不受静默期影响）——群管理不是"说话"。
- 申请事件（好友/入群）由 `/api/socialV2/group-requests` 透出（见下节），**并同时**写进该会话的消息流
  （`【好友申请】…` / `【入群申请】…`）和活动流，所以模型在对话里也会看到它，不只是"等来查"。

## 四、申请事件与「待办」查询

申请不是"先查列表再处理"的模型，而是**事件推过来**的：

1. SnowLuma 客户端发来 request 事件（`post_type: 'request'`），桥接用 `bot.onRequest(...)` 接住。
2. `request_type === 'group'` → 记到 `group:<group_id>`；`'friend'` → 记到 `private:<user_id>`；
   其它类型只记日志忽略。
3. 记录本身只留**有界**的一份（每个会话最多 20 条，同一个 `flag` 重复到达就覆盖），
   并跟着会话状态一起落盘——所以**重启不会丢掉待办**。
4. 同时：写进该会话的消息流、写活动流、给管理员私聊发一条提醒。

模型要实际处理时，用 `qq_list_requests`（AI 通道）取 `flag`：

```
GET /api/socialV2/group-requests?key=group:123456
  x-console-token: <控制台令牌>
  x-agent-call: 1
  x-agent-token: <该 key 的会话令牌>
```

返回 `{ ok, key, requests, requestsCount, approvals, approvalsCount, hint }`：

- `requests[]`：`{ flag, type, subType, userId, userName, groupId, groupName, comment, at, ageText }`
  —— `flag` 就是要原样回传给 `approveFriend` / `approveGroup` 的那个值。
- `approvals[]`：**当前挂起中的高危审批**（你发过 `kick`、管理员还没回）。
  有了它，模型就知道"我不是没反应，是在等审批"，不会重复提交。
- 只读：不发消息、不改状态。

为什么不塞进既有的 `/api/socialV2/states`：那是控制台的只读总览，字段是给**人**看的
（未读数、唤醒原因），而 `flag`、挂起审批这类**给模型用的操作凭据**不该混进控制台视图，
也不该被 `states` 的字段裁剪规则顺手丢掉。

## 五、端点与参数

### AI 通道

```
POST /api/socialV2/group-admin
  content-type: application/json
  x-console-token: <控制台令牌>          # 最外层全局鉴权认这个
  x-agent-call: 1
  x-agent-token: <该 key 的会话令牌>
```

```json
{ "key": "group:123456", "token": "<会话令牌>",
  "op": "deleteMsg", "messageId": "12345", "dryRun": true }
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✅ | `group:群号` / `private:QQ号`；格式错 → 400 |
| `token` | ✅ | 该 key 的会话令牌（也可走 `x-agent-token`） |
| `op` | ✅ | 上表六个之一；未知动作 → 400 `不支持的群管理动作：…（可用：…）` |
| `groupId` / `userId` | 视动作 | 必须是非零正整数（`group:0`、`abc` 一律拒） |
| `durationSec` | `ban` ✅ | 正整数秒，0/负数/小数/`> 2592000` 全部 400 |
| `messageId` | `deleteMsg` ✅ | 非零整数，可负 |
| `flag` / `approve` / `subType` / `remark` / `reason` | 申请类 ✅/❌ | 见第一节 |
| `allowDangerous` | ❌ | **只有操作者通道有效**；AI 通道传了也不放行 |
| `dryRun` | ❌ | `true` 时走完全部校验但不调网关 |

响应（成功）：`{ ok:true, action:'delete_msg', params:{message_id:12345}, risk:'low', summary, audit, messageId? }`；
`dryRun:true` 时带 `dryRun:true` 且**不带** `messageId`。

**参数非法一定先报 400，不会被审批闸门吃掉**：形状检查（`assertGroupAdminShape`）在审批之前跑，
而它只看**调用方自己写进请求体的 `groupId`**——正是为了不把"桥接替你补的群号"当成"你写过了"。
（踩过的坑：早期版本把补好群号的参数对象传进形状检查，于是 `{op:'kick'}` 少了 `groupId` 却得到
"需要审批"而不是 400。现在两条路径分开，回归测试钉住了这一点。）

### 操作者通道

```
POST /api/group-admin
  x-console-token: <控制台令牌>

{ "key": "group:123456", "op": "kick", "groupId": "123456", "userId": "999",
  "allowDangerous": true, "dryRun": true }
```

- 操作者通道**不受 `tools.groupAdmin` 限制**（那个开关只管 AI 工具），且**只有它**能放行 `kick`。
- 白名单外目标仍然 403。
- **带 `x-agent-token` 的请求到不了这里**：`/api/group-admin` 不在 agent 路径白名单里，
  会在更外层被拒，所以 AI 借不到这条"操作者例外"。

## 六、上限与限流

- `durationSec` 上限 **2592000 秒（30 天）**（`MAX_BAN_SECONDS`）；要永久禁言请用 30 天 + 到期再续。
- 文本字段一律截断而不是报错：`flag` ≤ 200 字、`remark` ≤ 30 字、`reason` ≤ 60 字。
- 群管理属于"写操作"，与发图/发语音同一套外发审计；每次成功写活动流 + 会话记录。
- 频繁调用会被限流（429）；联调一律先 `dryRun`。

## 七、做不了 / 没做（重要）

**SnowLuma 不支持**这些 OneBot action（源码 0 命中），所以本仓库**没有**、也不该假装有：

| 动作 | 说明 |
| --- | --- |
| `set_group_card` | 改群名片 |
| `set_group_leave` | 退群 |
| `set_group_name` | 改群名 |
| `set_group_whole_ban` | 全员禁言 |
| `get_group_info` | 查群资料 |
| `get_friend_list` | 拉好友列表 |

（`get_group_list`、`get_group_member_info` 在网关侧可用，但本工具**没有**实现这两个 op：
工具面越小越安全，需要群成员名单请用 `qq_get_group_members`。）

其它没做的：

- **没有"批量踢人/批量禁言"**：一次一个动作，避免一次误操作端掉半群人。
- **没有控制台群管理面板**：操作者入口是 HTTP 接口（见第四节），界面面板未做。
- **不能"先踢后审"**：审批闸门在**构造动作之前**，不存在"先执行再补审批"的路径。

## 八、常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `HTTP 401 未授权：请提供控制台访问令牌` | 没带 `x-console-token` | 每个请求都带控制台令牌 |
| `HTTP 403 agent token 无效` | `token` 不是这个 `key` 的会话令牌 | 用该 key 自己那份令牌 |
| `HTTP 403 工具未启用：qq_group_admin` | `tools.groupAdmin=false`（出厂默认） | 控制台 → 二代设置 → 工具勾选打开 |
| `needApproval: true` / `必须由管理员显式放行` | 调用了 `kick` 而没有放行 | 走操作者通道 + `allowDangerous:true`（先 `dryRun`） |
| `durationSec 必须是正整数秒（解除禁言请用 op:"unban"）` | 传了 0 / 负数 / 小数 / 缺省 | 禁言给正整数秒；解禁用 `unban` |
| `durationSec 超过上限（… > 2592000 秒 = 30 天）` | 想永久禁言 | 给 30 天，到期续 |
| `flag 不能为空（来自申请事件，必须原样回传）` | 自己编了 flag | 用申请事件里透出来的那个 |
| `approve 必须是 true/false` | 传了 `'yes'` / `1` | 传 JSON 布尔 |
| `不支持的群管理动作：set_group_card` | 那是 SnowLuma 不支持的动作 | 见第六节，别试了 |
| `HTTP 429` | 调用太频繁 | 等一会儿；先 `dryRun` 联调 |

## 九、相关文件与测试

- 动作构造与策略门：`src/group-admin.js`（`buildGroupAdminAction()`、`requiresOwnerApproval()`、
  `riskHint()`、`GROUP_ADMIN_RISK`、`MAX_BAN_SECONDS`）。
- 端点与工具：`src/bridge.js`（`/api/socialV2/group-admin`、`/api/group-admin`、
  `/api/socialV2/group-requests` + `v2ToolEnabled('groupAdmin')`）、
  `src/mcp-snowluma-safe.js`（`qq_group_admin`、`qq_list_requests` —— 两个都挂在 `groupAdmin` 这个开关上，
  关掉时**不注册**，模型连它们的 schema 都看不到）。
- 申请事件：`src/bridge.js` 的 `bot.onRequest` → `handleRequestEvent`；待办存在会话状态的
  `pendingRequests` 字段里（跟着 `saveSocialV2State()` 落盘）。
- 配置：`config.json` 的 `socialV2.tools.groupAdmin`（默认 `false`）。
  `socialV2.groupAdmin` 只留 `{ requireApprovalForKick: true, notifyOwnerOnBan: true, maxPerMinute: 6 }`；
  **`enabled` 跟随 `tools.groupAdmin`**，只有显式写 `socialV2.groupAdmin.enabled=false` 才作为紧急熔断
  关掉 AI 通道（详见 §二 的「只有一个开关」）。

### MCP 工具

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `qq_group_admin` | 执行一次群管理动作（只在群会话、只管自己这个群） | `key`、`token`、`op`、`userId`/`durationSec`/`messageId`/`flag`/`approve`/`subType`/`remark`/`reason`/`dryRun` |
| `qq_list_requests` | 列出待处理的好友/入群申请 + 挂起中的审批（**flag 的唯一来源**） | `key`、`token` |

两者都**不暴露 `allowDangerous`**：模型没有自己批高危操作的入口。`qq_group_admin` 撞上审批闸门时
返回的是"需要审批"而不是失败，工具描述里也写明了这一点，免得模型把它当错误去重试。

```bash
node scripts/test-group-admin-http.mjs    # 离线：真实 bridge.js + 假网关，不发任何真实 QQ 消息
```

覆盖：纯函数（六个动作映射与风险分级、`kick` 未放行必返回 `needApproval`、24 组非法参数、
30 天上限边界、字段截断）、AI 通道低危 `dryRun`（断言网关零调用）、**`kick` 未放行时不仅报错、
而且确实没调用网关**、**`kick` 少了 `groupId` 必须 400 而不是被审批闸门吃掉**、
操作者通道放行后 `dryRun` 成功、参数非法 400、跨会话越权 403、
缺凭据 401、AI 只能操作本会话对应的群、`tools.groupAdmin=false` 只拦 AI。
