/* Agent 集群 · 课堂编排
 *
 * 一个老师 + 三个水平不同的学生，围绕一个考点把课上一遍。
 *
 * ── 这个文件存在的唯一理由：别让用户当观众 ──────────────────────
 * 多角色 agent 集群最容易犯的错是：四个 agent 聊得热闹，用户在旁边看。
 * 那不是学习，是一档节目。判断标准很简单 ——
 * **整场下来有没有任何一步要求用户动手？**
 *
 * 所以每一轮结束都会挂起等作答。挂起是纯本地等待，不花 token，
 * 收益却是全部。
 *
 * ── 第二个理由：成本 ────────────────────────────────────────────
 * 不要让所有角色都独立调模型，也不要每回合都问一次调度器。
 *   · 首轮并发（Promise.all）→ 墙钟时间等于一次调用
 *   · 后续串行（要看到别人的话才能接话）
 *   · 发言调度先走本地规则，只在歧义时才问模型
 *   · 每个角色的 agent loop 步数上限 3
 */

import { chat } from './llm.js';
import {
  AGENTS, STUDENT_KEYS, PHASE_META,
  teacherPrompt, studentPrompt, runAgent, parseMove, blankMoves,
  classifyIntent, nextPhase, enforcePhase, lastQuestion,
} from './agent.js';
import { makeCtx } from './tools.js';
import { findPoint } from './curriculum.js';
import * as store from './store.js';

/* ============================================================
   会话
   ============================================================ */

export const MODES = {
  solo: { label: '一对一讲透', desc: '只有陈老师。快、聚焦，适合先啃下一个考点。', students: false, startPhase: null, rounds: 4 },
  class: { label: '多人课堂', desc: '陈老师 + 三个学生一起上。他们水平不同，会吵起来。', students: true, startPhase: null, rounds: 3 },
  debate: { label: '研讨课', desc: '不讲课，直接抛一个开放问题让他们争。', students: true, startPhase: 'discuss', rounds: 3 },
};

export function newSession(pointId, mode = 'class') {
  const point = findPoint(pointId);
  const m = MODES[mode] || MODES.class;
  return {
    id: `cls_${Date.now().toString(36)}`,
    pointId: point ? point.id : null,
    pointName: point ? point.name : String(pointId || ''),
    mode,
    round: 0,
    maxRounds: m.rounds,
    startPhase: m.startPhase,
    withStudents: m.students,
    phase: m.startPhase || 'lecture',
    turns: [],
    board: [],
    moves: blankMoves(),
    memory: Object.fromEntries(STUDENT_KEYS.map((k) => [k, []])),
    spoke: Object.fromEntries(STUDENT_KEYS.map((k) => [k, 0])),
    qa: [],                     // 问答配对表：{ round, q, a }
    pendingHand: null,
    pendingQuestion: null,
    passed: 0,
    currentQuestion: null,
    lastPrompt: '',
    lastPromptRound: 0,
    status: '准备中',
    done: false,
    /* ★ awaiting 带 Promise，**绝不能落盘**。
     *   从 localStorage 读回来的 awaiting 是个「按了没反应」的死框。
     *   用内存里的 LIVE 集合区分「正在跑的会话」和「读回来的死数据」。 */
    awaiting: null,
    _pendingInterject: '',
  };
}

/* ============================================================
   活的会话 vs 读回来的死数据
   ============================================================ */
const LIVE = new WeakSet();

export function isLive(session) {
  return !!session && LIVE.has(session);
}

export function markLive(session) { LIVE.add(session); return session; }
export function markDead(session) { if (session) LIVE.delete(session); return session; }

/* ============================================================
   ★ 门禁条件用「现在是否在跑」，不能用「是否有内容」
   ============================================================
   真踩过的：插话入口的可用性写成了 `session.turns.length > 0`。
   而 startClass 建 session 时 turns 是空的，紧接着就渲染页面 ——
   于是输入框一渲染出来就是禁用的，整节课都点不了。
   而收尾时又无条件 `disabled = false`，留下一个点了只弹错的框。两头都错。

   正解：拿「有没有一节正在跑的课」当唯一条件，并且把可用状态收进
   **一个函数** —— 别让同一套 UI 状态散落在四个地方手写 disabled。
   ============================================================ */
export function canInterject(session) {
  return isLive(session) && !(session && session.awaiting);
}

