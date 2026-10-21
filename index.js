import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Node half of the dsh-push bundle — a BYTE-STABLE loader shim.
 *
 * Mounted by the loader row `push` (see cordis.patch.yml) in the host
 * plane of the profile process. All real logic lives in ./src/host/index.js
 * ("the impl"); this file only loads it.
 *
 * WHY THE IMPL IS IMPORTED THROUGH A CONTENT-HASHED URL:
 *
 * Every in-process activation path — the market's hot mount (uninstall →
 * install), a loader entry update, a disable → enable cycle — imports the
 * package by the same module URL, so Node's ESM cache keeps returning the
 * FIRST module object this process ever loaded. A new version installed over a
 * running `dsh web` would therefore keep executing the OLD code, and one class
 * of bugs (stale routes, stale settings reads) would look like a live-reload
 * failure that only a restart fixes.
 *
 *   - This file MUST NEVER CHANGE across versions. A cached old shim is
 *     harmless: its only job is to load the CURRENT impl from disk. Any change
 *     to this file itself needs a process restart to apply.
 *   - apply() imports the impl through `?v=<sha256-of-file>`, so identical
 *     content reuses the cached module and changed content gets a fresh URL —
 *     and therefore fresh code — in-process.
 *
 * The impl module itself is re-imported on every mount; the routes and the
 * agent tool it registers are bound to the mounting fiber, so an unload
 * disposes them before the next mount registers them again.
 *
 * IMPORTANT — no `export default`. The loader's `unwrapExports` collapses
 * `exports.default ?? exports`, so a default export would discard the module
 * namespace and with it the named `inject` export, leaving the plugin mounted
 * with no dependencies: `apply()` would run before the host services exist and
 * the plugin would silently no-op. With the namespace preserved, cordis sees
 * `{ apply, inject }` and waits for `webServer` exactly like a published bundle.
 */

/** Implementation module, resolved next to this (possibly cached) shim. */
const IMPL_URL = new URL('./src/host/index.js', import.meta.url);

/**
 * Import the impl, cache-busted by its own content hash.
 *
 * Falls back to the plain URL when the file cannot be read, so the import
 * itself surfaces the real error instead of hiding it behind a stale cached
 * module. Import failures are never swallowed here: silently reusing old code
 * is the exact failure mode this shim exists to prevent.
 *
 * @returns {Promise<typeof import('./src/host/index.js')>}
 */
async function loadImpl() {
  let href = IMPL_URL.href;
  try {
    const bytes = await readFile(IMPL_URL);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    href = `${IMPL_URL.href}?v=${hash}`;
  } catch {
    // Unreadable impl: fall back to the plain URL so the import can report it.
  }
  return await import(/* @vite-ignore */ href);
}

/**
 * Host services that must exist before `apply` runs.
 *
 * `webServer` is the only hard one: without it there is no HTTP API and no
 * plugin. `tools` is deliberately NOT listed — the agent tool is an optional
 * surface, so the impl acquires it through a nested `ctx.inject(['tools'])`
 * fiber, which keeps a composition without the tools service serving the panel
 * instead of never mounting at all.
 *
 * @type {string[]}
 */
export const inject = ['webServer'];

/**
 * Mount the host service. Runs only after the injected services are up.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  // Guard against a double mount: `githubLink` is this plugin's own service, so
  // it cannot be declared in `inject`; ctx.get() is the non-throwing lookup.
  if (ctx.get('githubLink')) return;
  const mod = await loadImpl();
  // Re-check after the await: a concurrent apply may have mounted meanwhile.
  if (ctx.get('githubLink')) return;
  // NOTE: deliberately NOT returned. A returned fiber is a thenable whose
  // resolved value is the fiber object itself, which cordis's effect collector
  // rejects with "Invalid effect" at boot.
  ctx.plugin(mod.GithubLinkHost);
}
