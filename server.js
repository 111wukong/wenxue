/* 问学 · 零依赖服务端
 *
 * 一个进程干两件事：
 *   /api/*   转发给 DeepSeek（**密钥只在这里出现，永不下发浏览器**）
 *   其它      托管 public/ 下的静态文件
 *
 * ── 为什么需要一个服务端，而不是纯前端直连 ──────────────────────
 * 纯前端也能调 DeepSeek，但那样 API Key 必须写在前端代码里 ——
 * 任何人打开 DevTools 就能拿走，然后拿你的额度去跑他自己的东西。
 * 所以密钥必须留在服务端：浏览器调本机的 /api/chat，
 * 服务端在请求头里补上 Authorization 再转发出去。
 *
 * ── 为什么零依赖 ────────────────────────────────────────────────
 * Node 18+ 自带 fetch，20+ 自带稳定的 SSE 流读取，
 * 所以「转发一个流式接口」这件事不需要任何 npm 包。
 * 代价是 .env 要自己解析（十几行），好处是 `node server.js` 就能跑，
 * 没有 node_modules、没有安装步骤、也不会有依赖漏洞。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ============================================================
   配置：自己解析 .env（不引 dotenv）
   ============================================================
   规则：
     · 忽略空行和 # 开头的注释
     · KEY=VALUE，KEY 两边的空白去掉
     · VALUE 两边的空白去掉，外层成对的引号也去掉
     · 空值不算「配了」——`DEEPSEEK_API_KEY=` 这一行会被忽略，
       这样用户复制 .env.example 之后不填也不会把环境变量顶成空串

   ── ★ 凭据类键：.env 优先于环境变量（这一条和多数实现相反，是刻意的）──
   真踩过：本机 ~/.zshrc 里导出过一个旧 key，于是用户明明把新 key 写进了
   .env，服务端却全程在用那个旧的 —— 健康检查报「已配置」，每条消息却
   401，而且报错里只有上游的「your api key: ****b605 is invalid」，
   看上去像是 key 本身失效了，查半天查不到「用错了哪一把」。

   所以规则分两类，**按「出错了会不会静默」来分**：

     凭据类（*_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD）
       → .env 为准。用错了不会报「配置冲突」，只会 401，最难查。
     其余（PORT / HOST / 超时 之类）
       → 环境变量为准（常规做法）。用错了是 EADDRINUSE 这种当场就炸的错，
         而且 `PORT=5199 node server.js` 这种临时覆盖很常用，不该被拦。

   想反过来（临时换 key 不改文件）就加 WENXUE_ENV_WINS=1。
   凭据类两边都有且不一样时，启动日志会**大声**说清楚，不再静默。
   ============================================================ */
const ENV_FILE = process.env.WENXUE_ENV_FILE || path.join(__dirname, '.env');
const FROM_ENV_FILE = new Set();
const SHADOWED = [];

/** 名字看起来是凭据的键。用错了会静默失败，所以要特殊对待。 */
const SECRETISH = /(_API_KEY|_APIKEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD)$/i;

/** 只给本机控制台看：首尾各留几个字符，中间打码。 */
function mask(v) {
  const s = String(v || '');
  if (s.length <= 10) return '***';
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const forceEnvWins = String(process.env.WENXUE_ENV_WINS || '') === '1';
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!val) continue;                       // 空值不算「配了」

    const ambient = process.env[key];
    const secret = SECRETISH.test(key);
    const fileWins = secret && !forceEnvWins;

    if (fileWins) {
      if (ambient !== undefined && ambient !== '' && ambient !== val) SHADOWED.push({ key, ambient });
      process.env[key] = val;
      FROM_ENV_FILE.add(key);
    } else if (ambient === undefined || ambient === '') {
      // 环境里没有 → 用文件里的兜底
      process.env[key] = val;
      FROM_ENV_FILE.add(key);
    }
  }
}
loadEnv();

const PORT = Number(process.env.PORT) || 5188;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const BASE = (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT) || 60000;

/* 密钥是从哪来的 —— 只回来源，不回内容。
 * 这条信息在「明明配了 key 却一直 401」时是最有用的一条。 */
const KEY_SOURCE = !API_KEY ? 'none'
  : FROM_ENV_FILE.has('DEEPSEEK_API_KEY') ? 'env-file' : 'environment';

/* ============================================================
   静态文件
   ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';

  /* ★ 路径穿越防护。`/../../etc/passwd` 这类请求如果直接拼进 fs.readFile，
   *   就能读到项目外的文件。resolve 之后必须确认结果仍在 PUBLIC_DIR 里。 */
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

/* ============================================================
   读请求体
   ============================================================ */
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ============================================================
   /api/health
   ============================================================
   前端用它判断「服务端配好密钥了没有」。
   ★ 只回「配没配」和「用的是哪个模型」，**绝不回密钥本身**，
     连脱敏形式都不回 —— 脱敏后的前几位仍然是有效信息（可用于撞库）。
   ============================================================ */
