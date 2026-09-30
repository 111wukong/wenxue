/* 问学 · UI 编排
 *
 * 这个文件只做「把事件变成 DOM」。所有判断逻辑都在别处：
 *   llm.js       模型通道
 *   tools.js     工具与白名单
 *   agent.js     提示词与阶段状态机
 *   classroom.js 集群调度与挂起
 *   judge.js     判分与清洗
 *   store.js     本地档案
 *   latex.js     公式排版
 *
 * ── 这里踩过的两个坑，写在这里当备忘 ────────────────────────────
 *
 * 1. **门禁条件要用「现在是否在跑」，不能用「是否有内容」。**
 *    `session.turns.length > 0` 这种写法在建完 session、还没说话时是 false，
 *    于是输入框一渲染出来就是禁用的，整节课都点不了。
 *    所以：先 markLive 再渲染，且可用状态只由 setInterject() 一个函数算。
 *
 * 2. **同一块会反复重建的 DOM，内容拼接和事件绑定都要覆盖所有渲染路径。**
 *    黑板的初始渲染和后续重画是两条路。把 `boardHtml()` 写进 renderBoard，
 *    而初始模板那行忘了改 —— 结果绑定齐全、样式齐全、逻辑正确，
 *    那块内容压根不存在。所以这里让初始渲染**也走 renderBoard()**，
 *    路径只剩一条；bindBoard() 仍然两处都调，靠 data 标记防重复绑定。
 */

import * as llm from './llm.js';
import { POINTS, MODULES, findPoint, pointById } from './curriculum.js';
import * as Tools from './tools.js';
import * as Classroom from './classroom.js';
import * as Store from './store.js';
import { judge, describeGeneration, prettyAnswer } from './judge.js';
import { generateQuestions, explainAnswer, AGENTS, STUDENT_KEYS, guidanceRatio, PHASE_META } from './agent.js';
import { renderLatex, renderInline, escapeHtml } from './latex.js';

/* ============================================================
   小工具
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = escapeHtml;

function toast(msg, level = '') {
  const wrap = $('#toast-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

function fmtNum(v) {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

const REDUCED = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================
   状态
   ============================================================ */
const state = {
  topicId: null,
  mode: 'class',
  view: 'class',
  session: null,
  running: false,
  boardPage: null,        // ★ 浏览位置不落盘：刷新后回最新一组更合理
  generated: [],          // AI 生成的题
  quiz: [],               // 练习区当前展示的题
  teacherBubble: null,
  health: null,
};

/* 打字机串行队列：学生的发言要一条一条打出来，不能同时刷。 */
let typeChain = Promise.resolve();
function enqueue(fn) {
  typeChain = typeChain.then(fn).catch((e) => { console.warn(e); });
  return typeChain;
}

/* ============================================================
   侧栏
   ============================================================ */
function renderModes() {
  const box = $('#modes');
  box.innerHTML = Object.entries(Classroom.MODES).map(([k, m]) => {
    const calls = Classroom.estimateCalls(k);
    return `<button class="mode ${k === state.mode ? 'on' : ''}" data-mode="${k}">
      <span class="m-name">${esc(m.label)}<span class="m-calls">≈${calls} 次调用</span></span>
      <span class="m-desc">${esc(m.desc)}</span>
    </button>`;
  }).join('');
  box.onclick = (e) => {
    const b = e.target.closest('.mode');
    if (!b) return;
    state.mode = b.getAttribute('data-mode');
    renderModes();
    renderStartBtn();
  };
  renderStartBtn();
}

function renderStartBtn() {
  const m = Classroom.MODES[state.mode];
  const p = state.topicId ? pointById(state.topicId) : null;
  $('#start-sub').textContent = p ? `· ${p.name}` : '';
  $('#mode-hint').textContent = m.desc;
  $('#start-btn').disabled = state.running;
}

function renderPoints() {
  const box = $('#points');
  const html = [];
  for (const mod of MODULES) {
    html.push(`<div class="mod-name">${esc(mod)}</div>`);
    for (const p of POINTS.filter((x) => x.module === mod)) {
      const st = Store.pointStat(p.id);
      const badge = st.wrong ? `<span class="p-badge warn">错 ${st.wrong}</span>`
        : st.seen ? `<span class="p-badge">${st.seen} 题</span>` : '';
      html.push(`<button class="point ${p.id === state.topicId ? 'on' : ''}" data-point="${p.id}">
        <span class="p-dot"></span>
        <span class="p-name">${esc(p.name)}</span>
        ${badge}
      </button>`);
    }
  }
  box.innerHTML = html.join('');
  $('#point-count').textContent = `${POINTS.length} 个`;
  box.onclick = (e) => {
    const b = e.target.closest('.point');
    if (!b) return;
    state.topicId = b.getAttribute('data-point');
    renderPoints();
    renderStartBtn();
    syncGenPoint();
  };
}

