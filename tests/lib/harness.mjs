/* 测试脚手架
 *
 * ── 为什么要有 mock 上游 ────────────────────────────────────────
 * 不要依赖真实模型验证 agent loop。用 Node 起一个 OpenAI 兼容的假服务，
 * 手动构造流式 SSE 响应，就能覆盖全部路径 —— 而且**确定性**，
 * 真模型做不到这一点。
 *
 * ── 为什么必须同时实现 stream:true 和 stream:false ──────────────
 * 展示型文本走流式、结构化生成（出题）走非流式。
 * 漏掉任何一条，端到端时都会炸。
 *
 * ── ★ 最要紧的一条断言不是「函数返回了 ok」 ─────────────────────
 * 而是「服务端真的收到了凭据」。所以 mock 会把每个请求的
 * Authorization 头记下来，测试直接断言它。
 * 只断言返回值的话，即使凭据没发出去、只要 mock 不校验，测试照样绿。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const FAKE_KEY = 'sk-test-wenxue-0123456789abcdef';

/* ============================================================
   断言
   ============================================================ */
export function makeReporter(name) {
  const st = { name, pass: 0, fail: 0, failures: [] };
  const ok = (label, cond, detail) => {
    if (cond) { st.pass += 1; return true; }
    st.fail += 1;
    st.failures.push(`${label}${detail ? `\n      → ${detail}` : ''}`);
    return false;
  };
  const eq = (label, a, b) => ok(label, Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);
  const near = (label, a, b, eps = 1e-6) => ok(label, Math.abs(a - b) <= eps, `实际 ${a}，期望 ≈${b}`);
  const throws = (label, fn) => {
    try { fn(); return ok(label, false, '本该抛异常，但没有'); }
    catch { return ok(label, true); }
  };
  const done = () => {
    const line = st.fail ? '✗' : '✓';
    console.log(`${line} ${st.name} —— ${st.pass} 通过${st.fail ? `，${st.fail} 失败` : ''}`);
    for (const f of st.failures) console.log(`    ✗ ${f}`);
    return st;
  };
  return { ok, eq, near, throws, done, st };
}

/* ============================================================
   脚本条目：统一用 delta 数组描述，两种传输方式共用
   ============================================================ */
export function textDeltas(text, size = 6) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i += size) out.push({ content: s.slice(i, i + size) });
  if (!out.length) out.push({ content: '' });
  return { deltas: out };
}

/**
 * 分片 tool_calls —— 专门用来验「按 index 聚合、且是拼接不是覆盖」。
 * 每个参数 JSON 会被切成 3 段，拼错一个字符就会 JSON.parse 失败。
 */
export function toolDeltas(calls, finalText = '', shards = 3) {
  const deltas = [];
  calls.forEach((c, i) => {
    deltas.push({ tool_calls: [{ index: i, id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: '' } }] });
    const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {});
    const step = Math.max(1, Math.ceil(args.length / shards));
    for (let p = 0; p < args.length; p += step) {
      deltas.push({ tool_calls: [{ index: i, function: { arguments: args.slice(p, p + step) } }] });
    }
  });
  if (finalText) deltas.push(...textDeltas(finalText).deltas);
  return { deltas };
}

function aggregate(deltas) {
  let content = '';
  const calls = [];
  for (const d of deltas) {
    if (d.content) content += d.content;
    if (d.tool_calls) {
      for (const p of d.tool_calls) {
        const i = p.index != null ? p.index : calls.length;
        if (!calls[i]) calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (p.id) calls[i].id = p.id;
        if (p.function) {
          if (p.function.name) calls[i].function.name = p.function.name;
          if (p.function.arguments) calls[i].function.arguments += p.function.arguments;
        }
      }
    }
  }
  return { content, tool_calls: calls.filter(Boolean) };
}

/* ============================================================
   mock 上游
   ============================================================ */
/* 一份「真模型会吐出来的东西」的样本。
 *
 * ★ 顺序是刻意打乱的：**坏题放在前面**。
 *   如果好题都在前、坏题都在后，缓冲配额永远用不上 —— 凑够 3 道就 break 了。
 *   真模型也是随机穿插的，所以样本必须复现这一点，否则「缓冲」这条路径根本没被测到。 */
export const GOOD_QUESTIONS = {
  questions: [
    // ① 坏：证明题，判不了分
    { type: 'blank', stem: '请证明这个数列收敛，并写出完整证明过程。', answer: '无解' },
    // ② 好：选择题
    {
      type: 'choice',
      stem: '罗尔定理的三个条件中，去掉哪一个结论就可能不成立？',
      options: [
        { k: 'A', t: '闭区间上连续' },
        { k: 'B', t: '开区间内可导' },
        { k: 'C', t: '端点函数值相等' },
        { k: 'D', t: '以上任何一个去掉都可能不成立' },
      ],
      answer: 'D',
      explain: '三个条件缺一不可，各自都有反例。',
    },
    // ③ 坏：只有三个选项
    { type: 'choice', stem: '只有三个选项的题，应该被丢掉。', options: [{ k: 'A', t: 'x' }, { k: 'B', t: 'y' }, { k: 'C', t: 'z' }], answer: 'A' },
    // ④ 好：填空题（可判）
    { type: 'fill', stem: '计算 lim(x→0)(e^x−1−x)/x² 的值是多少？', answer: '1/2', explain: '泰勒展开到二阶。' },
    // ⑤ 好：填空题（可判）
    { type: 'fill', stem: '若 f(x)=x³ 在 [0,2] 上用拉格朗日中值定理，f′(ξ) 的值是多少？', answer: '4', explain: '3ξ²=4。' },
    // ⑥ 好：坏形状混进来之后仍然够数
    { type: 'fill', stem: '设 A 为 3 阶方阵且 |A|=2，则 |2A| 的值是多少？', answer: '16', explain: '|kA|=kⁿ|A|。' },
    // ⑦ 坏：根号答案
    { type: 'fill', stem: '求这个长度的值是多少？', answer: '\\sqrt{2}' },
  ],
};