function handleHealth(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    hasKey: !!API_KEY,
    keyLooksValid: /^sk-[A-Za-z0-9_-]{16,}$/.test(API_KEY),
    /* ★ 只回**来源**，不回任何一位密钥字符。
     *   「用错了哪一把 key」和「key 本身失效了」是两件事，
     *   处理方式完全不同；只回一个 hasKey 的话，这两种情况长得一模一样。 */
    keySource: KEY_SOURCE,
    shadowedKeys: SHADOWED.map((s) => s.key),
    base: BASE,
    model: MODEL,
  }));
}

/* ============================================================
   /api/chat —— 转发给 DeepSeek
   ============================================================
   请求体：{ messages, tools?, stream?, temperature?, max_tokens? }
   响应：stream=true 时原样透传 SSE；否则回一个 JSON。

   ── 为什么原样透传 SSE 而不是自己重新组装 ──────────────────────
   上游的流式协议里 tool_calls 是**按 index 分片**下发的，
   arguments 会被切成好几段。如果在这里解析再重组，
   就等于把「分片聚合」这件事写了两遍（服务端一遍、前端一遍），
   两边逻辑一旦不一致，工具调用就会静默拼出坏 JSON。
   所以服务端只做「补密钥 + 转发 + 超时」，协议解析统一放在前端一处。
   ============================================================ */
async function handleChat(req, res) {
  if (!API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: '服务端没有配置 DeepSeek API Key',
      code: 'NO_KEY',
      hint: '在项目目录执行 cp .env.example .env，把 DEEPSEEK_API_KEY 填进去，然后重启服务。',
    }));
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
    return;
  }

  const wantStream = body.stream !== false;
  const payload = {
    model: body.model || MODEL,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: wantStream,
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  // ★ 只有显式给了非空数组才带 tools —— 空数组会被某些网关判成参数错误
  if (Array.isArray(body.tools) && body.tools.length) payload.tools = body.tools;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT);

  let upstream;
  try {
    upstream = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ★ 密钥只在这一行出现，且只在本进程内
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const timeout = e.name === 'AbortError';
    res.writeHead(timeout ? 504 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: timeout ? `上游 ${UPSTREAM_TIMEOUT}ms 没响应` : `连不上上游：${e.message}`,
      code: timeout ? 'TIMEOUT' : 'NETWORK',
      base: BASE,
    }));
    return;
  }

  /* 上游报错时**读出它的正文再转发**。
   * 直接透传状态码而不读 body 的话，前端只能看到一句「请求失败」——
   * 而 DeepSeek 的错误正文里通常写清了是余额不足、模型名错、还是参数不对。
   * 这是排查时最有价值的一条信息，不能丢。 */
  if (!upstream.ok) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => '');
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: `上游返回 ${upstream.status}`,
      code: upstream.status === 401 ? 'UPSTREAM_AUTH' : 'UPSTREAM_ERROR',
      detail: text.slice(0, 800),
    }));
    return;
  }

  if (!wantStream) {
    clearTimeout(timer);
    const text = await upstream.text();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // 告诉反代别缓冲，否则流式会变成一次性
  });

  /* ★ 客户端断开时要 abort 上游。
   *   不断的话，用户关掉页面之后上游还在生成、还在计费，
   *   而结果没有任何人接收。 */
  const onClose = () => ctl.abort();
  res.on('close', onClose);

  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // 中断（客户端走了 / 上游超时）不算异常，静默收尾即可
    if (e.name !== 'AbortError') {
      res.write(`data: ${JSON.stringify({ __proxyError: String(e.message || e) })}\n\n`);
    }
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
    res.end();
  }
}

/* ============================================================
   路由
   ============================================================ */
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/api/health') return handleHealth(res);
  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '只接受 POST' }));
    }
    return handleChat(req, res);
  }
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '接口不存在' }));
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const keyState = !API_KEY ? '未配置（页面会提示怎么配）'
    : /^sk-[A-Za-z0-9_-]{16,}$/.test(API_KEY) ? `已配置（来自${KEY_SOURCE === 'env-file' ? '.env' : '环境变量'}）`
      : '已配置但格式可疑';
  console.log(`问学已启动 · http://${HOST}:${PORT}`);
  console.log(`上游 ${BASE} · 模型 ${MODEL}`);
  console.log(`API Key：${keyState}`);

  /* ★ 两边都有且不一样时必须大声说。
   *   静默地用了另一把 key，是这个项目里最难查的一类问题：
   *   健康检查说「已配置」，每条消息却 401，而报错里只有上游的
   *   「your api key: ****b605 is invalid」，看上去像 key 本身失效了。 */
  for (const s of SHADOWED) {
    console.log(`⚠️  环境变量里的 ${s.key}（${mask(s.ambient)}）被 .env 里的值顶掉了。`);
    console.log(`    当前用的是 .env 里的那一把。想用环境变量那把，就加 WENXUE_ENV_WINS=1 再启动。`);
  }
  if (SHADOWED.length) console.log(`    来源文件：${ENV_FILE}`);

  if (!API_KEY) {
    console.log('→ 执行 cp .env.example .env，填入 DEEPSEEK_API_KEY，然后重启。');
  }
});

export { server };
