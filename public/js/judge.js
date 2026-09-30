/* 判分与出题清洗
 *
 * ── 这个文件为什么必须存在 ───────────────────────────────────────
 * 模型生成的内容如果**要交给程序处理**，就必须过一道校验。
 * 一条判不了分的题，用户答对了系统说错 —— 页面不报错、测试全绿、
 * 用户直接失去信任。这比「生成失败」严重得多。
 *
 * ── 两条铁律 ────────────────────────────────────────────────────
 * 1. 判据只能有一份。内建题库、AI 生成、以后可能加的手工录题，
 *    都调同一个 normalizeAnswer / answerIssue。两处各写一份正则，
 *    迟早改歪一边，而歪的那边不会有任何报错。
 * 2. 模型给判断，代码算算术。凡是能算的（归一化、比对、计数、比例）
 *    都不交给模型。
 */

/* ============================================================
   归一化
   ============================================================
   顺序很重要：先做**能救的规范化**（\frac{1}{2} → 1/2、x=2 → 2），
   再卡最终判据。一上来就丢是浪费。
   ============================================================ */
export function normalizeAnswer(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // 全角数字/符号 → 半角（中文输入法下极常见）
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF0B\uFF0D\uFF0A\uFF0F\uFF1D\uFF08\uFF09]/g, (c) =>
      ({ '＋': '+', '－': '-', '＊': '*', '／': '/', '＝': '=', '（': '(', '）': ')' }[c]));

  // 各种「减号」统一成 ASCII 连字符
  s = s.replace(/[\u2212\u2013\u2014\u2015]/g, '-');
  // 各种空格（含不换行空格）清掉
  s = s.replace(/[\s\u00A0\u2007\u202F]+/g, '');
  // 数学定界符与 LaTeX 装饰
  s = s.replace(/\$+/g, '');
  s = s.replace(/\\left|\\right|\\!|\\,|\\;|\\ /g, '');
  s = s.replace(/\\text\{([^{}]*)\}/g, '$1');
  // \frac{a}{b} / \dfrac{a}{b} → a/b
  s = s.replace(/\\(?:d|t)?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)');
  // \sqrt{2} → sqrt(2)，让它在下面的数值判定里被明确拒绝（而不是伪装成合法）
  s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, 'sqrt($1)');
  // 百分号保留（下面会转成小数）
  // 末尾句号去掉
  s = s.replace(/[。．]+$/, '');
  // 方程形式 x=2 / y = -3 只留右边
  const eq = s.match(/^[a-zA-Z][_a-zA-Z0-9]*=(.+)$/);
  if (eq) s = eq[1];
  // 中文单位统一。注意「约等于」要拆成「去掉约」+「等于→=」，
  // 否则会剩下一个前导 `=`，把 0.67 变成一个解析不出来的串。
  s = s.replace(/约/g, '').replace(/等于/g, '=').replace(/^=/, '');
  return s;
}

/** 归一化 + 去掉纯数值分式外面多余的括号。展示和入库都用它。 */
export function canonicalAnswer(raw) {
  let s = normalizeAnswer(raw);
  s = s.replace(/^\((-?\d+(?:\.\d+)?)\)\/\((-?\d+(?:\.\d+)?)\)$/, '$1/$2');
  return s;
}

/** 把一个归一化后的串解析成数值。解析不出来返回 null（不是 0！0 是个合法答案）。 */
export function parseNumeric(s) {
  const t = normalizeAnswer(s);
  if (!t) return null;

  // 百分数
  const pct = t.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (pct) return Number(pct[1]) / 100;

  // 分数 a/b（分子分母都可带符号/小数）
  const frac = t.match(/^\(?(-?\d+(?:\.\d+)?)\)?\/\(?(-?\d+(?:\.\d+)?)\)?$/);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) return null;           // 分母为 0 不是合法答案
    return Number(frac[1]) / den;
  }

  // 纯数值
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);

  // 带 π 的简单形式（π、2π、π/2）—— 这类是常见答案，值得救
  const pi = t.match(/^(-?\d*(?:\.\d+)?)π(?:\/(\d+(?:\.\d+)?))?$/);
  if (pi) {
    const coef = pi[1] === '' || pi[1] === '-' ? (pi[1] === '-' ? -1 : 1) : Number(pi[1]);
    const div = pi[2] ? Number(pi[2]) : 1;
    if (!div) return null;
    return (coef * Math.PI) / div;
  }

  return null;
}

