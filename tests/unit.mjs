/* 单元套件：纯函数
 *
 * 不碰网络、不碰 DOM。跑得快（几百毫秒），所以每次改完代码都该跑。
 *
 * ── 这个文件里最值钱的两类断言 ──────────────────────────────────
 *
 * 1. **回归断言钉住已知的坑。** 比如「没听懂 ≠ 听懂了」、
 *    「-x^2 = -(x^2)」、「isNaN 时 fallback 不能是 0」。
 *    这些坑踩过一次就该永远记住。
 *
 * 2. **不变量 + 畸形输入扫描。** 单点断言守不住清洗函数 ——
 *    坏值的组合太多。要写「只要产出了题，它就一定是可判的」，
 *    再喂一组全是坏形状的输入。而且还要**手工写一个错误实现**，
 *    确认不变量真的能抓住它 —— 一个永远为绿的检查比没有检查更糟。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeReporter, ROOT } from './lib/harness.mjs';

import { compile, samplePoints, execute, makeCtx, schemaFor, toolNamesFor,
  TEACHER_TOOLS, STUDENT_TOOLS, TEACHER_ONLY, STUDENT_ONLY, BOARD_BLOCK_KINDS,
  boardRenderable, assertStudentCannotWriteSolution } from '../public/js/tools.js';
import { POINTS, materialFor, firstSentence, findPoint, distractorAt, DEPTH } from '../public/js/curriculum.js';
import { normalizeAnswer, parseNumeric, answerIssue, judge, sanitizeGenerated,
  extractJson, prettyAnswer } from '../public/js/judge.js';
import { classifyIntent, nextPhase, enforcePhase, isComputeQuestion, parseMove,
  guidanceRatio, blankMoves, canSpeak, compact, lastQuestion, findLastQuestion,
  COMPREHENSION_CHECKS, AGENTS, STUDENT_KEYS } from '../public/js/agent.js';
import { renderLatex, renderInline, escapeHtml } from '../public/js/latex.js';
import * as Store from '../public/js/store.js';
import * as Classroom from '../public/js/classroom.js';

const R = makeReporter('单元 · 纯函数');
const { ok, eq, near, throws } = R;

/* ============================================================
   1. 表达式求值器（无 eval）
   ============================================================ */
{
  const c = (src, vars) => compile(src, vars);
  const at = (src, x, vars, scope) => c(src, vars)(x, scope);

  eq('-x^2 必须是 -(x^2) 而不是 (-x)^2', at('-x^2', 3), -9);
  eq('x^2^3 必须右结合（2^(2^3)=256，不是 (2^2)^3=64）', at('x^2^3', 2), 256);
  eq('隐式乘法 2x', at('2x', 3), 6);
  eq('隐式乘法 2(x+1)', at('2(x+1)', 2), 6);
  eq('隐式乘法 x(x-1)', at('x(x-1)', 3), 6);
  eq('隐式乘法 3sin(x)', at('3sin(x)', Math.PI / 2), 3);
  eq('x^2y 读作 (x^2)*y', at('x^2y', 2, ['y'], { y: 5 }), 20);
  eq('2^3x 读作 (2^3)*x', at('2^3x', 2), 16);
  eq('一元正号', at('+x', 3), 3);
  eq('双层负号', at('--x', 3), 3);
  eq('括号优先', at('(2+3)*4', 0), 20);
  eq('除法', at('1/4', 0), 0.25);
  eq('科学计数法', at('1e-3', 0), 0.001);
  near('内置常数 pi ≈ 3.14159', at('pi', 0), Math.PI, 1e-9);
  near('内置常数 e ≈ 2.71828', at('e', 0), Math.E, 1e-9);
  near('内置函数 sqrt(2)', at('sqrt(2)', 0), Math.SQRT2, 1e-9);
  eq('多参数函数 max', at('max(1,5,3)', 0), 5);
  eq('除零得到 Infinity 而不是抛异常', at('1/0', 0), Infinity);

  eq('参数作用域生效', at('a*x', 2, ['a'], { a: 3 }), 6);
  /* ★ scope 只采纳声明过的名字 —— 照单全收的话，
   *   一个叫 pi 的 key 能把内置常数顶掉，而那是模型够得着的输入。 */
  eq('未声明的 scope key 一律忽略（pi 顶不掉内置常数）', at('pi', 0, [], { pi: 999 }), Math.PI);
  eq('未声明的 scope key 一律忽略（a 不在 varNames 里就用不上）', at('x', 2, [], { a: 3 }), 2);

  throws('表达式里用了没声明的符号要在编译期报错', () => c('y + 1', []));
  throws('参数名不许叫 x', () => c('a*x', ['x']));
  throws('参数名不许撞内置常数', () => c('pi*x', ['pi']));
  throws('参数名不许撞内置函数', () => c('sin*x', ['sin']));
  throws('括号不配对要报错', () => c('(x+1', []));
  throws('多余的右括号要报错', () => c('x)', []));
  eq('隐式乘法允许连续写（x 1 2 读作 x*1*2，不算多余内容）', at('x 1 2', 4), 8);
  throws('空表达式要报错', () => c('', []));
  throws('不认识的函数要报错', () => c('foo(x)', []));

  // 采样：不连续处用 null 标记，让渲染层断开路径
  const pts = samplePoints(compile('1/x', []), -1, 1, 40);
  ok('采样遇到极点用 null 断笔（而不是画一条飞出去的竖线）', pts.some(([, y]) => y === null));
  ok('采样点数是 n+1', samplePoints(compile('x', []), 0, 1, 40).length === 41);
}

