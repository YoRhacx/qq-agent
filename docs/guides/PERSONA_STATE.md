# 人格状态：情绪、好感、识海与旧账

> 角色卡（`roles/小鲸鱼.md`）回答「她是谁」，本模块回答「她现在是什么心情、跟这个人多熟、答应过什么、还记不记得哪件事」。
> **角色卡只读**：这里不往人格文件里写一个字，所有增强都是一段可裁剪的注入块。
> 实现：`src/persona-state.js`；测试：`scripts/test-persona-state.mjs`。

## 一、为什么单独做一层

人格卡是设定，应该是稳定的；情绪和关系是运行态，会一直变，还会因为一句「永远记住」长出新的长期记忆。把两者混在一张卡里，改一次情绪就要重写人格文件，迟早把主人的卡弄坏。

所以这层只做三件事：

1. **记录**：每条入站消息更新 PAD 情绪、好感、识海、旧账；
2. **遗忘**：标签 45 分钟半衰、心情 6 小时回基线、久不联系好感缓慢回落；
3. **注入**：唤醒前拼一小块 `<!-- PS:BEGIN persona -->…<!-- PS:END persona -->`，让模型「带着状态说话」。

状态存在 `state/persona-state.json`，跟人格文件完全分离；关掉开关就什么都不写、不注入。

## 二、机制

### 2.1 PAD 三维情绪

- 三个轴都在 `-1..1`：`pleasure`（快不快）、`arousal`（激不激动）、`dominance`（有没有底气）。
- 默认基线照参考包：`{ pleasure: 0.05, arousal: 0.35, dominance: 0.5 }`，可配 `baseline`。
- 一条消息最多命中 **两个** 情绪标签；每个轴的总冲击再封一次顶，**单条单轴 ≤ `maxStep`（默认 0.12）**。
- 标签强度封顶 `labelCap`（默认 0.6）。

### 2.2 十个标签与半衰期

标签固定为参考包那十个，顺序也就是注入/前端展示顺序：

| 标签 | 典型触发（关键词规则，非模型判断） |
| --- | --- |
| 开心 | 哈哈、笑死、好笑、可爱、喜欢、好棒、厉害、开心 |
| 生气 | 滚、闭嘴、蠢、笨、烦死、骗子、敷衍、讨厌 |
| 难过 | 难过、伤心、哭、失落、走了、再见 |
| 害怕 | 吓、怕、危险、恐怖、报警 |
| 委屈 | 不理、冷落、冤枉、嫌、不公 |
| 害羞 | 脸红、害羞、别说了、讨厌啦 |
| 得意 | 我厉害、赢了、夸我、聪明 |
| 感动 | 谢谢、心疼、抱抱、陪我、记得 |
| 焦虑 | 来不及、怎么办、担心、怕错过 |
| 无聊 | 无聊、没意思、好闲 |

- **标签半衰期 45 分钟**（`labelHalfLifeMin`）：45 分钟后剩一半，90 分钟后剩四分之一，低于 0.02 直接消失。
- **PAD 半衰期 6 小时**（`moodHalfLifeHours`）：不是直接归零，而是按指数回基线；6 小时后离基线的距离减半。
- 衰减是**惰性计算**的：`snapshot()`/`buildPersonaBlock()` 会按当前时间投影，`tick()` 负责把结果落盘。所以桥接就算十分钟没跑定时器，读到的也是衰减后的值。

### 2.3 被哄 / 被夸：正向只按 0.08

一句「对不起，别生气了」「谢谢你」「你好棒」算**被哄**，走单独分支：

- 所有负标签各降 0.08；
- `感动` 标签 +0.08（也受 `soothePositive` 限制，不会出现 0.12 的正向跳变）；
- PAD：`pleasure +0.08`（到顶时只加剩下的余量）、`arousal -0.02`、`dominance +0.02`。

判定要有「冲着她来」的迹象：句中有道歉词，或出现「谢谢/乖/宝贝/辛苦/爱你/想你/喜欢你」这类只能对人说的词，或句中有「你」+ 夸奖词。**单纯一句「哈哈哈哈好可爱」不算被哄**，走普通开心——否则开心/得意标签永远点不起来。这条在 `isSoothe()` 里，测试里有反例。

### 2.4 好感 affinity

