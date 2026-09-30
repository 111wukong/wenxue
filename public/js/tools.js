/* 工具集
 *
 * 三层架构的中间层：模型想「做点什么」时，落到这里。
 *
 * ── 这个文件里最重要的不是工具本身，是**白名单** ─────────────────
 * 多角色 agent 集群最经典的失败模式是「角色趋同」：
 * 提示词里写「你是个聪明学生」「你基础不好」，模型会说出几乎一样的话。
 * 解法不是把形容词写得更狠，而是三样结构性差异：
 *
 *   1. 信息可见性递减 —— 每个角色拿到的资料量不同（curriculum.materialFor）
 *   2. 工具白名单隔离 —— 学生**没有**「写完整解答」这个能力
 *   3. 错误来源真实   —— 后进生的错来自题库干扰项，不是模型编的
 *
 * 第 2 条只能用工具表约束。提示词约束不住 —— 一旦学生 agent 拿到了
 * write_steps，它就会开始写完整解法，慢慢退化成第二个老师。
 * 所以 TEACHER_ONLY 那条边界**必须写成断言**，见文件末尾的自检。
 *
 * ── 为什么不用 eval ─────────────────────────────────────────────
 * 表达式来自模型输出。用 eval / new Function 的话，模型输出
 * `process.exit()` 就是一次任意代码执行。自己写递归下降 parser
 * 大约一百行，换来的是「最坏情况只是一个算错的数」。
 */

import { findPoint, materialFor, distractorAt, POINTS } from './curriculum.js';
import * as store from './store.js';

/* ============================================================
   表达式求值器（无 eval）
   ============================================================
   支持的语法：+ - * / ^、括号、逗号、隐式乘法、一元正负、函数、常数。
   两个必须做对的地方（做错了会静默算错，很难发现）：
     · `-x^2` 必须是 `-(x^2)`，不是 `(-x)^2`
     · `x^2^3` 必须是 `x^(2^3)`，右结合
   ============================================================ */

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign,
};
const FUNCS2 = {
  pow: Math.pow,
  atan2: Math.atan2,
  min: Math.min,
  max: Math.max,
  mod: (a, b) => a % b,
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

function tokenize(src) {
  const s = String(src);
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }

    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      // 科学计数法 1e-3 / 2.5E6
      if (s[j] === 'e' || s[j] === 'E') {
        let k = j + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        if (/[0-9]/.test(s[k] || '')) {
          while (k < s.length && /[0-9]/.test(s[k])) k++;
          j = k;
        }
      }
      const raw = s.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new SyntaxError(`不是合法的数字：${raw}`);
      toks.push({ t: 'num', v, raw });
      i = j; continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({ t: 'id', v: s.slice(i, j) });
      i = j; continue;
    }

    if ('+-*/^(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new SyntaxError(`表达式里有不认识的字符「${c}」`);
  }
  toks.push({ t: 'end' });
  return toks;
}

/**
 * 编译一个表达式。
 * @param {string} src
 * @param {string[]} varNames  允许出现的参数名（自变量 x 总是允许）
 * @returns {(x:number, scope?:object) => number}
 * @throws {Error} 任何语法/符号问题都在**编译期**抛出，而不是等到求值时
 *   —— 画图时每个采样点抛一次异常，报错会淹没在噪声里。
 */
