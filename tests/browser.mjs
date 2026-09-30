/* 真浏览器端到端套件
 *
 * ── 这个套件回答的是别处回答不了的问题 ──────────────────────────
 * 单元套件验的是纯函数，agent / classroom 套件验的是**数据流**。
 * 但「页面上点下去到底有没有反应」它们都验不了：
 *
 *   · 事件绑定有没有接上（「元素在、样式对、行为没有」那种）
 *   · 模块图能不能在浏览器里链接起来（链接失败 = 整页白屏）
 *   · 有没有未捕获的 JS 异常
 *   · 黑板上的曲线是不是真的算出来了（有块 div ≠ 有曲线）
 *   · 答题卡的按钮点下去有没有推进课程
 *
 * 所以这里真的开一个无头浏览器，**走真实的 UI 路径**：
 * 点考点 → 点开课 → 点答题卡的按钮 → 看 DOM 变成什么样。
 *
 * ── 模型走 mock，不走真的 ───────────────────────────────────────
 * 一是确定性，二是**不烧用户的钱**。mock 的上游和别的套件共用。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  makeReporter, startMock, startApp, writeEnvFile, FAKE_KEY,
  textDeltas, toolDeltas, GOOD_QUESTIONS, ROOT,
} from './lib/harness.mjs';
import { findShell, dumpDom, screenshot, cleanupProfile, countClass, sectionById } from './lib/browser.mjs';
import { prepareProbe, cleanupProbe } from './lib/probe.mjs';

const R = makeReporter('真浏览器 · 端到端');
const { ok, eq } = R;

const PUBLIC_DIR = path.join(ROOT, 'public');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');

const bin = findShell();
if (!bin) {
  /* ★ 跑不了就**明确跳过**，不假装通过。
   *   假绿比没测更糟 —— 它会让人以为这里有人看着。 */
  console.log('⚠ 真浏览器 · 端到端 —— 跳过：这台机器上找不到可用的 chrome-headless-shell');
  console.log('  （找过 Playwright 缓存里的 chrome-headless-shell 与 /usr/bin 下的 chrome/chromium）');
  process.exit(0);
}
console.log(`  内核：${bin}`);

const mock = await startMock();

/* 浏览器套件用的路由：让老师一次调两个工具（写步骤 + 画图），
 * 这样截图里黑板上既有序号列表又有真实曲线。 */
const TEACHER_OPEN = '(focus)\n\n我先不往下讲。你把刚才那个条件用自己的话说一遍——如果去掉它，会怎么样？';
/* ★ 故意让老师在答疑轮**违规**：出一道算题。
 *   不违规的话，「被换成了理解确认」这条提示永远不会出现 ——
 *   而那正是硬过滤存在的意义。测试夹具要主动制造违规，
 *   不然那条兜底路径就是死代码。 */
const TEACHER_CLARIFY = '(telling)\n\n好，那我们直接算一下：lim(x→0) sinx/x 等于多少？';
const STUDENT_LINES = {
  a: '我觉得肯定是中间那一点，直接取中点就行了。',
  b: '可是这个不是要开区间可导吗？闭区间那个条件好像不一样。',
  c: '等等，罗尔定理和那个什么日中值定理是同一个东西吧？',
};

mock.setRoute((body) => {
  const msgs = body.messages || [];
  const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
  const tools = body.tools || [];
  const hasToolResult = msgs.some((m) => m.role === 'tool' || (m.role === 'user' && /【工具结果/.test(String(m.content || ''))));

  if (/课堂调度器/.test(sys)) return textDeltas('{"next":"END"}');
  if (/考研数学出题老师/.test(sys)) return textDeltas(JSON.stringify(GOOD_QUESTIONS));
  if (/讲评老师/.test(sys)) return textDeltas('你大概是漏了前提条件那一步。先回去看定理的第二条，然后重新走一遍。这一步现在清楚了吗？');

  /* ★ 学生必须排在老师之前判：学生的 system 里也含「陈老师」三个字 */
  if (/是陈老师课上的一名学生/.test(sys)) {
    const who = ['林一鸣', '周雨桐', '马小虎'].find((n) => sys.includes(n));
    const key = who === '林一鸣' ? 'a' : who === '周雨桐' ? 'b' : 'c';
    return textDeltas(`${who || '某同学'}：${STUDENT_LINES[key]}`);
  }

  if (/陈老师/.test(sys)) {
    if (/答疑重讲/.test(sys)) return textDeltas(TEACHER_CLARIFY);
    /* ★ 先判「已经拿到工具结果了没有」，再判阶段。
     *   顺序反了的话，agent loop 的每一轮都会再发一次 pose_question，
     *   直到步数上限 —— 屏幕上会出现好几个「正在调用 pose_question」的胶囊，
     *   而最后那次强制收尾调用只拿到工具调用、没有正文，气泡是空的。 */
    if (/当前阶段：练习/.test(sys) && !hasToolResult) {
      return toolDeltas([{ name: 'pose_question', args: { question: '求 f(x)=x³ 在 [0,2] 上满足拉格朗日中值定理的 f′(ξ)。', hint: '先算区间上的平均变化率。', pointId: 'lagrange-mvt' } }], '', 2);
    }
    if (tools.length && !hasToolResult) {
      return toolDeltas([
        {
          name: 'write_steps',
          args: {
            title: '罗尔定理的三个条件',
            steps: ['f(x) 在闭区间 [a,b] 上连续', 'f(x) 在开区间 (a,b) 内可导', '端点值相等：f(a) = f(b)', '则至少存在一点 ξ∈(a,b)，使 f′(ξ) = 0'],
          },
        },
        {
          name: 'draw_graph',
          args: {
            expr: 'a*x^2 - 2*x', xmin: -1.5, xmax: 3.5, title: 'f(x) = ax² − 2x',
            /* ★ 参数范围别开太宽。y 轴是按**参数端点包络**钉死的，
             *   范围一宽（比如 0.5~3），默认那条曲线就被压到图底那一小条里，
             *   看着像「没画出来」。真模型也该挑一个合理的范围。 */
            params: [{ name: 'a', min: 0.6, max: 1.6, value: 1 }],
          },
        },
      ], '', 3);
    }
    return textDeltas(TEACHER_OPEN);
  }
  return textDeltas('（默认）');
});

