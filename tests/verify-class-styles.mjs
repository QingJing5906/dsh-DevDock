/**
 * 组件用到的每个类名都必须有样式定义。
 *
 * 这一次的教训：给 NpmReviewDialog 自造了 `dsh-push-rv-preset` 等类名，
 * 样式表里根本没有这些规则，于是文字用了继承的白色，在深色底上看不清。
 * 同时预设也没能用上 GitHub 那套大卡片（`rv-card`）。
 *
 * 这类问题语法检查、渲染测试都抓不到——只有把「用到的类名」和「定义的
 * 样式」对起来才看得见。
 *
 * Run: node tests/verify-class-styles.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
const css = src.slice(open + 'const CSS = `'.length, src.indexOf('`;', open));

/** 某个类名在样式表里有没有规则。 */
function defined(cls) {
  return new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '[\\s{,:]').test(css);
}

/** 取一个组件的函数体。 */
function componentBody(name) {
  const start = src.indexOf('function ' + name + '(props) {');
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return end > start ? src.slice(start, end) : '';
}

/** 组件里用到的所有 dsh-push-* 类名。 */
function usedClasses(body) {
  const out = new Set();
  for (const match of body.match(/className: '[^']+'/g) || []) {
    for (const cls of match.replace(/className: '|'/g, '').split(/\s+/)) {
      if (cls.startsWith('dsh-push-')) out.add(cls);
    }
  }
  // 拼接形式的 className 也要能覆盖到
  for (const match of body.match(/className: '[^']*' \+/g) || []) {
    for (const cls of match.replace(/className: '|' \+/g, '').split(/\s+/)) {
      if (cls.startsWith('dsh-push-')) out.add(cls);
    }
  }
  return [...out];
}

/* ---- 1. 审查对话框用到的类名全部有样式 ---- */
{
  const body = componentBody('NpmReviewDialog');
  check('NpmReviewDialog 存在', body !== '');

  const used = usedClasses(body);
  const missing = used.filter((cls) => !defined(cls));
  check('审查对话框的类名都有样式', missing.length === 0,
    missing.join(', ') || '全部有定义');

  // 关键类：这些缺失会直接导致看不清 / 不是大卡片
  for (const cls of [
    'dsh-push-rv-head', 'dsh-push-rv-title', 'dsh-push-rv-sub',
    'dsh-push-rv-scroll', 'dsh-push-rv-cards', 'dsh-push-rv-card',
    'dsh-push-rv-card-title', 'dsh-push-rv-card-desc', 'dsh-push-rv-card-check',
    'dsh-push-rv-divider', 'dsh-push-rv-custom', 'dsh-push-rv-textarea',
    'dsh-push-rv-summary', 'dsh-push-rv-finding', 'dsh-push-rv-sev',
  ]) {
    check('样式存在：' + cls, defined(cls));
  }
}

/* ---- 2. 用的是 GitHub 那套大卡片，而不是自造类名 ---- */
{
  const body = componentBody('NpmReviewDialog');
  check('预设用 rv-card 大卡片', body.includes("'dsh-push-rv-card'"));
  check('分类用 rv-group / rv-cards',
    body.includes('dsh-push-rv-group') && body.includes('dsh-push-rv-cards'));
  check('唯一滚动区是 rv-scroll', body.includes('dsh-push-rv-scroll'));

  // 自造的那套类名不该再出现
  for (const legacy of ['rv-preset', 'rv-check', 'rv-category', 'rv-row-label']) {
    check('不再使用自造类名 ' + legacy, !body.includes(legacy));
  }
}

/* ---- 3. 结构：bare 模式自己渲染头部，避免双标题 ---- */
{
  const body = componentBody('NpmReviewDialog');
  check('使用 bare 模式（自渲染头部）', /bare: true/.test(body));
  check('有头部结构', body.includes('dsh-push-rv-head'));
  check('有标题', body.includes('dsh-push-rv-title'));
}

/* ---- 4. 结果页可读 ---- */
{
  const body = componentBody('NpmReviewDialog');
  check('结果页有摘要', body.includes('dsh-push-rv-summary'));
  check('结果条目有严重度标签', body.includes('dsh-push-rv-sev'));
  check('结果条目有标题', body.includes('dsh-push-rv-finding-title'));
  check('结果条目有详情', body.includes('dsh-push-rv-finding-detail'));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  const state = c.ok ? 'ok  ' : 'FAIL';
  const detail = c.detail ? ' - ' + c.detail : '';
  console.log(state + ' ' + c.label + detail);
}
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
