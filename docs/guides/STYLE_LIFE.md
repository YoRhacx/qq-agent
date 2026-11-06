# 表达层三件：真人语感 / 自我语感 / 生活层

> 一句话：**让她说话像这群人、知道自己最近是什么手感、生活里有东西可讲。**
> 代码：[src/style-guard.js](../../src/style-guard.js)、[src/self-style.js](../../src/self-style.js)、[src/life-loop.js](../../src/life-loop.js)——三个文件都是零 import 的纯函数 + 一个 `createXxx` 外壳（只有外壳碰磁盘）。
> 状态：`state/style-guard.json`、`state/self-style.json`、`state/life.json`（路径可被配置覆盖）。

## 一、为什么需要它

三件解决的是三个不同的问题，别混在一起看。

1. **真人语感**：模型默认写完整句、句尾带句号、张口就是「您好 / 很高兴为您服务 / 希望对你有帮助」。
   人格卡告诉它「我是谁」，语感块告诉它「这里的人怎么说话」——中位句长 6~12 字、七成不带句号、
   常用语气词、常常一口气发两三条。两个信息一起给，模仿才像。
2. **自我语感**：人格是设定，说久了会漂。今天格外凶、这两天突然客气、emoji 密度翻倍，
   她自己感觉不到。用她最近 200 条发言算一份「手感」，拼一句进提示词；参数突变就记一条 drift。
3. **生活层**：主动开口总得有事可说，否则只剩「在吗 / 吃了没」。生活笔记记「今天看了什么、读了什么、
   心情如何」，开口前按心情挑一个兴趣：心情差偏向安慰型（听歌/看番/散步），心情好偏向烧脑/创作。

## 二、三件各管什么

| 文件 | 回答的问题 | 主入口 | 状态文件 |
| --- | --- | --- | --- |
| `src/style-guard.js` | 这群人怎么说话？我这句话能不能照原样发出去？ | `createStyleGuard()` → `observe / buildStyleBlock / checkOutgoing / stats / snapshot` | `state/style-guard.json` |
| `src/self-style.js` | 我自己最近是什么手感？有没有突变？ | `createSelfStyle()` → `observe / buildSelfStyleBlock / profile / driftLog / snapshot` | `state/self-style.json` |
| `src/life-loop.js` | 我最近在干嘛？现在适合聊什么？ | `createLifeLoop()` → `addNote / todayNotes / pickInterest / summarizeDay / importJsonl` | `state/life.json` |

三个模块互相不 import，也不 import bridge.js；谁要用谁 `create` 一个实例。每个开关都独立，
**关掉 = 不读盘、不写盘、不建文件、提示词里一个字符都不占**（不是「建了文件但不读」）。

## 三、语感怎么统计（口径）

采样入参：`observe({ text, from, at })`，滚动保留最近 `sampleSize`（默认 300）条。只统计「真的在说话」的消息：

- 剥掉 `[管理员的朋友 12345]` 这类引用前缀——前缀混进句长会把中位数整体拉长两三字；
- 太短（<2 字）、太长（>400 字）、纯 `[图片]` / `[表情]` 占位、纯链接都不算（贴链接不是说话）；
- 长度按字符算（`Array.from`），一个 emoji 算 1 字。

| 指标 | 口径 | 用途 |
| --- | --- | --- |
| `medianLen` | 中位句长（字符数） | 注入块的第一句：「中位句长 12 字」 |
| `shortRatio` | ≤5 字的条数占比 | 「四成不到 5 字」 |
| `noPunctRatio` | 句尾没有 `。！？!?…` 的占比 | 「七成不带句号」 |
| `particles` | 单字语气词（吧哦呢嘛呀啊哈啦呗咯诶唉嘿嗯噢喔）按**出现条数**排序取 top N（默认 5） | 「常用语气词 吧/哦/呢」 |
| `emojiRatio` / `qqFaceRatio` / `kaomojiRatio` | emoji（1F300–1FAFF、2600–27BF）/ QQ 方括号表情 / 颜文字（qwq、^_^、(笑)） | 「想带表情就带」那一行 |
| `burst` | 同一 `from` 在 `burstGapMs`（60s）内的连续消息算一组：`{ groups, avg, singleRatio, max }` | 「真人常一口气发 2 条」 |
| `examples` | 最近 6~40 字、去重、跳过链接/引用/卡片，最多 `exampleCount` 条 | 给模型学节奏，不是照抄 |

