/**
 * Tests for the pre-push review engine's rule pass (CONTRACT §3d).
 *
 * The rule pass is the floor the whole feature stands on: it runs even with no
 * model available, so a bug here means a real token can be pushed while the
 * panel says "no findings". These assertions are about the two properties that
 * matter: it must FIND the credential, and it must never echo it back.
 *
 * Run: node tests/verify-review-rules.mjs
 */
import {
  BUILTIN_PRESETS,
  REVIEW_CATEGORIES,
  parseModelJson,
  normalizeFinding,
  scanSecrets,
  sortFindings,
} from '../src/host/review.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. each credential shape is detected ------------------------- */
const samples = {
  'GitHub 经典令牌': 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";',
  'GitHub 细粒度令牌': 'token: "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"',
  'OpenAI API Key': 'apiKey = "sk-abcdefghijklmnopqrstuvwxyz0123456789"',
  'AWS Access Key': 'aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"',
  'Slack 令牌': 'slack = "xoxb-1234567890-abcdefghijkl"',
  '私钥块': '-----BEGIN RSA PRIVATE KEY-----',
  'Authorization 头': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
};
for (const [label, line] of Object.entries(samples)) {
  const found = scanSecrets(line, { file: 'a.js' });
  check(`detects ${label}`, found.length === 1, `got ${found.length}`);
  if (found.length === 1) {
    check(`  ${label}: severity is blocker`, found[0].severity === 'blocker', found[0].severity);
    check(`  ${label}: category is secrets`, found[0].category === 'secrets', found[0].category);
    check(`  ${label}: reports the file`, found[0].file === 'a.js', found[0].file);
    check(`  ${label}: reports a line`, found[0].line === 1, String(found[0].line));
  }
}

/* ---- 2. the secret itself never appears in the finding ------------ */
{
  const lines = Object.values(samples).join('\n');
  const found = scanSecrets(lines, { file: 'a.js' });
  const serialized = JSON.stringify(found);
  const leaked = [
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'github_pat_11ABCDEFG',
    'sk-abcdefghijklmnop',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890',
    'abcdefghijklmnopqrstuvwxyz012345',
  ].filter((secret) => serialized.includes(secret));
  check('no raw secret appears anywhere in the findings', leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${found.length} findings, clean`);
  check('every finding has a Chinese explanation',
    found.every((f) => f.detail && f.detail.includes('行')), `n=${found.length}`);
}

/* ---- 3. placeholders are NOT reported ----------------------------- */
{
  const benign = [
    'password = "REPLACE_ME"',
    'token: "<your-token-here>"',
    'secret = "xxxxxxxxxxxx"',
    'const apiKey = "example"',
    '// 这里不要写 token',
    'const normalVariable = "just a string";',
  ].join('\n');
  const found = scanSecrets(benign, { file: 'b.js' });
  check('obvious placeholders are not reported as leaks', found.length === 0,
    found.map((f) => `${f.title}@${f.line}`).join(', '));
}

/* ---- 4. already-redacted text is not re-reported ------------------ */
{
  const found = scanSecrets('Authorization: Bearer ********************', { file: 'c.js' });
  check('already-redacted values are skipped', found.length === 0, `n=${found.length}`);
}

/* ---- 5. line numbers are accurate across a block ------------------ */
{
  const block = ['line one', 'line two', 'const t = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";', 'line four'].join('\n');
  const found = scanSecrets(block, { file: 'd.js' });
  check('the reported line matches the real line', found.length === 1 && found[0].line === 3,
    found.length ? String(found[0].line) : 'none');
}

/* ---- 6. built-in presets are complete and specific ----------------- */
{
  check('there are at least 8 built-in presets', BUILTIN_PRESETS.length >= 8, String(BUILTIN_PRESETS.length));
  check('every preset has a non-trivial prompt',
    BUILTIN_PRESETS.every((p) => typeof p.prompt === 'string' && p.prompt.length > 40),
    BUILTIN_PRESETS.map((p) => `${p.id}:${(p.prompt || '').length}`).join(' '));
  check('every preset has a title and description',
    BUILTIN_PRESETS.every((p) => p.title && p.description));
  const covered = new Set(BUILTIN_PRESETS.map((p) => p.category));
  for (const category of ['secrets', 'privacy', 'integrity', 'quality']) {
    check(`category ${category} has at least one preset`, covered.has(category), [...covered].join(','));
  }
  check('category metadata covers every preset category',
    BUILTIN_PRESETS.every((p) => REVIEW_CATEGORIES.some((c) => c.id === p.category)));
  check('preset ids are unique',
    new Set(BUILTIN_PRESETS.map((p) => p.id)).size === BUILTIN_PRESETS.length);
}

/* ---- 7. model JSON parsing is tolerant ---------------------------- */
{
  const plain = parseModelJson('{"findings":[{"severity":"high","title":"x"}],"summary":"s"}');
  check('parses a bare JSON object', plain.findings.length === 1 && plain.summary === 's');

  const fenced = parseModelJson('```json\n{"findings":[],"summary":"ok"}\n```');
  check('parses a fenced JSON object', fenced.summary === 'ok', fenced.summary);

  const chatty = parseModelJson('Here you go:\n{"findings":[],"summary":"fine"}\nHope that helps.');
  check('parses JSON surrounded by prose', chatty.summary === 'fine', chatty.summary);

  const prose = parseModelJson('I could not find anything wrong with this change.');
  check('falls back to prose as the summary', prose.findings.length === 0
    && prose.summary.includes('could not find'), prose.summary);

  const broken = parseModelJson('{"findings": [');
  check('unparseable input does not throw', broken.findings.length === 0);
}

/* ---- 8. findings are normalized and sorted ------------------------ */
{
  const normalized = normalizeFinding({
    severity: 'catastrophic', category: '', title: '', detail: 'd', line: 'nope',
  });
  check('an unknown severity degrades to medium', normalized.severity === 'medium', normalized.severity);
  check('an unknown category degrades to quality', normalized.category === 'quality', normalized.category);
  check('a missing title gets a placeholder', normalized.title === '未命名问题', normalized.title);
  check('a non-numeric line is dropped', normalized.line === undefined);

  const sorted = sortFindings([
    { severity: 'low', file: 'b' },
    { severity: 'blocker', file: 'z' },
    { severity: 'high', file: 'a' },
    { severity: 'info', file: 'a' },
  ]);
  check('findings sort most severe first',
    sorted[0].severity === 'blocker' && sorted[sorted.length - 1].severity === 'info',
    sorted.map((f) => f.severity).join(','));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
