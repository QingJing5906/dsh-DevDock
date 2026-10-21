/**
 * Verification harness for the Client half.
 *
 * It loads `client.js` with a stubbed `require('react')` and a fake cordis
 * context, then asserts the THREE registration surfaces. The interesting case
 * is the right-sidebar tab: on a real page load the Client plugins activate in
 * arbitrary order, so `betterSidebar` may not exist yet when our factory runs.
 *
 * The fake `ctx.inject` below reproduces that exactly — it defers the callback
 * until the service is provided later — which is the behaviour the fix must
 * survive.
 *
 * Run: node tests/verify-client.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/* ------------------------------------------------------------------ */
/* Minimal React stub: enough for createElement + the hook surface     */
/* ------------------------------------------------------------------ */

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children };
}
const noop = () => {};
const reactStub = {
  createElement,
  Fragment: 'Fragment',
  // Hooks are never invoked: this harness renders nothing, it only checks
  // registration side effects, so a stable stub is sufficient.
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useReducer: (fn, init) => [init, noop],
  useLayoutEffect: noop,
  useSyncExternalStore: (_sub, get) => get(),
};

/* ------------------------------------------------------------------ */
/* Fake cordis context                                                 */
/* ------------------------------------------------------------------ */

/** Everything the plugin registers, so the assertions can look it up. */
const recorded = {
  slots: [],
  tabs: [],
  effects: [],
};

function makeCtx({ provideBetterSidebar = 'never', services = {} } = {}) {
  const provided = new Map(Object.entries(services));
  const deferred = [];

  const ctx = {
    slots: {
      inject(name, callback) {
        // The slot exists, so the callback runs immediately.
        const disposer = callback();
        recorded.slots.push({ name, disposer });
        return disposer ?? (() => {});
      },
      register(options, component) {
        recorded.slots.push({ kind: 'register', options, component });
        return () => {};
      },
    },
    get(name) {
      return provided.get(name);
    },
    effect(callback, label) {
      const disposer = callback();
      recorded.effects.push({ label, disposer });
      return disposer ?? (() => {});
    },
    on() {
      return () => {};
    },
    provide(name, value) {
      provided.set(name, value);
      // Wake anything waiting on it, mirroring cordis' dependency machinery.
      for (let i = deferred.length - 1; i >= 0; i -= 1) {
        const entry = deferred[i];
        if (!entry.names.every((n) => provided.has(n))) continue;
        deferred.splice(i, 1);
        entry.callback(makeScoped(entry.names));
      }
      return () => provided.delete(name);
    },
    /**
     * `immediate: 'never'` holds every request until the service is provided,
     * which is precisely the cold-page-load ordering that broke the tab.
     */
    inject(names, callback) {
      if (provideBetterSidebar === 'never') {
        deferred.push({ names, callback });
        return () => {};
      }
      if (names.every((n) => provided.has(n))) {
        callback(makeScoped(names));
      } else {
        deferred.push({ names, callback });
      }
      return () => {};
    },
  };

  function makeScoped() {
    return ctx;
  }

  return { ctx, provided, deferred };
}

/* ------------------------------------------------------------------ */
/* Loader shim                                                         */
/* ------------------------------------------------------------------ */

let registeredModule = null;
globalThis.window = {
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  __ModuleLoader__: {
    load(entry) {
      registeredModule = entry;
    },
  },
};

// `document` must exist for the stylesheet injection; the calls are no-ops.
const fakeElement = () => ({
  id: '',
  dataset: {},
  appendChild: noop,
  remove: noop,
  setAttribute: noop,
  style: {},
  rel: '',
  href: '',
});
globalThis.document = {
  getElementById: () => null,
  createElement: fakeElement,
  head: fakeElement(),
  documentElement: fakeElement(),
  body: fakeElement(),
};

const source = await readFile(clientPath, 'utf8');
new Function('window', 'document', source)(globalThis.window, globalThis.document);

if (!registeredModule) throw new Error('client.js did not call window.__ModuleLoader__.load');
if (registeredModule.id !== 'dsh-push') {
  throw new Error(`unexpected module id: ${registeredModule.id}`);
}

const factoryRequire = (name) => {
  if (name === 'react') return reactStub;
  throw new Error(`client.js required a non-react module: ${name}`);
};

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

const checks = [];
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail });
}

function sectionsOf() {
  return recorded.slots.filter((s) => s.kind === 'register').map((s) => s.options);
}

