/**
 * 顶部入口的生命周期正确性。
 *
 * 这个问题反复出现三次，根因是写法与其它 surface 不一致：
 *  - 用 ctx.inject(['slots']) 只等「服务就绪」，不等「座位被声明」
 *  - 组件定义在 apply 内部，闭包绑在那一次 apply 的 ctx 上
 *  - 弹窗里的 WorkspaceTab 拿不到 scope，npm/Git 面板都用不了
 *
 * 这里逐条钉住，避免再退回去。
 *
 * Run: node tests/verify-header-entry.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. 注册方式必须与其它 surface 一致 ---- */
{
  check('设置页用 ctx.slots.inject', src.includes("ctx.slots.inject('settings.section'"));
  check('侧边栏用 ctx.slots.inject', src.includes("ctx.slots.inject('sidebar.panellist'"));
  check('顶部入口也用 ctx.slots.inject',
    src.includes("ctx.slots.inject('conversation.session.header.utilities'"));
  // 只看真实代码行，跳过注释；betterSidebar 用 ctx.inject 是对的——
  // 那等的是「服务」，而 slots 要用 ctx.slots.inject 等「座位声明」。
  const codeLines = src.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
  });
  const usesServiceInjectForSlots = codeLines.some((line) =>
    line.includes("ctx.inject(['slots']"));
  check('不再用 ctx.inject([\'slots\']) 来注册 slot', !usesServiceInjectForSlots);
  check('betterSidebar 仍用 ctx.inject（等的是服务，这是对的）',
    codeLines.some((line) => line.includes("ctx.inject(['betterSidebar']")));
}

/* ---- 2. 每个 ctx.slots.inject 的返回值都被 effect 接管 ---- */
{
  check('顶部入口的 inject 返回值交给 ctx.effect',
    /const offInject = ctx\.slots\.inject\('conversation\.session\.header\.utilities'[\s\S]{0,200}?ctx\.effect\(\(\) => offInject/.test(src));
}

/* ---- 3. 组件必须在模块级，而不是 apply 内部 ---- */
{
  check('DevDockHeaderEntry 定义在模块级',
    /^function DevDockHeaderEntry\(props\) \{/m.test(src));

  // 它不能出现在 apply 函数体里
  const applyStart = src.indexOf('function apply(ctx) {');
  const applyEnd = src.indexOf('\n    }\n', applyStart);
  const applyBody = applyStart >= 0 && applyEnd > applyStart
    ? src.slice(applyStart, applyEnd)
    : '';
  check('组件不在 apply 内部定义',
    !/function DevDockHeaderEntry\(/.test(applyBody));
  check('注册时通过 props 传 ctx',
    src.includes('h(DevDockHeaderEntry, Object.assign({}, props, { ctx }))'));
}

/* ---- 4. 弹窗里的面板必须拿到目录，否则 npm/Git 都用不了 ---- */
{
  const start = src.indexOf('function DevDockHeaderEntry(props) {');
  const end = src.indexOf('\n}\n', start);
  const body = start >= 0 ? src.slice(start, end) : '';
  check('入口自己持有目录状态', /const \[dir, setDir\]/.test(body));
  check('目录持久化到偏好', body.includes("writeViewPref('headerDir'"));
  check('把 scope 传给 WorkspaceTab', /h\(WorkspaceTab, \{[^}]*scope/.test(body));
  check('提供选择目录的入口', body.includes('pickDirectory'));
}

/* ---- 5. 注册失败不能静默 ---- */
{
  check('入口注册失败会 warn',
    /console\.warn\('push: header entry unavailable'/.test(src));
}

/* ---- 6. 设置页/侧边栏的行为没有被改坏 ---- */
{
  check('设置页仍然注册 id push', src.includes("name: 'settings.section'"));
  check('侧边栏仍然注册 panellist', src.includes("name: 'sidebar.panellist'"));
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
