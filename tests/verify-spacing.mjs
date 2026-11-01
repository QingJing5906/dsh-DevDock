/**
 * 侧栏间距检查。
 *
 * 起因：反馈「侧边栏有些文字过于紧靠边缘」。根因是水平内边距写死 16px，
 * 且行内元素自身几乎没有内缩。这里把结论固定下来——窄面板必须比宽面板
 * 更松，行必须有内缩。
 *
 * Run: node tests/verify-spacing.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
const css = src.slice(open + 'const CSS = `'.length, src.indexOf('`;', open));

/* ---- 1. 引入统一的水平内边距变量 ---- */
check('定义了 --dsh-push-pad-x', css.includes('--dsh-push-pad-x'));

/* ---- 2. 窄面板比宽面板更松 ---- */
{
  const wide = /\.dsh-push-root \{\s*--dsh-push-pad-x:\s*(\d+)px/.exec(css);
  const narrow = /\.dsh-push-page\.dsh-push-page--panel \{\s*--dsh-push-pad-x:\s*(\d+)px/.exec(css);
  check('宽面板定义了默认内边距', Boolean(wide), wide ? wide[1] + 'px' : 'missing');
  check('窄面板覆盖成更大的内边距', Boolean(narrow), narrow ? narrow[1] + 'px' : 'missing');
  if (wide && narrow) {
    check('窄面板 > 宽面板', Number(narrow[1]) > Number(wide[1]),
      narrow[1] + 'px > ' + wide[1] + 'px');
  }
}

/* ---- 3. 四个页面区域都用变量，而不是写死 16px ---- */
{
  const regions = ['page-head', 'page-toolbar', 'page-body', 'page-foot'];
  for (const region of regions) {
    const rule = new RegExp('\\.dsh-push-' + region + ' \\{([\\s\\S]*?)\\}').exec(css);
    const body = rule ? rule[1] : '';
    const usesVar = body.includes('var(--dsh-push-pad-x)');
    const hardcoded = /padding:[^;]*\b16px\b/.test(body);
    check(region + ' 使用变量内边距', usesVar && !hardcoded,
      body.replace(/\s+/g, ' ').trim().slice(0, 70));
  }
}

/* ---- 4. 行级元素在窄面板里有内缩 ---- */
{
  const targets = [
    ['row', '.dsh-push-page--panel .dsh-push-row'],
    ['repo-head', '.dsh-push-page--panel .dsh-push-repo-head'],
    ['group-head', '.dsh-push-page--panel .dsh-push-group-head'],
  ];
  for (const pair of targets) {
    check('窄面板里 ' + pair[0] + ' 有左右内缩', css.includes(pair[1]), pair[1]);
  }
}

/* ---- 5. 侧栏根容器真的挂了修饰类 ---- */
{
  const count = (src.match(/dsh-push-page dsh-push-page--panel/g) || []).length;
  check('侧栏根容器挂了 --panel 修饰类', count >= 2, count + ' 处');
  check('工作区标签页没有误加',
    !src.includes('dsh-push-root dsh-push-tab dsh-push-page--panel'));
}

/* ---- 6. 卡片间距与分组留白 ---- */
{
  check('窄面板卡片间距加大', css.includes('.dsh-push-page--panel .dsh-push-repocards'));
  check('窄面板分组之间有留白',
    css.includes('.dsh-push-page--panel .dsh-push-group + .dsh-push-group'));
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
