/**
 * Regression test: saved review presets must SURVIVE a write.
 *
 * The bug this pins is the nastiest kind: `mutate()` built its draft document
 * from an explicit field list, and that list never learned about the new
 * `reviewPresets` table. Saving a preset therefore reported success — the
 * mutator ran, the write completed, the API returned the new preset — and then
 * the very next read found an empty list, because the table had been dropped
 * on the way to disk. A user would see their prompt vanish and conclude the
 * feature was broken.
 *
 * The assertions below are about the observable promise: save, then read it
 * back, from a fresh store instance too.
 *
 * Run: node tests/verify-review-store.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GithubLinkStore } from '../src/host/store.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const home = await mkdtemp(path.join(tmpdir(), 'push-presets-'));

try {
  /* ---- 1. a saved preset is readable back ------------------------- */
  const store = new GithubLinkStore({ home });
  const saved = await store.saveReviewPreset({
    title: '我的检查',
    prompt: '检查所有 TODO 是否必须保留',
    category: 'custom',
  });
  check('save returns the preset', Boolean(saved && saved.id), saved && saved.id);

  const afterSave = await store.reviewPresets();
  check('the preset is in the list right after saving', afterSave.length === 1,
    `n=${afterSave.length}`);
  check('its title round-tripped', afterSave[0] && afterSave[0].title === '我的检查',
    afterSave[0] && afterSave[0].title);

  /* ---- 2. it survives an unrelated write -------------------------- */
  // This is the exact shape of the original bug: any OTHER mutation used to
  // rewrite the document without the presets table.
  await store.mutate((state) => {
    state.settings.defaultRemote = 'upstream';
    return state;
  });
  const afterOtherWrite = await store.reviewPresets();
  check('an unrelated mutation does not drop presets', afterOtherWrite.length === 1,
    `n=${afterOtherWrite.length}`);

  /* ---- 3. it survives a restart ----------------------------------- */
  const reopened = new GithubLinkStore({ home });
  const afterRestart = await reopened.reviewPresets();
  check('a new store instance still sees it', afterRestart.length === 1,
    `n=${afterRestart.length}`);

  /* ---- 4. updating replaces rather than duplicates ---------------- */
  await reopened.saveReviewPreset({
    id: saved.id,
    title: '改名了',
    prompt: '新的提示词',
    category: 'custom',
  });
  const afterUpdate = await reopened.reviewPresets();
  check('updating the same id does not duplicate', afterUpdate.length === 1,
    `n=${afterUpdate.length}`);
  check('the update took effect', afterUpdate[0] && afterUpdate[0].title === '改名了',
    afterUpdate[0] && afterUpdate[0].title);

  /* ---- 5. deletion sticks ---------------------------------------- */
  const removed = await reopened.deleteReviewPreset(saved.id);
  check('delete reports success', removed === true);
  const afterDelete = await new GithubLinkStore({ home }).reviewPresets();
  check('the preset is gone from disk', afterDelete.length === 0, `n=${afterDelete.length}`);

  /* ---- 6. two presets coexist ------------------------------------ */
  await reopened.saveReviewPreset({ title: 'A', prompt: 'aaa', category: 'custom' });
  await reopened.saveReviewPreset({ title: 'B', prompt: 'bbb', category: 'custom' });
  const two = await reopened.reviewPresets();
  check('two presets coexist', two.length === 2, `n=${two.length}`);
  check('both titles survived', two.map((p) => p.title).sort().join(',') === 'A,B',
    two.map((p) => p.title).join(','));

  /* ---- 7. a malformed entry is dropped, not fatal ----------------- */
  await reopened.mutate((state) => {
    state.reviewPresets = [
      { id: 'ok', title: 'good', prompt: 'p', category: 'custom' },
      { title: 'no id', prompt: 'p' },
      { id: 'no-prompt', title: 'x', prompt: '   ' },
      null,
      'nonsense',
    ];
    return state;
  });
  const sanitized = await new GithubLinkStore({ home }).reviewPresets();
  check('malformed presets are dropped on read', sanitized.length === 1, `n=${sanitized.length}`);
  check('the valid one survives', sanitized[0] && sanitized[0].id === 'ok');
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
