/* 真机联通性检查（不是测试套件的一部分，手动跑）
 *
 * 目的只有一个：确认这套东西接**真的 DeepSeek** 也跑得通 ——
 * mock 测的是逻辑，真机测的是「协议没理解错」。
 *
 * 用法：node scripts/smoke-real.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ★ 显式把 .env 里那把 key 传给子进程。
 *   不传的话，本机 shell 里可能导出着另一把旧 key ——
 *   而这个脚本要回答的问题是「**用户填在 .env 里的这把**能不能用」，
 *   不是「这台机器上随便哪把能不能用」。 */
function keyFromDotEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return null;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    if (t.slice(0, i).trim() === 'DEEPSEEK_API_KEY') return t.slice(i + 1).trim();
  }
  return null;
}

const dotKey = keyFromDotEnv();
if (!dotKey) { console.log('没有找到 .env 里的 DEEPSEEK_API_KEY，先 cp .env.example .env 填上。'); process.exit(1); }
const ambient = (process.env.DEEPSEEK_API_KEY || '').trim();
if (ambient && ambient !== dotKey) {
  console.log('注意：shell 里还导出着另一把 DEEPSEEK_API_KEY，本脚本只测 .env 里那把。');
}

const port = await freePort();
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, DEEPSEEK_API_KEY: dotKey, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(String(d)));
child.stderr.on('data', (d) => process.stderr.write(String(d)));

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 150));
}

const health = await (await fetch(`${base}/api/health`)).json();
console.log('健康检查：', JSON.stringify(health));

// 静态资源全部要能取到（模块图解析不了的话页面就是白屏）
const assets = [
  '/', '/css/base.css', '/css/components.css', '/css/board.css',
  '/js/app.js', '/js/llm.js', '/js/tools.js', '/js/agent.js',
  '/js/classroom.js', '/js/curriculum.js', '/js/judge.js', '/js/store.js', '/js/latex.js',
];
let bad = 0;
for (const a of assets) {
  const r = await fetch(base + a);
  if (!r.ok) { bad++; console.log(`  ✗ ${a} → ${r.status}`); }
}
console.log(`静态资源：${assets.length - bad}/${assets.length} 可访问`);

// ★ 前端代码里绝不能出现密钥
const appJs = await (await fetch(`${base}/js/app.js`)).text();
const html = await (await fetch(`${base}/`)).text();
console.log('前端是否泄漏密钥：', /sk-[a-zA-Z0-9]{16,}/.test(appJs + html) ? '★ 泄漏了！' : '没有');

// 真机对话
console.log('\n—— 真机对话（流式）——');
const t0 = Date.now();
const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: '你是考研数学老师。回答控制在 40 字以内。' },
      { role: 'user', content: '用一句话说清罗尔定理最容易漏掉的那个条件。' },
    ],
    stream: true,
  }),
});
console.log('HTTP', res.status, res.headers.get('content-type'));
if (!res.ok) {
  // 上游报错时服务端会把它的**正文**转发出来 —— 排查时最有价值的就是这一段
  console.log('上游原话：', (await res.text()).slice(0, 500));
  console.log('\n★ 这一把 key 用不了。检查 .env 里的 DEEPSEEK_API_KEY。');
  child.kill('SIGKILL');
  process.exit(1);
}
let text = '';
const reader = res.body.getReader();
const dec = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of dec.decode(value, { stream: true }).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (c) { text += c; process.stdout.write(c); }
    } catch { /* 忽略 */ }
  }
}
console.log(`\n用时 ${Date.now() - t0}ms，共 ${text.length} 字`);

// 真机工具调用
console.log('\n—— 真机工具调用 ——');
const res2 = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: '罗尔定理有哪些前提条件？先查资料再回答。' }],
    stream: true,
    tools: [{
      type: 'function',
      function: {
        name: 'look_up',
        description: '查一个考点的资料',
        parameters: { type: 'object', properties: { point: { type: 'string', description: '考点名' } }, required: ['point'] },
      },
    }],
  }),
});
let raw2 = '';
const rd2 = res2.body.getReader();
for (;;) {
  const { done, value } = await rd2.read();
  if (done) break;
  raw2 += dec.decode(value, { stream: true });
}
const calls = [];
for (const line of raw2.split('\n')) {
  if (!line.startsWith('data:')) continue;
  const d = line.slice(5).trim();
  if (!d || d === '[DONE]') continue;
  try {
    const j = JSON.parse(d);
    const tc = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.tool_calls;
    if (tc) for (const p of tc) calls.push(p);
  } catch { /* 忽略 */ }
}
console.log(`收到 ${calls.length} 个 tool_calls 分片`);
const byIdx = {};
for (const p of calls) {
  const i = p.index != null ? p.index : 0;
  byIdx[i] = byIdx[i] || { name: '', args: '' };
  if (p.function && p.function.name) byIdx[i].name = p.function.name;
  if (p.function && p.function.arguments) byIdx[i].args += p.function.arguments;
}
for (const [i, c] of Object.entries(byIdx)) {
  let parsed = null;
  try { parsed = JSON.parse(c.args); } catch { /* 保持 null */ }
  console.log(`  #${i} ${c.name}(${c.args}) → ${parsed ? 'JSON 完整' : '★ JSON 拼不完整'}`);
}

child.kill('SIGKILL');
console.log('\n完成。');
process.exit(0);
