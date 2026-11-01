/**
 * package.json 的界面声明与实际代码是否一致。
 *
 * 用户希望「打开 package.json 就知道侧边栏里有什么」，所以 `dsh.surfaces`
 * 必须是真的：声明的每个界面都要能在 client.js 里找到对应注册，反之亦然。
 * 一份会漂移的文档比没有文档更糟。
 *
 * Run: node tests/verify-surfaces.mjs
 */
import { readFileSync } from 'node:fs';

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const client = readFileSync('client.js', 'utf8');

const surfaces = pkg.dsh && pkg.dsh.surfaces;
check('package.json 声明了 dsh.surfaces', Boolean(surfaces));

/* ---- 1. 三个入口都存在且命名一致 ---- */
{
  const ids = ['settings', 'sidebar', 'workspaceTab'].filter((key) => surfaces && surfaces[key]);
  check('声明了设置页 / 侧边栏 / 工作区标签页三个入口', ids.length === 3, ids.join(','));
  for (const key of ids) {
    const entry = surfaces[key];
    check(`${key} 的 label 是 DevDock`, entry.label === 'DevDock', entry.label);
  }
}

/* ---- 2. 每个入口的 id 与代码中的注册 id 一致 ---- */
{
  check('设置页注册 id 为 push', client.includes("name: 'settings.section'") && client.includes("id: 'push'"));
  check('侧边栏注册 id 为 push',
    client.includes("name: 'sidebar.panellist'") && client.includes("key: 'push'"));
  check('工作区标签页注册 id 为 push', client.includes("id: 'push',"));
}

/* ---- 3. 声明的平台与 PLATFORMS 一致 ---- */
{
  const declared = new Set();
  for (const key of ['settings', 'sidebar', 'workspaceTab']) {
    const entry = surfaces[key];
    const list = entry.platforms || entry.pages || [];
    for (const row of list) declared.add(row.platform || row.id);
  }
  check('声明的平台与代码里的 PLATFORMS 一致',
    declared.has('github') && declared.has('npm')
    && client.includes("{ id: 'github', label: 'GitHub' }")
    && client.includes("{ id: 'npm', label: 'npm' }"),
    [...declared].join(','));
}

/* ---- 4. 声明里提到的关键能力真的存在 ---- */
{
  const must = [
    ['仓库管理弹窗', 'function RepoManageModal'],
    ['包管理弹窗', 'function NpmPackageModal'],
    ['打包面板', 'function NpmPackPanel'],
    ['创建 package.json', 'function NpmInitCard'],
    ['账号选择器', 'function NpmAccountPicker'],
    ['发布前自检', 'npmPreflight'],
    ['列表/卡片切换', 'function ViewSwitch'],
    ['Agent 审查', 'ReviewDialog'],
    // 提交图是内联渲染的（没有独立组件），按它的样式类与文案定位。
    ['版本树', 'dsh-push-commit-graph'],
    ['信息密度', 'function useDensity'],
  ];
  for (const [label, needle] of must) {
    const inClient = client.includes(needle);
    const inHost = !inClient && readFileSync('src/host/index.js', 'utf8').includes(needle);
    check(`声明的能力「${label}」在代码中存在`, inClient || inHost, needle);
  }
}

/* ---- 5. 工作区标签页声明了前置依赖与降级入口 ---- */
{
  const tab = surfaces.workspaceTab;
  check('声明了 betterSidebar 前置依赖', tab.requires === 'betterSidebar', tab.requires);
  check('声明了官方客户端降级入口', tab.fallback === 'conversation.session.header.utilities', tab.fallback);
  check('降级入口在代码中已注册',
    client.includes("name: 'conversation.session.header.utilities'"));
}

/* ---- 6. 不再出现「只读」这类过时表述 ---- */
{
  check('设置页不再写着「只读」',
    !client.includes('只读：查看账号与包') && !client.includes('Read-only: accounts and packages'));
}

/* ---- 7. 工作区标签页图标是套件标记 ---- */
{
  check('标签页图标使用 DevDockMark',
    client.includes('icon: (size) => h(DevDockMark'));
  check('标签页不再使用 GitHub 图标',
    !client.includes('icon: (size) => h(GithubMark'));
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