/* ============================================================
   2. 判分
   ============================================================ */
{
  eq('LaTeX 分数被转成可比的除法形式', normalizeAnswer('\\frac{1}{2}'), '(1)/(2)');
  eq('方程答案剥成纯值', normalizeAnswer('x=2'), '2');
  eq('全角数字归一', normalizeAnswer('０.５'), '0.5');
  eq('中文减号归一', normalizeAnswer('−3'), '-3');
  eq('定界符与空格清掉', normalizeAnswer('$ 1 / 2 $'), '1/2');
  eq('「约等于」不会留下前导等号', normalizeAnswer('约等于 0.67'), '0.67');

  eq('分数解析', parseNumeric('1/2'), 0.5);
  eq('百分数解析', parseNumeric('50%'), 0.5);
  near('2π 解析', parseNumeric('2π'), 2 * Math.PI, 1e-9);
  near('π/2 解析', parseNumeric('π/2'), Math.PI / 2, 1e-9);
  near('-π 解析', parseNumeric('-π'), -Math.PI, 1e-9);
  eq('0 是合法答案，不能被当成「解析不出来」', parseNumeric('0'), 0);
  eq('√2 判不了（要和 \\sqrt{2} 保持同一种不可判）', parseNumeric('√2'), null);
  eq('空串判不了', parseNumeric(''), null);
  eq('分母为 0 判不了', parseNumeric('1/0'), null);
  eq('文字判不了', parseNumeric('至少 1 个'), null);

  const choiceQ = {
    type: 'choice', stem: '这是一个足够长的选择题题干',
    options: [{ k: 'A', t: '甲' }, { k: 'B', t: '乙' }, { k: 'C', t: '丙' }, { k: 'D', t: '丁' }],
    answer: 'B',
  };
  eq('选择题判对', judge(choiceQ, 'B').correct, true);
  eq('选择题判对（小写输入）', judge(choiceQ, 'b').correct, true);
  eq('选择题判错', judge(choiceQ, 'A').correct, false);
  eq('选择题空答算错', judge(choiceQ, '').correct, false);

  const fillQ = { type: 'fill', stem: '这是一个足够长的填空题题干', answer: '1/2' };
  eq('填空题 0.5 判对（分数与小数互通）', judge(fillQ, '0.5').correct, true);
  eq('填空题 2/4 判对（等值分数）', judge(fillQ, '2/4').correct, true);
  eq('填空题 0.6 判错', judge(fillQ, '0.6').correct, false);
  eq('填空题「不会」判错而不是判不了', judge(fillQ, '不会').gradable, true);

  const textQ = { type: 'fill', stem: '这是一个足够长的填空题题干', answer: '至少 1 个' };
  const tr = judge(textQ, '至少 1 个');
  eq('★ 判不了的题要返回 gradable:false，不能压成「错」', tr.gradable, false);
  eq('★ 判不了时 correct 必须是 null（不是 false）', tr.correct, null);
  ok('判不了时要把标准答案摊给用户', String(tr.standard).length > 0);

  eq('三个选项的选择题判不了', answerIssue({ type: 'choice', stem: '够长的题干在这里', options: [{ k: 'A', t: 'a' }, { k: 'B', t: 'b' }, { k: 'C', t: 'c' }], answer: 'A' }) !== null, true);
  eq('选项键不是 ABCD 判不了', answerIssue({ type: 'choice', stem: '够长的题干在这里', options: [{ k: 'A', t: 'a' }, { k: 'B', t: 'b' }, { k: 'C', t: 'c' }, { k: 'E', t: 'e' }], answer: 'A' }) !== null, true);
  eq('答案不在 ABCD 判不了', answerIssue({ type: 'choice', stem: '够长的题干在这里', options: [{ k: 'A', t: 'a' }, { k: 'B', t: 'b' }, { k: 'C', t: 'c' }, { k: 'D', t: 'd' }], answer: 'Z' }) !== null, true);
  eq('两个选项文字一样判不了（答案不唯一）', answerIssue({ type: 'choice', stem: '够长的题干在这里', options: [{ k: 'A', t: '同' }, { k: 'B', t: '同' }, { k: 'C', t: 'c' }, { k: 'D', t: 'd' }], answer: 'A' }) !== null, true);
  eq('题干太短判不了', answerIssue({ type: 'fill', stem: '求值', answer: '1' }) !== null, true);
  eq('合法的选择题判得了', answerIssue(choiceQ), null);
  eq('合法的填空题判得了', answerIssue(fillQ), null);

  eq('prettyAnswer 选择题给大写键', prettyAnswer(choiceQ), 'B');
  eq('prettyAnswer 填空题归一化', prettyAnswer(fillQ), '1/2');
}

