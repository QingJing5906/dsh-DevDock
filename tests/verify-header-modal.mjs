/**
 * 顶部入口弹窗的布局，以及「能否切回 GitHub」。
 *
 * 两个真实反馈：
 *  1. 弹窗高度严重不足，平台切换浮层被裁掉。
 *  2. 从 npm 切到 GitHub 后回不去 —— GitHub 分支的头部没有切换器。
 *
 * Run: node tests/verify-header-modal.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
const css = src.slice(open + 'const CSS = `'.length, src.indexOf('`;', open));

/* ---- 1. 弹窗高度：内容区能真正伸缩，不再被裁 ---- */
{
  const body = /\.dsh-push-modal-body \{([\s\S]*?)\}/.exec(css);
  check('弹窗内容区可伸缩（flex:1）',
    Boolean(body) && /flex:\s*1/.test(body[1]),
    body ? body[1].replace(/\s+/g, ' ').trim().slice(0, 60) : 'missing');
  check('弹窗内容区允许收缩（min-height:0）',
    Boolean(body) && /min-height:\s*0/.test(body[1]));

  check('存在填满高度的变体 .dsh-push-modal--fill', css.includes('.dsh-push-modal--fill'));
  check('Modal 组件支持 fill 参数', src.includes("props.fill ? ' dsh-push-modal--fill'"));
  check('顶部入口弹窗启用了 fill', /fill: true,/.test(src));

  const head = /\.dsh-push-modal-head \{([\s\S]*?)\}/.exec(css);
  const foot = /\.dsh-push-modal-foot \{([\s\S]*?)\}/.exec(css);
  check('头部不参与伸缩', Boolean(head) && /flex:\s*none/.test(head[1]));
  check('底部不参与伸缩', Boolean(foot) && /flex:\s*none/.test(foot[1]));
}

/* ---- 2. 浮层不被父容器裁掉 ---- */
{
  check('头部允许溢出（否则菜单被裁）',
    /\.dsh-push-tab-head, \.dsh-push-page-head \{ overflow: visible; \}/.test(css));
  check('头部内的切换器是定位基准',
    css.includes('.dsh-push-tab-head .dsh-push-pswitch'));
}

/* ---- 3. 每个 tab 头部都必须有切换器（能切回去） ---- */
{
  const lines = src.split('\n');
  const heads = [];
  for (const [i, line] of lines.entries()) {
    if (line.includes("className: 'dsh-push-tab-head'")) {
      const window = lines.slice(i, i + 5).join('\n');
      heads.push({ line: i + 1, switchers: (window.match(/PlatformSwitcher/g) || []).length });
    }
  }
  check('存在 tab 头部', heads.length >= 3, heads.length + ' 个');

  const missing = heads.filter((row) => row.switchers === 0);
  check('每个 tab 头部都有平台切换器', missing.length === 0,
    missing.map((row) => '行 ' + row.line).join(', '));

  const doubled = heads.filter((row) => row.switchers > 1);
  check('没有重复的切换器', doubled.length === 0,
    doubled.map((row) => '行 ' + row.line + ' x' + row.switchers).join(', '));
}

/* ---- 4. npm 分支与 GitHub 分支都能切换 ---- */
{
  check('npm 分支的头部有切换器',
    /if \(platform === 'npm'\)[\s\S]{0,600}?PlatformSwitcher/.test(src));
  check('切换会写回偏好（切走再回来仍是同一平台）',
    src.includes("writePlatform('tab', id)"));
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