样本少于 `minSamples`（默认 20）**不注入**：样本太少的中位数没有说服力，只会污染提示词。

## 四、注入块（marker + 示例 + 开关）

`buildStyleBlock()` 返回下面这一块（这是用 26 条样例真跑出来的，不是手写示意）：

```markdown
<!-- STYLE:BEGIN -->
【这群人怎么说话】
像这群人一样说话：中位句长 6 字、几乎全部不带句号（100%）、四成不到 5 字；常用语气词 哈/吧/呢/啊/呗。
几句真人原话（学节奏，不要照抄）：
- 热和电费你选一个
- 电费也是一笔
- 我这也有一台 用过两次
- 那你别开窗了
<!-- STYLE:END -->
```

几条约定：

- **marker 必须成对**：`<!-- STYLE:BEGIN -->` / `<!-- STYLE:END -->`。重复注入前先 `stripStyleBlock(text)` 把旧块剥掉，否则提示词里会堆好几份。
- 表情那一行只在 `emojiRatio + qqFaceRatio >= 8%` 时出现；分条那一行要求 `groups >= 3` 且 `avg >= 1.4`——都不满足就整行不写，宁缺不编。
- 预算 `maxBlockChars`（默认 600）：超了先丢例子，再截断正文，marker 一定保住（缺一个就会污染后续注入）。
- 开关：`injectStyle`（总开关）、`styleInGroup`（打开时**只在群聊**注入，私聊返回空串）、`minSamples`、`exampleCount`（0 = 不带例子）。

## 五、发出去之前洗一遍（`checkOutgoing`）

返回 `{ text, changes: [{ type, before, after }], blocked: false }`。`text` 才是该发出去的文本；
`changes` 是审计记录（写日志用，**不要发到群里**）。

| `type` | 做什么 | 例子 |
| --- | --- | --- |
| `greeting` | 开头的「您好，」「亲，」砍掉（后面还有内容才砍） | `您好，在吗` → `在吗` |
| `tail` | 结尾客套整段砍 | `外面下雨了，记得带伞，有事叫我。` → `外面下雨了，记得带伞` |
| `banned` | 整句客服腔**删掉**（不替换——替换出来的还是客服话） | `明天多云。需要我帮你带伞吗？` → `明天多云` |
| `split` | 单行超过 `maxParagraphChars`（100）时按句末切成多行，只加换行 | 134 字一段 → 5 行 |
| `punct` | 连续重复标点压成一个 | `真的吗？？？？` → `真的吗？` |
| `bracket` | 空括号 `（ ）`、句尾孤立的右括号；**配对完好的 `（笑）` 一个字都不动** | `好呀（笑）)` → `好呀（笑）` |
| `period` | ≤ `shortLineMax`（30）字的行去掉句尾句号（微信式） | `好的。` → `好的` |
| `space` | 空白整理（行尾空格、连续空行） | |
| `fallback` | 一个字都不剩（或只剩标点）时说 `fallbackText`（默认「嗯」） | `您好，很高兴为您服务！希望对你有帮助！！` → `嗯` |

一条三类全命中的真实前后对比：

```text
IN : 您好，很高兴为您服务！明天多云，记得带伞。希望对你有帮助！！
OUT: 明天多云，记得带伞        （changes: greeting → banned → period）
```

长段落拆分（134 字无换行 → 5 行，`changes: split, period`）：

