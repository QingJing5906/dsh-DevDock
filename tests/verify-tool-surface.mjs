/**
 * Regression tests for the agent-tool surface (CONTRACT §4).
 *
 * Three defects shipped and were found only by actually calling the tool from a
 * model turn. Each one is silent from the panel's point of view, which is why
 * they are pinned here:
 *
 *   1. The tool's output schema used `type: ['string','null']` and later
 *      `anyOf`. The host validates schemas against a SUBSET that supports
 *      neither, so registration threw and `github_link` NEVER reached the
 *      model. The panel worked perfectly; the agent simply had no tool.
 *
 *   2. Review findings carry `undefined` for absent file/line/suggestion, and
 *      the tool layer rejects a value that is not lossless JSON. The review ran
 *      correctly and then failed to report ("value is not lossless JSON").
 *
 *   3. git's smart-HTTP transport authenticates with HTTP BASIC. The plugin
 *      sent `Authorization: Bearer`, which the git endpoint rejects with a 401;
 *      git fell back to its credential prompt and every push died with
 *      "could not read Password" — while the REST API accepted the same token.
 *
 * Run: node tests/verify-tool-surface.mjs
 */
import { readFileSync } from 'node:fs';
import { authEnv, redact } from '../src/host/git.js';

const host = readFileSync('src/host/index.js', 'utf8');
const git = readFileSync('src/host/git.js', 'utf8');

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. schema must stay inside the supported subset ---------------- */
{
  // The two tool schemas are the only schema literals in the file. Comments are
  // stripped first: a comment explaining why a type array is illegal would
  // otherwise fail this very check.
  const code = host
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const typeArrays = code.match(/type:\s*\[/g) || [];
  check('no type arrays anywhere in the tool schemas', typeArrays.length === 0,
    `found ${typeArrays.length}`);

  const anyOf = code.match(/\banyOf\s*:/g) || [];
  check('no anyOf in the tool schemas (unsupported keyword)', anyOf.length === 0,
    `found ${anyOf.length}`);

  const allOf = code.match(/\ballOf\s*:/g) || [];
  check('no allOf in the tool schemas', allOf.length === 0, `found ${allOf.length}`);

  // The action enum must advertise every action toolCall actually handles.
  const enumMatch = /enum: \[([^\]]+)\]/.exec(host);
  check('the action enum exists', Boolean(enumMatch));
  const declared = enumMatch
    ? enumMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : [];
  const handled = [...host.matchAll(/case '([a-z_]+)': \{/g)].map((m) => m[1]);
  const missing = handled.filter((name) => !declared.includes(name));
  check('every handled action is declared in the enum', missing.length === 0,
    missing.length ? `undeclared: ${missing.join(', ')}` : `${declared.length} actions`);

  const extra = declared.filter((name) => !handled.includes(name));
  check('every declared action is implemented', extra.length === 0,
    extra.length ? `unimplemented: ${extra.join(', ')}` : 'all implemented');
}

/* ---- 2. the review tool asks, it does not run ---------------------- */
{
  // 1.0.1: an agent may no longer execute a review on its own. The tool
  // records a request and the panel opens the dialog; the user decides what
  // gets inspected. The old assertions here pinned the projection of a
  // RESULT, which the tool no longer produces.
  const toolCase = host.slice(
    host.indexOf("case 'review': {"),
    host.indexOf('default:', host.indexOf("case 'review': {")),
  );
  check('the review tool returns a request, not findings',
    toolCase.includes('reviewRequest') && !toolCase.includes('findings'));
  check('it does not call reviewRun directly', !toolCase.includes('reviewRun('));
  check('a pending request is recorded', host.includes('#raiseReviewRequest('));
  check('a duplicate request is refused', host.includes("status: 'already_pending'"));
  check('leaving the dialog frees the slot',
    host.includes('this.#reviewRequest = null;'));
}
/* ---- 3. git auth must use the scheme the transport accepts ---------- */
{
  const env = authEnv('ghp_example_token_value_123456', {});
  const count = Number(env.GIT_CONFIG_COUNT);
  check('authEnv publishes git config through the environment', Number.isFinite(count) && count > 0,
    `count=${env.GIT_CONFIG_COUNT}`);

  const pairs = [];
  for (let i = 0; i < count; i += 1) {
    pairs.push([env['GIT_CONFIG_KEY_' + i], env['GIT_CONFIG_VALUE_' + i]]);
  }
  const header = (pairs.find(([k]) => k === 'http.extraheader') || [])[1] || '';
  check('it sets an Authorization header', header.includes('Authorization:'));
  check('it uses HTTP Basic, which the git transport accepts',
    header.includes('Authorization: Basic '), header.slice(0, 40));
  check('it does NOT use Bearer, which the git transport rejects',
    !header.includes('Bearer'));

  const b64 = header.split('Basic ')[1] || '';
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  check('the decoded pair carries the token', decoded.endsWith(':ghp_example_token_value_123456'));
  check('the decoded username is x-access-token', decoded.startsWith('x-access-token:'));
  check('the credential helper is disabled',
    pairs.some(([k, v]) => k === 'credential.helper' && v === ''));

  /* The whole point of the environment carrier: no process listing can see it. */
  check('the raw token never appears in the environment values',
    !Object.values(env).some((v) => String(v).includes('ghp_example_token_value_123456')));
  // Comments legitimately mention the old form; only real code matters.
  const gitCode = git.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('no argv carries the credential any more',
    !gitCode.includes('http.extraheader=Authorization'));
  check('every network command receives the auth environment',
    git.includes('env: authEnv(options.token, { username: options.username })'));
}

/* ---- 4. redaction must cover whatever scheme is in use -------------- */
{
  const basic = redact('Authorization: Basic YWJjOjEyMzQ1Njc4OTA=');
  check('a Basic header is redacted', !basic.includes('YWJjOjEyMzQ1Njc4OTA='), basic);

  const bearer = redact('Authorization: Bearer abcdefghijklmnopqrst');
  check('a Bearer header is still redacted', !bearer.includes('abcdefghijklmnopqrst'), bearer);

  // The scheme itself is useful context and should survive.
  check('the scheme name is kept for diagnosis', basic.includes('Basic'));

  // Known token shapes are caught even without the header.
  check('a bare ghp_ token is redacted',
    !redact('token=ghp_abcdefghijklmnopqrstuvwx').includes('ghp_abcdefghijklmnopqrstuvwx'));
  check('a bare pat token is redacted',
    !redact('github_pat_abcdefghijklmnopqrstuvwx').includes('github_pat_abcdefghijklmnopqrstuvwx'));

  // A PEM block is a credential too, and the README promises it is covered.
  const pem = redact('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----');
  check('a PEM private key block is redacted',
    !pem.includes('b3BlbnNzaC1rZXk'), pem.slice(0, 40));
}

/* ---- 5. failures must be observable, not silent --------------------- */
{
  check('a registration failure is RECORDED, not only logged',
    host.includes('toolRegistration = {') && host.includes('registered: false'));
  check('a registration success is recorded too',
    host.includes('registered: true'));
  check('a diagnostics route exists for operators',
    host.includes("get('/diagnostics'"));
  check('diagnostics reports a live visibility probe',
    host.includes("tools.get('github_link')"));
  // The removal path must also clear the flag, or a reload would keep claiming
  // the tool is registered when it is gone.
  check('disposal clears the registered flag',
    /registered: false/.test(host) && host.includes("toolRegistration = { attempted: true, registered: false"));
}

/* ---- 6. the same defect class must not exist in the client ---------- */
{
  const client = readFileSync('client.js', 'utf8');
  // A hook inside a conditional branch broke the whole tab once; the review
  // state must be declared at the component prologue.
  const prologue = client.indexOf('const [reviewOpen, setReviewOpen] = useState(false);');
  const firstReturn = client.indexOf("      /* ── no workspace path:");
  check('the review state is declared above every early return',
    prologue > 0 && (firstReturn < 0 || prologue < firstReturn));
  check('no hook sits inside the not-a-repo branch',
    !client.includes("        const resolved = (props.scope && (props.scope.repoRoot || props.scope.cwd)) || cwd;\n      // Pre-push review"));
  // 1.0.1: colours come from the LANGUAGE NAME (GitHub identity colours),
  // not from the segment position, which painted the first one black.
  check('language segments paint from the language name',
    client.includes('background: langColor(item.name)'));
  check('the position-based palette is gone', !client.includes('LANG_TONES'));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