export function compile(src, varNames) {
  const vars = Array.isArray(varNames) ? varNames.map(String) : [];
  const varSet = new Set(vars);

  /* ★ 校验放编译期：参数名不许叫 x、不许撞内置常数/函数名 */
  for (const v of vars) {
    if (v === 'x') throw new Error('参数名不能叫 x（x 是自变量）');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`参数名不合法：${v}`);
    if (Object.prototype.hasOwnProperty.call(CONSTS, v)) throw new Error(`参数名「${v}」和内置常数重名`);
    if (FUNCS[v] || FUNCS2[v]) throw new Error(`参数名「${v}」和内置函数重名`);
  }

  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isTok = (t) => toks[pos].t === t;
  const eat = (t) => {
    if (toks[pos].t !== t) {
      const got = toks[pos].t === 'end' ? '表达式结束' : `「${toks[pos].v ?? toks[pos].t}」`;
      throw new SyntaxError(`这里应该是「${t}」，实际是${got}`);
    }
    pos++;
  };

  function parseExpr() {
    let left = parseTerm();
    while (isTok('+') || isTok('-')) {
      const op = toks[pos].t; pos++;
      const right = parseTerm();
      const l = left, r = right;
      left = op === '+' ? (sc) => l(sc) + r(sc) : (sc) => l(sc) - r(sc);
    }
    return left;
  }

  function startsAtom() {
    const t = toks[pos].t;
    return t === 'num' || t === 'id' || t === '(';
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      if (isTok('*') || isTok('/')) {
        const op = toks[pos].t; pos++;
        const right = parseUnary();
        const l = left, r = right;
        left = op === '*' ? (sc) => l(sc) * r(sc) : (sc) => l(sc) / r(sc);
      } else if (startsAtom()) {
        /* 隐式乘法：2x、3sin(x)、2(x+1)、x(x-1)。
         * 在 term 层做而不是在 atom 层，这样 `x^2y` 会读成 (x^2)*y。 */
        const right = parseUnary();
        const l = left, r = right;
        left = (sc) => l(sc) * r(sc);
      } else break;
    }
    return left;
  }

  function parseUnary() {
    // ★ 先吃掉一元负号，再交给 parsePower —— 这样 -x^2 = -(x^2)
    if (isTok('-')) { pos++; const inner = parseUnary(); return (sc) => -inner(sc); }
    if (isTok('+')) { pos++; return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (isTok('^')) {
      pos++;
      // ★ 指数位回调 parseUnary，保证右结合：x^2^3 = x^(2^3)
      const exp = parseUnary();
      return (sc) => Math.pow(base(sc), exp(sc));
    }
    return base;
  }

  function parseAtom() {
    const tk = peek();

    if (tk.t === 'num') { pos++; const v = tk.v; return () => v; }

    if (tk.t === '(') {
      pos++;
      const inner = parseExpr();
      eat(')');
      return inner;
    }

    if (tk.t === 'id') {
      pos++;
      const name = tk.v;
      const isVar = name === 'x' || varSet.has(name);
      const isConst = Object.prototype.hasOwnProperty.call(CONSTS, name);
      const fn1 = FUNCS[name];
      const fn2 = FUNCS2[name];

      /* ★ 顺序要紧：先判「这是不是变量」。
       *   反过来先看后面有没有 `(` 的话，`x(x-1)` 会被当成函数调用 `x(...)`，
       *   报出「没有这个函数 x」—— 而它明明是隐式乘法。
       *   变量名在编译期已经保证不会和常数/函数重名，所以这里不会误判。 */
      if (isVar) return (sc) => {
        const v = sc[name];
        return typeof v === 'number' ? v : NaN;
      };

      if (isConst) { const v = CONSTS[name]; return () => v; }

      if (fn1 || fn2) {
        if (!isTok('(')) throw new SyntaxError(`${name} 是函数，后面要跟括号`);
        pos++;
        const args = [];
        if (!isTok(')')) {
          args.push(parseExpr());
          while (isTok(',')) { pos++; args.push(parseExpr()); }
        }
        eat(')');
        if (fn1) {
          if (args.length !== 1) throw new SyntaxError(`${name} 只接受 1 个参数，给了 ${args.length} 个`);
          const a = args[0];
          return (sc) => fn1(a(sc));
        }
        if (args.length < 2) throw new SyntaxError(`${name} 需要至少 2 个参数`);
        const as = args;
        return (sc) => fn2(...as.map((f) => f(sc)));
      }

      throw new SyntaxError(`表达式里用了没声明的符号「${name}」`);
    }

    if (tk.t === 'end') throw new SyntaxError('表达式不完整');
    throw new SyntaxError(`表达式里出现了意外的「${tk.v ?? tk.t}」`);
  }

  const ast = parseExpr();
  if (!isTok('end')) {
    const tk = toks[pos];
    throw new SyntaxError(`表达式在「${tk.v ?? tk.t}」之后有多余的内容`);
  }

  return function run(x, scope) {
    const sc = { x: typeof x === 'number' ? x : NaN };
    /* ★ scope 只采纳**声明过**的参数名。
     *   照单全收的话，一个叫 pi 或 e 的 key 能把内置常数顶掉，
     *   而那是调用方（模型）完全够得着的输入。 */
    if (scope && typeof scope === 'object') {
      for (const k of vars) {
        const v = scope[k];
        if (v !== undefined) sc[k] = Number(v);
      }
    }
    return ast(sc);
  };
}