```text
我刚看了一下这个问题主要是网络波动引起的，不是账号的问题
你先试试重启一下路由器，一般这样就好了
不过要是还不行的话，可以看看是不是网线松了，或者换个口插一下。
再不行就得叫师傅上门看线路了，这个我确实没法帮你远程处理
你可以先这样试一下，明天要是还有问题再跟我说一声
```

五条边界：

1. **只删不改**：删客套、删整句客服腔、加换行、压标点。不替换成别的句子，不润色，不改意思。
2. **带代码块整条跳过**（三个反引号）：里面是给人复制的命令，动了就是事故；此时 `changes: []`、`skipped: codeblock`。
3. **`blocked` 恒为 `false`**：自曝（「我是 AI」「作为一个 AI」）归 `identity-guard`，这里既不拦也不删。
4. **删光只剩标点时兜底**：不会把一串「！」发出去，也不会硬留一段没有实词的残句。
5. **怎么关掉清洗**：`styleGuard.cleanOutgoing: false`（只关清洗，注入照旧），或 `styleGuard.enabled: false`（整块关）。
   关掉时原样返回并带 `skipped: disabled`，一个字符都不动。

## 六、自我语感（`self-style`）

每 `windowEvery`（20）条自己的发言重算一次参数，滚动窗口 `sampleSize`（200）条；
代码/技术消息不进统计（那不是「说话」）。参数：`medianLen / avgLen / minLen / maxLen / shortRatio / noPunctRatio /
emojiDensity / kaomojiDensity / tsundereRatio / questionRatio / exclaimRatio / tails / topTail`。

傲娇句式占比只看命中，不评判好坏：`哼`、`才不`、`谁要`、`讨厌`、`笨蛋`、`不是啦`、`别误会`、`你少管`、`……`。

注入就一句（`buildSelfStyleBlock`，marker `<!-- SELF-STYLE:BEGIN -->`）：

```markdown
<!-- SELF-STYLE:BEGIN -->
我最近说话偏短（中位 4 字），爱用「你」收尾，基本不带表情，傲娇句式占 20%，多数不带句号。
<!-- SELF-STYLE:END -->
```

**drift**：每次滚窗口跟上一份 profile 比 7 个指标（句长、短句比、无标点比、emoji/颜文字密度、傲娇占比等），
相对变化超过 `threshold`（0.3，即 30%）记一条 `{ at, metric, from, to, ratio }`。
比例类指标额外要求绝对变化 ≥ `minAbsolute`（0.05），否则 0.02 → 0.04 这种「翻倍」噪声会把日志刷满；
样本不足 `minSamples`（30）不判 drift。记录最多留 `maxEntries`（50）条。

这条记录是**给自己看**的，不是「纠正她」：知道手感变了（比如这两天变客气了），人可以自己决定要不要调人格卡。

## 七、生活层（`life-loop`）

`state/life.json` 的形状：

```json
{
  "version": 1,
  "notes": [
    {
      "id": "n_1ab2cd",
      "date": "2026-10-28",
      "kind": "watch",
      "title": "孤独美食家 第三季",
      "text": "一集一集地看，馋了",
      "interest": "看番",
      "weight": 0.8,
      "createdAt": 1793201279920
    }
  ],
  "updatedAt": 1793201279920
}
```

- `kind` 四类：`watch` / `read` / `game` / `mood`。中英别名归一到这四类（视频、番、看 → watch；书、读 → read；游戏 → game）。
- `addNote({ kind, title, text, interest, weight, date, ts })`：`title` / `text` 至少给一个；`interest` 可以是兴趣名，
  也可以直接给 0~1 的数字（数字按兴趣权重算）；没给权重就用 `weightDefault`（0.5）。
- `id` 由 `date|kind|title|text` 哈希而来（FNV-1a 36 进制），**同样的内容永远同一个 id**，所以反复导入不会长影子记录；
  同一份状态里撞了 id 会补 `-2` 后缀。
- 读：`todayNotes(date?)`（默认今天，新的在前）、`list({ date, kind, interest, limit })`、`summarizeDay(date)`。
- 删：`removeNote(id)`。