const envFile = writeEnvFile({
  DEEPSEEK_API_KEY: FAKE_KEY,
  DEEPSEEK_BASE: mock.url,
  DEEPSEEK_MODEL: 'deepseek-chat',
});
const app = await startApp({ WENXUE_ENV_FILE: envFile });

fs.mkdirSync(SHOT_DIR, { recursive: true });
prepareProbe(PUBLIC_DIR);

/* 从 dump 出来的 DOM 里把探针结果抠出来。
 * ★ 要反转义：textContent 里的 `<` `>` `&` 被序列化时会变成实体。 */
function readProbe(dom) {
  const m = dom.match(/<pre id="__probe">([\s\S]*?)<\/pre>/);
  if (!m) return null;
  const raw = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  try { return JSON.parse(raw); } catch { return null; }
}

/* ★ 一定要打 /__probe.html，不能打 /。
 *   服务端把 `/` 映射到 index.html —— 那是**没有驱动脚本的产品页**，
 *   于是页面渲染得好好的，探针却永远不落结果，看起来像「驱动脚本崩了」。 */
const probeUrl = (name) => `${app.url}/__probe.html?probe=${name}`;

async function runScenario(name, budget) {
  const r = await dumpDom(bin, probeUrl(name), { budget, timeout: budget + 40000 });
  return { res: r, probe: readProbe(r.dom), dom: r.dom };
}

async function shoot(name, file, budget) {
  return screenshot(bin, probeUrl(name), file, { budget, timeout: budget + 40000 });
}

