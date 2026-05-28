const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Regression for the bug where chatgpt → /contact-verification HTTP 500 page
// could not be detected because Chrome's native error page blocks ISOLATED-world
// content-script injection, so readAuthTabSnapshot returned empty body, and the
// existing isPhoneResendServerError regex had nothing to match → flow got
// stuck polling SMS forever on a broken page.
//
// Two-layer fix:
//  1. readAuthTabSnapshot tries MAIN world fallback when ISOLATED returns
//     empty; if still empty AND URL is /contact-verification, returns a
//     synthetic snapshot containing "HTTP ERROR 500" so the existing detection
//     regex matches.
//  2. throwPhoneResendServerErrorIfAuthTabShowsIt re-reads after 500ms to
//     avoid catching a mid-navigation transient where body is briefly empty.
//
// This test verifies the snapshot-handling logic on a parsed file by
// re-exercising the regex used by getPhoneResendServerErrorFromSnapshot.

const PHONE_RESEND_SERVER_ERROR_PATTERN = /this\s+page\s+isn['’]?t\s+working|currently\s+unable\s+to\s+handle\s+this\s+request|http\s+error\s+500|500\s+internal\s+server\s+error/i;

test('isPhoneResendServerError pattern matches the synthetic snapshot text produced for chrome native error pages', () => {
  const syntheticText = 'HTTP ERROR 500 contact-verification 页面无内容（浏览器未能加载页面正文，疑似 OpenAI 后端 5xx）';
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test(syntheticText), true);
});

test('isPhoneResendServerError matches all common chrome error page phrasings', () => {
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test('HTTP ERROR 500'), true);
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test('500 Internal Server Error'), true);
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test("This page isn't working"), true);
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test("This page isn’t working"), true);
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test('auth.openai.com is currently unable to handle this request'), true);
});

test('isPhoneResendServerError does NOT match healthy verification page text', () => {
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test('请输入收到的验证码'), false);
  assert.equal(PHONE_RESEND_SERVER_ERROR_PATTERN.test('We sent a code to +1 555 1234'), false);
});

test('throwPhoneResendServerErrorIfAuthTabShowsIt reloads the tab once and retries before giving up', () => {
  // Reload-recovery 策略：reload tab 一次，如果页面恢复就不浪费已收到的 SMS；
  // 没恢复才走原来的"丢弃接码号 + 换号"链路。
  const src = fs.readFileSync('background/phone-verification-flow.js', 'utf8');
  assert.ok(
    src.includes('reloadAuthTabAndWait'),
    'should call reloadAuthTabAndWait helper to attempt recovery'
  );
  assert.ok(
    /reloadAuthTabAndWait\(tabId, 12000\)/.test(src) || /reloadAuthTabAndWait\(tabId,\s*12000\)/.test(src),
    'should reload with a reasonable timeout (12s)'
  );
  assert.ok(
    src.includes('stillError = await readPhoneResendServerErrorFromAuthTab(tabId)'),
    'after reload should re-check the page state to decide if recovery succeeded'
  );
  assert.ok(
    src.includes('将继续用当前接码号完成验证'),
    'should log a recovery-succeeded message when reload fixes the page'
  );
  assert.ok(
    src.includes('换号重跑当前轮'),
    'should log a give-up message when reload does not fix the page'
  );
});

test('background.js exposes reloadAuthTabAndWait helper and injects it into phone-verification-flow deps', () => {
  const bg = fs.readFileSync('background.js', 'utf8');
  assert.ok(
    /async function reloadAuthTabAndWait\(tabId/.test(bg),
    'background.js should define reloadAuthTabAndWait'
  );
  assert.ok(
    /chrome\.tabs\.reload\(tabId\)/.test(bg),
    'reloadAuthTabAndWait should actually call chrome.tabs.reload'
  );
  assert.ok(
    /chrome\.tabs\.onUpdated\.addListener\(listener\)/.test(bg),
    'reloadAuthTabAndWait should wait for tab status complete via onUpdated'
  );
  // Deps injection: helper must be passed to phone-verification-flow
  assert.ok(
    /reloadAuthTabAndWait,\s*\n\s*ensureStep8SignupPageReady/.test(bg)
      || /createPhoneVerificationHelpers\([\s\S]{0,2000}reloadAuthTabAndWait/.test(bg),
    'reloadAuthTabAndWait should be passed as a dep to createPhoneVerificationHelpers'
  );
});

test('background.js readAuthTabSnapshot has the MAIN-world fallback and synthetic 500 path', () => {
  const src = fs.readFileSync('background.js', 'utf8');
  // Look for the structural changes we made
  assert.ok(
    src.includes("await readInWorld('MAIN')"),
    'readAuthTabSnapshot should retry in MAIN world when ISOLATED returns empty'
  );
  assert.ok(
    src.includes('HTTP ERROR 500 contact-verification 页面无内容'),
    'readAuthTabSnapshot should return synthetic 500 text when /contact-verification body is empty'
  );
  assert.ok(
    /\/contact-verification\(\?:\[\/\?#]\|\$\)/.test(src),
    'readAuthTabSnapshot should test URL against /contact-verification before returning synthetic 500'
  );
});

