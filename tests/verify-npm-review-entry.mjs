/**
 * 三处 npm 面板的审查入口与目录选择。
 *
 * 两个真实反馈：
 *  1. 找不到 agent 审查入口 —— 它当时只藏在「包管理弹窗」里，而工作区
 *     标签页显示的是「这个项目」，根本没有弹窗可开。
 *  2. 发布页显示「需要选择工作区」，却没有选择控件。
 *
 * Run: node tests/verify-npm-review-entry.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/** 切出一个组件的函数体。 */
function componentBody(name) {
  const start = src.indexOf('function ' + name + '(props) {');
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return end > start ? src.slice(start, end) : '';
}

/* ---- 1. 三处面板都有审查入口 ---- */
{
  const panels = ['NpmSearchPanel', 'NpmSection', 'NpmProjectPanel'];
  for (const name of panels) {
    const body = componentBody(name);
    check(name + ' 存在', body !== '');
    check(name + ' 挂了 NpmReviewDialog', body.includes('h(NpmReviewDialog, {'));
    check(name + ' 有 reviewOpen 状态', body.includes('reviewOpen'));
  }
}

/* ---- 2. 每处都有触发按钮，而不只是对话框 ---- */
{
  const panels = ['NpmSearchPanel', 'NpmSection', 'NpmProjectPanel'];
  for (const name of panels) {
    const body = componentBody(name);
    check(name + ' 有可点击的审查按钮',
      /onClick: \(\) => setReviewOpen\(true\)/.test(body));
  }
}

/* ---- 3. 目录选择：三处都能选 ---- */
{
  const panels = ['NpmSearchPanel', 'NpmSection', 'NpmProjectPanel'];
  for (const name of panels) {
    const body = componentBody(name);
    check(name + ' 使用 useNpmDir', body.includes('useNpmDir('));
    check(name + ' 有目录控件', body.includes('NpmDirBar'));
  }

  check('NpmDirBar 组件存在', src.includes('function NpmDirBar('));
  check('useNpmDir 组件存在', src.includes('function useNpmDir('));
  check('目录选择调用官方 uiWorkspace', src.includes("ctx.get('uiWorkspace')"));
  check('目录持久化到偏好', src.includes("writeViewPref('npmDir'"));
}

/* ---- 4. 发布行不再只显示「需要选择工作区」 ---- */
{
  const body = componentBody('NpmPublishRow');
  check('发布行自己解析目录', body.includes('useNpmDir('));
  check('发布行有目录条', body.includes('NpmDirBar'));
  check('发布行不再只是干瘪提示',
    !/const cwd = props\.cwd \|\| '';[\s\S]{0,80}?npmPublishNeedWorkspace/.test(body));
}

/* ---- 5. 工作区面板没目录时给选择入口，而不是一句提示 ---- */
{
  const body = componentBody('NpmProjectPanel');
  check('没目录时提供选择入口',
    /cwd === ''[\s\S]{0,300}?NpmDirBar/.test(body));
}

/* ---- 6. 三处共用同一个目录偏好（不会各记各的） ---- */
{
  const occurrences = (src.match(/useNpmDir\(/g) || []).length;
  check('三处面板都通过 useNpmDir 取目录', occurrences >= 4, occurrences + ' 处调用');
  // 偏好写入应该只出现在 useNpmDir 内部（pick / clear 各一处），
  // 而不是散落在各个面板里各写一套。
  const defs = (src.match(/function useNpmDir\(/g) || []).length;
  check('只有一个 useNpmDir 实现', defs === 1, defs + ' 处定义');

  const useStart = src.indexOf('function useNpmDir(');
  const useEnd = src.indexOf('\n}\n', useStart);
  const useBody = useStart >= 0 && useEnd > useStart ? src.slice(useStart, useEnd) : '';
  const writes = (src.match(/writeViewPref\('npmDir'/g) || []).length;
  const writesInside = (useBody.match(/writeViewPref\('npmDir'/g) || []).length;
  check('目录偏好只在 useNpmDir 内写入', writes === writesInside,
    writes + ' 总写入 / ' + writesInside + ' 在 useNpmDir 内');
}

/* ---- 7. 文案齐全 ---- */
{
  check('目录相关文案', src.includes('npmNoDirYet: "还没有选择目录"'));
  check('审查摘要文案', src.includes('npmReviewSummary'));
  check('中英双语', src.includes('npmNoDirYet: "No folder selected"'));
}

/* ---- 8. 包管理弹窗的发布页 ---- */
{
  const body = componentBody('NpmPackageModal');
  check('发布弹窗存在', body !== '');
  check('发布弹窗自己解析目录', body.includes('useNpmDir('));
  check('发布弹窗的发布页有目录条', body.includes('NpmDirBar'));
  check('不再只有一句「需要选择工作区」',
    !/!cwd\s*\n?\s*\? h\('div', \{ className: 'dsh-push-error' \}, t\('npmPublishNeedWorkspace'\)\)/.test(body));
}

/* ---- 9. 空目录时面板不能只剩一句提示 ---- */
{
  const body = componentBody('NpmProjectPanel');
  // 注意：`cwd === ''` 在 load() 里还有一次提前 return，
  // 那不是渲染分支。这里要找真正的 `if (cwd === '') {` 分支。
  const idx = body.indexOf("if (cwd === '') {");
  const branch = idx >= 0 ? body.slice(idx, idx + 1600) : '';
  check('空目录分支里有目录条', branch.includes('NpmDirBar'));
  check('空目录分支里有审查入口', branch.includes('NpmReviewDialog'));
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
