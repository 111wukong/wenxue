/* 探针页面生成器
 *
 * ── 思路 ────────────────────────────────────────────────────────
 * 真页面的交互没法从外面点（CDP 在这里被拦）。所以反过来：
 * 生成一份 **index.html 的副本**，末尾多挂一个驱动脚本，让它自己点自己。
 *
 *   public/index.html          ← 产品，一个字不动
 *   public/__probe.html        ← 运行时生成的副本（测完删掉）
 *   public/__probe-driver.js   ← 驱动脚本（测完删掉）
 *
 * 驱动脚本走的是**真实的 UI 路径**：点考点、点开课、点答题卡的按钮。
 * 不是直接调内部函数 —— 那样就测不到「接线有没有接上」，
 * 而接线恰恰是最容易断的地方。
 */

import fs from 'node:fs';
import path from 'node:path';

export const PROBE_HTML = '__probe.html';
export const PROBE_JS = '__probe-driver.js';

export const DRIVER_SOURCE = String.raw`
/* 驱动脚本（测试用，不随产品发布） */
const out = {
  scenario: new URLSearchParams(location.search).get('probe') || 'home',
  steps: [], errors: [], ok: false,
};
window.addEventListener('error', (e) => out.errors.push('window: ' + (e.message || e.type)));
window.addEventListener('unhandledrejection', (e) => {
  out.errors.push('promise: ' + ((e.reason && e.reason.message) || String(e.reason)));
});

/* ★ 结果**边跑边落**，不是等跑完才写。
 *   虚拟时间预算一旦提前到期，Chrome 就 dump 当前 DOM ——
 *   如果结果只在最后写一次，超时就什么都看不到，
 *   只能看到「探针没跑完」，而卡在哪一步完全靠猜。 */
const pre = document.createElement('pre');
pre.id = '__probe';
document.body.appendChild(pre);
function flush() { pre.textContent = JSON.stringify(out, null, 2); }
const step = (s) => { out.steps.push(s); flush(); };

/* 兜底：万一 --force-prefers-reduced-motion 没生效，
 * 也在 JS 层把打字机关掉（app.js 里 REDUCED() 就是查这个）。
 * 不关的话，学生发言的逐字动画会卡在 rAF 上 —— 虚拟时间不推进 rAF，
 * 于是一条发言永远打不完，后面所有气泡都渲染不出来。 */
try {
  const orig = window.matchMedia.bind(window);
  window.matchMedia = (q) => (String(q).includes('reduced-motion')
    ? { matches: true, addListener() {}, removeListener() {} }
    : orig(q));
} catch (e) { /* 不改也能跑 */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out.t0 = Math.round(performance.now());
flush();
/* ============================================================
   ★ 轮询的让出方式决定了这个探针能不能跑完
   ============================================================
   无头 Chrome 的 --virtual-time-budget 只对**定时器**加速：
   setTimeout / rAF 每跑一次就吃掉一段虚拟时间预算，
   而应用真正的进度靠的是**真实网络往返**（浏览器不会为它暂停虚拟时钟）。

   于是用 rAF 轮询会出事：循环以每秒几百万虚拟毫秒的速度烧预算，
   几百毫秒真实时间内预算就见底了，而应用才刚跑完两轮对话。
   实测：budget=60000 和 200000 都在同一个位置停住（11 个请求），
   真实耗时几乎一样（237ms / 216ms）—— 说明瓶颈不是真实时间。

   正解：用 **MessageChannel** 让出。它是宏任务但**不是定时器**，
   不推进虚拟时钟，所以循环可以一直转，把真实时间留给网络。

   再配一个迭代上限兜底 —— 虚拟时钟不推进时 performance.now() 也不推进，
   光靠时间判断会死循环。
   ============================================================ */
const mc = new MessageChannel();
let yieldResolve = null;
mc.port1.onmessage = () => { const r = yieldResolve; yieldResolve = null; if (r) r(); };
mc.port1.start();
const frame = () => new Promise((r) => { yieldResolve = r; mc.port2.postMessage(0); });

const MAX_SPINS = 400000;      // 兜底上限，别死循环

async function waitFor(fn, ms, label) {
  const t0 = performance.now();
  let spins = 0;
  for (;;) {
    let hit = false;
    try { hit = !!fn(); } catch (e) { /* 元素还没出来 */ }
    if (hit) return true;
    if (performance.now() - t0 > ms || ++spins > MAX_SPINS) {
      step('TIMEOUT: ' + label);
      return false;
    }
    await frame();
  }
}

const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
function click(sel) {
  const el = q(sel);
  if (!el) { step('MISS: ' + sel); return false; }
  el.click();
  return true;
}
function setVal(sel, v) {
  const el = q(sel);
  if (!el) { step('MISS: ' + sel); return false; }
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
const S = () => window.__wenxue;

/* ---------- 答题卡自动作答 ---------- */
function autoAnswer(labels) {
  let i = 0;
  const slot = q('#ask-slot');
  if (!slot) { step('MISS: #ask-slot'); return; }
  const mo = new MutationObserver(() => {
    const card = q('#ask-card');
    if (!card || card.getAttribute('data-answered')) return;
    card.setAttribute('data-answered', '1');
    const label = labels[Math.min(i, labels.length - 1)];
    i += 1;
    const btn = qa('#ask-card [data-quick]').find((b) => b.textContent.trim() === label);
    step('ask#' + i + ' -> ' + label + (btn ? '' : '（没找到这个按钮）'));
    if (btn) setTimeout(() => btn.click(), 30);
  });
  mo.observe(slot, { childList: true, subtree: true });
}

/* ---------- 收集现场 ---------- */
function collect() {
  const stream = q('#stream');
  const turns = qa('#stream .turn');
  out.turns = turns.length;
  out.teacherTurns = qa('#stream .turn.teacher').length;
  out.studentTurns = qa('#stream .turn.a, #stream .turn.b, #stream .turn.c').length;
  out.userTurns = qa('#stream .turn.user').length;
  out.notes = qa('#stream .note').map((e) => e.textContent.trim());
  out.rounds = qa('#stream .round-sep').length;
  out.toolChips = qa('#stream .toolchip').length;
  out.moveTags = qa('#stream .move-tag').map((e) => e.textContent.trim());
  out.boardBlocks = qa('#board .b-item').length;
  out.boardKinds = qa('#board .b-item').map((e) => (e.className.match(/b-(graph|steps|latex)/) || [])[1]).filter(Boolean);
  out.boardEmpty = !!q('#board .board-empty');
  out.gauge = (q('#profile .gauge-legend') || {}).textContent || '';
  out.status = (q('#status') || {}).textContent || '';
  out.health = (q('#health') || {}).textContent || '';
  out.profileText = (q('#profile') || {}).textContent || '';
  out.pointsCount = qa('#points .point').length;
  out.toolRows = qa('#tools .tool-row').length;
  out.cInputDisabled = q('#c-input') ? q('#c-input').disabled : null;
  out.askCard = !!q('#ask-card');
  out.askButtons = qa('#ask-card [data-quick]').map((b) => b.textContent.trim());
  out.askPrompt = ((q('#ask-card .ask-q') || {}).textContent || '').slice(0, 120);
  out.askInputDisabled = q('#ask-input') ? q('#ask-input').disabled : null;
  out.quizCards = qa('#quiz .qcard').length;
  out.verdicts = qa('#quiz .verdict').map((e) => e.className + ' :: ' + e.textContent.trim().slice(0, 90));
  out.bookRows = qa('#weak-list .wrow').length + qa('#mistake-list .mrow').length;
  out.streamText = stream ? stream.textContent.replace(/\s+/g, ' ').slice(0, 3000) : '';
  out.boardHtml = (q('#board') || {}).innerHTML ? q('#board').innerHTML.slice(0, 4000) : '';
  out.boardAttrs = q('#board')
    ? { blocks: q('#board').getAttribute('data-blocks'), clear: q('#board').getAttribute('data-clear'), page: q('#board').getAttribute('data-page') }
    : null;
  /* 黑板上的 SVG 曲线路径 —— 断言「真的画出来了」而不是「有块 div」 */
  const path = q('#board .b-graph-line');
  out.graphPathLen = path ? (path.getAttribute('d') || '').length : 0;
  out.graphPathLengthAttr = path ? path.getAttribute('pathLength') : null;
  out.paramSliders = qa('#board input[type="range"]').length;
}

async function finish() {
  collect();
  out.ok = true;
  out.tEnd = Math.round(performance.now());
  flush();
}

/* ============================================================
   场景
   ============================================================ */
(async () => {
  try {
    const S0 = S();
    if (!S0) { out.errors.push('window.__wenxue 不存在 —— app.js 没跑起来'); await finish(); return; }

    if (out.scenario === 'home') {
      await waitFor(() => qa('#points .point').length > 0, 8000, '考点列表');
      /* 健康检查是异步的（要打一次 /api/health），不等它就会截到「检测中…」 */
      await waitFor(() => (q('#health') || {}).textContent.indexOf('检测中') < 0, 8000, '健康检查');
      step('初始渲染完成');
      await finish();
      return;
    }

    if (out.scenario === 'class' || out.scenario === 'ask') {
      S0.Store.reset();
      await waitFor(() => qa('#points .point').length > 0, 8000, '考点列表');
      click('.point[data-point="rolle"]');
      await sleep(30);
      click('.mode[data-mode="class"]');
      await sleep(30);
      out.modeSelected = !!q('.mode[data-mode="class"].on');
      click('#start-btn');
      step('已开课');

      if (out.scenario === 'ask') {
        /* ★ 这一屏截的是「等你作答」——**故意不自动作答**。
         *   课堂最有信息量的一刻就是答题卡弹出来的那一下：
         *   老师的追问、同学的发言、黑板上的步骤图、以及下面那两个
         *   一键按钮，全都在同一屏里。
         *
         *   ★ 顺序要紧：这一段必须在注册自动作答**之前**。
         *     写在后面的话，观察者会立刻把卡片点掉，
         *     于是「停下来不答」变成了「答完才截图」，
         *     截出来的是课程结束的画面，而断言 askCard 是 false。 */
        await waitFor(() => !!q('#ask-card'), 60000, '答题卡出现');
        step('答题卡已出现，停在这里不答');
        await sleep(400);
        await finish();
        return;
      }

      /* ★ 标签必须和**界面上真实存在的按钮文字**一字不差。
       *   写成「没听懂」（那是内部的意图词，不是按钮文字）的话，
       *   找不到按钮 → 不点 → 整节课挂在「等你作答」上，
       *   表现是「课程永远不结束」，而原因离现场很远。 */
      autoAnswer(['还是没懂', '懂了，继续', '懂了，继续']);

      await waitFor(() => (q('#status') || {}).textContent.indexOf('结束了') >= 0, 90000, '课程结束');
      await finish();
      return;
    }

    if (out.scenario === 'practice') {
      S0.Store.reset();
      await waitFor(() => qa('#points .point').length > 0, 8000, '考点列表');
      click('.tab[data-view="practice"]');
      await sleep(40);
      setVal('#gen-point', 'rolle');
      click('#gen-btn');
      step('已请求出题');
      await waitFor(() => qa('#quiz .qcard').length > 0, 40000, '题目出现');
      await sleep(200);

      /* 第 1 题故意答错、第 2 题按标准答案答对 —— 判对判错两条路都要走到 */
      const cards = qa('#quiz .qcard');
      const c0 = cards[0];
      const bad = c0.querySelector('.opt');
      if (bad) bad.click();
      await waitFor(() => c0.querySelector('.verdict'), 30000, '第 1 题判分');

      if (cards[1]) {
        const input = cards[1].querySelector('.q-input');
        if (input) {
          input.value = '999';                     // 一个几乎肯定不对的值
          const btn = cards[1].querySelector('[data-submit]');
          if (btn) btn.click();
          await waitFor(() => cards[1].querySelector('.verdict'), 30000, '第 2 题判分');
        }
      }
      await sleep(400);
      await finish();
      return;
    }

    if (out.scenario === 'book') {
      S0.Store.reset();
      /* 直接种几条记录 —— 错题本要的是「有数据时的样子」，
         而攒数据这件事本身已经在 classroom 套件里测过了 */
      S0.Store.recordAnswer({ pointId: 'rolle', qid: 'r1', answer: 'A', correct: false });
      S0.Store.recordAnswer({ pointId: 'rolle', qid: 'r2', answer: 'B', correct: true });
      S0.Store.recordAnswer({ pointId: 'rolle', qid: 'r3', answer: 'C', correct: false });
      S0.Store.recordAnswer({ pointId: 'lhopital', qid: 'l1', answer: '1', correct: false });
      S0.Store.recordAnswer({ pointId: 'eigen', qid: 'e1', answer: 'B', correct: true });
      S0.Store.recordAnswer({ pointId: 'eigen', qid: 'e2', answer: 'A', correct: true });
      S0.Store.recordAnswer({ pointId: 'eigen', qid: 'e3', answer: 'D', correct: false });
      click('.tab[data-view="book"]');
      await sleep(200);
      click('#tool-toggle');                        // 顺手把工具清单也展开，一起截图
      await sleep(120);
      step('错题本已渲染');
      await finish();
      return;
    }

    out.errors.push('未知场景：' + out.scenario);
    await finish();
  } catch (e) {
    out.errors.push('driver: ' + (e && e.message ? e.message : String(e)));
    try { await finish(); } catch (e2) { /* 连收集都失败了 */ }
  }
})();
`;

/**
 * 在 public/ 下生成探针页面。返回生成的文件路径。
 * ★ 生成的副本末尾多一行 `<script type="module" src="./__probe-driver.js">`。
 *   index.html 本身**一个字都不动**。
 */
export function prepareProbe(publicDir, driverSource = DRIVER_SOURCE) {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const injected = html.replace(
    '<script type="module" src="./js/app.js"></script>',
    '<script type="module" src="./js/app.js"></script>\n<script type="module" src="./__probe-driver.js"></script>',
  );
  if (injected === html) throw new Error('index.html 里没找到 app.js 的 script 标签，注入失败');
  fs.writeFileSync(path.join(publicDir, PROBE_HTML), injected, 'utf8');
  fs.writeFileSync(path.join(publicDir, PROBE_JS), driverSource, 'utf8');
  return path.join(publicDir, PROBE_HTML);
}

export function cleanupProbe(publicDir) {
  for (const f of [PROBE_HTML, PROBE_JS]) {
    try { fs.unlinkSync(path.join(publicDir, f)); } catch { /* 本来就没有 */ }
  }
}
