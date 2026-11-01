/**
 * npm 发布前审查的端到端测试。
 *
 * 不走 HTTP（宿主 webServer 需要浏览器会话凭据），而是直接验证业务逻辑与
 * 界面契约：Host 端的服务确实复用 GitHub 那套审查组件，客户端确实调用它，
 * 并且用一个真实临时包验证 npm pack + 规则扫描能跑通。
 *
 * Run: node tests/verify-npm-review.mjs
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const hostSrc = readFileSync('src/host/index.js', 'utf8');
const clientSrc = readFileSync('client.js', 'utf8');

/** 切出一个方法体（按它自己的结束位置，不猜长度）。 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end > start ? source.slice(start, end) : '';
}

const reviewBody = methodBody(hostSrc, 'async npmPublishReview(body) {');

/* ---- 1. 结构：服务与路由存在 ---- */
{
  check('存在 npmPublishReview 服务', reviewBody.length > 500, reviewBody.length + ' 字符');
  check('存在 /npm/review/run 路由', hostSrc.includes("post('/npm/review/run'"));
  check('客户端确实调用它', clientSrc.includes("API + '/npm/review/run'"));
}

/* ---- 2. 复用 GitHub 那套组件，而不是另造一套 ---- */
{
  check('复用 BUILTIN_PRESETS', hostSrc.includes('BUILTIN_PRESETS.filter'));
  check('复用 store 里保存的自定义预设', hostSrc.includes('this.#store.reviewPresets()'));
  check('复用 scanSecrets', /scanSecrets\(/.test(hostSrc));
  check('复用 runModelReview', /runModelReview\(llm, \{/.test(hostSrc));
  check('复用 sortFindings', hostSrc.includes('sortFindings('));
  check('复用 normalizeFinding', hostSrc.includes('normalizeFinding('));
  check('runModelReview 收到拼好的 prompt',
    /runModelReview\(llm, \{[\s\S]{0,400}?prompt:/.test(hostSrc));
}

/* ---- 3. 返回结构与 GitHub 审查同形 ----
 * 返回体里用的是简写属性（`findings,`），所以按「行首或逗号后 + 名字 +
 * 逗号或冒号」判断，而不是 \b 单词边界。 */
{
  for (const field of ['files', 'findings', 'summary', 'usage', 'degraded', 'truncated', 'model']) {
    const pattern = new RegExp('(^|[\\s{,])\\s*' + field + '\\s*[,:]', 'm');
    check('返回结构含 ' + field, pattern.test(reviewBody));
  }
  check('带 scope: package 以便界面区分', reviewBody.includes("scope: 'package'"));
  check('附带包信息（文件数/体积）', reviewBody.includes('pack: {'));
}

/* ---- 4. 三类不依赖模型的检查 ---- */
{
  check('空包会被判为阻断项', reviewBody.includes('包内没有任何文件'));
  check('缺 README 会被提示', reviewBody.includes('包里没有 README'));
  check('体积过大有提示', reviewBody.includes('包体积偏大'));
  check('prompt 里声明了审查范围（避免误报缺文件）',
    reviewBody.includes('审查范围'));
}

/* ---- 5. 真跑一遍 pack + 规则扫描 ---- */
{
  const dir = await mkdtemp(path.join(tmpdir(), 'npm-review-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'devdock-review-fixture',
      version: '1.0.0',
      license: 'MIT',
      files: ['index.js', 'README.md'],
    }, null, 2), 'utf8');
    await writeFile(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
    await writeFile(path.join(dir, 'index.js'), [
      '// 故意放一个假令牌，规则扫描必须抓到',
      'const token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      'module.exports = token;',
      '',
    ].join('\n'), 'utf8');

    const npmcli = await import('../src/host/npmcli.js');
    const review = await import('../src/host/review.js');

    const runner = new npmcli.NpmRunner();
    const out = await runner.run(['pack', '--dry-run', '--json'], {
      cwd: dir,
      env: { npm_config_cache: path.join(dir, '.cache') },
    });
    const packed = npmcli.mapPackResult(npmcli.parsePackJson(out.stdout));

    check('能对临时目录执行 npm pack', packed.totalFiles > 0, packed.totalFiles + ' 个文件');
    check('包里包含 README', packed.files.some((row) => /readme/i.test(row.path)));
    check('包里包含 index.js', packed.files.some((row) => /index\.js$/i.test(row.path)));

    const indexText = readFileSync(path.join(dir, 'index.js'), 'utf8');
    const findings = review.scanSecrets(indexText, { file: 'index.js' });
    check('规则扫描抓到假令牌', findings.length > 0, findings.length + ' 条');
    check('抓到的是阻断级令牌问题',
      findings.some((row) => row.severity === 'blocker'),
      JSON.stringify(findings[0] || {}).slice(0, 80));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---- 6. 界面契约 ---- */
{
  check('存在 NpmReviewDialog', clientSrc.includes('function NpmReviewDialog('));
  check('对话框读取 /review/presets（与 GitHub 同一个目录）',
    /NpmReviewDialog[\s\S]{0,2500}?review\/presets/.test(clientSrc));
  check('对话框读取 /review/models', /NpmReviewDialog[\s\S]{0,2500}?review\/models/.test(clientSrc));
  check('发布页有审查入口', clientSrc.includes("t('npmReviewOpen')"));
  check('审查对话框已挂载到发布弹窗', clientSrc.includes('h(NpmReviewDialog, {'));
  check('阻断级问题会给出提示', clientSrc.includes('npmReviewBlocker'));
  check('中英双语文案齐全',
    clientSrc.includes('npmReviewTitle: "发布前审查"')
    && clientSrc.includes('npmReviewTitle: "Pre-publish review"'));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  const state = c.ok ? 'ok  ' : 'FAIL';
  const detail = c.detail ? ' - ' + c.detail : '';
  console.log(state + ' ' + c.label + detail);
}
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
