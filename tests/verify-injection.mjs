import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NpmRunner, mapPackResult, parsePackJson } from '../src/host/npmcli.js';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const dir = await mkdtemp(path.join(tmpdir(), 'inject-'));
try {
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'inject-fixture', version: '1.0.0', license: 'MIT', files: ['index.js'],
  }, null, 2), 'utf8');
  await writeFile(path.join(dir, 'index.js'), 'module.exports = 1;\n', 'utf8');

  const runner = new NpmRunner();

  // 1. 修复后 npm pack 仍工作
  const out = await runner.run(['pack', '--dry-run', '--json'], {
    cwd: dir,
    env: { npm_config_cache: path.join(dir, '.cache') },
  });
  const packed = mapPackResult(parsePackJson(out.stdout));
  check('修复后 npm pack 仍工作', packed.totalFiles > 0, packed.totalFiles + ' 个文件');

  // 2. 注入字符不被 shell 执行。
  //    判断标准：如果 shell 真的执行了 `echo pwned`，stdout 里会有一行
  //    独立于 npm 报错的 "pwned"；而 npm 报错回显 tag 名时，pwned 只会
  //    作为 tag 名的一部分出现在引号里，不是独立命令的输出。
  const r = await runner.run(['publish', '--tag', 'x&echo pwned', '--json'], {
    cwd: dir,
    env: { npm_config_cache: path.join(dir, '.c') },
    allowFailure: true,
  });
  const combined = r.stdout + r.stderr;
  // 独立成行的 pwned（前面是行首或空白，后面是行尾），才是命令被执行了
  const executed = /\bpwned\b\s*(?:\r?\n|$)/.test(combined);
  check('注入字符未被 shell 执行', !executed,
    executed ? '检测到独立的 pwned 输出，注入成功' : 'pwned 仅出现在 npm 报错回显里');

  // 3. 附带验证：npm 报错是「非法 tag 名」，说明参数确实被当作 tag 传进去了
  check('npm 收到的是非法 tag 名（而非执行了命令）',
    /EINVALIDTAGNAME/.test(combined) && combined.includes('Invalid tag name'),
    '');
} finally {
  await rm(dir, { recursive: true, force: true });
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
