/* Agent 内核
 *
 * 一个角色 = 一个独立的 agent：独立的调用、独立的记忆、独立的工具白名单。
 * 这个文件负责把「角色」翻译成提示词，把「模型输出」翻译成动作。
 *
 * ── 三件这个文件必须做对的事 ────────────────────────────────────
 *
 * 1. **阶段由代码持有，不由模型判断。**
 *    模型除了对话历史之外不持有任何状态。每轮把全部规则平铺给它，
 *    它会按「每轮要留一道题」这种惯性继续走 —— 即使这一轮的情况
 *    已经完全相反（学生刚说了「没听懂」）。
 *    所以：提示词只描述**当前这一个状态**该干什么。
 *
 * 2. **提示词是请求，硬过滤才是保证。**
 *    小模型在「其他人该安静」这条上实测十次有三次不听话。
 *    所以模型输出之后要兜：静默越权角色 / 换掉算题 / 补空问题，
 *    并且**如实上报**被改了什么，让前端能说人话。
 *
 * 3. **意图分类的判断顺序就是语义。**
 *    「没听懂」里带一个「懂」字。先判「懂了」的话，
 *    「我还是没听懂」会被归成 understood，下一轮直接甩一道题出来 ——
 *    那正是要修的毛病本身。
 */

import { chat, TOOL_PROTOCOL_HINT } from './llm.js';
import { execute, schemaFor, toolNamesFor, makeCtx, assertStudentCannotWriteSolution } from './tools.js';
import { materialFor, findPoint } from './curriculum.js';
import { learningProfile } from './store.js';
import { sanitizeGenerated, describeGeneration } from './judge.js';

/* ============================================================
   角色定义
   ============================================================
   ★ 差异化靠三样东西，**不靠形容词**：
     · 资料量（depth → curriculum.DEPTH）
     · 工具白名单（学生没有 write_steps）
     · 典型失误（distractorIndex → 题库干扰项）
   写「你是个聪明学生」「你基础不好」是没用的 —— 模型会收敛到同一种腔调。
   ============================================================ */
export const AGENTS = {
  teacher: {
    key: 'teacher',
    name: '陈老师',
    short: '师',
    depth: 'teacher',
    kind: 'teacher',
    blurb: '掌握全部资料与学情数据，负责讲透、追问、出题、点评',
  },
  a: {
    key: 'a',
    name: '林一鸣',
    short: 'A',
    depth: 'a',
    kind: 'student',
    distractorIndex: 0,
    name2: '优等生',
    errorMode: '结论下得太早',
    errorHint: '你脑子快，经常看到一个模式就下结论，**忘了先验证定理的前提条件**。这次也请照旧——先说结论，被追问时才发现自己没验边界。',
    blurb: '资料齐全，但容易跳过前提条件直接下结论',
  },
  b: {
    key: 'b',
    name: '周雨桐',
    short: 'B',
    depth: 'b',
    kind: 'student',
    distractorIndex: 1,
    name2: '中等生',
    errorMode: '条件用错',
    errorHint: '你记得公式，但经常**把公式成立的前提条件记串**（比如把「开区间可导」记成「闭区间可导」）。这次也请照旧。',
    blurb: '记得公式，但常把成立条件记串',
  },
  c: {
    key: 'c',
    name: '马小虎',
    short: 'C',
    depth: 'c',
    kind: 'student',
    distractorIndex: 2,
    name2: '后进生',
    errorMode: '概念混淆',
    errorHint: '你手上**只有这个考点的第一句定义**，别的东西你都还没学到。你会把两个相邻的概念当成一回事。这次也请照旧，用大白话说出你的困惑。',
    blurb: '只拿到一句定义，容易把相邻概念混为一谈',
  },
};

export const STUDENT_KEYS = ['a', 'b', 'c'];

/* ============================================================
   教学动作标签（MathDial 分类法）
   ============================================================
   老师每次发言的第一行打一个标签。有了它才能把
   「这课到底在引导还是在念答案」变成一个数字。
   ============================================================ */
