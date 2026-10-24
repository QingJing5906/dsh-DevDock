/**
 * 平台切换（DevDock 套件的模块切换）行为测试。
 *
 * 三个入口各自记住平台、侧栏图标与标签跟随平台、npm 分支能真正渲染出来。
 * 「切到 npm 后界面还在」是这类重构最容易漏的一环，所以这里不只是读源码，
 * 而是把平台偏好写进去后，用迷你 React 把两个分支都渲染一遍。
 *
 * Run: node tests/verify-platform.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. 端口与注册表 ---- */
{
  check('平台注册表存在', src.includes('const PLATFORMS = ['));
  check('注册了 GitHub 与 npm',
    src.includes("{ id: 'github', label: 'GitHub' }") && src.includes("{ id: 'npm', label: 'npm' }"));
  check('每个入口独立记忆平台', src.includes("readViewPref('platform.' + surface, 'github')"));
  check('非法值回落 GitHub', src.includes("? raw : 'github'") || src.includes(": 'github'"));

  // 三个入口各自的 surface 名
  check("左侧面板用 'panel'", src.includes("readPlatform('panel')"));
  check("工作区标签页用 'tab'", src.includes("readPlatform('tab')"));
  // 三个入口代表套件本身，名字固定；平台在入口内部切换。
  const devdockLabels = (src.match(/label: \(\) => 'DevDock'/g) || []).length;
  check('设置与侧栏两个入口都以 DevDock 命名', devdockLabels === 2, String(devdockLabels));
  check('工作区标签页以 DevDock 命名', src.includes("title: () => 'DevDock'"));
  check('侧栏图标用套件标记', src.includes('h(DevDockMark, { size: (props && props.size)'));
}

/* ---- 2. 真实渲染两个分支 ---- */
const React = {
  createElement(type, props, ...children) { return { $$el: true, type, props: props || {}, children }; },
  Fragment: 'Fragment',
  memo: (fn) => fn,
  forwardRef: (fn) => fn,
  useState(initial) {
    let value = typeof initial === 'function' ? initial() : initial;
    // 让平台偏好生效：pref 桩会把 'platform.panel' 读成 npm
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
};

/** 用给定的平台偏好装载一次 bundle，返回注册的组件。 */
function load(prefs) {
  let captured = null;
  const registered = [];
  const store = new Map(Object.entries(prefs || {}));
  const styleEl = { dataset: {}, style: {}, textContent: '', setAttribute: () => {}, appendChild: () => {}, remove: () => {} };
  const document = {
    head: { appendChild: () => {} }, body: { appendChild: () => {} },
    documentElement: { appendChild: () => {}, style: {} },
    createElement: () => styleEl, getElementById: () => null, querySelector: () => null,
    addEventListener: () => {},
  };
  const ctx = {
    get: () => undefined,
    inject: (d, cb) => { if (typeof cb === 'function') cb(ctx, {}); },
    effect: () => {}, on: () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    slots: {
      inject: (k, cb) => { try { cb(); } catch { /* ignore */ } },
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
      registerFactory: () => () => {},
    },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (e) => { captured = e; } },
      // 偏好的读写走 window.localStorage，桩必须挂在 window 上。
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    },
    document,
    navigator: { userAgent: 'node', language: 'zh-CN' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id) => (id === 'react' ? React : new Proxy({}, { get: () => undefined })),
    module: { exports: {} }, exports: {},
  };
  const context = vm.createContext(sandbox);
  context.globalThis = context;
  vm.runInContext(src, context, { filename: 'client.js' });
  const exported = captured.factory(sandbox.require);
  exported.apply(ctx, {});
  return { registered, React };
}

/** 递归渲染，收集 ReferenceError 与是否见到 npm 分区。 */
function render(node, depth, out) {
  if (node == null || depth > 16) return;
  if (Array.isArray(node)) { for (const c of node) render(c, depth + 1, out); return; }
  if (typeof node === 'function') {
    try { render(node(PROPS), depth + 1, out); } catch (e) {
      if (String(e && e.name) === 'ReferenceError') out.errors.push(e.message);
    }
    return;
  }
  if (typeof node !== 'object' || !node.$$el) return;
  if (typeof node.type === 'function') {
    try { render(node.type(Object.assign({}, PROPS, node.props)), depth + 1, out); } catch (e) {
      if (String(e && e.name) === 'ReferenceError') out.errors.push(e.message);
    }
    return;
  }
  if (node.props && typeof node.props.className === 'string' && node.props.className.includes('dsh-push-npm-mark')) {
    out.sawNpmMark = true;
  }
  for (const c of node.children || []) render(c, depth + 1, out);
}

const PROPS = {
  ctx: {},
  cwd: '/repo', visible: true, active: false, size: 16, open: true,
  status: {
    isRepo: true, root: '/repo', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0,
    detachedHead: false, remotes: [], tags: [], branches: [], stashes: [], files: [],
    dirty: { changed: 0, staged: 0, untracked: 0, conflicted: 0 },
  },
  repo: {
    id: '1', owner: 'o', name: 'n', fullName: 'o/n', private: false, fork: false, archived: false,
    defaultBranch: 'main', description: 'd', stars: 0, forks: 0, openIssues: 0,
    htmlUrl: 'https://github.com/o/n', updatedAt: new Date().toISOString(),
    permissions: { admin: true, push: true, pull: true }, language: 'JavaScript',
  },
  pending: null, languages: [{ name: 'JavaScript', percent: 100, bytes: 1 }],
};

/* 默认 GitHub：不该出现 npm 标记在列表里（切换器菜单里一定有，所以只查是否出错） */
{
  const { registered } = load({});
  const out = { errors: [], sawNpmMark: false };
  for (const entry of registered) render(entry.component, 0, out);
  check('GitHub 分支渲染无 ReferenceError', out.errors.length === 0, [...new Set(out.errors)].join(' | '));
}

/* 切到 npm：两个入口都要能把 npm 视图渲染出来且不报错 */
{
  const { registered } = load({ 'dsh-push.view.platform.panel': 'npm', 'dsh-push.view.platform.tab': 'npm' });
  const out = { errors: [], sawNpmMark: false };
  for (const entry of registered) render(entry.component, 0, out);
  check('npm 分支渲染无 ReferenceError', out.errors.length === 0, [...new Set(out.errors)].join(' | '));
  check('npm 分支渲染出了 npm 标记', out.sawNpmMark === true);
}

/* ---- 3. 设置页：顶部切换器 + 每个平台独立一页 ---- */
{
  check('设置页有自己的平台记忆', src.includes("readPlatform('settings')"));
  check('设置页顶部有切换器', src.includes("className: 'dsh-push-settings-head'"));
  check('npm 有独立一页', src.includes("if (platform === 'npm')") && src.includes('dsh-push-settings-body'));
  check('GitHub 页不再混入 npm 分区',
    (src.match(/h\(NpmSection, \{ ctx \}\)/g) || []).length === 2);
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