export function interjectPlaceholder(session) {
  if (!session) return '先选一个考点，开一节课';
  if (!isLive(session)) return '这一节已经结束了，重开一节';
  if (session.awaiting) return '先把上面那道题交了，再插话';
  return '插一句话（老师下一轮会看到）';
}

export function interject(session, text) {
  if (!canInterject(session)) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  session._pendingInterject = t;
  return true;
}

/* ============================================================
   事件出口
   ============================================================ */
function emit(hooks, ev) { if (hooks && hooks.onEvent) hooks.onEvent(ev); }
function status(hooks, s) { if (hooks && hooks.onStatus) hooks.onStatus(s); }

/* ============================================================
   ★ 挂起 / 唤醒
   ============================================================
   调度流程里插一个 await，返回一个**不会自己 resolve 的 Promise**，
   把 resolve 存到 session 上；UI 交答案时再调它。
   ============================================================ */
export function askUser(session, hooks, spec) {
  const payload = {
    prompt: spec.prompt || '',
    placeholder: spec.placeholder || '用你自己的话答，或者直接说「没听懂」',
    phase: spec.phase || session.phase,
    hint: spec.hint || '',
  };

  /* ⚠️ emit 必须在 onAsk 分支**之前**。
   *   写在 Promise executor 里面的话，onAsk 直通会提前 return，
   *   UI 永远收不到「该你了」事件（真踩过：直通路径测试全绿，
   *   只有真机上 UI 收不到事件）。 */
  /* ⚠️ 而且还要在 emit **之前**把「我在等作答」这个事实记下来。
   *   顺序反了的话：UI 收到事件时 session.awaiting 还是 null，
   *   canInterject() 会算成「可以插话」—— 于是**正在等你答题的时候，
   *   插话输入框反而是可用的**，老师会被两条线同时拉扯。
   *   （resolve 此刻还没有，先占位，Promise executor 里补上。） */
  session.awaiting = { prompt: payload.prompt, resolve: null };

  emit(hooks, { type: 'ask', spec: payload });
  status(hooks, spec.status || '该你了 —— 先答上面这道题');

  if (hooks && typeof hooks.onAsk === 'function') {
    session.awaiting = null;                            // 直通模式没有真的挂起
    return Promise.resolve(hooks.onAsk(payload));       // 测试 / 无人值守直通
  }
  return new Promise((resolve) => {
    session.awaiting.resolve = resolve;
  });
}

/* ★ 提交/跳过必须要求 resolve 是个函数。
 *   awaiting 会在「已经记账、还没拿到 resolve」的那一小段窗口里是占位对象，
 *   这时调 resolve 会炸。 */
function takeResolver(session) {
  if (!session || !session.awaiting) return null;
  const r = session.awaiting.resolve;
  if (typeof r !== 'function') return null;
  session.awaiting = null;
  return r;
}

export function submitAnswer(session, text) {
  const r = takeResolver(session);
  if (!r) return false;                                 // 接不上（刷新后残留）
  r(String(text ?? ''));
  return true;
}

/** 跳过。流程照常继续，但这次没有用户输入 —— 后续提示词里要明确写「他跳过了，别追问」。 */
export function skipAnswer(session) {
  const r = takeResolver(session);
  if (!r) return false;
  session.passed += 1;
  r({ __skipped: true });
  return true;
}

export function hasAwaiting(session) {
  return !!(session && session.awaiting);
}

/* ============================================================
   记忆：只记自己的 + 吸收点名
   ============================================================ */
export function pushMemory(session, key, text) {
  const list = session.memory[key] || (session.memory[key] = []);
  const t = String(text || '').trim();
  if (!t || list.includes(t)) return list;
  list.push(t);
  if (list.length > 4) list.splice(0, list.length - 4);
  return list;
}

/** 老师点评里出现「林一鸣」，那句话就自动进他的记忆。 */
export function absorbMentions(session, teacherText) {
  const sentences = String(teacherText || '').split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  for (const k of STUDENT_KEYS) {
    const nm = AGENTS[k].name;
    const hits = sentences.filter((s) => s.includes(nm)).slice(0, 2);
    if (hits.length) pushMemory(session, k, `老师点评到我：${hits.join(' ')}`.slice(0, 160));
  }
}

/* ============================================================
   发言调度
   ============================================================
   借 director graph 的思路，但**不要每个回合都调一次模型** ——
   那是纯浪费。分层：能本地定的就本地定。
   ============================================================ */