export function parseMove(text) {
  const m = String(text || '').match(/^\s*\((focus|probing|telling)\)\s*\n?/i);
  if (!m) return { move: '', text: String(text || '') };
  return { move: m[1].toLowerCase(), text: String(text || '').slice(m[0].length) };
}

export function blankMoves() {
  return { focus: 0, probing: 0, telling: 0 };
}

/** 引导占比 = 引导类动作 / 全部动作。好课以引导为主。 */
export function guidanceRatio(moves) {
  const m = moves || blankMoves();
  const total = (m.focus || 0) + (m.probing || 0) + (m.telling || 0);
  if (!total) return null;
  return (m.focus + m.probing) / total;
}

/* ============================================================
   意图分类
   ============================================================ */

/* ★ 顺序不能反：先判困惑，再判懂了。
 *   「听不懂」「没听懂」里都带一个「懂」字，反过来判的话
 *   「我还是没听懂」会被归成「听懂了」，下一轮直接甩一道题 —— 那正是要修的毛病。 */
const CONFUSED_RE = /不知道|不懂|没懂|没听懂|听不懂|不明白|搞不清|分不清|搞不懂|没搞懂|不理解|没理解|不会|跟不上|没跟上|卡住|卡在|有点晕|懵|疑惑|迷惑|\?\?\?|？？？|一头雾水|没明白|还是不明白|再说一遍|再讲一遍|换个说法/;
const UNDERSTOOD_RE = /懂了|明白了|理解了|会了|跟上了|清楚了|搞懂了|知道了|可以了|继续吧|继续|下一步|接着讲|没问题了|ok|OK|Ok|好的/;
const QUESTION_RE = /[?？]|为什么|为啥|怎么|如何|是不是|是否|凭什么|难道|能不能|可不可以|请问|我想问|想问|解释一下/;

/**
 * @returns {'none'|'confused'|'understood'|'question'|'other'}
 *
 * 两条经验：
 *   · 别做整句相等匹配。真实输入是「这个我真不知道…」「哎不懂啊」，
 *     用锚定写法会全部漏掉。宁可宽一点 —— 宽了最多是多讲一遍，
 *     窄了会把「没懂」当成「懂了」。
 *   · 「提问」要排在「其他」之前。既不含困惑词也不含「懂了」的提问
 *     归成 other 的话，状态机会认为他做出了实质回应，于是推去练习 ——
 *     又变成「人家还在问，你就让他算」。
 */
export function classifyIntent(text) {
  const s = String(text || '').trim();
  if (!s) return 'none';
  if (CONFUSED_RE.test(s)) return 'confused';
  if (UNDERSTOOD_RE.test(s)) return 'understood';
  if (QUESTION_RE.test(s)) return 'question';
  return 'other';
}

/* ============================================================
   阶段状态机
   ============================================================ */
export const PHASES = ['lecture', 'explain', 'clarify', 'practice', 'discuss'];

export const PHASE_META = {
  lecture: { label: '讲透', who: '老师 + 同学', tail: '回忆式问题（不动笔）' },
  explain: { label: '讲授', who: '老师 + 同学', tail: '回忆式问题' },
  clarify: { label: '答疑重讲', who: '只有老师', tail: '理解确认（禁止出题）' },
  practice: { label: '练习', who: '老师 + 同学', tail: '一道小题' },
  discuss: { label: '研讨', who: '老师 + 同学', tail: '开放问题' },
};

/**
 * 阶段推演。
 *
 * 最后那条「上一轮是 clarify 且 intent 是 other 之外的」是刻意的：
 * 用户点了「继续」但一个字没打（intent = none）时，**不许自己滑进练习**。
 * 没有明确信号就留在原地重讲 —— 保守方向是这里唯一正确的方向。
 */
export function nextPhase(prevPhase, intent, round) {
  if (round === 0) return 'lecture';
  if (intent === 'confused') return 'clarify';
  if (intent === 'understood') return 'practice';
  if (intent === 'question') return prevPhase === 'clarify' ? 'clarify' : 'explain';
  if (prevPhase === 'clarify') return intent === 'other' ? 'practice' : 'clarify';
  return 'explain';
}

/** 这个阶段谁可以说话。 */
export function canSpeak(phase, role) {
  if (phase !== 'clarify') return true;
  return role === 'teacher';
}