/* ============================================================
   判据：这道题判得了分吗
   ============================================================
   返回 null 表示判得了；返回字符串表示给人看的「为什么判不了」。
   ★ 这是**唯一**的判据出口。内建题、AI 生成题都走它。
   ============================================================ */
export function answerIssue(q) {
  if (!q || typeof q !== 'object') return '题目对象不存在';

  const stem = String(q.stem || '').trim();
  if (stem.length < 5) return '题干太短，无法确认在问什么';

  if (q.type === 'choice' || (Array.isArray(q.options) && q.options.length)) {
    const opts = q.options || [];
    if (opts.length !== 4) return `选择题必须正好 4 个选项（现在 ${opts.length} 个）`;
    const keys = opts.map((o) => String(o && o.k || '')).join('');
    if (keys !== 'ABCD') return `选项键必须正好是 ABCD（现在是「${keys}」）`;
    const ans = String(q.answer || '').trim().toUpperCase();
    if (!'ABCD'.includes(ans) || ans.length !== 1) return `选择题答案必须是 A/B/C/D 之一（现在是「${q.answer}」）`;
    // 选项文本重复会让答案不唯一
    const texts = opts.map((o) => String(o.t || '').trim());
    if (texts.some((t) => !t)) return '有选项是空的';
    if (new Set(texts).size !== texts.length) return '有两个选项的文字完全一样，答案不唯一';
    return null;
  }

  // 填空题：答案必须能被解析成一个数
  const v = parseNumeric(q.answer);
  if (v === null || !Number.isFinite(v)) {
    return `填空题的答案必须是整数、小数、分数或 π 的简单形式（现在是「${q.answer}」）`;
  }
  return null;
}

/** 归一化后的标准答案，用于展示。 */
export function prettyAnswer(q) {
  if (!q) return '';
  if (q.type === 'choice' || (q.options && q.options.length)) return String(q.answer || '').toUpperCase();
  return canonicalAnswer(q.answer);
}

/* ============================================================
   判分
   ============================================================
   ★ 三种结果，不能压成两种：
     · correct === true  判对
     · correct === false 判错
     · gradable === false 判不了（降级：把标准答案摊给用户自己看）
   把第三种压成「错」，用户答对了却被告知错 —— 这是最伤信任的一种 bug。
   ============================================================ */
const EPS = 1e-6;

export function judge(q, userAnswer) {
  const issue = answerIssue(q);
  if (issue) {
    return { gradable: false, correct: null, reason: issue, standard: prettyAnswer(q) };
  }

  const user = String(userAnswer ?? '').trim();
  if (!user) return { gradable: true, correct: false, reason: '没有作答', standard: prettyAnswer(q) };

  if (q.type === 'choice' || (q.options && q.options.length)) {
    const u = normalizeAnswer(user).toUpperCase();
    const a = String(q.answer).trim().toUpperCase();
    return {
      gradable: true,
      correct: u === a,
      reason: u === a ? '' : '选项不对',
      standard: a,
      normalized: { user: u, standard: a },
    };
  }

  const uNum = parseNumeric(user);
  const aNum = parseNumeric(q.answer);
  if (uNum !== null && aNum !== null) {
    // 相对容差 + 绝对容差取大者：0.013 这种小数用绝对容差会误判，
    // 1e9 这种大数用绝对容差会过宽。
    const tol = Math.max(EPS, Math.abs(aNum) * 1e-4);
    const ok = Math.abs(uNum - aNum) <= tol;
    return {
      gradable: true,
      correct: ok,
      reason: ok ? '' : '数值不对',
      standard: prettyAnswer(q),
      normalized: { user: uNum, standard: aNum },
    };
  }

  // 走到这里说明标准答案可判、但用户写的东西不是数值（比如写了「不会」）
  return { gradable: true, correct: false, reason: '没写成可比的数值形式', standard: prettyAnswer(q) };
}

/* ============================================================
   ★ 模型输出的可消费性守卫
   ============================================================
   防线一在提示词里（见 agent.js 的 GENERATE_SYSTEM），
   这里是防线二。小模型基本不听枚举约束，所以这道必须硬。
   ============================================================ */

