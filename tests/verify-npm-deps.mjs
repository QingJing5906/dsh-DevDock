/**
 * 工作区依赖检查的判定逻辑测试。
 *
 * `rangeSatisfied` 决定「这个依赖有没有更新」。它必须保守：宁可多提示一次，
 * 也不能把已经落后主版本的项目说成「已最新」。所以这里覆盖各种 range 写法。
 *
 * Run: node tests/verify-npm-deps.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/host/index.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 从 index.js 里切出纯函数并真实执行 ---- */
const START = 'function rangeSatisfied(range, latest) {';
const start = src.indexOf(START);
if (start < 0) {
  console.error('rangeSatisfied not found');
  process.exit(1);
}
const end = src.indexOf('\n}\n', start);
if (end < 0) {
  console.error('rangeSatisfied end not found');
  process.exit(1);
}
const body = src.slice(start, end + 2);
// eslint-disable-next-line no-new-func
const rangeSatisfied = new Function(`${body}\nreturn rangeSatisfied;`)();

/* ---- 1. 明确已满足 ---- */
check('精确版本相同 → 满足', rangeSatisfied('1.2.3', '1.2.3') === true);
check('精确版本不同 → 不满足', rangeSatisfied('1.2.3', '1.2.4') === false);
check('caret 同主版本 → 满足', rangeSatisfied('^4.17.0', '4.18.1') === true);
check('caret 主版本升级 → 不满足', rangeSatisfied('^4.18.0', '5.3.0') === false);
check('tilde 同主同次 → 满足', rangeSatisfied('~5.0.0', '5.0.9') === true);
check('tilde 次版本升级 → 不满足', rangeSatisfied('~5.0.0', '5.1.0') === false);
check('tilde 主版本升级 → 不满足', rangeSatisfied('~5.0.0', '7.0.2') === false);

/* ---- 2. 通配写法 ---- */
check('星号 → 满足', rangeSatisfied('*', '9.9.9') === true);
check('latest 标签 → 满足', rangeSatisfied('latest', '1.0.0') === true);
check('空字符串 → 满足', rangeSatisfied('', '1.0.0') === true);

/* ---- 3. 保守分支：拿不准就算过时 ---- */
check('>= 写法保守判过时', rangeSatisfied('>=1.0.0', '2.0.0') === false);
check('或运算保守判过时', rangeSatisfied('1.0.0 || 2.0.0', '2.0.0') === false);
check('文件路径保守判过时', rangeSatisfied('file:../x', '1.0.0') === false);
check('git url 保守判过时', rangeSatisfied('github:o/r', '1.0.0') === false);

/* ---- 4. 脏输入不抛错 ---- */
let threw = false;
try {
  rangeSatisfied(undefined, '1.0.0');
  rangeSatisfied(null, '1.0.0');
  rangeSatisfied('^x', 'not-a-version');
} catch { threw = true; }
check('脏输入不抛异常', threw === false);

/* ---- 5. 结构与挂载 ---- */
check('存在 /npm/deps 路由', src.includes("get('/npm/deps'"));
check('限并发而不是全部并发', src.includes('const CONCURRENCY = 6;'));
check('读取顺序：dependencies 与 devDependencies',
  src.includes("['dependencies', doc.dependencies]")
  && src.includes("['devDependencies', doc.devDependencies]"));
check('没有 package.json 时给出可读错误', src.includes('这个目录下没有 package.json'));
check('非法 JSON 时给出可读错误', src.includes('package.json 不是合法 JSON'));

/* ---- 6. 客户端确实用到了这个接口 ---- */
const client = readFileSync('client.js', 'utf8');
check('客户端带 path 调用 /npm/deps', client.includes("'/npm/deps?path='"));
check('客户端按「可更新 / 已最新 / 失败」分组显示',
  client.includes('npmDepGroupOutdated')
  && client.includes('npmDepGroupCurrent')
  && client.includes('npmDepGroupFailed'));

/* ---- 7. fixture 能被解析 ---- */
{
  const fixture = JSON.parse(readFileSync('tests/fixtures/deps/package.json', 'utf8'));
  check('fixture 含依赖', Object.keys(fixture.dependencies).length === 3);
  check('fixture 含 devDependencies', Object.keys(fixture.devDependencies).length === 1);
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