function renderProfile() {
  const st = Store.load();
  const total = st.answers.length;
  const right = st.answers.filter((a) => a.correct).length;
  const acc = total ? Math.round((right / total) * 100) : null;

  const rows = [
    ['累计作答', total ? `${total} 题` : '—'],
    ['正确率', acc === null ? '还没有记录' : `${acc}%`],
    ['上过的课', st.classes.length ? `${st.classes.length} 节` : '—'],
  ];

  let gauge = '';
  const moves = (state.session && state.session.moves) || null;
  const ratio = moves ? guidanceRatio(moves) : null;
  if (moves) {
    const f = moves.focus || 0, p = moves.probing || 0, t = moves.telling || 0;
    const sum = f + p + t || 1;
    gauge = `<div class="gauge">
      <div class="gauge-top">
        <span>这堂课的引导占比</span>
        <span class="mono">${ratio === null ? '—' : Math.round(ratio * 100) + '%'}</span>
      </div>
      <div class="gauge-bar">
        <div class="gauge-seg f" style="width:${(f / sum) * 100}%"></div>
        <div class="gauge-seg p" style="width:${(p / sum) * 100}%"></div>
        <div class="gauge-seg t" style="width:${(t / sum) * 100}%"></div>
      </div>
      <div class="gauge-legend">
        <span><i style="background:#34d399"></i>focus ${f}</span>
        <span><i style="background:#5b8cff"></i>probing ${p}</span>
        <span><i style="background:#fbbf24"></i>telling ${t}</span>
      </div>
      <div class="gauge-legend" style="margin-top:4px">
        <span>占比偏低 = 老师在替你做题</span>
      </div>
    </div>`;
  }

  $('#profile').innerHTML =
    rows.map(([k, v]) => `<div class="prof-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')
    + gauge;
}

let toolsOpen = false;
function renderTools() {
  const box = $('#tools');
  const btn = $('#tool-toggle');
  btn.textContent = toolsOpen ? '收起' : '展开';
  if (!toolsOpen) {
    box.innerHTML = `<div class="tool-row"><span class="t-desc">老师 ${Tools.TEACHER_TOOLS.length} 个 · 学生 ${Tools.STUDENT_TOOLS.length} 个。差别不只是数量，是<b>种类</b>。</span></div>`;
    return;
  }
  const rows = [];
  rows.push(`<div class="tool-row"><span class="t-desc"><b>陈老师</b>（全部资料 + 学情数据）</span></div>`);
  for (const t of Tools.describeTools('teacher')) {
    rows.push(`<div class="tool-row"><span class="t-name">${t.name}</span><span class="t-desc">${esc(t.description.split('。')[0])}</span>${t.teacherOnly ? '<span class="t-lock">仅老师</span>' : ''}</div>`);
  }
  rows.push(`<div class="tool-row" style="margin-top:8px"><span class="t-desc"><b>三个学生</b>（资料按水平递减，工具里<b>没有</b>「写完整解答」）</span></div>`);
  for (const t of Tools.describeTools('a')) {
    rows.push(`<div class="tool-row"><span class="t-name">${t.name}</span><span class="t-desc">${esc(t.description.split('。')[0])}</span></div>`);
  }
  rows.push(`<div class="tool-row"><span class="t-desc">学生拿到的是<b>被裁剪过的</b>资料 —— 后进生只有考点定义的第一句话。这不是提示词写的，是工具数据源真的只返回那一句。</span></div>`);
  box.innerHTML = rows.join('');
}

/* ============================================================
   视图切换
   ============================================================ */
function setView(v) {
  state.view = v;
  $$('.tab').forEach((t) => t.classList.toggle('on', t.getAttribute('data-view') === v));
  $('#view-class').hidden = v !== 'class';
  $('#view-practice').hidden = v !== 'practice';
  $('#view-book').hidden = v !== 'book';
  if (v === 'book') renderBook();
}

/* ============================================================
   课堂：事件 → DOM
   ============================================================ */
function clearStream() {
  $('#stream').innerHTML = '';
  state.teacherBubble = null;
}

function bubbleEl(role, name, tag) {
  const el = document.createElement('div');
  el.className = `turn ${role}`;
  el.innerHTML = `
    <div class="avatar ${role}">${esc(AGENTS[role] ? AGENTS[role].short : '我')}</div>
    <div class="bubble-wrap">
      <div class="bubble-meta">
        <span class="role-name">${esc(name)}</span>
        ${tag ? `<span class="role-tag">${esc(tag)}</span>` : ''}
        <span class="move-slot"></span>
      </div>
      <div class="bubble"><span class="b-text"></span></div>
    </div>`;
  return el;
}

function atBottom() {
  const s = $('#stream');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}
function scrollDown(force) {
  const s = $('#stream');
  if (force || atBottom()) s.scrollTop = s.scrollHeight;
}

function appendNote(text, level = '') {
  const el = document.createElement('div');
  el.className = `note ${level}`;
  el.textContent = text;
  $('#stream').appendChild(el);
  scrollDown(true);
}

function appendRound(round, phase) {
  const meta = PHASE_META[phase] || { label: phase };
  const el = document.createElement('div');
  el.className = 'round-sep';
  el.innerHTML = `<span class="line"></span><span class="label">第 <b>${round + 1}</b> 轮 · ${esc(meta.label)}</span><span class="line"></span>`;
  $('#stream').appendChild(el);
  scrollDown(true);
}

function appendUserBubble(text, replyTo) {
  const el = document.createElement('div');
  el.className = 'turn user';
  el.innerHTML = `
    <div class="avatar user">我</div>
    <div class="bubble-wrap">
      <div class="bubble-meta">
        <span class="role-name">我</span>
        ${replyTo ? `<span class="role-tag">回答第 ${replyTo} 轮老师的问题</span>` : ''}
      </div>
      <div class="bubble"><span class="b-text">${renderInline(text)}</span></div>
    </div>`;
  $('#stream').appendChild(el);
  scrollDown(true);
}

function ensureTeacherBubble(again) {
  const stream = $('#stream');
  if (state.teacherBubble && !again) return state.teacherBubble;
  if (again || !state.teacherBubble) {
    const el = bubbleEl('teacher', AGENTS.teacher.name, '老师');
    stream.appendChild(el);
    state.teacherBubble = el;
  }
  return state.teacherBubble;
}

function setTeacherText(text, move) {
  const el = ensureTeacherBubble(false);
  el.querySelector('.b-text').innerHTML = renderInline(text);
  const slot = el.querySelector('.move-slot');
  if (move) {
    slot.innerHTML = `<span class="move-tag ${move}">${move}</span>`;
  }
  scrollDown();
  return el;
}

async function typeInto(el, text, opts = {}) {
  const body = el.querySelector('.b-text');
  if (REDUCED() || !text) { body.innerHTML = renderInline(text); return; }
  const total = text.length;
  const dur = Math.min(opts.max || 1500, Math.max(420, total * 16));
  const t0 = performance.now();
  let shown = 0;
  await new Promise((resolve) => {
    function frame(t) {
      const p = Math.min(1, (t - t0) / dur);
      const n = Math.floor(p * total);
      if (n !== shown) { shown = n; body.innerHTML = renderInline(text.slice(0, shown)) + '<span class="caret"></span>'; scrollDown(); }
      if (p < 1) requestAnimationFrame(frame);
      else { body.innerHTML = renderInline(text); scrollDown(); resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

function appendTurn(turn) {
  return enqueue(async () => {
    const a = AGENTS[turn.role];
    const tag = a ? (a.kind === 'student' ? a.name2 : '老师') : '';
    const el = bubbleEl(turn.role, turn.name || (a ? a.name : turn.role), tag);
    $('#stream').appendChild(el);
    scrollDown(true);
    await typeInto(el, turn.text || '');
  });
}

function appendToolChip(role, name, phase, ok, error) {
  if (phase === 'call') {
    const el = document.createElement('div');
    el.className = 'toolchip';
    el.setAttribute('data-tool', `${role}:${name}`);
    const a = AGENTS[role];
    el.innerHTML = `<span class="spin"></span>${esc(a ? a.name : role)} 正在调用 ${esc(name)}…`;
    $('#stream').appendChild(el);
    scrollDown(true);
    return;
  }
  const el = $(`[data-tool="${role}:${name}"]`, $('#stream'));
  if (!el) return;
  el.classList.add('done');
  el.innerHTML = ok
    ? `<span class="tick">✓</span>${esc(AGENTS[role] ? AGENTS[role].name : role)} 用了 ${esc(name)}`
    : `<span class="bad-tx">✕</span>${esc(name)} 没成功${error ? '：' + esc(String(error).slice(0, 60)) : ''}`;
}

/* ---- 答题卡 ---- */
function renderAsk(spec) {
  const slot = $('#ask-slot');
  const clarify = spec.phase === 'clarify';
  slot.innerHTML = `
    <div class="ask-card" id="ask-card">
      <div class="ask-head"><span class="dot"></span>该你了</div>
      <div class="ask-q">${renderInline(spec.prompt)}</div>
      ${spec.hint ? `<div class="ask-hint">提示：${renderInline(spec.hint)}</div>` : ''}
      <div class="ask-row">
        <input id="ask-input" type="text" autocomplete="off" placeholder="${esc(spec.placeholder || '')}">
        <button class="btn primary" id="ask-submit">交答案</button>
      </div>
      <div class="ask-quick">
        <button class="btn ghost sm" data-quick="还是没懂">还是没懂</button>
        <button class="btn ghost sm" data-quick="懂了，继续">懂了，继续</button>
        <button class="btn ghost sm" id="ask-skip">跳过这题</button>
      </div>
      ${clarify ? '<p class="side-hint" style="margin-top:8px">这一步只有陈老师会说话 —— 那三个同学已经安静了。答完再让他们回来。</p>' : ''}
    </div>`;

  const input = $('#ask-input');
  const submit = (text) => {
    if (!Classroom.submitAnswer(state.session, text)) return;
    slot.innerHTML = '';
    setInterject(state.session);
  };
  $('#ask-submit').onclick = () => submit(input.value);
  input.onkeydown = (e) => {
    // ★ 中文输入法组合期不能提交 —— 回车是在选字，不是在交答案
    if (e.key === 'Enter' && !e.isComposing) submit(input.value);
  };
  $('#ask-skip').onclick = () => {
    if (Classroom.skipAnswer(state.session)) { slot.innerHTML = ''; setInterject(state.session); }
  };
  $$('.ask-quick [data-quick]', slot).forEach((b) => {
    b.onclick = () => submit(b.getAttribute('data-quick'));
  });
  input.focus();
  setInterject(state.session);
}

/* ============================================================
   ★ 插话门禁：可用状态只在这一个函数里算
   ============================================================ */
function setInterject(session) {
  const on = Classroom.canInterject(session);
  const inp = $('#c-input');
  const btn = $('#c-send');
  const ph = Classroom.interjectPlaceholder(session);
  if (inp) { inp.disabled = !on; inp.placeholder = ph; }
  if (btn) btn.disabled = !on;
  const hint = $('#c-hint');
  if (hint) {
    hint.textContent = on
      ? '插的话老师下一轮会看到'
      : (session ? ph : '先选一个考点，开一节课');
  }
  return on;
}

/* ============================================================
   课堂：hooks
   ============================================================ */
const hooks = {
  onStatus(s) {
    const el = $('#status');
    el.textContent = s;
    el.classList.toggle('busy', state.running && s !== '这一节结束了');
  },
  onEvent(ev) {
    switch (ev.type) {
      case 'round':
        appendRound(ev.round, ev.phase);
        break;
      case 'speaking': {
        const prev = $('.avatar.speaking');
        if (prev) prev.classList.remove('speaking');
        if (ev.role === 'teacher') {
          const el = ensureTeacherBubble(!!ev.again);
          if (ev.again) { state.teacherBubble = el; }
          const av = el.querySelector('.avatar');
          if (av) av.classList.add('speaking');
        }
        break;
      }
      case 'delta': {
        const el = ensureTeacherBubble(false);
        el.querySelector('.b-text').innerHTML = renderInline(ev.text) + '<span class="caret"></span>';
        el.querySelector('.bubble').classList.add('streaming');
        const slot = el.querySelector('.move-slot');
        if (ev.move && slot && !slot.innerHTML) slot.innerHTML = `<span class="move-tag ${ev.move}">${ev.move}</span>`;
        scrollDown();
        break;
      }
      case 'patch': {
        const el = state.teacherBubble;
        if (el) {
          el.querySelector('.b-text').innerHTML = renderInline(ev.text);
          el.querySelector('.bubble').classList.remove('streaming');
          const slot = el.querySelector('.move-slot');
          if (ev.move) slot.innerHTML = `<span class="move-tag ${ev.move}">${ev.move}</span>`;
        }
        renderProfile();
        break;
      }
      case 'turn':
        appendTurn(ev.turn);
        break;
      case 'note':
        appendNote(ev.text, ev.level || '');
        break;
      case 'tool':
        appendToolChip(ev.role, ev.name, ev.phase, ev.ok, ev.error);
        break;
      case 'board': {
        if (state.session) {
          state.session.board.push(ev.item);
          renderBoard(state.session);
        }
        break;
      }
      case 'ask':
        renderAsk(ev.spec);
        break;
      case 'user':
        appendUserBubble(ev.text, ev.replyTo);
        break;
      case 'error':
        appendNote(`出错了：${ev.message}`, 'err');
        toast(ev.message, 'err');
        break;
      case 'done':
        state.running = false;
        state.session = null;
        state.teacherBubble = null;
        $('#start-btn').disabled = false;
        $('#ask-slot').innerHTML = '';
        setInterject(null);
        renderProfile();
        renderPoints();
        renderBook();
        break;
      default:
        break;
    }
  },
};

/* ============================================================
   开始上课
   ============================================================ */
async function startClass() {
  if (state.running) return;
  if (!state.topicId) { toast('先在左边选一个考点', 'warn'); return; }

  const session = Classroom.newSession(state.topicId, state.mode);
  state.session = session;
  state.boardPage = null;
  state.teacherBubble = null;
  clearStream();
  renderBoard(session);

  /* ★ 先 markLive，再渲染，再算门禁。
   *   顺序反了的话，isLive 是 false → 输入框一渲染出来就是禁用的，
   *   整节课都点不了（真踩过）。 */
  Classroom.markLive(session);
  state.running = true;
  setInterject(session);
  $('#start-btn').disabled = true;
  $('#status').textContent = '开课';
  $('#status').classList.add('busy');
  renderProfile();

  try {
    await Classroom.run(session, hooks, {});
  } catch (e) {
    appendNote(`这节课中断了：${e.message}`, 'err');
    toast(e.message, 'err');
  } finally {
    state.running = false;
    state.session = null;
    $('#start-btn').disabled = false;
    setInterject(null);
  }
}

/* ============================================================
   黑板
   ============================================================
   ★ 记账口径必须和渲染口径一致。
     drawn = 当前页里**真正画出来的块**（graph / steps / latex）。
     highlight 不渲染成块，所以不算进块数；page / clear 是分隔标记，也不算。
     口径不一致的话，计数比实际多，新块的起点算错，
     **该播动画的块不播** —— 静默失效，比报错难查得多。
   ============================================================ */
const graphCtx = new Map();

function boardState(items) {
  const pages = [[]];
  let lastClear = -1;
  items.forEach((it, i) => {
    if (!it) return;
    if (it.kind === 'clear') { pages.length = 0; pages.push([]); lastClear = i; return; }
    if (it.kind === 'page') { pages.push([]); return; }
    pages[pages.length - 1].push(it);
  });
  return { pages, lastClear };
}

function drawnOf(pageItems) {
  return pageItems.filter((it) => Tools.BOARD_BLOCK_KINDS.includes(it.kind));
}

function emptyBoardHtml() {
  return `<div class="board-empty">
    <div class="board-empty-glyph">∅</div>
    <p>老师写上去的东西会出现在这里</p>
    <p class="dim">曲线可以拖参数；步骤会逐条落下；公式会自动排版</p>
  </div>`;
}

function renderBoard(session) {
  const box = $('#board');
  if (!box) return;

  const items = (session && session.board) || [];
  const { pages, lastClear } = boardState(items);
  const total = pages.length || 1;

  if (state.boardPage === null || state.boardPage === undefined || state.boardPage >= total) {
    state.boardPage = total - 1;
  }
  const pageIdx = Math.max(0, Math.min(total - 1, state.boardPage));
  const pageItems = pages[pageIdx] || [];
  const drawn = drawnOf(pageItems);
  const lights = pageItems.filter((it) => it.kind === 'highlight');

  /* ★ isNaN 时 fallback 到 drawn.length，**不是 0**。
   *   fallback 写 0 的话，第一次收到新动作时会把已有的老内容
   *   全当成新的，重播一遍动画。 */
  const prevBlocks = parseInt(box.getAttribute('data-blocks'), 10);
  const prevClear = box.getAttribute('data-clear');
  const prevPage = box.getAttribute('data-page');
  const pageChanged = String(pageIdx) !== String(prevPage);
  const cleared = String(lastClear) !== String(prevClear);
  const freshFrom = (pageChanged || cleared)
    ? 0
    : (Number.isNaN(prevBlocks) ? drawn.length : prevBlocks);

  box.setAttribute('data-blocks', String(drawn.length));
  box.setAttribute('data-clear', String(lastClear));
  box.setAttribute('data-page', String(pageIdx));

  graphCtx.clear();
  if (!drawn.length) {
    box.innerHTML = emptyBoardHtml();
  } else {
    let bi = 0;
    box.innerHTML = pageItems.map((it) => {
      if (it.kind === 'highlight') return '';
      const idx = bi++;
      return blockHtml(it, idx, idx >= freshFrom, lights);
    }).join('');
  }

  renderPageNav(total, pageIdx);
  bindBoard();
}

function renderPageNav(total, pageIdx) {
  const nav = $('#page-nav');
  if (!nav) return;
  // 只有一页时不渲染导航 —— 没翻过页，就别多给一个要理解的东西
  if (total <= 1) { nav.innerHTML = ''; return; }
  nav.innerHTML = `
    <button id="pg-prev" ${pageIdx <= 0 ? 'disabled' : ''}>‹</button>
    <span class="pg">${pageIdx + 1}/${total}</span>
    <button id="pg-next" ${pageIdx >= total - 1 ? 'disabled' : ''}>›</button>`;
  const prev = $('#pg-prev'), next = $('#pg-next');
  if (prev) prev.onclick = () => { state.boardPage = pageIdx - 1; renderBoard(state.session); };
  if (next) next.onclick = () => { state.boardPage = pageIdx + 1; renderBoard(state.session); };
}

function blockHtml(item, idx, fresh, lights) {
  const lit = lights.find((l) => String(Tools.blockText(item)).includes(String(l.target || '')));
  const cls = ['b-item', `b-${item.kind}`];
  if (fresh) cls.push('b-fresh');
  if (lit) cls.push('is-lit');

  let body = '';
  if (item.kind === 'graph') body = graphBody(item, idx);
  else if (item.kind === 'steps') body = stepsBody(item);
  else if (item.kind === 'latex') body = latexBody(item);

  const by = item.by && AGENTS[item.by] ? `<span class="b-by">${esc(AGENTS[item.by].name)}</span>` : '';
  const why = lit && lit.why ? `<div class="b-lit-why">${esc(lit.why)}</div>` : '';
  return `<div class="${cls.join(' ')}" data-i="${idx}">${body}${why}${by}</div>`;
}

function stepsBody(item) {
  const title = item.title ? `<div class="b-title">${esc(item.title)}</div>` : '';
  const lis = (item.steps || []).map((s) => `<li>${renderInline(s)}</li>`).join('');
  return `${title}<ol class="b-steps">${lis}</ol>`;
}

function latexBody(item) {
  const cap = item.caption ? `<div class="b-latex-cap">${esc(item.caption)}</div>` : '';
  return `<div class="b-latex">${renderLatex(item.tex || '')}</div>${cap}`;
}

/* ---- 图 ---- */
const GW = 460, GH = 280, GP = 34;

function proj(item) {
  const sx = (x) => GP + ((x - item.xmin) / (item.xmax - item.xmin)) * (GW - 2 * GP);
  const sy = (y) => GH - GP - ((y - item.ymin) / (item.ymax - item.ymin)) * (GH - 2 * GP);
  return { sx, sy };
}

function pathFrom(pts, item) {
  const { sx, sy } = proj(item);
  let d = '';
  let pen = false;
  for (const [x, y] of pts) {
    if (y === null || !Number.isFinite(y)) { pen = false; continue; }
    const py = sy(y);
    // 超出视野太多的点直接断笔，不然一条竖线会从图外飞进来
    if (py < -GH * 3 || py > GH * 4) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + sx(x).toFixed(1) + ' ' + py.toFixed(1);
    pen = true;
  }
  return d;
}

function axisSvg(item) {
  const { sx, sy } = proj(item);
  const out = [];

  // 网格 + 刻度：挑一个「整」的步长，别出现 0.3333 这种刻度
  const xspan = item.xmax - item.xmin;
  const yspan = item.ymax - item.ymin;
  const stepOf = (span) => {
    const raw = span / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const s = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return s * mag;
  };
  const xs = stepOf(xspan), ys = stepOf(yspan);

  for (let x = Math.ceil(item.xmin / xs) * xs; x <= item.xmax + 1e-9; x += xs) {
    const px = sx(x);
    out.push(`<line class="bg-gridline" x1="${px.toFixed(1)}" y1="${GP}" x2="${px.toFixed(1)}" y2="${GH - GP}"/>`);
    out.push(`<text class="bg-tick" x="${px.toFixed(1)}" y="${GH - GP + 13}" text-anchor="middle">${fmtNum(Math.round(x * 1e6) / 1e6)}</text>`);
  }
  for (let y = Math.ceil(item.ymin / ys) * ys; y <= item.ymax + 1e-9; y += ys) {
    const py = sy(y);
    out.push(`<line class="bg-gridline" x1="${GP}" y1="${py.toFixed(1)}" x2="${GW - GP}" y2="${py.toFixed(1)}"/>`);
    out.push(`<text class="bg-tick" x="${GP - 6}" y="${(py + 3).toFixed(1)}" text-anchor="end">${fmtNum(Math.round(y * 1e6) / 1e6)}</text>`);
  }

  // 坐标轴（只在原点落在视野内时画到原点，否则贴边）
  const ox = Math.max(GP, Math.min(GW - GP, sx(0)));
  const oy = Math.max(GP, Math.min(GH - GP, sy(0)));
  out.push(`<line class="bg-axis" x1="${GP}" y1="${oy.toFixed(1)}" x2="${GW - GP}" y2="${oy.toFixed(1)}"/>`);
  out.push(`<line class="bg-axis" x1="${ox.toFixed(1)}" y1="${GP}" x2="${ox.toFixed(1)}" y2="${GH - GP}"/>`);
  out.push(`<text class="bg-label" x="${GW - GP + 2}" y="${(oy + 3).toFixed(1)}">x</text>`);
  out.push(`<text class="bg-label" x="${(ox + 5).toFixed(1)}" y="${GP - 2}">y</text>`);
  return out.join('');
}

function graphBody(item, idx) {
  let fn = null;
  let err = '';
  try { fn = Tools.compile(item.expr, (item.params || []).map((p) => p.name)); }
  catch (e) { err = e.message; }

  const scope = {};
  for (const p of item.params || []) scope[p.name] = p.value;

  let d = '';
  if (fn) {
    const pts = Tools.samplePoints(fn, item.xmin, item.xmax, 320, scope);
    d = pathFrom(pts, item);
  }
  if (fn) graphCtx.set(String(idx), { item, fn, scope });

  const clipId = `bclip${idx}`;
  const params = (item.params || []).length
    ? `<div class="b-params">
        ${item.params.map((p) => `
          <div class="b-param">
            <span class="pn">${esc(p.name)}</span>
            <input type="range" data-g="${idx}" data-p="${esc(p.name)}"
                   min="${p.min}" max="${p.max}" step="${((p.max - p.min) / 200).toPrecision(2)}"
                   value="${p.value}">
            <span class="pv">${fmtNum(p.value)}</span>
          </div>`).join('')}
        <div class="b-params-hint">拖一下滑块，看曲线怎么变。坐标轴是钉死的 —— 不钉的话整张图会跟着手抖。</div>
      </div>`
    : '';

  const title = item.title ? `<div class="b-title">${esc(item.title)}</div>` : '';
  const errHtml = err ? `<div class="b-lit-why">表达式没法画：${esc(err)}</div>` : '';

  return `${title}
    <svg viewBox="0 0 ${GW} ${GH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(item.title || item.expr)}">
      <defs><clipPath id="${clipId}"><rect x="${GP}" y="${GP}" width="${GW - 2 * GP}" height="${GH - 2 * GP}"/></clipPath></defs>
      ${axisSvg(item)}
      <g clip-path="url(#${clipId})">
        <path class="b-graph-line" pathLength="1" d="${d}" fill="none"/>
      </g>
    </svg>
    ${errHtml}${params}`;
}

/* ★ 事件委托绑在**容器**上，并且初始渲染和后续重画两条路径都要调。
 *   绑定写在 renderBoard 里、而初始页面不经过 renderBoard 的话，
 *   滑块画得出来、样式也对、拖了毫无反应。 */
function bindBoard() {
  const box = $('#board');
  if (!box || box.getAttribute('data-board-bound')) return;
  box.setAttribute('data-board-bound', '1');
  box.addEventListener('input', onBoardInput);
  box.addEventListener('change', onBoardInput);
}

function onBoardInput(e) {
  const r = e.target.closest && e.target.closest('input[type="range"][data-g]');
  if (!r) return;
  const gi = r.getAttribute('data-g');
  const g = graphCtx.get(gi);
  if (!g) return;
  const pname = r.getAttribute('data-p');
  g.scope[pname] = Number(r.value);

  const lab = r.parentElement.querySelector('.pv');
  if (lab) lab.textContent = fmtNum(Number(r.value));

  const wrap = r.closest('.b-item');
  /* ★ 换内容前把入场动画的类摘掉。
   *   不摘的话，新插进去的 path 会重新匹配描线动画规则，
   *   每拖一下就重播一次「一笔描出来」—— 那是入场动画，不是交互反馈。
   *   语义上也对：他都在拖它了，它显然不再是「刚出现的块」。 */
  if (wrap) wrap.classList.remove('b-fresh');

  const svg = wrap && wrap.querySelector('svg');
  const path = svg && svg.querySelector('.b-graph-line');
  if (!path) return;
  const pts = Tools.samplePoints(g.fn, g.item.xmin, g.item.xmax, 320, g.scope);
  path.setAttribute('d', pathFrom(pts, g.item));
}

/* ============================================================
   练习
   ============================================================ */
function syncGenPoint() {
  const sel = $('#gen-point');
  if (!sel) return;
  if (state.topicId) sel.value = state.topicId;
}

function renderGenPoints() {
  const sel = $('#gen-point');
  sel.innerHTML = POINTS.map((p) => `<option value="${p.id}">${esc(p.module)} · ${esc(p.name)}</option>`).join('');
  syncGenPoint();
}

function builtinStems(pointId) {
  const p = pointById(pointId);
  return p ? (p.questions || []).map((q) => q.stem) : [];
}

function renderQuiz() {
  const box = $('#quiz');
  if (!state.quiz.length) { box.innerHTML = ''; return; }
  box.innerHTML = state.quiz.map((q, i) => {
    const isChoice = q.type === 'choice' || (q.options && q.options.length);
    const opts = isChoice ? `<div class="opts">${q.options.map((o) =>
      `<button class="opt" data-q="${i}" data-k="${esc(o.k)}"><span class="k">${esc(o.k)}</span><span>${renderInline(o.t)}</span></button>`).join('')}</div>` : '';
    const input = isChoice ? '' : `<div class="q-actions"><input class="q-input" data-q="${i}" placeholder="只填数值，例如 1/2、0.5、2"><button class="btn primary sm" data-submit="${i}">交答案</button></div>`;
    return `<div class="qcard" data-card="${i}">
      <div class="q-head">
        <span class="q-no">Q${i + 1}</span>
        <span>${esc(pointById(q.pointId) ? pointById(q.pointId).name : '练习')}</span>
        <span class="q-src ${q.generated ? 'ai' : ''}">${q.generated ? 'AI 生成' : '题库'}</span>
      </div>
      <div class="q-stem">${renderInline(q.stem)}</div>
      ${opts}${input}
      <div class="verdict-slot"></div>
    </div>`;
  }).join('');

  box.onclick = (e) => {
    const opt = e.target.closest('.opt');
    if (opt) { submitQuiz(Number(opt.getAttribute('data-q')), opt.getAttribute('data-k')); return; }
    const sub = e.target.closest('[data-submit]');
    if (sub) {
      const i = Number(sub.getAttribute('data-submit'));
      const inp = $(`.q-input[data-q="${i}"]`, box);
      submitQuiz(i, inp ? inp.value : '');
    }
  };
  box.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const inp = e.target.closest('.q-input');
    if (inp) submitQuiz(Number(inp.getAttribute('data-q')), inp.value);
  };
}

async function submitQuiz(i, answer) {
  const q = state.quiz[i];
  if (!q) return;
  const card = $(`[data-card="${i}"]`);
  const slot = card && card.querySelector('.verdict-slot');
  if (!slot) return;

  const r = judge(q, answer);
  $$('.opt', card).forEach((o) => {
    o.classList.remove('on');
    if (o.getAttribute('data-k') === String(q.answer).toUpperCase()) o.classList.add('right');
    if (o.getAttribute('data-k') === String(answer).toUpperCase() && !r.correct) o.classList.add('wrong');
  });

  /* ★ 三种结果，不能压成两种。
   *   把「判不了」压成「错」，用户答对了却被告知错 —— 最伤信任的一种 bug。
   *   所以判不了时走降级：把标准答案摊给他自己看。 */
  if (!r.gradable) {
    slot.innerHTML = `<div class="verdict manual">
      <div class="v-title">这道题程序判不了分</div>
      <div class="v-body">标准答案：<b>${esc(prettyAnswer(q))}</b>
自己对照一下。之所以不硬判，是因为硬判有可能把你对的答案判成错的 —— 那比不判更糟。</div>
    </div>`;
    return;
  }

  if (r.gradable) {
    Store.recordAnswer({
      pointId: q.pointId || state.topicId,
      qid: q.id || `gen_${i}`,
      answer: String(answer),
      correct: r.correct,
      source: q.generated ? 'ai' : 'bank',
    });
  }

  slot.innerHTML = `<div class="verdict ${r.correct ? 'right' : 'wrong'}">
    <div class="v-title">${r.correct ? '答对了' : '不对'}　<span class="dim mono">你写的是 ${esc(String(answer) || '（空）')} · 标准答案 ${esc(prettyAnswer(q))}</span></div>
    <div class="v-body" id="explain-${i}">${q.explain ? esc(q.explain) : ''}${r.correct ? '' : '\n正在让 AI 讲一下你错在哪…'}</div>
  </div>`;

  if (!r.correct) {
    const out = await explainAnswer({
      pointId: q.pointId || state.topicId,
      stem: q.stem,
      userAnswer: String(answer),
      standard: prettyAnswer(q),
      correct: false,
    });
    const body = $(`#explain-${i}`);
    if (body) body.textContent = `${q.explain ? q.explain + '\n\n' : ''}${out.text}`;
  }
  renderProfile();
  renderPoints();
}

