/**
 * Regression test for repository deletion semantics.
 *
 * The bug this pins: `deleteRepo` treated a 404 from GitHub as success. That
 * looks reasonable ("already deleted") but GitHub returns 404 for a repo the
 * caller cannot see just as often as for one that is gone — so deleting a
 * repository that never existed, or one the token could not reach, reported
 * `{deleted:true}` and told the user their repository had been removed. A
 * false success on an irreversible action is the worst possible answer.
 *
 * The module talks to GitHub over `node:https`, so this test starts a REAL
 * scripted HTTP server, points `DSH_PUSH_API_BASE` at it, and lets the client
 * run its own request path. Status codes, headers and body decoding are all
 * exercised for real; nothing about the transport is stubbed.
 *
 * Note: `github.js` uses `https.request`, so the scripted server is an HTTPS
 * server with a self-signed certificate that the client is told to accept
 * only for this test process (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
 *
 * Run: node tests/verify-delete-semantics.mjs
 */
import { createServer } from 'node:http';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/** Scripted responses, consumed in order; the last one repeats. */
let script = [];
let callIndex = 0;
const calls = [];

const server = createServer((req, res) => {
  calls.push({ method: req.method, url: req.url });
  const spec = script[Math.min(callIndex, script.length - 1)] || { status: 500 };
  callIndex += 1;
  req.resume();
  res.writeHead(spec.status, { 'content-type': 'application/json' });
  res.end(spec.body ? JSON.stringify(spec.body) : '');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// Point the module at the local server BEFORE importing it: `API_BASE` is
// read once at module load.
process.env.DSH_PUSH_API_BASE = `http://127.0.0.1:${port}`;

const { deleteRepo } = await import('../src/host/github.js');

const base = { token: 'ghp_test_token_value', owner: 'octo', name: 'hello' };

/** Run one scenario, returning the thrown error (or null) plus the result. */
async function scenario(responses, run = () => deleteRepo(base)) {
  calls.length = 0;
  callIndex = 0;
  script = responses;
  try {
    return { threw: null, result: await run() };
  } catch (error) {
    return { threw: error, result: null };
  }
}

/* ---- 1. a real 204 is success ------------------------------------- */
{
  const { threw, result } = await scenario([{ status: 204 }]);
  check('204 reports deleted', !threw && result && result.deleted === true,
    threw ? threw.message : JSON.stringify(result));
  check('204 makes exactly one request', calls.length === 1, `${calls.length} calls`);
  check('the delete used DELETE', calls[0] && calls[0].method === 'DELETE', calls[0] && calls[0].method);
}

/* ---- 2. 404 + repo unreadable is a FAILURE, not success ------------ */
{
  const { threw } = await scenario([{ status: 404 }, { status: 404 }]);
  check('404 + unreadable throws instead of reporting success', Boolean(threw),
    threw ? String(threw.message).slice(0, 40) : 'returned success');
  check('the failure names the repo', threw && String(threw.message).includes('octo/hello'));
  check('the failure is NOT_FOUND', threw && threw.code === 'NOT_FOUND', threw && threw.code);
  check('it verified readability before deciding', calls.length === 2, `${calls.length} calls`);
  check('readability probe used GET', calls[1] && calls[1].method === 'GET', calls[1] && calls[1].method);
}

/* ---- 3. 404 but the repo IS readable: genuine no-op delete ---------- */
{
  const { threw, result } = await scenario([
    { status: 404 },
    { status: 200, body: { full_name: 'octo/hello' } },
  ]);
  check('404 + still-readable still reports deleted', !threw && result && result.deleted === true,
    threw ? threw.message : JSON.stringify(result));
}

/* ---- 4. a permission failure keeps its actionable message ---------- */
{
  const { threw } = await scenario([{ status: 403 }]);
  check('403 throws', Boolean(threw));
  check('403 explains delete_repo', threw && String(threw.message).includes('delete_repo'),
    threw ? String(threw.message).slice(0, 40) : '');
  check('403 is UNAUTHORIZED', threw && threw.code === 'UNAUTHORIZED', threw && threw.code);
}

/* ---- 5. the token never appears in any message -------------------- */
{
  const { threw } = await scenario([{ status: 404 }, { status: 404 }]);
  const message = String(threw && threw.message);
  check('the token is not echoed in the failure message',
    !message.includes('ghp_test_token_value'), message.slice(0, 50));
}

/* ---- 6. an unreachable server is NETWORK, never a silent success --- */
{
  await new Promise((resolve) => server.close(resolve));
  calls.length = 0;
  let threw = null;
  try {
    await deleteRepo(base);
  } catch (error) {
    threw = error;
  }
  check('an unreachable host throws', Boolean(threw));
  check('an unreachable host is NETWORK', threw && threw.code === 'NETWORK', threw && threw.code);
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
