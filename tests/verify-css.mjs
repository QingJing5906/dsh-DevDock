/**
 * 样式表结构检查。
 *
 * 这一次的教训：新增规则时把代码插进了已有一条规则的声明中间，于是它变成
 * 了嵌套选择器，既匹配不到元素，原规则的值也照旧生效——表现就是「改了没
 * 反应」。语法检查（node --check）抓不到这种问题，因为它只是模板字符串里
 * 的普通文本。
 *
 * Run: node tests/verify-css.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
if (open < 0) {
  console.error('CSS block not found');
  process.exit(1);
}
const bodyStart = open + 'const CSS = `'.length;
const bodyEnd = src.indexOf('`;', bodyStart);
if (bodyEnd < 0) {
  console.error('CSS block end not found');
  process.exit(1);
}
const css = src.slice(bodyStart, bodyEnd);

/* ---- 1. 大括号必须配平，且不能出现负深度 ---- */
{
  let depth = 0;
  let negative = false;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth < 0) negative = true;
  }
  check('大括号配平', depth === 0, `final depth ${depth}`);
  check('不出现负深度', !negative);
}

/* ---- 2. 不允许任何嵌套规则 ----
 * 本样式表是扁平的：每条选择器后面直接跟 `{`，闭合 `}` 之后要么换行要么结束。
 * 一旦某条规则被插进另一条里，就会出现「一行以内既没有 { 也没有 }」的
 * 声明行夹杂在选择器之前的情况——这里按「选择器前面必须没有未闭合的块」检查。
 */
{
  const lines = css.split('\n');
  let depth = 0;
  const offenders = [];
  let inBlock = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('/*') || line.startsWith('*') || line.startsWith('@')) {
      // 注释内部不判断
      continue;
    }
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;

    // 在块内部却出现了以 `.` 或 `#` 开头的选择器 => 嵌套
    if (depth > 0 && /^[.#][\w-]/.test(line)) {
      offenders.push({ line: i + 1, text: line.slice(0, 80) });
    }

    depth += opens - closes;
    inBlock = depth > 0;
  }
  check('没有嵌套的选择器', offenders.length === 0,
    offenders.slice(0, 3).map((o) => `第 ${o.line} 行: ${o.text}`).join(' | '));
}

/* ---- 3. 每个声明块内部不能出现「孤立的属性 + 空行 + 新选择器」 ----
 * 这是本次事故的形态：属性行后面突然跟了一条选择器，而块没闭合。
 */
{
  const lines = css.split('\n');
  let pendingBlock = false;
  let problems = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[.#][\w-].*\{\s*$/.test(line)) pendingBlock = true;
    else if (line.endsWith('}')) pendingBlock = false;
    else if (pendingBlock && /^[.#][\w-].*\{/.test(line)) problems += 1;
  }
  check('选择器不会出现在未闭合的块里', problems === 0, String(problems));
}

/* ---- 4. 搜索框：compact 变体必须是独立规则并且真的更矮 ---- */
{
  const host = /\.dsh-push-search \{([\s\S]*?)\}/.exec(css);
  const compact = /\.dsh-push-search--compact \{([\s\S]*?)\}/.exec(css);
  check('.dsh-push-search 规则完整（含 border）',
    Boolean(host) && host[1].includes('border'));
  check('.dsh-push-search--compact 是独立规则', Boolean(compact));
  if (host && compact) {
    const hHost = Number((/height:\s*(\d+)px/.exec(host[1]) || [])[1]);
    const hCompact = Number((/height:\s*(\d+)px/.exec(compact[1]) || [])[1]);
    check('compact 比宽页面版更矮', Number.isFinite(hCompact) && hCompact < hHost,
      `${hCompact}px < ${hHost}px`);
  }
}

/* ---- 5. 侧栏两个搜索框都用上了 compact ---- */
{
  check('仓库面板搜索框用 compact',
    src.includes("className: 'dsh-push-search dsh-push-search--compact'"));
  check('npm 浏览面板搜索框用 compact',
    src.includes("dsh-push-search dsh-push-search--compact dsh-push-npm-searchrow"));
  const npmRow = /\.dsh-push-npm-searchrow \{([\s\S]*?)\}/.exec(css);
  check('npm 搜索行不再自带 padding/边框（避免叠加变高）',
    Boolean(npmRow) && !/padding:/.test(npmRow[1]) && !/border:/.test(npmRow[1]),
    npmRow ? npmRow[1].replace(/\s+/g, ' ').trim().slice(0, 60) : 'missing');
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