async function doGenerate() {
  const pointId = $('#gen-point').value;
  const count = Number($('#gen-count').value);
  const btn = $('#gen-btn');
  const note = $('#gen-note');
  btn.disabled = true;
  note.className = 'gen-note';
  note.textContent = '正在出题…（要的是 ' + (count + 2) + ' 道，多出两道当缓冲，判不了分的会被丢掉）';

  const res = await generateQuestions({ pointId, count, knownStems: builtinStems(pointId) });
  state.generated = res.created;
  state.quiz = res.created.slice();
  note.className = res.parseFailed ? 'gen-note warn' : 'gen-note';
  note.textContent = res.note;
  renderQuiz();
  btn.disabled = false;
}

function doBank() {
  const pointId = $('#gen-point').value;
  const p = pointById(pointId);
  state.quiz = (p && p.questions ? p.questions.map((q) => ({ ...q, pointId })) : []);
  $('#gen-note').className = 'gen-note';
  $('#gen-note').textContent = `题库里这个考点有 ${state.quiz.length} 道题。`;
  renderQuiz();
}

/* ============================================================
   错题本
   ============================================================ */
function renderBook() {
  const weak = Store.weakPoints(8);
  const mis = Store.recentMistakes(10);

  $('#weak-list').innerHTML = weak.length ? weak.map((w) => {
    const p = pointById(w.pointId);
    const pct = Math.round(w.accuracy * 100);
    return `<div class="wrow">
      <div class="w-top">
        <span class="w-name">${esc(p ? p.name : w.pointId)}</span>
        <span class="w-bar"><span class="w-fill" style="width:${Math.max(6, 100 - pct)}%"></span></span>
        <span class="w-num">${pct}%</span>
      </div>
      <div class="w-num">做过 ${w.seen} 题 · 错 ${w.wrong} 次${w.last && w.last.length ? ' · 最近 ' + w.last.map((v) => (v ? '对' : '错')).join('') : ''}</div>
    </div>`;
  }).join('') : `<p class="dim">还没有记录。去课堂里答几道题，或者到练习区做几道。</p>`;

  $('#mistake-list').innerHTML = mis.length ? mis.map((m) => {
    const p = pointById(m.pointId);
    return `<div class="mrow">
      <div class="m-q">${esc(p ? p.name : m.pointId)}</div>
      <div class="m-a">他写的：${esc(m.answer) || '（空）'}</div>
      <div class="m-t">${esc(String(m.at).replace('T', ' ').slice(0, 19))}</div>
    </div>`;
  }).join('') : `<p class="dim">还没有错题。</p>`;
}

