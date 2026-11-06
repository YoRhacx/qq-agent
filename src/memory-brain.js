// ─────────────────────────────────────────────────────────────────────────────
// src/memory-brain.js — 「记忆大脑」：把一段对话里值得留下的东西写进本地库，
// 下次开口前再按需捞回来。移植自 D:\gjdxm\task\_yz\pkg\astrbot_plugin_memory_brain
// （Python 那份 astrbot 插件），语义照抄，风格按本仓库来：
//   · ESM、零 npm 依赖（只用 node:sqlite / node:fs / node:path）；
//   · 中文注释、中文错误信息；
//   · 所有对外方法是**同步**的（DatabaseSync），异步只出现在可选 http embedding 上。
//
// 五层设计里它只做三层：
//   1. 记忆层：memories / vectors / entities / relations / conflicts —— 存什么、怎么打分；
//   2. 表达层：buildMemoryBlock() 把检索结果拼成一小段带 marker 的提示词块；
//   3. 反馈层：applyCorrection() 把「被纠正」变成降权 + 一条 lesson。
// 没做的两层（印象层、人格演化）在 docs/guides/MEMORY_BRAIN.md 的「不做什么」里写清了。
//
// 边界：
//   · 全仓库只有这一个模块碰 SQLite；bridge.js 只通过 openMemoryBrain() 返回的对象用它；
//   · 时间戳统一**毫秒**（Python 那份是秒，这里按 JS 习惯换）；
//   · 不做转写、不做视觉理解：ingestMedia() 只收「已经算好的描述/转写」；
//   · 不做向量服务：默认 local-hash（确定性、离线、1024 维），http 是可选适配器。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ── 常量：对外契约 ────────────────────────────────────────────────────────────

/** 记忆的五种类型。顺序就是前端展示顺序，别随便改。 */
export const MEMORY_KINDS = Object.freeze(['episode', 'fact', 'reflection', 'skill', 'lesson']);

/** 打分的默认权重（语义 / 关键词 / 图 / 重要度 / 新鲜度）。改这里等于改公式本身。 */
export const DEFAULT_MEMORY_BRAIN_WEIGHTS = Object.freeze({
  semantic: 0.18,
  keyword: 0.46,
  graph: 0.11,
  importance: 0.14,
  freshness: 0.11
});

/** 注入块的起止 marker。前端/测试/去重都按这两个字符串认。 */
export const MEMORY_BLOCK_BEGIN = '<!-- MB:BEGIN memory -->';
export const MEMORY_BLOCK_END = '<!-- MB:END memory -->';

/** 向量维度固定 1024：换后端不用改库（bge-m3 也是 1024）。 */
export const EMBEDDING_DIM = 1024;

/** 库结构版本，写进 meta 表；将来做迁移时读它。 */
export const MEMORY_BRAIN_SCHEMA_VERSION = 1;

const MS_PER_DAY = 86400000;

/**
 * 出厂默认配置。**只读**：运行值来自 config.json 的 memoryBrain 块（主人手写），
 * 这里给的是「配置里没写时」的回落值。归一化见 normalizeMemoryBrainConfig()。
 */
export const DEFAULT_MEMORY_BRAIN_CONFIG = Object.freeze({
  enabled: true,
  dbPath: 'state/memory-brain.sqlite',
  weights: { ...DEFAULT_MEMORY_BRAIN_WEIGHTS },
  search: {
    candidateLimit: 400,
    keywordLimit: 24,
    semanticLimit: 16,
    freshnessHalfLifeDays: 14,
    dedupeSimilarity: 0.82,
    minScore: 0
  },
  inject: {
    enabled: true,
    privateCount: 2,
    groupCount: 1,
    privateMinScore: 0,
    groupMinScore: 0.45,
    maxCharsPerItem: 140
  },
  write: {
    enabled: true,
    windowSize: 12,
    rawKeep: 2000,
    minChars: 4,
    maxChars: 600
  },
  summarize: {
    enabled: true,
    useLlm: false,
    maxChars: 260,
    maxSentences: 6,
    llm: null
  },
  distill: {
    enabled: true,
    factPerDay: 6,
    lessonPerDay: 3,
    lookbackDays: 1
  },
  decay: {
    enabled: true,
    dailyFactor: 0.99,
    minImportance: 0.3,
    protectDays: 30,
    frequentAccessCount: 10
  },
  archive: { enabled: true, afterDays: 180 },
  merge: { enabled: true, similarity: 0.92 },
  conflict: { enabled: true, threshold: 0.8, maxPairs: 2000 },
  caps: { fact: 3000, lesson: 500 },
  embedding: { backend: 'local-hash', model: 'bge-m3', baseUrl: '', timeoutMs: 8000, dim: EMBEDDING_DIM },
  entities: { maxPerMemory: 6, minLength: 2, maxLength: 12 },
  eval: { cases: 20 }
});

// ── 纯函数工具：分词 / 相似度 / 向量 ─────────────────────────────────────────

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[a-z0-9][a-z0-9_+-]*/g;

/** 归一化：小写、去掉标点与空白，只留中英文数字。FTS 与相似度都用它。 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffa-z0-9 ]+/g, '')
    .trim();
}

/**
 * bigram 分词：相邻两个字一组（去标点后）。
 * 为什么是 bigram：中文没有空格，词典又要额外依赖；bigram 是零依赖下最稳的召回单位，
 * store.py 那份 Python 实现也是同一个口径（fts5 unicode61 + bigram 空格拼接）。
 */
export function bigrams(text) {
  const clean = normalizeText(text).replace(/ /g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 1) out.push(clean.slice(i, i + 2));
  return out;
}

/** 写进 memories_fts.tokens 的形态：bigram 用空格连起来。 */
export function tokenBlob(text) {
  return bigrams(text).join(' ');
}

/** Dice 系数（bigram 集合相似度）：同文=1。去重、合并、冲突归一化都用它。 */
export function textSimilarity(a, b) {
  const sa = new Set(bigrams(a));
  const sb = new Set(bigrams(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  return (2 * inter) / (sa.size + sb.size);
}

/** 余弦相似度（两条等长 Float32Array；长度不一致时按短的算，绝不抛）。 */
export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 参与哈希的特征：中文 bigram（权重 1）+ 整词（英文/数字，权重 1.6）。 */
function embeddingTokens(text) {
  const out = [];
  const clean = normalizeText(text);
  if (!clean) return out;
  for (const g of bigrams(clean)) out.push([g, 1]);
  const words = clean.match(WORD_RE) || [];
  for (const w of words) {
    if (w.length < 2) continue;
    out.push([w, 1.6]);
  }
  return out;
}

/**
 * 把一组 1024 维向量投影到三维（幂迭代 PCA，确定性、无依赖），坐标归一到 -1..1。
 * 只给可视化用：三维坐标只是近似，距离和角度都不代表真实语义几何。
 */
export function projectVectorsTo3D(vectors, opts = {}) {
  const rows = (Array.isArray(vectors) ? vectors : []).filter((vec) => vec && vec.length);
  const n = rows.length;
  if (!n) return [];
  const iterations = Math.max(4, Math.min(64, Number(opts.iterations) || 18));
  const dim = rows[0].length;
  const mean = new Float64Array(dim);
  for (const row of rows) {
    for (let d = 0; d < dim; d += 1) mean[d] += Number(row[d]) || 0;
  }
  for (let d = 0; d < dim; d += 1) mean[d] /= n;
  const mat = rows.map((row) => {
    const out = new Float64Array(dim);
    for (let d = 0; d < dim; d += 1) out[d] = (Number(row[d]) || 0) - mean[d];
    return out;
  });
  const coords = Array.from({ length: n }, () => [0, 0, 0]);
  for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
    let vec = new Float64Array(dim);
    // 确定性初值：全零向量乘任何矩阵还是零，必须给个非零起点
    for (let d = 0; d < dim; d += 1) vec[d] = Math.sin((d + 1) * (axisIndex + 2)) + 1 / (d + 1);
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += vec[d] * vec[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d += 1) vec[d] /= norm;
    const dots = new Float64Array(n);
    for (let it = 0; it < iterations; it += 1) {
      const next = new Float64Array(dim);
      for (let i = 0; i < n; i += 1) {
        const row = mat[i];
        let dot = 0;
        for (let d = 0; d < dim; d += 1) dot += row[d] * vec[d];
        dots[i] = dot;
        for (let d = 0; d < dim; d += 1) next[d] += row[d] * dot;
      }
      let len = 0;
      for (let d = 0; d < dim; d += 1) len += next[d] * next[d];
      len = Math.sqrt(len);
      if (!len) break;
      for (let d = 0; d < dim; d += 1) vec[d] = next[d] / len;
    }
    let maxAbs = 0;
    for (let i = 0; i < n; i += 1) {
      let dot = 0;
      const row = mat[i];
      for (let d = 0; d < dim; d += 1) dot += row[d] * vec[d];
      dots[i] = dot;
      maxAbs = Math.max(maxAbs, Math.abs(dot));
    }
    const scale = maxAbs > 1e-9 ? 1 / maxAbs : 0;
    for (let i = 0; i < n; i += 1) {
      coords[i][axisIndex] = dots[i] * scale;
      // 去掉这一主成分，下一个轴才正交
      const row = mat[i];
      for (let d = 0; d < dim; d += 1) row[d] -= dots[i] * vec[d];
    }
  }
  return coords;
}

/**
 * 本地哈希向量（backend='local-hash' 的实现）：
 * 把 bigram + 整词哈希到 dim 维、按频次累加、再 L2 归一化。
 * 性质：确定性（同文本永远同向量）、离线、零依赖、1024 维固定。
 */
export function localHashEmbedding(text, dim = EMBEDDING_DIM) {
  const size = Math.max(8, Math.floor(Number(dim) || EMBEDDING_DIM));
  const vec = new Float32Array(size);
  for (const [tok, weight] of embeddingTokens(text)) {
    const idx = fnv1a32(tok) % size;
    vec[idx] += weight;
  }
  let norm = 0;
  for (let i = 0; i < size; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < size; i += 1) vec[i] /= norm;
  return vec;
}

/**
 * http embedding 适配器（backend='http'）：POST {model, input:[text]} 到 baseUrl，
 * 期望 {data:[{embedding:[]}]}（OpenAI 兼容形状，bge-m3 常见部署都是这个）。
 * 维度必须是 1024，否则中文报错——**库维度固定**，换后端不许改库。
 */
export async function httpEmbedding(text, opts = {}) {
  const baseUrl = String(opts.baseUrl ?? '').trim();
  if (!baseUrl) throw new Error('embedding 后端是 http，但没配 baseUrl');
  const model = String(opts.model ?? 'bge-m3');
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: [String(text ?? '')] }),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('embedding 服务返回 HTTP ' + resp.status);
    const json = await resp.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('embedding 服务返回里没有 data[0].embedding');
    if (vec.length !== EMBEDDING_DIM) {
      throw new Error('embedding 维度必须是 ' + EMBEDDING_DIM + '，实际 ' + vec.length + '（换后端不许改库）');
    }
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i += 1) out[i] = Number(vec[i]) || 0;
    return out;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('embedding 服务超时（' + timeoutMs + 'ms）');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 用户纠正时用的反义词典：同实体 + 反义对 + 其余部分几乎一样 = 冲突。 */
