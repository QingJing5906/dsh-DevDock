import { readFileSync, writeFileSync } from 'node:fs';

const file = 'D:/360MoveData/Users/向崇华/Desktop/github管理插件/dsh-push/client.js';
let src = readFileSync(file, 'utf8');
let changed = 0;

/* ---- CSS：设置页的头部与正文分区 ---- */
if (!src.includes('.dsh-push-settings-head')) {
  const anchor = '/* ── 平台切换 ─────────────────────────────────────────────────────── */';
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.error('css anchor missing'); process.exit(1); }
  const css = [
    '/* 设置页：顶部固定平台切换器，正文是当前平台自己的一页。 */',
    '.dsh-push-settings-head { flex: none; display: flex; align-items: center;',
    '  gap: 8px; padding: 8px 12px 6px;',
    '  border-bottom: 1px solid var(--dsw-alias-border-l1); }',
    '.dsh-push-settings-body { display: flex; flex-direction: column; gap: 10px;',
    '  padding: 10px 12px 16px; }',
    '',
    anchor,
  ].join('\n');
  src = src.slice(0, idx) + css + src.slice(idx);
  changed += 1;
  console.log('settings css added');
}

/* ---- 移除已不再使用的 platformLabel ---- */
{
  const START = '/** 当前平台的显示名，供 sidebar 的 label thunk 使用。 */';
  const start = src.indexOf(START);
  if (start >= 0) {
    const END = "  return found ? found.label : 'GitHub';\n}";
    const endIdx = src.indexOf(END, start);
    if (endIdx > 0) {
      src = src.slice(0, start) + src.slice(endIdx + END.length + 1);
      changed += 1;
      console.log('platformLabel removed');
    }
  }
}

writeFileSync(file, src, 'utf8');
console.log('done (' + changed + ' edits)');

const left = (src.match(/platformLabel/g) || []).length;
console.log('remaining platformLabel refs:', left);