/* ============================================================
   启动
   ============================================================ */
async function checkHealth() {
  const h = await llm.health();
  state.health = h;
  const el = $('#health');
  if (!h || !h.ok) {
    el.className = 'health bad';
    el.textContent = '服务端没起来';
    return;
  }
  if (!h.hasKey) {
    el.className = 'health bad';
    el.textContent = '缺 API Key';
    el.title = '在项目目录执行 cp .env.example .env，填入 DEEPSEEK_API_KEY，然后重启服务';
    toast('服务端没配 API Key，去项目目录执行 cp .env.example .env 填上', 'warn');
    return;
  }
  el.className = 'health ok';
  el.textContent = h.keyLooksValid ? `已连接 · ${h.model}` : `Key 格式可疑 · ${h.model}`;
  el.title = `上游 ${h.base}`;
}

function init() {
  renderModes();
  renderPoints();
  renderProfile();
  renderTools();
  renderGenPoints();
  renderBoard(null);
  setInterject(null);

  $('#start-btn').onclick = startClass;
  $('#tool-toggle').onclick = () => { toolsOpen = !toolsOpen; renderTools(); };

  $('#tabs').onclick = (e) => {
    const t = e.target.closest('.tab');
    if (t) setView(t.getAttribute('data-view'));
  };

  $('#c-send').onclick = () => {
    const inp = $('#c-input');
    if (!Classroom.interject(state.session, inp.value)) { toast('现在不能插话', 'warn'); return; }
    appendUserBubble(inp.value, null);
    inp.value = '';
    toast('老师下一轮会看到');
  };
  $('#c-input').onkeydown = (e) => {
    // ★ 中文输入法组合期回车是在选字，不是在提交
    if (e.key === 'Enter' && !e.isComposing) $('#c-send').click();
  };

  $('#gen-btn').onclick = doGenerate;
  $('#bank-btn').onclick = doBank;

  $('#reset-btn').onclick = () => {
    if (!confirm('清空本机的全部作答记录、错题本和上课记录？这一步不可撤销。')) return;
    Store.reset();
    state.generated = [];
    state.quiz = [];
    renderQuiz();
    renderProfile();
    renderPoints();
    renderBook();
    toast('已清空');
  };

  checkHealth();
  setInterval(() => { if (!state.running) renderProfile(); }, 4000);

  window.__wenxue = { state, Tools, Classroom, Store, judge, renderBoard, setInterject };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
