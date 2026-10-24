import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const lines = src.split('\n');
const idx = lines.findIndex((line) => line.includes('dsh-push-settings--npm'));
const start = idx >= 0 ? idx : lines.findIndex((line) => line.includes("dsh-push-root dsh-push-settings"));
console.log(lines.slice(Math.max(0, start - 2), start + 26).map((l, i) => `${start - 1 + i}: ${l}`).join('\n'));

console.log('\n--- 关键标记 ---');
for (const [i, line] of lines.entries()) {
  if (/platformLabel|settings-head|settings-body|DevDockMark|title: \(\) => 'DevDock'|label: \(\) => 'DevDock'/.test(line)) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
}
