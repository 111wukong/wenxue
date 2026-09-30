/* 集群编排端到端套件
 *
 * 打的是真的链路：classroom.js → agent.js → llm.js → server.js → mock 上游。
 *
 * ── 这里要证明的四件事 ──────────────────────────────────────────
 * 1. **每一轮都挂起等用户作答**（不让他当观众）
 * 2. **说「没听懂」之后同学真的安静了**，而且老师没被允许出题
 * 3. **黑板内容不会重复落账**（同一块内容出现两遍是很难察觉的那种 bug）
 * 4. **首轮并发真的并发**（墙钟时间等于一次调用，不是三次）
 */

import { makeReporter, startMock, startApp, FAKE_KEY, textDeltas, toolDeltas } from './lib/harness.mjs';
import * as llm from '../public/js/llm.js';
import * as Classroom from '../public/js/classroom.js';
import { AGENTS, STUDENT_KEYS, isComputeQuestion, lastQuestion } from '../public/js/agent.js';
import * as Store from '../public/js/store.js';

const R = makeReporter('集群编排 · 端到端');
const { ok, eq } = R;

const mock = await startMock();
const app = await startApp({
  DEEPSEEK_API_KEY: FAKE_KEY,
  DEEPSEEK_BASE: mock.url,
  DEEPSEEK_MODEL: 'deepseek-chat',
});
llm.setEndpoint(`${app.url}/api/chat`);

/* ============================================================
   测试用的路由：故意让老师**在答疑阶段违规出一道算题**，
   这样才测得到硬过滤那条兜底路径。
   ============================================================ */
const TEACHER_OPEN = '(focus)\n\n我先不往下讲。你把刚才那个条件用自己的话说一遍——如果去掉它，会怎么样？';
const TEACHER_CLARIFY_VIOLATION = '(telling)\n\n好，那我们直接算一下：lim(x→0) sinx/x 等于多少？';
const STUDENT_LINE = '你刚才说的我记下了，不过那个条件我还是不太明白。';

function route(body) {
  const msgs = body.messages || [];
  const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
  const tools = body.tools || [];
  const hasToolResult = msgs.some((m) => m.role === 'tool' || (m.role === 'user' && /【工具结果/.test(String(m.content || ''))));

  if (/课堂调度器/.test(sys)) return textDeltas('{"next":"END"}');

  /* ★ 学生必须排在老师**之前**判。
   *   学生的 system 里也写着「是陈老师课上的一名学生」—— 含「陈老师」三个字，
   *   顺序反了的话三个学生会全部走进老师分支，拿到同一段老师台词，
   *   于是「角色趋同」这个要测的问题反而被测成了假的通过。 */
  if (/是陈老师课上的一名学生/.test(sys)) {
    /* 每个角色回一句**不一样**的台词。
     * 如果 classroom 把同一份 system 发给了三个人（真出过这种 bug），
     * 这里就会得到三段一样的文本，「角色没有趋同」那条断言当场就能抓住。 */
    const who = ['林一鸣', '周雨桐', '马小虎'].find((n) => sys.includes(n)) || '某同学';
    return textDeltas(`${who}：${STUDENT_LINE}`);
  }

  if (/陈老师/.test(sys)) {
    // ★ 顺序要紧：先判阶段，再判要不要调工具
    if (/答疑重讲/.test(sys)) return textDeltas(TEACHER_CLARIFY_VIOLATION);
    if (/当前阶段：练习/.test(sys)) {
      return toolDeltas([{ name: 'pose_question', args: { question: '求 f(x)=x³ 在 [0,2] 上的 f′(ξ)。', hint: '先算平均变化率。', pointId: 'lagrange-mvt' } }], '', 2);
    }
    if (tools.length && !hasToolResult) {
      return toolDeltas([{ name: 'write_steps', args: { title: '三个条件', steps: ['在 [a,b] 上连续', '在 (a,b) 内可导', 'f(a)=f(b)'] } }], '', 2);
    }
    return textDeltas(TEACHER_OPEN);
  }
  return textDeltas('（默认）');
}

