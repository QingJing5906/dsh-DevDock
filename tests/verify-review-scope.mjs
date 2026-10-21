/**
 * Tests for the review SCOPE fallback (CONTRACT §3d).
 *
 * The review exists for the moment before a push — and at that moment the
 * working tree is usually CLEAN, because the changes were already committed.
 * Before this fallback existed, that case reported "没有检测到待推送的改动" and
 * returned zero findings: a safety feature silently passing exactly the content
 * it was built to inspect.
 *
 * These assertions drive the real collector against throwaway repositories made
 * with the real git, because the bug lived in the git plumbing (which ref is the
 * base? does an upstream exist?) rather than in any pure function.
 *
 * Run: node tests/verify-review-scope.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitRunner } from '../src/host/git.js';
import { collectReviewChanges } from '../src/host/review.js';

const exec = promisify(execFile);
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* This suite drives REAL git, because the defect lived in the git plumbing.
 * A confined DSH sandbox forbids a child process with piped stdio (spawn
 * EPERM), so the suite SKIPS there rather than reporting a failure it cannot
 * actually test. Everywhere else it runs for real. */
try {
  await exec('git', ['--version']);
} catch (error) {
  const code = String((error && error.code) || '');
  const reason = code === 'EPERM' || code === 'ENOENT' ? code : (error && error.message);
  console.log(`skip: cannot spawn git in this environment (${reason})`);
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const dirs = [];

/** Create an empty git repo with an identity configured. */
async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'push-scope-'));
  dirs.push(dir);
  const git = (args) => exec('git', args, { cwd: dir });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  return { dir, git };
}

/** A runner pointed at the temp repo, with no token (local operations only). */
function makeRunner() {
  return new GitRunner({ gitPath: 'git' });
}

try {
  /* ---- 1. clean tree with an unpushed commit is still reviewed ------ */
  {
    const { dir, git } = await makeRepo();
    await writeFile(path.join(dir, 'app.js'), 'const hello = "world";\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);

    const result = await collectReviewChanges(makeRunner(), dir, { maxFiles: 20 });
    check('a clean tree with outgoing commits yields a review', Boolean(result));
    check('the scope is reported as outgoing', result && result.scope === 'outgoing',
      result && result.scope);
    check('the outgoing commit is counted', result && result.range && result.range.count === 1,
      result && result.range && result.range.count);
    check('the committed file is included',
      Boolean(result) && result.files.some((f) => f.path === 'app.js'),
      result && result.files.map((f) => f.path).join(','));
    check('its content is actually sent for review',
      Boolean(result) && result.patch.includes('hello'), result && result.patch.slice(0, 40));
  }

  /* ---- 2. nothing outgoing means nothing to review ----------------- */
  {
    const { dir, git } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'x\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'only']);
    // Point origin/main at HEAD so the branch has nothing left to push.
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['update-ref', 'refs/remotes/origin/main', head]);

    const result = await collectReviewChanges(makeRunner(), dir, { maxFiles: 20 });
    check('a fully pushed branch reports no changes', Boolean(result) && result.files.length === 0,
      result && result.files.length);
    check('that empty result is scoped to the working tree',
      result && result.scope === 'working', result && result.scope);
  }

  /* ---- 3. uncommitted work takes priority over outgoing ------------ */
  {
    const { dir, git } = await makeRepo();
    await writeFile(path.join(dir, 'committed.txt'), 'old\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'base']);
    await writeFile(path.join(dir, 'dirty.txt'), 'new secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n');

    const result = await collectReviewChanges(makeRunner(), dir, { maxFiles: 20 });
    check('an untracked file is what gets reviewed', Boolean(result)
      && result.files.some((f) => f.path === 'dirty.txt'),
    result && result.files.map((f) => f.path).join(','));
    check('the working-tree scope is kept', result && result.scope === 'working',
      result && result.scope);
  }

  /* ---- 4. only outgoing changes, not the whole history ------------- */
  {
    const { dir, git } = await makeRepo();
    await writeFile(path.join(dir, 'old.txt'), 'already pushed\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'old']);
    const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['update-ref', 'refs/remotes/origin/main', base]);

    await writeFile(path.join(dir, 'new.txt'), 'about to be pushed\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'new']);

    const result = await collectReviewChanges(makeRunner(), dir, { maxFiles: 20 });
    check('only the unpushed file is reviewed',
      Boolean(result) && result.files.some((f) => f.path === 'new.txt'),
      result && result.files.map((f) => f.path).join(','));
    check('the already-pushed file is NOT re-reviewed',
      Boolean(result) && !result.files.some((f) => f.path === 'old.txt'),
      result && result.files.map((f) => f.path).join(','));
    check('exactly one outgoing commit is reported',
      result && result.range && result.range.count === 1,
      result && result.range && result.range.count);
  }

  /* ---- 5. a binary file is skipped, not fatal --------------------- */
  {
    const { dir, git } = await makeRepo();
    await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await writeFile(path.join(dir, 'text.txt'), 'readable\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'mixed']);

    const result = await collectReviewChanges(makeRunner(), dir, { maxFiles: 20 });
    check('the text file is still reviewed', Boolean(result)
      && result.files.some((f) => f.path === 'text.txt'),
    result && result.files.map((f) => f.path).join(','));
    const binary = result ? result.files.find((f) => f.path === 'blob.bin') : null;
    check('the binary file is marked skipped rather than failing the run',
      Boolean(binary) && Boolean(binary.skipped), binary && binary.skipped);
  }

  /* ---- 6. an empty repository is a clean no-op -------------------- */
  {
    const { dir } = await makeRepo();
    const result = await collectReviewChanges(makeRunner(), dir, { maxFiles: 20 });
    check('an empty repository returns no files instead of throwing',
      Boolean(result) && result.files.length === 0, result && result.files.length);
  }
} finally {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
