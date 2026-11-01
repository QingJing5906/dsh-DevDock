/**
 * 审查扫描器对「测试夹具假令牌」的识别。
 *
 * 背景：统一审查跑完后报了 25 个 blocker，全是测试文件里的假令牌
 * （ghp_bbbbbbb…、ghp_AAAAAAAA… 这类重复字符占位符）。它们不是泄露，
 * 却淹没了真正的问题。
 *
 * 这里验证 scanSecrets：
 *   - 明显是夹具的假令牌 → 不报（降噪）
 *   - 真实形态的令牌 → 仍然报（不漏报）
 *
 * Run: node tests/verify-fixture-noise.mjs
 */
import { scanSecrets } from '../src/host/review.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. 假令牌：重复字符 / 测试字眼，不该报 ---- */
{
  const fixtures = [
    'const token = "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
    'const token = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
    'const token = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
    'const token = "ghp_test_token_value";',
    'const token = "ghp_example_token_value_123456";',
  ];
  for (const line of fixtures) {
    const findings = scanSecrets(line, { file: 'fixture.js' });
    check('夹具假令牌不报: ' + line.slice(0, 40),
      findings.length === 0,
      findings.length + ' 条');
  }
}

/* ---- 2. 真实形态的令牌必须仍然报（不能为了降噪而漏报） ---- */
{
  // 用「看起来随机」的高熵字符串模拟真实令牌，避免与占位符冲突
  const real = [
    'const token = "ghp_xK9mQ2wN8vL3pR7sT5uY1cD4fG6hJ0kL9";',
    'const key = "sk-Ab3dEf7Gh9Jk2Mn4Pq6Rs8Tu1Vw5Xy0Z";',
  ];
  for (const line of real) {
    const findings = scanSecrets(line, { file: 'app.js' });
    check('真实形态令牌仍报: ' + line.slice(0, 40),
      findings.length > 0,
      findings.length + ' 条');
  }
}

/* ---- 3. 私钥块与 Authorization 头仍是真报（不是夹具时） ---- */
{
  const findings = scanSecrets(
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...',
    { file: 'app.js' },
  );
  check('私钥块仍报', findings.length > 0);
}

/* ---- 4. 已有的 assigned-secret 占位符逻辑不回归 ---- */
{
  const findings = scanSecrets('const password = "change-me";', { file: 'app.js' });
  check('password=change-me 仍被降噪', findings.length === 0);
  const real = scanSecrets('const password = "S3cure$Real#Pass!";', { file: 'app.js' });
  check('password=真密码仍报', real.length > 0);
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