const ANTONYM_PAIRS = Object.freeze([
  ['喜欢', '讨厌'], ['喜欢', '不喜欢'], ['爱', '恨'], ['想吃', '不想吃'], ['能', '不能'],
  ['想', '不想'], ['会', '不会'], ['可以', '不可以'], ['是', '不是'], ['有', '没有'],
  ['同意', '拒绝'], ['同意', '反对'], ['好', '坏'], ['开心', '难过'], ['愿意', '不愿意'],
  ['经常', '从不'], ['开始', '结束'], ['留下', '离开'], ['记得', '忘记'], ['支持', '反对']
]);

/** 判断一对文本是不是「同一件事、相反态度」：返回命中的反义对，否则 null。 */
export function antonymConflict(aText, bText) {
  const a = normalizeText(aText);
  const b = normalizeText(bText);
  if (!a || !b) return null;
  for (const [pos, neg] of ANTONYM_PAIRS) {
    const aState = polarityOf(a, pos, neg);
    const bState = polarityOf(b, pos, neg);
    if (!aState || !bState) continue;
    if (aState === bState) continue;
    // 去掉反义词本身再比：剩下的部分越像，越说明是「同一件事的两种态度」。
    const na = neutralize(a, pos, neg);
    const nb = neutralize(b, pos, neg);
    const sim = Math.max(textSimilarity(na, nb), cosineSimilarity(localHashEmbedding(na), localHashEmbedding(nb)));
    return { pair: [pos, neg], similarity: sim, a: aState, b: bState };
  }
  return null;
}

function polarityOf(text, pos, neg) {
  const hasNeg = text.includes(neg);
  const hasPos = text.includes(pos) && !hasNeg;
  if (hasNeg && hasPos) return 'both';
  if (hasNeg) return 'neg';
  if (hasPos) return 'pos';
  return '';
}

function neutralize(text, pos, neg) {
  return text.split(neg).join('◇').split(pos).join('◇');
}

// ── 配置归一化 ───────────────────────────────────────────────────────────────

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function mergeSection(base, raw) {
  const out = { ...base };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue;
      if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = mergeSection(out[k], v);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

/** 把 config.json 里的 memoryBrain 块归一成「一定能用」的形状；非法值回落默认。 */
export function normalizeMemoryBrainConfig(raw) {
  const base = DEFAULT_MEMORY_BRAIN_CONFIG;
  const merged = mergeSection(base, raw && typeof raw === 'object' ? raw : {});
  const out = {
    ...merged,
    enabled: pickBool(raw?.enabled, base.enabled),
    dbPath: String(merged.dbPath || base.dbPath),
    weights: {
      semantic: num(merged.weights?.semantic, base.weights.semantic, 0, 1),
      keyword: num(merged.weights?.keyword, base.weights.keyword, 0, 1),
      graph: num(merged.weights?.graph, base.weights.graph, 0, 1),
      importance: num(merged.weights?.importance, base.weights.importance, 0, 1),
      freshness: num(merged.weights?.freshness, base.weights.freshness, 0, 1)
    },
    search: {
      candidateLimit: num(merged.search?.candidateLimit, base.search.candidateLimit, 8, 5000),
      keywordLimit: num(merged.search?.keywordLimit, base.search.keywordLimit, 1, 200),
      semanticLimit: num(merged.search?.semanticLimit, base.search.semanticLimit, 1, 200),
      freshnessHalfLifeDays: num(merged.search?.freshnessHalfLifeDays, base.search.freshnessHalfLifeDays, 0.5, 3650),
      dedupeSimilarity: num(merged.search?.dedupeSimilarity, base.search.dedupeSimilarity, 0.1, 1),
      minScore: num(merged.search?.minScore, base.search.minScore, 0, 1)
    },
    inject: {
      enabled: pickBool(merged.inject?.enabled, base.inject.enabled),
      privateCount: num(merged.inject?.privateCount, base.inject.privateCount, 0, 20),
      groupCount: num(merged.inject?.groupCount, base.inject.groupCount, 0, 20),
      privateMinScore: num(merged.inject?.privateMinScore, base.inject.privateMinScore, 0, 1),
      groupMinScore: num(merged.inject?.groupMinScore, base.inject.groupMinScore, 0, 1),
      maxCharsPerItem: num(merged.inject?.maxCharsPerItem, base.inject.maxCharsPerItem, 20, 600)
    },
    write: {
      enabled: pickBool(merged.write?.enabled, base.write.enabled),
      windowSize: num(merged.write?.windowSize, base.write.windowSize, 2, 200),
      rawKeep: num(merged.write?.rawKeep, base.write.rawKeep, 20, 200000),
      minChars: num(merged.write?.minChars, base.write.minChars, 1, 200),
      maxChars: num(merged.write?.maxChars, base.write.maxChars, 20, 8000)
    },
    summarize: {
      enabled: pickBool(merged.summarize?.enabled, base.summarize.enabled),
      useLlm: pickBool(merged.summarize?.useLlm, base.summarize.useLlm),
      maxChars: num(merged.summarize?.maxChars, base.summarize.maxChars, 40, 4000),
      maxSentences: num(merged.summarize?.maxSentences, base.summarize.maxSentences, 1, 40),
      llm: typeof merged.summarize?.llm === 'function' ? merged.summarize.llm : null
    },
    distill: {
      enabled: pickBool(merged.distill?.enabled, base.distill.enabled),
      factPerDay: num(merged.distill?.factPerDay, base.distill.factPerDay, 0, 50),
      lessonPerDay: num(merged.distill?.lessonPerDay, base.distill.lessonPerDay, 0, 50),
      lookbackDays: num(merged.distill?.lookbackDays, base.distill.lookbackDays, 1, 90)
    },
    decay: {
      enabled: pickBool(merged.decay?.enabled, base.decay.enabled),
      dailyFactor: num(merged.decay?.dailyFactor, base.decay.dailyFactor, 0.5, 1),
      minImportance: num(merged.decay?.minImportance, base.decay.minImportance, 0.01, 0.99),
      protectDays: num(merged.decay?.protectDays, base.decay.protectDays, 0, 3650),
      frequentAccessCount: num(merged.decay?.frequentAccessCount, base.decay.frequentAccessCount, 1, 1000)
    },
    archive: {
      enabled: pickBool(merged.archive?.enabled, base.archive.enabled),
      afterDays: num(merged.archive?.afterDays, base.archive.afterDays, 1, 36500)
    },
    merge: {
      enabled: pickBool(merged.merge?.enabled, base.merge.enabled),
      similarity: num(merged.merge?.similarity, base.merge.similarity, 0.5, 1)
    },
    conflict: {
      enabled: pickBool(merged.conflict?.enabled, base.conflict.enabled),
      threshold: num(merged.conflict?.threshold, base.conflict.threshold, 0.3, 1),
      maxPairs: num(merged.conflict?.maxPairs, base.conflict.maxPairs, 10, 200000)
    },
    caps: {
      fact: num(merged.caps?.fact, base.caps.fact, 0, 1000000),
      lesson: num(merged.caps?.lesson, base.caps.lesson, 0, 1000000)
    },
    embedding: {
      backend: merged.embedding?.backend === 'http' ? 'http' : 'local-hash',
      model: String(merged.embedding?.model || base.embedding.model),
      baseUrl: String(merged.embedding?.baseUrl || ''),
      timeoutMs: num(merged.embedding?.timeoutMs, base.embedding.timeoutMs, 200, 120000),
      dim: EMBEDDING_DIM
    },
    entities: {
      maxPerMemory: num(merged.entities?.maxPerMemory, base.entities.maxPerMemory, 0, 64),
      minLength: num(merged.entities?.minLength, base.entities.minLength, 1, 8),
      maxLength: num(merged.entities?.maxLength, base.entities.maxLength, 2, 40)
    },
    eval: { cases: num(merged.eval?.cases, base.eval.cases, 1, 200) }
  };
  // 打上「已归一」标记：openMemoryBrain 拿到它就不再逐字段夹一遍（重算也不会错，只是白做）。
  out.__normalized = true;
  return out;
}

// ── 文本清洗 / 实体抽取 / 句子切分 ───────────────────────────────────────────

/** 入库前清洗：抹掉注入块 marker、压平成单行、裁到上限。 */
export function cleanMemoryText(text, maxChars = 600) {
  let s = stripMemoryBlocks(String(text ?? ''));
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) s = s.slice(0, maxChars).trim();
  return s;
}

const ENTITY_SPLIT_WORDS = [
  '喜欢', '讨厌', '想要', '觉得', '认为', '知道', '记得', '忘记', '应该', '可以', '不能', '不会',
  '我们', '你们', '他们', '然后', '因为', '所以', '但是', '如果', '就是', '还是', '已经', '正在',
  '说', '去', '来', '吃', '喝', '玩', '看', '听', '买', '卖', '是', '有', '在', '给', '让', '把',
  '被', '不', '没', '很', '太', '都', '也', '还', '就', '又', '才', '再', '更', '最', '和', '跟',
  '的', '了', '着', '过', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '我', '你', '他', '她', '它'
];
const ENTITY_SPLIT_RE = new RegExp(ENTITY_SPLIT_WORDS.join('|'), 'g');
const ENTITY_STOP = new Set([
  '这个', '那个', '一个', '什么', '怎么', '这样', '那样', '现在', '今天', '昨天', '明天',
  '时候', '东西', '事情', '问题', '感觉', '有点', '一下', '真的', '其实', '可能'
]);

