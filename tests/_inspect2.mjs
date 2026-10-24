import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const lines = src.split('\n');

const marker = "dsh-push-root dsh-push-settings";
const idx = lines.findIndex((line) => line.includes(marker));
console.log('settings root at line', idx + 1);
console.log(lines.slice(Math.max(0, idx - 3), idx + 14).map((l, i) => `${idx - 2 + i}: ${l}`).join('\n'));

console.log('\n--- 注册处 ---');
for (const [i, line] of lines.entries()) {
  if (/label: \(\) =>|title: \(\) =>/.test(line)) console.log(`${i + 1}: ${line.trim()}`);
}