export function localSchedule(session) {
  // 1. 有人举手 → 老师，直接定
  if (session.pendingHand) return 'teacher';
  // 2. 还有人没开过口 → 按优先级让他开口
  const silent = STUDENT_KEYS.filter((k) => !session.spoke[k]);
  if (silent.length) return silent[0];
  // 3. 说到量了 → 结束
  const spokeTotal = STUDENT_KEYS.reduce((a, k) => a + (session.spoke[k] || 0), 0);
  if (spokeTotal >= session.targetSpoke) return null;
  // 4. 都不满足 → 交给模型
  return undefined;
}

/** 兜底：轮转，且不连着同一个人。 */
export function fallbackRotate(session) {
  const last = session._lastSpeaker;
  const order = last ? [...STUDENT_KEYS.filter((k) => k !== last), last] : [...STUDENT_KEYS];
  // 开口少的优先
  order.sort((x, y) => (session.spoke[x] || 0) - (session.spoke[y] || 0));
  return order[0] || null;
}

const DIRECTOR_SYSTEM = `你是课堂调度器。根据讨论进展，判断下一个该谁发言。
可选的发言者：
- teacher：老师（该收拢、该纠错、该给结论时）
- a / b / c：三个学生（该有人补充、该有人质疑时）
- END：讨论够了，该结束了
只输出 JSON，不要任何解释文字：{"next":"a"}`;

export async function directorCall(session, ctx) {
  const recent = session.turns.slice(-6).map((t) => `${AGENTS[t.role] ? AGENTS[t.role].name : t.role}：${String(t.text).slice(0, 80)}`).join('\n');
  const out = await chat({
    messages: [
      { role: 'system', content: DIRECTOR_SYSTEM },
      {
        role: 'user',
        content: `考点：${session.pointName}\n当前阶段：${session.phase}\n已发言次数：${JSON.stringify(session.spoke)}\n最近发言：\n${recent}\n\n下一个该谁？`,
      },
    ],
    tools: [],
    stream: false,
    temperature: 0.2,
    maxTokens: 40,
  });
  const m = String(out.content || '').match(/\{[\s\S]*?\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]);
    const n = String(j.next || '').trim();
    if (n === 'END') return null;
    if (n === 'teacher' || STUDENT_KEYS.includes(n)) return n;
  } catch { /* 解析不了就走兜底 */ }
  return undefined;
}

export async function schedule(session, ctx) {
  const local = localSchedule(session);
  if (local !== undefined) return local;
  try {
    const d = await directorCall(session, ctx);
    if (d !== undefined) return d;
  } catch { /* 调度器挂了不能让整节课中断 */ }
  return fallbackRotate(session);
}

/* ============================================================
   单个角色的发言
   ============================================================ */

async function teacherTurn(session, opts, hooks) {
  const point = findPoint(session.pointId);
  const ctx = makeCtx({ role: 'teacher', depth: 'teacher', session });
  const system = teacherPrompt({
    phase: session.phase,
    point,
    ctx: { pointId: session.pointId, showProfile: opts.showProfile !== false },
    lastPrompt: session.lastPrompt,
    lastPromptRound: session.lastPromptRound,
    userAnswer: opts.userAnswer,
    userSkipped: opts.userSkipped,
  });

  const userParts = [`考点：${session.pointName}`];
  if (session.phase === 'discuss') userParts.push('这一轮是研讨，抛一个开放问题出来。');
  if (session.round === 0 && session.phase === 'lecture') userParts.push('这是第一轮，按「讲透」的五段结构讲。');
  if (session._pendingInterject) {
    userParts.push(`学习者刚刚插了一句话：「${session._pendingInterject}」。先回应它。`);
    session._pendingInterject = '';
  }
  if (session.phase === 'clarify') userParts.push('他刚说了没听懂。退回去重讲概念，这一轮不要出题。');
  if (opts.userAnswer) userParts.push(`他刚才对上一问的作答：「${String(opts.userAnswer).slice(0, 200)}」`);
  if (opts.userSkipped) userParts.push('他跳过了上一问，别追问那道题。');

  const roleKey = 'teacher';
  let streamed = '';
  const r = await runAgent({
    role: roleKey,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    ctx,
    temperature: 0.7,
    hooks: {
      // 老师是主内容，**流式**给 UI
      onDelta: (d) => {
        streamed += d;
        // 流式时就要剥掉标签，否则用户第一个 token 会看到 `(foc` 这种半截
        const { move, text } = parseMove(streamed);
        emit(hooks, { type: 'delta', role: roleKey, text, move, raw: streamed });
      },
      onToolCall: (c) => emit(hooks, { type: 'tool', role: roleKey, phase: 'call', name: c.name, args: c.args }),
      onToolResult: (t) => emit(hooks, { type: 'tool', role: roleKey, phase: 'done', name: t.name, ok: t.ok, error: t.error }),
    },
  });

  const { move, text } = parseMove(r.text || streamed);
  return { role: roleKey, name: AGENTS.teacher.name, text, move, round: session.round, boardItems: r.boardItems, toolCalls: r.toolCalls };
}