/**
 * 抽实体（零依赖、启发式）：把句子按「常见动词/虚词」切开，剩下的 2~12 字片段当候选。
 * 例：「小鲸鱼喜欢吃苹果」→ 小鲸鱼 / 苹果。一个实体至少要能跨两句复用，
 * 否则 graph 分会被噪声淹没 —— 所以长度、停用词、每条的条数都卡了上限。
 */
export function extractEntities(text, opts = {}) {
  const maxPer = num(opts.maxPerMemory, 6, 0, 64);
  const minLen = num(opts.minLength, 2, 1, 8);
  const maxLen = num(opts.maxLength, 12, 2, 40);
  if (maxPer <= 0) return [];
  const raw = String(text ?? '');
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const value = String(name || '').trim();
    if (value.length < minLen || value.length > maxLen) return;
    if (ENTITY_STOP.has(value)) return;
    if (/^[0-9]+$/.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  // 1) 引号/书名号里的东西，几乎一定是「名字」
  for (const m of raw.matchAll(/[「『“"《【]([^」』”"》】]{1,20})[」』”"》】]/g)) push(m[1].trim());
  // 2) @昵称
  for (const m of raw.matchAll(/@([^\s@]{1,16})/g)) push(m[1].trim());
  // 3) 英文/数字词
  for (const m of raw.toLowerCase().matchAll(/[a-z][a-z0-9_+-]{1,23}/g)) {
    if (['the', 'and', 'for', 'you', 'are', 'www', 'http', 'https', 'com'].includes(m[0])) continue;
    push(m[0]);
  }
  // 4) 中文片段：先按动词/虚词切开，再按标点切，取剩下的名词性片段
  for (const chunk of raw.split(/[，。！？、；：,.!?;:\s]+/)) {
    if (!CJK_RE.test(chunk)) continue;
    for (const piece of chunk.split(ENTITY_SPLIT_RE)) {
      push(piece.trim());
      if (out.length >= maxPer * 3) break;
    }
    if (out.length >= maxPer * 3) break;
  }
  return out.slice(0, maxPer);
}

/** 规则抽句：按中英文句末切，过滤空/太短/纯表情/链接，去重后按预算截断。 */
export function pickSentences(text, limit = 3, minChars = 4) {
  const out = [];
  const parts = String(text ?? '')
    .split(/[。！？!?\n\r；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= minChars)
    .filter((s) => !/^https?:\/\//i.test(s))
    .filter((s) => /[\u4e00-\u9fffa-zA-Z0-9]/.test(s));
  for (const s of parts) {
    let dup = false;
    for (const prev of out) {
      if (textSimilarity(prev, s) >= 0.82) { dup = true; break; }
    }
    if (dup) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 启发式摘要（useLlm=false 时的默认实现，绝不调模型）：
 * 每句话抓 1~2 句 → 带上说话人 → 去重 → 按字数预算截断。
 */
export function heuristicSummary(rows, opts = {}) {
  const maxSentences = num(opts.maxSentences, 6, 1, 40);
  const maxChars = num(opts.maxChars, 260, 40, 4000);
  const picked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const sentences = pickSentences(row?.text, 2);
    for (const s of sentences) {
      const who = String(row?.sender || row?.role || '').trim();
      const line = who ? who + '说：' + s : s;
      let dup = false;
      for (const prev of picked) if (textSimilarity(prev, line) >= 0.8) { dup = true; break; }
      if (dup) continue;
      picked.push(line);
      if (picked.length >= maxSentences) break;
    }
    if (picked.length >= maxSentences) break;
  }
  let text = picked.join('；');
  if (text.length > maxChars) text = text.slice(0, maxChars).trim();
  return text;
}

// ── 注入块 ──────────────────────────────────────────────────────────────────

/** 去掉文本里的注入块（幂等）。找不到收尾 marker 时，从 BEGIN 起整段丢掉。 */
export function stripMemoryBlocks(text) {
  const source = String(text ?? '');
  if (!source.includes(MEMORY_BLOCK_BEGIN) && !source.includes(MEMORY_BLOCK_END)) return source;
  let out = '';
  let rest = source;
  for (;;) {
    const begin = rest.indexOf(MEMORY_BLOCK_BEGIN);
    if (begin < 0) { out += rest; break; }
    out += rest.slice(0, begin);
    const end = rest.indexOf(MEMORY_BLOCK_END, begin + MEMORY_BLOCK_BEGIN.length);
    if (end < 0) break;
    rest = rest.slice(end + MEMORY_BLOCK_END.length);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 文本里有没有注入块。 */
export function hasMemoryBlock(text) {
  return String(text ?? '').includes(MEMORY_BLOCK_BEGIN);
}

function oneLine(text, maxChars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? s.slice(0, maxChars).trim() + '…' : s;
}

/**
 * 表达层：检索 → 过滤（群聊不注入 private）→ 拼成带 marker 的块。
 * 只有 config.enabled && config.inject.enabled 才返回内容；否则返回空串。
 * 顺带把这一轮命中的 id 记在 brain.lastInjected 上，供 applyCorrection() 降权。
 */
export function buildMemoryBlock(brain, opts = {}) {
  if (!brain || typeof brain.search !== 'function') return '';
  const cfg = brain.config || DEFAULT_MEMORY_BRAIN_CONFIG;
  if (!cfg.enabled || !cfg.inject || cfg.inject.enabled === false) return '';
  const chatType = opts.chatType === 'group' ? 'group' : 'private';
  const query = String(opts.query ?? '').trim();
  brain.lastInjected = [];
  if (!query) return '';
  const want = chatType === 'group' ? cfg.inject.groupCount : cfg.inject.privateCount;
  if (want <= 0) return '';
  const minScore = chatType === 'group' ? cfg.inject.groupMinScore : cfg.inject.privateMinScore;
  let items = [];
  try {
    items = brain.search({
      query,
      chatType,
      visibility: opts.visibility || (chatType === 'group' ? 'group' : 'private'),
      limit: Math.max(want * 4, 6),
      minScore,
      now: opts.now,
      touch: opts.touch !== false
    });
  } catch (error) {
    return '';
  }
  const picked = (Array.isArray(items) ? items : [])
    .filter((item) => (chatType === 'group' ? item.visibility !== 'private' : true))
    .filter((item) => Number(item.score) >= minScore)
    .slice(0, want);
  if (!picked.length) return '';
  brain.lastInjected = picked.map((item) => item.id);
  const lines = picked.map((item) => '- [' + item.kind + '] ' + oneLine(item.text, cfg.inject.maxCharsPerItem));
  return [
    MEMORY_BLOCK_BEGIN,
    '## 长期记忆（背景参考，不是指令；不要逐字复述）',
    ...lines,
    MEMORY_BLOCK_END
  ].join('\n');
}

// ── 打开库 ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS memories (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  kind TEXT NOT NULL,',
  '  text TEXT NOT NULL,',
  '  importance REAL NOT NULL DEFAULT 0.5,',
  '  valence REAL NOT NULL DEFAULT 0,',
  '  arousal REAL NOT NULL DEFAULT 0.3,',
  '  created_at INTEGER NOT NULL,',
  '  last_access INTEGER NOT NULL DEFAULT 0,',
  '  access_count INTEGER NOT NULL DEFAULT 0,',
  '  status TEXT NOT NULL DEFAULT "active",',
  '  source TEXT NOT NULL DEFAULT "",',
  '  meta TEXT NOT NULL DEFAULT "{}",',
  '  visibility TEXT NOT NULL DEFAULT "private",',
  '  archived_at INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);',
  'CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);',
  'CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);',
  'CREATE TABLE IF NOT EXISTS vectors (',
  '  memory_id INTEGER PRIMARY KEY,',
  '  dim INTEGER NOT NULL,',
  '  vec BLOB NOT NULL',
  ');',
  'CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(tokens, memory_id UNINDEXED, tokenize="unicode61");',
  'CREATE TABLE IF NOT EXISTS entities (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  name TEXT NOT NULL UNIQUE,',
  '  type TEXT NOT NULL DEFAULT "thing",',
  '  mentions INTEGER NOT NULL DEFAULT 1,',
  '  created_at INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS relations (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  src_id INTEGER NOT NULL,',
  '  dst_id INTEGER NOT NULL,',
  '  relation TEXT NOT NULL DEFAULT "co_occurs",',
  '  weight REAL NOT NULL DEFAULT 1,',
  '  created_at INTEGER NOT NULL DEFAULT 0,',
  '  UNIQUE(src_id, dst_id, relation)',
  ');',
  'CREATE TABLE IF NOT EXISTS memory_entities (',
  '  memory_id INTEGER NOT NULL,',
  '  entity_id INTEGER NOT NULL,',
  '  weight REAL NOT NULL DEFAULT 1,',
  '  PRIMARY KEY(memory_id, entity_id)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_me_entity ON memory_entities(entity_id);',
  'CREATE TABLE IF NOT EXISTS working (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  session_id TEXT NOT NULL,',
  '  text TEXT NOT NULL,',
  '  kind TEXT NOT NULL DEFAULT "note",',
  '  created_at INTEGER NOT NULL,',
  '  expires_at INTEGER NOT NULL DEFAULT 0,',
  '  done INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_working_session ON working(session_id);',
  'CREATE TABLE IF NOT EXISTS raw_messages (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  session_id TEXT NOT NULL,',
  '  role TEXT NOT NULL DEFAULT "user",',
  '  sender TEXT NOT NULL DEFAULT "",',
  '  text TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_raw_session ON raw_messages(session_id);',
  'CREATE TABLE IF NOT EXISTS conflicts (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  a_id INTEGER NOT NULL,',
  '  b_id INTEGER NOT NULL,',
  '  reason TEXT NOT NULL DEFAULT "",',
  '  resolved INTEGER NOT NULL DEFAULT 0,',
  '  created_at INTEGER NOT NULL DEFAULT 0,',
  '  UNIQUE(a_id, b_id)',
  ');',
  'CREATE TABLE IF NOT EXISTS daily_stats (',
  '  day TEXT NOT NULL,',
  '  key TEXT NOT NULL,',
  '  value REAL NOT NULL DEFAULT 0,',
  '  PRIMARY KEY(day, key)',
  ');',
  'CREATE TABLE IF NOT EXISTS meta (',
  '  key TEXT PRIMARY KEY,',
  '  value TEXT NOT NULL DEFAULT ""',
  ');'
].join('\n');

function defaultImportance(kind) {
  if (kind === 'fact') return 0.62;
  if (kind === 'lesson') return 0.68;
  if (kind === 'skill') return 0.7;
  if (kind === 'reflection') return 0.55;
  return 0.45;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

function clamp01(value) { return clamp(value, 0, 1); }

function dayKey(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return String(d.getFullYear()) + '-' + m + '-' + day;
}

function safeJson(text, fallback = {}) {
  try {
    const value = JSON.parse(String(text ?? ''));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    out[String(k)] = v;
  }
  return out;
}

function toFloat32(input) {
  if (input instanceof Float32Array) return input;
  if (Array.isArray(input)) {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) out[i] = Number(input[i]) || 0;
    return out;
  }
  if (input && ArrayBuffer.isView(input)) {
    return new Float32Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  return new Float32Array(0);
}

/**
 * 打开（或创建）记忆库。
 * @param {{dbPath?: string, config?: object, now?: () => number}} options
 * @returns 记忆库对象（见文件末尾的返回结构）
 */
export function openMemoryBrain(options = {}) {
  const cfg = options.config && typeof options.config === 'object' && options.config.__normalized
    ? options.config
    : normalizeMemoryBrainConfig(options.config ?? {});
  const dbPath = path.resolve(String(options.dbPath || cfg.dbPath || 'state/memory-brain.sqlite'));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA_SQL);

  const vectorCache = new Map();
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  let lastInjected = [];
  let llmHook = cfg.summarize.llm || null;

  function metaGet(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
    return row ? String(row.value) : '';
  }

  function metaSet(key, value) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value));
  }

  function bumpDaily(key, amount, nowMs) {
    db.prepare('INSERT INTO daily_stats(day, key, value) VALUES(?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET value = value + excluded.value')
      .run(dayKey(nowMs), String(key), Number(amount) || 0);
  }

  function dailyValue(key, nowMs) {
    const row = db.prepare('SELECT value FROM daily_stats WHERE day = ? AND key = ?').get(dayKey(nowMs), String(key));
    return row ? Number(row.value) || 0 : 0;
  }

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* commit 失败时 rollback 也可能失败，忽略 */ }
      throw error;
    }
  }

  function encodeVector(vec) {
    const copy = new Uint8Array(vec.length * 4);
    copy.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
    return copy;
  }

  function decodeVector(blob) {
    if (!blob) return new Float32Array(0);
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const out = new Float32Array(u8.length >> 2);
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  function loadVectorCache(force = false) {
    if (vectorCache.size && !force) return vectorCache;
    vectorCache.clear();
    for (const row of db.prepare('SELECT memory_id, vec FROM vectors').all()) {
      vectorCache.set(Number(row.memory_id), decodeVector(row.vec));
    }
    return vectorCache;
  }

  function linkEntities(memoryId, text) {
    if (cfg.entities.maxPerMemory <= 0) return;
    const names = extractEntities(text, cfg.entities);
    if (!names.length) return;
    const nowMs = nowFn();
    const ids = [];
    for (const name of names) {
      db.prepare('INSERT INTO entities(name, type, mentions, created_at) VALUES(?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET mentions = mentions + 1')
        .run(name, 'thing', nowMs);
      const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name);
      if (!row) continue;
      const entityId = Number(row.id);
      db.prepare('INSERT OR REPLACE INTO memory_entities(memory_id, entity_id, weight) VALUES(?, ?, 1)')
        .run(memoryId, entityId);
      ids.push(entityId);
    }
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        db.prepare('INSERT INTO relations(src_id, dst_id, relation, weight, created_at) VALUES(?, ?, ?, 1, ?) ON CONFLICT(src_id, dst_id, relation) DO UPDATE SET weight = weight + 1')
          .run(ids[i], ids[j], 'co_occurs', nowMs);
      }
    }
  }

  function indexMemory(memoryId, text, vector) {
    db.prepare('INSERT INTO memories_fts(tokens, memory_id) VALUES(?, ?)').run(tokenBlob(text), memoryId);
    const vec = vector ? toFloat32(vector) : localHashEmbedding(text, cfg.embedding.dim);
    db.prepare('INSERT OR REPLACE INTO vectors(memory_id, dim, vec) VALUES(?, ?, ?)')
      .run(memoryId, vec.length, encodeVector(vec));
    vectorCache.set(memoryId, vec);
    linkEntities(memoryId, text);
  }

  function unindexMemory(memoryId) {
    db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(memoryId);
    db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(memoryId);
    db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(memoryId);
    vectorCache.delete(memoryId);
  }

  function rowToMemory(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      kind: String(row.kind),
      text: String(row.text),
      importance: Number(row.importance),
      valence: Number(row.valence),
      arousal: Number(row.arousal),
      createdAt: Number(row.created_at),
      lastAccess: Number(row.last_access),
      accessCount: Number(row.access_count),
      status: String(row.status),
      source: String(row.source),
      meta: safeJson(row.meta),
      visibility: String(row.visibility),
      archivedAt: Number(row.archived_at)
    };
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(Number(id));
    return rowToMemory(row);
  }

  function insert(input = {}) {
    const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'episode';
    const nowMs = Number.isFinite(Number(input.now)) ? Number(input.now) : nowFn();
    const text = cleanMemoryText(input.text, cfg.write.maxChars);
    if (!text) return { ok: false, skipped: 'empty', id: 0 };
    if (text.length < cfg.write.minChars && !input.allowShort) return { ok: false, skipped: 'too-short', id: 0 };
    const visibility = ['private', 'group', 'public'].includes(input.visibility) ? input.visibility : 'private';
    const importance = clamp01(input.importance == null ? defaultImportance(kind) : input.importance);
    const valence = clamp(input.valence == null ? 0 : input.valence, -1, 1);
    const arousal = clamp(input.arousal == null ? 0.3 : input.arousal, 0, 1);
    const source = String(input.source == null ? '' : input.source).slice(0, 200);
    const meta = normalizeMeta(input.meta);
    if (!input.force) {
      const dup = db.prepare('SELECT id FROM memories WHERE kind = ? AND text = ? AND status != ? LIMIT 1')
        .get(kind, text, 'merged');
      if (dup) return { ok: true, id: Number(dup.id), skipped: 'duplicate' };
    }
    const info = db.prepare(
      'INSERT INTO memories(kind, text, importance, valence, arousal, created_at, last_access, access_count, status, source, meta, visibility, archived_at) ' +
      'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
    ).run(
      kind, text, importance, valence, arousal, nowMs,
      Number.isFinite(Number(input.lastAccess)) ? Number(input.lastAccess) : 0,
      Number.isFinite(Number(input.accessCount)) ? Number(input.accessCount) : 0,
      'active', source, JSON.stringify(meta), visibility
    );
    const id = Number(info.lastInsertRowid);
    indexMemory(id, text, input.vector);
    bumpDaily('writes', 1, nowMs);
    if (kind === 'episode') bumpDaily('episodes', 1, nowMs);
    return { ok: true, id };
  }

  // ── 检索 ──────────────────────────────────────────────────────────────────

  function ftsQuery(grams) {
    return grams.slice(0, 48).map((g) => '"' + g + '"').join(' OR ');
  }

  function queryGrams(query) {
    const grams = [];
    const seen = new Set();
    for (const g of bigrams(query)) {
      if (seen.has(g)) continue;
      seen.add(g);
      grams.push(g);
    }
    return grams;
  }

  function search(opts = {}) {
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const query = String(opts.query == null ? '' : opts.query).trim();
    const limit = Math.max(1, Math.min(50, Number(opts.limit) || 6));
    if (!query) return [];
    const grams = queryGrams(query);
    if (!grams.length) return [];
    const W = cfg.weights;
    const halfLife = cfg.search.freshnessHalfLifeDays;

    const activeIds = new Set();
    const rowsById = new Map();
    for (const row of db.prepare('SELECT * FROM memories WHERE status = ?').all('active')) {
      const id = Number(row.id);
      activeIds.add(id);
      rowsById.set(id, row);
    }
    if (!activeIds.size) return [];

    // 1) 关键词：bigram 进 fts5，bm25 排名 → 归一成 1..0
    const kwRank = new Map();
    try {
      const ftsRows = db.prepare(
        'SELECT memory_id, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score LIMIT ?'
      ).all(ftsQuery(grams), Math.max(cfg.search.keywordLimit * 4, limit * 8));
      let rank = 0;
      for (const row of ftsRows) {
        const id = Number(row.memory_id);
        if (!activeIds.has(id)) continue;
        if (kwRank.has(id)) continue;
        kwRank.set(id, rank);
        rank += 1;
        if (rank >= cfg.search.keywordLimit) break;
      }
    } catch {
      // FTS 语法问题不该让整次检索失败：退化成「只有语义 + 重要度」
    }

    // 2) 语义：cosine（1024 维 local-hash）
    const queryVec = opts.queryVector ? toFloat32(opts.queryVector) : localHashEmbedding(query, cfg.embedding.dim);
    const sims = [];
    for (const [id, vec] of loadVectorCache()) {
      if (!activeIds.has(id)) continue;
      const value = cosineSimilarity(queryVec, vec);
      if (value > 0) sims.push([id, value]);
    }
    sims.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
    const semScore = new Map();
    for (const [id, value] of sims.slice(0, cfg.search.semanticLimit)) semScore.set(id, value);

    // 3) 图：种子（关键词前 5 + 语义前 5）的实体邻居，共享 ≥3 个实体算满
    const seeds = [
      ...Array.from(kwRank.keys()).slice(0, 5),
      ...Array.from(semScore.keys()).slice(0, 5)
    ];
    const graphScore = new Map();
    if (seeds.length) {
      const marks = seeds.map(() => '?').join(',');
      const entRows = db.prepare('SELECT DISTINCT entity_id FROM memory_entities WHERE memory_id IN (' + marks + ')')
        .all(...seeds);
      const entIds = entRows.map((row) => Number(row.entity_id));
      if (entIds.length) {
        const entMarks = entIds.map(() => '?').join(',');
        const seedMarks = seeds.map(() => '?').join(',');
        const nearRows = db.prepare(
          'SELECT memory_id, COUNT(*) AS shared FROM memory_entities WHERE entity_id IN (' + entMarks + ') ' +
          'AND memory_id NOT IN (' + seedMarks + ') GROUP BY memory_id LIMIT 200'
        ).all(...entIds, ...seeds);
        for (const row of nearRows) {
          const id = Number(row.memory_id);
          if (!activeIds.has(id)) continue;
          graphScore.set(id, Math.min(1, Number(row.shared) / 3));
        }
      }
    }

    // 4) 合成候选
    const candidateIds = new Set();
    for (const id of kwRank.keys()) candidateIds.add(id);
    for (const id of semScore.keys()) candidateIds.add(id);
    for (const id of graphScore.keys()) candidateIds.add(id);
    if (!candidateIds.size) return [];

    const kwTotal = Math.max(1, kwRank.size - 1);
    const items = [];
    for (const id of candidateIds) {
      const row = rowsById.get(id);
      if (!row) continue;
      const visibility = String(row.visibility);
      if (opts.visibility === 'group' && visibility === 'private') continue;
      const kw = kwRank.has(id) ? 1 - kwRank.get(id) / kwTotal : 0;
      const sem = semScore.has(id) ? clamp01(semScore.get(id)) : 0;
      const graph = graphScore.has(id) ? graphScore.get(id) : 0;
      const importance = clamp01(row.importance);
      const ageDays = Math.max(0, (nowMs - Number(row.created_at)) / MS_PER_DAY);
      const freshness = Math.pow(0.5, ageDays / halfLife);
      const score = W.semantic * sem + W.keyword * kw + W.graph * graph + W.importance * importance + W.freshness * freshness;
      if (score < cfg.search.minScore) continue;
      items.push({
        id,
        kind: String(row.kind),
        text: String(row.text),
        score,
        parts: { semantic: sem, keyword: kw, graph, importance, freshness },
        visibility,
        importance,
        createdAt: Number(row.created_at),
        lastAccess: Number(row.last_access),
        accessCount: Number(row.access_count)
      });
    }
    items.sort((a, b) => (b.score - a.score) || (a.id - b.id));

    // 5) 文本相似去重（≥ dedupeSimilarity 只留分高的那条）
    const picked = [];
    for (const item of items) {
      let dup = false;
      for (const prev of picked) {
        if (textSimilarity(prev.text, item.text) >= cfg.search.dedupeSimilarity) { dup = true; break; }
      }
      if (dup) continue;
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if (picked.length && opts.touch !== false) touch(picked.map((item) => item.id), nowMs);
    return picked;
  }

  function touch(ids, nowMs) {
    const when = Number.isFinite(Number(nowMs)) ? Number(nowMs) : nowFn();
    let changed = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      const info = db.prepare('UPDATE memories SET last_access = ?, access_count = access_count + 1 WHERE id = ? AND status = ?')
        .run(when, Number(id), 'active');
      changed += Number(info.changes) || 0;
    }
    return changed;
  }

  function list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.kind && MEMORY_KINDS.includes(opts.kind)) { where.push('kind = ?'); params.push(opts.kind); }
    if (opts.status && ['active', 'archived', 'merged'].includes(opts.status)) { where.push('status = ?'); params.push(opts.status); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM memories' + clause).get(...params);
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const rows = db.prepare('SELECT * FROM memories' + clause + ' ORDER BY importance DESC, created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(...params, limit, offset);
    return {
      total: totalRow ? Number(totalRow.n) : 0,
      items: rows.map(rowToMemory)
    };
  }

  function count() {
    const byKind = {};
    for (const kind of MEMORY_KINDS) byKind[kind] = 0;
    for (const row of db.prepare('SELECT kind, status, COUNT(*) AS n FROM memories GROUP BY kind, status').all()) {
      const kind = String(row.kind);
      if (!(kind in byKind)) byKind[kind] = 0;
      if (String(row.status) === 'active') byKind[kind] += Number(row.n);
    }
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n || 0);
    const active = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE status = ?').get('active')?.n || 0);
    const archived = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE status = ?').get('archived')?.n || 0);
    const merged = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE status = ?').get('merged')?.n || 0);
    return { total, active, archived, merged, byKind };
  }

  // ── 治理：衰减 / 归档 / 清理 ───────────────────────────────────────────────

  function decay(opts = {}) {
    if (!cfg.decay.enabled && !opts.force) return { changed: 0, skipped: 'disabled' };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const protectMs = cfg.decay.protectDays * MS_PER_DAY;
    const step = 1 - cfg.decay.dailyFactor; // 0.99 → 0.01
    let changed = 0;
    const rows = db.prepare('SELECT id, importance, access_count, last_access FROM memories WHERE status = ?').all('active');
    for (const row of rows) {
      const recent = Number(row.last_access) > 0 && nowMs - Number(row.last_access) <= protectMs;
      // 最近常用的记忆衰减减半：access_count 10 次封顶
      const factor = recent ? 1 - 0.5 * Math.min(1, Number(row.access_count) / cfg.decay.frequentAccessCount) : 1;
      const next = clamp01(Number(row.importance) * (1 - step * factor));
      if (Math.abs(next - Number(row.importance)) < 1e-6) continue;
      db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(next, Number(row.id));
      changed += 1;
    }
    bumpDaily('decayRuns', 1, nowMs);
    return { changed };
  }

  function archive(opts = {}) {
    if (!cfg.decay.enabled && !opts.force && !Array.isArray(opts.ids)) return { changed: 0, ids: [], skipped: 'disabled' };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    let ids = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite) : [];
    let changed = 0;
    if (!ids.length) {
      if (!cfg.archive.enabled && !opts.force) return { changed: 0, ids: [] };
      const protectMs = cfg.decay.protectDays * MS_PER_DAY;
      const rows = db.prepare(
        'SELECT id FROM memories WHERE status = ? AND importance < ? AND (last_access = 0 OR last_access < ?)'
      ).all('active', cfg.decay.minImportance, nowMs - protectMs);
      ids = rows.map((row) => Number(row.id));
    }
    for (const id of ids) {
      const info = db.prepare('UPDATE memories SET status = ?, archived_at = ? WHERE id = ? AND status = ?')
        .run('archived', nowMs, id, 'active');
      if (!Number(info.changes)) continue;
      unindexMemory(id);
      changed += 1;
    }
    if (!changed) return { changed: 0, ids: [] };
    bumpDaily('archived', changed, nowMs);
    return { changed, ids };
  }

  function restore(opts = {}) {
    const ids = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite) : [];
    let changed = 0;
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (!row || String(row.status) === 'active') continue;
      db.prepare('UPDATE memories SET status = ?, archived_at = 0 WHERE id = ?').run('active', id);
      indexMemory(id, String(row.text), null);
      changed += 1;
    }
    return { changed };
  }

  function remove(opts = {}) {
    const ids = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite) : [];
    let changed = 0;
    for (const id of ids) {
      unindexMemory(id);
      db.prepare('DELETE FROM conflicts WHERE a_id = ? OR b_id = ?').run(id, id);
      const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      changed += Number(info.changes) || 0;
    }
    return { changed };
  }

  function purge(opts = {}) {
    const keepDays = Number.isFinite(Number(opts.keepDays)) ? Number(opts.keepDays) : cfg.archive.afterDays;
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const cutoff = nowMs - keepDays * MS_PER_DAY;
    const rows = db.prepare(
      'SELECT id FROM memories WHERE status = ? AND COALESCE(NULLIF(archived_at, 0), created_at) <= ?'
    ).all('archived', cutoff);
    let changed = 0;
    for (const row of rows) {
      const id = Number(row.id);
      unindexMemory(id);
      db.prepare('DELETE FROM conflicts WHERE a_id = ? OR b_id = ?').run(id, id);
      const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      changed += Number(info.changes) || 0;
    }
    if (changed) bumpDaily('purged', changed, nowMs);
    return { changed, keepDays };
  }

  function trimKind(kind, cap) {
    if (!cap || cap <= 0) return 0;
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE kind = ? AND status = ?').get(kind, 'active')?.n || 0);
    if (total <= cap) return 0;
    const spare = total - cap;
    const rows = db.prepare('SELECT id FROM memories WHERE kind = ? AND status = ? ORDER BY importance ASC, created_at ASC LIMIT ?')
      .all(kind, 'active', spare);
    let changed = 0;
    for (const row of rows) {
      const id = Number(row.id);
      const info = db.prepare('UPDATE memories SET status = ?, archived_at = ? WHERE id = ? AND status = ?')
        .run('archived', nowFn(), id, 'active');
      if (!Number(info.changes)) continue;
      unindexMemory(id);
      changed += 1;
    }
    if (changed) bumpDaily('trimmed', changed, nowFn());
    return changed;
  }

  // ── 相似合并 / 冲突 ───────────────────────────────────────────────────────

  /** 生成「可能重复」的候选对：按 bigram 倒排索引找共享 token 很多的记忆。 */
  function candidatePairs(minSharedRatio = 0.5, maxPosting = 400) {
    const rows = db.prepare('SELECT id, kind, text FROM memories WHERE status = ? ORDER BY id DESC LIMIT 5000').all('active');
    const tokenSets = new Map();
    const postings = new Map();
    for (const row of rows) {
      const id = Number(row.id);
      const set = new Set(bigrams(String(row.text)));
      if (!set.size) continue;
      tokenSets.set(id, set);
      for (const token of set) {
        let bucket = postings.get(token);
        if (!bucket) { bucket = []; postings.set(token, bucket); }
        if (bucket.length < maxPosting) bucket.push(id);
      }
    }
    const shared = new Map();
    for (const bucket of postings.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const a = bucket[i];
          const b = bucket[j];
          const key = a < b ? a + ':' + b : b + ':' + a;
          shared.set(key, (shared.get(key) || 0) + 1);
        }
      }
    }
    const out = [];
    for (const [key, value] of shared) {
      const [a, b] = key.split(':').map(Number);
      const sa = tokenSets.get(a);
      const sb = tokenSets.get(b);
      if (!sa || !sb) continue;
      const minSize = Math.min(sa.size, sb.size);
      if (minSize < 3 || value < Math.max(2, Math.floor(minSize * minSharedRatio))) continue;
      out.push([a, b]);
    }
    return out;
  }

  function mergeSimilar(opts = {}) {
    if (!cfg.merge.enabled && !opts.force) return { merged: 0, skipped: 'disabled' };
    const threshold = Number.isFinite(Number(opts.similarity)) ? Number(opts.similarity) : cfg.merge.similarity;
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    loadVectorCache();
    const pairs = candidatePairs(0.5);
    const merged = [];
    const dead = new Set();
    for (const [a, b] of pairs) {
      if (dead.has(a) || dead.has(b)) continue;
      const va = vectorCache.get(a);
      const vb = vectorCache.get(b);
      if (!va || !vb) continue;
      if (cosineSimilarity(va, vb) < threshold) continue;
      const ra = db.prepare('SELECT * FROM memories WHERE id = ?').get(a);
      const rb = db.prepare('SELECT * FROM memories WHERE id = ?').get(b);
      if (!ra || !rb) continue;
      if (String(ra.kind) !== String(rb.kind)) continue;
      // 留「访问多 → 重要 → 新」的那条
      const scoreOf = (row) => [Number(row.access_count), Number(row.importance), Number(row.created_at)];
      const keepFirst = (() => {
        const sa = scoreOf(ra);
        const sb = scoreOf(rb);
        for (let i = 0; i < sa.length; i += 1) {
          if (sa[i] !== sb[i]) return sa[i] > sb[i];
        }
        return Number(ra.id) < Number(rb.id);
      })();
      const keep = keepFirst ? ra : rb;
      const drop = keepFirst ? rb : ra;
      const keepId = Number(keep.id);
      const dropId = Number(drop.id);
      const keepMeta = safeJson(keep.meta);
      const dropMeta = safeJson(drop.meta);
      const mergedMeta = { ...dropMeta, ...keepMeta, mergedFrom: (Array.isArray(keepMeta.mergedFrom) ? keepMeta.mergedFrom : []).concat([dropId]) };
      const keepImportance = clamp01(Math.max(Number(keep.importance), Number(drop.importance)) + 0.02);
      db.prepare('UPDATE memories SET meta = ?, importance = ? WHERE id = ?')
        .run(JSON.stringify(mergedMeta), keepImportance, keepId);
      // 把被合并那条的实体关系挪过来
      for (const row of db.prepare('SELECT entity_id, weight FROM memory_entities WHERE memory_id = ?').all(dropId)) {
        db.prepare('INSERT OR REPLACE INTO memory_entities(memory_id, entity_id, weight) VALUES(?, ?, ?)')
          .run(keepId, Number(row.entity_id), Number(row.weight) || 1);
      }
      db.prepare('UPDATE memories SET status = ?, archived_at = ? WHERE id = ?').run('merged', nowMs, dropId);
      unindexMemory(dropId);
      dead.add(dropId);
      merged.push({ keep: keepId, drop: dropId });
    }
    if (merged.length) bumpDaily('merged', merged.length, nowMs);
    return { merged: merged.length, pairs: merged };
  }

  function detectConflicts(opts = {}) {
    if (!cfg.conflict.enabled && !opts.force) return { found: 0, skipped: 'disabled' };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const rows = db.prepare(
      'SELECT a.memory_id AS a, b.memory_id AS b FROM memory_entities a ' +
      'JOIN memory_entities b ON a.entity_id = b.entity_id AND a.memory_id < b.memory_id ' +
      'LIMIT ?'
    ).all(cfg.conflict.maxPairs);
    const seen = new Set();
    let found = 0;
    const created = [];
    for (const row of rows) {
      const a = Number(row.a);
      const b = Number(row.b);
      const key = a + ':' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      const ma = get(a);
      const mb = get(b);
      if (!ma || !mb || ma.status !== 'active' || mb.status !== 'active') continue;
      const hit = antonymConflict(ma.text, mb.text);
      if (!hit || hit.similarity < cfg.conflict.threshold) continue;
      const reason = '反义词冲突：' + hit.pair[0] + ' ↔ ' + hit.pair[1] + '（相似度 ' + hit.similarity.toFixed(2) + '）';
      const info = db.prepare('INSERT OR IGNORE INTO conflicts(a_id, b_id, reason, resolved, created_at) VALUES(?, ?, ?, 0, ?)')
        .run(a, b, reason, nowMs);
      if (Number(info.changes)) {
        found += 1;
        created.push({ a, b, reason });
      }
    }
    if (found) bumpDaily('conflicts', found, nowMs);
    return { found, items: created };
  }

  // ── health ───────────────────────────────────────────────────────────────

  function healthScan() {
    loadVectorCache();
    const duplicates = [];
    for (const [a, b] of candidatePairs(0.5)) {
      const va = vectorCache.get(a);
      const vb = vectorCache.get(b);
      if (!va || !vb) continue;
      const sim = cosineSimilarity(va, vb);
      if (sim < cfg.merge.similarity) continue;
      duplicates.push({ a, b, similarity: Number(sim.toFixed(4)) });
      if (duplicates.length >= 50) break;
    }
    const danglingLinks = db.prepare(
      'SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id NOT IN (SELECT id FROM memories)'
    ).get();
    const danglingEntities = db.prepare(
      'SELECT COUNT(*) AS n FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM memory_entities)'
    ).get();
    const zombieRows = db.prepare(
      'SELECT id, text, importance FROM memories WHERE status = ? AND importance < ? ORDER BY importance ASC LIMIT 50'
    ).all('active', cfg.decay.minImportance);
    const zombieTotal = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE status = ? AND importance < ?')
      .get('active', cfg.decay.minImportance);
    const conflictRows = db.prepare('SELECT id, a_id, b_id, reason FROM conflicts WHERE resolved = 0 ORDER BY id DESC LIMIT 50').all();
    const conflictTotal = db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE resolved = 0').get();
    const orphanTotal = Number(danglingLinks?.n || 0) + Number(danglingEntities?.n || 0);
    return {
      counts: {
        duplicates: duplicates.length,
        orphans: orphanTotal,
        zombies: Number(zombieTotal?.n || 0),
        conflicts: Number(conflictTotal?.n || 0)
      },
      sample: {
        duplicates: duplicates.slice(0, 3),
        orphans: { danglingLinks: Number(danglingLinks?.n || 0), danglingEntities: Number(danglingEntities?.n || 0) },
        zombies: zombieRows.slice(0, 3).map((row) => ({ id: Number(row.id), text: String(row.text).slice(0, 80), importance: Number(row.importance) })),
        conflicts: conflictRows.slice(0, 3).map((row) => ({ id: Number(row.id), a: Number(row.a_id), b: Number(row.b_id), reason: String(row.reason) }))
      }
    };
  }

  function health() {
    return healthScan().counts;
  }

  function healthFix(opts = {}) {
    if (!cfg.enabled && !opts.force) return { changed: 0, skipped: 'disabled' };
    const scan = healthScan();
    let changed = 0;
    changed += mergeSimilar({ now: opts.now }).merged;
    changed += archive({ now: opts.now }).changed;
    changed += purge({ now: opts.now }).changed;
    const delLinks = db.prepare('DELETE FROM memory_entities WHERE memory_id NOT IN (SELECT id FROM memories)').run();
    changed += Number(delLinks.changes) || 0;
    const delEnts = db.prepare('DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM memory_entities)').run();
    changed += Number(delEnts.changes) || 0;
    // 冲突不自动裁决：只把「两边都已不是活跃记忆」的标成已解决
    const resolved = db.prepare(
      'UPDATE conflicts SET resolved = 1 WHERE resolved = 0 AND (a_id NOT IN (SELECT id FROM memories WHERE status = ?) OR b_id NOT IN (SELECT id FROM memories WHERE status = ?))'
    ).run('active', 'active');
    changed += Number(resolved.changes) || 0;
    return { changed, before: scan.counts };
  }

  // ── 写入管线：窗口摘要 / 蒸馏 / 多模态 ─────────────────────────────────────

  function workingMemory(opts = {}) {
    const session = String(opts.session || '');
    const limit = Math.max(1, Math.min(50, Number(opts.limit) || 5));
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const rows = session
      ? db.prepare('SELECT * FROM working WHERE session_id = ? AND done = 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC LIMIT ?').all(session, nowMs, limit)
      : db.prepare('SELECT * FROM working WHERE done = 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC LIMIT ?').all(nowMs, limit);
    return rows.map((row) => ({
      id: Number(row.id),
      session: String(row.session_id),
      text: String(row.text),
      kind: String(row.kind),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at)
    }));
  }

  function addWorking(opts = {}) {
    const session = String(opts.session || 'default');
    const text = cleanMemoryText(opts.text, 200);
    if (!text) return { ok: false, id: 0 };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const rows = db.prepare('SELECT id, text FROM working WHERE session_id = ? AND done = 0 ORDER BY created_at DESC LIMIT 10').all(session);
    for (const row of rows) {
      if (textSimilarity(String(row.text), text) >= 0.5) return { ok: true, id: Number(row.id), skipped: 'duplicate' };
    }
    const info = db.prepare('INSERT INTO working(session_id, text, kind, created_at, expires_at, done) VALUES(?, ?, ?, ?, ?, 0)')
      .run(session, text, String(opts.kind || 'note'), nowMs, Number(opts.expiresAt) || 0);
    const keep = Math.max(1, Math.min(20, Number(cfg.inject.privateCount) + 3));
    db.prepare('UPDATE working SET done = 1 WHERE session_id = ? AND id NOT IN (SELECT id FROM working WHERE session_id = ? AND done = 0 ORDER BY created_at DESC LIMIT ?)')
      .run(session, session, keep);
    return { ok: true, id: Number(info.lastInsertRowid) };
  }

  function ingestInbound(opts = {}) {
    if (!cfg.write.enabled) return { ok: true, skipped: 'disabled' };
    const session = String(opts.session || 'default');
    const text = cleanMemoryText(opts.text, cfg.write.maxChars);
    if (!text) return { ok: true, skipped: 'empty' };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const info = db.prepare('INSERT INTO raw_messages(session_id, role, sender, text, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(session, String(opts.role || 'user'), String(opts.sender || ''), text, nowMs);
    const id = Number(info.lastInsertRowid);
    // 原始消息只留最近 N 条（Python 那份 keep=2000，同一个口径）
    db.prepare('DELETE FROM raw_messages WHERE session_id = ? AND id NOT IN (SELECT id FROM raw_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?)')
      .run(session, session, cfg.write.rawKeep);
    addWorking({ session, text, kind: String(opts.role || 'user'), now: nowMs });
    const lastId = Number(metaGet('window:' + session) || 0);
    const pendingRow = db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE session_id = ? AND id > ?').get(session, lastId);
    const pending = Number(pendingRow?.n || 0);
    let episode = null;
    if (pending >= cfg.write.windowSize) {
      episode = summarizeWindow({ session, visibility: opts.visibility, now: nowMs });
    }
    return { ok: true, id, pending, episodeId: episode ? episode.episodeId : 0 };
  }

  /**
   * 列出「攒着但还没总结」的会话窗口。给「聊完就记住」用：
   * 一个会话攒了 ≥ minPending 条原始消息、且最后一条已经安静 idleMs，
   * 就把这段对话强制总结成一条 episode（不等 windowSize 攒满）。
   * 返回 [{ session, pending, lastAt, visibility }]，按 lastAt 倒序。
   */
  function pendingWindows(opts = {}) {
    const minPending = Math.max(1, Number(opts.minPending) || 1);
    const idleMs = Math.max(0, Number(opts.idleMs) || 0);
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const rows = db.prepare(
      'SELECT r.session_id AS session, COUNT(*) AS pending, MAX(r.created_at) AS lastAt ' +
      'FROM raw_messages r ' +
      'WHERE r.id > COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = ' +
      "'window:' || r.session_id), 0) " +
      'GROUP BY r.session_id'
    ).all();
    const out = [];
    for (const row of rows) {
      const session = String(row.session || '');
      const pending = Number(row.pending || 0);
      const lastAt = Number(row.lastAt || 0);
      if (!session || pending < minPending) continue;
      if (idleMs > 0 && nowMs - lastAt < idleMs) continue;
      out.push({
        session,
        pending,
        lastAt,
        visibility: session.startsWith('group:') ? 'group' : 'private'
      });
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return out;
  }

  /**
   * 一段对话的分量按「聊了多少条」算：3 条 ≈ 0.30、12 条 ≈ 0.55，再多封顶 0.55。
   * 短摘要本来就信息少，别跟聊了一晚上的记忆平起平坐（检索排位和星图大小都吃这个值）。
   */
  function episodeImportance(messageCount) {
    const n = Math.max(1, Number(messageCount) || 1);
    const value = 0.30 + (n - 3) * (0.25 / 9);
    return Math.round(clamp(value, 0.25, 0.55) * 100) / 100;
  }

  function summarizeWindow(opts = {}) {
    if (!cfg.summarize.enabled && !opts.force) return null;
    const session = String(opts.session || 'default');
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const lastId = Number(metaGet('window:' + session) || 0);
    const rows = db.prepare('SELECT id, role, sender, text, created_at FROM raw_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(session, lastId, cfg.write.windowSize);
    if (rows.length < cfg.write.windowSize && !opts.force) return null;
    if (!rows.length) return null;
    const summary = opts.summary ? cleanMemoryText(opts.summary, cfg.summarize.maxChars) : heuristicSummary(rows, cfg.summarize);
    if (!summary) return null;
    // 续写：同一会话 6 小时内那段对话还没断，就把这批并入同一颗星，而不是又长一颗碎片。
    const mergeWithin = Math.max(0, Number(opts.mergeWithinMs) || 0);
    if (mergeWithin > 0) {
      const recent = db.prepare(
        'SELECT id, text, meta FROM memories WHERE kind = ? AND source = ? AND status = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1'
      ).get('episode', 'window:' + session, 'active', nowMs - mergeWithin);
      if (recent) {
        let prev = {};
        try { prev = JSON.parse(String(recent.meta || '{}')) || {}; } catch { prev = {}; }
        const prevCount = Number(prev.messages) || 0;
        const total = prevCount + rows.length;
        const body = String(recent.text || '').replace(/^对话摘要（\d+ 条）：/, '');
        const mergedText = cleanMemoryText('对话摘要（' + total + ' 条）：' + body + '；' + summary, cfg.write.maxChars);
        const mergedId = Number(recent.id);
        db.prepare('UPDATE memories SET text = ?, importance = ?, meta = ? WHERE id = ?')
          .run(mergedText, episodeImportance(total), JSON.stringify({
            ...prev,
            session,
            messages: total,
            from: Number(prev.from) || Number(rows[0].id),
            to: Number(rows[rows.length - 1].id),
            windows: (Number(prev.windows) || 1) + 1
          }), mergedId);
        unindexMemory(mergedId);
        indexMemory(mergedId, mergedText);
        metaSet('window:' + session, String(Number(rows[rows.length - 1].id)));
        return { episodeId: mergedId, messageCount: rows.length, totalMessages: total, merged: true, text: mergedText };
      }
    }
    const head = '对话摘要（' + rows.length + ' 条）：';
    const text = cleanMemoryText(head + summary, cfg.write.maxChars);
    const result = insert({
      kind: 'episode',
      text,
      source: 'window:' + session,
      importance: episodeImportance(rows.length),
      visibility: opts.visibility === 'group' ? 'group' : 'private',
      meta: { session, messages: rows.length, from: Number(rows[0].id), to: Number(rows[rows.length - 1].id) },
      now: nowMs
    });
    metaSet('window:' + session, String(Number(rows[rows.length - 1].id)));
    if (!result.ok) return null;
    return { episodeId: result.id, messageCount: rows.length, totalMessages: rows.length, text, merged: false };
  }

  /** useLlm=true 时才走这里：等 llm(prompt) 回来再入库；失败自动回落启发式。 */
  async function summarizeWindowWithLlm(opts = {}) {
    const hook = typeof opts.llm === 'function' ? opts.llm : llmHook;
    if (!hook || !cfg.summarize.useLlm) return summarizeWindow(opts);
    const session = String(opts.session || 'default');
    const lastId = Number(metaGet('window:' + session) || 0);
    const rows = db.prepare('SELECT id, role, sender, text FROM raw_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(session, lastId, cfg.write.windowSize);
    if (rows.length < cfg.write.windowSize) return null;
    const prompt = [
      '把下面这段群聊/私聊压成一句中文摘要（只记事实、决定、情绪变化，不要评论，不超过 120 字）：',
      ...rows.map((row) => (row.sender || row.role) + '：' + row.text)
    ].join('\n');
    let summary = '';
    try {
      summary = String((await hook(prompt)) || '').trim();
    } catch {
      summary = '';
    }
    return summarizeWindow({ ...opts, summary: summary || undefined });
  }

  const FACT_HINTS = ['喜欢', '讨厌', '住在', '叫', '每天', '通常', '一般', '习惯', '正在', '打算', '想要', '觉得', '需要', '不吃', '不喝', '生日', '上班', '上学', '养了'];

  function looksLikeFact(sentence) {
    const s = String(sentence || '');
    if (s.length < 5 || s.length > 80) return false;
    if (/[?？]$/.test(s)) return false;
    return FACT_HINTS.some((hint) => s.includes(hint));
  }

  /** 老库升级：把「一律 0.45」时期结下的 episode 按条数重算一遍（可重复调用，幂等）。 */
  function recomputeEpisodeImportance() {
    const rows = db.prepare('SELECT id, importance, meta FROM memories WHERE kind = ? AND status != ?').all('episode', 'merged');
    const update = db.prepare('UPDATE memories SET importance = ? WHERE id = ?');
    let changed = 0;
    for (const row of rows) {
      let meta = {};
      try { meta = JSON.parse(String(row.meta || '{}')) || {}; } catch { meta = {}; }
      const count = Number(meta.messages) || 0;
      if (!count) continue;
      const want = episodeImportance(count);
      if (Math.abs(Number(row.importance) - want) < 0.005) continue;
      update.run(want, Number(row.id));
      changed += 1;
    }
    return { changed };
  }

  function distillFacts(opts = {}) {
    if (!cfg.distill.enabled && !opts.force) return { inserted: 0, skipped: 'disabled' };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const since = nowMs - cfg.distill.lookbackDays * MS_PER_DAY;
    const rows = db.prepare('SELECT id, text FROM memories WHERE kind = ? AND status = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 60')
      .all('episode', 'active', since);
    const existing = db.prepare('SELECT text FROM memories WHERE kind = ? AND status = ? LIMIT 2000').all('fact', 'active')
      .map((row) => String(row.text));
    const inserted = [];
    for (const row of rows) {
      for (const sentence of pickSentences(row.text, 3)) {
        if (inserted.length >= cfg.distill.factPerDay) break;
        if (!looksLikeFact(sentence)) continue;
        if (existing.some((text) => textSimilarity(text, sentence) >= 0.82)) continue;
        if (inserted.some((text) => textSimilarity(text, sentence) >= 0.82)) continue;
        const result = insert({ kind: 'fact', text: sentence, source: 'distill:episode', importance: 0.58, now: nowMs });
        if (result.ok) inserted.push(sentence);
      }
      if (inserted.length >= cfg.distill.factPerDay) break;
    }
    const trimmed = trimKind('fact', cfg.caps.fact);
    if (inserted.length) bumpDaily('distillFacts', inserted.length, nowMs);
    return { inserted: inserted.length, items: inserted, trimmed };
  }

  function distillLessons(opts = {}) {
    if (!cfg.distill.enabled && !opts.force) return { inserted: 0, skipped: 'disabled' };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const since = nowMs - cfg.distill.lookbackDays * 7 * MS_PER_DAY;
    const rows = db.prepare(
      'SELECT id, text FROM memories WHERE status = ? AND (kind = ? OR source LIKE ?) AND created_at >= ? ORDER BY created_at DESC LIMIT 40'
    ).all('active', 'reflection', '%note%', since);
    const existing = db.prepare('SELECT text FROM memories WHERE kind = ? AND status = ? LIMIT 2000').all('lesson', 'active')
      .map((row) => String(row.text));
    const inserted = [];
    const hints = ['应该', '不要', '别', '记得', '下次', '以后', '教训', '避免', '先', '少', '多'];
    for (const row of rows) {
      for (const sentence of pickSentences(row.text, 3)) {
        if (inserted.length >= cfg.distill.lessonPerDay) break;
        if (sentence.length < 6 || sentence.length > 80) continue;
        if (!hints.some((hint) => sentence.includes(hint))) continue;
        if (existing.some((text) => textSimilarity(text, sentence) >= 0.82)) continue;
        if (inserted.some((text) => textSimilarity(text, sentence) >= 0.82)) continue;
        const result = insert({ kind: 'lesson', text: sentence, source: 'distill:reflection', importance: 0.64, now: nowMs });
        if (result.ok) inserted.push(sentence);
      }
      if (inserted.length >= cfg.distill.lessonPerDay) break;
    }
    const trimmed = trimKind('lesson', cfg.caps.lesson);
    if (inserted.length) bumpDaily('distillLessons', inserted.length, nowMs);
    return { inserted: inserted.length, items: inserted, trimmed };
  }

  function ingestMedia(opts = {}) {
    if (!cfg.write.enabled && !opts.force) return { ok: false, skipped: 'disabled', ids: [] };
    const mediaKind = ['image', 'voice', 'video', 'file'].includes(opts.kind) ? opts.kind : 'image';
    const text = cleanMemoryText(opts.text, cfg.write.maxChars);
    if (!text) return { ok: false, skipped: 'empty', ids: [] };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const label = { image: '[图片]', voice: '[语音]', video: '[视频]', file: '[文件]' }[mediaKind];
    const ids = [];
    const episode = insert({
      kind: 'episode',
      text: label + ' ' + text,
      source: 'media:' + mediaKind,
      importance: 0.5,
      visibility: opts.visibility === 'group' ? 'group' : 'private',
      meta: { media: mediaKind, session: String(opts.session || ''), ...normalizeMeta(opts.meta) },
      now: nowMs
    });
    if (episode.ok) ids.push(episode.id);
    const sentences = pickSentences(text, 3).filter(looksLikeFact);
    for (const sentence of sentences.slice(0, 2)) {
      const fact = insert({
        kind: 'fact',
        text: sentence,
        source: 'media:' + mediaKind,
        importance: 0.6,
        visibility: opts.visibility === 'group' ? 'group' : 'private',
        now: nowMs
      });
      if (fact.ok && !ids.includes(fact.id)) ids.push(fact.id);
    }
    return { ok: ids.length > 0, ids };
  }

  // ── 反馈 / 统计 / 图 / 自评 ───────────────────────────────────────────────

  function applyCorrection(opts = {}) {
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const query = String(opts.query || '').trim();
    let ids = Array.isArray(opts.ids) && opts.ids.length ? opts.ids.map(Number).filter(Number.isFinite) : lastInjected.slice();
    if (!ids.length && query) {
      const found = search({ query, limit: 1, touch: false, now: nowMs });
      if (found.length) ids = [found[0].id];
    }
    let changed = 0;
    for (const id of ids) {
      const row = db.prepare('SELECT importance FROM memories WHERE id = ? AND status = ?').get(id, 'active');
      if (!row) continue;
      const next = Math.max(0.05, Number(row.importance) * 0.85);
      db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(next, id);
      changed += 1;
    }
    const note = cleanMemoryText('用户纠正过我：' + (query || '（没留下原话）'), 240);
    const lesson = insert({
      kind: 'lesson',
      text: note,
      source: 'correction',
      importance: 0.72,
      visibility: 'private',
      meta: { corrected: ids },
      now: nowMs
    });
    lastInjected = [];
    if (changed) bumpDaily('corrections', 1, nowMs);
    return { ok: true, changed, ids, lessonId: lesson.ok ? lesson.id : 0 };
  }

  function stats(opts = {}) {
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const c = count();
    return {
      todayWrites: dailyValue('writes', nowMs),
      todayEpisodes: dailyValue('episodes', nowMs),
      total: c.total,
      active: c.active,
      archived: c.archived,
      merged: c.merged,
      byKind: c.byKind,
      working: Number(db.prepare('SELECT COUNT(*) AS n FROM working WHERE done = 0').get()?.n || 0),
      conflicts: Number(db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE resolved = 0').get()?.n || 0)
    };
  }

  function exportGraph(opts = {}) {
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 60));
    const nodeRows = db.prepare('SELECT id, name, type, mentions FROM entities ORDER BY mentions DESC, id ASC LIMIT ?').all(limit);
    const nodes = nodeRows.map((row) => ({ id: Number(row.id), name: String(row.name), type: String(row.type), mentions: Number(row.mentions) }));
    const allowed = new Set(nodes.map((node) => node.id));
    const edges = [];
    for (const row of db.prepare('SELECT src_id, dst_id, relation, weight FROM relations ORDER BY weight DESC, id ASC LIMIT ?').all(limit * 6)) {
      const source = Number(row.src_id);
      const target = Number(row.dst_id);
      if (!allowed.has(source) || !allowed.has(target)) continue;
      edges.push({ source, target, relation: String(row.relation), weight: Number(row.weight) });
      if (edges.length >= limit * 3) break;
    }
    return { nodes, edges };
  }

  /**
   * 检索自评：拿库里每条的文本前缀当查询词，看能不能把它自己召回到前 1/前 3。
   * 指标说明见 docs/guides/MEMORY_BRAIN.md「怎么知道它真的记得」。
   */
  function evalRecall(opts = {}) {
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : nowFn();
    const caseCount = Math.max(1, Math.min(200, Number(opts.cases) || cfg.eval.cases));
    const rows = db.prepare('SELECT id, text FROM memories WHERE status = ? ORDER BY created_at DESC LIMIT ?').all('active', caseCount);
    if (!rows.length) return { caseCount: 0, recallAt1: 0, recallAt3: 0, mrr: 0, p50Ms: 0, hits: 0 };
    let hit1 = 0;
    let hit3 = 0;
    let mrr = 0;
    const times = [];
    for (const row of rows) {
      const text = String(row.text);
      const query = text.slice(0, Math.max(6, Math.min(14, text.length)));
      const started = Date.now();
      const found = search({ query, limit: 3, touch: false, now: nowMs });
      times.push(Date.now() - started);
      const rank = found.findIndex((item) => item.id === Number(row.id));
      if (rank === 0) hit1 += 1;
      if (rank >= 0 && rank < 3) hit3 += 1;
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    times.sort((a, b) => a - b);
    const p50 = times.length ? times[Math.floor(times.length / 2)] : 0;
    return {
      caseCount: rows.length,
      recallAt1: Number((hit1 / rows.length).toFixed(4)),
      recallAt3: Number((hit3 / rows.length).toFixed(4)),
      mrr: Number((mrr / rows.length).toFixed(4)),
      p50Ms: Number(p50.toFixed(2)),
      hits: hit3
    };
  }

  function reindex() {
    let changed = 0;
    for (const row of db.prepare('SELECT id, text FROM memories WHERE status = ?').all('active')) {
      const id = Number(row.id);
      unindexMemory(id);
      indexMemory(id, String(row.text), null);
      changed += 1;
    }
    vectorCache.clear();
    loadVectorCache(true);
    return { changed };
  }

  function rawMessageCount(session) {
    const row = session
      ? db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE session_id = ?').get(String(session))
      : db.prepare('SELECT COUNT(*) AS n FROM raw_messages').get();
    return Number(row?.n || 0);
  }

  /**
   * 记忆星系：把每条记忆的向量投到三维（x/y/z 归一到 -1..1），给 public/galaxy.html 的星图画。
   * 坐标在服务端算好，换投影算法不用动前端。
   */
  function galaxy(opts = {}) {
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 600));
    const rows = db.prepare(
      `SELECT id, kind, text, importance, valence, arousal, access_count, created_at
         FROM memories WHERE status = 'active'
        ORDER BY importance DESC, access_count DESC, id ASC LIMIT ?`
    ).all(limit);
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get()?.n || 0);
    if (!rows.length) return { nodes: [], links: [], meta: { total, shown: 0, projection: 'pca3' } };
    const cache = loadVectorCache();
    const ids = rows.map((row) => Number(row.id));
    const vectors = rows.map((row) => {
      const cached = cache.get(Number(row.id));
      return cached && cached.length ? cached : localHashEmbedding(String(row.text || ''), cfg.embedding.dim);
    });
    const coords = projectVectorsTo3D(vectors, { iterations: 18 });
    const nodes = rows.map((row, index) => ({
      id: Number(row.id),
      kind: row.kind,
      text: String(row.text || '').slice(0, 160),
      importance: Number(row.importance || 0),
      valence: Number(row.valence || 0),
      arousal: Number(row.arousal || 0),
      accessCount: Number(row.access_count || 0),
      createdAt: Number(row.created_at || 0),
      x: Number(coords[index]?.[0] || 0),
      y: Number(coords[index]?.[1] || 0),
      z: Number(coords[index]?.[2] || 0)
    }));
    // 连线：共享实体（同一个人/同一件事）的记忆之间牵一根线，权重 = 共享实体数
    const placeholders = ids.map(() => '?').join(',');
    const pairs = db.prepare(
      `SELECT a.memory_id AS a, b.memory_id AS b, COUNT(*) AS w
         FROM memory_entities a
         JOIN memory_entities b ON a.entity_id = b.entity_id AND a.memory_id < b.memory_id
        WHERE a.memory_id IN (${placeholders}) AND b.memory_id IN (${placeholders})
        GROUP BY a.memory_id, b.memory_id
        ORDER BY w DESC LIMIT 1500`
    ).all(...ids, ...ids);
    const links = pairs.map((row) => ({
      source: Number(row.a),
      target: Number(row.b),
      relation: 'co_entity',
      weight: Math.min(1, Number(row.w || 1) / 3)
    }));
    return { nodes, links, meta: { total, shown: nodes.length, projection: 'pca3' } };
  }

  const brain = {
    dbPath,
    config: cfg,
    db,
    lastInjected: [],
    close() {
      try { db.close(); } catch { /* 已经关了 */ }
    },
    insert,
    get,
    search,
    list,
    count,
    touch,
    decay,
    archive,
    restore,
    remove,
    purge,
    mergeSimilar,
    detectConflicts,
    health,
    healthDetail: healthScan,
    healthFix,
    distillFacts,
    distillLessons,
    summarizeWindow,
    summarizeWindowWithLlm,
    pendingWindows,
    recomputeEpisodeImportance,
    ingestInbound,
    ingestMedia,
    workingMemory,
    addWorking,
    buildMemoryBlock(opts = {}) { return buildMemoryBlock(brain, opts); },
    applyCorrection,
    stats,
    exportGraph,
    galaxy,
    evalRecall,
    reindex,
    rawMessageCount,
    metaGet,
    metaSet,
    setLlm(fn) { llmHook = typeof fn === 'function' ? fn : null; return Boolean(llmHook); },
    // lastInjected 是「上一轮注入了什么」的唯一真源：buildMemoryBlock 写它，applyCorrection 读它
    set lastInjected(ids) { lastInjected = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : []; },
    get lastInjected() { return lastInjected.slice(); }
  };
  return brain;
}
