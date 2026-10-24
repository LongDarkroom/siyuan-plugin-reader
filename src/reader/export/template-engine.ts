/**
 * 受限模板引擎（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 定位
 *
 * 对标 Readest 的 `utils/note.ts`（Nunjucks / Jinja2 语法），
 * 但**只实现我们需要的子集**且**不引入依赖**（理由见设计方案 13.1）。
 *
 * 支持：
 *   {{ 变量 }}                       变量替换，支持点号 {{ book.title }}
 *   {{ 变量 | 过滤器 | 过滤器 }}       过滤器可链式，参数用引号
 *   {% for 项 in 列表 %}…{% endfor %}  循环
 *   {% if 条件 %}…{% elif 条件 %}…{% else %}…{% endif %}
 *   {# 注释 #}                        注释（不输出）
 *
 * 不支持（刻意）：表达式运算、函数调用、模板继承、set/macros。
 *
 * ## 🔴 三条不可妥协的安全约束
 *
 * ① **变量值永不二次解析**。插值走 `toOutString(v)` 后直接进结果数组，
 *    绝不再进词法分析。否则用户某条摘录里写了 `{% for %}` 就会被执行。
 * ② **不碰原型链**。变量名只允许 `[A-Za-z_][A-Za-z0-9_]*` 加 `.` 分段，
 *    逐段 `hasOwnProperty` 检查，并显式黑名单
 *    `__proto__` / `constructor` / `prototype`。
 * ③ **有资源上限**。输出 2MB、嵌套 8 层、for 迭代 10000 次、token 500 个。
 *    超限**抛错**而不是静默截断（截断产生半截产物，比失败更糟）。
 *
 * ## 与 Readest 的关键差异
 *
 * Readest 出错时 `return "[Template Error: ...]"`（utils/note.ts）——
 * 下载文件场景勉强可接受。我们是**往用户的思源文档里追加**，错误文本要用户手删。
 * ⇒ 本引擎只**抛错**，由调用方在写入之前中止；**永不返回错误文本**。
 *
 * ## 三段式结构
 *
 *   tokenize（词法）→ parse（建 AST）→ renderNode（渲染）
 *
 * 刻意分三段：把「切标签」与「判结构」分开后，块标签的匹配与嵌套
 * 只需一次线性扫描，比在渲染期做递归回溯简单得多，也不容易出边界错。
 */

import { FILTERS, hasFilter, type Filter } from "./template-filters.ts";

/* ================================================================
 * 限额
 * ============================================================ */

export const LIMITS = {
  /** 渲染结果最大长度（2MB） */
  maxOutput: 2 * 1024 * 1024,
  /** 块标签最大嵌套深度 */
  maxDepth: 8,
  /** 单个 for 的最大迭代次数 */
  maxIterations: 10000,
  /** 模板内最大 token 数 */
  maxTokens: 500,
} as const;

/* ================================================================
 * 错误
 * ============================================================ */

export class TemplateRenderError extends Error {
  /** 出错行（1-based）；0 =未知 */
  line: number;
  constructor(msg: string, line = 0) {
    super(line > 0 ? `第 ${line} 行：${msg}` : msg);
    this.line = line;
  }
}

/* ================================================================
 * 一、词法分析
 * ============================================================ */

type TokenType = "text" | "var" | "tag";

interface Token {
  type: TokenType;
  /** text：原文；var/tag：标签内部源码（不含定界符） */
  value: string;
  /** 所在行（1-based），用于错误定位 */
  line: number;
}

