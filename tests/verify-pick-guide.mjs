/**
 * 顶部入口没有目录时的引导区。
 *
 * 反馈：左下角那个「选择目录」按钮太小，看不见，需要在上方空白处给一个
 * 大按钮。这里钉住三件事：
 *  1. 没有目录时渲染引导区（标题 + 说明 + 大按钮）
 *  2. 小按钮保留（选过之后它显示路径，同时是切换入口）
 *  3. 布局上引导区能真正占满高度（modal-body 必须是 flex 容器）
 *
 * Run: node tests/verify-pick-guide.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
const css = src.slice(open + 'const CSS = `'.length, src.indexOf('`;', open));

/* ---- 1. 引导区存在 ---- */
{
  check('存在引导区组件片段', src.includes('dsh-push-pickguide'));
  check('引导区有标题文案', src.includes("t('headerNeedDirTitle')"));
  check('引导区有说明文案', src.includes("t('headerNeedDirText')"));
  check('引导区有大按钮', src.includes("t('headerPickDirBig')"));
  check('大按钮用 primary 样式',
    src.includes('dsh-push-btn--primary dsh-push-pickguide-btn'));
  check('中英文案齐全',
    src.includes('headerNeedDirTitle: "先选一个目录"')
    && src.includes('headerNeedDirTitle: "Choose a folder first"'));
}

/* ---- 2. 小按钮保留 ---- */
{
  check('弹窗左下角仍保留小按钮', src.includes("t('headerPickDir')"));
  check('小按钮在 modal-status 里',
    /dsh-push-modal-status[\s\S]{0,300}?headerPickDir/.test(src));
}

/* ---- 3. 有目录 / 没目录的分支 ---- */
{
  check('没有目录时才显示引导区',
    /dir !== '' \? null : h\('div', \{ className: 'dsh-push-pickguide' \}/.test(src)
    || /dir === ''[\s\S]{0,80}?dsh-push-pickguide/.test(src));
  check('没有目录时隐藏面板，避免大片空白',
    /dir === '' \? null : h\('div', \{ key: 'panel'/.test(src));
}

/* ---- 4. 布局：引导区真的能占满 ---- */
{
  const body = /\.dsh-push-modal-body \{([\s\S]*?)\}/.exec(css);
  check('modal-body 是 flex 容器',
    Boolean(body) && /display:\s*flex/.test(body[1]),
    body ? body[1].replace(/\s+/g, ' ').trim().slice(0, 70) : 'missing');

  const wrap = /\.dsh-push-pickguide-wrap \{([\s\S]*?)\}/.exec(css);
  check('引导区占满剩余空间',
    Boolean(wrap) && /flex:\s*1/.test(wrap[1]),
    wrap ? wrap[1].replace(/\s+/g, ' ').trim().slice(0, 60) : 'missing');
  check('引导区内容居中',
    Boolean(wrap) && /justify-content:\s*center/.test(wrap[1]));

  const btn = /\.dsh-push-pickguide-btn \{([\s\S]*?)\}/.exec(css);
  check('大按钮比常规按钮更高',
    Boolean(btn) && /height:\s*(3[0-9])px/.test(btn[1]),
    btn ? btn[1].replace(/\s+/g, ' ').trim().slice(0, 60) : 'missing');
}

/* ---- 5. 真渲染：没有目录时应该出现按钮，而不是空白 ---- */
{
  const React = {
    createElement(type, props, ...children) { return { $$el: true, type, props: props || {}, children }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect: () => {}, useCallback: (fn) => fn, useRef: (v) => ({ current: v ?? null }),
    useContext: () => ({}), useMemo: (fn) => { try { return fn(); } catch { return undefined; } },
    useId: () => 'id', memo: (fn) => fn, forwardRef: (fn) => fn, Fragment: 'Fragment',
    createContext: (v) => ({ Provider: 'P', Consumer: 'C' }),
    Children: { map: (x) => x, toArray: (x) => x },
    isValidElement: (x) => Boolean(x && x.$$el),
  };

  const start = src.indexOf('function DevDockHeaderEntry(props) {');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end + 3);

  const stub = `
    const t = (key) => key;
    const readViewPref = () => '';
    const writeViewPref = () => {};
    const DevDockMark = () => ({ $$el: true, type: 'svg', props: {}, children: [] });
    const NpmMark = () => ({ $$el: true, type: 'span', props: {}, children: [] });
    const Btn = () => ({ $$el: true, type: 'button', props: {}, children: [] });
    const Modal = (props) => ({ $$el: true, type: 'div', props: { className: 'stub-modal' }, children: [props.children] });
    const WorkspaceTab = () => ({ $$el: true, type: 'div', props: {}, children: [] });
    ${body}
    return DevDockHeaderEntry;
  `;

  let rendered = null;
  try {
    const factory = new Function('h', 'useState', 'useEffect', 'useCallback', 'useRef', 'useContext', stub);
    const Comp = factory(
      React.createElement,
      /* 第一次 useState(false) 是 open —— 让它返回 true，模拟「弹窗已打开」 */
      (initial) => {
        const value = typeof initial === 'function' ? initial() : initial;
        if (value === false) return [true, () => {}];
        return [value, () => {}];
      },
      React.useEffect, React.useCallback, React.useRef, React.useContext,
    );
    rendered = Comp({ ctx: { get: () => null } });
  } catch (error) {
    check('组件能独立渲染', false, String(error.message).slice(0, 90));
  }

  if (rendered) {
    const seen = { buttons: 0, classes: [] };
    const walk = (node, depth) => {
      if (depth > 14 || node == null) return;
      if (Array.isArray(node)) { for (const c of node) walk(c, depth + 1); return; }
      if (typeof node !== 'object' || !node.$$el) return;
      if (node.type === 'button') seen.buttons += 1;
      const cls = node.props && node.props.className;
      if (typeof cls === 'string') seen.classes.push(cls);
      for (const c of node.children || []) walk(c, depth + 1);
    };
    walk(rendered, 0);

    check('渲染出引导区',
      seen.classes.some((c) => c.includes('dsh-push-pickguide')), seen.classes.join(' | ').slice(0, 80));
    check('渲染出大按钮（可点击）', seen.buttons >= 2, seen.buttons + ' 个 button');
  }
}

/* ---- 6. 能换目录、也能清除 ---- */
{
  const start = src.indexOf('function DevDockHeaderEntry(props) {');
  const end = src.indexOf('\n}\n', start);
  const body = start >= 0 ? src.slice(start, end) : '';

  check('提供清除目录的动作', /const clear = \(\) =>/.test(body));
  check('清除后会写回空值', /setDir\(''\)/.test(body) && /writeViewPref\('headerDir', ''\)/.test(body));
  check('左下角有清除按钮', body.includes("t('headerClearDir')"));
  check('小按钮显示目录名而不是整条路径', body.includes('basename(dir)'));
  check('存在 basename 辅助函数', /function basename\(/.test(src));
  check('按钮 title 显示完整路径（便于辨认）', body.includes('title: dir'));
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