/** 采样。返回 [x, y|null] 数组；不连续处用 null 标记，让渲染层断开路径。 */
export function samplePoints(fn, xmin, xmax, n, scope) {
  const pts = [];
  const N = Math.max(8, Math.min(1200, Number(n) || 240));
  for (let i = 0; i <= N; i++) {
    const x = xmin + ((xmax - xmin) * i) / N;
    let y;
    try { y = fn(x, scope); } catch { y = NaN; }
    if (!Number.isFinite(y) || Math.abs(y) > 1e5) y = null;
    pts.push([round6(x), y === null ? null : round6(y)]);
  }
  return pts;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/** 2%–98% 分位裁剪 + 留白。不用 min/max 是因为一个极点会把整张图压成一条线。 */
function envelope(values, pad = 0.12) {
  const ys = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!ys.length) return { ymin: -1, ymax: 1 };
  const lo = ys[Math.floor(ys.length * 0.02)];
  const hi = ys[Math.min(ys.length - 1, Math.ceil(ys.length * 0.98))];
  let span = hi - lo;
  if (!(span > 0)) { span = Math.max(1, Math.abs(hi) * 0.5); }
  const ymin = lo - span * pad;
  const ymax = hi + span * pad;
  return { ymin: round6(ymin), ymax: round6(ymax) };
}

/* ============================================================
   黑板动作族
   ============================================================
   ★ 所有动作返回**同一个形状**：{ type:'board', item:{ kind, ... } }
     渲染层只认 kind。别让某个动作返回 { type:'svg' } 走特例分支 ——
     后面每加一种动作都要改渲染层，加三种之后渲染层就没法看了。
   ============================================================ */

function board(kind, rest) {
  return { type: 'board', item: { kind, ...rest } };
}

/** highlight 不是一块内容，是打在已有块上的光。它**不占黑板块数的号**。
 *
 *  ★ 这个常量是**两个地方的唯一口径**：
 *    · 工具的 highlight 在哪些块里找目标
 *    · UI 的增量动画记账数几块
 *    两边口径必须一致。把 page / clear 也算进来的话，计数会比实际多，
 *    新块的起点算错，**该播动画的块不播** —— 静默失效，比报错难查得多。 */
export const BOARD_KINDS = ['graph', 'steps', 'latex', 'page', 'clear', 'highlight'];
export const BOARD_BLOCK_KINDS = ['graph', 'steps', 'latex'];

/** 黑板渲染口径的唯一来源。记账口径必须和它一致，否则动画会错位。 */
export function boardRenderable(items) {
  return (items || []).filter((it) => it && BOARD_BLOCK_KINDS.includes(it.kind));
}

/* ============================================================
   工具表
   ============================================================ */

function ok(data, render) { return { ok: true, data: data ?? null, render: render ?? null }; }
function bad(error) { return { ok: false, data: null, render: null, error: String(error) }; }