function lineAt(src: string, k: number): number {
  let n = 1;
  for (let i = 0; i < k && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/** 切分为 text / var / tag 三类 token。`{# #}` 注释在词法阶段直接丢弃。 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;

  const pushText = (end: number) => {
    if (end > textStart) {
      out.push({ type: "text", value: src.slice(textStart, end), line: lineAt(src, textStart) });
    }
  };

  while (i < n) {
    const open = src.indexOf("{", i);
    // 至少要能容纳「开定界2 字符 + 闭定界 2 字符」= 4
    if (open < 0 || open + 3 >= n) break;
    const c = src[open + 1];
    // 开定界符是**两个字符**：`{{` / `{%` / `{#`。
    // ⚠️ 别再加"第三个字符必须重复"的判断 —— 那样 `{{ x }}` 会因为
    //   第 3 个字符是空格而被当成普通文本，模板整条不生效（第一版踩过）。
    if (c !== "{" && c !== "%" && c !== "#") {
      i = open + 1; // 孤立的 { ，当普通文本
      continue;
    }
    const closeMark = c === "{" ? "}}" : c === "%" ? "%}" : "#}";
    const close = src.indexOf(closeMark, open + 2);
    if (close < 0) {
      throw new TemplateRenderError(
        `标签未闭合（缺少 ${closeMark}）`,
        lineAt(src, open),
      );
    }
    const line = lineAt(src, open);
    pushText(open);
    // 开定界符占 2 字符（`{{` / `{%` / `{#`），内容从 open+2 开始
    if (c === "{") {
      out.push({ type: "var", value: src.slice(open + 2, close).trim(), line });
    } else if (c === "%") {
      out.push({ type: "tag", value: src.slice(open + 2, close).trim(), line });
    }
    // c === "#"：注释，丢弃
    i = close + 2;
    textStart = i;
    if (out.length > LIMITS.maxTokens) {
      throw new TemplateRenderError(`标签数量超过上限 ${LIMITS.maxTokens}`, line);
    }
  }
  pushText(n);
  return out;
}

/* ================================================================
 * 二、语法树
 * ============================================================ */

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; expr: string; line: number }
  | { kind: "for"; varName: string; path: string[]; body: Node[]; line: number }
  | { kind: "if"; branches: Array<{ cond: string | null; body: Node[] }>; line: number };

const BLOCK_OPENERS = new Set(["for", "if", "elif", "else"]);

/** 解析 token 序列为 AST。遇到不匹配的闭合标签就抛错。 */
function parse(tokens: Token[]): Node[] {
  let i = 0;
  /**
   * 当前块嵌套深度（模块级，**不随 parseUntil 重置**）。
   *
   * 🔴 第一版把它写成 `parseUntil` 的局部变量 `let depth = 1`，
   *   每层递归都重置为 1 ⇒ 深度检查形同虚设，
   *   实测 11 层嵌套照样渲染成功。深度必须是跨递归共享的状态。
   */
  let depth = 0;

  function parseUntil(stopNames: string[]): { nodes: Node[]; stop: Token | null } {
    const nodes: Node[] = [];
    while (i < tokens.length) {
      const tk = tokens[i];
      if (tk.type === "text") {
        nodes.push({ kind: "text", text: tk.value });
        i++;
        continue;
      }
      if (tk.type === "var") {
        nodes.push({ kind: "var", expr: tk.value, line: tk.line });
        i++;
        continue;
      }
      // tag
      const name = tagName(tk);
      if (!name) {
        // 空标签：跳过（不当作未知标签报错，见 tagName 的注释）
        i++;
        continue;
      }
      // 🔴 判定顺序必须是「先看终止符，再看块头」。
      //   `else` / `elif` 既出现在 BLOCK_OPENERS 里（作为一个 if 分支的开头），
      //   又要能终止上一个分支的解析 —— 若先判块头，`else` 会被当成新块头递归，
      //   于是 `{% if %}A{% else %}B{% endif %}` 报「缺少 endif」。
      //   （第一版就踩了这个：if 链的三个分支全部报同一个错。）
      if (stopNames.includes(name)) {
        return { nodes, stop: tk };
      }
      if (name === "if" || name === "for") {
        if (depth >= LIMITS.maxDepth) {
          throw new TemplateRenderError(
            `块嵌套超过上限 ${LIMITS.maxDepth} 层`,
            tk.line,
          );
        }
        depth++;
        const node = parseBlock(tk, name);
        depth--;
        nodes.push(node);
        continue;
      }
      throw new TemplateRenderError(`未知标签 {{% ${name} %}}`, tk.line);
    }
    if (stopNames.length) {
      // 🔴 报「主终止符」而不是 stopNames[0]。
      //   if 块的分支体把 elif/else 也列为终止符（否则 else 会被当块头吃掉），
      //   于是 stopNames[0] 恒为 "elif" ⇒ `{% if %}x` 缺 endif 时
      //   会报「缺少 elif」—— 错误信息指向了错的标签，用户更困惑。
      //   约定：主终止符放在**最后**。
      throw new TemplateRenderError(`缺少 {{% ${stopNames[stopNames.length - 1]} %}}`);
    }
    return { nodes, stop: null };
  }

  function parseBlock(tk: Token, name: string): Node {
    i++; // 跳过块头
    if (name === "for") {
      const m = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(tk.value.trim());
      if (!m) {
        throw new TemplateRenderError(
          `for 语法应为 {%% for 项 in 列表 %%}，当前「${tk.value}」`,
          tk.line,
        );
      }
      const varName = m[1];
      // for 的列表也允许带过滤器（如 {% for a in list | reverse %}）——
      // 但过滤器的返回值是字符串，故只接受"纯路径"形式，避免误用。
      const path = parsePath(m[2]);
      const body = parseUntil(["endfor"]);
      if (!body.stop) throw new TemplateRenderError("for 缺少 {% endfor %}", tk.line);
      i++; // 跳过 endfor
      return { kind: "for", varName, path, body: body.nodes, line: tk.line };
    }
    // if / elif / else
    // 🔴 每一层分支体都必须把 elif / else / endif **全部**列为终止符。
    //   写成 parseUntil(["endif"]) 时，链中间的 {% else %} 不在终止符里
    //   ⇒ 被当新块头递归吃掉 ⇒ 最后走到 endif 才return，
    //   外层看 stop="endif" 以为整个 if 结束了 → 实际报「缺少 endif」。
    const branches: Array<{ cond: string | null; body: Node[] }> = [];
    // 🔴 用 `^if\b` 而不是 `^if\s+`：`{% if %}` 的 value 就是 "if"（后面没空格），
    //   `^if\s+` 匹配不掉 ⇒ parseCond 收到 "if" 这个非空串 ⇒ 缺条件也不报错。
    const cond0: string | null =
      name === "else" ? null : parseCond(tk.value.replace(/^if\b\s*/, ""), tk.line);
    let cond = cond0;
    for (;;) {
      // 分支体：遇到下一个 elif/else/endif 都停
      const body = parseUntil(["elif", "else", "endif"]);
      branches.push({ cond, body: body.nodes });
      if (!body.stop) throw new TemplateRenderError("if 缺少 {% endif %}", tk.line);
      const stopName = tagName(body.stop);
      if (stopName === "endif") {
        i++; // 跳过 endif
        break;
      }
      // elif / else：作为**下一个分支的开头**被消费
      cond = stopName === "else" ? null : parseCond(body.stop.value.replace(/^elif\b\s*/, ""), body.stop.line);
      i++; // 跳过 elif / else
    }
    return { kind: "if", branches, line: tk.line };
  }

  const { nodes, stop } = parseUntil([]);
  if (stop) throw new TemplateRenderError(`多余的{{% ${tagName(stop)} %}}`, stop.line);
  return nodes;
}

function tagName(tk: Token): string {
  const s = tk.value.trim();
  // 🔴 空标签（`{{ }}` / `{% %}`）不是错误 —— 模板里手滑多打一个标签很常见，
  //   直接崩掉整个导出体验很差。视为**无内容的噪声**，交给调用方跳过。
  if (!s) return "";
  const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(s);
  if (!m) throw new TemplateRenderError(`标签格式不合法「${tk.value}」`, tk.line);
  return m[1];
}

function parseCond(expr: string, line: number): string {
  const s = expr.trim();
  if (!s) throw new TemplateRenderError("if/elif 缺少条件", line);
  return s;
}

/* ================================================================
 * 三、安全取值与过滤器
 * ============================================================ */

const BLACKLIST = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 解析变量路径 `a.b.c` → 段数组。
 * @throws 变量名非法或命中黑名单
 */
export function parsePath(expr: string): string[] {
  const s = String(expr ?? "").trim();
  if (!s) throw new TemplateRenderError("变量名为空");
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(s)) {
    throw new TemplateRenderError(`变量名不合法：${s}`);
  }
  const segs = s.split(".").map((x) => x.trim());
  for (const seg of segs) {
    if (BLACKLIST.has(seg)) throw new TemplateRenderError(`不允许访问：${seg}`);
  }
  return segs;
}