/* ============================================================
   结尾问题
   ============================================================ */

/** 找出最后那个问句的位置。中文标点全算句末。 */
export function findLastQuestion(text) {
  const s = String(text || '');
  const idx = Math.max(s.lastIndexOf('？'), s.lastIndexOf('?'));
  if (idx < 0) return { q: '', start: -1, end: -1 };
  let start = idx;
  while (start > 0 && !/[。！!？?\n；;：:]/.test(s[start - 1])) start--;
  return { q: s.slice(start, idx + 1).trim(), start, end: idx + 1 };
}

export function lastQuestion(text) {
  return findLastQuestion(text).q;
}

/* ★ 判断「算题」的正则要小心误杀。
 *   `求导`、`求极限` 这类光杆词在理解确认问题里太正常了
 *   （「求极限有哪些方法」），拦下来反而把好问题换成通用兜底句。
 *   只认真正带计算动作的说法。 */
const COMPUTE_RE = /计算下列|化简下列|求解下列|计算[^，。？?！!]{0,10}|证明[^，。？?！!]{0,14}|求解|化简|等于多少|的值是|算出|求出|解方程|解不等式|求[^，。？?！!]{0,14}的值|下列各题|下面这道/;

export const COMPREHENSION_CHECKS = [
  '这么说能跟上吗？能的话我就出一道小题，让你自己走一遍；要还有哪个地方别扭，直接说是哪一步别扭。',
  '到这里清楚了吗？说不清也没关系——说不清我就换个说法再讲一次。',
  '先别急着往下走。你用自己的话把刚才那一步复述一遍——你抓到的是不是我想讲的那个点？',
];

function pickCheck(seed) {
  const i = Math.abs(Number(seed) || 0) % COMPREHENSION_CHECKS.length;
  return COMPREHENSION_CHECKS[i];
}

/**
 * 找出「该被替换掉的那一段」。
 *
 * ★ 比 findLastQuestion 往回走得**更远**：一直退到真正的句末
 *   （。！？；或换行），把引出语一起包进来。
 *
 *   真踩过：只换问句本身的话，
 *     「好，那我们直接算一下：lim(x→0) sinx/x 等于多少？」
 *   会变成
 *     「好，那我们直接算一下：到这里清楚了吗？说不清也没关系……」
 *   —— 前半句「那我们就直接算一下」是引出算题的，现在跟理解确认拼在一起，
 *   读起来自相矛盾。而 findLastQuestion 之所以在 `：` 处断开是对的
 *   （提取问题时要那个精度），替换时要的却是**整句**。
 */
export function findReplaceSpan(text) {
  const s = String(text || '');
  const { q, end } = findLastQuestion(s);
  if (!q || end < 0) return { text: '', start: -1, end: -1 };
  let start = end;
  /* ★ 回退边界里**不能包含问号**：end 正好落在问号后面，
   *   把问号也算边界的话循环第一步就停住，span 永远是空的 ——
   *   于是「替换」静默退化成「追加」，界面上变成
   *   「好，那我们直接算一下：lim…等于多少？」+ 理解确认，两句并存。 */
  while (start > 0 && !/[。！!\n；;]/.test(s[start - 1])) start--;
  return { text: s.slice(start, end).trim(), start, end };
}

/** 把结尾那个问句（连同引出它的那句话）换成另一个。没有问句就追加。 */
export function replaceTrailingQuestion(text, newQ) {
  const s = String(text || '');
  const { text: span, start, end } = findReplaceSpan(s);
  if (!span) return `${s.trim()}\n\n${newQ}`.trim();
  return (s.slice(0, start) + newQ + s.slice(end)).trim();
}

/* ============================================================
   ★ 硬过滤：模型越界之后的兜底
   ============================================================
   不报错让前端重试的理由：一次重试就是一次上游调用，花的是用户的钱；
   而这几种越界都有语义等价的兜底。
   ============================================================ */
