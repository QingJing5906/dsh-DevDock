/**
 * npm registry 客户端的行为测试。
 *
 * 用一个本地假 registry 跑真实的请求路径（不走网络、不依赖令牌），验证：
 * 鉴权头带上令牌、状态码映射成插件统一的错误码、packument 被投影成界面
 * 需要的结构。这些用源码断言测不出来。
 *
 * Run: node tests/verify-npm-client.mjs
 */
import http from 'node:http';
import { npmWhoami, npmSearchByMaintainer, npmPackument, mapPackument } from '../src/host/npm.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 假 registry ---- */
let lastAuth = null;
let mode = 'ok';

const server = http.createServer((req, res) => {
  lastAuth = req.headers.authorization ?? null;
  const url = req.url ?? '';

  const send = (status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  };

  if (mode === 'unauthorized') return send(401, { error: 'unauthorized' });
  if (mode === 'missing') return send(404, { error: 'not found' });

  if (url.startsWith('/-/whoami')) return send(200, { username: 'qingjing5906' });
  if (url.startsWith('/-/v1/search')) {
    return send(200, {
      total: 2,
      objects: [
        {
          package: {
            name: 'alpha-pkg',
            version: '1.2.3',
            description: '第一个包',
            date: '2026-10-01T00:00:00.000Z',
            links: { npm: 'https://www.npmjs.com/package/alpha-pkg' },
            maintainers: [{ username: 'qingjing5906' }, { username: 'someone' }],
          },
          score: { final: 0.4321 },
        },
        {
          package: {
            name: 'beta-pkg',
            version: '0.0.1',
            maintainers: [{ username: 'other' }],
          },
          score: { final: 0.1 },
        },
      ],
    });
  }
  if (url.startsWith('/alpha-pkg')) {
    return send(200, {
      name: 'alpha-pkg',
      description: '第一个包',
      'dist-tags': { latest: '1.2.3', beta: '1.3.0-rc.1' },
      time: {
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-10-01T00:00:00.000Z',
        '1.2.3': '2026-10-01T00:00:00.000Z',
        '1.3.0-rc.1': '2026-09-01T00:00:00.000Z',
        '1.0.0': '2026-01-01T00:00:00.000Z',
      },
      maintainers: [{ username: 'qingjing5906' }],
      versions: {
        '1.0.0': { license: 'MIT', deprecated: '请升级', repository: { url: 'git+https://x/y.git' } },
        '1.2.3': { license: 'MIT', homepage: 'https://example.com', keywords: ['dsh', 'git'] },
        '1.3.0-rc.1': { license: 'MIT' },
      },
    });
  }
  return send(404, { error: 'unknown path' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.DSH_PUSH_NPM_REGISTRY = `http://127.0.0.1:${port}`;

try {
  /* ---- 1. whoami ---- */
  const who = await npmWhoami({ token: 'npm_test_token_123' });
  check('whoami 返回用户名', who.login === 'qingjing5906', who.login);
  check('whoami 带上 Bearer 令牌', lastAuth === 'Bearer npm_test_token_123', String(lastAuth));

  /* ---- 2. 搜索 ---- */
  const search = await npmSearchByMaintainer({ login: 'qingjing5906', token: 'npm_test_token_123' });
  check('搜索返回全部条目', search.items.length === 2, String(search.items.length));
  check('搜索带上 total', search.total === 2, String(search.total));
  check('条目投影出 name/version', search.items[0].name === 'alpha-pkg' && search.items[0].version === '1.2.3');
  check('owned 标记出本人维护的包', search.items[0].owned === true, String(search.items[0].owned));
  check('owned 对他人包为 false', search.items[1].owned === false, String(search.items[1].owned));
  check('score 保留三位小数', search.items[0].score === 0.432, String(search.items[0].score));

  /* ---- 3. packument ---- */
  const { pkg } = await npmPackument({ name: 'alpha-pkg' });
  check('latest 取自 dist-tags', pkg.latestVersion === '1.2.3', pkg.latestVersion);
  check('版本数正确', pkg.versionCount === 3, String(pkg.versionCount));
  check('版本按发布时间倒序',
    pkg.versions.map((v) => v.version).join(',') === '1.2.3,1.3.0-rc.1,1.0.0',
    pkg.versions.map((v) => v.version).join(','));
  check('isLatest 只标记 latest 那个',
    pkg.versions.filter((v) => v.isLatest).length === 1);
  check('废弃版本被统计', pkg.deprecatedVersions === 1, String(pkg.deprecatedVersions));
  check('废弃文案保留', pkg.versions.find((v) => v.version === '1.0.0').deprecated === '请升级');
  check('dist-tags 全部保留', Object.keys(pkg.distTags).length === 2, JSON.stringify(pkg.distTags));
  check('htmlUrl 指向 npmjs', pkg.htmlUrl === 'https://www.npmjs.com/package/alpha-pkg', pkg.htmlUrl);
  check('维护者被投影成用户名数组', pkg.maintainers.join(',') === 'qingjing5906');

  /* ---- 4. 错误映射 ---- */
  mode = 'unauthorized';
  let unauthorized = null;
  try { await npmWhoami({ token: 'bad' }); } catch (error) { unauthorized = error; }
  check('401 映射成 UNAUTHORIZED', unauthorized && unauthorized.code === 'UNAUTHORIZED',
    unauthorized && unauthorized.code);
  check('401 的提示提到令牌类型', String(unauthorized && unauthorized.message).includes('Granular'));

  mode = 'missing';
  let missing = null;
  try { await npmPackument({ name: 'nope' }); } catch (error) { missing = error; }
  check('404 映射成 NOT_FOUND', missing && missing.code === 'NOT_FOUND', missing && missing.code);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

/* ---- 5. 纯函数：空输入不炸 ---- */
{
  const empty = mapPackument(null, 'fallback');
  check('空 packument 不抛错', empty.name === 'fallback', empty.name);
  check('空 packument 版本数为 0', empty.versionCount === 0, String(empty.versionCount));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