function runApply(label) {
  recorded.slots.length = 0;
  recorded.tabs.length = 0;
  recorded.effects.length = 0;
  const exports = registeredModule.factory(factoryRequire);
  check(`${label}: exports.apply is a function`, typeof exports.apply === 'function');
  check(`${label}: exports.inject is exactly ['slots']`,
    Array.isArray(exports.inject) && exports.inject.length === 1 && exports.inject[0] === 'slots',
    JSON.stringify(exports.inject));
  return exports;
}

/* --- Case 1: cold page load, betterSidebar NOT yet provided --------- */
{
  const { ctx } = makeCtx({ provideBetterSidebar: 'never' });
  const exports = runApply('cold-load');
  exports.apply(ctx);

  const opts = sectionsOf();
  check('cold-load: settings.section registered',
    opts.some((o) => o.name === 'settings.section' && o.id === 'push'));
  check('cold-load: sidebar.panellist registered',
    opts.some((o) => o.name === 'sidebar.panellist' && o.id === 'push'));
  check('cold-load: main page key registered',
    opts.some((o) => o.name === 'main' && o.key === 'push'));
  check('cold-load: no tab yet (service absent)', recorded.tabs.length === 0);
}

/* --- Case 2: betterSidebar arrives AFTER apply (the regression) ----- */
{
  const { ctx } = makeCtx({ provideBetterSidebar: 'never' });
  const exports = runApply('late-service');
  exports.apply(ctx);
  check('late-service: no tab before the service exists', recorded.tabs.length === 0);

  // The better-sidebar bundle finishes activating and publishes its service.
  ctx.provide('betterSidebar', {
    registerTab(descriptor) {
      recorded.tabs.push(descriptor);
      return () => {};
    },
  });

  check('late-service: tab IS registered once betterSidebar appears', recorded.tabs.length === 1,
    `tabs=${recorded.tabs.length}`);
  const tab = recorded.tabs[0];
  if (tab) {
    check('late-service: tab id is push', tab.id === 'push', tab.id);
    check('late-service: tab is single-instance', tab.single === true);
    check('late-service: tab declares a component', typeof tab.component === 'function');
    check('late-service: tab declares an icon', typeof tab.icon === 'function');
    check('late-service: tab title is a thunk returning Chinese',
      typeof tab.title === 'function' && typeof tab.title() === 'string' && tab.title().length > 0);
    check('late-service: tab icon renders at a requested size',
      Boolean(tab.icon(16)));
  }
}

/* --- Case 3: betterSidebar already present (HMR reload path) -------- */
{
  const { ctx } = makeCtx({ provideBetterSidebar: 'now' });
  const exports = runApply('warm-load');
  ctx.provide('betterSidebar', {
    registerTab(descriptor) {
      recorded.tabs.push(descriptor);
      return () => {};
    },
  });
  exports.apply(ctx);
  check('warm-load: tab registered immediately', recorded.tabs.length === 1,
    `tabs=${recorded.tabs.length}`);
}

/* --- Case 4: every registered component must be renderable ---------- */
{
  const { ctx } = makeCtx({ provideBetterSidebar: 'now' });
  ctx.provide('betterSidebar', {
    registerTab(descriptor) {
      recorded.tabs.push(descriptor);
      return () => {};
    },
  });
  const exports = runApply('renderable');
  exports.apply(ctx);

  // Rendering for real needs a React reconciler; instead assert the contract
  // the slot system requires: a function component per registration.
  const components = recorded.slots.filter((s) => s.kind === 'register').map((s) => s.component);
  check('renderable: every slot registration has a component function',
    components.length > 0 && components.every((c) => typeof c === 'function'),
    `${components.length} registrations`);
  for (const tab of recorded.tabs) {
    check('renderable: tab component is a function', typeof tab.component === 'function');
  }
}

