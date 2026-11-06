// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  // 0.2.2-rc.1 起 schedule_update / schedule_delete 改名为 schedule_edit（改）/ schedule_view（看）
  'schedule_create', 'schedule_list', 'schedule_edit', 'schedule_view',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])
// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。B 站 MCP **故意不在这里**：
// 它是另一个角色的运行面，必须走下面的逐项 allowlist，不能按整个前缀放行。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// ── QQ ↔ B 站安全联动（主人 m11254 / m13414 / m02841）────────────────────
// 2026-10-18 m02841：主人明确「所有的 B 站工具都开放给她，反正 B 站机器人我不咋用了」，
// 于是从「公开内容 4/52 正向 allowlist」改为「52 个已知工具全部放行」。
// 仍然按**名单**校验而不是整个前缀放行：B 站以后新增工具时依旧默认拒绝，
// 避免"对面加了个写接口、这边悄悄多出一个越权出口"。
//
// 历史口径（m11254/m13414 时期，留作背景）：当时只放行公开内容读取，账号状态/私信/
// 审计/汇总/记忆/出站写操作全部拒绝，理由是"两个角色边界"。主人现在不要这条边界了。
const BILI_TOOL_PREFIX = 'mcp__bili__'
// 快照口径（2026-10-18 对账）：B 站侧已从 26 个工具长到 52 个，新增的都是
// 私信/收件/评论/投稿/收藏/热搜榜/后台/记忆之类的**越界面或写操作**，全部按正向
// allowlist 的默认拒绝补进来——**不因为它是读接口就放行**。分组只为审计时看得懂，
// 顺序无关（下面对账断言按集合比较）。B 站再加工具时，这里仍须人工分类后补名。
const BILI_ALL_TOOL_NAMES = Object.freeze([
  // ① 账号/运行状态与花费（另一角色的运行面）
  'bili_account_status', 'bili_mode_status', 'bili_quota_status',
  'bili_usage', 'bili_activity_status', 'bili_wake_status',
  // ↑ bili_wake_status（2026-10-13 对账时新增）：返回的是 B 站角色的唤醒/配额/
  //   会话内部状态，属于「另一个角色在干什么」，不是公开内容。
  // ② 公开内容读取（m02841 起与下面各组一样全部放行，名单只为审计时看得懂）
  'bili_search_video', 'bili_video_info', 'bili_watch_video', 'bili_article',
  'bili_user_videos', 'bili_comment_thread', 'bili_weekly_hot', 'bili_hot_videos',
  'bili_hot_buzzwords', 'bili_rank', 'bili_video_zones',
  'bili_user_card', 'bili_favorite_lists', 'bili_favorite_content', 'bili_recognize_image',
  // ↑ 后 4 个虽然读的是公开资料，但会带出「另一个角色的关系/收藏」或替她拉图：
  //   bili_user_card 返回 iFollowThem；bili_favorite_lists/content 是她的口味与收藏夹；
  //   bili_recognize_image 按她的会话读评论图/头像。裁决同 bili_digest_preview：留拒绝侧。
  // ③ 私域与工作流内部：消息中心/私信/收件/关注流/审计/判定/后台/记忆
  'bili_msgfeed', 'bili_received_replies', 'bili_received_at_and_likes',
  'bili_pm_list', 'bili_pm_history', 'bili_unread_messages', 'bili_wait_for_messages',
  'bili_dynamic_feed', 'bili_follow_feed', 'bili_follow', 'bili_unfollow',
  'bili_audit_log', 'bili_audit_search', 'bili_classify_text', 'bili_outbound_check',
  'bili_topics', 'bili_admin_info',
  'bili_memory_append', 'bili_memory_query', 'bili_memory_remove', 'bili_memory_clear',
  // ④ 汇总/刷视频工作流：会写 state/seen-videos.json、耗配额、改变她后续的汇总结果
  'bili_digest_preview', 'bili_digest_list', 'bili_run_digest',
  // ⑤ 出站写操作：评论/私信/动态/专栏/投稿（拿她的账号发内容、消耗账号信用）
  'bili_post_comment', 'bili_send_pm', 'bili_send_dynamic', 'bili_send_opus',
  'bili_send_article', 'bili_upload_video', 'bili_upload_video_multi',
])
// m02841：52 个全部放行（不是前缀通配——名单外的未来工具仍然默认拒绝）。
const BILI_ALLOWED_TOOL_NAMES = Object.freeze(
  BILI_ALL_TOOL_NAMES.map((name) => `${BILI_TOOL_PREFIX}${name}`),
)
const BILI_ALLOWED_TOOLS = new Set(BILI_ALLOWED_TOOL_NAMES)
// 保留 denied 这个字段（测试、文档、控制台自检都读它）：现在为空数组，语义仍是
// "已知但被拒绝的 B 站工具"，将来若要重新收紧，只需往这里挪名字。
const BILI_DENIED_TOOL_NAMES = Object.freeze([])
const BILI_DENIED_TOOLS = new Set(BILI_DENIED_TOOL_NAMES)

