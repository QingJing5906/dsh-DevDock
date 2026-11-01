/**
 * 审查进行中的界面提示。
 *
 * 反馈：「一直显示加载中？如果是在用户看不见的地方跑模型，能不能给点
 * 让人理解的提示」。
 *
 * 之前 running 只把按钮文字换成通用的「加载中」，主区域还停在配置页，
 * 用户既不知道在跑模型，也不知道要等多久、能不能关。
 *
 * Run: node tests/verify-review-running.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('client.js', 'utf8');
const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

const open = src.indexOf('const CSS = `');
const css = src.slice(open + 'const CSS = `'.length, src.indexOf('`;', open));

const start = src.indexOf('function NpmReviewDialog(props) {');
const end = src.indexOf('\n}\n', start);
const body = start >= 0 ? src.slice(start, end) : '';

/* ---- 1. 有独立的运行态界面 ---- */
{
  check('存在运行态界面', body.includes('runningBody'));
  check('运行态被真正渲染', /step === 'running' \? runningBody/.test(body));
  check('不再停在配置页', !/running \? t\('loading'\)/.test(body));
}

/* ---- 2. 说明在做什么，而不是只说「加载中」 ---- */
{
  check('有运行态标题', body.includes("t('npmReviewRunningTitle')"));
  check('说明第一步：读包', body.includes("t('npmReviewStep1')"));
  check('说明第二步：规则扫描', body.includes("t('npmReviewStep2')"));
  check('说明第三步：模型审查', body.includes('npmReviewStep3Model'));
  check('没有模型时说明只跑规则', body.includes("t('npmReviewStep3Rules')"));
}

/* ---- 3. 显示已用时间，让「还在跑」和「卡死」可区分 ---- */
{
  check('有 elapsedMs 状态', body.includes('const [elapsedMs'));
  check('有计时 effect', body.includes('setElapsedMs') && body.includes('setInterval'));
  check('界面显示已用时间', body.includes("t('npmReviewElapsed'"));
  check('停止时清理计时器', body.includes('clearInterval'));
}

/* ---- 4. 说明预期耗时与可以关掉 ---- */
{
  check('说明模型审查大概耗时', body.includes("t('npmReviewSlowHint')"));
  check('说明可以直接关闭', body.includes("t('npmReviewWaitHint')"));
}

/* ---- 5. 步骤圆点有视觉状态 ---- */
{
  check('步骤圆点：已完成', body.includes('dsh-push-npm-step-dot is-done'));
  check('步骤圆点：进行中', body.includes('dsh-push-npm-step-dot is-active'));
  check('进行中有呼吸动画', css.includes('@keyframes dsh-push-pulse'));
}

/* ---- 6. 文案齐全 ---- */
{
  check('中文运行态标题', src.includes('npmReviewRunningTitle: "正在审查"'));
  check('英文运行态标题', src.includes('npmReviewRunningTitle: "Reviewing"'));
  check('footer 也提示进行中', body.includes("t('rvRunningFooter')"));
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
