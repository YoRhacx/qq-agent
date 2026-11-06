# 记忆模块三件套：人物画像 / 每日反思 / 程序记忆

> 一句话：记忆大脑（[MEMORY_BRAIN.md](MEMORY_BRAIN.md)）负责「记住」，
> 这三个模块负责「把记住的东西压成能用的三样」——一个人的画像、一天的回想、一件事的做法。
>
> 全部是**纯启发式**：不调模型、不联网、零 npm 依赖、同样的输入永远得到同样的输出。
> 三个模块各写一份自己的小 JSON，**不碰** `state/memory-brain.sqlite`；开关关掉时连文件都不建。

设计来源是一份 AstrBot/Python 的记忆系统实现（`profile.py` / `reflection.py` / `procedural.py`）。
那边是「拼提示词让模型写 + 解析 JSON」，这边把**功能与参数**搬过来，实现换成确定性的启发式：
可单测、可复现、零 token，也不会因为模型抽风把画像写成小作文。

## 一、为什么单独拆三个模块

| 模块 | 回答的问题 | 输入 | 输出 |
| --- | --- | --- | --- |
| 人物画像 `memory-profile.js` | 「这个人／这个群／这个项目，我该记得什么？」 | 按实体聚合的一批记忆 | 一段 200~400 字第三人称描述 |
| 每日反思 `memory-reflection.js` | 「今天过得怎么样，下次怎么更好？」 | 当天的记忆 | 一段第一人称小日记 + 至多 3 条亮点 |
| 程序记忆 `memory-procedural.js` | 「这件事上次是怎么做成的？」 | 做过的流程 + 认可词，或现成的 skill 记忆 | 任务名 + 步骤 + 用过几次 + 成功率 |

拆开的好处是**三件事的节奏完全不一样**：画像是「一天最多几个、七天一更新」，
反思是「一天一条」，技能是「每 12 条消息就可能多一条」。混在一个定时任务里，
要么画像被反复重写，要么技能永远抽不出来。

## 二、三件套各干什么

### 2.1 画像：按实体聚合，够格才写

```
记忆流 ──按实体分组──▶ degree（出现在几条不同的记忆里）
                          │
        degree ≥ minDegree(2) 且 距上次更新 ≥ intervalDays(7)
                          │
                    本轮还有额度（maxPerRun 5 个／天）
                          ▼
              一句话判断 + 称呼/偏好/雷点 + 时间线 + 记忆摘录
```

- **实体**来自记忆的 `entities`（`memory-brain` 的 `extractEntities()` 已经写进 SQLite 的
  `entities` / `memory_entities` 两张表，适配器只读它们）。
- **degree** 是「不同的记忆条数」，同一条记忆里提两次只算 1；`mentions` 才是出现次数。
- 正文结构：`「名字」是她记得比较清楚的<人/群/项目>之一，前后在 N 件事里被提到。`
  → 大部分在记什么 → 称呼（外号／也叫）→ 喜欢什么 → 不太喜欢什么 → 时间线 → 最多 5 条记忆摘录。
- 长度：`minChars 200` / `maxChars 400` / `targetChars 260`。摘录一条条加，够 260 就停；
  **事实不够时不注水**——只有两条短记忆时可能不到 200 字，这是刻意的（宁可短，不编）。
- 输出记录：`{ entityId, name, degree, profile, firstAt, updatedAt }`。

### 2.2 反思：一天一条，只写当天

- **只取当天**：`createdAt` 落在本地日历日（`YYYY-MM-DD`）里的记忆才算；
  没有时间的记忆归不到「哪一天」，直接跳过。
- 摘要四句：`今天一共记下 N 件事，最要紧的是：…` → 情绪统计（`valence ≤ -0.25` 的有几条）
  → `回想起来，今天记下的多是…` → `下次…`（有 `lesson` 就用她自己写下的，没有按情绪给一句）。