// 供自检导入：验证真源工具集合、正向 allowlist 和默认拒绝口径。
export const BILI_TOOL_POLICY = Object.freeze({
  prefix: BILI_TOOL_PREFIX,
  allowed: BILI_ALLOWED_TOOL_NAMES,
  denied: BILI_DENIED_TOOL_NAMES,
  all: BILI_ALL_TOOL_NAMES,
})

// 注册期隐藏：现在 deny 集合为空，所以 52 个工具全部留在 schema 里（她要用就得看得见）。
// ⚠️ 代价是上下文：52 个工具的描述 + schema 每条消息都要重发，约 1 万 token 量级。
// 想省的话在 B 站侧 tools.disabled 里摘掉不常用的，而不是回到这里按角色边界藏。
export const BILI_RESTRICTED_TOOL_NAMES = BILI_DENIED_TOOL_NAMES

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
// 主人 m02841：「ops_bash 也开放给她」——点名放开 dsh-ops 的命令执行工具。
// 注意 ops_bash 不是 DSH 内置的 bash/pwsh（那两个仍在 LOCAL_EXECUTION_TOOLS 里隐藏），
// 它来自 profile 里的 dsh-ops 插件；这里只放开这一个名字，文件读写/检索类（read/write/
// edit/glob/grep/ops_glob/ops_grep/ops_replace/ops_inspect_local_file）保持拒绝。
// 梗百科（dsh-memewiki）：search_meme_wiki 只读本地 SQLite 词库（6792 条、离线、
// 毫秒级），不碰文件、不发网络，和 ops_bash 同属"只给她多一个查词的口子"，放行。
// feedback_meme_wiki **不放行**——它会把内容提交到 cnmeme.wiki，属于对外发布，
// 必须由主人确认后由主会话调。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'ops_bash',
  'search_meme_wiki',
])

// 上下文管理类工具（DSH 的上下文压缩 / ACP 家族）：它们只操作**模型自己的对话上下文**
// ——压缩自己的历史、把压缩块还原回来、在自己被折叠的历史里检索、读自己的缓存账本——
// 既不碰文件也不起进程，属于同一个"无害模型侧工具"口径，因此放行。
//
// 为什么必须显式列出来（2026-10-11 的真实故障）：仿真会话里她上下文变长后**连续两次**
// 收到 `工具 "compress" 不在 QQ 桥接白名单内，已拒绝`，于是"太长了自己压一压"这条唯一
// 的自救路径被堵死，只能继续复读旧内容直到被 DSH 强制截断。她因此把这件事写进
// "未解决环境问题"汇报给主人。放行后她可以自己减负，且这条路径**不扩大权限面**：
// 压缩/还原/检索作用域都是她自己的会话上下文，拿不到任何群聊之外的本地资源。
//
// 名单名逐条对齐 DSH 注册的工具名（compress / decompress / search_context /
// acp_status / acp_cache）；写成数组而非 Set，便于测试与文档引用同一份来源。
export const SAFE_CONTEXT_TOOL_NAMES = Object.freeze([
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
])
const SAFE_CONTEXT_TOOLS = new Set(SAFE_CONTEXT_TOOL_NAMES)

