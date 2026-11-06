# 音乐卡片全解（MUSIC）

> 两个入口，共用同一个段构造器（`src/music-card.js` 的 `buildMusicSegment()`）：
> **AI 工具** `qq_send_music`（→ `POST /api/socialV2/send-music`，带 `key` + 会话令牌）与
> **操作者通道** `POST /api/media/send-music`（控制台 / CLI，凭 `x-console-token`）。
>
> ⚠️ 出厂默认**关**：`socialV2.tools.sendMusic=false`。原因见第二节：
> 平台卡片会把点歌信息交给**第三方签名服务**。

---

## 一、这个能力干什么

发一条 QQ「音乐卡片」消息段（OneBot v11 的 `{type:'music', data:{…}}`）。两种卡片：

| 类型 | 参数 | 卡片长什么样 |
| --- | --- | --- |
| **平台卡** | `type` + `id` | 由 QQ 音乐/网易云等平台按歌曲 id 渲染，带封面、歌手、播放按钮。`type` 取 `qq`、`163`、`kugou`、`kuwo`、`migu`、`bilibili` |
| **自定义卡** | `type:'custom'` + `url` + `audio` + `title`（+ `image?`、`singer?`） | 用你自己给的封面/标题/音频直链拼一张卡，QQ 点开是外链播放 |

消息里可以再带一段说明文字（`text`，与卡片同一条消息，`text` 段在前）。这一点与发图/发表情一致。

## 二、为什么默认关闭（第三方签名）

这一节是这份文档最重要的部分。

**平台卡不是桥接自己渲染的。** SnowLuma 收到 `{type:'music', data:{type,id}}` 后，会把 `{type,id}`
再 POST 给它配置里的 `musicSignUrl`（**默认 `https://ss.xingzhige.com/music_card/card`**，
xingzhige 的第三方签名服务）换取 QQ 认得的卡片 JSON；签名失败才退化成普通 JSON 卡片。
也就是说：

> **发一张平台音乐卡片 = 把"这个群里有人在点这首歌"这条信息交给一个第三方域名。**

这不是桥接能替你决定的事，所以：

1. `socialV2.tools.sendMusic` 出厂 **`false`** —— 不给模型这个外发面（与 `sendImage` / `sendVoice`
   同口径：一旦发出去撤不回，而群聊内容不可信，prompt injection 可以让模型"替群友点歌"）。
2. 想**完全避免第三方**：用 `type:'custom'`，自己给 `url`+`audio`+`title`。自定义卡**不经**
   `musicSignUrl`，这也是唯一一条"零第三方"的路。
3. 桥接**绝不自己**去调 `musicSignUrl`：签名只发生在 SnowLuma 侧。要彻底关掉第三方，
   就改 SnowLuma 的配置（把 `musicSignUrl` 留空/改成自建服务），而不是改桥接。
4. 返回体里**显式**告诉调用方这件事：`thirdPartySign: true` 与 `warnings: ['third-party-sign']`。
   这条信息不能藏——模型据此才知道"我这一下把点歌信息发出去了"。
5. 配置里把平台卡钉死：`socialV2.music.allowThirdPartySign=false` 时，**平台卡一律 400**，
   错误信息直接建议改用自定义卡（配置项见第四节）。

## 三、端点与参数

### AI 通道

```
POST /api/socialV2/send-music
  content-type: application/json
  x-console-token: <控制台令牌>          # 最外层全局鉴权认这个
  x-agent-call: 1
  x-agent-token: <该 key 的会话令牌>
```

```json
{ "key": "group:123456", "token": "<会话令牌>",
  "type": "163", "id": "1234567", "text": "点一首老歌", "dryRun": true }
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✅ | `group:群号` / `private:QQ号`；格式错 → 400 |
| `token` | ✅ | 该 key 的会话令牌；也可以走 `x-agent-token` |
| `type` | ✅ | 平台名或 `custom`。**必填**：网关侧 `requireNonEmptyStringField(...,'type')` 直接拒空 |
| `id` | 平台卡 ✅ | 歌曲 id |
| `url` / `audio` / `title` | 自定义卡 ✅ | 必须**同时**给；`url` 是卡片跳转、`audio` 是音频直链 |
| `image` / `singer` | ❌ | 自定义卡的封面 / 歌手（歌手会被写进网关认的 `data.content`） |
| `text` | ❌ | 同一条消息里卡片之前的说明文字 |
| `dryRun` | ❌ | `true` 时走完全部校验但不发送 |

响应（成功）：

```json
{ "ok": true, "kind": "platform", "thirdPartySign": true,
  "warnings": ["third-party-sign"], "messageId": 9001 }
```

`dryRun:true` 时返回 `{ ok:true, dryRun:true, kind, thirdPartySign, warnings, … }` 且**不带** `messageId`。

### 操作者通道

```
POST /api/media/send-music
  x-console-token: <控制台令牌>