export function enforcePhase(phase, turns, opts = {}) {
  const report = { silenced: 0, promptAdjusted: false, promptAdded: false, phase };
  const kept = [];

  for (const t of turns) {
    if (!t || !t.text) continue;
    if (!canSpeak(phase, t.role)) { report.silenced += 1; continue; }
    kept.push(t);
  }

  if (phase === 'clarify') {
    // 找到老师最后一条发言，检查它的结尾问题
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].role !== 'teacher') continue;
      const q = lastQuestion(kept[i].text);
      if (q && COMPUTE_RE.test(q)) {
        kept[i] = { ...kept[i], text: replaceTrailingQuestion(kept[i].text, pickCheck(opts.seed)), promptAdjusted: true };
        report.promptAdjusted = true;
      } else if (!q) {
        // 留着空问题，前端那块「老师留了个问题」的卡片就不出现，
        // 学生不知道该说什么
        kept[i] = { ...kept[i], text: `${kept[i].text.trim()}\n\n${pickCheck(opts.seed)}`, promptAdded: true };
        report.promptAdded = true;
      }
      break;
    }
  }

  report.turns = kept;
  return report;
}

/** 这个结尾问题算不算「算题」。UI 和测试都用它。 */
export function isComputeQuestion(q) {
  return COMPUTE_RE.test(String(q || ''));
}

/* ============================================================
   上下文压缩（compaction）
   ============================================================
   纯文本拼接截断，**不用 LLM** —— 压一次上下文再花一次调用是不划算的。
   ============================================================ */
export function compact(messages, opts = {}) {
  const keep = Number(opts.keep) || 12;
  if (!Array.isArray(messages) || messages.length <= keep + 1) return messages;

  const system = messages[0] && messages[0].role === 'system' ? [messages[0]] : [];
  const rest = system.length ? messages.slice(1) : messages.slice();
  const dropped = rest.slice(0, rest.length - keep);
  const keptTail = rest.slice(rest.length - keep);

  // 把被丢掉的内容压成一行「要点」：只留角色和开头几个字
  const digest = dropped
    .filter((m) => m.role === 'assistant' || m.role === 'user')
    .slice(-8)
    .map((m) => {
      const who = m.role === 'user' ? '学习者' : '老师';
      const t = String(m.content || '').replace(/\s+/g, ' ').slice(0, 40);
      return `${who}说过「${t}…」`;
    })
    .join('；');

  const note = {
    role: 'system',
    content: `【前情提要】（已省略 ${dropped.length} 条更早的消息）${digest || '（无实质内容）'}`,
  };

  return [...system, note, ...keptTail];
}

/* ============================================================
   提示词
   ============================================================ */

const BASE_RULES = `
【绝对规则 —— 违反任何一条，这一轮就算失败】
1. 学习者没有自己作答之前，**不许说出这道题的答案**，包括换个说法暗示、包括把关键中间步骤写出来。
2. 他答错了，先给**最小提示**（只点一个方向，不把解法讲完），留一步让他自己走。
3. 他答对之后，必须再出一道**同类的新题**让他独立做。答对不等于学会。
4. 不要用「很好的问题」「这是个好思路」这类开场白。直接说事。
5. 说人话。这是考研复习，不是论文答辩。`;

const MOVE_RULES = `
【发言格式 —— 第一行必须是标签】
每次发言的第一行，只写一个括号标签，占一行，后面再写正文：
(focus)   —— 把注意力拉回关键处，或者推他自己往下走
(probing) —— 追问，逼他把话说清楚
(telling) —— 直接告知（讲答案、给结论）
好课以 focus 和 probing 为主。如果连续几轮都是 telling，说明你在替他做题。`;

const TOOL_RULES = `
【工具】
你可以调用工具。需要具体数字时**一律用 calc 算**，不要心算 —— 你的心算经常错。
黑板上的内容用户能看见，写上去比写在正文里更醒目。`;

function profileBlock(ctx) {
  if (!ctx || ctx.showProfile === false) return '';
  return `\n\n${learningProfile(ctx.pointId || null)}`;
}

/**
 * 老师的 system prompt。★ 只描述**当前阶段**该干什么。
 */
