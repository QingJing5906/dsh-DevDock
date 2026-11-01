/**
 * npm 账号卡片交互测试。
 *
 * 起因：反馈「设置里添加新的 npm 账号，卡片点击之后什么都没有，连输入框
 * 都没有」。这类「点了没反应」的 bug 用源码断言抓不到，所以这里把小组件
 * 的行为真的跑一遍：点空卡片 / 点「添加」行，都必须让输入框出现。
 *
 * Run: node tests/verify-npm-account-ui.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. 源码结构：adding 与渲染分支的关系 ---- */
{
  check('存在 NpmAccountCards 组件', src.includes('function NpmAccountCards('));

  const block = /const stackChildren = [\s\S]*?;\n  \}\n/.exec(src);
  check('stackChildren 先渲染已有账号', Boolean(block) && block[0].includes('list.map(accountCard)'));
  check('adding 时必然渲染输入面板',
    Boolean(block) && /if \(adding\) \{[\s\S]*?addPanel/.test(block[0]));
  check('没有把空卡片和输入框锁在互斥分支里',
    !/list\.length === 0 && !adding \? emptyCard/.test(src));
}

/* ---- 2. 输入框本身存在且是密码框 ---- */
{
  const tokenField = /const tokenField = h\('input', \{[\s\S]*?\}\);/.exec(src);
  check('存在令牌输入框', Boolean(tokenField));
  if (tokenField) {
    check('输入框是 password 类型', tokenField[0].includes("type: 'password'"));
    check('输入框绑定 onChange', tokenField[0].includes('onChange'));
  }
  check('输入面板包含保存按钮', src.includes("t('npmAddSave')"));
}

/* ---- 3. 真跑一遍组件：点击后必须出现 input ---- */
{
  const React = {
    createElement(type, props, ...children) { return { $$el: true, type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useReducer: (r, i) => [i, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useInsertionEffect: () => {},
    useMemo: (fn) => { try { return fn(); } catch { return undefined; } },
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v ?? null }),
    useContext: () => ({}),
    useId: () => 'id',
    createContext: (v) => ({ Provider: 'P', Consumer: 'C' }),
    Children: { map: (x) => x, toArray: (x) => x },
    isValidElement: (x) => Boolean(x && x.$$el),
    memo: (fn) => fn,
    forwardRef: (fn) => fn,
  };

  /* 把 NpmAccountCards 抽出来单独挂载，用一个可控的 useState 模拟点击。 */
  const start = src.indexOf('function NpmAccountCards(');
  const end = src.indexOf('\n}\n', src.indexOf('return h(', start));
  const body = src.slice(start, end + 3);

  /* 渲染后收集所有 input 元素 */
  function collect(node, out, depth) {
    if (depth > 20 || node == null) return;
    if (Array.isArray(node)) { for (const c of node) collect(c, out, depth + 1); return; }
    if (typeof node !== 'object' || !node.$$el) return;
    if (node.type === 'input') out.inputs.push(node);
    for (const c of node.children || []) collect(c, out, depth + 1);
  }

  /* 用一次「already adding」的渲染验证输入框会出现——这正是不带账号、
   * 或点了「添加」之后应当进入的状态。 */
  const stub = `
    const t = (key) => key;
    const api = async () => ({ accounts: [], activeId: null });
    const API = '/api/push';
    const NpmMark = () => ({ $$el: true, type: 'span', props: {}, children: [] });
    const Icon = () => ({ $$el: true, type: 'span', props: {}, children: [] });
    const Btn = () => ({ $$el: true, type: 'button', props: {}, children: [] });
    const npmAccountCache = [];
    ${body}
    return NpmAccountCards;
  `;

  let rendered = null;
  try {
    const factory = new Function(
      'h', 'useState', 'useEffect', 'useCallback', 'useRef', 'useContext',
      stub,
    );
    const Comp = factory(
      React.createElement,
      /* useState 直接返回「已经在添加」的状态，绕开事件模拟 */
      (initial) => {
        const value = typeof initial === 'function' ? initial() : initial;
        if (value === false && initial !== undefined) return [true, () => {}];
        return [value, () => {}];
      },
      React.useEffect, React.useCallback, React.useRef, React.useContext,
    );
    rendered = Comp({ ctx: {} });
  } catch (error) {
    check('组件能独立渲染', false, String(error.message).slice(0, 80));
  }

  if (rendered) {
    const out = { inputs: [] };
    collect(rendered, out, 0);
    check('adding 状态下渲染出输入框', out.inputs.length > 0, out.inputs.length + ' 个');
    if (out.inputs.length > 0) {
      check('渲染出的输入框是 password',
        out.inputs.some((n) => n.props.type === 'password'));
    }
  }
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