const TABLE = {
  /* ---------------- 资料类（按角色裁剪） ---------------- */
  look_up: {
    description: '查一个考点的资料。返回的内容量取决于你是谁——同一个考点，不同角色查到的详略不同。',
    parameters: {
      type: 'object',
      properties: {
        point: { type: 'string', description: '考点名或关键词，例如「罗尔定理」「特征值」' },
      },
      required: ['point'],
    },
    run(args, ctx) {
      const p = findPoint(args.point);
      if (!p) {
        const names = POINTS.map((x) => x.name).join('、');
        return bad(`没有找到考点「${args.point}」。目前有：${names}`);
      }
      return ok(materialFor(p, ctx.depth), null);
    },
  },

  /* ---------------- 计算类 ---------------- */
  calc: {
    description: '算一个表达式的值。**不要自己心算**——需要具体数字时一律用它，你的心算经常错。',
    parameters: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: '表达式，例如 "1/2 + 3*4"、"sqrt(2)"、"sin(pi/6)"' },
      },
      required: ['expr'],
    },
    run(args) {
      const expr = String(args.expr || '').trim();
      if (!expr) return bad('expr 不能为空');
      let fn;
      try { fn = compile(expr, []); } catch (e) { return bad(`表达式有问题：${e.message}`); }
      const v = fn(0);
      if (!Number.isFinite(v)) return bad(`表达式算不出有限值（${expr}）`);
      return ok({ expr, value: round6(v) }, null);
    },
  },

  /* ---------------- 黑板：画图 ---------------- */
  draw_graph: {
    description: '在黑板上画函数图像。曲线会从左到右描出来。可以带参数（如 a、b），界面上能拖动滑块实时看曲线怎么变。',
    parameters: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: '关于 x 的表达式，例如 "a*x^2 - 2*x"、"sin(x)/x"' },
        xmin: { type: 'number', description: 'x 轴左端，默认 -6' },
        xmax: { type: 'number', description: 'x 轴右端，默认 6' },
        title: { type: 'string', description: '这块图的标题，例如 "f(x)=x²−2x"' },
        params: {
          type: 'array',
          description: '可拖动参数。每个 {name, min, max, value}。最多 3 个。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              min: { type: 'number' },
              max: { type: 'number' },
              value: { type: 'number' },
            },
            required: ['name'],
          },
        },
      },
      required: ['expr'],
    },
    run(args) {
      const expr = String(args.expr || '').trim();
      if (!expr) return bad('draw_graph 需要 expr');

      const rawParams = Array.isArray(args.params) ? args.params.slice(0, 3) : [];
      const params = [];
      for (const p of rawParams) {
        if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
        const name = p.name.trim();
        const min = Number.isFinite(Number(p.min)) ? Number(p.min) : -3;
        const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 3;
        if (!(max > min)) return bad(`参数 ${name} 的 max 必须大于 min`);
        let value = Number.isFinite(Number(p.value)) ? Number(p.value) : (min + max) / 2;
        value = Math.min(max, Math.max(min, value));
        params.push({ name, min: round6(min), max: round6(max), value: round6(value) });
      }
      // 名字重复会让 scope 互相覆盖
      if (new Set(params.map((p) => p.name)).size !== params.length) return bad('参数名有重复');

      let fn;
      try { fn = compile(expr, params.map((p) => p.name)); } catch (e) { return bad(`表达式有问题：${e.message}`); }

      let xmin = Number.isFinite(Number(args.xmin)) ? Number(args.xmin) : -6;
      let xmax = Number.isFinite(Number(args.xmax)) ? Number(args.xmax) : 6;
      if (!(xmax > xmin)) return bad('xmax 必须大于 xmin');
      if (xmax - xmin > 1e4) { xmin = -6; xmax = 6; }

      const scopeOf = (p, pick) => {
        const sc = {};
        for (const q of p) sc[q.name] = pick(q);
        return sc;
      };
      const baseScope = scopeOf(params, (q) => q.value);

      /* ★ y 轴范围预先算好并钉死。
       *   让每个参数各取遍 min / max 端点，把结果并起来求包络，重绘时复用。
       *   不这么做的话坐标轴会跟着参数一起缩放，整张图随手指抖，
       *   反而看不出参数到底改变了什么。 */
      const allY = [];
      const combos = params.length ? 2 ** params.length : 1;
      for (let mask = 0; mask < combos; mask++) {
        const sc = {};
        params.forEach((q, i) => { sc[q.name] = (mask >> i) & 1 ? q.max : q.min; });
        for (const [, y] of samplePoints(fn, xmin, xmax, 60, sc)) {
          if (y !== null) allY.push(y);
        }
      }
      for (const [, y] of samplePoints(fn, xmin, xmax, 240, baseScope)) {
        if (y !== null) allY.push(y);
      }
      const { ymin, ymax } = envelope(allY);

      const samples = samplePoints(fn, xmin, xmax, 320, baseScope);

      const item = board('graph', {
        expr,
        title: String(args.title || `y = ${expr}`).slice(0, 80),
        xmin: round6(xmin), xmax: round6(xmax), ymin, ymax,
        params,
        samples,
      });

      // ★ data 给模型看，要精简；samples 有几百个点，绝不能塞进去白烧 token
      return ok({
        expr, xmin: round6(xmin), xmax: round6(xmax), ymin, ymax,
        params: params.map((p) => ({ name: p.name, min: p.min, max: p.max, value: p.value })),
        note: '图像已画在黑板上。',
      }, item);
    },
  },

  /* ---------------- 黑板：解题步骤（老师专用） ---------------- */
  write_steps: {
    description: '在黑板上写出解题步骤，最多 8 条。逐条错开落下。这是「完整解答」，只有老师能用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题，例如 "求 f′(1)"' },
        steps: { type: 'array', items: { type: 'string' }, description: '每一步一行，最多 8 条' },
      },
      required: ['steps'],
    },
    run(args) {
      const raw = Array.isArray(args.steps) ? args.steps : [args.steps];
      const steps = raw.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 8);
      if (!steps.length) return bad('steps 不能为空');
      const title = String(args.title || '').trim().slice(0, 60);
      const item = board('steps', { title, steps });
      return ok({ title, count: steps.length, note: `已写下 ${steps.length} 步。` }, item);
    },
  },

  /* ---------------- 黑板：公式（老师专用） ---------------- */
  write_latex: {
    description: '在黑板上排一个公式。$ 和 $$ 定界符会自动剥掉，直接写 LaTeX 内容即可。',
    parameters: {
      type: 'object',
      properties: {
        tex: { type: 'string', description: 'LaTeX 内容，例如 "f\'(\\xi)=0"' },
        caption: { type: 'string', description: '公式下方的说明，可省' },
      },
      required: ['tex'],
    },
    run(args) {
      const tex = String(args.tex || '').replace(/^\s*\$\$?|\$\$?\s*$/g, '').trim();
      if (!tex) return bad('tex 不能为空');
      const item = board('latex', { tex: tex.slice(0, 400), caption: String(args.caption || '').slice(0, 80) });
      return ok({ tex, note: '公式已排上黑板。' }, item);
    },
  },

  /* ---------------- 黑板：高亮（老师 + 学生） ---------------- */
  highlight: {
    description: '把黑板上已有的某一块圈出来。按**文字**匹配（写目标块里出现过的一段字），不是按坐标。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要圈出的那段文字，例如 "f(a)=f(b)"' },
        why: { type: 'string', description: '为什么圈它，一句话' },
      },
      required: ['target'],
    },
    run(args, ctx) {
      const target = String(args.target || '').trim();
      if (!target) return bad('target 不能为空');
      const items = (ctx.session && ctx.session.board) || [];
      // 按文字匹配已有块 —— 不必上 DOM，indexOf 就够
      const hit = boardRenderable(items).find((it) => blockText(it).includes(target));
      if (!hit) {
        return bad(`黑板上没有包含「${target}」的内容。先看看已经画了什么，再圈。`);
      }
      const item = board('highlight', { target, why: String(args.why || '').slice(0, 80), hits: hit.kind });
      return ok({ target, on: hit.kind, note: '已圈出。' }, item);
    },
  },

  /* ---------------- 黑板：翻页 / 擦除（老师专用） ---------------- */
  new_page: {
    description: '在黑板上开新的一页。**旧内容会保留**，可以翻回去看。想删掉才用 clear_board。',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: '这一页的标题' } },
      required: [],
    },
    run(args) {
      const title = String(args.title || '').trim().slice(0, 60);
      return ok({ title, note: '已翻到新的一页。' }, board('page', { title }));
    },
  },

  clear_board: {
    description: '把黑板擦干净。**之前写的内容会永久消失**，用户翻不回去。只想接着写就用 new_page。',
    parameters: { type: 'object', properties: {}, required: [] },
    run() {
      return ok({ note: '黑板已擦净。' }, board('clear', {}));
    },
  },

  /* ---------------- 学情类（老师专用） ---------------- */
  get_mistakes: {
    description: '看这个学习者**真实答错过的题**（含他当时写的答案）。这是你针对性讲评的依据。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多几条，默认 5' } },
      required: [],
    },
    run(args) {
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const rows = store.recentMistakes(limit).map((m) => {
        const p = findPoint(m.pointId);
        return { point: p ? p.name : m.pointId, pointId: m.pointId, 他写的答案: m.answer, qid: m.qid };
      });
      if (!rows.length) return ok({ 错题: [], note: '他还没有答错过题。' });
      return ok({ 错题: rows });
    },
  },

  query_weakness: {
    description: '看他的薄弱考点排名（按累计错题数排序）。用它决定这节课先讲什么。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多几条，默认 5' } },
      required: [],
    },
    run(args) {
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const rows = store.weakPoints(limit).map((w) => {
        const p = findPoint(w.pointId);
        return {
          考点: p ? p.name : w.pointId,
          pointId: w.pointId,
          正确率: Math.round(w.accuracy * 100) + '%',
          累计错: w.wrong,
          最近: (w.last || []).map((v) => (v ? '对' : '错')).join(''),
        };
      });
      if (!rows.length) return ok({ 薄弱考点: [], note: '还没有足够的作答记录。' });
      return ok({ 薄弱考点: rows });
    },
  },

  /* ---------------- 出题（老师专用） ---------------- */
  pose_question: {
    description: '留一道题让学习者**现在动手做**。调用之后整堂课会暂停等他作答，所以一轮最多调一次，而且要留在他够得着的难度上。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '题目原文' },
        hint: { type: 'string', description: '只在他卡住时给的最小提示，可省' },
        pointId: { type: 'string', description: '这道题考哪个考点' },
      },
      required: ['question'],
    },
    run(args, ctx) {
      const question = String(args.question || '').trim();
      if (!question) return bad('question 不能为空');
      const p = findPoint(args.pointId || args.question);
      const rec = { question: question.slice(0, 400), hint: String(args.hint || '').slice(0, 200), pointId: p ? p.id : null };
      // 记录到会话上，由编排层决定「何时真的挂起」——挂起只在一处实现
      if (ctx.session) ctx.session.pendingQuestion = rec;
      return ok({ posed: true, pointId: rec.pointId, note: '题已留出，接下来会等他作答。' });
    },
  },

  /* ---------------- 学生专用 ---------------- */
  recall_mistake: {
    description: '回忆你自己在这个考点上「卡住的地方」——就是你最容易犯的那个错。返回的是一条真实的错误思路，不是正确答案。',
    parameters: {
      type: 'object',
      properties: { point: { type: 'string', description: '考点名' } },
      required: ['point'],
    },
    run(args, ctx) {
      const p = findPoint(args.point);
      if (!p) return bad(`没有找到考点「${args.point}」`);
      // ★ 一人分一个干扰项：按角色序号索引，min 夹住不越界。
      //   这样三个人踩的是**不同的**坑，讨论才有张力。
      const d = distractorAt(p, ctx.distractorIndex);
      if (!d) return ok({ point: p.name, 想法: null, note: '这个考点你还没什么想法。' });
      return ok({
        point: p.name,
        你当时是这么想的: d.text,
        note: '这是你的想法，不是标准答案。请用你自己的话把它说出来，并说清你为什么这么想。',
      });
    },
  },

  raise_hand: {
    description: '举手，让老师把话头交给你。有疑问或者不同意别人时用它。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '一句话说清你要问什么' } },
      required: ['reason'],
    },
    run(args, ctx) {
      const reason = String(args.reason || '').trim().slice(0, 120);
      if (!reason) return bad('reason 不能为空');
      if (ctx.session) ctx.session.pendingHand = { role: ctx.role, reason };
      return ok({ raised: true, reason });
    },
  },

  pass: {
    description: '弃权，这一轮不发言。真的没想法时用它，比硬编一句好。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '为什么说不上来，可省' } },
      required: [],
    },
    run(args, ctx) {
      if (ctx.session) ctx.session.passed = (ctx.session.passed || 0) + 1;
      return ok({ passed: true, reason: String(args.reason || '').slice(0, 80) });
    },
  },
};