/* ============================================================
   3. ★ 清洗函数的不变量 + 畸形输入扫描
   ============================================================ */
{
  const WEIRD = [
    null, undefined, '', '   ', '这不是 JSON', '{}', '{"questions":null}', '{"questions":[null]}',
    '{"questions":[{}]}',
    '{"questions":[{"type":"choice","stem":"够长的题干在这里","options":[],"answer":"A"}]}',
    '{"questions":[{"type":"choice","stem":"够长的题干在这里","options":[{"k":"A","t":"a"},{"k":"B","t":"b"},{"k":"C","t":"c"}],"answer":"A"}]}',
    '{"questions":[{"type":"choice","stem":"够长的题干在这里","options":[{"k":"A","t":"a"},{"k":"B","t":"b"},{"k":"C","t":"c"},{"k":"D","t":"d"}],"answer":"Z"}]}',
    '{"questions":[{"type":"fill","stem":"够长的题干在这里","answer":"无解"}]}',
    '{"questions":[{"type":"fill","stem":"够长的题干在这里","answer":"\\\\sqrt{2}"}]}',
    '{"questions":[{"type":"fill","stem":"够长的题干在这里","answer":"x_1=1, x_2=2"}]}',
    '{"questions":[{"type":"fill","stem":"够长的题干在这里","answer":""}]}',
    '{"questions":[{"type":"fill","stem":"短","answer":"1"}]}',
    '```json\n{"questions":[{"type":"fill","stem":"够长的题干在这里","answer":"1/2"}]}\n```',
    '前面的解释文字 {"questions":[{"type":"fill","stem":"够长的题干在这里","answer":"x=2"}]} 后面的解释',
    '[{"type":"fill","stem":"够长的题干在这里","answer":"0.5"}]',
  ];

  /* ★ 不变量：只要产出了一道题，它就**一定**是可判的。
   *   这条比前面所有单点断言加起来都值钱 —— 它保证不管模型吐什么，
   *   前端拿到的题都判得了分。 */
  let produced = 0;
  for (const raw of WEIRD) {
    const res = sanitizeGenerated(raw, { count: 3 });
    produced += res.created.length;
    for (const q of res.created) {
      ok(`不变量：产出的题一定可判（输入 ${JSON.stringify(String(raw).slice(0, 24))}）`, answerIssue(q) === null);
      if (q.type === 'choice') {
        ok('不变量：选择题一定正好 4 个选项且键是 ABCD', q.options.length === 4 && q.options.map((o) => o.k).join('') === 'ABCD');
        ok('不变量：选择题的答案一定落在选项里', 'ABCD'.includes(String(q.answer).toUpperCase()));
      } else {
        ok('不变量：填空题的答案一定能解析成有限数', Number.isFinite(parseNumeric(q.answer)));
      }
    }
    ok('不变量：created 是数组', Array.isArray(res.created));
    ok('不变量：丢弃计数不为负', res.skippedUnjudgeable >= 0 && res.skippedDuplicate >= 0);
  }
  ok('★ 畸形输入扫过一轮后确实有题目被救回来（说明不是全丢）', produced > 0);

  /* ★ 自检：手工写一个「不做校验」的错误实现，确认不变量抓得住它。
   *   一个永远为绿的检查比没有检查更糟。 */
  function brokenSanitize(raw) {
    const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
    const list = (parsed && parsed.questions) || [];
    return list.filter((q) => q && typeof q === 'object').map((q) => ({ ...q, options: q.options || [] }));
  }
  let brokenCaught = false;
  for (const raw of WEIRD) {
    for (const q of brokenSanitize(raw)) {
      if (answerIssue(q) !== null) { brokenCaught = true; break; }
    }
    if (brokenCaught) break;
  }
  ok('★ 自检：不变量确实能抓住「不做校验」的错误实现（不是永远为绿）', brokenCaught);

  // 该丢的丢
  const allBad = sanitizeGenerated(JSON.stringify({
    questions: [
      { type: 'fill', stem: '请证明这个数列收敛并写出完整证明。', answer: '无解' },
      { type: 'fill', stem: '求这个长度的值是多少？', answer: '\\sqrt{2}' },
      { type: 'choice', stem: '只有三个选项的题应该被丢掉。', options: [{ k: 'A', t: 'a' }, { k: 'B', t: 'b' }, { k: 'C', t: 'c' }], answer: 'A' },
    ],
  }), { count: 3 });
  eq('全是坏形状时一道都不留', allBad.created.length, 0);
  eq('一道都出不来时明确报 parseFailed', allBad.parseFailed, true);
  eq('丢了几道要如实上报', allBad.skippedUnjudgeable, 3);

  // 该救的救
  const saved = sanitizeGenerated(JSON.stringify({
    questions: [
      { type: 'fill', stem: '计算这个定积分的值是多少？', answer: '\\frac{1}{2}' },
      { type: 'fill', stem: '求这个方程的解的值是多少？', answer: 'x=2' },
    ],
  }), { count: 3 });
  eq('LaTeX 分数被救成 1/2 形式', saved.created[0].answer, '1/2');
  eq('方程答案被剥成纯值 2', saved.created[1].answer, '2');

  // 去重
  const dup = sanitizeGenerated(JSON.stringify({
    questions: [
      { type: 'fill', stem: '同一道题换个数字出两遍。', answer: '1' },
      { type: 'fill', stem: '同一道题换个数字出两遍。', answer: '1' },
    ],
  }), { count: 3 });
  eq('同批去重', dup.created.length, 1);
  eq('重复计数上报', dup.skippedDuplicate, 1);

  const known = sanitizeGenerated(JSON.stringify({
    questions: [{ type: 'fill', stem: '题库里已经有的题干。', answer: '1' }],
  }), { count: 3, knownStems: ['题库里已经有的题干。'] });
  eq('和题库已有题干去重', known.created.length, 0);

  // ★ 缓冲：要 3 道就让它出 5 道 —— 模型总会出一两道不可判的
  const buffered = sanitizeGenerated(JSON.stringify({
    questions: [
      { type: 'fill', stem: '坏题一，答案不可判。', answer: '无解' },
      { type: 'fill', stem: '好题一，答案是数值。', answer: '1' },
      { type: 'fill', stem: '坏题二，答案不可判。', answer: '\\sqrt{3}' },
      { type: 'fill', stem: '好题二，答案是数值。', answer: '2' },
      { type: 'fill', stem: '好题三，答案是数值。', answer: '3' },
    ],
  }), { count: 3 });
  eq('★ 缓冲生效：5 道里 2 道不可判，仍然凑够 3 道', buffered.created.length, 3);

  // 部分成功要返回部分结果，不能全丢
  const partial = sanitizeGenerated(JSON.stringify({
    questions: [
      { type: 'fill', stem: '好题，答案是数值。', answer: '1' },
      { type: 'fill', stem: '坏题，答案不可判。', answer: '无解' },
    ],
  }), { count: 3 });
  eq('部分成功也要返回（不是全丢）', partial.created.length, 1);
  eq('部分成功时 parseFailed 为 false', partial.parseFailed, false);

  eq('extractJson 能剥 ```json 围栏', extractJson('```json\n{"a":1}\n```').a, 1);
  eq('extractJson 能跳过前后解释文字', extractJson('说明 {"a":2} 完了').a, 2);
  eq('extractJson 解析不了就返回 null', extractJson('完全没有 JSON'), null);
}