- 按 **QQ 号**记，首次互动从 `affinityBase=30` 起；输出夹到 `0..100`。
- 每条有效消息：
  - 普通 +0.35；
  - 夸奖/感谢 +1.2；
  - 辱骂 -3.5。
- **每日正向收益封顶 +6**（`affinityDailyGainCap`）：一天里再怎么夸也只涨 6 分；负向不封顶。
- **久不联系回落**：最后互动 7 天（`affinityIdleGraceDays`）之后，每天 -1（`affinityIdleDecayPerDay`）；在 `snapshot()` 里是投影值，`tick()`/下次互动时结算。
- **floors**：`{ "QQ号": 60 }` 给某些人设下限，任何回落/扣分都压不破。
- `adjustAffinity({userId, delta})` 给控制台/主控手动调，单次夹在 `±maxAffinityDelta`（默认 10），同样受 floor 约束。
- 等级：<20 陌生、<40 眼熟、<60 朋友、<80 亲近、≥80 重要的人。
- `allowed` 只是 **QQ 号 → 称呼** 的映射（也用于识海白名单判断），**不是**好感白名单：没在名单里的人也会被记好感，名字先用 QQ 号。

### 2.5 识海 core memory

- 触发词（`CORE_TRIGGERS`）：`永远记住 / 永远记得 / 一辈子记住 / 记住这个 / 记住这件事 / 记住我说的话 / 别忘了 / 别忘记` 等。**普通「记住」不算**，避免每句「记住带伞」都进永久记忆。
- 取触发词**后面**的正文（长触发词优先，取最早出现的那一处）；去掉开头标点；正文少于 3 个字不记。
- 单条最多 `coreEntryMaxChars=300` 字；按「去标点/去空格后的小写文本」去重，重复说不会新增。
- 注入总预算 `coreMaxChars=2400` 字（含标题与说明）。超预算时整行丢，末尾注明「还有 N 条识海记忆因字数预算没展开」；最后一条放不下会截断并标「…（已截断）」。
- 识海是**最高优先级**，注入块里排最前；不会自动删除，只能 `removeCore(id)` 或 `reset()`。
- `captureInGroup` 控制群聊里能不能写识海；`coreFromAllowedOnly=true` 时只有 `allowed` 名单里的人能写（**生产环境建议打开**，否则群里任何人都能留永久记忆）。
- 手动 `addCore(text, {by})` / `removeCore(id)` 给控制台用。

### 2.6 旧账 emotional memory

- 不是每条负面消息都记：**单次负面冲击 ≥ `grudgeSingleThreshold`（0.08）**，或 **900 秒窗口累计 ≥ `grudgeWindowThreshold`（0.12）** 才记一条。
- 同一用户 24 小时内、文本相似度 ≥0.8 的旧账不重复记。
- 每条旧账有话题、情绪、强度、日期；最多留 `grudgeMaxEvents=800` 条（超了丢最旧）。
- **平时不注入**。下次同一个人说话时按概率想起：
  - 同话题（相似度 ≥ `grudgeSameTopicSimilarity=0.35`）：**45%–60%**，随 `grudge`（0–100）和当初强度上升；
  - 话题不像、但当前情绪也差：**15%–20%**；
  - 当前既不负面、心情也不差：不掷骰。
- 每被翻一次概率 -4 个百分点（最多 -12）；**6 小时内翻过的不再翻**（`grudgeCooldownSec`）。
- 命中后生成一个 `pendingRecall`，只在下一次 `buildPersonaBlock()` 注入一次；10 分钟没被消费就过期（`recallTtlSec`）。
- `resolveGrudge(id)` 标记「翻篇了」，之后不再参与回忆。

> 旧账永远只匹配**同一个人**：A 欠你的，不会算到 B 头上。

## 三、配置（`config.json` 的 `personaState`）

模块导出 `DEFAULT_PERSONA_STATE_CONFIG`；主控读 `config.personaState` 传给 `createPersonaState` 即可。键名以 camelCase 为主，同时接受参考包/需求里的 snake_case 别名。

