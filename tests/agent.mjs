/* Agent loop 端到端套件
 *
 * 打的是**真的链路**：
 *   浏览器侧 llm.js  →  server.js（持密钥）  →  mock 上游（OpenAI 兼容）
 *
 * ── ★ 本文件最要紧的一条断言 ────────────────────────────────────
 * 不是「函数返回了 ok」，而是 **mock 上游真的收到了 Authorization 头**。
 * 只断言返回值的话，即使凭据没发出去、只要 mock 不校验，测试照样绿 —— 那就白测了。
 *
 * ── 为什么不用真模型 ────────────────────────────────────────────
 * 真模型不可复现：分片怎么切、什么时候调工具、JSON 会不会畸形，每次都不同。
 * mock 能把这些都钉死，于是「分片拼接」「降级链」「清洗」这些路径才测得准。
 */

import { makeReporter, startMock, startApp, writeEnvFile, FAKE_KEY, textDeltas, toolDeltas, GOOD_QUESTIONS } from './lib/harness.mjs';
import * as llm from '../public/js/llm.js';
import { runAgent, generateQuestions, explainAnswer } from '../public/js/agent.js';
import { makeCtx } from '../public/js/tools.js';
import { answerIssue, parseNumeric } from '../public/js/judge.js';

const R = makeReporter('Agent loop · 端到端');
const { ok, eq } = R;

const mock = await startMock();
const app = await startApp({
  DEEPSEEK_API_KEY: FAKE_KEY,
  DEEPSEEK_BASE: mock.url,
  DEEPSEEK_MODEL: 'deepseek-chat',
});
llm.setEndpoint(`${app.url}/api/chat`);

const bearer = `Bearer ${FAKE_KEY}`;