/* ============================================================
   4. ★ 阶段状态机与意图分类
   ============================================================ */
{
  /* ★ 顺序不能反：「听不懂」「没听懂」里都带一个「懂」字。
   *   反过来判的话「我还是没听懂」会被归成「听懂了」，
   *   下一轮直接甩一道题出来 —— 那正是要修的毛病本身。 */
  eq('★「我还是没听懂」必须归成 confused（不是 understood）', classifyIntent('我还是没听懂'), 'confused');
  eq('★「这个我真不知道…」归成 confused（不做整句锚定）', classifyIntent('这个我真不知道…'), 'confused');
  eq('★「哎不懂啊」归成 confused', classifyIntent('哎不懂啊'), 'confused');
  eq('★「跟不上」归成 confused', classifyIntent('有点跟不上'), 'confused');
  eq('「听懂了」归成 understood', classifyIntent('听懂了'), 'understood');
  eq('「明白了，继续」归成 understood', classifyIntent('明白了，继续'), 'understood');
  eq('空输入归成 none', classifyIntent(''), 'none');
  eq('只有空格也归成 none', classifyIntent('   '), 'none');
  /* ★「提问」要排在「其他」之前：既不含困惑词也不含「懂了」的提问
   *   归成 other 的话，状态机会认为他做出了实质回应，于是推去练习。 */
  eq('★ 纯提问（无困惑词无懂字）归成 question 而不是 other', classifyIntent('我还是想问一下为什么这里要加条件？'), 'question');
  eq('含问号的短句归成 question', classifyIntent('这一步对吗？'), 'question');
  eq('闲聊归成 other', classifyIntent('今天天气不错'), 'other');

  eq('第 0 轮一定是 lecture', nextPhase('explain', 'understood', 0), 'lecture');
  eq('confused → clarify', nextPhase('lecture', 'confused', 1), 'clarify');
  eq('understood → practice', nextPhase('clarify', 'understood', 1), 'practice');
  eq('question 且上一轮不是 clarify → explain', nextPhase('lecture', 'question', 1), 'explain');
  eq('question 且上一轮是 clarify → 留在 clarify', nextPhase('clarify', 'question', 1), 'clarify');
  eq('clarify + other → practice', nextPhase('clarify', 'other', 1), 'practice');
  /* ★ 用户点了「继续」但一个字没打（intent = none）时，不许自己滑进练习。
   *   没有明确信号就留在原地重讲 —— 保守方向是这里唯一正确的方向。 */
  eq('★ clarify + none → 留在 clarify（不许自己滑进练习）', nextPhase('clarify', 'none', 1), 'clarify');
  eq('默认 → explain', nextPhase('lecture', 'other', 2), 'explain');

  eq('clarify 阶段只有老师能说话', canSpeak('clarify', 'a'), false);
  eq('clarify 阶段老师能说话', canSpeak('clarify', 'teacher'), true);
  eq('lecture 阶段学生能说话', canSpeak('lecture', 'b'), true);

  /* ★ 判断「算题」的正则要小心误杀：`求极限有哪些方法` 是正常的理解确认问题，
   *   拦下来反而把好问题换成通用兜底句。 */
  eq('★「求极限有哪些方法？」不算算题（不能误杀）', isComputeQuestion('求极限有哪些方法？'), false);
  eq('★「求导有哪些技巧？」不算算题', isComputeQuestion('求导有哪些技巧？'), false);
  eq('★「下列说法哪个对？」不算算题', isComputeQuestion('下列说法哪个对？'), false);
  eq('「计算下列各题的值？」算算题', isComputeQuestion('计算下列各题的值？'), true);
  eq('「请证明这个结论？」算算题', isComputeQuestion('请证明这个结论？'), true);
  eq('「等于多少？」算算题', isComputeQuestion('lim sinx/x 等于多少？'), true);
  eq('「求 f′(ξ) 的值？」算算题', isComputeQuestion('求 f′(ξ) 的值？'), true);

  /* ---- 硬过滤 ---- */
  const turns1 = [
    { role: 'teacher', text: '(focus)\n我先讲讲这个定理。' },
    { role: 'a', text: '我觉得是……' },
    { role: 'b', text: '我也说两句。' },
    { role: 'c', text: '我听不懂。' },
  ];
  const r1 = enforcePhase('clarify', turns1);
  eq('★ clarify 阶段把非老师角色全部摘掉', r1.silenced, 3);
  eq('clarify 阶段只留老师', r1.turns.length, 1);
  eq('★ clarify 阶段没留问题就补一个', r1.promptAdded, true);
  ok('补的问题就是兜底确认句之一', COMPREHENSION_CHECKS.some((c) => r1.turns[0].text.includes(c)));
  ok('★ 兜底确认句里有「说不清也没关系」的出口（少一个按钮这条链就断了）',
    COMPREHENSION_CHECKS.some((c) => c.includes('说不清')));
  ok('★ 每一条兜底确认句本身都不是算题（换了之后不能又违规）',
    COMPREHENSION_CHECKS.every((c) => !isComputeQuestion(lastQuestion(c))));
  ok('★ 每一条兜底确认句都以问句结尾（否则前端那块「老师留了个问题」的卡片不出现）',
    COMPREHENSION_CHECKS.every((c) => lastQuestion(c).length > 0));

  const r2 = enforcePhase('clarify', [{ role: 'teacher', text: '好，那我们计算一下 lim(x→0) sinx/x 等于多少？' }]);
  eq('★ clarify 阶段结尾的算题被换掉', r2.promptAdjusted, true);
  eq('换掉之后不再是算题', isComputeQuestion(lastQuestion(r2.turns[0].text)), false);

  const r3 = enforcePhase('clarify', [{ role: 'teacher', text: '那你想想，去掉第二个条件会怎么样？' }]);
  eq('正常的理解确认问题不动它', r3.promptAdjusted, false);
  eq('已经有问题就不补', r3.promptAdded, false);

  const r4 = enforcePhase('lecture', turns1);
  eq('lecture 阶段不静默任何人', r4.silenced, 0);
  eq('lecture 阶段四条都留下', r4.turns.length, 4);

  eq('findLastQuestion 取最后一个问句', lastQuestion('第一问？第二问？'), '第二问？');
  eq('findLastQuestion 在冒号后断开', lastQuestion('我先问你一个：为什么？'), '为什么？');
  eq('没有问号返回空串', lastQuestion('这是一句陈述。'), '');

  /* ---- 教学动作标签 ---- */
  const m1 = parseMove('(focus)\n正文在这里');
  eq('标签被解析出来', m1.move, 'focus');
  eq('标签被剥掉', m1.text, '正文在这里');
  eq('标签大小写不敏感', parseMove('(TELLING) 正文').move, 'telling');
  eq('没有标签时 move 是空串', parseMove('就是普通正文').move, '');
  eq('没有标签时正文不动', parseMove('就是普通正文').text, '就是普通正文');

  eq('引导占比', guidanceRatio({ focus: 2, probing: 1, telling: 1 }), 0.75);
  eq('没有动作时占比是 null（不是 0 —— 0 会被误读成「全在念答案」）', guidanceRatio(blankMoves()), null);

  /* ---- compaction ---- */
  const long = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` });
  const comp = compact(long, { keep: 10 });
  ok('压缩后消息变少', comp.length < long.length);
  eq('压缩保留 system', comp[0].role, 'system');
  ok('压缩后有一行前情提要', comp.some((m) => String(m.content).startsWith('【前情提要】')));
  eq('短对话不压缩', compact([{ role: 'system', content: 'S' }], { keep: 10 }).length, 1);
}

/* ============================================================
   5. ★ 工具白名单与角色隔离
   ============================================================ */
{
  ok('自检函数通过', assertStudentCannotWriteSolution() === true);
  eq('学生白名单里没有写解答类工具', STUDENT_TOOLS.filter((t) => TEACHER_ONLY.includes(t)).length, 0);
  eq('老师白名单里没有学生专用工具', TEACHER_TOOLS.filter((t) => STUDENT_ONLY.includes(t)).length, 0);
  ok('学生没有 write_steps（会画图不等于会写解法）', !STUDENT_TOOLS.includes('write_steps'));
  ok('学生没有 write_latex', !STUDENT_TOOLS.includes('write_latex'));
  ok('学生没有 clear_board', !STUDENT_TOOLS.includes('clear_board'));
  ok('老师没有 raise_hand（老师不用举手）', !TEACHER_TOOLS.includes('raise_hand'));
  ok('老师没有 pass', !TEACHER_TOOLS.includes('pass'));

  const ts = schemaFor('teacher').map((t) => t.function.name);
  const ss = schemaFor('a').map((t) => t.function.name);
  ok('老师 schema 里有 write_steps', ts.includes('write_steps'));
  ok('学生 schema 里没有 write_steps', !ss.includes('write_steps'));
  ok('学生 schema 里有 raise_hand', ss.includes('raise_hand'));
  ok('老师 schema 里没有 raise_hand', !ts.includes('raise_hand'));
  eq('schema 数量与白名单一致', ts.length, toolNamesFor('teacher').length);
  eq('schema 数量与白名单一致（学生）', ss.length, toolNamesFor('a').length);

  const ctx = makeCtx({ role: 'a', depth: 'c', session: { board: [] }, distractorIndex: 2 });
  const tctx = makeCtx({ role: 'teacher', depth: 'teacher', session: { board: [] } });

  eq('★ 学生越权调用 write_steps 被拒', execute('write_steps', { steps: ['一步'] }, ctx, 'a').ok, false);
  eq('★ 学生越权调用 clear_board 被拒', execute('clear_board', {}, ctx, 'a').ok, false);
  eq('★ 学生越权调用 query_weakness 被拒', execute('query_weakness', {}, ctx, 'a').ok, false);
  eq('老师调用 write_steps 通过', execute('write_steps', { steps: ['一步'] }, tctx, 'teacher').ok, true);
  eq('★ 老师越权调用 raise_hand 被拒', execute('raise_hand', { reason: 'x' }, tctx, 'teacher').ok, false);
  ok('被拒时错误信息里列出了可用清单', /可用清单|只能用/.test(execute('write_steps', { steps: ['x'] }, ctx, 'a').error));

  /* ---- 黑板动作族：统一返回结构 ---- */
  const kinds = {};
  const g = execute('draw_graph', { expr: 'x^2' }, tctx, 'teacher');
  eq('draw_graph 成功', g.ok, true);
  eq('★ 黑板动作统一返回 type:board', g.render.type, 'board');
  eq('★ 黑板动作统一返回 item.kind', g.render.item.kind, 'graph');
  ok('图里有采样点', g.render.item.samples.length > 10);
  ok('图里有钉死的坐标轴范围', g.render.item.ymin < g.render.item.ymax);
  ok('★ data 里**没有**采样点（别把渲染内容塞给模型白烧 token）', !JSON.stringify(g.data).includes('samples'));

  const s = execute('write_steps', { title: '求导', steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] }, tctx, 'teacher');
  eq('步骤最多 8 条', s.render.item.steps.length, 8);
  eq('步骤动作 kind 正确', s.render.item.kind, 'steps');

  const l = execute('write_latex', { tex: '$$f\'(\\xi)=0$$' }, tctx, 'teacher');
  eq('公式动作 kind 正确', l.render.item.kind, 'latex');
  eq('★ $ 定界符被自动剥掉', l.render.item.tex, 'f\'(\\xi)=0');

  /* ★ highlight 不是一块内容，是打在已有块上的光，**不占黑板块数的号**。
   *   计数口径和渲染口径必须一致，否则该播动画的块不播。 */
  const sess = { board: [{ kind: 'steps', steps: ['由 f(a)=f(b) 得'] }] };
  const hctx = makeCtx({ role: 'teacher', depth: 'teacher', session: sess });
  const h = execute('highlight', { target: 'f(a)=f(b)', why: '关键条件' }, hctx, 'teacher');
  eq('highlight 按文字匹配成功', h.ok, true);
  eq('highlight 也是 board 动作', h.render.item.kind, 'highlight');
  eq('黑板上没有目标时 highlight 失败', execute('highlight', { target: '不存在的文字' }, hctx, 'teacher').ok, false);
  eq('空黑板时 highlight 失败', execute('highlight', { target: 'x' }, makeCtx({ role: 'teacher', depth: 'teacher', session: { board: [] } }), 'teacher').ok, false);

  const renderable = boardRenderable([{ kind: 'graph' }, { kind: 'highlight' }, { kind: 'page' }, { kind: 'clear' }, { kind: 'steps' }]);
  eq('★ boardRenderable 只数真正画出来的块（口径唯一来源）', renderable.length, 2);
  ok('★ highlight / page / clear 都不算块', !BOARD_BLOCK_KINDS.includes('highlight') && !BOARD_BLOCK_KINDS.includes('page') && !BOARD_BLOCK_KINDS.includes('clear'));

  eq('page 动作 kind 正确', execute('new_page', {}, tctx, 'teacher').render.item.kind, 'page');
  eq('clear 动作 kind 正确', execute('clear_board', {}, tctx, 'teacher').render.item.kind, 'clear');

  /* ---- 参数化画图：坐标轴要预先算好并钉死 ---- */
  const pg = execute('draw_graph', {
    expr: 'a*x', xmin: -2, xmax: 2,
    params: [{ name: 'a', min: -3, max: 3, value: 1 }],
  }, tctx, 'teacher');
  eq('参数化画图成功', pg.ok, true);
  /* ★ 让每个参数各取遍 min / max 端点，把结果并起来求包络。
   *   不这么做的话坐标轴只覆盖 a=1 的那条线（|y|≤2），
   *   拖到 a=3 曲线就飞出画面了。 */
  ok('★ y 轴包络覆盖了参数范围（|y| 要接近 6 而不是 2）', pg.render.item.ymax >= 5.5, `ymax=${pg.render.item.ymax}`);
  ok('★ y 轴包络负方向也覆盖', pg.render.item.ymin <= -5.5, `ymin=${pg.render.item.ymin}`);
  eq('x 轴范围也一起存下来（重绘时不能退回默认）', [pg.render.item.xmin, pg.render.item.xmax], [-2, 2]);
  eq('参数名不能叫 x', execute('draw_graph', { expr: 'x^2', params: [{ name: 'x' }] }, tctx, 'teacher').ok, false);
  eq('参数名重复被拒', execute('draw_graph', { expr: 'a*x', params: [{ name: 'a' }, { name: 'a' }] }, tctx, 'teacher').ok, false);
  eq('表达式用了没声明的符号被拒', execute('draw_graph', { expr: 'k*x' }, tctx, 'teacher').ok, false);
  eq('xmax <= xmin 被拒', execute('draw_graph', { expr: 'x', xmin: 5, xmax: 1 }, tctx, 'teacher').ok, false);

  /* ---- calc：模型不该心算 ---- */
  near('calc 算得对', execute('calc', { expr: '1/2+1/3' }, tctx, 'teacher').data.value, 5 / 6, 1e-6);
  eq('calc 坏表达式返回错误而不是抛异常', execute('calc', { expr: 'x+' }, tctx, 'teacher').ok, false);

  /* ---- 角色化资料：结构性无知 ---- */
  const p = findPoint('罗尔定理');
  ok('找得到罗尔定理', !!p);
  eq('★ 后进生只拿到第一句定义', materialFor(p, 'c').definition, firstSentence(p.definition));
  ok('★ 后进生拿不到直观解释', materialFor(p, 'c').intuition === undefined);
  ok('★ 后进生拿不到适用范围', materialFor(p, 'c').scope === undefined);
  ok('★ 后进生拿不到例题', materialFor(p, 'c').example === undefined);
  ok('中等生拿得到例题', typeof materialFor(p, 'b').example === 'string');
  ok('中等生拿不到适用范围', materialFor(p, 'b').scope === undefined);
  ok('优等生拿得到适用范围', typeof materialFor(p, 'a').scope === 'string');
  ok('优等生拿不到考卷形式（那是老师的）', materialFor(p, 'a').examForm === undefined);
  ok('老师拿得到全部', typeof materialFor(p, 'teacher').examForm === 'string' && typeof materialFor(p, 'teacher').intuition === 'string');
  ok('只有老师看得到「学生常错在哪」', materialFor(p, 'teacher').commonMistakes && !materialFor(p, 'a').commonMistakes);
  eq('资料量按 teacher > a > b > c 递减', [
    JSON.stringify(materialFor(p, 'teacher')).length > JSON.stringify(materialFor(p, 'a')).length,
    JSON.stringify(materialFor(p, 'a')).length > JSON.stringify(materialFor(p, 'b')).length,
    JSON.stringify(materialFor(p, 'b')).length > JSON.stringify(materialFor(p, 'c')).length,
  ], [true, true, true]);
  ok('四种角色拿到的资料确实各不相同（不是同一份）',
    new Set(['teacher', 'a', 'b', 'c'].map((d) => JSON.stringify(materialFor(p, d)))).size === 4);

  /* 学生查资料的出口也要走裁剪 —— 绕过它差异就失效了 */
  const stuCtx = makeCtx({ role: 'c', depth: 'c', session: {}, distractorIndex: 2 });
  const looked = execute('look_up', { point: '罗尔定理' }, stuCtx, 'c');
  eq('★ 后进生通过工具查资料，也只拿到第一句', looked.data.definition, firstSentence(p.definition));
  const tlooked = execute('look_up', { point: '罗尔定理' }, tctx, 'teacher');
  ok('★ 老师通过工具查资料拿到完整定义', tlooked.data.definition.length > looked.data.definition.length);

  /* 干扰项分配：一人一个，不越界，且不含正确答案 */
  const d0 = distractorAt(p, 0), d1 = distractorAt(p, 1), d2 = distractorAt(p, 2), d99 = distractorAt(p, 99);
  ok('干扰项不越界（用 min 夹住）', d99 !== null && d99.index <= (d99.total - 1));
  eq('干扰项总数一致', d0.total, d1.total);
  ok('分给不同角色的干扰项不同（讨论才有张力）', d0.text !== d1.text);

  /* ---- 找不到考点时的报错要给出可选项 ---- */
  const miss = execute('look_up', { point: '不存在的考点xyz' }, tctx, 'teacher');
  eq('找不到考点返回失败', miss.ok, false);
  ok('报错里列出了现有考点', miss.error.includes('罗尔定理'));
}

/* ============================================================
   6. LaTeX 渲染
   ============================================================ */
{
  ok('分式被渲染成 lx-frac', renderLatex('\\frac{1}{2}').includes('lx-frac'));
  ok('根号被渲染成 lx-sqrt', renderLatex('\\sqrt{2}').includes('lx-sqrt'));
  ok('上标被渲染成 sup', renderLatex('x^{2}').includes('<sup>2</sup>'));
  ok('下标被渲染成 sub', renderLatex('a_{n}').includes('<sub>n</sub>'));
  ok('希腊字母被替换', renderLatex('\\xi \\lambda \\pi').includes('ξ') && renderLatex('\\lambda').includes('λ'));
  ok('\\left \\right 被剥掉', !renderLatex('\\left( x \\right)').includes('\\left'));
  ok('定界符被剥掉', !renderLatex('$$x^2$$').includes('$'));
  ok('不认识的宏原样保留（不吞掉）', renderLatex('\\begin{matrix}').includes('\\begin'));

  /* ★ XSS：先转义再做替换。反过来的话模型输出里的 <script> 会被当标签塞进 DOM。 */
  ok('★ 尖括号被转义', renderLatex('<script>alert(1)</script>').includes('&lt;script&gt;'));
  ok('★ 引号被转义', escapeHtml('a"b').includes('&quot;'));
  ok('★ 行内混排：公式外的 < 只转义一次', renderInline('a < b 且 $x^2$').includes('a &lt; b'));
  ok('★ 行内混排不会双重转义', !renderInline('a < b 且 $x^2$').includes('&amp;lt;'));
  ok('行内公式被渲染', renderInline('$x^2$').includes('<sup>2</sup>'));
}

/* ============================================================
   7. 本地档案
   ============================================================ */
{
  Store._clearMemory();
  eq('没有记录时正确率是 null（不是 0 —— 0 会被误读成「全错」）', Store.accuracy('rolle'), null);
  ok('没有记录时档案里明说这是第一次课', Store.learningProfile().includes('第一次课'));

  Store.recordAnswer({ pointId: 'rolle', qid: 'q1', answer: 'A', correct: false });
  Store.recordAnswer({ pointId: 'rolle', qid: 'q2', answer: 'B', correct: true });
  Store.recordAnswer({ pointId: 'rolle', qid: 'q3', answer: 'A', correct: false });
  near('正确率 1/3', Store.accuracy('rolle'), 1 / 3, 1e-9);
  eq('错题记录条数', Store.recentMistakes(5).length, 2);

  const weak = Store.weakPoints(5);
  eq('薄弱考点有罗尔定理', weak[0].pointId, 'rolle');
  eq('累计错次数', weak[0].wrong, 2);

  const prof = Store.learningProfile('rolle');
  ok('★ 档案里带上了考点名（不是「该生基础薄弱」这种空话）', prof.includes('罗尔定理'));
  ok('★ 档案里带上了数字', /\d+%/.test(prof));
  ok('★ 档案里带上了最近的作答序列', prof.includes('错对错'));
  ok('档案里带上了他答错的原文', prof.includes('他答'));

  Store.recordClass({ topic: '罗尔定理', mode: 'class', turns: 7 });
  ok('上课记录进了档案', Store.learningProfile().includes('罗尔定理'));

  Store._clearMemory();
  eq('清空后档案回到初始状态', Store.load().answers.length, 0);
}

/* ============================================================
   8. ★ 集群门禁：用「现在是否在跑」，不能用「是否有内容」
   ============================================================ */
{
  const s = Classroom.newSession('rolle', 'class');
  eq('★ 新建的会话 turns 是空的（这正是当初踩坑的地方）', s.turns.length, 0);
  eq('★ 没 markLive 时不能插话', Classroom.canInterject(s), false);

  Classroom.markLive(s);
  /* ★ 关键断言：turns 仍然为空，但输入框必须可用。
   *   写成 turns.length > 0 的话，输入框一渲染出来就是禁用的，整节课都点不了。 */
  eq('★ markLive 之后、还没说一句话时就能插话', Classroom.canInterject(s), true);
  eq('placeholder 是可插话时的文案', Classroom.interjectPlaceholder(s).includes('插一句话'), true);

  s.awaiting = { prompt: 'x', resolve: () => {} };
  eq('★ 等待作答期间不能插话（否则老师被两条线拉扯）', Classroom.canInterject(s), false);
  ok('等待期间 placeholder 说清了为什么禁用', Classroom.interjectPlaceholder(s).includes('先把上面那道题交了'));

  s.awaiting = null;
  Classroom.markDead(s);
  eq('★ 课结束后不能插话', Classroom.canInterject(s), false);
  ok('结束后的 placeholder 说清了要重开一节', Classroom.interjectPlaceholder(s).includes('重开一节'));

  /* ---- 挂起 / 唤醒 ---- */
  const s2 = Classroom.newSession('rolle', 'solo');
  Classroom.markLive(s2);
  const events = [];
  let resolved = null;
  const p = Classroom.askUser(s2, { onEvent: (e) => events.push(e) }, { prompt: '你觉得呢？' });
  ok('挂起后 session.awaiting 有值', !!s2.awaiting);
  /* ★ emit 必须在 onAsk 分支之前。写在 Promise executor 里的话，
   *   onAsk 直通会提前 return，UI 永远收不到「该你了」事件。 */
  eq('★ 挂起事件在 Promise 创建前就发出了', events.filter((e) => e.type === 'ask').length, 1);
  eq('挂起事件里带上了问题', events[0].spec.prompt, '你觉得呢？');
  eq('提交答案返回 true', Classroom.submitAnswer(s2, '我懂了'), true);
  resolved = await p;
  eq('唤醒后拿到答案', resolved, '我懂了');
  eq('唤醒后 awaiting 清空', s2.awaiting, null);
  eq('没有 awaiting 时提交返回 false（接不上）', Classroom.submitAnswer(s2, 'x'), false);

  const p2 = Classroom.askUser(s2, {}, { prompt: '再来' });
  eq('跳过返回 true', Classroom.skipAnswer(s2), true);
  const r2 = await p2;
  ok('跳过时回的是 __skipped 标记', r2 && r2.__skipped === true);
  eq('跳过计数加一', s2.passed, 1);

  /* onAsk 直通（测试 / 无人值守） */
  const p3 = Classroom.askUser(s2, { onAsk: () => '直通答案' }, { prompt: 'q' });
  eq('onAsk 直通能拿到值', await p3, '直通答案');
  eq('直通模式下不设 awaiting', s2.awaiting, null);

  /* ---- 本地调度短路 ---- */
  const s3 = Classroom.newSession('rolle', 'class');
  s3.targetSpoke = 9;
  eq('★ 有人举手 → 直接定老师，不问模型', Classroom.localSchedule({ ...s3, pendingHand: { role: 'a' } }), 'teacher');
  eq('★ 还有人没开口 → 直接定他，不问模型', Classroom.localSchedule(s3), 'a');
  s3.spoke = { a: 1, b: 1, c: 1 };
  s3.targetSpoke = 3;
  eq('说到量了 → 结束，不问模型', Classroom.localSchedule(s3), null);
  s3.targetSpoke = 99;
  eq('都不满足 → undefined（交给模型）', Classroom.localSchedule(s3), undefined);

  const rot = Classroom.fallbackRotate({ spoke: { a: 2, b: 0, c: 1 }, _lastSpeaker: 'a' });
  ok('兜底轮转不会连着同一个人', rot !== 'a');

  /* ---- 记忆：吸收点名 ---- */
  const s4 = Classroom.newSession('rolle', 'class');
  Classroom.absorbMentions(s4, '林一鸣说得对，前提条件你漏了。周雨桐这次注意了条件。马小虎的概念还是混的。');
  eq('点名进了林一鸣的记忆', s4.memory.a.length, 1);
  eq('点名进了周雨桐的记忆', s4.memory.b.length, 1);
  eq('点名进了马小虎的记忆', s4.memory.c.length, 1);
  ok('记忆里写清了是「老师点评到我」', s4.memory.a[0].includes('老师点评到我'));
  Classroom.absorbMentions(s4, '林一鸣说得对，前提条件你漏了。');
  eq('重复的点名不重复记', s4.memory.a.length, 1);
  for (let i = 0; i < 8; i++) Classroom.pushMemory(s4, 'a', `第 ${i} 条不同的记忆`);
  ok('记忆上限 4 条', s4.memory.a.length <= 4);

  /* ---- 一场课大概几次调用：要能算出来，别让用户猜 ---- */
  ok('solo 模式的调用估算小于 class 模式', Classroom.estimateCalls('solo') < Classroom.estimateCalls('class'));
  ok('估算是个正整数', Classroom.estimateCalls('class') > 0);

  /* ---- 阶段元信息齐全 ---- */
  ok('三种模式都有说明', Object.values(Classroom.MODES).every((m) => m.label && m.desc));
  ok('每个学生角色都绑了一种典型失误', STUDENT_KEYS.every((k) => AGENTS[k].errorMode && AGENTS[k].errorHint));
  ok('★ 每个学生角色都分了干扰项序号（一人一个坑）',
    new Set(STUDENT_KEYS.map((k) => AGENTS[k].distractorIndex)).size === STUDENT_KEYS.length);
}

/* ============================================================
   9. 内容自检 + 零依赖 + 语法
   ============================================================ */
{
  ok('考点数量 ≥ 10', POINTS.length >= 10);
  ok('每个考点都有五段内容（严格表述/直观/适用/例子/考卷形式）',
    POINTS.every((p) => p.definition && p.intuition && p.scope && p.example && p.examForm));
  ok('每个考点都有至少一道题', POINTS.every((p) => (p.questions || []).length > 0));
  ok('每道题都有干扰项（后进生的错要靠它当燃料）',
    POINTS.every((p) => p.questions.every((q) => (q.distractors || []).length > 0)));
  ok('每个考点 id 唯一', new Set(POINTS.map((p) => p.id)).size === POINTS.length);
  ok('related 指向的考点都真实存在',
    POINTS.every((p) => (p.related || []).every((r) => !!findPoint(r))));
  /* ★ 发给学生的干扰项里不能有正确答案 —— 谁对谁错让学生自己吵出来 */
  ok('★ 干扰项的文字不会和正确答案一模一样',
    POINTS.every((p) => p.questions.every((q) => (q.distractors || []).every((d) => d.text !== q.answer))));
  ok('DEPTH 覆盖全部角色', ['teacher', 'a', 'b', 'c'].every((k) => DEPTH[k]));

  /* ---- 语法自检：改完 js 立刻查，别等测试 ---- */
  const jsFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(e.name)) jsFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'public/js'));
  walk(path.join(ROOT, 'tests'));
  ok('待检查的 js 文件数量合理', jsFiles.length >= 10);
  let bad = [];
  for (const f of jsFiles) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad.push(`${path.relative(ROOT, f)}: ${String(e.stderr || e.message).split('\n')[0]}`); }
  }
  ok('★ 全部 js/mjs 通过语法检查', bad.length === 0, bad.join(' | '));

  /* ---- 零依赖自检 ---- */
  const offenders = [];
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    // 非相对路径的 import —— 那就是在引 npm 包
    const m = src.match(/(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g) || [];
    for (const line of m) {
      const spec = line.match(/from\s*['"]([^'"]+)['"]/)[1];
      if (!spec.startsWith('.') && !spec.startsWith('node:')) offenders.push(`${path.relative(ROOT, f)} → ${spec}`);
    }
    if (/\brequire\s*\(/.test(src)) offenders.push(`${path.relative(ROOT, f)} → 用了 CommonJS 的模块加载`);
  }
  ok('★ 零依赖：没有任何非相对路径的 import / require', offenders.length === 0, offenders.join(' | '));
  ok('★ 没有 node_modules 目录', !fs.existsSync(path.join(ROOT, 'node_modules')));
  ok('没有 package-lock.json（零依赖不该有锁文件）', !fs.existsSync(path.join(ROOT, 'package-lock.json')));

  /* ---- 前端资源与 DOM 接线 ---- */
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const ids = [...appSrc.matchAll(/\$\('#([a-zA-Z0-9_-]+)'/g)].map((m) => m[1]);
  /* 这几个 id 是**动态生成**的（答题卡、翻页按钮），不在静态模板里。
   * 白名单必须显式列出来 —— 用 `.*` 之类的通配会把真缺的 id 一起放过。 */
  const DYNAMIC_IDS = new Set(['ask-card', 'ask-input', 'ask-submit', 'ask-skip', 'pg-prev', 'pg-next']);
  const missing = [...new Set(ids)].filter((id) => !DYNAMIC_IDS.has(id) && !html.includes(`id="${id}"`));
  ok('★ app.js 里引用的每个 id 在 index.html 里都存在（或明确属于动态生成）',
    missing.length === 0, `缺失：${missing.join(', ')}`);
  ok('白名单里的动态 id 确实是在模板字符串里生成的',
    [...DYNAMIC_IDS].every((id) => appSrc.includes(`id="${id}"`)));

  /* ★ 黑板容器初始 HTML 就要带 data-blocks，
   *   否则第一次渲染读不到标记，会把已有内容全当成新的重播一遍动画。 */
  ok('★ 黑板容器初始 HTML 带了 data-blocks', /id="board"[^>]*data-blocks/.test(html));
  ok('★ 黑板容器初始 HTML 带了 data-clear', /id="board"[^>]*data-clear/.test(html));
  /* ★ 绑定必须覆盖两条渲染路径：初始渲染 + 后续重画 */
  ok('★ bindBoard 在 renderBoard 里被调用（后续重画路径）', /function renderBoard[\s\S]*?bindBoard\(\)/.test(appSrc));
  ok('★ bindBoard 在 init 里也被调用（初始渲染路径）', /function init\(\)[\s\S]*?renderBoard\(null\)/.test(appSrc));
  ok('★ bindBoard 用 data 标记防重复绑定', /data-board-bound/.test(appSrc));
  /* ★ isNaN 时 fallback 必须是 drawn.length，不能是 0 */
  ok('★ 增量动画记账的 isNaN fallback 是 drawn.length 而不是 0',
    /Number\.isNaN\(prevBlocks\)\s*\?\s*drawn\.length\s*:\s*prevBlocks/.test(appSrc));
  ok('★ 记账口径与渲染口径共用 BOARD_BLOCK_KINDS', /BOARD_BLOCK_KINDS/.test(appSrc));
  /* ★ 拖参数前要摘掉入场动画的类 */
  ok('★ 拖参数重绘前摘掉了 b-fresh（否则每拖一下重播一次入场动画）', /remove\('b-fresh'\)/.test(appSrc));
  /* ★ 中文输入法组合期不能提交 */
  ok('★ 输入框回车提交前检查了 isComposing（中文输入法选字时不误提交）',
    (appSrc.match(/isComposing/g) || []).length >= 2);
  /* ★ 一键按钮两个都要有 —— 少一个这条链就断了 */
  ok('★ 答题卡同时提供「还是没懂」和「懂了，继续」',
    html.includes('id="ask-slot"') && appSrc.includes('还是没懂') && appSrc.includes('懂了，继续'));
  /* ★ 三种判定结果不能压成两种 */
  ok('★ UI 里区分了「判不了」这一种结果', /verdict manual/.test(appSrc));
  /* ★ 减少动态效果时要同时清掉 stroke-dasharray */
  const boardCss = fs.readFileSync(path.join(ROOT, 'public/css/board.css'), 'utf8');
  ok('★ prefers-reduced-motion 里同时清掉了 stroke-dasharray（少这句曲线会整条消失）',
    /prefers-reduced-motion[\s\S]*stroke-dasharray:\s*none/.test(boardCss));
  ok('★ 描线动画用 pathLength 归一化而不是去量路径', /pathLength="1"/.test(appSrc));
  /* 汉字不能加字距 */
  /* 查之前先把注释剥掉 —— 不剥的话，那句「汉字不能加 letter-spacing」的**说明文字**
     会把自己检出来（真踩过：检查器被自己的注释绊倒）。 */
  const baseCss = fs.readFileSync(path.join(ROOT, 'public/css/base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('★ 全局没有给汉字加 letter-spacing', !/body\s*\{[^}]*letter-spacing/.test(baseCss));
}

/* ============================================================
   10. server.js 的静态服务与密钥隔离
   ============================================================ */
{
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('★ 服务端有路径穿越防护', /startsWith\(PUBLIC_DIR \+ path\.sep\)/.test(serverSrc));
  ok('★ /api/health 只回「有没有 key」，不回 key 本身', /hasKey/.test(serverSrc) && !/key:\s*API_KEY/.test(serverSrc));
  ok('★ 密钥只在 Authorization 头里出现一次', (serverSrc.match(/Bearer \$\{API_KEY\}/g) || []).length === 1);
  ok('★ 上游报错时读正文再转发（否则前端只能看到一句「请求失败」）', /await upstream\.text\(\)/.test(serverSrc));
  ok('★ 客户端断开时 abort 上游（否则用户关掉页面还在计费）', /res\.on\('close'/.test(serverSrc));
  ok('★ 空 tools 数组不下发（某些网关会判成参数错误）', /body\.tools\.length/.test(serverSrc));
  /* ★ 这条是真机测出来的：凭据类键必须 .env 优先。
   *   旧写法（环境变量一律优先）会让 ~/.zshrc 里的旧 key 静默顶掉 .env 里的新 key，
   *   而失败表现是 401 —— 看上去像 key 失效，完全查不到「用错了哪一把」。 */
  ok('★ 凭据类的键以 .env 为准（环境里的旧 key 不能静默顶掉它）',
    /const fileWins = secret && !forceEnvWins;/.test(serverSrc) && /SECRETISH/.test(serverSrc));
  ok('★ 非凭据类的键仍以环境变量为准（PORT=5199 node server.js 这种覆盖不该被拦）',
    /else if \(ambient === undefined \|\| ambient === ''\)/.test(serverSrc));
  ok('★ 空值不算「配了」（复制 .env.example 之后不填，也不会把环境变量顶成空串）',
    /if \(!val\) continue;/.test(serverSrc));
  ok('★ 两边不一致时启动日志会大声说，不静默', /被 \.env 里的值顶掉了/.test(serverSrc));
  ok('★ 健康检查只回「密钥来源 + 被遮蔽的变量名」，不回任何一位密钥字符',
    /keySource/.test(serverSrc) && /shadowedKeys/.test(serverSrc) && !/key:\s*API_KEY/.test(serverSrc));
  ok('★ 临时换 key 的口子还在（WENXUE_ENV_WINS=1）', /WENXUE_ENV_WINS/.test(serverSrc));

  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, 'public/js/llm.js'), 'utf8');
  ok('★ 前端代码里不出现任何密钥', !/sk-[a-zA-Z0-9]{20,}/.test(html + frontend));
  ok('★ 前端只打同源的 /api/chat', frontend.includes("'/api/chat'"));
}

const st = R.done();
process.exit(st.fail ? 1 : 0);