/**
 * 按路径取值。🔴逐段 `hasOwnProperty` —— 不用 `in`、不直接 `obj[seg]`。
 */
export function lookup(data: any, segs: string[]): any {
  let cur = data;
  for (const seg of segs) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 最终输出的字符串化。🔴 关键：只做字符串转换，不过滤器、不再解析。 */
function toOutString(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(toOutString).join("");
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/** 解析引号包裹的参数列表：`"a", 'b'` → `["a","b"]` */
function parseArgs(argStr: string): string[] {
  const s = String(argStr ?? "").trim();
  if (!s) return [];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    const q = s[i];
    if (q === '"' || q === "'") {
      i++;
      let buf = "";
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
          // 🔴 必须把转义序列**还原成真实字符**，不能只把 `\` 丢掉。
          //   否则模板里写 '第一行\n第二行' 会得到 "第一行n第二行"（丢了反斜杠），
          //   blockquote / join 这类依赖换行的过滤器就废了。
          const next = s[i + 1];
          const simple: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            "\\": "\\",
            "'": "'",
            '"': '"',
          };
          buf += Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        buf += s[i++];
      }
      out.push(buf);
    } else {
      let buf = "";
      while (i < s.length && !/[\s,]/.test(s[i])) buf += s[i++];
      out.push(buf);
    }
  }
  return out;
}