try {
  /* ============================================================
     1. 一对一讲透（solo）：只有老师，不调学生
     ============================================================ */
  {
    Store._clearMemory();
    mock.clearLog();
    mock.setRoute(route);

    const s = Classroom.newSession('rolle', 'solo');
    s._pendingInterject = '我想先问一下：这个定理和拉格朗日有什么区别？';
    const events = [];
    const answers = ['没听懂', '懂了，继续'];
    let ai = 0;

    await Classroom.run(s, {
      onEvent: (e) => events.push(e),
      onStatus: () => {},
      onAsk: () => answers[Math.min(ai++, answers.length - 1)],
    }, {});

    ok('solo 模式下一句学生发言都没有', s.turns.every((t) => t.role === 'teacher'));
    ok('★ 每一轮都挂起了等作答（3 轮 → 至少 2 次 ask）', events.filter((e) => e.type === 'ask').length >= 2);
    ok('★ 挂起事件里带了问题原文', events.find((e) => e.type === 'ask').spec.prompt.length > 0);
    ok('★ 用户插的那句话进了老师的提示词', mock.log.some((l) => JSON.stringify(l.body.messages).includes('和拉格朗日有什么区别')));
    ok('老师用了工具（写步骤上黑板）', events.some((e) => e.type === 'tool' && e.phase === 'done' && e.ok));
    eq('★ 黑板上的步骤块只落账一次（不是两次）', s.board.filter((b) => b.kind === 'steps').length, 1);
    ok('板上的块带了作者标记', s.board.every((b) => !!b.by));
    ok('★ 老师的发言被标了教学动作', s.turns.some((t) => t.move));
    ok('★ 引导占比算得出来', (s.moves.focus + s.moves.probing + s.moves.telling) > 0);
    ok('★ 第二轮的阶段是答疑（他说了没听懂）', events.some((e) => e.type === 'round' && e.phase === 'clarify'));
    ok('★ 答疑之后他说懂了，阶段推到练习', events.some((e) => e.type === 'round' && e.phase === 'practice'));
    ok('★ 练习阶段老师用 pose_question 出了题', mock.log.some((l) => JSON.stringify(l.body.messages).includes('pose_question')));
    ok('★ 记录里带上了他答的原文', s.qa.some((q) => q.a === '没听懂'));
    eq('★ 课结束后会话不再是活的', Classroom.isLive(s), false);
    eq('★ 课结束后不能再插话', Classroom.canInterject(s), false);
    eq('★ 挂起的 Promise 已经清空（不会留下按了没反应的死框）', s.awaiting, null);
  }

  /* ============================================================
     2. ★ 多人课堂：说「没听懂」之后同学必须安静
     ============================================================ */
  {
    Store._clearMemory();
    mock.clearLog();
    mock.setRoute(route);

    const s = Classroom.newSession('rolle', 'class');
    const events = [];
    let ai = 0;
    const answers = ['没听懂', '没听懂'];

    await Classroom.run(s, {
      onEvent: (e) => events.push(e),
      onStatus: () => {},
      onAsk: () => answers[Math.min(ai++, answers.length - 1)],
    }, {});

    const studentTurns = s.turns.filter((t) => t.role !== 'teacher');
    ok('★ 首轮三个学生都开过口', studentTurns.length >= 3, `实际 ${studentTurns.length}`);
    eq('三个学生都说了话', new Set(studentTurns.map((t) => t.role)).size, 3);
    ok('★ 学生发言各不相同（角色没有趋同）', new Set(studentTurns.map((t) => t.text)).size === studentTurns.length);

    /* ★ 这一条是整节设计的核心：答疑阶段「其他人该安静」必须真的发生 */
    ok('★ 前端收到了「同学已安静」的提示', events.some((e) => e.type === 'note' && /安静/.test(e.text)));
    eq('★ 答疑阶段一条学生发言都没有', s.turns.filter((t) => t.role !== 'teacher' && t.round > 0).length, 0);

    /* ★ 老师故意在答疑阶段出了算题 —— 必须被换成理解确认 */
    ok('★ 前端收到了「本来要出题，被换成了确认」的提示',
      events.some((e) => e.type === 'note' && /被换成了理解确认/.test(e.text)));
    const clarifyTurns = s.turns.filter((t) => t.role === 'teacher' && /答疑|跟不上|换个说法|理解确认|复述/.test(t.text));
    ok('答疑轮的结尾问题不再是算题',
      clarifyTurns.every((t) => !isComputeQuestion(lastQuestion(t.text))),
      clarifyTurns.map((t) => lastQuestion(t.text)).join(' | '));
    ok('★ 答疑轮确实被处理过（至少有一轮）', clarifyTurns.length >= 1);

    /* ★ 黑板落账只有一处 —— 同一块内容不能出现两遍 */
    const stepsItems = s.board.filter((b) => b.kind === 'steps');
    eq('★ 黑板上的步骤块只落账一次', stepsItems.length, 1);
    eq('★ 发给前端的 board 事件数量与落账数量一致',
      events.filter((e) => e.type === 'board').length, s.board.length);

    /* ★ 每个学生都有独立记忆 */
    ok('学生记忆是分开的', STUDENT_KEYS.every((k) => Array.isArray(s.memory[k])));

    eq('★ 三个学生都发过言被记了数', STUDENT_KEYS.filter((k) => s.spoke[k] > 0).length, 3);
  }

  /* ============================================================
     3. ★ 首轮并发：墙钟时间要接近一次调用，不是三次
     ============================================================ */
  {
    mock.clearLog();
    mock.setRoute(async () => {
      await new Promise((r) => setTimeout(r, 400));       // 每个角色都慢 400ms
      return textDeltas(STUDENT_LINE);
    });
    // 只跑老师 + 学生的首轮：把 maxRounds 压到 1
    const s = Classroom.newSession('rolle', 'class');
    s.maxRounds = 1;
    const t0 = Date.now();
    await Classroom.run(s, { onEvent: () => {}, onStatus: () => {}, onAsk: () => 'x' }, {});
    const elapsed = Date.now() - t0;
    /* 3 个学生串行的话要 1200ms+；并发的话约 400ms。
     * 阈值取 900ms —— 留了余量，但串行一定过不了。 */
    ok('★ 首轮并发：三个学生的墙钟时间接近一次调用而不是三次',
      elapsed < 900, `实际 ${elapsed}ms`);
    eq('三个学生都说了话', s.turns.filter((t) => t.role !== 'teacher').length, 3);
    mock.setRoute(route);
  }

  /* ============================================================
     4. ★ 无人值守直通：onAsk 也要能收到事件
     ============================================================ */
  {
    mock.clearLog();
    mock.setRoute(route);
    const s = Classroom.newSession('rolle', 'solo');
    s.maxRounds = 2;
    const events = [];
    await Classroom.run(s, {
      onEvent: (e) => events.push(e),
      onStatus: () => {},
      onAsk: () => '懂了',
    }, {});
    /* ★ emit 必须在 onAsk 分支之前。写在 Promise executor 里面的话，
     *   onAsk 直通会提前 return，UI 永远收不到「该你了」事件。 */
    ok('★ 直通模式下「该你了」事件照样发出去了', events.filter((e) => e.type === 'ask').length >= 1);
    eq('直通模式不会留下 awaiting', s.awaiting, null);
  }

  /* ============================================================
     5. 上游挂了不能让整节课炸掉
     ============================================================ */
  {
    mock.clearLog();
    mock.setMode('billing');
    const s = Classroom.newSession('rolle', 'solo');
    s.maxRounds = 1;
    const events = [];
    await Classroom.run(s, { onEvent: (e) => events.push(e), onStatus: () => {}, onAsk: () => 'x' }, {});
    mock.setMode('ok');
    ok('★ 上游报错时前端收到 error 事件（而不是无声失败）', events.some((e) => e.type === 'error'));
    ok('★ 出错时也会走到 done（不会卡在 running 状态）', events.some((e) => e.type === 'done'));
    eq('出错后会话不再是活的', Classroom.isLive(s), false);
  }

  /* ============================================================
     6. 研讨模式：第一轮就是研讨，不是讲透
     ============================================================ */
  {
    mock.clearLog();
    mock.setRoute(route);
    const s = Classroom.newSession('rolle', 'debate');
    s.maxRounds = 1;
    const events = [];
    await Classroom.run(s, { onEvent: (e) => events.push(e), onStatus: () => {}, onAsk: () => 'x' }, {});
    const first = events.find((e) => e.type === 'round');
    eq('★ 研讨模式第一轮就是 discuss', first && first.phase, 'discuss');
  }

  /* ============================================================
     7. 上课记录进了本地档案
     ============================================================ */
  {
    Store._clearMemory();
    mock.clearLog();
    mock.setRoute(route);
    const s = Classroom.newSession('rolle', 'solo');
    s.maxRounds = 1;
    await Classroom.run(s, { onEvent: () => {}, onStatus: () => {}, onAsk: () => 'x' }, {});
    const st = Store.load();
    eq('课被记进了档案', st.classes.length, 1);
    eq('记的是考点名', st.classes[0].topic, '罗尔定理');
    ok('★ 档案里没有 awaiting（Promise 不能落盘 —— 读回来是个按了没反应的死框）',
      !JSON.stringify(st).includes('awaiting'));
  }
} finally {
  await app.close();
  await mock.close();
}

const st = R.done();
process.exit(st.fail ? 1 : 0);
