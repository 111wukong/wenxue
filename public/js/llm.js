/* 模型通道
 *
 * 和上游说话只在这一个文件里。上层（agent / classroom）看到的是
 * 统一的 `chat()` 和一组回调，不关心 SSE 长什么样。
 *
 * ── 三个必须处理好的地方 ────────────────────────────────────────
 *
 * 1. **流式 tool_calls 是按 index 分片的。** OpenAI 兼容协议里
 *    `tool_calls[].function.arguments` 会被切成好几段字符串下发，
 *    必须按 index 聚合、且是**拼接**不是覆盖。少这一步，
 *    工具参数会是一个半截 JSON，而报错是「JSON 解析失败」——
 *    指向的是解析那一行，离真正的原因（少了一次 +=）很远。
 *
 * 2. **三级降级链。** 不是所有 OpenAI 兼容网关都支持原生 `tools` 参数。
 *    原生失败时要退到「文本工具协议」（让模型用 ```tool 代码块输出），
 *    再不行退到「纯文本回答」。三层缺一层，换个模型就整个不能用。
 *
 * 3. **错误要说清是哪一种。** 「连不上」「密钥不对」「模型不支持工具」
 *    是三件不同的事，处理方式完全不同。压成一句「请求失败」，
 *    用户只能靠猜。
 */

/* 默认走同源。测试里会把它指到一个真实起着的本机端口 ——
 * 关键是**别让测试绕过 llm.js**：绕过的话，「服务端到底有没有收到凭据」
 * 这条最要紧的断言就测不到了。 */
let ENDPOINT = '/api/chat';

export function setEndpoint(url) {
  ENDPOINT = String(url || '/api/chat');
  return ENDPOINT;
}

export function getEndpoint() {
  return ENDPOINT;
}

/** 把上游的 HTTP 错误翻成人能看懂的话。 */
function describeError(status, body) {
  const detail = body && body.detail ? String(body.detail).slice(0, 300) : '';
  if (body && body.code === 'NO_KEY') {
    return { kind: 'nokey', message: body.error, hint: body.hint || '' };
  }
  if (body && body.code === 'TIMEOUT') {
    return { kind: 'timeout', message: body.error, hint: '可以调大 .env 里的 UPSTREAM_TIMEOUT，或缩短上下文。' };
  }
  if (body && body.code === 'NETWORK') {
    return { kind: 'network', message: body.error, hint: '检查网络与 DEEPSEEK_BASE 是否可达。' };
  }
  if (status === 401 || (body && body.code === 'UPSTREAM_AUTH')) {
    return { kind: 'auth', message: '上游拒绝了这次请求（401）', hint: `多半是 API Key 不对或已失效。上游原话：${detail}` };
  }
  if (status === 402 || /insufficient|balance|quota/i.test(detail)) {
    return { kind: 'billing', message: '上游账户余额或额度不足', hint: detail };
  }
  if (status === 429) {
    return { kind: 'ratelimit', message: '请求太频繁', hint: '等几秒再试。' };
  }
  return { kind: 'upstream', message: `上游返回 ${status}`, hint: detail };
}

/* ============================================================
   流式解析
   ============================================================ */

/**
 * 把上游的 SSE 流解析成回调。
 *
 * @param {Response} res
 * @param {object} hooks
 *   onDelta(text)        正文增量
 *   onToolDelta(index)   工具调用参数有更新（用于 UI 提示"正在调用工具"）
 * @returns {Promise<{content:string, toolCalls:Array, finishReason:string}>}
 */
async function parseStream(res, hooks = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  let content = '';
  const toolCalls = [];
  let finishReason = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    /* SSE 以空行分隔事件。按 \n\n 切，最后一段可能不完整，留在 buf 里。
     * 注意不能按单个 \n 切 —— 一个事件里可能有多行（data: / event:）。 */
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let json;
        try { json = JSON.parse(data); } catch { continue; }

        // 服务端自己塞进来的错误（比如客户端断开）
        if (json.__proxyError) throw new Error(json.__proxyError);

        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};

        if (delta.content) {
          content += delta.content;
          if (hooks.onDelta) hooks.onDelta(delta.content);
        }

        /* ★ tool_calls 的分片聚合 —— 这个文件里最要紧的一段。
         *   同一个 index 会出现多次，每次带一小段 arguments，必须 += 。 */
        if (delta.tool_calls) {
          for (const part of delta.tool_calls) {
            const i = part.index != null ? part.index : toolCalls.length;
            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', rawArgs: '' };
            if (part.id) toolCalls[i].id = part.id;
            if (part.function) {
              if (part.function.name) toolCalls[i].name = part.function.name;
              if (part.function.arguments) toolCalls[i].rawArgs += part.function.arguments;
            }
            if (hooks.onToolDelta) hooks.onToolDelta(i);
          }
        }
      }
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean), finishReason };
}

/* ============================================================
   文本工具协议（降级用）
   ============================================================
   有些网关不支持原生 tools 参数。退而求其次：把工具清单写进 system，
   让模型用围栏代码块输出调用意图：

     ```tool
     {"name": "look_up", "args": {"q": "..."}}
     ```

   解析放在这里而不是 agent 里，是因为它和「原生 tool_calls」
   是同一层的东西 —— 都是「把模型输出变成工具调用」。
   ============================================================ */