export function teacherPrompt(opts) {
  const { phase, point, ctx, moveTags = true } = opts || {};
  const mat = point ? materialFor(point, 'teacher') : null;

  const parts = [
    `你叫陈老师，正在给一个考研的学生上一对一的课。你旁边还坐着三个学生（林一鸣、周雨桐、马小虎），他们也会说话。`,
    `你手里有**全部资料**：考点的严格表述、直观解释、适用范围、最小例子、考卷形式，还能查这个学习者真实的错题记录和薄弱考点。所以你要讲得比课本更针对他。`,
  ];

  if (mat) {
    parts.push(`\n【这节课的考点】${mat.name}（${mat.module} · ${mat.chapter}）
严格表述：${mat.definition}
直观解释：${mat.intuition}
适用范围（含**不能用**的情形）：${mat.scope}
最小例子：${mat.example}
考卷上通常怎么出现：${mat.examForm}`);
  }

  parts.push(profileBlock(ctx));

  /* ---- 阶段说明：只给当前这一个 ---- */
  const phaseText = {
    lecture: `
【当前阶段：讲透（第 1 轮）】
这一轮的任务是把考点**一次讲透**，不要惜字。按这个顺序讲，五段都要有：
  1) 严格表述：完整定义，**包含全部前提条件**，一个都不能漏
  2) 直观解释：几何上或生活里对应什么，为什么它成立
  3) 适用范围：什么情况下能用、什么情况下**不能用**（这是最容易丢分的地方，务必说清）
  4) 一个最小例子：把定义代进去走一遍
  5) 一句小结：这个考点在考卷上通常以什么形式出现
字数放宽到 400 字以内都可以。这一轮讲不透，后面每一轮都在补债。
结尾留一个**回忆式**问题（不动笔的那种，比如「你想想，如果去掉第二个条件会怎么样？」）。`,
    explain: `
【当前阶段：常规讲授】
顺着他的话往下讲。结尾留一个**回忆式**问题，不要让他动笔。`,
    clarify: `
【当前阶段：答疑重讲 —— 他说「没听懂」】
**这一轮只有你说话。** 那三个学生此刻必须安静（系统会强制静默他们，但你也别在正文里替他们发言）。
退回去**重讲概念**，不要接着往下推。
- 换一个说法、换一个比喻、换一个角度。把上一遍的原话重复一遍是没用的。
- 结尾必须是**理解确认**，**绝对不许出题**。
- 确认句里要留出口：「说不清也没关系，说不清我就换个说法再讲一次」。
- 他可能只是卡在某一步。先猜他卡在哪，把那个点单独拿出来讲。`,
    practice: `
【当前阶段：练习】
他说听懂了。现在出一道**小题**让他动手做，难度是「他现在踮脚够得着」。
- 一次只出一道，题目要短。
- 出完题用 pose_question 工具把它记下来，然后**停下来等他作答**，不要自问自答。
- 结尾不要再附加别的问题，就这一道。`,
    discuss: `
【当前阶段：研讨】
这是个开放问题，没有唯一答案。你的任务是**维持张力**：谁说得太顺就追问一个反例，
谁说得太偏就把他拉回关键处。你自己**不要给结论**，让讨论继续。
结尾留一个开放问题。`,
  }[phase] || '';

  parts.push(phaseText);

  if (phase === 'practice' || phase === 'discuss') {
    parts.push(`\n【学习者正在回答的问题】${opts.lastPrompt ? `「${opts.lastPrompt}」（第 ${opts.lastPromptRound || '?'} 轮留的）` : '（本轮新留）'}`);
    if (opts.userAnswer) {
      parts.push(`【他刚刚的作答原文】${opts.userAnswer}`);
      parts.push(`★ 不要直接判定对错。先点明你在回应哪一问，再按规则 1/2/3 处理。`);
    }
    if (opts.userSkipped) {
      parts.push(`【他跳过了这一题】不要追问这道题了，换个角度再讲一遍同一个概念，然后另出一道更小的题。`);
    }
  }

  parts.push(BASE_RULES);
  if (moveTags) parts.push(MOVE_RULES);
  parts.push(TOOL_RULES);
  return parts.filter(Boolean).join('\n');
}

/**
 * 学生的 system prompt。
 * ★ 差异化全在这里：资料量 + 典型失误 + 强制回应。
 */
