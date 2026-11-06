// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;

// ── 回复示例里的中文空格（只在二代注入前改写） ──────────────────────────────
// 一代是在**一条消息里用空格分句**，示例中的空格有语义；二代靠数组分条，示例里的
// 「中文 中文」空格会被模型照抄成不自然的消息。所以只对二代做改写。
//
// 认两种示例块写法，块内逐行改写、块外原样返回：
//   `## 回复示例〔二代〕` 小节   → 到下一个标题为止
//   `- 回复示例：` 列表项        → 到下一个同级/更浅的行或空行为止
export function isCjkLikeChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

// 这些字符旁边的空格不改成逗号：符号类改了就坏（URL、路径、引号），
// 句末标点后的空格是口语停顿（`？ 你再说一遍试试`），改了就变成 `？，你…`。
const EXAMPLE_NO_REPLACE = new Set([
  '/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.',
  '。', '，', '、',
  '？', '！', '?', '!', '：', '；', '…', '～', '~', '」', '』', '）', '】',
]);

export function convertExampleSpacesToComma(line) {
  const chars = Array.from(String(line ?? ''));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const prevCjk = !!prev && isCjkLikeChar(prev);
      const nextCjk = !!next && isCjkLikeChar(next);
      const prevBlocked = !!prev && EXAMPLE_NO_REPLACE.has(prev);
      const nextBlocked = !!next && EXAMPLE_NO_REPLACE.has(next);
      // 只改「中文 中文」：一侧是英文/数字/标点时，那空格多半是间距而不是分句
      // （`DeepSeek 小鲸鱼`、`？ 你再说一遍`、`- 回复示例` 都保持原样）。
      if (prevCjk && nextCjk && !prevBlocked && !nextBlocked) {
        out += '，';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function rewriteExampleSpaces(text) {
  const out = [];
  let mode = null; // null | 'heading' | 'bullet'
  let baseIndent = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (mode === 'heading' && /^#{1,6}\s/.test(line)) mode = null;
    if (mode === 'bullet') {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === '' || indent <= baseIndent) mode = null;
    }
    if (mode) {
      out.push(convertExampleSpacesToComma(line));
      continue;
    }
    if (/^#{1,6}\s.*回复示例/.test(line)) {
      mode = 'heading';
      out.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
      continue;
    }
    const bullet = /^(\s*)[-*]\s*回复示例/.exec(line);
    if (bullet) {
      mode = 'bullet';
      baseIndent = bullet[1].length;
      out.push(convertExampleSpacesToComma(line));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