/**
 * 求值一个「变量 + 过滤器链」表达式。
 * `expr` 形如 `book.title | default('未知') | upper`
 */
function evalExpr(expr: StringOrAny, scope: any, line: number): any {
  const parts = String(expr).split("|");
  const head = parts[0].trim();
  let cur = evalHead(head, scope, line);
  for (let k = 1; k < parts.length; k++) {
    const spec = parts[k].trim();
    if (!spec) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?$/.exec(spec);
    if (!m) throw new TemplateRenderError(`过滤器写法不合法「${spec}」`, line);
    if (!hasFilter(m[1])) throw new TemplateRenderError(`未知过滤器「${m[1]}」`, line);
    const fn: Filter = FILTERS[m[1]];
    cur = fn(cur, ...parseArgs(m[2] ?? ""));
  }
  return cur;
}

type StringOrAny = string;

/**
 * 求值表达式头部：字面量 / 变量路径 / 数字。
 *
 * 刻意**不支持下标**（`a[0]`）：那会引入数组索引与属性访问两套语义，
 * 且是注入面（`a[__proto__]`）。需要「第一条」时用 `{% for %}` 配 `if`，
 * 或让 `buildExportTemplateData` 预置 `first` / `last` 字段。
 */
function evalHead(head: string, scope: any, line: number): any {
  const s = head.trim();
  if (!s) return "";
  if (s.startsWith("'") || s.startsWith('"')) {
    return parseArgs(s)[0] ?? "";
  }
  // 纯数字字面量
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  // true / false
  if (s === "true") return true;
  if (s === "false") return false;
  return lookup(scope, parsePath(s));
}

function truthy(v: any): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * 条件求值。
 *
 * 支持：`x` / `not x` / `x == "s"` / `x != "s"` / 两侧可带过滤器。
 * ⚠️ **不支持数值比较与算术**（`>` `<` `+`）—— 会重演表达式求值的复杂度，
 *   而实际需求（有没有笔记 / 有没有高亮色）用真值判定就够。
 */
