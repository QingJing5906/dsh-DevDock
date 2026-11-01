/**
 * 样式注入的更新行为。
 *
 * 起因：改了 CSS 却「还是和原来一样」。根因是 injectStyles 里
 * `if (document.getElementById(STYLE_ID)) return;` —— 旧样式表还在就直接
 * 返回，插件重载后新 CSS 从未写入。这类 bug 只有真的跑一遍才能发现。
 *
 * Run: node tests/verify-style-inject.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

/* ---- 1. 源码不再有「存在即返回」的早退 ---- */
{
  check('不再存在旧的早退写法',
    !/if \(document\.getElementById\(STYLE_ID\)\) return;/.test(src));
  check('会复用已有 style 元素', /const existing = document\.getElementById\(STYLE_ID\)/.test(src));
  check('内容不同时会覆盖', /existing\.textContent !== CSS/.test(src));
}

/* ---- 2. 真跑 injectStyles：已有 style 必须被更新 ---- */
{
  const start = src.indexOf('function injectStyles() {');
  const end = src.indexOf('\n    }', start);
  const body = src.slice(start, end + 6);
  check('抽出了 injectStyles', start > 0 && body.includes('textContent'));

  /** 造一个假 document，记录对 style 的写入。 */
  /**
   * 真实 DOM 里 createElement 只会拿到一个「还没插入」的空元素，
   * 它没有 id、也不在文档中。之前的桩让假元素天生就带 id，
   * 于是「样式表不存在」这个场景永远测不出来——测试本身错了。
   */
  function makeDom(existingText) {
    let appended = 0;
    const existing = existingText === null
      ? null
      : { id: 'dsh-push-styles', textContent: existingText, dataset: {} };
    const created = { id: '', textContent: '', dataset: {} };
    const document = {
      head: { appendChild: (el) => { appended += 1; el.inserted = true; } },
      documentElement: { appendChild: (el) => { appended += 1; el.inserted = true; } },
      getElementById: (id) => (existing && existing.id === id ? existing : null),
      createElement: () => created,
    };
    const target = existing || created;
    return { document, styleEl: target, created, getAppended: () => appended };
  }

  function run(existingText) {
    const dom = makeDom(existingText);
    const fn = new Function('document', 'STYLE_ID', 'CSS', body + '\nreturn injectStyles;');
    const injectStyles = fn(dom.document, 'dsh-push-styles', '.new-rule { color: red; }');
    injectStyles();
    return dom;
  }

  /* 场景 A：样式表已存在，内容是旧的 -> 必须被替换 */
  {
    const dom = run('.old-rule { color: blue; }');
    check('已存在的旧样式被更新为新内容',
      dom.styleEl.textContent === '.new-rule { color: red; }',
      dom.styleEl.textContent);
    check('不重复插入新的 style 标签', dom.getAppended() === 0, String(dom.getAppended()));
  }

  /* 场景 B：样式表不存在 -> 新建并插入 */
  {
    const dom = run(null);
    /* 内容相同则什么都不做；内容为空说明新建了 */
    check('不存在时会创建并写入内容',
      dom.styleEl.textContent === '.new-rule { color: red; }',
      String(dom.styleEl.textContent));
    check('不存在时插入了 style 标签', dom.getAppended() === 1, String(dom.getAppended()));
  }

  /* 场景 C：内容已经是最新的 -> 不重复写 */
  {
    const dom = run('.new-rule { color: red; }');
    check('内容已最新时不重复写入',
      dom.styleEl.textContent === '.new-rule { color: red; }');
    check('内容已最新时不再插入', dom.getAppended() === 0);
  }
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