- 亮点：按 `importance` 取前 3 条，互相包含的只留一条，每条 ≤40 字。
- 输出记录：`{ date, summary, highlights[], createdAt, memoryCount }`；只留最近 `keepDays = 30` 天。

### 2.3 程序记忆：抽技能 + 记成功率

两个来源：

| 来源 | 长什么样 | 例 |
| --- | --- | --- |
| 现成的 `skill` 记忆 | `任务名：1. 第一步；2. 第二步`（跟 `procedural.py` 的 `to_text()` 同格式） | `部署服务：1. 重启 bridge；2. 检查 3100 端口` |
| 做过的流程 + 认可 | 时间窗口（`windowMs` 10 分钟）内至少 2 条动作，最后一条是**短**认可词 | `帮我重启 bridge` → `查一下端口` → `搞定了，谢谢` |

- 认可词只在 **≤40 字**的消息里认，否则闲聊里一句「谢谢」就能把无关动作拼成技能。
- 技能记录：`{ id, name, steps[], uses, successes, failures, successRate, seen, source, sourceIds, createdAt, updatedAt }`。
- `match(query)` 用 bigram Dice 相似度打分（名字 6 成 + 步骤 3.5 成 + 用过且成功的加成），
  过 `matchMinScore`（0.34）才返回；返回里直接带 `steps`，可以照抄。
- `use({ name, ok })`：`ok:true` 记成功、`ok:false` 记失败、不传只算「用过」；
  `successRate = successes / uses`。

## 三、输入从哪来：只读快照，不抢写库

三个模块**都不写记忆库**。原因很实在：`state/memory-brain.sqlite` 只有一个主人
（`src/bridge.js` 里的那个 `brain` 实例），多一个写入者就多一类锁与脏读；
而这三个模块要的只是「读一批记忆」，用快照就够了。

统一形状（`normalizeInputMemories()` 与各模块内部同款）：

```js
{
  memories: [
    { id: 12, kind: 'episode', text: '主人：…', entities: [{ name: '小鲸鱼', type: 'person' }],
      createdAt: 1761672000000, importance: 0.6, valence: 0 }
  ]
}
```

适配器只有 `memory-profile.js` 里的一个：

```js
import { collectInputsFromMemoryBrain } from './memory-profile.js';

const snapshot = collectInputsFromMemoryBrain(brain, { limit: 500, status: 'active' });
// → { memories: [...], total, fetchedAt, source: 'memory-brain' }
```

它做两件事，**都是只读**：

1. `brain.list({ status, limit, offset })` 翻页取记忆（每页 ≤500，`list()` 的上限）；
2. `brain.db.prepare('SELECT me.memory_id, e.name, e.type FROM memory_entities me JOIN entities e …').all(...)` 补实体名。

拿不到实体名（没有 `db`、表结构变了、SQL 抛错）就**降级成空实体**，不抛——
表现是这一轮画像不生成，而不是桥接 500。

> 可选过滤：`limit` / `status ('active'|'archived'|'merged')` / `since` / `until`（毫秒，按 `createdAt`）。
> 反思只要当天的话，直接传 `since: 当天 0 点` 更省。

## 四、状态文件

三份独立 JSON，默认都在 `state/` 下（`statePath` 可改；相对路径按进程 cwd 解析）：

| 模块 | 默认路径 | 结构 |
| --- | --- | --- |
| 画像 | `state/memory-profile.json` | `{ version, day, dayCount, profiles:[{entityId,name,degree,profile,firstAt,updatedAt}], stats:{generated,refreshed,pruned}, updatedAt }` |
| 反思 | `state/memory-reflection.json` | `{ version, items:[{date,summary,highlights,createdAt,memoryCount}], updatedAt }` |
| 技能 | `state/memory-procedural.json` | `{ version, skills:[{id,name,steps,uses,successes,failures,seen,source,sourceIds,createdAt,updatedAt}], updatedAt }` |

