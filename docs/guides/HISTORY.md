# 历史检索全解（HISTORY）

> 能力：桥接把每个会话的**收发文字**按行落盘（每会话一个 JSONL），AI 可以用 `qq_search_history`
> （→ `POST /api/socialV2/history/search`）在**自己那个会话**的历史里做关键词检索，拿回**命中片段**。
> 操作者通道同一个端点，凭 `x-console-token` 可查任意 key，另有 `GET /api/socialV2/history/stats`。
>
> ✅ 出厂默认**开**：`socialV2.tools.searchHistory=true`（`history.enabled=true`）。它是**只读**能力，
> 只能读本会话、返回的是片段——不会外发任何消息，所以与"默认关"的外发工具口径不同。
>
> 落盘目录 `state/history/`（可用 `socialV2.history.dir` 改）；保留策略挂在**已有的 60 秒 ticker** 上低频跑。

---

## 一、什么会被记下来（挂点只有三处）

| 方向 | 挂点 | 记什么 |
| --- | --- | --- |
| 入站 `dir:'in'` | `appendSocialV2Message()` 内部 | **只记别人发的消息**（自己发的走下面两处）；带 `tsMs/senderId/senderName/text/media/messageId/replyToId` |
| 出站 `dir:'out'`（文字） | `recordSentMessagesV2()` | 桥接真正发出去的文本；`senderName` 记成 `我` |
| 出站 `dir:'out'`（媒体） | `recordSelfMessageV2()` | 发图/发语音/发表情时**只记一条文字描述**，如 `[图片] 猫.png` |

- **同一句话只记一处**：文本走 `recordSentMessagesV2`，媒体走 `recordSelfMessageV2`，两条路径不重叠，
  所以不会出现"一句话在历史里出现两次"。
- **绝不存字节**：图片/语音/表情只留描述性字段（`type/file/url/name/bytes/mime/durationMs/desc`），
  没有 base64、没有本地绝对路径——历史库要长期躺在 `state/` 里，还要给模型检索。
- 入站 append 是**异步且不阻塞主链路**（`void archive.append(...).catch(log)`）：历史写失败只记一行日志，
  不会让一条群消息处理不下去。

## 二、检索的语义（不要把它当"完整对话"）

- **就是关键词 AND 子串匹配**，没有分词、没有语义/向量检索：`query` 按空格切成多个词，
  **每个词都必须出现在同一条记录里**才算命中（大小写不敏感）。
- 返回的是**片段（snippet）**：命中关键词前后各取 40 字（`snippetPad`），片段里带发送者名与方向；
  一条命中只保证那一小段相关，**别拿它当原话引用**——要完整上下文还是用 `qq_get_recent_messages` /
  `qq_get_unread_messages`。
- 每个会话一个文件，检索**天然按 key 隔离**：AI 只能查自己那个 key（拿别会话的 key 会被 403）。
- 返回里的 `scanned` 是本次**实际检查的行数**，`truncated=true` 表示这次被体积/时间/命中数上限截断，
  结果可能不全（不是"没有更多了"的保证）。
- 记录是**按行倒着读**的（最近的先命中），默认预算：倒读 64 MB / 20 万行、单次最多 2 秒、最多 50 条命中。

## 三、硬边界（代码里拦掉的，不是建议）

| 情况 | 结果 |
| --- | --- |
| `query` 为空 | ❌ 400 `query 不能为空` |
| `query` > 100 字 | ❌ 400 `query 过长（最多 100 字）` |
| `limit` 不是 1~50 | ❌ 400 `limit 必须是 1~50 的整数`（缺省 20） |
| `sinceMs` / `untilMs` 不是毫秒数 | ❌ 400 `sinceMs 必须是毫秒数`（允许数字字符串；空值 = 不过滤该边界） |
| `key` 不是 `group:<数字>` / `private:<数字>` | ❌ 400 `key 格式应为 group:群号 或 private:QQ号` |
| 请求体不是合法 JSON | ❌ 400 `请求体必须是合法 JSON` |
| AI 拿**别的会话**的 key | ❌ 403 `agent token 无效` |
| AI 调用不带令牌 | ❌ 403（外层鉴权 `智能体调用必须携带有效的会话令牌`） |
| `tools.searchHistory=false` | ❌ 403 `工具未启用：qq_search_history`（操作者通道不受影响） |
| `history.enabled=false` | ❌ 403 `历史检索已关闭（socialV2.history.enabled=false）`（**总闸**，操作者也拒） |

## 四、配置项