### 3.1 开关与文件

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时构造不读文件、任何方法都不写文件 |
| `stateFile` / `state_file` | `state/persona-state.json` | 状态文件，相对路径按进程 cwd 解析 |
| `inject` | `true` | 注入开关。`false` 仍记录（灰度用），只是不给提示词 |
| `injectInGroup` / `inject_in_group` | `true` | 群聊是否注入；`false` 不影响私聊 |
| `captureInGroup` / `capture_in_group` | `true` | 群聊里是否允许写识海（**只作用于识海**；情绪/好感/旧账在群聊仍会更新） |
| `coreCapture` / `core_capture` | `true` | 识海**自动捕获**开关。`false` 时不再从消息里抓新条目；已有识海仍照常注入，手动 `addCore()` 也不受它影响 |
| `coreFromAllowedOnly` / `core_from_allowed_only` | `false` | 只有 `allowed` 名单能写识海 |
| `emotionalMemory` / `emotional_memory` | `true` | 旧账**记录/回忆**开关。`false` 时不记新账、不注入回忆；已有旧账仍在 `snapshot()` 里可查 |
| `affinity` | `true` | 好感**更新/注入**开关。`false` 时不更新、不注入好感；已有记录仍在 `snapshot()` 里可查 |

### 3.2 名单与情绪

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `allowed` / `allowedIds` / `allowed_ids` | `{}` | QQ号 → 称呼；也用于识海白名单。留空＝不限制 |
| `floors` / `affinity_floors` | `{}` | QQ号 → 好感下限 0..100 |
| `baseline` | `{p:0.05,a:0.35,d:0.5}` | PAD 基线，也接受 `baselinePleasure` 等扁平键 |
| `maxStep` / `max_step` | `0.12` | 单条消息单轴总冲击上限 |
| `labelCap` / `label_cap` | `0.6` | 标签强度上限 |
| `labelHalfLifeMin` / `label_half_life_min` | `45` | 标签半衰期（分钟） |
| `moodHalfLifeHours` / `mood_half_life_hours` | `6` | PAD 回基线半衰期（小时） |
| `soothePositive` / `soothe_positive` | `0.08` | 被哄时 PAD/感动标签的正向上限 |

### 3.3 好感、旧账、识海

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `affinityBase` | `30` | 初次好感的起点 |
| `affinityDailyGainCap` | `6` | 每日正向收益上限 |
| `affinityIdleGraceDays` | `7` | 久不联系的宽限天数 |
| `affinityIdleDecayPerDay` | `1` | 宽限后每天回落 |
| `maxAffinityDelta` | `10` | 手动 `adjustAffinity` 单次上限 |
| `grudge` | `45` | 旧账翻出倾向 0..100，越高越容易想起 |
| `grudgeSingleThreshold` | `0.08` | 单次负面冲击记账阈值 |
| `grudgeWindowThreshold` | `0.12` | 900 秒窗口累计阈值 |
| `grudgeWindowSec` | `900` | 窗口长度 |
| `grudgeCooldownSec` | `21600` | 同一条旧账冷却（6 小时） |
| `grudgeSameTopicSimilarity` | `0.35` | 判「同话题」的相似度 |
| `grudgeMaxEvents` | `800` | 旧账上限 |
| `recallTtlSec` | `600` | pendingRecall 多久没消费就作废 |
| `coreMaxChars` / `core_max_chars` | `2400` | 识海注入总预算 |
| `coreEntryMaxChars` | `300` | 单条识海上限 |
| `injectTopAffinity` | `3` | 注入块里列几个好感最高的人 |

示例（先灰度就把 `inject` 设成 `false`）：

```json
{
  "personaState": {
    "enabled": true,
    "inject": false,
    "injectInGroup": false,
    "stateFile": "state/persona-state.json",
    "allowed": { "10001": "阿澈" },
    "floors": { "10001": 40 },
    "grudge": 45,
    "coreFromAllowedOnly": true
  }
}
```

> 模块默认 `enabled=true`。主控接线时建议：**只有 `config.personaState` 存在才创建实例**；如果无条件创建，请把默认块显式写成 `enabled:false`，否则会直接开始记录。

## 四、注入块长什么样

真实渲染（私聊、已有一条识海、刚被骂过）：

```
<!-- PS:BEGIN persona -->
【识海 · 永不遗忘】
以下内容是被要求永远记住的，优先级最高：永不衰减、永不删除、不许否认、不许擅自改；不要主动复述，也不要拿别人的私事当谈资。
1. [2026-10-28 阿澈] 我不吃香菜，点外卖别放

【角色当前状态】
现在有点生气（0.2），因为「滚，闭嘴，烦死了」
好感：阿澈 31.6/100（眼熟）、小满 27.7/100（眼熟）
识海：1 条永远不会忘的事（见前文）。
句子短一点，别主动找话题，但别骂人；情绪只影响语气，不影响判断；对方要你做事就正常做，不要主动提自己的情绪。
这些是内部状态：不报数字，也不解释这套机制。
<!-- PS:END persona -->
```

