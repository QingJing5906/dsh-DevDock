/**
 * Render the client half for real and fail on ReferenceError.
 *
 * Why this exists: repeated outages came from an identifier declared in the
 * WRONG component — `reviewResult` took the workspace tab down, and
 * `agentAsked` took the whole sidebar down. Syntax checks, source greps and a
 * successful `apply()` all pass while such a bug is present; only rendering the
 * tree exposes it.
 *
 * Scope, stated honestly: this renders EVERY surface the plugin registers
 * (settings section, sidebar icon, main page, workspace tab) in two passes —
 * once with default state and once with booleans forced true, which opens
 * state-gated UI. A dialog that only opens from a user action deeper inside a
 * component (the push form's review dialog is one) is NOT reached. It catches
 * load-path and first-render ReferenceErrors, not every possible one.
 *
 * The harness is a mini React: `createElement` builds plain nodes and the
 * renderer walks components recursively.
 *
 * Run: node tests/verify-render.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

function safeCall(fn) {
  try { return fn(); } catch { return undefined; }
}

/* ---- mini React ---------------------------------------------------- */
const React = {
  // Booleans can be forced true so state-gated dialogs render in a second pass.
  forceOpen: false,
  createElement(type, props, ...children) {
    return { $$el: true, type, props: props || {}, children };
  },
  Fragment: 'Fragment',
  memo: (fn) => fn,
  forwardRef: (fn) => fn,
  useState(initial) {
    const value = typeof initial === 'function' ? safeCall(initial) : initial;
    if (React.forceOpen === true && typeof value === 'boolean') return [true, () => {}];
    return [value, () => {}];
  },
  useReducer: (reducer, initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useInsertionEffect: () => {},
  useMemo: (fn) => safeCall(fn),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value ?? null }),
  useContext: () => ({}),
  useId: () => 'id',
  createContext: (value) => ({ Provider: 'P', Consumer: 'C', _value: value }),
  Children: { map: (items) => items, toArray: (items) => items, only: (x) => x },
  isValidElement: (x) => Boolean(x && x.$$el),
};

/* ---- capture the bundle ------------------------------------------- */
let captured = null;
const fakeWindow = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };

const styleEl = {
  dataset: {}, style: {}, textContent: '',
  setAttribute: () => {}, appendChild: () => {}, remove: () => {},
};
const document = {
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  documentElement: { appendChild: () => {}, style: {} },
  createElement: () => styleEl,
  getElementById: () => null,
  querySelector: () => null,
  addEventListener: () => {},
};

const registered = [];
const fakeSidebar = {
  registerTab: (options, component) => {
    registered.push({
      label: (options && (options.id || options.key)) || 'workspace-tab',
      component,
    });
    return () => {};
  },
  openTab: () => {},
};

const ctx = {
  get: (key) => (key === 'betterSidebar' ? fakeSidebar : undefined),
  inject: (deps, cb) => { if (typeof cb === 'function') cb(ctx, {}); },
  effect: () => {},
  on: () => {},
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  slots: {
    inject: (key, cb) => { if (typeof cb === 'function') safeCall(cb); },
    register: (options, component) => {
      registered.push({
        label: (options && (options.id || options.key || options.name)) || 'slot',
        component,
      });
      return () => {};
    },
    registerFactory: () => () => {},
  },
};

const sandbox = {
  window: fakeWindow,
  document,
  navigator: { userAgent: 'node', language: 'zh-CN' },
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }),
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: (id) => (id === 'react' ? React : new Proxy({}, { get: () => undefined })),
  module: { exports: {} },
  exports: {},
};
const context = vm.createContext(sandbox);
context.globalThis = context;

try {
  vm.runInContext(code, context, { filename: 'client.js' });
  check('the bundle evaluates', true);
} catch (error) {
  check('the bundle evaluates', false, String(error && error.message));
}

/* ---- render tree --------------------------------------------------- */
/** Props generous enough that most components reach their JSX. */
const PROPS = {
  ctx,
  cwd: '/repo',
  visible: true,
  active: false,
  size: 16,
  open: true,
  status: {
    isRepo: true, root: '/repo', branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, detachedHead: false, remotes: [], tags: [], branches: [], stashes: [],
    files: [],
    dirty: { changed: 0, staged: 0, untracked: 0, conflicted: 0 },
  },
  repo: {
    id: '1', owner: 'o', name: 'n', fullName: 'o/n', private: false, fork: false,
    archived: false, defaultBranch: 'main', description: 'd', stars: 0, forks: 0,
    openIssues: 0, htmlUrl: 'https://github.com/o/n', updatedAt: new Date().toISOString(),
    permissions: { admin: true, push: true, pull: true }, language: 'JavaScript',
  },
  pending: null,
  languages: [{ name: 'JavaScript', percent: 100, bytes: 1 }],
};

const referenceErrors = [];

function collect(error) {
  if (String(error && error.name) === 'ReferenceError') {
    referenceErrors.push(String(error.message));
  }
}

/** Walk a rendered node; ReferenceErrors are collected, prop errors ignored. */
function renderTree(node, depth) {
  if (node == null || depth > 16) return;
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, depth + 1);
    return;
  }
  if (typeof node === 'function') {
    try { renderTree(node(PROPS), depth + 1); } catch (error) { collect(error); }
    return;
  }
  if (typeof node !== 'object' || !node.$$el) return;

  if (typeof node.type === 'function') {
    try {
      renderTree(node.type(Object.assign({}, PROPS, node.props)), depth + 1);
    } catch (error) {
      collect(error);
    }
    return;
  }
  for (const child of node.children || []) renderTree(child, depth + 1);
}

if (captured) {
  check('it registers with the loader', Boolean(captured.id), captured.id);
  let exported;
  try {
    exported = captured.factory(sandbox.require);
    check('the factory returns apply/inject',
      typeof exported.apply === 'function' && Array.isArray(exported.inject));
  } catch (error) {
    check('the factory returns apply/inject', false, String(error && error.message));
  }

  if (exported && typeof exported.apply === 'function') {
    try {
      exported.apply(ctx, {});
      check('apply completes', true);
    } catch (error) {
      check('apply completes', false, String(error && error.message));
    }
  }

  check('surfaces were registered', registered.length > 0, `${registered.length}`);

  for (const pass of [false, true]) {
    React.forceOpen = pass;
    referenceErrors.length = 0;
    for (const entry of registered) renderTree(entry.component, 0);
    const label = pass
      ? 'no ReferenceError with state-gated UI open'
      : 'no ReferenceError on first render';
    check(label, referenceErrors.length === 0,
      [...new Set(referenceErrors)].join(' | '));
  }
  React.forceOpen = false;
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
