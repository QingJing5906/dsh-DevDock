import { readFileSync, writeFileSync } from 'node:fs';

const file = 'D:/360MoveData/Users/向崇华/Desktop/github管理插件/dsh-push/src/host/index.js';
let src = readFileSync(file, 'utf8');

const lines = src.split('\n');
const start = lines.findIndex((line) => line.includes("from './review.js'"));
console.log('=== review.js 的 import 块 ===');
console.log(lines.slice(start - 12, start + 1).map((l, i) => (start - 11 + i) + ': ' + l).join('\n'));

/* MAX_FILE_BYTES 在 npmPublishReview 里用到了，但没导入。补上。 */
if (!/^\s+MAX_FILE_BYTES,/m.test(src)) {
  const anchor = "  scanSecrets,\n";
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.error('scanSecrets import anchor missing'); process.exit(1); }
  src = src.slice(0, idx) + anchor + '  MAX_FILE_BYTES,\n' + src.slice(idx + anchor.length);
  writeFileSync(file, src, 'utf8');
  console.log('\nMAX_FILE_BYTES 已加入导入');
} else {
  console.log('\n已经导入过了');
}