async function studentTurn(session, key, opts, hooks) {
  const a = AGENTS[key];
  const point = findPoint(session.pointId);
  const ctx = makeCtx({ role: key, depth: a.depth, session, distractorIndex: a.distractorIndex });

  const teacherSaid = [...session.turns].reverse().find((t) => t.role === 'teacher');
  const system = studentPrompt(key, {
    point,
    ctx,
    round: session.round,
    teacherSaid: teacherSaid ? teacherSaid.text : '',
    memory: session.memory[key] || [],
    interjected: session._pendingInterject || '',
  });

  const userParts = [
    session.round === 0
      ? '老师刚讲完，说说你的第一反应。'
      : '轮到你了。先回应前面某个人的话，再说你自己的看法。',
  ];
  const others = session.turns.filter((t) => t.role !== 'teacher' && t.role !== key).slice(-3);
  if (others.length && session.round > 0) {
    userParts.push('前面这些人说过：\n' + others.map((t) => `${AGENTS[t.role] ? AGENTS[t.role].name : t.role}：「${String(t.text).slice(0, 100)}」`).join('\n'));
  }
  if (session.pendingHand && session.pendingHand.role === key) {
    userParts.push(`你举手了（${session.pendingHand.reason}）。老师现在把话头交给你。`);
    session.pendingHand = null;
  }

  const r = await runAgent({
    role: key,
    system,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    ctx,
    maxSteps: 2,          // 学生只需要「查一下 → 说」两步
    temperature: 0.9,     // 高一点，让三个人的措辞不至于撞车
    hooks: {
      // 学生**不流式到 UI**：首轮并发时三路流会互相打断。
      // 收集完整文本后由 UI 逐字打出来，制造「正在说」的现场感。
      onToolCall: (c) => emit(hooks, { type: 'tool', role: key, phase: 'call', name: c.name, args: c.args }),
      onToolResult: (t) => emit(hooks, { type: 'tool', role: key, phase: 'done', name: t.name, ok: t.ok, error: t.error }),
    },
  });

  return { role: key, name: a.name, text: String(r.text || '').trim(), move: '', round: session.round, boardItems: r.boardItems, toolCalls: r.toolCalls };
}

/* ============================================================
   主循环
   ============================================================ */

/**
 * 上一节课。
 *
 * @param {object} session  newSession() 的产物
 * @param {object} hooks
 *   onEvent(ev)   事件流：delta / turn / board / ask / patch / note / done
 *   onStatus(s)   状态条文字
 *   onAsk(spec)   直通模式：直接返回答案，不挂起（测试 / 无人值守）
 * @param {object} opts
 *   showProfile   是否把学习档案注入提示词（默认 true）
 *   skipAnswerFor 每轮都跳过作答（测试用）
 */
