/**
 * Package integrity: what `npm pack` produces must actually load.
 *
 * The dangerous failure mode for a published plugin is "npm installs it, the
 * host imports it, and it dies" — because `files` in package.json decides what
 * ships and `index.js` imports files by path. A missing entry there breaks the
 * install silently, long after tests on the source tree passed.
 *
 * This suite packs the package for real and then imports the packed copy from a
 * temporary directory, so it tests the artifact rather than the checkout.
 *
 * Run: node tests/verify-package.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* npm cannot be spawned with piped stdio inside a confined sandbox. Skip rather
 * than fail, and say why — the suite still runs in CI and on a normal machine. */
let npmVersion = '';
try {
  npmVersion = (await exec('npm', ['--version'], { cwd: pkgDir })).stdout.trim();
} catch (error) {
  const code = String((error && error.code) || '');
  if (code === 'EPERM' || code === 'ENOENT') {
    console.log(`skip: cannot spawn npm here (${code})`);
    console.log('\n0 passed, 0 failed, 1 skipped');
    process.exit(0);
  }
  npmVersion = '(unknown)';
}
console.log(`npm ${npmVersion}`);

const work = await mkdtemp(path.join(tmpdir(), 'push-pack-'));
let tarball;

try {
  /* Pack into a scratch destination: the checkout stays clean and the npm cache
   * lives somewhere writable. */
  const cache = path.join(work, 'cache');
  const out = path.join(work, 'out');
  await exec('npm', ['pack', '--cache', cache, '--pack-destination', out], { cwd: pkgDir });
  const produced = (await readdir(out)).filter((name) => name.endsWith('.tgz'));
  check('npm pack produced exactly one tarball', produced.length === 1, produced.join(','));
  tarball = produced[0] ? path.join(out, produced[0]) : null;

  if (tarball) {
    /* Extract it the way an install would. */
    const unpack = path.join(work, 'unpack');
    await mkdir(unpack, { recursive: true });
    await exec('tar', ['-xzf', tarball, '-C', unpack]);

    const root = path.join(unpack, 'package');
    const toUrl = (rel) => new URL('file:///' + path.join(root, rel).replace(/\\/g, '/')).href;

    /* ---- the entry point and everything it imports ---------------- */
    const entry = await import(toUrl('index.js'));
    check('the packed entry point imports', typeof entry === 'object');
    check('it exports apply()', typeof entry.apply === 'function');

    for (const rel of ['src/host/index.js', 'src/host/git.js', 'src/host/github.js', 'src/host/review.js', 'src/host/store.js']) {
      try {
        await import(toUrl(rel));
        check('packed ' + rel + ' imports', true);
      } catch (error) {
        check('packed ' + rel + ' imports', false, String(error && error.message).slice(0, 100));
      }
    }

    /* ---- the client bundle must be parseable ---------------------- */
    const client = await readFile(path.join(root, 'client.js'), 'utf8');
    check('client.js ships', client.length > 1000, client.length + ' bytes');
    check('its CSS template literal is not broken', (() => {
      const open = client.indexOf('const CSS = `');
      if (open < 0) return false;
      const close = client.indexOf('`;', open);
      if (close < 0) return false;
      return !client.slice(open + 13, close).includes('`');
    })());

    /* ---- metadata a consumer relies on ---------------------------- */
    const packed = JSON.parse((await readFile(path.join(root, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''));
    check('the package is not private', packed.private !== true);
    check('the version is a real one', /^\d+\.\d+\.\d+/.test(String(packed.version)), packed.version);
    check('dsh.bundle.patch resolves inside the package', (() => {
      try {
        readFile(packagePath(root, packed.dsh.bundle.patch));
        return true;
      } catch { return false; }
    })());
    for (const extra of ['README.md', 'LICENSE']) {
      let ok = true;
      try { await readFile(path.join(root, extra)); } catch { ok = false; }
      check(extra + ' ships', ok);
    }

    /* ---- nothing that must not ship ------------------------------- */
    const names = await listAll(root);
    check('no test files ship', !names.some((n) => n.startsWith('tests/')), names.filter((n) => n.startsWith('tests/')).slice(0, 3).join(','));
    check('no tarball ships inside itself', !names.some((n) => n.endsWith('.tgz')));
    check('no local state or secrets ship', !names.some((n) => /(^|\/)(state\.json|\.env)/.test(n)));
  }
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

/** Resolve a package-relative path from a manifest field. */
function packagePath(root, rel) {
  return path.join(root, String(rel).replace(/^\.\//, ''));
}

/** Every file path inside a directory, relative and '/'-separated. */
async function listAll(root, prefix = '') {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) out.push(...await listAll(path.join(root, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