export function studentPrompt(roleKey, opts) {
  const a = AGENTS[roleKey];
  const { point, ctx, round = 0, teacherSaid = '', memory = [], interjected = '' } = opts || {};
  if (!a) return '';

  const mat = point ? materialFor(point, a.depth) : null;

  const parts = [
    `你叫${a.name}，是陈老师课上的一名学生。你**不是** AI 助手，你是坐在教室里的人。`,
    `你的水平：${a.blurb}。`,
  ];

  /* ---- 资料：按角色裁剪。低水位角色真的只拿到一句话 ---- */
  if (mat) {
    const lines = [`\n【你手上的资料 —— 就这么多，别的你没学到】`, `考点：${mat.name}`];
    if (mat.definition) lines.push(`定义：${mat.definition}`);
    if (mat.intuition) lines.push(`直观理解：${mat.intuition}`);
    if (mat.scope) lines.push(`适用范围：${mat.scope}`);
    if (mat.example) lines.push(`例题：${mat.example}`);
    if (mat.related && mat.related.length) lines.push(`相关考点：${mat.related.map((r) => r.name).join('、')}`);
    if (!mat.intuition && !mat.scope) {
      lines.push(`★ 你手上**只有上面这些**。别的内容你确实不知道，被问到就直接说不知道，不要编。`);
    }
    parts.push(lines.join('\n'));
  }

  /* ---- 典型失误：让每个人都会犯错，否则看着像陪读 ---- */
  parts.push(`\n【你这一轮大概率会犯的错】${a.errorHint}`);

  /* ---- 发言要求 ---- */
  const reqs = [
    `\n【发言要求】`,
    `· 用**你自己的话**说，一到三句话，别背课本，别说完整解法。`,
    `· 你是学生，不是老师。**你没有能力写出完整解答**，也不该试着写。`,
    `· 你的困惑必须是**真的困惑**，不要假装不懂。`,
  ];
  if (round > 0) {
    reqs.push(`· ★ 第 2 轮起，你**必须先回应前面某个人说过的话**（「你刚才说……」），再讲自己的看法。不许各说各的。`);
  }
  if (memory && memory.length) {
    reqs.push(`· 你记得这些事：${memory.map((m) => `「${m}」`).join('、')}`);
  }
  parts.push(reqs.join('\n'));

  if (teacherSaid) parts.push(`\n【老师刚说的话】\n${teacherSaid.slice(0, 900)}`);
  if (interjected) parts.push(`\n【学习者刚刚插话】\n${interjected}`);

  parts.push(`\n【你的工具】你有 look_up（查资料，但你查到的也只有上面那些）、recall_mistake（回忆你自己卡在哪）、draw_graph（画图）、highlight（圈重点）、raise_hand（举手）、pass（弃权）。你没有写完整解法的工具 —— 因为你确实不会。`);

  return parts.filter(Boolean).join('\n');
}

/* ============================================================
   Agent loop
   ============================================================ */

const UNSUPPORTED_RE = /tool|function|unsupported|not support|400|invalid/i;

function toolResultData(r) {
  return JSON.stringify(r.ok ? r.data : { error: r.error });
}

/**
 * 跑一个 agent 的完整回合：模型可能调几轮工具，最后给出结论。
 *
 * @param {object} opts
 *   role        'teacher' | 'a' | 'b' | 'c'
 *   system      system prompt
 *   messages    已有的对话消息（不含 system）
 *   ctx         角色化上下文（tools.makeCtx 的产物）
 *   hooks       { onDelta, onToolDelta, onToolCall, onToolResult }
 *   maxSteps    工具调用轮数上限（默认 3）
 * @returns {Promise<{text, toolCalls, boardItems, steps, degraded}>}
 */
