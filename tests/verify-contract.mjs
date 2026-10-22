/**
 * Contract coherence: the client must only call routes the document describes.
 *
 * CONTRACT.md is the single source of truth both halves are written against. A
 * route the client calls but the document never mentions is a trap: the next
 * maintainer reads the contract, "cleans up" an undocumented call, and the
 * feature disappears. This suite fails when that gap appears.
 *
 * It also pins the tool-schema rules that silently removed the agent tool once,
 * and the response fields the review depends on.
 *
 * Run: node tests/verify-contract.mjs
 */
import { readFileSync } from 'node:fs';

const client = readFileSync('client.js', 'utf8');
const contract = readFileSync('CONTRACT.md', 'utf8');
const host = readFileSync('src/host/index.js', 'utf8');

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. every client route is documented ---------------------------- */
{
  const PREFIX = /^\/(local|repos|push|review|accounts|state|settings|contributions|notifications|releases)\b/;
  const paths = new Set(
    [...client.matchAll(/'(\/[a-z][a-zA-Z0-9/_?=&.-]*)'/g)]
      .map((m) => m[1].split('?')[0])
      .filter((p) => PREFIX.test(p)),
  );
  const undocumented = [...paths].filter((p) => !contract.includes(p));
  check('every route the client calls appears in CONTRACT.md',
    undocumented.length === 0,
    undocumented.length ? undocumented.join(', ') : `${paths.size} routes`);
}

