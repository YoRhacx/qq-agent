// 极简 XML 解析器（只为 QQ 卡片这种"结构固定、体积不大、不需要命名空间"的场景）。
//
// 为什么不装依赖：qq-bridge 的 node_modules 只有 10 个顶层包（js-yaml / msedge-tts / zod /
// @modelcontextprotocol/sdk 等），而卡片解析是**核心链路**上的东西 —— 为它引一个 XML 库，
// 收益（几十行代码）远小于代价（多一个要跟版本的依赖 + 供应链面）。QQ 卡片 XML 的形状很窄：
// 一层 <msg> 包着 <item>，属性里带 title/summary/url，足够用正则+栈扫出来。
//
// 支持的子集：元素、属性（单/双引号）、自闭合、文本节点、<!--注释-->、<![CDATA[...]]>、
// <?xml ... ?> 声明。不支持：命名空间前缀解析、DTD、实体引用（除内置 5 个）。

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

export const XMLParser = {
  /**
   * @param {string} src
   * @returns {{ name:string, attrs:object, children:Array, text:string }|null}
   */
  parse(src) {
    const input = String(src ?? '');
    if (!input.trim()) return null;

    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    let i = 0;

    const pushText = (raw) => {
      const text = decodeEntities(raw);
      if (!text.trim()) return;
      const top = stack[stack.length - 1];
      top.text += text;
    };

    while (i < input.length) {
      const lt = input.indexOf('<', i);
      if (lt < 0) {
        pushText(input.slice(i));
        break;
      }
      if (lt > i) pushText(input.slice(i, lt));

      // 注释
      if (input.startsWith('<!--', lt)) {
        const end = input.indexOf('-->', lt + 4);
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      // CDATA
      if (input.startsWith('<![CDATA[', lt)) {
        const end = input.indexOf(']]>', lt + 9);
        const body = end < 0 ? input.slice(lt + 9) : input.slice(lt + 9, end);
        stack[stack.length - 1].text += body;
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      // 声明 / DOCTYPE
      if (input.startsWith('<?', lt) || input.startsWith('<!', lt)) {
        const end = input.indexOf('>', lt);
        i = end < 0 ? input.length : end + 1;
        continue;
      }
      // 闭合标签
      if (input.startsWith('</', lt)) {
        const end = input.indexOf('>', lt);
        if (end < 0) break;
        if (stack.length > 1) stack.pop();
        i = end + 1;
        continue;
      }

      // 开标签
      const end = input.indexOf('>', lt);
      if (end < 0) break;
      const inner = input.slice(lt + 1, end);
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const sp = body.search(/\s/);
      const name = (sp < 0 ? body : body.slice(0, sp)).trim();
      const attrRaw = sp < 0 ? '' : body.slice(sp);
      if (!name) {
        i = end + 1;
        continue;
      }
      const node = { name, attrs: parseAttrs(attrRaw), children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }

    // 只有一层根元素时把它提到顶层，省得调用方到处 .children[0]
    const real = root.children.filter((c) => c.name !== '#root');
    if (real.length === 1) return real[0];
    return root;
  },

  /** 深度优先找第一个名字匹配的节点。 */
  find(node, name) {
    if (!node) return null;
    const want = String(name).toLowerCase();
    const stack = [node];
    while (stack.length) {
      const n = stack.shift();
      if (String(n?.name ?? '').toLowerCase() === want) return n;
      for (const c of n?.children ?? []) stack.push(c);
    }
    return null;
  },

  /** 收集所有名字匹配的节点。 */
  findAll(node, name) {
    const want = String(name).toLowerCase();
    const out = [];
    const stack = [node];
    while (stack.length) {
      const n = stack.shift();
      if (String(n?.name ?? '').toLowerCase() === want) out.push(n);
      for (const c of n?.children ?? []) stack.push(c);
    }
    return out;
  },

  /** 取某节点的纯文本（含子节点文本拼接）。 */
  text(node) {
    if (!node) return '';
    let out = node.text ?? '';
    for (const c of node.children ?? []) out += XMLParser.text(c);
    return out.trim();
  }
};

export default XMLParser;
