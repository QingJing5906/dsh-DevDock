import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

/* 造一个最小的测试包，供 /npm/review/run 端到端验证。 */
const dir = 'D:/360MoveData/Users/向崇华/Desktop/github管理插件/dsh-push/tests/fixtures/reviewpkg';

import { mkdirSync } from 'node:fs';
mkdirSync(dir, { recursive: true });

writeFileSync(dir + '/package.json', JSON.stringify({
  name: 'devdock-review-e2e',
  version: '1.0.0',
  license: 'MIT',
  files: ['index.js', 'README.md'],
}, null, 2) + '\n', 'utf8');

writeFileSync(dir + '/README.md', '# e2e fixture\n', 'utf8');
writeFileSync(dir + '/index.js', [
  '// 故意放一个假令牌，规则扫描必须抓到',
  'const token = "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
  'module.exports = token;',
  '',
].join('\n'), 'utf8');

console.log('fixture ready:', dir);
