/**
 * Regression tests for the two 1.0.1 fixes.
 *
 * 1. An agent must never run a review on its own. It raises a request, the panel
 *    opens the ordinary review dialog, and the user picks the items. Before
 *    this, an agent asked to "push" ran the review repeatedly and silently — a
 *    safety step the user could not see or steer.
 *
 * 2. Language bar colours come from the language NAME (GitHub's own colours),
 *    not from the segment's position. Position-based colouring made the first
 *    segment black and everything after it meaningless.
 *
 * Run: node tests/verify-review-gate.mjs
 */
import { readFileSync } from 'node:fs';

const client = readFileSync('client.js', 'utf8');
const host = readFileSync('src/host/index.js', 'utf8');

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- A. the agent cannot run a review directly --------------------- */
{
  // The tool case must raise a request instead of calling reviewRun.
  const toolCase = host.slice(
    host.indexOf("case 'review': {"),
    host.indexOf('default:', host.indexOf("case 'review': {")),
  );
  check('the review tool raises a request', toolCase.includes('#raiseReviewRequest('));
  check('the review tool does NOT call reviewRun', !toolCase.includes('reviewRun('));
  check('it tells the model to wait', toolCase.includes('reviewRequest'));

  check('a pending-request slot exists', host.includes('#reviewRequest = null'));
  check('a second request is refused, not queued',
    host.includes("status: 'already_pending'"));
  check('the host exposes /review/pending', host.includes("get('/review/pending'"));
  check('the host exposes a clear route', host.includes("post('/review/pending/clear'"));
  check('clearing frees the slot', host.includes('this.#reviewRequest = null;'));

  // Client: poll → open dialog → seed → clear.
  check('the panel polls for a pending request', client.includes("'/review/pending?path='"));
  check('a pending request opens the dialog', client.includes('setReviewOpen(true)'));
  check('the dialog is seeded from the request', client.includes('props.pending'));
  check('closing the dialog clears the request',
    client.includes("'/review/pending/clear'"));
  check('the dialog says an agent asked', client.includes("t('rvAgentAsked')"));
}

/* ---- B. language colours are identity colours ---------------------- */
{
  const start = client.indexOf('const LANG_COLOR_MAP = [');
  const end = client.indexOf('\n/**\n * The proportion bar pinned');
  const body = client.slice(start, end);
  const langColor = new Function(`${body}\nreturn langColor;`)();

  const known = [
    ['JavaScript', '#F1E05A'],
    ['TypeScript', '#3178C6'],
    ['Python', '#3572A5'],
    ['HTML', '#E34C26'],
    ['CSS', '#563D7C'],
    ['Go', '#00ADD8'],
    ['Rust', '#DEA584'],
    ['Vue', '#41B883'],
    ['Shell', '#89E051'],
  ];
  const wrong = known.filter(([name, hex]) => langColor(name).toUpperCase() !== hex);
  check('known languages use GitHub colours', wrong.length === 0,
    wrong.map(([n]) => n).join(','));

  check('unknown languages are stable', langColor('Zorp') === langColor('Zorp'));
  check('two unknown languages differ', langColor('Zorp') !== langColor('Quux'));
  check('lowercase resolves', langColor('javascript') === '#F1E05A');
  check('an alias resolves', langColor('ts') === '#3178C6');

  // The old implementation assigned by position; that must be gone.
  check('no position-based palette remains', !client.includes('LANG_TONES'));
  check('no data-tone segments remain', !client.includes("'data-tone'"));
  check('segments paint from the language name',
    client.includes('background: langColor(item.name)'));
  check('the legend dot paints from the name too',
    client.includes('style: { background: langColor(item.name) }'));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