`summarizeDay` 返回 `{ date, n, byKind, interests, titles, text, notes }`，其中 `text` 是一句人话：
`2026-10-28 记了 2 件事：看了《孤独美食家 第三季》；读了《随笔集》。`

### 按心情挑兴趣：`pickInterest({ mood })`

心情先归一成分数：数字直接 clamp 到 -1..1；字符串按词表（难过/累/emo/生气/委屈 → -0.6，开心/兴奋/感动/好耶 → 0.6）；
对象认 `valence` / `mood` / `score`。然后分三路：

| 心情分 | 偏向 | 兴趣池 |
| --- | --- | --- |
| ≤ -0.2 | 安慰型（`comfort`） | `comfortInterests`：听歌 / 看番 / 散步 / 发呆 / 吃点甜的 |
| ≥ 0.2 | 烧脑/创作（`focus`） | `focusInterests`：推理 / 烧脑 / 写点东西 / 学点新东西 / 折腾代码 / 创作 |
| 中间 | 按历史兴趣权重 | 自己记过的 `interest` 按累计 `weight` 加权抽 |

返回 `{ interest, kind, mood, reason, source? }`：`source` 指向这条兴趣是从哪条笔记来的；
自己记过的兴趣优先（+0.5 权重），一个都没记过时才落回默认清单，`reason` 里写清楚是哪条路：
`心情一般，偏安慰型` / `心情不错，偏烧脑/创作` / `心情不错，暂时没记过，按默认清单`。

### 从外部 jsonl 导入

两种格式混着也能吃，`importJsonl(text | rows | { path })`：

```jsonl
{"ts":1793201279920,"note":"晚上刷的","items":[{"desc":"猫和老鼠 第 1 集"},{"desc":"孤独美食家 第 3 季"}]}
{"ts":1793201280000,"kind":"read","keep":"long","text":"今天翻了两页书"}
```

- 第一种（`watched.jsonl`）：`items` 里每个 `desc` 出一条 `watch` 笔记，`title = desc`，`text = note`；
- 第二种（`notes.jsonl`）：一行一条，字段容错——`title/name/desc/headline`、`text/content/note/summary/body`、`ts/time/at/date/timestamp` 都认；
- `items` 可以是对象数组，也可以是字符串数组；本模块自己导出的笔记数组也能再导回来。
- 返回 `{ added, skipped, duplicated, rows, formats: { watched, notes, unknown } }`。同一份文件导两次：
  第二次 `added: 0, duplicated: N`——幂等，不会把生活刷成一堆重复记录。

## 八、配置与状态文件

`config.json` 里建议三个块（名称可自己定，构造时把块原样传进去即可；配置也认参考包的 snake_case 键名）：

**`styleGuard`**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总闸。关掉：不读盘、不写盘、不建文件、不注入、不清洗 |
| `collect` | `true` | 只采样不注入时用它（关掉采样就不写盘） |
| `sampleSize` | `300` | 滚动采样窗口 |
| `minSamples` | `20` | 少于这个数不注入 |
| `injectStyle` | `true` | 拼提示词时注入语感块 |
| `styleInGroup` | `true` | 打开时只在群聊注入 |
| `cleanOutgoing` | `true` | 出站清洗 |
| `particleTopN` | `5` | 语气词取前几个 |
| `exampleCount` | `4` | 例子条数（0 = 不带例子） |
| `maxBlockChars` | `600` | 注入块字数上限 |
| `maxParagraphChars` | `100` | 单行超过这个长度才拆 |
| `lineChars` | `40` | 拆完每行的目标长度 |
| `shortLineMax` | `30` | 短句去句号的阈值（0 = 不删） |
| `burstGapMs` | `60000` | 同一人多长时间内的连续消息算一组 |
| `fallbackText` | `嗯` | 删光了说什么 |
| `stateFile` | `""` | 空 = `state/style-guard.json` |

