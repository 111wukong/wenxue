/* 跑全部套件
 *
 * 每个套件是一个独立进程 —— 一个炸了不影响其它的，而且退出码能分别拿到。
 * ★ 不要用 `node unit.mjs | tail` 这种写法：管道会把退出码换成 tail 的 0，
 *   失败了也照样往下跑，看着像全绿。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 浏览器套件排在最后：它最慢（要开五次无头浏览器），
 * 而且找不到内核时会**明确跳过**（退出码 0 + 一行说明），
 * 不会让前面三个快套件的结果被埋掉。 */
const SUITES = ['unit.mjs', 'agent.mjs', 'classroom.mjs', 'browser.mjs'];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code || 0));
  });
}

const results = [];
const t0 = Date.now();
for (const f of SUITES) {
  const code = await run(f);
  results.push({ f, code });
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const failed = results.filter((r) => r.code !== 0);

console.log('');
console.log('─'.repeat(58));
for (const r of results) {
  console.log(`${r.code === 0 ? '✓' : '✗'}  ${r.f.padEnd(16)} 退出码 ${r.code}`);
}
console.log(`  ${results.length} 个套件 · 用时 ${secs}s`);
console.log('─'.repeat(58));

process.exit(failed.length ? 1 : 0);