三个模块写文件的规矩一样：

- **原子写**：先写 `<file>.part-<pid>-<ts>` 再 `rename`，权限 `0o600`；进程半路挂掉不会留半截 JSON。
- **只在自己的事情变了才写**：没生成／没更新就不落盘（所以空输入不会凭空建出一个空文件）。
- **读坏了不炸**：JSON 解析失败 → 当空状态继续，并把原因记在 `status().warnings` 里。
- **`day` / `dayCount` 是「今天已经用掉几个额度」**，跨天自动归零。

幂等规则（都写在代码里，也都有测试）：

| 情况 | 结果 |
| --- | --- |
| 画像：同一天对同一个实体再跑 | `skipped: 'today'`，不重写 |
| 画像：未满 `intervalDays` | `skipped: 'interval'` |
| 画像：今天已经生成 `maxPerRun` 个 | `skipped: 'budget'` |
| 反思：同一天再跑 | 返回已有那条，`created: false, reason: 'already'` |
| 技能：同一批记忆再抽一次 | 合并（`sourceIds` 没有新的就不写盘），条数不变 |

## 五、配置与开关

三个开关**各自独立**：`enabled:false` 时模块不读也不写、`render()` 返回空串，主控不用判断。
默认值在三个文件顶部的 `DEFAULT_*_CONFIG` 里；`config.json` 建议各给一块
（`memoryProfile` / `memoryReflection` / `memoryProcedural`），由主控读进来传即可：

```json
{
  "memoryProfile": { "enabled": true, "statePath": "state/memory-profile.json",
                     "minDegree": 2, "maxPerRun": 5, "intervalDays": 7,
                     "minChars": 200, "maxChars": 400 },
  "memoryReflection": { "enabled": true, "statePath": "state/memory-reflection.json",
                        "keepDays": 30, "maxHighlights": 3, "maxChars": 400 },
  "memoryProcedural": { "enabled": true, "statePath": "state/memory-procedural.json",
                        "minSteps": 2, "maxSteps": 6, "windowMs": 600000,
                        "matchMinScore": 0.34, "matchLimit": 3 }
}
```

三个 `normalizeXxxConfig()` 都同时认**驼峰**和**蛇形别名**（`profile_min_degree` /
`profile_max_per_run` / `profile_interval_days` / `reflection_keep_days` /
`procedural_min_steps` …），这样从 Python 版抄过来的配置块能直接用。
非法值（负数、字符串、超范围）一律夹到合法区间，不会让模块起不来。

## 六、给主控的调用时机

| 时机 | 调什么 | 为什么是这个时候 |
| --- | --- | --- |
| **每天一次**（建议 04:10，跟记忆卡衰减同一批） | `profileBuilder.build(snapshot)`、`reflectionWriter.run(snapshot)` | 画像要跨天才有「7 天更新」的意义；反思按日历日切 |
| **每 12 条消息**（跟 `summarizeWindow()` 同一个窗口） | `proceduralStore.extract(snapshot)` | 流程刚做完，认可词还在 10 分钟窗口里；12 条正好是一个 episode 的粒度 |
| **出站前拼提示词**（每条回复） | 三个 `render()` | 都带 `maxChars` 预算，返回空串表示「没有内容／关掉了」 |
| **技能用完之后** | `proceduralStore.use({ name, ok })` | 成功率只有主控知道（她有没有照做、做成没有） |

接线示意（在主控里，不在本模块内）：