/* ---- 2. every documented route exists on the host ------------------- */
{
  /* Only PLUGIN routes count. The document also quotes GitHub's own API
   * (`GET /user`, `POST /repos`) while explaining what the Host calls upstream;
   * those are not registered here and must not be reported as phantom. */
  const GITHUB_API = new Set(['/user', '/repos', '/rate_limit', '/graphql', '/notifications']);
  const documented = new Set(
    [...contract.matchAll(/`(?:GET|POST|DELETE|PUT)\s+(\/[a-z][a-zA-Z0-9/_-]*)`/g)]
      .map((m) => m[1])
      .filter((p) => !GITHUB_API.has(p)),
  );
  const hostPaths = new Set(
    [...host.matchAll(/^\s{4}(?:get|post|del|delete|put)\('([^']+)'/gm)].map((m) => m[1]),
  );
  const phantom = [...documented].filter((p) => !hostPaths.has(p));
  check('every route the contract documents exists on the host',
    phantom.length === 0,
    phantom.length ? phantom.join(', ') : `${documented.size} documented`);
}

/* ---- 3. the tool schema stays inside the supported subset ----------- */
{
  const code = host
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('no type arrays in tool schemas', (code.match(/type:\s*\[/g) || []).length === 0);
  check('no anyOf in tool schemas', (code.match(/\banyOf\s*:/g) || []).length === 0);
  check('CONTRACT documents the schema subset',
    contract.includes('additionalProperties') && contract.includes('anyOf'));
}

/* ---- 4. the review response carries its scope ----------------------- */
{
  check('CONTRACT documents review scope', contract.includes("scope: 'working' | 'outgoing'"));
  check('the host returns scope', host.includes("scope: changes.scope === 'outgoing'"));
  check('the host returns outgoingCommits', host.includes('outgoingCommits:'));
  // 1.0.1: the tool no longer returns findings/scope — it raises a request the
  // user must confirm. The scope is still returned by /review/run itself.
  check('the review gate routes exist',
    host.includes("get('/review/pending'") && host.includes("post('/review/pending/clear'"));
}

/* ---- 5. the release payload carries assets -------------------------- */
{
  const github = readFileSync('src/host/github.js', 'utf8');
  check('mapRelease maps assets', github.includes('assets: Array.isArray(release.assets)'));
  check('CONTRACT documents release assets', contract.includes('downloadUrl'));
  check('an asset delete route exists', host.includes("post('/releases/asset/delete'"));
}

/* ---- 6. the UI defects the review found stay fixed ------------------ */
{
  // A comment that swallowed the request body made delete impossible.
  check('the delete request body is not inside a comment',
    !/\/\/[^\n]*body:\s*\{\s*owner: repo\.owner/.test(client));
  check('both delete entry points send confirm: true',
    (client.match(/body: \{ owner: repo\.owner, name: repo\.name, confirm: true \}/g) || []).length === 2);
  // A callback nobody passes crashed the first card click in Settings.
  check('the settings card never calls an unpassed prop',
    !client.includes('props.onOpenManage'));
  // A label that promised staging while only toggling commit inclusion.
  check('the per-file button does not claim to stage',
    !client.includes("file.staged ? t('tabUnstage') : t('tabStage')"));
  check('it describes inclusion instead', client.includes("t('tabPickInclude')"));
  // Asset feedback was set but never rendered.
  check('asset feedback is rendered', client.includes('actionNotice ? h('));
}

/* ---- 7. topics use their own endpoint, never the repo PATCH --------- */
{
  const github = readFileSync('src/host/github.js', 'utf8');
  const code = github
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // GitHub ignores `topics` in PATCH /repos/{o}/{n}: sending it there returned
  // 200 and changed nothing, which looked like a successful save.
  check('a dedicated topics call exists', github.includes('export async function setTopics'));
  check('it targets the /topics endpoint', code.includes("'/topics'"));
  check('topics are NOT put in the repository PATCH body',
    !code.includes('body.topics ='));
  check('updateRepo delegates topics to it', code.includes('if (wantsTopics)'));
  // The refetch lives in the service, not the client module.
  check('a topics-only update still returns a full repo',
    host.includes('const refreshed = await fetchRepoDetail'));
}

/* ---- 8. release edit must not collide on `name` --------------------- */
{
  // `name` is the repository; the release title needs its own key. A duplicate
  // key in the payload object silently replaced the repo name, so every save of
  // an existing release hit a non-existent repository.
  const releaseCall = client.slice(
    client.indexOf("mutate('/repos/release/update'"),
    client.indexOf("}, { label: t('releaseSave') });") + 40,
  );
  const nameKeys = (releaseCall.match(/^\s{12}name,/gm) || []).length;
  check('the release update payload has exactly one `name` key', nameKeys === 1, `${nameKeys}`);
  check('the release title travels as releaseName',
    releaseCall.includes('releaseName: releaseDraft.name'));
  check('the host reads releaseName', host.includes('optionalString(body.releaseName)'));
  check('CONTRACT documents releaseName', contract.includes('releaseName'));

  // The same collision existed one layer down: spreading the patch into an
  // object that already had `name` put the release TITLE into the repo path.
  check('the service never spreads the patch over the repo name',
    !host.includes('updateRelease({ token: account.token, owner, name, id, ...patch })'));
  check('updateRelease takes the repository as `repo`',
    host.includes('repo: name,'));
  check('updateRelease takes the title as `title`',
    host.includes('title: patch.name,'));
  const githubSrc = readFileSync('src/host/github.js', 'utf8');
  check('the PATCH URL uses the repository, not the title',
    githubSrc.includes('repoPath(options.owner, options.repo)'));
}

/* ---- 9. client module identity must match the package name --------- */
{
  /* The browser module loader keys client modules by PACKAGE NAME. The doc is
   * explicit: "the browser artifact registers a lazy factory whose id equals
   * the package name".
   *
   * This shipped broken once: the package was renamed `dsh-harness-push` for
   * npm while the bundle still registered `dsh-push`. The Host half stayed
   * active, so the plugin looked enabled, but the client module registered
   * under an id nobody resolved and EVERY surface disappeared — settings page,
   * sidebar icon and workspace tab.
   */
  const pkg = JSON.parse(readFileSync('package.json', 'utf8').replace(/^\uFEFF/, ''));
  const bundleId = (/id:\s*'([^']+)'/.exec(client) || [])[1];
  check('the client module id equals the package name',
    bundleId === pkg.name, `${bundleId} vs ${pkg.name}`);

  // The patch row name is the module SPECIFIER the loader resolves. It may be
  // the installed alias rather than the manifest name, but it must exist.
  const patchText = readFileSync('cordis.patch.yml', 'utf8');
  const rowName = (/^\s+name:\s*(\S+)\s*$/m.exec(patchText) || [])[1];
  check('the patch declares a module row', Boolean(rowName), rowName);

  // One row only: a second row would mount the Host half twice.
  const rows = (patchText.match(/^\s+- id:\s*\S+/gm) || []).length;
  check('the patch inserts exactly one row', rows === 1, String(rows));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