**`selfStyle`**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` / `collect` / `inject` | `true` | 总闸 / 采样 / 注入 |
| `sampleSize` | `200` | 自画像滚动窗口 |
| `minSamples` | `30` | 少于这个数不注入、不判 drift |
| `windowEvery` | `20` | 每 N 条自己的发言重算一次（0 = 不自动重算） |
| `tailTopN` | `5` | 尾词取前几个 |
| `maxInjectChars` | `160` | 注入那句的长度上限 |
| `drift.enabled` | `true` | 是否记 drift |
| `drift.threshold` | `0.3` | 相对变化超过 30% 记一条 |
| `drift.minSamples` | `30` | 两侧样本都要够 |
| `drift.minAbsolute` | `0.05` | 比例类指标的绝对下限 |
| `drift.maxEntries` | `50` | 最多留几条 |
| `stateFile` | `""` | 空 = `state/self-style.json` |

**`lifeLoop`**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` / `collect` | `true` | 总闸 / 是否记账 |
| `maxNotes` | `500` | 最多留多少条（超了丢最旧的） |
| `weightDefault` | `0.5` | 没给权重时的默认兴趣权重 |
| `maxTextChars` | `400` | 单条正文上限 |
| `comfortInterests` | 听歌/看番/散步/发呆/吃点甜的 | 心情差时偏向 |
| `focusInterests` | 推理/烧脑/写点东西/学点新东西/折腾代码/创作 | 心情好时偏向 |
| `moodThreshold` | `0.2` | 心情分绝对值超过它才算「偏」 |
| `stateFile` | `""` | 空 = `state/life.json` |

状态文件路径：默认三个都在 `state/` 下，可用各块的 `stateFile`（也认 `state_file` / `file`）覆盖；
写盘都是原子写（`<file>.part-<pid>-<ts>` + rename），进程中断不会在状态文件里留下半截 JSON。
测试一律 `fs.mkdtemp()`，**绝不写真实 `state/`**。

## 九、接线（给主控）/ 测试 / 不做的事

本模块只提供库能力，**不改 bridge.js**。接线的完整清单：

1. import 三个 `createXxx`，从 `config.styleGuard` / `config.selfStyle` / `config.lifeLoop` 读配置；
2. 入站：群友消息 → `styleGuard.observe({ text, from, at })`；她自己的发言 → `selfStyle.observe(text)`；
3. 拼提示词：`stripStyleBlock` 后拼 `styleGuard.buildStyleBlock({ isGroup })`，再拼 `selfStyle.buildSelfStyleBlock()`；
4. 出站：发送前 `const r = styleGuard.checkOutgoing(text)`，发 `r.text`，`r.changes` 只写日志；
5. 生活：她说「看了/读了/玩了」时 `life.addNote(...)`；主动开口前 `life.pickInterest({ mood })` 拿话头；收工时 `life.summarizeDay()`；
6. 只读端点（建议）：`/api/style`、`/api/self-style`、`/api/life` 直接返回各自的 `snapshot()`；
7. 注册：`scripts/test-audit.mjs` 清单加一行；`scripts/audit-bridge-harness.mjs` 的 `vm.createContext` 注入三个模块（接线后必须，否则运行时 500）。

测试：

```sh
ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/test-style-life.mjs
```

17 段 108 条断言，全部在 `os.tmpdir()` 的临时目录里跑（不碰真实 `state/`、不联网、不发消息），覆盖：
统计口径 / 注入块 marker 与三个开关 / 清洗九类改写与跳过 / 自我统计与 drift 两条路 /
生活笔记增删与两路挑兴趣 / jsonl 两种格式与幂等 / 三个模块关掉时不建文件、坏 JSON 降级不抛。

明确不做的事：

- **不做自曝拦截**（`identity-guard` 的活），`blocked` 恒为 `false`；
- 不自己发消息、不自己调模型、不读 `roles/`；
- 不做「改写润色」：只删客套、只加换行、只压标点，不动内容；
- 不建 SQLite、不加依赖——三个状态文件都是小 JSON；
- 不自动回灌 QQ 历史：要导旧账请用 `importJsonl` 喂文件。
