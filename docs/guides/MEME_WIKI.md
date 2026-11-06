# 梗百科（dsh-memewiki）

> 一句话：给 DSH 装了一本**离线的网络梗词典**（6792 条，来自 cnmeme.wiki），她和主会话都能查；查到的词条会以「怎么用/怎么接」的形式给模型，而不是百科腔。

安装于 2026-11-06，插件版本 **dsh-memewiki 0.1.20**（MIT）。

## 装在哪

| 项 | 位置 |
| --- | --- |
| 插件本体 | `D:\dsh-plugins\dsh-memewiki\`（源码 + `data/memes.db` 17 MB） |
| profile 依赖 | `C:\Users\testuser\.dsh\profiles\desktop\package.json` → `"dsh-memewiki": "file:D:/dsh-plugins/dsh-memewiki"` |
| profile 启用 | 同文件 `dsh.profile.bundles` 末尾的 `"dsh-memewiki"` |
| 运行时配置 | `C:\Users\testuser\.dsh\memewiki.json`（首次保存设置时生成） |
| 词库 | `D:\dsh-plugins\dsh-memewiki\data\memes.db`（SQLite，表 `memes`） |

装法是 profile 里跑 pnpm：`pnpm add file:D:/dsh-plugins/dsh-memewiki`（不要从 codeload 反复 clone——4.8 MB 的 tar.gz 在国内链路上只有 ~40 KB/s 且不支持续传）。

## 它给我们多了什么

1. **两个工具**
   - `search_meme_wiki({ query })`：查词。命中时返回的是「[梗百科·内置用法] 1. 查到词条就先接梗、别科普…」+ 词条正文（怎么用 / 出处与含义 / 标签）；没收录时明确说「词库里没收录…别硬解释」。
   - `feedback_meme_wiki({ title, addition, reason, section })`：把一条纠正/补充提交回 cnmeme.wiki（站内先过 AI 审核，再转人工）。
2. **预查注入**（`lib/index.js:883` `ctx.systemPrompt.context({ name: 'memewiki:prefetch', order: 950 })`）：每轮现算、纯本地、**不调模型不花钱**。当某条用户消息「像是在问梗」（`问梗模式` 结尾匹配「什么梗/什么意思/怎么用…」，或整句就是 2~10 字的裸词）时，把词条直接塞进系统提示。
3. **设置页**：DSH 设置 → 插件 → 梗百科（自动思考梗 / 串子开关 / 串子程度 50）。开关写在 `~/.dsh/memewiki.json`，改完即时生效。

## 我们为「她」（QQ 角色）做的接线

- **工具白名单**：`plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_EXACT` 加了 `'search_meme_wiki'`（只读本地 SQLite、离线、毫秒级，和 `ops_bash` 同属「多一个查词口子」）。`feedback_meme_wiki` **故意不放行**——它会把内容提交到外网站点，属于对外发布，必须主人确认后由主会话调。
- **人格卡规则**：`roles/小鲸鱼.md` §十（怎么混进群）里加了一条——遇到看不懂的梗/黑话/缩写，**第一站是本地梗百科**（`search_meme_wiki`），查到了照「怎么用」接一句、别念词条；没收录再去贴吧/B站搜。
- 生效方式：人格卡是**热生效**（下一条消息就带上）；`qq-tool-restrict` 的白名单是 DSH 启动时装配的插件代码，**要重启一次 DSH** 才生效。

## 为什么预查注入对她的会话基本不触发

她的会话里，桥接发过来的「用户消息」是一整块拼好的提示（时间、会话、消息记录、行为要求…），而 `问梗模式` 要求**整段文本以**「什么梗/什么意思/怎么用」结尾、`裸词模式` 要求**整段**只有 2~10 个字。所以注入几乎永远不会命中她的会话——她能查梗靠的是上面那条人格卡规则 + `search_meme_wiki` 工具，而不是预查。主会话（人直接在 GUI 里打一句「马头」或「XX 是什么梗」）才会吃到预查。

## 验收怎么做

```bash
# 主会话：直接问工具
#   search_meme_wiki({ query: "马头" })          → 词条 + 内置用法
#   search_meme_wiki({ query: "蚌埠住了" })      → 「词库里没收录…别硬解释」
# 她的会话（重启 DSH 后）：在群里丢一个生词，看她会不会先查再接
```

## 边界

- 词库是**离线快照**，不会自动更新；要更新走设置页的「检查更新 / 更新词库」按钮（会联网）。
- 不联网、不写外部服务（除非你点更新或调 `feedback_meme_wiki`）。
- 词条质量是众包的，冷门梗可能没有；查不到时她的规则是「直接问『这啥梗』」，禁止硬编。