顺序固定：**识海（最高优先级）→ 当前状态（情绪一句话/好感前 N/识海条数/情绪提示/内部状态声明）→ 可能的旧账**。旧账块长这样：

```
【压在心里的旧事】
你忽然想起 2026-10-28 那天「小满」说过的话：「滚，闭嘴，烦死了」。
当时你挺生气的，一直没提。要不要翻出来你自己看着办；不想提，就当没想起来。
```

- 群聊且 `injectInGroup=false` ⇒ 返回空串，提示词里连 marker 都没有。
- `inject=false` 或 `enabled=false` ⇒ 同样返回空串。
- 旧账是**一次性**的：`buildPersonaBlock()` 取走后会清空并落盘；`peek:true` 只预览不消费（调试用）。
- `stripPersonaBlocks(text)` 会裁掉完整块，也会裁掉只有 BEGIN、没有 END 的残块；主控出站前应先过一遍，防止模型把 marker 复述出去。

## 五、状态文件

- 默认 `state/persona-state.json`，内容是一个 JSON：`{version, updatedAt, pad, affinity, core, grudges, pendingRecall}`。
- **首次真正变更才建文件**：只构造、只 `snapshot()` 不会写；`observeMessage` 成功处理一条消息会写一次；`tick()` 只有衰减/回落/过期真的发生才写。
- 写入是 `tmp + rename` 原子替换，权限 `0o600`，父目录自动建。
- 坏档不会让桥接起不来：文件被改坏时改名为 `.bad` 留证据，然后从空状态开始。
- `enabled=false` 时连读都不读；已有文件原样保留，重新打开开关还能接上。
- **不要手动编辑这个文件**；要改状态走 `/api/emotion` 对应的控制台方法（主控接线）。

## 六、灰度：先只记录，不注入

建议按三步走，每步至少观察一天：

1. **只记录**：`enabled:true, inject:false, injectInGroup:false`。重启后看 `GET /api/emotion` 的 `snapshot()`：情绪标签是不是合理、好感有没有乱涨、识海有没有被群里陌生人写脏、旧账是不是记太多。
2. **只开私聊注入**：`inject:true, injectInGroup:false`。看私聊回复的语气有没有变自然；如果她开始复述状态/报数字，检查注入块是否被放得太靠后，或 `emotionHint` 是否被过度放大。
3. **再开群聊**：`injectInGroup:true`；若不想让群里陌生人写永久记忆，关 `captureInGroup` 或开 `coreFromAllowedOnly`。注意 `captureInGroup` 只管识海，**不能阻止群聊影响情绪/好感/旧账**；介意群聊气氛污染情绪时，只能在主控侧决定是否把群消息传给 `observeMessage`。

灰度期不建议同时开 `adjustMood` 自动干预；先让规则自己跑，确认基线。

## 七、回滚

- **立刻停注入**：`inject:false`（重启或主控热读配置）。记录继续，不丢数据。
- **完全停用**：`enabled:false`。所有方法空转、不再写文件；已有 `state/persona-state.json` 保留，下次打开继续用。
- **清空重来**：先停桥接，再删/改名 `state/persona-state.json`（进程里还有内存态，运行中删会被下次写入重建）。只想清某一条识海/某条旧账，用 `removeCore(id)` / `resolveGrudge(id)`，别动整个文件。
- 人格文件从始至终没被改过，所以**不需要回滚人格卡**；这也是这层坚持「只注入、不写卡」的原因。

## 八、接到 `bridge.js`（主控要做的）

模块本身不 import 任何仓库文件、不读配置、不注册端点。建议接线：

1. **启动时创建一次**（配置加载之后、事件泵之前）：

   ```js
   import { createPersonaState, stripPersonaBlocks } from './persona-state.js';
   const personaState = createPersonaState({
     stateFile: path.resolve(rootDir, config.personaState?.stateFile || 'state/persona-state.json'),
     config: config.personaState || {},
   });
   ```