// ── 注册期隐藏（restrict）：**必须重试**，否则对 MCP 工具必然静默失效 ──────
//
// 2026-10-13 实测根因（此前一直误判为"作用域问题"）：
// `tools.restrict()` 在调用时会先做一次**原子性**的名字校验——
// `const known = this.view(scope).restrictableNames;` 只要有一个名字还没注册，
// 整批抛 `tools.restrict() names unknown global tool "X"; known global tools: …`。
//
// 而 preset 守卫的 `apply()` 跑在 profile 级 MCP client 完成 `tools/list` **之前**：
// 启动日志实证（crash-2026-10-12T15-40-16-994Z-host.log）——
//   第 12–205 行：194 条 `skip restrict … names unknown global tool`，
//                 每条都报 `known global tools: list_mcp_resource_templates,
//                 list_mcp_resources, read_mcp_resource`（当时全局层只有这 3 个）；
//   第 209 行：`[mcp-bili] 注册了 23 个工具`（**晚于**全部 restrict 尝试）。
// ⇒ 单次 restrict 对 MCP 工具（snowluma 51 个、bili 25 个）**一个都挡不住**，
//   且因为逐名 try/catch 而**完全静默**：schema 里照样有，只有 guard 在调用时兜底。
//
// 修法：把名单放进 `pending`，订阅 `tools/change`（工具表任何变化都会 emit，
// 且该事件是**非作用域过滤**的注册表通知，scoped 监听者能收到全局变化），
// 每次变化后把**尚未成功限制**的名字再试一遍；成功一个就从 pending 移除。
// 另配几次延时兜底，防某些注册路径不触发事件。
const RESTRICT_TARGETS = Object.freeze([
  ...KNOWN_DANGEROUS_GLOBAL_TOOLS,
  ...BILI_RESTRICTED_TOOL_NAMES,
])

export function apply(ctx) {
  const pending = new Set(RESTRICT_TARGETS)
  const restricted = new Set()
  let flushing = false

  const flushRestrictions = () => {
    if (flushing || pending.size === 0) return
    flushing = true
    try {
      for (const name of [...pending]) {
        try {
          ctx.tools.restrict({ deny: [name] })
          pending.delete(name)
          restricted.add(name)
        } catch (error) {
          const message = String(error?.message ?? error)
          if (/names unknown global tool/.test(message)) continue // 尚未注册，等下次变化
          // 其它错误（空过滤器、保留名等）是真问题，必须留痕。
          console.error(`[qq-tool-restrict] restrict ${name} 失败：${message}`)
          pending.delete(name)
        }
      }
    } finally {
      flushing = false
    }
  }

  // 启动期会有上百次 tools/change（每个 MCP 工具注册一次）。名单里绝大多数名字
  // 在本 profile 里永远不存在，逐次全量重试会做几万次无谓的 view() 遍历，
  // 所以把事件合并成一个短窗口，一个窗口只扫一遍。
  let flushTimer = null
  const scheduleFlush = () => {
    if (flushTimer !== null) return
    if (typeof setTimeout !== 'function') { flushRestrictions(); return }
    flushTimer = setTimeout(() => { flushTimer = null; flushRestrictions() }, 60)
    if (typeof flushTimer?.unref === 'function') flushTimer.unref()
  }

  flushRestrictions() // 首次：能挡的（已在全局层的）立即挡掉
  if (typeof ctx.on === 'function') {
    ctx.on('tools/change', scheduleFlush)
    // 兜底：MCP 工具是异步连上的，事件之外再补几次，避免时序竞态。
    if (typeof setTimeout === 'function') {
      for (const delayMs of [500, 1500, 4000, 10000]) {
        const timer = setTimeout(() => flushRestrictions(), delayMs)
        if (typeof timer?.unref === 'function') timer.unref()
      }
    }
  }
  // 供自检读取内部状态（不参与运行时行为）。
  // 用 defineProperty 而非直接赋值：ctx 是 Cordis 的上下文对象，直接挂属性
  // 可能命中它的拦截器；失败也不该影响守卫本身。
  try {
    Object.defineProperty(ctx, '__qqRestrictState', {
      value: { pending, restricted, flushRestrictions },
      enumerable: false,
      configurable: true,
    })
  } catch { /* 自检可读性不是运行时的必要条件 */ }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    // B 站命名空间不走通配前缀：只有公开内容 allowlist 可用；其余（包括以后新增、
    // 尚未审计的名字）一律默认拒绝，防止 QQ 角色干预 B 站角色的私域与工作流。
    if (name.startsWith(BILI_TOOL_PREFIX)) {
      if (BILI_ALLOWED_TOOLS.has(name)) return
      const known = BILI_DENIED_TOOLS.has(name)
      return known
        ? `工具 "${name}" 属于 B 站工具人的私域或工作流，已拒绝（QQ 仅可读取公开 B 站内容，不能干预另一个角色）`
        : `工具 "${name}" 尚未通过 QQ↔B站联动安全审计，已默认拒绝`
    }
    if (SAFE_EXACT.has(name)) return
    if (SAFE_CONTEXT_TOOLS.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
