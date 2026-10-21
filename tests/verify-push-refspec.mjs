/**
 * Regression test for version-pinned push refspec construction.
 *
 * What this pins (all observed behaviour, not intentions):
 *  1. a branch push keeps its historical `--set-upstream origin <b>:<b>` shape,
 *     so ordinary pushes did not change;
 *  2. a sha source becomes `<sha>:<branch>` — that refspec is the ONLY way git
 *     will push a commit that is not the tip of a branch;
 *  3. a tag source becomes `<tag>:<branch>`;
 *  4. a sha with NO destination branch is rejected BEFORE any network call,
 *     with a Chinese message — git would otherwise spend the full timeout
 *     reaching a remote that then refuses the refspec.
 *
 * The repository is created by the CALLER and passed as argv, because this
 * sandbox denies the pipe-based `spawnSync`/`execFile` a fixture builder would
 * need. GitRunner itself spawns through its own fallback path, which is the
 * code under test.
 *
 * Run: node tests/verify-push-refspec.mjs <repoPath> <sha> <branch>
 */
import { GitRunner } from '../src/host/git.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const repo = process.argv[2];
const sha = process.argv[3];
const branch = process.argv[4];
if (!repo || !sha || !branch) {
  console.error('usage: verify-push-refspec.mjs <repoPath> <sha> <branch>');
  process.exit(2);
}

const runner = new GitRunner({});

/** Run one push and return the error it raised (argv lives on it). */
async function attempt(options) {
  try {
    await runner.push(repo, options);
    return { threw: null, args: [] };
  } catch (error) {
    return { threw: error, args: Array.isArray(error.args) ? error.args : [] };
  }
}

/* ---- 1. branch push keeps the historical shape ------------------- */
{
  const { threw, args } = await attempt({ remote: 'origin', branch });
  const refspec = args[args.length - 1];
  check('a branch push ends in <branch>:<branch>',
    refspec === `${branch}:${branch}`, JSON.stringify(args));
  check('a branch push sets upstream', args.includes('--set-upstream'), JSON.stringify(args));
  check('the branch push reached git (not pre-rejected)',
    Boolean(threw) && threw.code === 'GIT_FAILED', threw && threw.code);
}

/* ---- 2. a sha source becomes <sha>:<branch> --------------------- */
{
  const { threw, args } = await attempt({ remote: 'origin', branch, source: sha });
  const refspec = args[args.length - 1];
  check('a sha push ends in <sha>:<branch>', refspec === `${sha}:${branch}`, JSON.stringify(args));
  check('a sha push does NOT set upstream', !args.includes('--set-upstream'), JSON.stringify(args));
  check('a sha push reached git', Boolean(threw) && threw.code === 'GIT_FAILED', threw && threw.code);
}

/* ---- 3. a tag source becomes <tag>:<branch> --------------------- */
{
  const { threw, args } = await attempt({ remote: 'origin', branch, source: 'v1.0' });
  const refspec = args[args.length - 1];
  check('a tag push ends in <tag>:<branch>', refspec === `v1.0:${branch}`, JSON.stringify(args));
  check('a tag push reached git', Boolean(threw) && threw.code === 'GIT_FAILED', threw && threw.code);
}

/* ---- 4. a sha with no destination is refused before the network -- */
{
  const { threw, args } = await attempt({ remote: 'origin', source: sha });
  check('a sha with no destination branch is BAD_REQUEST',
    Boolean(threw) && threw.code === 'BAD_REQUEST', threw && threw.code);
  check('the rejection never spawned git', args.length === 0, JSON.stringify(args));
  check('the rejection explains the fix in Chinese',
    Boolean(threw) && threw.message.includes('目标分支'), threw ? threw.message.slice(0, 40) : '');
  check('the rejection names the commit',
    Boolean(threw) && threw.message.includes(sha.slice(0, 8)), threw ? threw.message.slice(0, 40) : '');
}

/* ---- 5. a hex-looking source WITH a destination still refspecs ---- */
{
  const { args } = await attempt({ remote: 'origin', branch, source: 'abc123' });
  check('a hex-looking source with a destination still gets a refspec',
    args[args.length - 1] === `abc123:${branch}`, JSON.stringify(args));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