2. **入站**：解析出 `userId/text/chatType/name` 之后、拼唤醒提示词之前调用：

   ```js
   personaState.observeMessage({ userId, text, chatType, at: Date.now(), name });
   ```

   - 私聊/群聊都要（群聊能否写**识海**由 `captureInGroup` 决定；情绪/好感/旧账仍会更新）；
   - 跳过 `/` 命令、纯 `[图片]`/`[表情]` 占位、空文本（模块本身会拒绝空文本）；
   - 每条消息只调一次，不要对同一条重试消息重复调（会重复涨好感/重复记旧账）。

3. **拼提示词**：角色卡之后、记忆卡/社交记忆附近调一次：

   ```js
   const personaBlock = personaState.buildPersonaBlock({ chatType });
   if (personaBlock) prompt += '\n\n' + personaBlock;
   ```

   - 一次唤醒只调一次；旧账取走就没了；
   - 如果提示词是复用/重渲染的，先对旧文本 `stripPersonaBlocks` 再拼。

4. **出站**：发送前过一遍 `stripPersonaBlocks(replyText)`，防止模型把 marker/状态块复述给用户。不需要对每条出站更新状态；只有主动消息失败、或主控想手动干预时，才调 `adjustMood({delta, reason})`。

5. **衰减定时器**：每 5 分钟（或 1–10 分钟）调一次：

   ```js
   setInterval(() => personaState.tick(Date.now()), 5 * 60 * 1000).unref?.();
   ```

   启动时也先 `tick()` 一次，把停机期间该衰减/该回落的补上。标签半衰期 45 分钟，5 分钟粒度足够。

6. **只读视图**：`GET /api/emotion` 直接返回 `personaState.snapshot()`；写操作（加/删识海、翻篇旧账、reset）走主控已有的控制台鉴权，不要新开无鉴权端点。

7. **不要**在出站消息上再调 `observeMessage`（会把她自己的话当成用户输入）；也不要把这个模块的状态写进 `roles/*.md`。

## 九、边界、已知取舍与测试

### 9.1 明确不做

- **不是模型情感分析**：只有关键词规则，反讽、上下文、语气全靠规则兜不住；它是「稳定的小状态」，不是「读心」。
- **不跨会话隔离**：情绪和好感是全局的；同一个人私聊和群聊共用一份。识海也是全局。
- **不识别人格切换**：换 `roles/小鲸鱼.md` 不影响这份状态；要清就 `reset()`。
- **没有自动压缩/遗忘识海**：识海只增不减，靠 2400 字预算截断 + 手动删；这是有意的（「永远记住」不该被系统悄悄删）。
- **没有前端页面**：只提供 `snapshot()` 和控制台方法，页面由主控决定。
- **不是多进程安全的**：同一 `stateFile` 只允许一个桥接进程写；多开会互相覆盖。

### 9.2 两个容易误解的点

- **十个标签里没有「平静/兴奋/疲惫」**：参考包固定十个标签，需求里那三个词是 PAD 推出来的 **`state.mood` 概括词**，不是 `labels` 条目。所以 `snapshot().state` 同时有 `mood:"平静"` 和 `labels:[{name:"生气",...}]`，这不矛盾：mood 是三维快照的粗词，labels 是细标签。
- **「被哄」不是所有夸奖**：必须像在对她说（有「你」、道歉、或「谢谢/抱抱/乖」这类词）。「哈哈好可爱」走普通开心，否则正向永远被 0.08 封顶，标签层就死了。

### 9.3 测试

`scripts/test-persona-state.mjs` 共 **25 条**（node:test，临时目录，不碰真实 `state/`），覆盖：单条 0.12 上限、45/90 分钟半衰、6 小时回基线、被哄 0.08、好感每日 6 分/辱骂 -3.5/20 天回落/floors/±10、识海三触发词/去重/删除/群聊开关/名单限制/2400 截断、旧账阈值/关闭开关/概率区间（注入 rng）/只注入一次、marker 与 strip、群聊注入开关、`affinity=false` 不记不注入、`coreCapture=false` 只停自动捕获、`enabled=false` 不建文件、`inject=false` 灰度、重启续存、snapshot 形状、手动调整与 reset、纯函数边界。

```bash
export ELECTRON_RUN_AS_NODE=1
'/d/dsh/DeepSeek Harness.exe' --check src/persona-state.js
'/d/dsh/DeepSeek Harness.exe' --check scripts/test-persona-state.mjs
'/d/dsh/DeepSeek Harness.exe' scripts/test-persona-state.mjs
```

预期末尾：`tests 25 / pass 25 / fail 0`。
