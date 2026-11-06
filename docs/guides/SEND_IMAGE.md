# 发图全解（SEND_IMAGE）

> 两个入口，共用同一套规则（`src/send-image-lib.js` 的路径闸门 + `src/safe-fetch.js` 的抓取校验）：
> **AI 工具** `qq_send_image`（→ `POST /api/socialV2/send-image`，带 `key` + 会话令牌）与
> **操作者通道** `POST /api/media/send-image`（控制台 / CLI，凭 `x-console-token`）。
>
> ⚠️ 出厂默认**关**：`socialV2.tools.sendImage=false`。原因见第二节。

---

## 一、图片来源只有两类

| 来源 | 参数 | 规则 |
| --- | --- | --- |
| **图片库** `media/images/` | `file` | 相对名，可带子目录、可省略扩展名。绝对路径也必须在库内；`..`、symlink 逃逸一律拒绝 |
| **公网图片** | `url` | 桥接**自己**用 `src/safe-fetch.js` 抓（DNS 固定、逐跳校验、字节上限），内网/本机地址拒绝，且必须是真的 PNG/JPEG/GIF/WebP |

库内文件直接以**绝对路径**交给 OneBot（零拷贝）；URL 来源在桥接里抓成字节后以 `base64://` **内联**发送
——**绝不把 URL 交给 SnowLuma 去抓**，否则等于把网关变成 SSRF 出口，也绕过了本地的体积/格式校验。

图片与说明文字放在**同一条消息**里（`text` 段在 `image` 段之前）。这一点与表情不同：表情消息只能是
一张表情（见 `sendStickerV2`）。

表情发送走的是 **`image` 段 + `sub_type: 1`**（落在 QQ `PicElement` 的 `bizType`/`subType` 上），
不是普通图片：不带这个标记，QQ 会把 1224×1224 的收藏表情当成一张大照片铺开（2026-10-29 的
"表情包怎么这么大"就是这个原因）；带上之后客户端按表情尺寸渲染，和手点收藏表情发出去的一样。

## 二、为什么默认关闭

1. **撤不回**：QQ 图片发出去没有"撤回"接口，发错就是把私人图公开给群里。
2. **库内常是私人素材**：图片库通常放本机截图/照片，与语音库是同一性质的东西。
3. **群聊内容不可信**：prompt injection 可以让模型把"发这张图"当成用户指令。默认不给这个动作面，
   等于默认没有这条外发通道；要开由操作者显式打开（和 `sendVoice` / `setStickerRemark` 同口径）。

`socialV2.media.enabled` 是**总闸**（默认 `true`）：关掉后连操作者通道也不可用，适合"彻底禁用发图"。
它只影响图片；`tools.sendImage` 只影响 AI 工具。

## 三、硬边界（代码里拦掉的，不是建议）

| 情况 | 结果 |
| --- | --- |
| 库外绝对路径 / `..` / symlink 指向库外 | ❌ 400 `图片只能从图片库取文件` |
| `file` 传 `base64://` / `data:` / `file://` / `http(s)://` | ❌ 400（公网图必须走 `url`） |
| 改名成 `.png` 的文本 | ❌ 400 `不是有效图片` |
| > `maxSendBytes`（默认 5 MB） | ❌ 400 `超过大小上限` |
| 像素总数 > 6400 万（图片炸弹） | ❌ 400 `像素过大` |
| 内网/本机/云元数据 URL | ❌ 400 `禁止访问内网/本机地址` |
| 公网取回的是 HTML | ❌ 400 `不是有效图片` |
| `file` 与 `url` 同时给 / 都不给 | ❌ 400 |
| `text` 超过 `socialV2.send.maxMessageChars`（默认 500，本项目现设 2000） | ❌ 400 `附图说明过长` |
| 目标不在白名单 / 非 reserved2 模式 / 工具未启用 | ❌ 403 |
| 超过频率上限 | ❌ 429 `发图频率超限` |

