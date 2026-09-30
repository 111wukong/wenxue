/* LaTeX 渲染（零依赖）
 *
 * ── 为什么不用 KaTeX ────────────────────────────────────────────
 * KaTeX 要从 CDN 拉，一来破掉「零依赖 / 双击可开」，二来离线就用不了。
 * 而这个应用要排的公式其实只有考研讲义里最常见的那十几种，
 * 自己写一个够用的子集，代价是八十行，收益是永远能打开。
 *
 * ── 一个必须遵守的顺序 ──────────────────────────────────────────
 * 先 escapeHtml，再做替换。反过来的话，用户/模型输入里的 `<script>`
 * 会被当成标签塞进 DOM。
 */

const SYM = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏', lim: 'lim',
  to: '→', rightarrow: '→', longrightarrow: '⟶', Rightarrow: '⇒',
  leftarrow: '←', leftrightarrow: '↔', mapsto: '↦',
  infty: '∞', pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', propto: '∝',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃',
  cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  partial: '∂', nabla: '∇', prime: '′',
  ldots: '…', cdots: '⋯', dots: '…', quad: ' ', qquad: '　', ',': ' ', ';': ' ', ' ': ' ',
  '\\': ' ', '{': '{', '}': '}',
};

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把一小段 LaTeX 变成 HTML。
 * 支持的子集：\frac \dfrac \sqrt ^{} _{} \text \left \right 常用希腊字母与算符。
 * 不支持的写法会**原样保留**（宁可显示成 `\begin{matrix}` 也不要显示成空白）。
 */
export function renderLatex(src) {
  return renderLatexUnsafe(escapeHtml(src));
}

/**
 * 同上，但**输入必须是已经转义过的**。
 *
 * 这个变体存在的原因是：气泡正文需要「先整体转义，再把 $...$ 里的内容当公式渲染」。
 * 如果对整串调 renderLatex，公式外那部分的转义会被做两遍，
 * `a < b` 会显示成 `a &lt; b`。
 */
export function renderLatexUnsafe(escapedSrc) {
  let s = String(escapedSrc ?? '');

  // 定界符与位置修饰符
  s = s.replace(/\$\$?/g, '');
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*/g, '');
  s = s.replace(/\\displaystyle|\\limits/g, '');
  s = s.replace(/\\!/g, '').replace(/\\,/g, ' ');
  s = s.replace(/\\;/g, ' ').replace(/\\:/g, ' ');

  // \text{...} —— 里面的东西按普通文字处理，不能再被后面的规则动
  s = s.replace(/\\text\s*\{([^{}]*)\}/g, '<span class="lx-txt">$1</span>');
  s = s.replace(/\\mathrm\s*\{([^{}]*)\}/g, '<span class="lx-txt">$1</span>');

  /* 分式：从内往外剥。嵌套 \frac{\frac{a}{b}}{c} 需要多轮。
   * 循环上限是防止畸形输入把浏览器卡死（比如一千层嵌套）。 */
  for (let i = 0; i < 8 && s.indexOf('\\frac') >= 0; i++) {
    s = s.replace(
      /\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      (m, a, b) => `<span class="lx-frac"><span class="lx-num">${a}</span><span class="lx-den">${b}</span></span>`,
    );
  }

  // 根号
  for (let i = 0; i < 4 && s.indexOf('\\sqrt') >= 0; i++) {
    s = s.replace(
      /\\sqrt\s*\{([^{}]*)\}/g,
      (m, a) => `<span class="lx-sqrt"><span class="lx-radical">√</span><span class="lx-rad">${a}</span></span>`,
    );
  }

  // 上标 / 下标（先花括号形式，再单字符形式）
  s = s.replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>');
  s = s.replace(/\^([A-Za-z0-9+\-])/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>');
  s = s.replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');

  // 希腊字母与算符
  s = s.replace(/\\([A-Za-z]+|[,;:! ]|\{|\}|\\)/g, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(SYM, name)) return SYM[name];
    return m;   // 不认识就原样留着，别吞掉
  });

  return s;
}

/** 行内公式。用于气泡正文里 `$...$` 混排。
 *
 * ★ 顺序是「先整体转义，再渲染公式」，不能反过来：
 *   反过来的话公式外那段会被转义两遍，`a < b` 会显示成 `a &lt; b`。 */
export function renderInline(src) {
  const e = escapeHtml(src);
  return e.replace(/\$([^$\n]+)\$/g, (m, tex) => `<span class="lx">${renderLatexUnsafe(tex)}</span>`);
}
