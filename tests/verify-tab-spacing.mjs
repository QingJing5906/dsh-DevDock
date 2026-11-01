/**
 * 右侧栏（工作区标签页）的间距与入口可用性。
 *
 * 两件事在这里固化：
 *  1. 右侧栏的容器必须有水平内边距——之前 .dsh-push-scroll 完全没有
 *     padding，所有内容直接顶到边框，这就是「文字紧贴边缘」的根因。
 *  2. 顶部降级入口必须能在宿主重载后重新注册（改用 ctx.inject）。
 *
 * Run: node tests/verify-tab-spacing.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
const css = src.slice(open + 'const CSS = `'.length, src.indexOf('`;', open));

/* ---- 1. 右侧栏根容器定义了水平内边距变量 ---- */
{
  const tabRule = /\.dsh-push-tab \{([\s\S]*?)\}/.exec(css);
  check('.dsh-push-tab 定义了 --dsh-push-pad-x',
    Boolean(tabRule) && tabRule[1].includes('--dsh-push-pad-x'),
    tabRule ? tabRule[1].replace(/\s+/g, ' ').trim().slice(0, 60) : 'missing');
}

/* ---- 2. 头部与内容区都真的用了它 ---- */
{
  const head = /\.dsh-push-tab-head \{([\s\S]*?)\}/.exec(css);
  check('tab-head 使用变量内边距',
    Boolean(head) && head[1].includes('var(--dsh-push-pad-x)'),
    head ? head[1].replace(/\s+/g, ' ').trim().slice(0, 60) : 'missing');

  const scroll = /\.dsh-push-scroll \{([\s\S]*?)\}/.exec(css);
  const hasPadding = Boolean(scroll) && /padding:[^;]*var\(--dsh-push-pad-x\)/.test(scroll[1]);
  check('内容区有水平内边距', hasPadding,
    scroll ? scroll[1].replace(/\s+/g, ' ').trim().slice(0, 70) : 'missing');
}

/* ---- 3. 内部行也有内缩 ---- */
{
  const inner = [
    '.dsh-push-tab .dsh-push-row',
    '.dsh-push-tab .dsh-push-group-head',
  ];
  for (const selector of inner) {
    check('右侧栏内 ' + selector.split(' ').pop() + ' 有内缩', css.includes(selector), selector);
  }
}

/* ---- 4. 左右两个侧栏的间距策略一致 ---- */
{
  const panel = /\.dsh-push-page\.dsh-push-page--panel \{\s*--dsh-push-pad-x:\s*(\d+)px/.exec(css);
  const tab = /\.dsh-push-tab \{[\s\S]*?--dsh-push-pad-x:\s*(\d+)px/.exec(css);
  check('左侧栏与右侧栏用同一档内边距',
    Boolean(panel) && Boolean(tab) && panel[1] === tab[1],
    panel && tab ? panel[1] + 'px vs ' + tab[1] + 'px' : 'missing');
}

/* ---- 5. 顶部入口在重载后能重新注册 ---- */
{
  check('顶部入口通过 ctx.inject 注册',
    /ctx\.inject\(\['slots'\]/.test(src));
  check('注册失败不再静默',
    /console\.warn\('push: header entry/.test(src));
  check('入口改用 ctx.slots.inject 等座位声明',
    src.includes("ctx.slots.inject('conversation.session.header.utilities'"));
  check('顶部入口注册到官方座位',
    src.includes("name: 'conversation.session.header.utilities'"));
}

/* ---- 6. 侧栏标签仍然只在 betterSidebar 存在时注册 ---- */
{
  check('右侧栏标签依赖 betterSidebar',
    src.includes("ctx.inject(['betterSidebar']"));
  check('缺失 betterSidebar 时不阻塞其它界面',
    !/static inject\s*=\s*\[[^\]]*betterSidebar/.test(src));
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