发图会走与文本、语音同一套**外发审计**（`assertOutboundAuditOk`）：`text` 与文件名/URL 都过一遍
`SENSITIVE_RE`，命中就拒（URL 只取 `origin+pathname`，避免图床链接里的签名参数被误判）。
每次成功发送写 `appendActivity` + `log`，并通过 `recordSelfMessageV2` 落进会话记录（AI 下一轮
才知道自己发过这张图）。

## 四、配置项

```json
"socialV2": {
  "tools": { "sendImage": false },
  "media": {
    "enabled": true,
    "dir": "media/images",
    "maxSendBytes": 5242880,
    "maxPerMinute": 2,
    "maxPerHour": 10
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tools.sendImage` | `false` | AI 工具 `qq_send_image` 的开关（控制台勾选写这里） |
| `media.enabled` | `true` | 总闸；`false` 时 AI 通道与操作者通道都拒 |
| `media.dir` | `media/images` | 图片库目录，相对仓库根 |
| `media.maxSendBytes` | `5242880`（5 MB） | 单张上限；硬上限 20 MB（超过会被钳到硬上限） |
| `media.maxPerMinute` / `maxPerHour` | `2` / `10` | **复用语音的限流口径**：独立时间戳桶，只检查、真正发出去后才记账 |

限流"只检查、发出后才 commit"：参数错、被审计拦、网关失败都不会白吃配额（否则失败几次就被假 429 卡死）。

## 五、dryRun：只校验不发送

两个入口都支持 `dryRun: true`，返回 `{ok, dryRun, file, via, bytes, format, width, height, detail, text, limits}`：

- 走完**全部**校验（解析、格式、体积、像素、审计、限流），唯独不调网关；
- AI 通道回报的是**库内相对名 / 原始 URL**，**绝不回报绝对路径**——这条 JSON 会进模型上下文，
  而模型面对的是不可信的群聊内容；操作者通道才回报绝对路径（调试需要）。

## 六、做不了 / 没做

- **QQ 群文件发送做不了**：SnowLuma 只实现 `send_group_msg` / `send_private_msg` / `send_msg` 等，
  **没有** `upload_group_file` / `upload_private_file` / `get_group_file_url`（源码里 0 命中）。
  所以"发文件"这件事只能绕道——图片走消息段的 `image`，不受文件上传限制。
- **没有 `qq_list_images` 工具**：多一个工具就要多付一份常驻的 schema token。解析失败时的报错里
  直接附带库内清单，模型照抄即可自我纠正。
- **没有控制台发图面板**：操作者入口是 HTTP 接口 `/api/media/send-image`（见下），界面面板未做。

## 七、操作者通道

```bash
# 只校验（dryRun），不发真实消息；TOKEN 见 config.json 的 consoleToken
node -e "fetch('http://127.0.0.1:3100/api/media/send-image',{method:'POST',headers:{'content-type':'application/json','x-console-token':process.env.TOKEN},body:JSON.stringify({target:'group:123456',file:'猫.png',dryRun:true})}).then(r=>r.json()).then(console.log)"
```

- 请求体：`{ target, file | url, text?, dryRun? }`（`key` 也接受）。
- **边界（有意放宽）**：`/api/media/send-image` **允许库外文件**——操作者本来就能读本机文件，
  与 `/api/voice/send` 同口径；体积/格式/像素校验、外发审计、限流一个都不少。
- 它**不**受 `tools.sendImage` / `media.enabled` 之外的 AI 闸门影响；**带 `x-agent-token` 的请求到不了
  这里**（`/api/media/` 不在 agent 路径白名单里，会在更外层被 403），所以 AI 借不到这条例外。

## 八、测试

```bash
node scripts/test-send-image.mjs      # 离线：真实 bridge.js + 假网关，不发任何真实 QQ 消息
```

覆盖：库外路径/`..`/symlink 逃逸、内网与坏 URL、非图片内容、超限、像素炸弹、开关关闭、
非 reserved2 模式、白名单外目标、限流 429、dryRun 不发送、正常路径真的发出 `image` 段
（库内文件用绝对路径、URL 来源用 `base64://`）、操作者通道的库外例外。
