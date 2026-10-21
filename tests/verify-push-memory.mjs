/**
 * End-to-end check for the per-branch push memory, through the real store.
 *
 * This is the behaviour the user asked for in words: "每一个 git 分支在推送一次
 * 过后，下一次在同一 git 内要能够有记忆能力，自动选择上一次的仓库". So the
 * assertions here are about the observable promise, not the storage layout:
 *   1. remembering a target for a branch is visible on the next read,
 *   2. the SAME repository written three different ways finds that one entry,
 *   3. a second store instance (a restart) still sees it,
 *   4. a different branch is independent,
 *   5. forgetting removes only that branch.
 *
 * Run: node tests/verify-push-memory.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GithubLinkStore, normalizeRepoRoot, pushMemoryKey } from '../src/host/store.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const home = await mkdtemp(path.join(tmpdir(), 'push-mem-'));

try {
  /* ---- 1. a remembered target is readable back ---------------------- */
  const repo = 'C:\\work\\demo';
  const store = new GithubLinkStore({ home });
  await store.rememberPushTarget(repo, 'main', {
    remote: 'origin', owner: 'alice', repo: 'demo', ref: 'main',
    at: '2026-01-01T00:00:00.000Z',
  });
  const got = await store.pushMemoryFor(repo, 'main');
  check('a remembered target is returned for its branch',
    got && got.owner === 'alice' && got.repo === 'demo', JSON.stringify(got));

  /* ---- 2. key normalization: three spellings, one entry ------------ */
  const spellings = ['C:\\work\\demo', 'C:/work/demo', 'c:\\work\\demo\\'];
  const keys = spellings.map((p) => pushMemoryKey(normalizeRepoRoot(p), 'main'));
  check('the same repo written three ways collides to one key',
    new Set(keys).size === 1, keys.join(' | '));
  for (const variant of spellings) {
    const hit = await store.pushMemoryFor(variant, 'main');
    check(`spelling ${variant} finds the same memory`, Boolean(hit), JSON.stringify(hit));
  }

  /* ---- 3. a restart (new instance) still sees it ------------------- */
  const reopened = new GithubLinkStore({ home });
  const afterRestart = await reopened.pushMemoryFor(repo, 'main');
  check('a new store instance reads the same memory', Boolean(afterRestart));

  /* ---- 4. branches are independent -------------------------------- */
  await reopened.rememberPushTarget(repo, 'release', {
    remote: 'fork', owner: 'bob', repo: 'demo', ref: 'release',
    at: '2026-01-02T00:00:00.000Z',
  });
  const mainAgain = await reopened.pushMemoryFor(repo, 'main');
  const release = await reopened.pushMemoryFor(repo, 'release');
  check('branches do not overwrite each other',
    mainAgain.remote === 'origin' && release.remote === 'fork',
    `main=${mainAgain.remote} release=${release.remote}`);

  const entries = await reopened.pushMemoryEntries(repo);
  check('all branches are listed for one repo', entries.length === 2, `n=${entries.length}`);

  /* ---- 5. forgetting is per branch -------------------------------- */
  await reopened.forgetPushTarget(repo, 'release');
  const afterForget = await reopened.pushMemoryEntries(repo);
  check('forget removes only the named branch',
    afterForget.length === 1 && afterForget[0].branch === 'main',
    JSON.stringify(afterForget.map((e) => e.branch)));

  /* ---- 6. a corrupt table degrades instead of throwing ------------ */
  await writeFile(path.join(home, 'push', 'state.json'), JSON.stringify({
    version: 1,
    accounts: [],
    activeAccountId: null,
    settings: {},
    pushMemory: ['not', 'an', 'object'],
  }), 'utf8');
  const corrupt = new GithubLinkStore({ home });
  let survived = true;
  let empty = false;
  try {
    const list = await corrupt.pushMemoryEntries(repo);
    empty = Array.isArray(list) && list.length === 0;
  } catch {
    survived = false;
  }
  check('a corrupt pushMemory table does not throw', survived);
  check('a corrupt pushMemory table degrades to empty', empty);

  /* ---- 7. an absent table behaves the same ------------------------ */
  await writeFile(path.join(home, 'push', 'state.json'), JSON.stringify({
    version: 1, accounts: [], activeAccountId: null, settings: {},
  }), 'utf8');
  const absent = new GithubLinkStore({ home });
  const missing = await absent.pushMemoryFor(repo, 'main');
  check('an absent pushMemory table reads as no memory', missing === undefined || missing === null,
    JSON.stringify(missing));
} finally {
  await rm(home, { recursive: true, force: true });
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