```json
"socialV2": {
  "tools": { "searchHistory": true },
  "history": {
    "enabled": true,
    "dir": "state/history",
    "retentionDays": 30,
    "maxBytes": 67108864
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tools.searchHistory` | `true` | AI 工具 `qq_search_history` 的开关（控制台勾选写这里） |
| `history.enabled` | `true` | **总闸**；`false` 时 AI 通道与操作者通道都拒，挂点也不再归档 |
| `history.dir` | `state/history` | 归档目录（相对路径按仓库根解析，绝对路径原样使用） |
| `history.retentionDays` | `30` | prune 保留窗口（天）；`0` 表示不按时间删 |
| `history.maxBytes` | `67108864`（64 MB） | 单会话文件体积上限，超了就从头删最老的行 |

模块层的默认上限（`HISTORY_LIMITS`，只读参考）：`maxTextChars 2000`、`maxMediaItems 8`、
`maxQueryChars 100`、`maxHits 50`、`maxScanBytes 64MB`、`maxScanLines 200000`、`timeLimitMs 2000`、
`snippetPad 40`、`tsFloorMs 946684800000`、`pruneEvery 500`、`dedupeTailBytes 16KB`。

## 五、去重与保留

- **去重按 `messageId`，且只对能解析成有限数字（且 ≠ 0）的 id 生效**（真实 QQ 消息 id 就是数字）：
  append 前扫文件尾部窗口（默认最后 64 条 / 16 KB），命中同 `messageId` + 同方向的记录就跳过写入。
  没有 messageId 的消息**无法去重**（会照实记）。这就是"唤醒重放/补投不会把同一条群消息写两遍"的机制。
- **保留策略挂在 60 秒 ticker 上低频执行**（约每 30 分钟一次）：
  `prune({ key, beforeMs, maxBytes })` 用 `retentionDays` / `maxBytes` 删最老的行，然后原子重写文件。
- `prune` **必须显式给 key**（模块对空 key 会抛 `history-archive: key 不能为空`），所以桥接是遍历
  当前已知会话逐个 prune；`append` 自己也会按 `pruneEvery` 顺带触发一次保留检查。
- 文件名是"会话 key 的 Windows 安全化 + 12 位 sha1 后缀"：`group:1` 与 `private:1` 不会撞到一起；
  路径越界（`..`）在模块层直接抛错。

## 六、做不了 / 没做

- **没有写入端点**：归档只由桥接自己的挂点写，HTTP 侧**只有检索**（没有 `POST /history/append`），
  这样 AI 无法伪造历史。
- **没有语义检索 / 向量库 / 摘要**：只有关键词 AND 子串匹配；"上一次是谁提过这件事"能查，
  "意思相近怎么说"查不了。
- **只存文字**：图片、语音、表情、转发内容都只留一条描述（转发里的文字若已在入站文本里就照常存）。
- **不是"完整对话导出"**：片段窗口 40 字，长消息会被截到 2000 字，超预算的扫描会被 `truncated` 标记。
- **没有控制台检索面板**：操作者入口是 HTTP 接口（见下）。

## 七、操作者通道

```bash
# 检索某个会话（TOKEN 见 config.json 的 consoleToken）；操作者可以查任意 key
node -e "fetch('http://127.0.0.1:3100/api/socialV2/history/search',{method:'POST',headers:{'content-type':'application/json','x-console-token':process.env.TOKEN},body:JSON.stringify({key:'group:123456',query:'吃药 明天',limit:10})}).then(r=>r.json()).then(d=>console.log(d.scanned,d.truncated,d.hits))"

# 统计（记录数 / 字节数等）
node -e "fetch('http://127.0.0.1:3100/api/socialV2/history/stats?key=group%3A123456',{headers:{'x-console-token':process.env.TOKEN}}).then(r=>r.json()).then(console.log)"
```

请求体：`{ key, query, sinceMs?, untilMs?, limit? }`（`sinceMs`/`untilMs` 是毫秒，可传数字字符串）。
⚠️ 会话令牌只走 `x-agent-token` 头：`?token=` 在外层是**控制台令牌**，塞会话令牌进查询串会被 401。

## 八、测试

```bash
node scripts/test-history-archive.mjs   # 纯模块层：归档/检索/去重/prune/坏行自愈
node scripts/test-history-http.mjs      # 端到端：真实 bridge.js + 假网关 + 控制台端口，不发真实 QQ 消息
```

`test-history-http.mjs` 覆盖：入站挂点归档后能搜到（片段含发送者）、出站文本归档且只记一处、
多词 AND、`messageId` 去重、`sinceMs`/`untilMs` 过滤、按 key 隔离、JSONL 落在临时目录，
以及空/超长 `query`、`limit` 上下限、非法 `sinceMs`、坏 JSON → 400、非法 key，
AI 只能查自己的 key（别的 key → 403）、不带令牌 → 403、匿名 → 401、
`tools.searchHistory=false` 与 `history.enabled=false` 的 403、`stats` 可用。
