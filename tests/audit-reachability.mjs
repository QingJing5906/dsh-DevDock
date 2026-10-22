/**
 * Reachability audit: which Host routes can the browser actually reach?
 *
 * A route that exists on the Host but is never called by the client is dead
 * weight — the feature was built and never wired, which reads to the user as
 * "the tab cannot do X". This script compares both sides and FAILS when the
 * gap grows, so a future change cannot quietly add an unreachable feature.
 *
 * Three routes are allowed to stay Host-only and are listed here by hand:
 *   GET /push/memory  — diagnostic; the panel reads the same data through
 *                       `/push/targets`, and the full list is for debugging.
 *   GET /tools        — a false positive of the literal scan: the client never
 *                       calls it; it is the Host's own tool route table entry.
 *   GET /diagnostics  — answers "why can't the agent call this plugin?" for an
 *                       operator or an agent, not for the panel; there is
 *                       nothing in it a panel would render.
 *
 * Run: node tests/audit-reachability.mjs
 */
import { readFileSync } from 'node:fs';

/** Routes that are deliberately not consumer-facing. */
const ALLOWED_HOST_ONLY = new Set(['/push/memory', '/tools', '/diagnostics']);

const client = readFileSync('client.js', 'utf8');
const host = readFileSync('src/host/index.js', 'utf8');

/**
 * Every path the Host registers.
 *
 * The pattern is anchored to the route-table helpers (`get(...)` / `post(...)`
 * used inside `buildRoutes`) rather than any `x.get('name')` in the file —
 * otherwise a service lookup such as `ctx.get('tools')` is mistaken for a
 * route and shows up as a permanently unreachable one.
 */
const hostRoutes = new Map();
for (const m of host.matchAll(/(?:^|[\s;{(])(get|post)\(\s*'([^']+)'\s*,/g)) {
  const method = m[1].toUpperCase();
  const path = m[2];
  if (!path.startsWith('/')) continue;
  if (!hostRoutes.has(path)) hostRoutes.set(path, []);
  hostRoutes.get(path).push(method);
}

/**
 * Every API path the client mentions. Matches the string literals the client
 * passes to `api(...)`; paths appear both as `'/local/push'` and concatenated
 * like `API + '/local/status?path='`, so a plain literal scan is right.
 */
const clientPaths = new Set();
for (const m of client.matchAll(/'(\/[a-z][a-zA-Z0-9/_?=&.-]*)'/g)) {
  const raw = m[1].split('?')[0];
  // `review` belongs in this list: omitting it once made four live review
  // routes look unreachable, which is exactly the false signal this gate must
  // not produce.
  if (/^\/(local|repos|push|review|npm|accounts|state|settings|contributions|notifications|releases)\b/.test(raw)) {
    clientPaths.add(raw);
  }
}

const reachable = [...hostRoutes.keys()].filter((p) => clientPaths.has(p));
const unreachable = [...hostRoutes.keys()].filter((p) => !clientPaths.has(p)).sort();
const phantom = [...clientPaths].filter((p) => !hostRoutes.has(p)).sort();

console.log(`Host routes:      ${hostRoutes.size}`);
console.log(`Client paths:     ${clientPaths.size}`);
console.log(`Reachable:        ${reachable.length}`);
console.log(`Host-only (dead): ${unreachable.length}`);
console.log(`Client-only (bug):${phantom.length}`);

if (unreachable.length) {
  console.log('\n=== Host routes NO UI can reach ===');
  for (const p of unreachable) console.log(` ${String(hostRoutes.get(p)).padEnd(14)} ${p}`);
}
if (phantom.length) {
  console.log('\n=== Client calls with NO Host route ===');
  for (const p of phantom) console.log(` ${p}`);
}

/* ---- second axis: does the git tab expose the operation at all? ---- */
const tabFeatures = {
  '创建/关联远端': /local\/remote|关联远端|添加远端/,
  '推送': /'\/local\/push'/,
  '拉取': /'\/local\/pull'/,
  '抓取': /'\/local\/fetch'/,
  '提交': /'\/local\/commit'/,
  '分支切换/新建': /'\/local\/branch'|'\/local\/checkout'/,
  '删除分支': /'\/local\/branch\/delete'/,
  '合并': /'\/local\/merge'/,
  '撤回 reset': /'\/local\/reset'/,
  '反向提交 revert': /'\/local\/revert/,
  '打标签 tag': /'\/local\/tag'/,
  '暂存 stash': /'\/local\/stash'/,
  '恢复暂存': /'\/local\/stash\/pop'/,
  '丢弃改动 restore': /'\/local\/restore'/,
  '清空工作区': /'\/local\/discard-all'/,
  '初始化仓库': /'\/local\/init'/,
};
console.log('\n=== git tab: is the operation wired? ===');
const unwired = [];
for (const [label, re] of Object.entries(tabFeatures)) {
  const ok = re.test(client);
  if (!ok) unwired.push(label);
  console.log(` ${ok ? 'yes' : 'NO '}  ${label}`);
}

/* ---- verdict: this is a gate, not a report ---- */
const unexpectedDead = unreachable.filter((p) => !ALLOWED_HOST_ONLY.has(p));
const problems = [];
if (unexpectedDead.length > 0) problems.push(`${unexpectedDead.length} unreachable host route(s): ${unexpectedDead.join(', ')}`);
if (phantom.length > 0) problems.push(`${phantom.length} client call(s) with no host route: ${phantom.join(', ')}`);
if (unwired.length > 0) problems.push(`${unwired.length} git operation(s) not wired: ${unwired.join(', ')}`);

if (problems.length === 0) {
  console.log('\nOK: every host route is either reachable, explicitly diagnostic, or accounted for.');
  process.exit(0);
}
console.log('\nFAIL:');
for (const p of problems) console.log(` - ${p}`);
process.exit(1);