export async function runAgent(opts) {
  const {
    role, system, messages = [], ctx, hooks = {}, maxSteps = 3, temperature = 0.7,
  } = opts;

  assertStudentCannotWriteSolution();

  let tools = schemaFor(role);
  let sys = system;
  let degraded = '';
  const boardItems = [];
  const allToolCalls = [];

  const convo = [{ role: 'system', content: sys }, ...messages];

  for (let step = 0; step < maxSteps; step++) {
    let out;
    try {
      out = await chat({
        messages: compact(convo),
        tools,
        hooks,
        temperature,
      });
    } catch (e) {
      /* ★ 降级链第二层：模型/网关不认原生 tools。
       *   去掉 tools，把工具清单写进 system，让它用文本协议输出。 */
      if (tools.length && (e.kind === 'upstream' || UNSUPPORTED_RE.test(e.message || ''))) {
        tools = [];
        degraded = 'text-protocol';
        sys = `${system}\n${TOOL_PROTOCOL_HINT}\n\n可用工具：\n${toolNamesFor(role).join('、')}`;
        convo[0] = { role: 'system', content: sys };
        step--;                       // 这一次不算步数
        if (step < -1) break;         // 防死循环
        continue;
      }
      throw e;
    }

    if (!out.toolCalls.length) {
      return { text: out.content, toolCalls: allToolCalls, boardItems, steps: step + 1, degraded };
    }

    /* ★ 工具结果回灌的两种格式，很容易错：
     *   原生调用 → assistant(tool_calls) + tool(tool_call_id)
     *   文本协议 → assistant(正文含 ```tool 块) + user(【工具结果】…)
     *   第二种**不能用 tool role** —— 没有合法的 tool_call_id 对应。 */
    const native = out.degraded !== 'text-protocol' && out.toolCalls.some((c) => c.id && !c.id.startsWith('text_'));

    if (native) {
      convo.push({
        role: 'assistant',
        content: out.content || null,
        tool_calls: out.toolCalls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs || '{}' },
        })),
      });
    } else {
      convo.push({ role: 'assistant', content: out.content || '' });
    }

    const results = [];
    for (const c of out.toolCalls) {
      let args = {};
      try { args = JSON.parse(c.rawArgs || '{}'); } catch { args = {}; }
      if (hooks.onToolCall) hooks.onToolCall({ name: c.name, args, role });

      const r = execute(c.name, args, ctx, role);
      allToolCalls.push({ name: c.name, args, ok: r.ok, error: r.error || null });

      if (r.ok && r.render && r.render.type === 'board' && r.render.item) {
        // ★ 学生侧要**泛化收集**，不能只认 draw_graph —— 后面每加一种动作都要改收集逻辑
        boardItems.push({ ...r.render.item, by: role });
        if (hooks.onBoard) hooks.onBoard({ ...r.render.item, by: role });
      }
      if (hooks.onToolResult) hooks.onToolResult({ name: c.name, ok: r.ok, error: r.error || null, data: r.data });

      results.push({ call: c, result: r, native });
    }

    for (const { call, result } of results) {
      if (native) {
        convo.push({ role: 'tool', tool_call_id: call.id, content: toolResultData(result) });
      } else {
        convo.push({ role: 'user', content: `【工具结果 · ${call.name}】\n${toolResultData(result)}` });
      }
    }

    /* 工具结果回灌之后，最后一步强制它出结论（不带 tools），
     * 否则模型可能无限调工具 —— 那是用户在花钱。 */
    if (step === maxSteps - 1) {
      const final = await chat({ messages: compact(convo), tools: [], hooks, temperature });
      return { text: final.content, toolCalls: allToolCalls, boardItems, steps: step + 2, degraded };
    }
  }

  return { text: '', toolCalls: allToolCalls, boardItems, steps: maxSteps, degraded };
}

/* ============================================================
   ★ AI 出题
   ============================================================
   模型生成的内容要交给程序判分，所以必须过守卫。
   两道防线：提示词写死边界（下面这段）+ judge.sanitizeGenerated 兜底。
   ============================================================ */
