import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const host = readFileSync('src/host/index.js', 'utf8');

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- cards + language bar ----------------------------------------- */
check('a RepoCard component exists', /function RepoCard\(/.test(src));
check('a LanguageBar component exists', /function LanguageBar\(/.test(src));
check('cards support a large size', src.includes('dsh-push-repocard--large'));
check('cards show a description', src.includes('repoNoDescription'));
check('cards show the default branch', src.includes('dsh-push-repocard-branch'));
check('cards expose a jump action', src.includes("href: repo.htmlUrl"));
check('cards open the management modal', src.includes('onManage'));
check('the bar reaches the card bottom edge', src.includes('dsh-push-langbar'));

/* ---- view switch --------------------------------------------------- */
check('a list/card switch exists', /function ViewSwitch\(/.test(src));
check('the switch offers a card size only in card mode',
  src.includes("props.mode === 'card'") && src.includes('dsh-push-rv-muted') === false
  || src.includes("props.mode === 'card'"));
check('the settings page uses the switch', src.includes("readViewPref('section'"));
check('the push page uses the switch', src.includes("readViewPref('page'"));
check('view choices persist', src.includes('writeViewPref'));

/* ---- language data -------------------------------------------------- */
check('the host exposes a languages route', host.includes("get('/repos/languages'"));
check('the client requests languages', src.includes("'/repos/languages?owner='"));
check('language fetches are cached', src.includes('languageCache'));

/* ---- account profile button ---------------------------------------- */
check('the account card has a profile link', src.includes('dsh-push-acc-card-profile'));
check('the profile link sits before the chevron',
  src.indexOf('dsh-push-acc-card-profile') < src.indexOf("className: 'dsh-push-chevron'"));

/* ---- release assets + target --------------------------------------- */
check('the host exposes an asset upload route', host.includes("post('/releases/asset'"));
check('the client uploads assets', src.includes("'/releases/asset'"));
check('the release row offers an upload control', src.includes('uploadAsset(release.id, picked)'));
check('the release form can choose a target commit', src.includes('releaseDraft.target'));
check('the target is sent to the host', src.includes('target: String(releaseDraft.target'));
check('uploads are size-capped', src.includes('assetTooLarge'));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