/* 渲染层要知道每块黑板内容是什么文字，highlight 才能按文字匹配。 */
export function blockText(item) {
  if (!item) return '';
  if (item.kind === 'graph') return `${item.title || ''} ${item.expr || ''}`;
  if (item.kind === 'steps') return `${item.title || ''} ${(item.steps || []).join(' ')}`;
  if (item.kind === 'latex') return `${item.tex || ''} ${item.caption || ''}`;
  if (item.kind === 'page') return item.title || '';
  return '';
}

/* ============================================================
   ★ 角色白名单
   ============================================================
   显式列举，不用 Object.keys(TABLE).map(toSchema)。
   后者会让老师也拿到「举手 / 弃权」——语义错误，而且会在
   断言「工具数量」的测试里静默破功。
   ============================================================ */

/** 写完整解答的能力。学生**没有**这个能力 —— 会画图不等于会写解法。 */
export const TEACHER_ONLY = ['write_steps', 'write_latex', 'clear_board', 'new_page', 'pose_question', 'get_mistakes', 'query_weakness'];

/** 学生专用：老师不该「举手」也不该「弃权」。 */
export const STUDENT_ONLY = ['raise_hand', 'pass', 'recall_mistake'];

/** 两边都有，但**数据源按角色裁剪**。 */
export const SHARED = ['look_up', 'calc', 'draw_graph', 'highlight'];