export async function run(session, hooks = {}, opts = {}) {
  markLive(session);
  session.done = false;
  session.targetSpoke = session.withStudents ? STUDENT_KEYS.length * session.maxRounds : 0;

  let userAnswer = null;
  let userSkipped = false;

  try {
    for (session.round = 0; session.round < session.maxRounds; session.round++) {
      const isFirst = session.round === 0;
      const intent = isFirst ? 'none' : classifyIntent(userAnswer);

      session.phase = (isFirst && session.startPhase)
        ? session.startPhase
        : nextPhase(session.phase, intent, session.round);

      const meta = PHASE_META[session.phase];
      status(hooks, `第 ${session.round + 1} 轮 · ${meta.label}${meta.who.includes('同学') ? '' : '（同学安静）'}`);
      emit(hooks, { type: 'round', round: session.round, phase: session.phase, meta });

      /* ---- 1. 老师发言（流式） ---- */
      emit(hooks, { type: 'speaking', role: 'teacher' });
      let tTurn;
      try {
        tTurn = await teacherTurn(session, { userAnswer, userSkipped, showProfile: opts.showProfile }, hooks);
      } catch (e) {
        emit(hooks, { type: 'error', message: e.message, kind: e.kind || 'unknown' });
        status(hooks, `老师这一轮没说出来：${e.message}`);
        break;
      }
      userAnswer = null; userSkipped = false;

      const roundTurns = [tTurn];

      /* ---- 2. 学生发言 ---- */
      /* ★ clarify 阶段**根本不调**学生 —— 既省 token，又天然保证「其他人该安静」。
       *   这比「生成了再丢掉」好：一次调用就是一次钱。 */
      let skippedStudents = 0;
      if (session.withStudents && session.phase !== 'clarify') {
        const firstRound = session.round === 0;
        if (firstRound) {
          // 首轮并发：墙钟时间等于一次调用
          status(hooks, '同学们正在看资料…');
          const results = await Promise.all(STUDENT_KEYS.map(async (k) => {
            try { return await studentTurn(session, k, opts, hooks); }
            catch (e) { return { role: k, name: AGENTS[k].name, text: '', error: e.message, round: session.round }; }
          }));
          for (const r of results) {
            if (r.text) {
              roundTurns.push(r);
              session.spoke[r.role] = (session.spoke[r.role] || 0) + 1;
              session._lastSpeaker = r.role;
            } else {
              emit(hooks, { type: 'note', text: `${r.name}这一轮没说出话来`, level: 'warn' });
            }
          }
        } else {
          // 后续串行：要看到别人的话才能接话
          let guard = 0;
          for (;;) {
            const next = await schedule(session, null);
            if (next === null) break;
            if (guard++ > 4) break;

            /* 有人举手 → 老师被叫回来。这里要**真的让他再说一段**，
             * 不能只是 break —— 那等于举了手没人理。 */
            if (next === 'teacher') {
              emit(hooks, { type: 'speaking', role: 'teacher', again: true });
              try {
                const extra = await teacherTurn(session, { userAnswer: null, userSkipped: false, showProfile: opts.showProfile }, hooks);
                roundTurns.push(extra);
              } catch (e) {
                emit(hooks, { type: 'note', text: `老师没能回应：${e.message}`, level: 'warn' });
              }
              break;
            }

            if (roundTurns.some((t) => t.role === next)) break;   // 已经说过就别重复
            try {
              const r = await studentTurn(session, next, opts, hooks);
              if (r.text) {
                roundTurns.push(r);
                session.spoke[next] = (session.spoke[next] || 0) + 1;
                session._lastSpeaker = next;
              }
            } catch (e) {
              emit(hooks, { type: 'note', text: `${AGENTS[next].name}卡住了：${e.message}`, level: 'warn' });
              break;
            }
          }
        }
      } else if (session.withStudents) {
        skippedStudents = STUDENT_KEYS.length;
      }

      /* ---- 3. 硬过滤：模型越界之后的兜底 ---- */
      const report = enforcePhase(session.phase, roundTurns, { seed: session.round });
      report.silenced += skippedStudents;
      if (report.silenced) {
        emit(hooks, { type: 'note', text: `这一轮是答疑，${report.silenced} 位同学已安静`, level: 'info' });
      }
      if (report.promptAdjusted) {
        emit(hooks, {
          type: 'note',
          text: '这一轮本来要出题，被换成了理解确认 —— 他还没说听懂，不该往下推',
          level: 'info',
        });
      }
      if (report.promptAdded) {
        emit(hooks, { type: 'note', text: '老师这轮忘了留问题，已补上一句理解确认', level: 'info' });
      }

      /* ---- 4. 落账 + 上报 ---- */
      for (const t of report.turns) {
        if (t.role === 'teacher') {
          /* ★ 这里**不能再剥一次**标签。
           *   teacherTurn 早就剥过了（流式时必须剥，否则用户第一个 token
           *   会看到 `(foc` 这种半截），再对已经剥干净的正文剥一次，
           *   只会得到空串 —— 于是「引导占比」永远是 0，静默失效。 */
          const move = t.move || '';
          t.move = move;
          if (move && session.moves[move] !== undefined) session.moves[move] += 1;
          absorbMentions(session, t.text);
        }
        session.turns.push(t);

        /* 黑板落账只在这**一处**：既进 session.board，又发给 UI。
         *   分散在两个地方的话，UI 那份和存档那份会各推一次，
         *   黑板上同一块内容出现两遍（而且是很难察觉的那种重复）。 */
        if (t.boardItems && t.boardItems.length) {
          for (const it of t.boardItems) {
            session.board.push(it);
            emit(hooks, { type: 'board', item: it });
          }
        }

        // 老师那条已经流式打过了，不再重复整段；但要发 patch 把硬过滤的修改同步过去
        if (t.role === 'teacher') {
          emit(hooks, { type: 'patch', role: 'teacher', text: t.text, move: t.move, round: session.round });
        } else {
          emit(hooks, { type: 'turn', turn: t, animate: true });
        }
      }

      /* ---- 5. 挂起等作答 ---- */
      const isLast = session.round >= session.maxRounds - 1;

      if (session.pendingQuestion) {
        session.lastPrompt = session.pendingQuestion.question;
        session.currentQuestion = session.pendingQuestion;
        session.pendingQuestion = null;
      } else {
        // 老师这一轮可能被叫回来两次，取最后一条的结尾问题
        const lastTeacher = [...roundTurns].reverse().find((t) => t.role === 'teacher');
        const trailing = lastQuestion(lastTeacher ? lastTeacher.text : '');
        if (trailing) session.lastPrompt = trailing;
      }
      session.lastPromptRound = session.round + 1;

      if (isLast) break;

      const spec = {
        prompt: session.lastPrompt || `第 ${session.round + 1} 轮结束了，你有什么想说的？`,
        hint: session.currentQuestion ? session.currentQuestion.hint : '',
        phase: session.phase,
        placeholder: session.phase === 'clarify'
          ? '说清你卡在哪一步，或者直接说「还是没懂」'
          : '用你自己的话答，不会就说「没听懂」',
      };
      const ans = await askUser(session, hooks, spec);

      if (ans && typeof ans === 'object' && ans.__skipped) {
        userSkipped = true;
        emit(hooks, { type: 'note', text: '他跳过了这一题', level: 'info' });
      } else {
        userAnswer = String(ans ?? '');
        session.qa.push({ round: session.round + 1, q: spec.prompt, a: userAnswer, replyTo: session.round + 1 });
        if (userAnswer) emit(hooks, { type: 'user', text: userAnswer, replyTo: session.round + 1 });
        // 记一次作答（如果这道题来自题库，顺手把对错也判了）
        recordIfKnown(session, userAnswer);
      }
    }
  } finally {
    session.done = true;
    markDead(session);
    status(hooks, '这一节结束了');
    emit(hooks, {
      type: 'done',
      session: publicSession(session),
    });
    store.recordClass({
      topic: session.pointName,
      mode: session.mode,
      turns: session.turns.length,
    });
  }

  return publicSession(session);
}

