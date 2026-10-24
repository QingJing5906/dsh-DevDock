import { readFileSync, writeFileSync } from 'node:fs';

const file = 'D:/360MoveData/Users/向崇华/Desktop/github管理插件/dsh-push/client.js';
let src = readFileSync(file, 'utf8');
let changed = 0;
const notes = [];

/* ══════════ 1. DevDock 品牌标记 ══════════ */
if (!src.includes('function DevDockMark(')) {
  const anchor = '/** 按平台 id 渲染对应标记。 */';
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.error('PlatformMark anchor missing'); process.exit(1); }
  const mark = [
    '/**',
    ' * 套件标记：一个托盘 + 三格内容。',
    ' *',
    ' * 三个入口（设置 / 左侧栏 / 工作区标签页）都用它，因为这三个入口代表的',
    ' * 是「DevDock 这个套件」，平台是在里面切换的。用平台图标当入口图标会',
    ' * 造成"入口叫 DevDock、图标却是 npm"的错位。',
    ' */',
    'function DevDockMark(props) {',
    '  const size = (props && props.size) || 16;',
    '  return h(\'svg\', {',
    "    width: size, height: size, viewBox: '0 0 24 24',",
    "    'aria-hidden': 'true',",
    "    style: { display: 'block' },",
    '  },',
    "    h('rect', { x: 2.6, y: 2.6, width: 18.8, height: 18.8, rx: 5,",
    "      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }),",
    "    h('rect', { x: 6.2, y: 13.6, width: 3.6, height: 4.2, rx: 1.1, fill: 'currentColor' }),",
    "    h('rect', { x: 10.2, y: 13.6, width: 3.6, height: 4.2, rx: 1.1, fill: 'currentColor', opacity: 0.55 }),",
    "    h('rect', { x: 14.2, y: 13.6, width: 3.6, height: 4.2, rx: 1.1, fill: 'currentColor', opacity: 0.3 }),",
    "    h('rect', { x: 6.2, y: 7.4, width: 11.6, height: 3.2, rx: 1.1, fill: 'currentColor', opacity: 0.85 }));",
    '}',
    '',
    anchor,
  ].join('\n');
  src = src.slice(0, idx) + mark + src.slice(idx + anchor.length);
  changed += 1;
  notes.push('DevDockMark added');
}

/* ══════════ 2. 侧栏：图标与名称都代表套件 ══════════ */
{
  const OLD = [
    '      // 图标跟随当前平台：切换后不需要重载页面，label thunk 与本组件都',
    '      // 会在下一次投影时读到新值。',
    "      const platform = readPlatform('panel');",
    "      return h('span', {",
    "        className: 'dsh-push-sb-icon',",
    "        'data-active': props && props.active ? 'true' : 'false',",
    "        title: platformLabel('panel'),",
    '      }, h(PlatformMark, { id: platform, size: (props && props.size) || 16 }));',
  ].join('\n');
  const NEW = [
    '      // 入口代表的是 DevDock 套件，平台在面板里切换——所以这里用稳定的',
    '      // 品牌标记，而不是跟随平台的图标。',
    '      //',
    '      // 之前用平台图标 + 动态 label 行不通：宿主导航只在注册时读一次',
    '      // label，切平台不会让它重新投影，于是图标和名称都停在旧值上。',
    "      return h('span', {",
    "        className: 'dsh-push-sb-icon',",
    "        'data-active': props && props.active ? 'true' : 'false',",
    "        title: 'DevDock',",
    '      }, h(DevDockMark, { size: (props && props.size) || 16 }));',
  ].join('\n');
  if (src.includes(OLD)) {
    src = src.replace(OLD, NEW);
    changed += 1;
    notes.push('sidebar icon = DevDock');
  }
}

{
  const OLD = [
    '      // 侧栏显示当前平台名；label 是 thunk，切换后下一次投影就更新。',
    "      label: () => platformLabel('panel'),",
  ].join('\n');
  const NEW = [
    '      // 入口名固定为套件名；平台在面板顶部切换。',
    "      label: () => 'DevDock',",
  ].join('\n');
  if (src.includes(OLD)) {
    src = src.replace(OLD, NEW);
    changed += 1;
    notes.push('sidebar label = DevDock');
  }
}

/* ══════════ 3. 工作区标签页标题 ══════════ */
{
  const OLD = "      title: () => t('tabTitle'),";
  if (src.includes(OLD)) {
    src = src.replace(OLD, "      // 标签页同样以套件命名，平台在页内切换。\n      title: () => 'DevDock',");
    changed += 1;
    notes.push('tab title = DevDock');
  }
}

/* ══════════ 4. 设置页：顶部切换平台 + 每个平台自己的页面 ══════════ */
{
  // 4a. 状态
  const anchor = '      const [density, setDensity] = useDensity();';
  const idx = src.indexOf(anchor, src.indexOf('function SettingsSection(props) {'));
  if (idx > 0 && !src.slice(idx, idx + 400).includes("readPlatform('settings')")) {
    const add = [
      anchor,
      '      // 设置页自己也记一个平台；三个入口互不影响。',
      "      const [platform, setPlatform] = useState(() => readPlatform('settings'));",
      '      const switchPlatform = (id) => {',
      '        setPlatform(id);',
      "        writePlatform('settings', id);",
      '      };',
    ].join('\n');
    src = src.slice(0, idx) + add + src.slice(idx + anchor.length);
    changed += 1;
    notes.push('settings platform state');
  }

  // 4b. npm 分支：整页只显示 npm
  const RET = "      return h('div', { className: 'dsh-push-root dsh-push-settings', style: densityStyle(density) },";
  const retIdx = src.indexOf(RET);
  if (retIdx < 0) { console.error('settings return missing'); process.exit(1); }
  if (!src.includes('dsh-push-settings--npm')) {
    const npmBranch = [
      "      /* npm 有自己的一页：只显示 npm 的账号与包，不混进 GitHub 的内容。 */",
      "      if (platform === 'npm') {",
      "        return h('div', { className: 'dsh-push-root dsh-push-settings', style: densityStyle(density) },",
      "          h('div', { className: 'dsh-push-settings-head' },",
      '            h(PlatformSwitcher, { value: platform, onChange: switchPlatform })),',
      "          h('div', { className: 'dsh-push-settings-body' },",
      "            h(NpmSection, { ctx })));",
      '      }',
      '',
      RET.replace('},', '},\n        // GitHub 的一页，顶部同样有平台切换器。\n        h(\'div\', { className: \'dsh-push-settings-head\' },\n          h(PlatformSwitcher, { value: platform, onChange: switchPlatform })),'),
    ].join('\n');
    src = src.slice(0, retIdx) + npmBranch + src.slice(retIdx + RET.length);
    changed += 1;
    notes.push('settings npm page + head switcher');
  }

  // 4c. GitHub 页里不再常驻 npm 分区
  const OLD_NPM = '        h(NpmSection, { ctx }),\n\n';
  if (src.includes(OLD_NPM)) {
    src = src.replace(OLD_NPM, '');
    changed += 1;
    notes.push('npm section removed from GitHub page');
  }
}

writeFileSync(file, src, 'utf8');
console.log('done (' + changed + ' edits)');
for (const n of notes) console.log(' -', n);