{ "target": "group:123456", "type": "163", "id": "1234567", "dryRun": true }
```

- 请求体：`{ target | key, type, … , text?, dryRun? }`。
- 操作者通道**不受 `tools.sendMusic` 限制**（那个开关只管 AI 工具）；白名单外目标仍然 403。
- **带 `x-agent-token` 的请求到不了这里**：`/api/media/` 不在 agent 路径白名单里，会在更外层被拒，
  所以 AI 借不到这条"操作者例外"。

## 四、配置项

```json
"socialV2": {
  "tools": { "sendMusic": false },
  "music": {
    "enabled": true,
    "allowThirdPartySign": true,
    "maxPerMinute": 2,
    "maxPerHour": 10
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tools.sendMusic` | **`false`** | AI 工具 `qq_send_music` 的开关（控制台勾选写这里） |
| `music.enabled` | `true` | 音乐能力总闸；`false` 时 AI 与操作者通道都拒 |
| `music.allowThirdPartySign` | `true` | 设 `false` 即**禁止平台卡**（因为平台卡必经 `musicSignUrl`）；自定义卡不受影响 |
| `music.maxPerMinute` / `maxPerHour` | `2` / `10` | 复用语音/发图的限流口径：独立时间戳桶，**只检查、真正发出后才记账** |

「只检查、发出后才 commit」的意思是：参数错、被审计拦、网关失败都不会白吃配额
（否则失败几次就被假 429 卡死）。

SnowLuma 侧还有一个与隐私直接相关的键（**不在本仓库的 config.json 里**）：
`musicSignUrl`，默认 `https://ss.xingzhige.com/music_card/card`。想换自建签名服务或禁用它，
要去改 SnowLuma 的配置。

## 五、dryRun：只校验不发送

两个入口都支持 `dryRun: true`：

- 走完**全部**校验（类型判定、必填字段、http(s) scheme、各字段长度、第三方签名策略、限流、
  外发审计），唯独不调网关；
- 因此"这张卡会被 QQ 拒绝吗""这会经第三方吗""现在会被限流吗"都能在**发出去之前**问清楚；
- 测试与联调请一律先 `dryRun`。

## 六、硬边界（代码里拦掉的，不是建议）

| 情况 | 结果 |
| --- | --- |
| 缺 `type` | ❌ 400 `music 段缺少 type` |
| 平台卡缺 `id` | ❌ 400 `平台音乐卡片必须给 id` |
| 自定义卡缺 `url` / `audio` / `title` 中任意一个 | ❌ 400 `自定义音乐卡片必须同时给 url（卡片跳转）、audio（音频直链）和 title` |
| `url` / `audio` / `image` 不是 `http(s)://` | ❌ 400 `… 必须是 http(s) 链接`（`data:`、`base64://`、`file://`、`ftp://` 全拒） |
| `title` > 60 字 / `id` > 32 字 / `type` > 16 字 | ❌ 400 `… 太长` |
| 未知平台且没给 `id` | ❌ 400 `不认识的点歌平台：…（可用：…）` |
| 平台卡但 `music.allowThirdPartySign=false` | ❌ 400（提示改用 `type:'custom'`） |
| 目标不在白名单 / 非 reserved2 模式 | ❌ 403 |
| `tools.sendMusic=false` 时的 AI 调用 | ❌ 403 `工具未启用：qq_send_music` |
| 超过频率上限 | ❌ 429 `音乐发送频率超限` |

另外：平台卡给了 `title`/`url`/`singer`/`image` 这类用不上的字段时不报错，但会回一条
`platform-card-ignores-extra-fields` 告警（免得你以为标题没生效是 bug）；自定义卡没给歌手会回
`no-singer`。发送成功会写活动流 + 会话记录（AI 下一轮才知道自己发过这张卡）。

## 七、做不了 / 没做

- **不能"搜索点歌"**：桥接不做音乐搜索，平台卡必须由调用方给出 `id`。想要"点《起风了》"，
  得先自己拿到 id（或改用自定义卡给直链）。
- **不能真正内联播放自有音频**：`audio` 只是卡片里的外链，QQ 侧播放时是去那个域名取的；
  桥接不代理、不缓存、不转码音频（所以 `audio` 必须是一个公网可访问的直链）。
- **没有语音库/图片库那样的本地文件来源**：音乐卡片不接受本地路径（会经网关暴露本机路径）。
- **没有控制台点歌面板**：操作者入口是 HTTP 接口（见第三节），界面面板未做。

## 八、常见错误与测试

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `HTTP 401 未授权：请提供控制台访问令牌` | 没带 `x-console-token` | 每个请求都带控制台令牌 |
| `HTTP 403 agent token 无效` | `token` 不是这个 `key` 的会话令牌 | 用该 key 自己那份令牌 |
| `HTTP 403 工具未启用：qq_send_music` | `tools.sendMusic=false`（出厂默认） | 控制台 → 二代设置 → 工具勾选打开 |
| 卡片发出去没有封面/播放按钮 | 平台卡签名失败（`musicSignUrl` 不可用）→ 退化成普通 JSON 卡片 | 换自定义卡，或自建签名服务 |
| 自定义卡点开是空白页 | `url` 给的是音频直链而不是"歌曲页面" | `url` 给页面、`audio` 给音频直链 |
| 收到 `warnings: ['third-party-sign']` | 正常提示：这条卡经了第三方签名服务 | 在意隐私就改用 `type:'custom'` |

```bash
node scripts/test-music-card-http.mjs    # 离线：真实 bridge.js + 假网关，不发任何真实 QQ 消息
```

覆盖：纯函数（平台/自定义卡判定、6 个平台、13 组非法参数、`third-party-sign` 标记、
`allowThirdPartySign:false` 拒绝平台卡、长度边界）、AI 通道 dryRun 与正常路径（断言交给网关的段
是 `{type:'music',data:{type,id}}`、且桥接自己没去碰 `ss.xingzhige.com`）、参数非法 400、
跨会话越权 403、缺凭据 401、操作者通道、`tools.sendMusic=false` 只拦 AI、限流 429 按会话独立计数。

相关文件：`src/music-card.js`（段构造与校验）、`src/bridge.js`（两个端点 + 限流 + `v2ToolEnabled`）、
`src/mcp-snowluma-safe.js`（`qq_send_music` 工具注册）。
