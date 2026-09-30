/* 零依赖无头浏览器
 *
 * ── 为什么能用 ──────────────────────────────────────────────────
 * 之前在这台机器上试 Chrome 主程序跑不起来（进程被外层 SIGTERM 掉）。
 * 但 Playwright 缓存里那个 **chrome-headless-shell** 是另一个二进制，
 * 它在这个环境里能正常出图。
 *
 * ── 为什么用 --screenshot / --dump-dom 而不是 CDP ───────────────
 * CDP 的页面级 WebSocket 在这里会被拦（握手后立刻 1006）。
 * 而 chrome-headless-shell 自带的这两个开关不需要 WebSocket：
 *   --screenshot=path   跑完把图存下来
 *   --dump-dom          跑完把 DOM 序列化到 stdout
 * 配合 --virtual-time-budget 让页面自己跑一段，够用了。
 *
 * ── 一个必须记住的坑 ────────────────────────────────────────────
 * --virtual-time-budget 会**加速 setTimeout**。如果你的等待逻辑是
 * `for (i<400) await sleep(50)`，那 400 次循环只花掉 20 秒的**虚拟时间**，
 * 一眨眼就跑完了，页面其实还没渲染。
 * 所以轮询里每一步都要**让出一帧**（await rAF），虚拟时钟才会推进到真实进度。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

export function findShell() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return null;
}

function runShell(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经死了 */ }
      finish(-1);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e.message); finish(-2); });
    child.on('exit', (c) => finish(c));
  });
}

/* 单例 user-data-dir：多张截图共用一次登录态 / localStorage，
 * 每次新开一个临时目录的话，用户档案会被反复清空。 */
let SHARED_PROFILE = null;
function profileDir() {
  if (!SHARED_PROFILE) {
    SHARED_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-chrome-'));
  }
  return SHARED_PROFILE;
}

/**
 * 打开一个 URL，跑够时间，把 DOM 序列化出来。
 * @returns {Promise<{ok:boolean, dom:string, stderr:string, reason?:string}>}
 */
/* ★ 必须强制「减少动态效果」，否则**截图里的内容是看不见的**。
 *
 *   入场动画（曲线描线、步骤逐条落下）是 CSS 动画。
 *   虚拟时间只推进定时器，CSS 动画停在第一帧 ——
 *   于是曲线还是 stroke-dashoffset:1（整条不可见）、步骤还是 opacity:0。
 *   截出来一片空白，看着像「没渲染」。
 *
 *   开了这个开关，CSS 里的 prefers-reduced-motion 分支生效：动画关掉，
 *   且**同时**把 stroke-dasharray 清掉，内容直接可见。
 *   （app.js 的打字机也会因为 matchMedia 命中而直接落文本，
 *     顺带把探针等待从「每个角色 1.5 秒」降到 0。） */
function commonArgs(width, height, budget) {
  return [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--force-prefers-reduced-motion',
    `--user-data-dir=${profileDir()}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${budget}`,
  ];
}

export async function dumpDom(bin, url, opts = {}) {
  const budget = opts.budget || 25000;
  const width = opts.width || 1680;
  const height = opts.height || 1050;
  const args = [...commonArgs(width, height, budget), '--dump-dom', url];
  const r = await runShell(bin, args, opts.timeout || 60000);
  return { ok: r.code === 0 && r.out.length > 0, dom: r.out, stderr: r.err, code: r.code };
}

/** 打开一个 URL，跑够时间，存一张图。 */
export async function screenshot(bin, url, file, opts = {}) {
  const budget = opts.budget || 25000;
  const width = opts.width || 1680;
  const height = opts.height || 1050;
  const args = [...commonArgs(width, height, budget), `--screenshot=${file}`, url];
  const r = await runShell(bin, args, opts.timeout || 60000);
  const exists = fs.existsSync(file) && fs.statSync(file).size > 1000;
  return { ok: r.code === 0 && exists, size: exists ? fs.statSync(file).size : 0, stderr: r.err, code: r.code };
}

export function cleanupProfile() {
  if (SHARED_PROFILE) {
    try { fs.rmSync(SHARED_PROFILE, { recursive: true, force: true }); } catch { /* 算了 */ }
    SHARED_PROFILE = null;
  }
}

/* ============================================================
   DOM 解析（够用的子集，不引 jsdom）
   ============================================================ */

/** 把标签剥掉，只留文字。断言用 textContent，不用 innerText ——
 *  innerText 依赖布局，--dump-dom 不触发布局，会只拿到一部分。 */
export function textOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取出某个 id 的元素内容（到下一个同级开始标签为止，够用）。 */
export function sectionById(html, id) {
  const re = new RegExp(`id="${id}"[^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return '';
  // 粗略地配平 div
  let i = m.index + m[0].length;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = i;
  let t;
  while ((t = tagRe.exec(html))) {
    if (t[0][1] === '/') depth -= 1; else depth += 1;
    if (depth === 0) return html.slice(i, t.index);
  }
  return html.slice(i);
}

/** 某个 class 出现了几次。 */
export function countClass(html, cls) {
  return (String(html).match(new RegExp(`class="[^"]*\\b${cls}\\b`, 'g')) || []).length;
}