```js
import { createProfileBuilder, collectInputsFromMemoryBrain } from './memory-profile.js';
import { createReflectionWriter } from './memory-reflection.js';
import { createProceduralStore } from './memory-procedural.js';

const profileBuilder = createProfileBuilder({ config: cfg.memoryProfile });
const reflectionWriter = createReflectionWriter({ config: cfg.memoryReflection });
const proceduralStore = createProceduralStore({ config: cfg.memoryProcedural });

// 04:10
const snapshot = collectInputsFromMemoryBrain(brain, { limit: 500 });
profileBuilder.build(snapshot);
reflectionWriter.run(snapshot);

// 每 12 条消息
proceduralStore.extract(collectInputsFromMemoryBrain(brain, { limit: 80 }));

// 出站前：三个都可以直接拼，空的自然不占位
const extra = [
  profileBuilder.render({ names: mentionedNames, maxChars: 300 }),
  reflectionWriter.render({ days: 1, maxChars: 200 }),
  proceduralStore.render({ query: userText, limit: 2, maxChars: 300 })
].filter(Boolean).join('\n');
```

`render()` 的形状：

- 画像：`【人物印象】\n- 小鲸鱼：…`（`names` 给了就只取这几个，按 degree 排）
- 反思：`【最近的回想】\n- 2026-10-28：今天…`
- 技能：`【这样做过】\n- 部署服务（用过 3 次）:1. 重启 bridge；2. 检查 3100 端口`

## 七、不做的事

1. **不调模型**。三份 Python 原版都要一次 LLM 调用；这一版一次都不调。
   代价是文字没有模型写得「活」，但换来确定性、可单测、零 token、不会因为模型抽风写飞。
2. **不写记忆库**。没有 `INSERT` / `UPDATE` / `DELETE`，只有一条 `SELECT`。
   想把结果再写回记忆库（比如把画像存成 `fact`），是主控的事，不是模块的事。
3. **不猜「她当时怎么想的」**。反思只统计当天真实存在的条数／种类／情绪标记，
   不编造「她当时很开心」。没 `lesson` 时的「下次…」是一句按情绪选的模板，文档就写在这里。
4. **不判断技能成功**。抽取只看「动作 + 认可词」；成功率必须靠主控调 `use()` 回传，
   否则永远显示「用过 0 次」。
5. **不合并实体**。`小鲸鱼` 和 `鱼鱼` 是两条实体（除非 `memory-brain` 的 `mergeSimilar` 已经合过）。
   实体归一那一步在参考实现里是 `consolidate.py`，属于记忆库的治理，不在这一层。

## 八、测试

```bash
ELECTRON_RUN_AS_NODE=1 "/d/dsh/DeepSeek Harness.exe" scripts/test-memory-modules.mjs
```

21 条，覆盖：画像阈值（degree=1 不生成）／长度 200~400／每天限额／同一天幂等／7 天更新／
空输入不建文件／开关关掉不建文件／状态读回／配置别名；反思只取当天／一天一条／保留 30 天／
没有当天记忆不写／关掉不建文件；技能解析／流程抽取／没认可不抽／`use` 统计／`match` 命中／
重复抽取幂等／关掉不建文件；适配器翻页 + 只读补实体 + 降级不抛。
全部写 `fs.mkdtemp()` 的临时目录，不碰真 `state/`。

## 九、已知取舍

- **画像可能短于 200 字**：事实不够时宁可短，也不拿套话灌水。想看够不够，看 `degree` 和正文里的摘录条数。
- **`maxPerRun` 是「每天累计」**：靠 `dayCount` 记，不是「每次跑最多 5 个」——
  一天跑三次也不会生成 15 个。
- **技能的 10 分钟窗口**是拍的：窗口太长会把不相干的动作拼进来，太短会漏掉慢流程。
  真觉得不合适就调 `windowMs`（建议 5~30 分钟）。
- **反思的「下次怎么更好」最弱**：没有 `lesson` 时就是一句模板。要它变好，
  得先在写入侧多存 `lesson`（`memory-brain` 的 `distillLessons()` 已经在做这件事）。
- 三个模块都**不自己接线**：`bridge.js` / `config.example.json` / `docs/README.md` /
  `docs/FOLDER_MAP.md` / `scripts/test-audit.mjs` 的注册由主控统一做。