/* --- Case 5: settings modal + repo visibility control --------------- */
{
  // These two are pure-source contracts: the CSS template must not be broken
  // by a stray backtick (that closes the literal early and takes the whole
  // bundle down), and the settings fields must live inside the modal rather
  // than a permanently-rendered section at the bottom of the page.
  const src = await readFile(clientPath, 'utf8');

  const cssOpen = src.indexOf('const CSS = `');
  let cssEnd = -1;
  if (cssOpen >= 0) {
    // The CSS literal closes at the first line that is exactly "`;"
    const after = src.indexOf('\n`;', cssOpen);
    cssEnd = after >= 0 ? after : -1;
  }
  check('source: CSS template literal is terminated', cssOpen >= 0 && cssEnd > cssOpen);
  if (cssOpen >= 0 && cssEnd > cssOpen) {
    const cssBody = src.slice(cssOpen + 'const CSS = `'.length, cssEnd);
    // A backtick inside the CSS body would terminate it; the only legal one is
    // the closing delimiter, which the slice already excluded.
    check('source: no stray backtick inside the CSS template',
      !cssBody.includes('`'));
    check('source: no event-handler interpolation inside CSS',
      !cssBody.includes('${'));
    check('source: modal styles are defined', cssBody.includes('.dsh-push-overlay')
      && cssBody.includes('.dsh-push-modal'));
    check('source: segmented-control styles are defined',
      cssBody.includes('.dsh-push-seg-btn'));
  }

  check('source: a Modal component exists', /function Modal\(/.test(src));
  check('source: a Segmented component exists', /function Segmented\(/.test(src));

  // The global options must be inside the Modal's children, and the settings
  // section must not render the connection group inline any more.
  const modalCall = src.indexOf('h(Modal, {');
  const gitPathRow = src.indexOf("t('gitPath')");
  check('source: gitPath option lives inside the modal call',
    modalCall >= 0 && gitPathRow > modalCall);
  check('source: no leftover inline connection group',
    !/connOpen\s*\n?\s*\?\s*h\('div', \{ className: 'dsh-push-group' \}/.test(src));

  // Repo split: the list must be filtered by visibility, not just decorated.
  check('source: repos are filtered by visibility',
    /visibility === 'private'/.test(src) && /visibility === 'public'|!repo\.private/.test(src));
  check('source: private/public tallies exist',
    /privateCount\s*=/.test(src) && /publicCount\s*=/.test(src));
  check('source: the segmented control is rendered with both options',
    /value: 'private'/.test(src) && /value: 'public'/.test(src));
}

/* --- Case 6: pre-push review UI (CONTRACT §3d) ---------------------- */
{
  // The review flow is two dialogs and a result screen; these assertions pin
  // the structure that makes it usable rather than testing pixels: the presets
  // must be multi-select cards, only the card area may scroll, the custom
  // prompt must be savable, and the confirmation must show what will run.
  const src = await readFile(clientPath, 'utf8');

  check('review: a ReviewDialog component exists', /function ReviewDialog\(/.test(src));
  check('review: a model picker exists', /function ModelPicker\(/.test(src));

  // Three screens, each with its own marker.
  check('review: the configure screen is present', src.includes("t('rvTitle')"));
  check('review: the confirm screen is present', src.includes("t('rvConfirmTitle')"));
  check('review: the result screen is present', src.includes("t('rvResult')"));

  // Multi-select preset cards, grouped by category.
  check('review: presets render as selectable cards',
    src.includes('dsh-push-rv-card') && src.includes("'aria-pressed'"));
  check('review: cards are grouped by category', src.includes('dsh-push-rv-group'));
  check('review: only the preset area scrolls', src.includes('dsh-push-rv-scroll'));

  // Model + effort controls, and the host-derived effort scale.
  check('review: the effort control can render as a slider', src.includes('dsh-push-rv-slider'));
  check('review: the effort control falls back to a select',
    src.includes('efforts.length >= 3'));
  check('review: a host without models is handled',
    src.includes("t('rvNoModels')"));

  // Custom prompt + save-as-preset.
  check('review: a custom prompt textarea exists', src.includes('dsh-push-rv-textarea'));
  check('review: a prompt can be saved as a preset', src.includes("t('rvSavePreset')"));
  check('review: saved presets can be deleted', src.includes("'/review/presets/delete'"));

  // Every endpoint the flow needs.
  for (const endpoint of ['/review/presets', '/review/models', '/review/run']) {
    check(`review: calls ${endpoint}`, src.includes(`'${endpoint}'`));
  }

  // The confirm screen must be able to go BACK without losing state, and the
  // push button must warn (not block) on blocker findings.
  check('review: the confirm screen can return to configure', src.includes("t('rvBack')"));
  check('review: blocker findings warn on the push button',
    src.includes('reviewBlocked') && src.includes("severity === 'blocker'"));

  // A degraded run must be explained, never presented as a clean pass.
  check('review: a degraded run is disclosed', src.includes("t('rvDegraded')"));
}

/* --- Report --------------------------------------------------------- */
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