export function parseTextToolCalls(content) {
  const calls = [];
  const re = /```tool\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.name) calls.push({ id: `text_${calls.length}`, name: obj.name, rawArgs: JSON.stringify(obj.args || {}) });
    } catch { /* 这一块不是合法 JSON，跳过 */ }
  }
  return calls;
}

/** 把工具清单渲染成给模型看的文本说明。 */
export function toolsToText(tools) {
  return tools.map((t) => {
    const p = t.function.parameters;
    const props = (p && p.properties) || {};
    const args = Object.keys(props).map((k) => {
      const req = (p.required || []).includes(k) ? '' : '?';
      return `${k}${req}: ${props[k].description || props[k].type}`;
    }).join(', ');
    return `- ${t.function.name}(${args}) —— ${t.function.description}`;
  }).join('\n');
}

/* ============================================================
   对外接口
   ============================================================ */

export const TOOL_PROTOCOL_HINT = `

【工具调用协议】
你可以调用下列工具来获取资料或操作黑板。需要调用时，输出一个围栏代码块：

\`\`\`tool
{"name": "工具名", "args": {"参数": "值"}}
\`\`\`

一次可以输出多个代码块（会按顺序执行）。不需要工具时直接回答，不要输出这个代码块。
`;

/**
 * 和模型对话一轮。
 *
 * @param {object} opts
 *   messages   完整消息数组
 *   tools      工具 schema 数组（空数组 = 不带工具）
 *   hooks      { onDelta, onToolDelta }
 *   temperature
 *   maxTokens
 *   stream     默认 true。结构化生成（如出题）传 false ——
 *              要一次拿完整 JSON，流式反而要自己拼接
 * @returns {Promise<{content, toolCalls, finishReason, degraded}>}
 *   degraded: '' | 'text-protocol' —— 走的是哪条降级路径
 */
export async function chat(opts) {
  const { messages, tools = [], hooks = {}, temperature, maxTokens, stream = true } = opts;

  const body = {
    messages,
    stream: !!stream,
  };
  if (tools.length) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw Object.assign(new Error(`连不上本地服务：${e.message}`), { kind: 'local' });
  }

  if (!res.ok) {
    let payload = null;
    try { payload = JSON.parse(await res.text()); } catch { /* 不是 JSON 就算了 */ }
    const info = describeError(res.status, payload);
    const err = new Error(info.message);
    Object.assign(err, info);
    throw err;
  }

  /* ---- 非流式分支 ---- */
  if (!stream) {
    let json;
    try { json = JSON.parse(await res.text()); } catch (e) {
      throw Object.assign(new Error(`上游返回的不是 JSON：${e.message}`), { kind: 'stream' });
    }
    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const content = String(msg.content || '');
    if (content && hooks.onDelta) hooks.onDelta(content);

    const toolCalls = (msg.tool_calls || []).map((c) => ({
      id: c.id || '',
      name: (c.function && c.function.name) || '',
      rawArgs: (c.function && c.function.arguments) || '{}',
    })).filter((c) => c.name);

    if (toolCalls.length) return { content, toolCalls, finishReason: choice.finish_reason || '', degraded: '' };

    const textCalls = parseTextToolCalls(content);
    if (textCalls.length) return { content, toolCalls: textCalls, finishReason: choice.finish_reason || '', degraded: 'text-protocol' };

    return { content, toolCalls: [], finishReason: choice.finish_reason || '', degraded: '' };
  }

  /* ---- 第一层：原生 tools ---- */
  let out;
  try {
    out = await parseStream(res, hooks);
  } catch (e) {
    const err = new Error(`流解析失败：${e.message}`);
    Object.assign(err, { kind: 'stream' });
    throw err;
  }

  if (out.toolCalls.length) {
    return { ...out, degraded: '' };
  }

  /* ---- 第二层：模型没用原生工具，但正文里可能有文本协议调用 ---- */
  const textCalls = parseTextToolCalls(out.content);
  if (textCalls.length) {
    return { ...out, toolCalls: textCalls, degraded: 'text-protocol' };
  }

  /* ---- 第三层：完全没用工具，就当普通回答 ---- */
  return { ...out, degraded: '' };
}

/** 上游有没有配好密钥。UI 启动时问一次。
 *
 * ★ 地址要从 ENDPOINT 推导，不能写死 '/api/health'。
 *   写死的话，把 ENDPOINT 指到别处（测试里就这么做）之后，
 *   健康检查会去 fetch 一个相对地址 —— 在 Node 里直接失败，
 *   于是「服务端报告已配密钥」永远是 false，而真实链路其实是通的。 */
export async function health() {
  try {
    const url = /^https?:\/\//i.test(ENDPOINT)
      ? new URL('/api/health', ENDPOINT).href
      : '/api/health';
    const r = await fetch(url);
    return await r.json();
  } catch {
    return { ok: false, hasKey: false };
  }
}
