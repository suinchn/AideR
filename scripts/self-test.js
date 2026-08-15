'use strict';
/**
 * self-test.js — end-to-end verification of the R session engine.
 *
 * Use once R is installed:
 *     npm test
 *
 * Validates the core requirement: the AI / user can run code in a persistent
 * R session and reference earlier variables later (state persistence).
 */

const { RSession, findRscript } = require('../server/r-engine');

async function main() {
  const rscript = process.env.RSCRIPT || undefined;
  console.log(`→ 使用 Rscript: ${findRscript(rscript)}`);
  const s = new RSession({ rscript });

  console.log('→ 启动常驻 R 会话…');
  await s.ensureStarted();
  console.log('   ✓ 会话就绪');

  // 1. basic execution + variable appears
  console.log('→ 执行 x <- 1:10 …');
  let r = await s.submit('x <- 1:10');
  assert(r.ok, 'x <- 1:10 执行失败: ' + r.error);
  assert(hasVar(r, 'x'), 'x 未出现在变量窗口');
  console.log('   ✓ x 已创建并出现在变量窗口:', terse(r.output));

  // 2. STATE PERSISTENCE — reference x from a later, separate step
  console.log('→ 第二步用前一步的 x 求均值 mean(x) …');
  r = await s.submit('mean(x)');
  assert(r.ok, 'mean(x) 失败: ' + r.error);
  assert(/5\.5/.test(r.output), `期望 5.5，实测: ${JSON.stringify(r.output)}`);
  console.log('   ✓ mean(x)=5.5 —— 成功引用前一步变量（需求 #5 成立）');

  // 3. data.frame in variables window with class + dim
  console.log('→ 建数据框并建模 …');
  r = await s.submit('df <- data.frame(id=1:5, age=c(54,61,58,47,66)); fit <- lm(age ~ id, df)');
  assert(r.ok, 'df/fit 失败: ' + r.error);
  const dfv = getVar(r, 'df');
  assert(dfv && /data.frame/.test(dfv.class), 'df 未正确显示 class=data.frame');
  const fv = getVar(r, 'fit');
  assert(fv && /lm/.test(fv.class), 'lm 对象未显示');
  console.log('   ✓ 变量窗口正确显示 objects: df(data.frame), fit(lm)');

  // 4. error handling does not kill the session
  console.log('→ 故意报错，随后继续运行 …');
  r = await s.submit('stop("boom")');
  assert(!r.ok, '应返回错误');
  console.log('   ✓ 捕获错误:', terse(r.error));
  r = await s.submit('y <- 42');
  assert(r.ok && hasVar(r, 'y'), '错误后会话未恢复');
  console.log('   ✓ 报错后会话仍可用（y=42 已创建）');

  console.log('\n✅ 全部通过 —— R 会话状态保持验证成功。');
  process.exit(0);

  function hasVar(rr, name) { return (rr.variables || []).some((v) => v.name === name); }
  function getVar(rr, name) { return (rr.variables || []).find((v) => v.name === name); }
  function terse(x) { x = String(x || '').replace(/\s+/g, ' ').trim(); return x.length > 60 ? x.slice(0, 60) + '…' : x; }
  function assert(cond, msg) { if (!cond) { console.error('   ✗ ' + msg); process.exit(1); } }
}

main().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