function evalCond(expr: string, scope: any, line: number): boolean {
  let s = String(expr).trim();
  if (!s) return false;
  let negate = false;
  while (/^not\s+/.test(s)) {
    negate = !negate;
    s = s.replace(/^not\s+/, "").trim();
  }
  const m = /^(.+?)(==|!=)\s*(.+)$/.exec(s);
  let v: boolean;
  if (m) {
    const left = operand(m[1], scope, line);
    const right = operand(m[3], scope, line);
    const eq = toOutString(left).trim() === toOutString(right).trim();
    v = m[2] === "==" ? eq : !eq;
  } else {
    v = truthy(operand(s, scope, line));
  }
  return negate ? !v : v;
}

function operand(expr: string, scope: any, line: number): any {
  const s = expr.trim();
  if (!s) return "";
  if (s.startsWith("'") || s.startsWith('"')) return parseArgs(s)[0] ?? "";
  return evalExpr(s, scope, line);
}

/* ================================================================
 * 四、渲染
 * ============================================================ */

interface RenderState {
  out: string[];
  size: number;
}

function renderNodes(nodes: Node[], scope: any, st: RenderState): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        emit(st, node.text);
        break;
      case "var":
        // 🔴 变量值经 toOutString 后直接进输出，**不再解析**
        emit(st, toOutString(evalExpr(node.expr, scope, node.line)));
        break;
      case "for": {
        const list = lookup(scope, node.path);
        const arr = Array.isArray(list) ? list : [];
        if (arr.length > LIMITS.maxIterations) {
          throw new TemplateRenderError(
            `for 迭代 ${arr.length} 次，超过上限 ${LIMITS.maxIterations}`,
            node.line,
          );
        }
        for (const item of arr) {
          // 每项一个浅层作用域；不改动外层（避免循环内赋值污染）
          renderNodes(node.body, { ...scope, [node.varName]: item }, st);
        }
        break;
      }
      case "if": {
        for (const br of node.branches) {
          if (br.cond === null || evalCond(br.cond, scope, node.line)) {
            renderNodes(br.body, scope, st);
            break;
          }
        }
        break;
      }
    }
  }
}

function emit(st: RenderState, s: string): void {
  st.size += s.length;
  if (st.size > LIMITS.maxOutput) {
    throw new TemplateRenderError(
      `渲染结果超过 ${Math.round(LIMITS.maxOutput / 1024 / 1024)} MB 上限（可能有超长循环）`,
    );
  }
  st.out.push(s);
}

/* ================================================================
 * 公共 API
 * ============================================================ */

/** 编译（词法 + 语法）。失败抛 `TemplateRenderError`。 */
export function compileTemplate(tpl: string): Node[] {
  return parse(tokenize(String(tpl ?? "")));
}

/**
 * 渲染模板。
 * @throws TemplateRenderError 语法错、未知过滤器、越限 —— **永不返回错误文本**。
 */
export function renderTemplate(tpl: string, data: any): string {
  const nodes = compileTemplate(tpl);
  const st: RenderState = { out: [], size: 0 };
  renderNodes(nodes, data, st);
  return st.out.join("");
}

export interface ValidateOk {
  ok: true;
}
export interface ValidateErr {
  ok: false;
  message: string;
  line?: number;
}

/**
 * 校验模板（不改数据结构、不写任何东西）。
 *
 * 用**样例数据**试渲染一次：只做语法校验不够 ——
 * `{{ a | datey }}` 语法合法但过滤器不存在，只有真跑一遍才暴露。
 */
export function validateTemplate(tpl: string, sampleData: any): ValidateOk | ValidateErr {
  try {
    renderTemplate(tpl, sampleData);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const line = e instanceof TemplateRenderError ? e.line : undefined;
    return line ? { ok: false, message: msg, line } : { ok: false, message: msg };
  }
}