/* 若老师留的题正好命中题库里的一道，顺手记一次作答 —— 学习档案就是这么攒起来的。 */
function recordIfKnown(session, answer) {
  if (!answer) return;
  const point = findPoint(session.pointId);
  if (!point) return;
  const hit = (point.questions || []).find((q) => session.lastPrompt && session.lastPrompt.includes(q.stem.slice(0, 12)));
  if (!hit) return;
  // 判分走 judge.js —— 这里不重复实现判据
  import('./judge.js').then(({ judge }) => {
    const r = judge(hit, answer);
    if (r.gradable) store.recordAnswer({ pointId: point.id, qid: hit.id, answer, correct: r.correct, source: 'class' });
  }).catch(() => { /* 记不上就算了，不影响上课 */ });
}

/** 给 UI / 存档用的纯数据视图（不含 Promise）。 */
export function publicSession(session) {
  return {
    id: session.id,
    pointId: session.pointId,
    pointName: session.pointName,
    mode: session.mode,
    round: session.round,
    phase: session.phase,
    done: session.done,
    turns: session.turns.map((t) => ({ role: t.role, name: t.name, text: t.text, move: t.move, round: t.round })),
    board: session.board,
    moves: session.moves,
    qa: session.qa,
    status: session.status,
  };
}

/** 一场课大概花几次调用 —— README 里要写清，别让用户猜。 */
export function estimateCalls(mode, rounds) {
  const m = MODES[mode] || MODES.class;
  const r = rounds || m.rounds;
  const students = m.students ? STUDENT_KEYS.length : 0;
  // 每轮：老师 1 次（可能 +1 次工具回灌）
  const perRoundTeacher = 2;
  const studentFirst = m.students ? 2 : 0;                 // 首轮并发，墙钟算一次但按 token 算三次
  const studentLater = m.students ? Math.max(0, r - 1) * Math.min(2, STUDENT_KEYS.length) * 2 : 0;
  return perRoundTeacher * r + studentFirst + studentLater;
}
