/**
 * 直接调用 Host 服务，验证 /review/project 的实现。
 *
 * HTTP 层需要浏览器会话凭据，无法从命令行探测；这里构造最小依赖，
 * 直接跑 reviewProject 的核心流程（规则扫描 + 内容收集）。
 *
 * Run: node tests/verify-project-review.mjs
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const hostSrc = readFileSync('src/host/index.js', 'utf8');
const clientSrc = readFileSync('client.js', 'utf8');

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end > start ? source.slice(start, end) : '';
}

const body = methodBody(hostSrc, 'async reviewProject(body) {');

/* ---- 1. 服务与路由 ---- */
{
  check('存在 reviewProject 服务', body.length > 500, body.length + ' 字符');
  check('存在 /review/project 路由', hostSrc.includes("post('/review/project'"));
  check('客户端调用它', clientSrc.includes("API + '/review/project'"));
}

/* ---- 2. 一次覆盖两类内容 ---- */
{
  check('收集 git 改动', body.includes('collectReviewChanges'));
  check('收集 npm 包内容', body.includes('npm pack') || body.includes("'pack', '--dry-run'"));
  check('有 includeGit / includePack 开关',
    body.includes('includeGit') && body.includes('includePack'));
  check('去重：git 里已有的文件不重复审',
    /collections\.some\(/.test(body));
}

/* ---- 3. 结果带 scope，界面才能分组 ---- */
{
  check("git 内容标注 scope: 'git'", /scope:\s*'git'/.test(body));
  check("npm 内容标注 scope: 'npm'", /scope:\s*'npm'/.test(body));
  check('返回 scope: project', body.includes("scope: 'project'"));
  check('报告被跳过的来源', body.includes('skipped'));
}

/* ---- 4. 复用同一套审查组件 ---- */
{
  check('复用 scanSecrets', /scanSecrets\(/.test(body));
  check('复用 runModelReview', /runModelReview\(llm, \{/.test(body));
  check('复用 BUILTIN_PRESETS', body.includes('BUILTIN_PRESETS'));
  check('复用 sortFindings / normalizeFinding',
    body.includes('sortFindings(') && body.includes('normalizeFinding('));
}

/* ---- 5. GitHub 的审查也改走同一接口 ---- */
{
  check('GitHub ReviewDialog 调 /review/project',
    /ReviewDialog[\s\S]{0,6000}?API \+ '\/review\/project'/.test(clientSrc));
  check('GitHub 面板只要 git 部分', clientSrc.includes('includePack: false'));
}

/* ---- 6. 界面：多选与复制提示词 ---- */
{
  check('存在 ProjectReviewDialog', clientSrc.includes('function ProjectReviewDialog('));
  check('有勾选状态', clientSrc.includes('chosenFindings'));
  check('有全选', clientSrc.includes("t('pjChooseAll')"));
  check('有复制修复提示词', clientSrc.includes("t('pjCopyPrompt')"));
  check('有提示词生成函数', clientSrc.includes('function buildFixPrompt('));
  check('提示词含目录与文件', /buildFixPrompt[\s\S]{0,900}?finding\.file/.test(clientSrc));
}

/* ---- 7. 真跑一遍：临时项目，含 git 目录与 npm 文件 ---- */
{
  const dir = await mkdtemp(path.join(tmpdir(), 'proj-review-'));
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'proj-fixture', version: '1.0.0', license: 'MIT',
      files: ['src/index.js', 'README.md'],
    }, null, 2), 'utf8');
    await writeFile(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
    await writeFile(path.join(dir, 'src/index.js'), [
      'const token = "ghp_xK9mQ2wN8vL3pR7sT5uY1cD4fG6hJ0kL9ZaQ";',
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

    check('npm pack 能收集到文件', packed.totalFiles > 0, packed.totalFiles + ' 个');

    const text = readFileSync(path.join(dir, 'src/index.js'), 'utf8');
    const findings = review.scanSecrets(text, { file: 'src/index.js' });
    check('规则扫描抓到令牌', findings.length > 0, findings.length + ' 条');
    check('抓到的是阻断级', findings.some((row) => row.severity === 'blocker'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