try {
  /* ============================================================
     0. 健康检查：只说配没配，绝不说密钥是什么
     ============================================================ */
  {
    const h = await llm.health();
    eq('服务端报告已配密钥', h.hasKey, true);
    eq('健康检查回的是模型名', h.model, 'deepseek-chat');
    ok('★ 健康检查的响应体里不含密钥本身（连脱敏形式都不该有）', !JSON.stringify(h).includes(FAKE_KEY));
    ok('★ 健康检查的响应体里不含密钥的任何前缀', !JSON.stringify(h).includes(FAKE_KEY.slice(0, 12)));
    eq('没配 .env 时，密钥来源标成 environment', h.keySource, 'environment');
  }

  /* ============================================================
     0b. ★ .env 优先于环境变量
     ============================================================
     真踩过：本机 ~/.zshrc 里导出过一个旧 key，于是用户明明把新 key
     写进了 .env，服务端却全程在用旧的 —— 健康检查报「已配置」，
     每条消息却 401，而报错里只有上游那句「your api key: ****b605 is invalid」，
     看上去像是 key 本身失效了，查半天查不到「用错了哪一把」。 */
  {
    const staleKey = 'sk-stale-from-zshrc-0000000000';
    const envFile = writeEnvFile({
      DEEPSEEK_API_KEY: FAKE_KEY,
      DEEPSEEK_BASE: mock.url,
      DEEPSEEK_MODEL: 'deepseek-chat',
      /* ★ 故意在 .env 里写一个用不了的端口。
       *   如果连 PORT 也变成「.env 优先」，服务会去 listen(1) 然后起不来 ——
       *   下面那次健康检查会超时，这条正向用例就当场抓住了。
       *   非凭据类归环境变量，是常规做法，也是 `PORT=5199 node server.js` 能用的前提。 */
      PORT: '1',
    });
    const app3 = await startApp({
      WENXUE_ENV_FILE: envFile,
      DEEPSEEK_API_KEY: staleKey,          // 环境变量里还挂着一把旧的
      DEEPSEEK_BASE: mock.url,
    });
    const h = await (await fetch(`${app3.url}/api/health`)).json();

    eq('★ .env 里的 key 优先于环境变量', h.keySource, 'env-file');
    ok('★ 非凭据类的键（PORT）仍然以环境变量为准（能起来就说明没被 .env 的 PORT=1 顶掉）', !!h.ok);
    ok('★ 健康检查报出了被顶掉的那个变量名（「用错了哪把」才一眼可见）',
      Array.isArray(h.shadowedKeys) && h.shadowedKeys.includes('DEEPSEEK_API_KEY'),
      JSON.stringify(h.shadowedKeys));
    ok('★ 但健康检查里仍然不出现任何一把 key 的片段',
      !JSON.stringify(h).includes(FAKE_KEY.slice(0, 12)) && !JSON.stringify(h).includes(staleKey.slice(0, 12)));
    ok('★ 启动日志大声说明了遮蔽（不再静默用错 key）',
      /被 \.env 里的值顶掉了/.test(app3.output()), app3.output().slice(0, 240));

    mock.clearLog();
    llm.setEndpoint(`${app3.url}/api/chat`);
    await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    eq('★ 上游收到的确实是 .env 里那把，不是环境变量里那把旧 key', mock.log[0].auth, bearer);

    llm.setEndpoint(`${app.url}/api/chat`);
    await app3.close();
  }

  /* ============================================================
     1. ★ 分片 tool_calls：必须按 index 聚合，且是拼接不是覆盖
     ============================================================ */
  {
    mock.clearLog();
    mock.setScript([toolDeltas([{ name: 'look_up', args: { point: '罗尔定理' } }], '', 4)]);

    const out = await llm.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'look_up', parameters: { type: 'object' } } }],
    });

    eq('分片 tool_calls 被聚合成一个', out.toolCalls.length, 1);
    eq('工具名拼对了', out.toolCalls[0].name, 'look_up');
    let parsed = null;
    try { parsed = JSON.parse(out.toolCalls[0].rawArgs); } catch { /* 保持 null */ }
    ok('★ 分片参数拼成了完整 JSON（少一次 += 就会在这里炸）', parsed !== null, out.toolCalls[0].rawArgs);
    eq('参数内容正确', parsed && parsed.point, '罗尔定理');
  }

  /* ============================================================
     2. ★ 服务端真的收到了凭据
     ============================================================ */
  {
    const first = mock.log[0];
    ok('★ mock 上游确实收到了 Authorization 头', !!first.auth, JSON.stringify(first.auth));
    eq('★ Authorization 是 Bearer + 密钥', first.auth, bearer);
    eq('★ 请求打在正确的路径上', first.path, '/v1/chat/completions');
    ok('★ 服务端在请求体里带上了模型名', !!first.body.model);
  }

  /* ============================================================
     3. agent loop：工具结果要真的回灌给模型
     ============================================================ */
  {
    mock.clearLog();
    mock.setScript([]);                     // 走默认路由
    mock.setRoute(null);

    const ctx = makeCtx({ role: 'teacher', depth: 'teacher', session: { board: [] } });
    const out = await runAgent({
      role: 'teacher',
      system: '你叫陈老师，正在给一个考研的学生上课。',
      messages: [{ role: 'user', content: '讲一下罗尔定理' }],
      ctx,
      hooks: {},
    });

    ok('至少调了两轮', mock.log.length >= 2);
    eq('第一轮拿到了工具调用', out.toolCalls.length, 1);
    eq('工具调用名字对', out.toolCalls[0].name, 'look_up');

    const second = mock.log[1];
    const secondMsgs = second.body.messages || [];
    const toolMsg = secondMsgs.find((m) => m.role === 'tool');
    const asstMsg = secondMsgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
    ok('★ 工具结果以 role:tool 回灌给了模型（原生通道的正确形状）', !!toolMsg, JSON.stringify(secondMsgs.map((m) => m.role)));
    ok('★ assistant 那轮带上了 tool_calls（协议要求成对出现）', !!asstMsg);
    ok('★ 回灌的 tool_call_id 和 assistant 消息里的 id 对得上',
      !!asstMsg && !!toolMsg && toolMsg.tool_call_id === asstMsg.tool_calls[0].id,
      toolMsg ? `tool_call_id=${toolMsg.tool_call_id}` : '没有 tool 消息');
    /* ★ 这条断言同时证明了「分片拼接」是对的：
     *   参数拼坏 → findPoint 找不到 → 工具返回「没有找到考点」。 */
    ok('★ 工具真的按参数执行了（回灌内容里是罗尔定理的资料，不是报错）',
      !!toolMsg && toolMsg.content.includes('罗尔定理') && !toolMsg.content.includes('没有找到考点'),
      toolMsg && String(toolMsg.content).slice(0, 160));

    ok('★ 最终答案是最后一轮给的（不是中间某轮）', String(out.text).includes('如果去掉它'), String(out.text).slice(0, 80));
    ok('步数合理（至少两轮）', out.steps >= 2, `steps=${out.steps}`);
  }

  /* ============================================================
     4. ★ 降级链：网关不认原生 tools
     ============================================================ */
  {
    mock.clearLog();
    mock.setMode('notools');
    const ctx = makeCtx({ role: 'teacher', depth: 'teacher', session: { board: [] } });
    const out = await runAgent({
      role: 'teacher',
      system: '你叫陈老师。',
      messages: [{ role: 'user', content: '讲一下' }],
      ctx,
      hooks: {},
    });
    mock.setMode('ok');

    eq('★ 降级到文本工具协议', out.degraded, 'text-protocol');
    ok('★ 第一次请求带了 tools', Array.isArray(mock.log[0].body.tools) && mock.log[0].body.tools.length > 0);
    ok('★ 重试的请求去掉了 tools', !mock.log[1].body.tools || mock.log[1].body.tools.length === 0);
    ok('★ 重试时把工具协议说明写进了 system',
      /工具调用协议/.test(String((mock.log[1].body.messages[0] || {}).content || '')));
    ok('降级之后仍然拿到了回答', String(out.text).length > 0);
  }

  /* ============================================================
     5. 非流式分支（结构化生成走它）
     ============================================================ */
  {
    mock.clearLog();
    mock.setScript([textDeltas('{"ok":true}')]);
    const out = await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    eq('非流式分支能拿到正文', out.content, '{"ok":true}');
    eq('非流式分支没有工具调用', out.toolCalls.length, 0);
    eq('★ 非流式请求在体里声明了 stream:false', mock.log[0].body.stream, false);
  }

  /* ============================================================
     6. ★ AI 出题：模型给的东西必须过清洗
     ============================================================ */
  {
    mock.clearLog();
    mock.setScript([textDeltas(JSON.stringify(GOOD_QUESTIONS))]);
    const res = await generateQuestions({ pointId: 'rolle', count: 3, knownStems: [] });

    eq('★ 好题被留下（要 3 道就给 3 道）', res.created.length, 3);
    ok('★ 不可判的题被丢掉并计数', res.skippedUnjudgeable >= 1, `丢了几道：${res.skippedUnjudgeable}`);
    eq('不是解析失败', res.parseFailed, false);
    ok('★ 留下的每一道都判得了分', res.created.every((q) => answerIssue(q) === null));
    ok('★ 选择题的答案一定落在选项里', res.created.filter((q) => q.type === 'choice').every((q) => 'ABCD'.includes(String(q.answer).toUpperCase())));
    ok('★ 填空题的答案一定解析得出有限数', res.created.filter((q) => q.type === 'fill').every((q) => Number.isFinite(parseNumeric(q.answer))));
    ok('返回里说清了丢了几道（前端才能说人话）', /生成|丢/.test(res.note), res.note);
    ok('★ 出题请求走的是非流式', mock.log[0].body.stream === false);
    ok('★ 出题请求里写死了硬性边界（防线一）',
      /硬性要求/.test(String((mock.log[0].body.messages[0] || {}).content || '')));
    ok('出题请求里写死了禁止证明题',
      /禁止出证明题/.test(String((mock.log[0].body.messages[0] || {}).content || '')));
  }

  /* ============================================================
     7. 出题：模型吐的不是 JSON
     ============================================================ */
  {
    mock.setScript([textDeltas('抱歉，我不能生成这类题目。今天天气不错。')]);
    const res = await generateQuestions({ pointId: 'rolle', count: 3 });
    eq('★ 解析不了就明确报 parseFailed（而不是静默返回空数组）', res.parseFailed, true);
    eq('一道都没有', res.created.length, 0);
    ok('给用户的话说明了可以再试一次', /再点一次|再试/.test(res.note), res.note);
  }

  /* ============================================================
     8. 讲评失败要走降级，不要弹错误
     ============================================================ */
  {
    /* 先走通成功路径 —— 只测降级的话，「能讲评」这件事本身没人看着 */
    mock.clearLog();
    const good = await explainAnswer({ pointId: 'rolle', stem: '题干原文', userAnswer: 'A', standard: 'B', correct: false });
    eq('★ 讲评成功时返回 ok:true', good.ok, true);
    ok('讲评正文非空', String(good.text).length > 8, good.text);
    /* ★ 断言要看**发给上游的请求体**里确实带上了这两样，
     *   只看返回值的话，把答案漏传了也测不出来 —— 讲评会变成泛泛而谈。 */
    const lastUser = String((mock.log.at(-1).body.messages.find((m) => m.role === 'user') || {}).content || '');
    ok('★ 讲评请求里带上了他写的答案', lastUser.includes('A'), lastUser.slice(0, 200));
    ok('★ 讲评请求里带上了标准答案', lastUser.includes('B'), lastUser.slice(0, 200));
    ok('★ 讲评请求里带上了题干', lastUser.includes('题干原文'), lastUser.slice(0, 200));
    ok('★ 讲评提示词里写明了「只讲那一步，不要抄整道题」',
      /不要把整道题的完整解法抄一遍/.test(String((mock.log.at(-1).body.messages[0] || {}).content || '')));

    mock.setMode('billing');
    const out = await explainAnswer({
      pointId: 'rolle', stem: '题干', userAnswer: 'A', standard: 'B', correct: false,
    });
    mock.setMode('ok');
    eq('★ 讲评失败返回 ok:false（不抛异常）', out.ok, false);
    ok('★ 降级文案里把标准答案摊给了用户（那条路还在，功能是可用的）', out.text.includes('B'));
    ok('降级文案里说明了原因', out.text.includes('讲评没能生成'));
  }

  /* ============================================================
     9. 上游各类错误的文案要认得出是哪一种
     ============================================================ */
  {
    const cases = [
      ['auth', 'auth'],
      ['billing', 'billing'],
      ['ratelimit', 'ratelimit'],
    ];
    for (const [mode, kind] of cases) {
      mock.setMode(mode);
      let err = null;
      try { await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] }); }
      catch (e) { err = e; }
      mock.setMode('ok');
      ok(`上游 ${mode} 被归类成 ${kind}`, err && err.kind === kind, err ? err.kind : '没有抛异常');
      ok(`上游 ${mode} 的报错里有可操作的提示`, err && String(err.hint || '').length > 0);
    }

    // ★ 密钥不对时不能劝用户「检查余额」，两者处理方式完全不同
    mock.setMode('auth');
    let authErr = null;
    try { await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] }); } catch (e) { authErr = e; }
    mock.setMode('ok');
    ok('★ 401 的文案说的是密钥问题', /Key|密钥/.test(authErr.message + authErr.hint));
    ok('★ 401 的文案里不出现「余额」（两件事不能混成一句）', !/余额/.test(authErr.message + authErr.hint));

    // 服务端没配密钥
    const app2 = await startApp({ DEEPSEEK_API_KEY: '', DEEPSEEK_BASE: mock.url });
    llm.setEndpoint(`${app2.url}/api/chat`);
    let noKeyErr = null;
    try { await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] }); } catch (e) { noKeyErr = e; }
    await app2.close();
    llm.setEndpoint(`${app.url}/api/chat`);
    eq('★ 服务端没配密钥时归类成 nokey', noKeyErr && noKeyErr.kind, 'nokey');
    ok('nokey 的提示里给了怎么配', /\.env/.test(String(noKeyErr.hint)));
  }

  /* ============================================================
     10. 连不上本机服务时的报错要能落地
     ============================================================ */
  {
    llm.setEndpoint('http://127.0.0.1:1/api/chat');   // 几乎肯定没人听
    let e1 = null;
    try { await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] }); } catch (e) { e1 = e; }
    llm.setEndpoint(`${app.url}/api/chat`);
    eq('连不上本机服务归类成 local', e1 && e1.kind, 'local');
  }

  /* ============================================================
     11. 客户端断开要 abort 上游（否则用户关掉页面还在计费）
     ============================================================ */
  {
    mock.clearLog();
    const ac = new AbortController();
    const p = fetch(`${app.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
      signal: ac.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    await p;
    ok('★ 断开之后请求确实打到了上游（说明链路是通的）', mock.log.length >= 1);
  }
} finally {
  await app.close();
  await mock.close();
}

const st = R.done();
process.exit(st.fail ? 1 : 0);
