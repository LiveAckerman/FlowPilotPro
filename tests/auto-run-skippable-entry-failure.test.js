const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
const api = new Function('self', `${source}; return self.MultiPageBackgroundAutoRunController;`)({});
const { isRoundSkippableEntryFailure } = api;

test('isRoundSkippableEntryFailure matches the "stuck on logged-in ChatGPT home" guard error', () => {
  const msg = '步骤 2：检测到当前停留在已登录 ChatGPT 首页，已阻止自动跳过步骤 3/4/5。请先执行步骤 1 清理会话后重试。';
  assert.equal(isRoundSkippableEntryFailure(msg), true);
});

test('isRoundSkippableEntryFailure matches the content-script disconnect transport error', () => {
  const msg = '认证页 页面刚完成跳转或刷新，内容脚本还没有重新接回；扩展已自动重试，但仍未恢复。请重试当前步骤。';
  assert.equal(isRoundSkippableEntryFailure(msg), true);
});

test('isRoundSkippableEntryFailure matches the combined error from the user log', () => {
  const msg = '步骤 2：检测到当前停留在已登录 ChatGPT 首页，已阻止自动跳过步骤 3/4/5。请先执行步骤 1 清理会话后重试。（触发原因：认证页 页面刚完成跳转或刷新，内容脚本还没有重新接回；扩展已自动重试，但仍未恢复。请重试当前步骤。）';
  assert.equal(isRoundSkippableEntryFailure(msg), true);
});

test('isRoundSkippableEntryFailure does NOT match unrelated hard failures', () => {
  assert.equal(isRoundSkippableEntryFailure('SIGNUP_PHONE_PASSWORD_MISMATCH::...'), false);
  assert.equal(isRoundSkippableEntryFailure('PHONE_RESEND_BANNED_NUMBER::...'), false);
  assert.equal(isRoundSkippableEntryFailure('STEP8_EMAIL_IN_USE::...'), false);
  assert.equal(isRoundSkippableEntryFailure('认证失败: Request failed with status code 502'), false);
  assert.equal(isRoundSkippableEntryFailure(''), false);
  assert.equal(isRoundSkippableEntryFailure(null), false);
});

test('auto-run-controller source: skippable entry failure bypasses the autoRunSkipFailures stop and continues next round', () => {
  // 结构守卫：!autoRunSkipFailures 的停整段逻辑必须额外加 !skippableEntryFailure 条件，
  // 且 skippable 情况下走 forceFreshTabsNextRun + break（继续下一轮），不 broadcast stopped。
  assert.ok(
    /const skippableEntryFailure = isRoundSkippableEntryFailure\(reason\)/.test(source),
    'final-failure block should compute skippableEntryFailure'
  );
  assert.ok(
    /if \(!autoRunSkipFailures && !skippableEntryFailure\)/.test(source),
    'the stop-entire-run branch must be gated by !skippableEntryFailure'
  );
  assert.ok(
    source.includes('自动跳过当前轮继续下一轮（下一轮会清理会话重开）'),
    'should log a skip-to-next-round message for skippable entry failures'
  );
});