export const TEACHER_TOOLS = [...SHARED, ...TEACHER_ONLY];
export const STUDENT_TOOLS = [...SHARED, ...STUDENT_ONLY];

/* 自检：这条边界必须硬。提示词约束不住，只有工具表能约束。
 * 写成模块级断言而不是测试里的一句 —— 测试可能被跳过，import 不会。 */
for (const t of STUDENT_TOOLS) {
  if (TEACHER_ONLY.includes(t)) {
    throw new Error(`工具白名单配置错误：${t} 是老师专用，不该出现在学生白名单里`);
  }
}
for (const t of TEACHER_TOOLS) {
  if (STUDENT_ONLY.includes(t)) {
    throw new Error(`工具白名单配置错误：${t} 是学生专用，不该出现在老师白名单里`);
  }
  if (!TABLE[t]) throw new Error(`工具白名单里有一个不存在的工具：${t}`);
}
for (const t of STUDENT_TOOLS) {
  if (!TABLE[t]) throw new Error(`工具白名单里有一个不存在的工具：${t}`);
}

/** 学生不该有能力「写完整解答」。 */
export function assertStudentCannotWriteSolution() {
  const offenders = STUDENT_TOOLS.filter((t) => TEACHER_ONLY.includes(t));
  if (offenders.length) throw new Error(`学生白名单里出现了写解答类工具：${offenders.join(', ')}`);
  return true;
}

