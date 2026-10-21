/**
 * Regression test for the network-error message.
 *
 * The bug this pins: `api()` used to replace EVERY failed request's message
 * with the generic `errNetwork` label ("网络请求失败，请检查网络连接"). The Host
 * already answers with a precise, actionable diagnosis — TLS verification,
 * missing scope, rate limit — so overwriting it made a certificate problem
 * look like a dead internet connection, which is exactly the wrong thing to
 * tell someone who just pasted a token.
 *
 * Strategy: `api()` is module-private, so instead of simulating React we drive
 * it through a surface that calls it synchronously and records the thrown
 * error. `ReposSection`'s refresh path does exactly that; the simplest stable
 * seam here is the internal helper reached through a component's event
 * handler, so we register the surface and invoke the handler directly.
 *
 * Run: node tests/verify-errors.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/* ---- minimal React + DOM stubs so the bundle can load ---- */
const noop = () => {};
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useLayoutEffect: noop,
  useReducer: (fn, init) => [init, noop],
  useSyncExternalStore: (_s, get) => get(),
};
const fakeElement = () => ({
  id: '', dataset: {}, rel: '', href: '', style: {},
  appendChild: noop, remove: noop, setAttribute: noop,
});
globalThis.window = {
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  __ModuleLoader__: { load(entry) { globalThis.__entry = entry; } },
  open: noop,
};
globalThis.document = {
  getElementById: () => null,
  createElement: fakeElement,
  head: fakeElement(),
  documentElement: fakeElement(),
  body: fakeElement(),
};

const source = await readFile(clientPath, 'utf8');

/**
 * Load the bundle with `api` observed.
 *
 * The bundle is one closure; `api` is declared inside it and unreachable from
 * outside. We therefore append a tiny probe to the factory body that publishes
 * the private helper on the exports object. This is test-only instrumentation
 * applied to a COPY of the source — the shipped file is untouched.
 */
const probeSource = source.replace(
  'exports.apply = apply;',
  'exports.apply = apply;\n    exports.__api = api;',
);
if (probeSource === source) throw new Error('probe injection failed: exports.apply anchor not found');

new Function('window', 'document', probeSource)(globalThis.window, globalThis.document);

const entry = globalThis.__entry;
const exports = entry.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error(`unexpected require: ${name}`);
});
if (typeof exports.__api !== 'function') throw new Error('probe did not expose api()');

const api = exports.__api;
const ctx = { get: () => undefined };

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/** Capture what `api()` throws for a fabricated response. */
async function failure(fetchImpl, pathArg = '/state') {
  globalThis.fetch = fetchImpl;
  try {
    await api(ctx, '/api/push' + pathArg);
    return { threw: false, error: null };
  } catch (error) {
    return { threw: true, error };
  }
}

/* ---------------- case 1: Host NETWORK payload keeps its message --------- */
{
  const hostMessage = '无法连接 GitHub：https://api.github.com/user（UNABLE_TO_VERIFY_LEAF_SIGNATURE）'
    + '。本机 TLS/证书校验未能通过 GitHub 的证书（常见于系统时间错误、企业代理或杀毒软件拦截）。'
    + '请修复证书/代理，或改用可用的 git（设置项「git 路径」）。';
  const { threw, error } = await failure(async () => ({
    ok: false,
    status: 502,
    json: async () => ({ ok: false, error: { code: 'NETWORK', message: hostMessage } }),
  }));
  check('the request failed', threw);
  check('host NETWORK message reaches the UI verbatim', error && error.message === hostMessage,
    error ? String(error.message).slice(0, 60) : 'no error');
  check('the generic sentence did NOT replace it', error && !error.message.includes('请检查网络连接'));
  check('code is preserved', error && error.code === 'NETWORK', error && error.code);
}

/* ---------------- case 2: a real fetch rejection is still generic --------- */
{
  const { threw, error } = await failure(async () => { throw new TypeError('Failed to fetch'); });
  check('a rejected fetch still throws', threw);
  check('a rejected fetch reports the generic network label',
    error && error.message.includes('网络请求失败'), error && error.message);
  check('the underlying cause is kept as detail',
    error && String(error.detail || '').includes('Failed to fetch'), error && error.detail);
}

/* ---------------- case 3: host message wins over the code label ---------- */
{
  const scopeMessage = '贡献图需要令牌具备 read:user 权限；当前令牌没有该权限。';
  const { error } = await failure(async () => ({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, error: { code: 'UNAUTHORIZED', message: scopeMessage } }),
  }));
  check('a specific host message beats the generic per-code label',
    error && error.message === scopeMessage, error && error.message);
  check('the short label is still available', error && typeof error.label === 'string' && error.label.length > 0,
    error && error.label);
}

/* ---------------- case 4: envelope with no message falls back ------------ */
{
  const { error } = await failure(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error: { code: 'NO_ACCOUNT' } }),
  }));
  check('a message-less envelope still gets a readable label',
    error && error.message && error.message !== 'NO_ACCOUNT', error && error.message);
}

/* ---------------- case 5: success path still unwraps data --------------- */
{
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { hello: 'world' } }),
  });
  const value = await api(ctx, '/api/push/state');
  check('a successful envelope returns payload.data', value && value.hello === 'world');
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