/** 从模型输出里抠出 JSON。模型很爱加 ```json 围栏和前后解释文字。 */
export function extractJson(text) {
  let s = String(text || '').trim();
  if (!s) return null;

  // 1. 先剥 ```json 围栏
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  // 2. 直接试
  try { return JSON.parse(s); } catch { /* 继续 */ }

  // 3. 取第一个 { 到最后一个 }（数组同理）
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try { return JSON.parse(s.slice(objStart, objEnd + 1)); } catch { /* 继续 */ }
  }
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try { return JSON.parse(s.slice(arrStart, arrEnd + 1)); } catch { /* 继续 */ }
  }
  return null;
}

/**
 * 清洗模型生成的题目。
 *
 * @param {string|object} raw       模型原始输出
 * @param {object} opts
 *   count      想要的题数
 *   knownStems 已存在的题干（用于去重）
 *   pointId    限定考点（会强制写回，不信模型给的）
 * @returns {{created:Array, skippedDuplicate:number, skippedUnjudgeable:number, parseFailed:boolean, total:number}}
 */
export function sanitizeGenerated(raw, opts = {}) {
  const count = Number(opts.count) || 3;
  const knownStems = new Set((opts.knownStems || []).map((s) => normalizeStem(s)));

  const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.questions)) ? parsed.questions
      : (parsed && parsed.stem) ? [parsed]
        : [];

  const created = [];
  let skippedDuplicate = 0;
  let skippedUnjudgeable = 0;

  /* ★ 缓冲：要 3 道就让它出 5 道。模型总会出一两道不可判的，
   *   按 count 精确取的话，用户点了「3 道」会拿到 1 道。 */
  for (const item of list.slice(0, count + 2)) {
    if (created.length >= count) break;
    if (!item || typeof item !== 'object') { skippedUnjudgeable += 1; continue; }

    const q = coerceQuestion(item, opts.pointId);
    if (!q) { skippedUnjudgeable += 1; continue; }

    const issue = answerIssue(q);
    if (issue) { skippedUnjudgeable += 1; continue; }

    const key = normalizeStem(q.stem);
    if (knownStems.has(key)) { skippedDuplicate += 1; continue; }
    knownStems.add(key);

    created.push(q);
  }

  return {
    created,
    skippedDuplicate,
    skippedUnjudgeable,
    parseFailed: created.length === 0,
    total: list.length,
  };
}

function normalizeStem(s) {
  return String(s || '').replace(/[\s\u00A0]+/g, '').replace(/[。．.？?！!，,、；;：:]/g, '').toLowerCase();
}

/** 把模型给的一条原始对象整形。整形失败返回 null（不抛异常）。 */
function coerceQuestion(item, forcePointId) {
  const stem = String(item.stem || item.question || item.q || '').trim();
  if (stem.length < 6) return null;

  const type = String(item.type || '').toLowerCase();
  const rawOpts = item.options || item.choices;
  const looksChoice = type === 'choice' || (Array.isArray(rawOpts) && rawOpts.length);

  const base = {
    stem,
    pointId: forcePointId || String(item.pointId || '').trim() || null,
    explain: String(item.explain || item.explanation || item.why || '').trim().slice(0, 400),
    generated: true,
  };

  if (looksChoice) {
    const opts = (rawOpts || []).slice(0, 4).map((o, i) => {
      if (o && typeof o === 'object') return { k: String(o.k || o.key || 'ABCD'[i]).toUpperCase(), t: String(o.t || o.text || '').trim() };
      return { k: 'ABCD'[i], t: String(o || '').trim() };
    });
    let answer = String(item.answer ?? '').trim().toUpperCase();
    // 模型有时给选项全文而不是键 —— 救一下
    if (answer.length > 1) {
      const hit = opts.find((o) => o.t === answer);
      answer = hit ? hit.k : answer;
    }
    return { ...base, type: 'choice', options: opts, answer };
  }

  // 填空题：先做能救的规范化，再交给 answerIssue 卡死
  const answer = canonicalAnswer(item.answer ?? item.a ?? '');
  return { ...base, type: 'fill', answer };
}

/** 给 UI 用的一句话结论。 */
export function describeGeneration(res) {
  const bits = [`生成了 ${res.created.length} 道题`];
  if (res.skippedUnjudgeable) bits.push(`有 ${res.skippedUnjudgeable} 道因为判不了分被丢掉了`);
  if (res.skippedDuplicate) bits.push(`${res.skippedDuplicate} 道和已有题目重复`);
  if (res.parseFailed) return '这次一道都没生成出来，再点一次试试（模型偶尔会输出不成形的 JSON）';
  return bits.join(' · ');
}