export function defaultRoute(body) {
  const msgs = body.messages || [];
  const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
  const tools = body.tools || [];
  const hasToolResult = msgs.some((m) => m.role === 'tool' || (m.role === 'user' && /【工具结果/.test(String(m.content || ''))));

  if (/课堂调度器/.test(sys)) return textDeltas('{"next":"END"}');
  if (/考研数学出题老师/.test(sys)) return textDeltas(JSON.stringify(GOOD_QUESTIONS));

  if (tools.length && !hasToolResult) {
    return toolDeltas([{ name: 'look_up', args: { point: '罗尔定理' } }], '', 3);
  }

  if (/陈老师/.test(sys)) {
    // 老师：带教学动作标签，并以一个问句结尾（硬过滤和标签统计都靠它）
    return textDeltas('(focus)\n\n我先不往下讲。你把刚才那个条件用自己的话说一遍——如果去掉它，会怎么样？');
  }
  if (/是陈老师课上的一名学生/.test(sys)) {
    return textDeltas('你刚才说的我记下了，不过我这边有个地方对不上：那个条件到底什么时候才需要？');
  }
  return textDeltas('（mock 默认回复）');
}

export async function startMock(opts = {}) {
  const log = [];
  let queue = [];
  let mode = 'ok';
  let route = opts.route || null;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 保留 {} */ }

    log.push({
      path: req.url,
      auth: req.headers['authorization'] || null,
      contentType: req.headers['content-type'] || null,
      body,
    });

    const sendJson = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (mode === 'auth') return sendJson(401, { error: { message: 'Authentication Fails, Your api key is invalid' } });
    if (mode === 'billing') return sendJson(402, { error: { message: 'Insufficient Balance' } });
    if (mode === 'ratelimit') return sendJson(429, { error: { message: 'Rate limit reached' } });
    /* ★ 只拒绝**带 tools 的**请求 —— 这才像真网关：
     *   不支持工具的网关，不带 tools 时是能正常对话的。
     *   不加这个条件的话，降级之后的重试也会被拒，测不出「降级链」本身。 */
    if (mode === 'notools' && Array.isArray(body.tools) && body.tools.length) {
      return sendJson(400, { error: { message: 'Invalid parameter: tools is not supported by this model' } });
    }
    if (mode === 'notjson') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html>not an api</html>');
    }

    /* ★ route 可能是异步的（要模拟「每个角色都慢 400ms」那种场景）。
     *   不 await 的话，拿到的是个 Promise，`entry.deltas` 是 undefined，
     *   于是聚合出空正文 —— 表现是「所有角色都一言不发」，
     *   而报错指向的地方（断言学生发言数）离真正的原因很远。 */
    let entry = queue.shift();
    if (!entry && route) entry = await route(body);
    if (!entry) entry = defaultRoute(body);
    const { content, tool_calls } = aggregate(entry.deltas || []);

    if (body.stream === false) {
      return sendJson(200, {
        id: 'mock', object: 'chat.completion', model: body.model || 'mock',
        choices: [{
          index: 0,
          message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) },
          finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
        }],
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    for (const d of entry.deltas || []) {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool_calls.length ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    push: (entry) => { queue.push(entry); },
    setScript: (list) => { queue = list.slice(); },
    clearLog: () => { log.length = 0; },
    setMode: (m) => { mode = m; },
    setRoute: (r) => { route = r; },
    get pending() { return queue.length; },
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ============================================================
   应用服务（server.js）—— 真实进程，带真实凭据注入
   ============================================================ */
/* ★ 测试用的服务默认**不读项目里的 .env**。
 *   不隔离的话，本机 .env 里那把真 key 会（按 .env 优先的规则）
 *   顶掉测试传进去的假 key，于是「服务端真的收到了凭据」那条断言
 *   会拿着真 key 去比 —— 测试要么假绿要么假红，两头都不可信。 */
const NO_ENV_FILE = path.join(os.tmpdir(), 'wenxue-test-no-env-file');

/** 造一个临时 .env，用来测「.env 优先于环境变量」这条规则。 */
export function writeEnvFile(vars) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wenxue-env-')), '.env');
  fs.writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
  return file;
}

export async function startApp(env = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      WENXUE_ENV_FILE: NO_ENV_FILE,
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server.js 15s 没起来：\n${out}`);
    }
    await sleep(120);
  }
  return {
    port,
    url,
    output: () => out,
    close: () => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }),
  };
}

/* ============================================================
   工具
   ============================================================ */
export function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

export async function getFreePort() {
  const s = http.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function post(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 可能是 SSE */ }
  return { status: r.status, text, json, headers: r.headers };
}