export const GENERATE_SYSTEM = `你是一个考研数学出题老师。请针对指定考点出题。

【硬性要求 —— 违反则整题作废】
1. 每道题必须是下面两种题型之一，别的题型一律不要：
   A) 选择题：正好 4 个选项，键必须依次是 A、B、C、D，answer 只写一个大写字母。
   B) 填空题：answer 只能是整数、小数、分数或 π 的简单形式（例如 2、0.5、1/2、2/3、2pi）。
2. 禁止出证明题、讨论题、答案不唯一的题、需要画图的题、需要写文字的题。
3. 填空题的 answer 只写值本身：写 1/2，不要写 \\frac{1}{2}；写 2，不要写 x=2；写 2/3，不要写 约等于 0.67。
4. 答案里含根号、字母、区间、集合时，改出成选择题。
5. 四个选项的文字不能有重复。
6. 题干不能太短，要把条件说完整。

【只输出 JSON，不要任何解释文字】
格式：
{"questions":[
  {"type":"choice","stem":"题干","options":[{"k":"A","t":"..."},{"k":"B","t":"..."},{"k":"C","t":"..."},{"k":"D","t":"..."}],"answer":"B","explain":"为什么选它，以及另外三个错在哪"},
  {"type":"fill","stem":"题干","answer":"1/2","explain":"解题要点"}
]}`;

/**
 * 生成练习题。
 *
 * @param {object} opts
 *   pointId    限定考点
 *   count      想要几道
 *   knownStems 已存在的题干（去重）
 *   hooks
 * @returns {Promise<{created, skippedDuplicate, skippedUnjudgeable, parseFailed, total, note, error}>}
 */
export async function generateQuestions(opts = {}) {
  const count = Math.max(1, Math.min(5, Number(opts.count) || 3));
  const point = opts.pointId ? findPoint(opts.pointId) : null;

  const userMsg = [
    `考点：${point ? `${point.name}（${point.module} · ${point.chapter}）` : '（未指定，请围绕考研数学的常见考点）'}`,
    point ? `该考点的严格表述：${point.definition}` : '',
    point ? `常见错误：${(point.questions || []).flatMap((q) => q.distractors || []).map((d) => d.text).join('；')}` : '',
    `请出 ${count + 2} 道题（多出两道是备用，会被程序筛选）。`,
  ].filter(Boolean).join('\n');

  let raw;
  try {
    const out = await chat({
      messages: [
        { role: 'system', content: GENERATE_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      tools: [],
      stream: false,          // 结构化内容走非流式，一次性拿完整 JSON
      temperature: 0.8,
      maxTokens: 2000,
    });
    raw = out.content;
  } catch (e) {
    return {
      created: [], skippedDuplicate: 0, skippedUnjudgeable: 0, parseFailed: true, total: 0,
      note: `出题失败：${e.message}`, error: e.kind || 'unknown',
    };
  }

  const res = sanitizeGenerated(raw, { count, knownStems: opts.knownStems || [], pointId: point ? point.id : null });
  return { ...res, note: describeGeneration(res) };
}

/* ============================================================
   ★ 批改（模型给判断，代码算算术）
   ============================================================
   客观题一律走 judge.js 的确定性判分，**不问模型**。
   只有「讲评」这一段交给模型 —— 那是它真正擅长的地方。
   ============================================================ */
export async function explainAnswer(opts = {}) {
  const { pointId, stem, userAnswer, standard, correct, hooks } = opts;
  const point = pointId ? findPoint(pointId) : null;

  const sys = `你是一个考研数学讲评老师。学习者刚做错了一道题，你要做的是**讲清他错在哪**，不是重做一遍。
规则：
- 先点出他的思路大概率错在哪一步（从答案反推）。
- 只讲那一步，不要把整道题的完整解法抄一遍。
- 最后用一句话问他：这一步现在清楚了吗？`;
  const user = [
    point ? `考点：${point.name}` : '',
    `题目：${stem}`,
    `他写的答案：${userAnswer}`,
    `标准答案：${standard}`,
    `判定：${correct ? '对' : '错'}`,
  ].filter(Boolean).join('\n');

  try {
    const out = await chat({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      tools: [],
      hooks,
      temperature: 0.6,
    });
    return { ok: true, text: out.content };
  } catch (e) {
    // ★ 解析失败要走降级，不要弹错误 —— 让用户自己对照标准答案这条降级路径还在
    return { ok: false, text: `（讲评没能生成：${e.message}。你可以自己对照标准答案 ${standard} 看看是哪一步不一样。）`, error: e.kind };
  }
}