/* ============================================================
   对外接口
   ============================================================ */

function toSchema(name) {
  const t = TABLE[name];
  return {
    type: 'function',
    function: { name, description: t.description, parameters: t.parameters },
  };
}

export function schemaFor(role) {
  const list = role === 'teacher' ? TEACHER_TOOLS : STUDENT_TOOLS;
  return list.map(toSchema);
}

export function toolNamesFor(role) {
  return role === 'teacher' ? [...TEACHER_TOOLS] : [...STUDENT_TOOLS];
}

/**
 * 造一个角色化的执行上下文。
 *
 * ★ 这个包装是「结构性无知」真正生效的地方。
 *   如果调用方传的是原始 ctx，工具内部就拿不到裁剪函数，
 *   角色差异**直接失效**（真踩过：提示词截了、工具没截，结果后进生
 *   照样查到了完整定义，四个人说话一模一样）。
 */
export function makeCtx({ role, depth, session, distractorIndex = 0 }) {
  return { role, depth, session, distractorIndex };
}

/**
 * 执行一个工具。
 *
 * @param {string} name
 * @param {object} args      模型给的参数
 * @param {object} ctx       makeCtx() 的产物
 * @param {string} role      用于白名单校验
 */
export function execute(name, args, ctx, role) {
  const allowed = role === 'teacher' ? TEACHER_TOOLS : STUDENT_TOOLS;
  if (!allowed.includes(name)) {
    // 越权调用是**结构性**问题，不是模型调皮 —— 必须拒绝并让它看见
    return bad(`工具 ${name} 不在你的可用清单里。你只能用：${allowed.join('、')}`);
  }
  const t = TABLE[name];
  if (!t) return bad(`没有这个工具：${name}`);
  try {
    return t.run(args && typeof args === 'object' ? args : {}, ctx || makeCtx({ role, depth: 'c' }));
  } catch (e) {
    // 工具内部异常不能让整节课挂掉
    return bad(`工具 ${name} 执行出错：${e.message}`);
  }
}

/** 给 UI 展示：这个角色手里有哪些工具。 */
export function describeTools(role) {
  return (role === 'teacher' ? TEACHER_TOOLS : STUDENT_TOOLS).map((n) => ({
    name: n,
    description: TABLE[n].description,
    teacherOnly: TEACHER_ONLY.includes(n),
  }));
}