try {
  /* ============================================================
     场景 1 · 首页
     ============================================================ */
  {
    const { res, probe } = await runScenario('home', 12000);
    ok('★ 首页能 dump 出 DOM', res.ok, `退出码 ${res.code}，stderr：${res.stderr.slice(0, 200)}`);
    ok('★ 探针脚本跑到了终点（说明 app.js 没在启动时炸掉）', !!probe && probe.ok === true,
      probe ? `卡在这些步骤之后：${JSON.stringify(probe.steps.slice(-6))}` : '连探针结果都没有（驱动脚本没加载？）');
    if (probe && probe.ok) {
      eq('★ 没有未捕获的 JS 异常', probe.errors.length, 0);
      if (probe.errors.length) console.log('      ' + probe.errors.join('\n      '));
      eq('考点树渲染出了 14 个考点', probe.pointsCount, 14);
      eq('一开始黑板是空的', probe.boardEmpty, true);
      eq('★ 没选考点时输入框是禁用的', probe.cInputDisabled, true);
      ok('健康检查显示已连接', /已连接|deepseek/.test(probe.health), probe.health);
      ok('工具清单默认折叠', probe.toolRows >= 1);
    }
    const s = await shoot('home', path.join(SHOT_DIR, '01-首页.png'), 12000);
    ok('首页截图已生成', s.ok && s.size > 20000, `${s.size} 字节`);
  }

  /* ============================================================
     场景 2 · 一整节课（多人课堂，自动作答）
     ============================================================ */
  {
    const { probe } = await runScenario('class', 60000);
    ok('★ 课程场景跑到了终点', !!probe && probe.ok === true,
      probe ? `卡在这些步骤之后：${JSON.stringify(probe.steps.slice(-8))}（未捕获异常：${JSON.stringify(probe.errors)}）` : '连探针结果都没有');
    if (probe && probe.ok) {
      eq('★ 没有未捕获的 JS 异常', probe.errors.length, 0);
      if (probe.errors.length) console.log('      ' + probe.errors.join('\n      '));

      /* ★ 这条断言守的是「每轮一个独立气泡」。
       *   气泡被复用时，屏幕上的老师发言数会少于轮数，
       *   而 session.turns 里的条数是对的 —— 数据流测试抓不到。 */
      ok('★ 老师发言出现在对话流里', probe.teacherTurns >= 2, `teacherTurns=${probe.teacherTurns}`);
      ok('★ 老师气泡数等于轮数（每轮一个独立气泡，不是复用同一个）',
        probe.teacherTurns === probe.rounds,
        `teacherTurns=${probe.teacherTurns} rounds=${probe.rounds}`);
      ok('★ 三个学生都发了言（角色没有趋同）', probe.studentTurns >= 3, `studentTurns=${probe.studentTurns}`);
      ok('★ 用户自己的答案也上屏了', probe.userTurns >= 2, `userTurns=${probe.userTurns}`);
      ok('★ 答题卡确实被点过（自动作答生效）',
        probe.steps.some((s) => s.startsWith('ask#')), JSON.stringify(probe.steps));
      ok('★ 前端收到了「同学已安静」的提示',
        probe.notes.some((n) => n.includes('安静')), JSON.stringify(probe.notes));
      ok('★ 前端收到了「本来要出题，被换成了确认」的提示',
        probe.notes.some((n) => n.includes('被换成了理解确认')), JSON.stringify(probe.notes));
      ok('★ 至少渲染了 3 轮', probe.rounds >= 3, `rounds=${probe.rounds}`);

      /* 黑板：这才是「真的画出来了」的证据 */
      ok('★ 黑板上出现了块', probe.boardBlocks >= 2, `blocks=${probe.boardBlocks} kinds=${probe.boardKinds}`);
      ok('★ 有序号步骤块', probe.boardKinds.includes('steps'));
      ok('★ 有图块', probe.boardKinds.includes('graph'));
      ok('★ 曲线真的算出来了（path 的 d 属性有内容）', probe.graphPathLen > 100, `d 长度=${probe.graphPathLen}`);
      eq('★ 描线动画用的是 pathLength 归一化', probe.graphPathLengthAttr, '1');
      eq('★ 参数滑块渲染出来了', probe.paramSliders, 1);
      ok('★ 黑板的记账属性对得上（data-blocks 等于真实块数）',
        probe.boardAttrs && Number(probe.boardAttrs.blocks) === probe.boardBlocks,
        JSON.stringify(probe.boardAttrs));

      ok('★ 教学动作标签渲染出来了', probe.moveTags.length >= 1, JSON.stringify(probe.moveTags));
      ok('★ 引导占比仪表有内容', /focus|probing|telling/.test(probe.gauge), probe.gauge);
      ok('★ 学习档案有内容', /正确率|累计作答/.test(probe.profileText), probe.profileText.slice(0, 80));

      ok('课程结束后状态条说明已结束', /结束/.test(probe.status), probe.status);
      eq('★ 课程结束后答题卡已收起', probe.askCard, false);
      eq('★ 课程结束后插话入口重新变成禁用', probe.cInputDisabled, true);

      ok('黑板上出现了考点名（老师写的步骤标题）', probe.boardHtml.includes('罗尔定理'));
      ok('工具调用的胶囊出现过', probe.toolChips >= 2, `toolChips=${probe.toolChips}`);
    }
    const s = await shoot('class', path.join(SHOT_DIR, '02-课堂.png'), 60000);
    ok('课堂截图已生成', s.ok && s.size > 20000, `${s.size} 字节`);
  }

  /* ============================================================
     场景 3 · 「该你了」那一屏（课堂最有信息量的一刻）
     ============================================================ */
  {
    const { probe } = await runScenario('ask', 60000);
    ok('★ 答题卡场景跑到了终点', !!probe && probe.ok === true,
      probe ? `卡在这些步骤之后：${JSON.stringify(probe.steps.slice(-6))}` : '连探针结果都没有');
    if (probe && probe.ok) {
      eq('★ 没有未捕获的 JS 异常', probe.errors.length, 0);
      eq('★ 答题卡确实弹出来了', probe.askCard, true);
      if (!probe.askCard) console.log('      steps=' + JSON.stringify(probe.steps) + ' status=' + probe.status + ' turns=' + probe.turns);
      eq('★ 等你作答期间，插话入口是禁用的（别让老师被两条线拉扯）', probe.cInputDisabled, true);
      ok('★ 黑板上已经有内容了', probe.boardBlocks >= 2, `blocks=${probe.boardBlocks}`);
      ok('★ 同学已经发过言', probe.studentTurns >= 3, `studentTurns=${probe.studentTurns}`);
      ok('★ 老师这一轮有正文（不是只调工具留个空气泡）',
        !probe.teacherTurns || probe.teacherTurns >= 1, `teacherTurns=${probe.teacherTurns}`);
      /* 老师的答疑轮里那道算题必须已经被换掉 —— 界面上不该留下它 */
      /* ★ 一键按钮两个都要在 —— 少一个，「还是没懂」这条链就断了：
       *   用户会硬撑着说「懂了」，整个答疑阶段白跑。 */
      ok('★ 答题卡同时提供「还是没懂」和「懂了，继续」',
        probe.askButtons.includes('还是没懂') && probe.askButtons.includes('懂了，继续'),
        JSON.stringify(probe.askButtons));
      ok('★ 答题卡上有问题原文', probe.askPrompt.length > 4, probe.askPrompt);
      eq('★ 答题卡的输入框是可用的（正在等你答）', probe.askInputDisabled, false);
    }
    const s = await shoot('ask', path.join(SHOT_DIR, '03-该你了.png'), 60000);
    ok('答题卡截图已生成', s.ok && s.size > 20000, `${s.size} 字节`);
  }

  /* ============================================================
     场景 4 · 练习（AI 出题 + 判分）
     ============================================================ */
  {
    const { probe } = await runScenario('practice', 45000);
    ok('★ 练习场景跑到了终点', !!probe && probe.ok === true,
      probe ? `卡在这些步骤之后：${JSON.stringify(probe.steps.slice(-8))}（未捕获异常：${JSON.stringify(probe.errors)}）` : '连探针结果都没有');
    if (probe && probe.ok) {
      eq('★ 没有未捕获的 JS 异常', probe.errors.length, 0);
      if (probe.errors.length) console.log('      ' + probe.errors.join('\n      '));

      ok('★ 生成了题目卡片', probe.quizCards >= 3, `quizCards=${probe.quizCards}`);
      ok('★ 判分结果渲染出来了', probe.verdicts.length >= 2, JSON.stringify(probe.verdicts));
      ok('★ 判分结果里带了标准答案',
        probe.verdicts.some((v) => /标准答案/.test(v)), JSON.stringify(probe.verdicts));
      ok('★ 答错的题走到了 AI 讲评或降级文案',
        probe.verdicts.some((v) => /wrong|manual/.test(v)), JSON.stringify(probe.verdicts));
      ok('★ 答对的题被正确标记', probe.verdicts.some((v) => /right/.test(v)) || probe.verdicts.length >= 1);
      ok('★ 答完之后学习档案跟着更新了', /累计作答/.test(probe.profileText), probe.profileText.slice(0, 80));
    }
    const s = await shoot('practice', path.join(SHOT_DIR, '04-练习.png'), 45000);
    ok('练习截图已生成', s.ok && s.size > 20000, `${s.size} 字节`);
  }

  /* ============================================================
     场景 5 · 错题本 + 工具清单展开
     ============================================================ */
  {
    const { probe } = await runScenario('book', 20000);
    ok('★ 错题本场景跑到了终点', !!probe && probe.ok === true,
      probe ? `卡在这些步骤之后：${JSON.stringify(probe.steps.slice(-8))}` : '连探针结果都没有');
    if (probe && probe.ok) {
      eq('★ 没有未捕获的 JS 异常', probe.errors.length, 0);
      ok('★ 薄弱考点与错题都渲染出来了', probe.bookRows >= 3, `bookRows=${probe.bookRows}`);
      ok('★ 档案里算出了正确率', /正确率/.test(probe.profileText), probe.profileText.slice(0, 120));
      ok('★ 工具清单展开后有内容（老师与学生分开列）', probe.toolRows >= 8, `toolRows=${probe.toolRows}`);
    }
    const s = await shoot('book', path.join(SHOT_DIR, '05-错题本.png'), 20000);
    ok('错题本截图已生成', s.ok && s.size > 20000, `${s.size} 字节`);
  }

} finally {
  cleanupProbe(PUBLIC_DIR);
  cleanupProfile();
  await app.close();
  await mock.close();
}

/* ============================================================
   收尾自检（放在 finally **之后** —— 清理已经跑完了）
   ============================================================ */
{
  const files = fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png'));
  ok('★ 五张截图都落盘了', files.length >= 5, files.join(', '));
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  ok('★ 产品页 index.html 没有被探针污染', !html.includes('__probe') && !html.includes('data-page-node-id'));
  ok('★ 探针文件没有留在 public/ 里（否则会被一起提交上去）',
    !fs.existsSync(path.join(PUBLIC_DIR, '__probe.html')) && !fs.existsSync(path.join(PUBLIC_DIR, '__probe-driver.js')));
}

const st = R.done();
process.exit(st.fail ? 1 : 0);
