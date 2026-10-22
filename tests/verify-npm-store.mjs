import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GithubLinkStore } from '../src/host/store.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });
const home = await mkdtemp(path.join(tmpdir(), 'npm-store-'));

try {
  const store = new GithubLinkStore({ home });

  /* 空状态 */
  const empty = await store.npmAccounts();
  check('初始没有 npm 账号', empty.accounts.length === 0, String(empty.accounts.length));
  check('初始 active 为 null', empty.activeId === null, String(empty.activeId));

  /* 新增 */
  const saved = await store.saveNpmAccount({ login: 'qingjing5906', token: 'npm_abc123456789' });
  check('保存返回 id', Boolean(saved && saved.id), saved && saved.id);
  check('保存后自动成为当前', (await store.npmAccounts()).activeId === saved.id);
  check('列表里能读到', (await store.npmAccounts()).accounts.length === 1);
  check('列表不返回令牌',
    !JSON.stringify(await store.npmAccounts()).includes('npm_abc123456789'));

  /* 带令牌的读取 */
  const active = await store.activeNpmAccount();
  check('activeNpmAccount 带令牌', active && active.token === 'npm_abc123456789');
  check('令牌类型默认 granular', active && active.tokenKind === 'granular', active && active.tokenKind);

  /* 脱敏列表包含 npm 令牌 */
  const secrets = await store.secrets();
  check('secrets 覆盖 npm 令牌', secrets.includes('npm_abc123456789'), secrets.join('|'));

  /* 第二个账号 + 切换 */
  const second = await store.saveNpmAccount({ login: 'other-user', token: 'npm_def987654321' });
  check('第二个账号加入', (await store.npmAccounts()).accounts.length === 2);
  check('新保存的成为当前', (await store.npmAccounts()).activeId === second.id);
  await store.setActiveNpmAccount(saved.id);
  check('可以切回第一个', (await store.npmAccounts()).activeId === saved.id);
  check('拒绝切到不存在的账号', (await store.setActiveNpmAccount('nope')) === false);

  /* 重启后仍在（含 mutate 不丢表） */
  await store.mutate((state) => { state.settings.defaultRemote = 'upstream'; return state; });
  const reopened = new GithubLinkStore({ home });
  const afterRestart = await reopened.npmAccounts();
  check('无关写入不丢 npm 账号', afterRestart.accounts.length === 2, String(afterRestart.accounts.length));

  /* 删除当前账号后自动切换 */
  await reopened.deleteNpmAccount(afterRestart.activeId);
  const afterDelete = await reopened.npmAccounts();
  check('删除后剩一条', afterDelete.accounts.length === 1, String(afterDelete.accounts.length));
  check('删除当前账号后自动切到剩下的', afterDelete.activeId === afterDelete.accounts[0].id);

  /* 脏数据降级 */
  await reopened.mutate((state) => {
    state.npmAccounts = [
      { id: 'ok', login: 'good', token: 'npm_ok000000000' },
      { login: 'no-token' },
      { id: 'no-login', token: 'npm_x' },
      null,
      'junk',
    ];
    return state;
  });
  const sanitized = await new GithubLinkStore({ home }).npmAccounts();
  check('脏条目被丢弃，只留合法的', sanitized.accounts.length === 1, String(sanitized.accounts.length));
  check('合法条目保留', sanitized.accounts[0] && sanitized.accounts[0].id === 'ok');
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
