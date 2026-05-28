const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('flows/openai/content/openai-auth.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function buildApi({
  phoneByIdElement = null,
  phoneByNameElement = null,
  phoneByAutocompleteElement = null,
  emailInputElement = null,
  phoneInputElement = null,
} = {}) {
  const phoneJson = JSON.stringify(phoneByIdElement);
  const phoneNameJson = JSON.stringify(phoneByNameElement);
  const phoneAutoJson = JSON.stringify(phoneByAutocompleteElement);
  const emailJson = JSON.stringify(emailInputElement);
  const phoneFallbackJson = JSON.stringify(phoneInputElement);
  return new Function(`
const phoneByIdElement = ${phoneJson};
const phoneByNameElement = ${phoneNameJson};
const phoneByAutocompleteElement = ${phoneAutoJson};
const emailInputElement = ${emailJson};
const phoneInputElement = ${phoneFallbackJson};
const location = { href: 'https://chatgpt.com/auth/login', pathname: '/auth/login' };
const document = {
  title: 'ChatGPT',
  getElementById(id) {
    if (id === 'phoneNumberInput') return phoneByIdElement;
    return null;
  },
  querySelectorAll() {
    return [];
  },
  querySelector(selector) {
    if (typeof selector !== 'string') return null;
    // Mirror the new code: prefers #phoneNumberInput via querySelector first.
    if (/#phoneNumberInput/.test(selector)) {
      return phoneByIdElement;
    }
    if (/name="phone(?:Number(?:Input)?|_number)"/.test(selector)) {
      return phoneByNameElement;
    }
    if (/autocomplete="tel/.test(selector)) {
      return phoneByAutocompleteElement;
    }
    if (/type="email"|id="email"|name="email"|autocomplete="email"/.test(selector)) {
      return emailInputElement;
    }
    if (/type="tel"/.test(selector)) {
      return phoneInputElement;
    }
    return null;
  },
};

function isPhoneVerificationPageReady() { return false; }
function getStep4PostVerificationState() { return null; }
function isVerificationPageStillVisible() { return false; }
function isSignupPasswordPage() { return false; }
function getSignupPasswordInput() { return null; }
function getSignupPasswordSubmitButton() { return null; }
function getSignupPasswordDisplayedEmail() { return ''; }
function getSignupPasswordFieldErrorText() { return ''; }
function getSignupEmailInput() { return emailInputElement; }
function getSignupEmailContinueButton() { return null; }
function findSignupUsePhoneTrigger() { return null; }
function getSignupPhoneInput() { return phoneInputElement; }
function findSignupUseEmailTrigger() { return null; }
function isChatgptAuthLoginEntryUrl() { return false; }
function findSignupEntryTrigger() { return null; }
function getVerificationCodeTarget() { return null; }
function getPhoneVerificationDisplayedPhone() { return ''; }

${extractFunction('inspectSignupEntryState')}

return { inspectSignupEntryState };
`)();
}

test('inspectSignupEntryState reports phone_entry when only #phoneNumberInput is present', () => {
  const api = buildApi({
    phoneByIdElement: { id: 'phoneNumberInput', type: 'tel' },
    emailInputElement: null,
    phoneInputElement: null,
  });
  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'phone_entry');
  assert.deepEqual(snapshot.phoneInput, { id: 'phoneNumberInput', type: 'tel' });
  assert.equal(snapshot.detectedBy, 'phoneNumberInput-id');
});

test('inspectSignupEntryState prefers #phoneNumberInput over a stale email input element', () => {
  // This is the bug-fix case: page DOM has both an email input (leftover) and a
  // phoneNumberInput (user already selected phone signup). Previously inspect()
  // returned email_entry because the email input check ran first, then step 2
  // would loop trying to «switch to phone» on a page that is already on phone.
  const api = buildApi({
    phoneByIdElement: { id: 'phoneNumberInput', type: 'tel' },
    emailInputElement: { id: 'emailInput', type: 'email' },
    phoneInputElement: null,
  });
  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'phone_entry', 'should prefer phone_entry when #phoneNumberInput exists');
  assert.equal(snapshot.detectedBy, 'phoneNumberInput-id');
});

test('inspectSignupEntryState falls back to email_entry when #phoneNumberInput is absent', () => {
  const api = buildApi({
    phoneByIdElement: null,
    emailInputElement: { id: 'emailInput', type: 'email' },
    phoneInputElement: null,
  });
  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'email_entry');
});

test('inspectSignupEntryState detects phone_entry via input[name="phoneNumber"] when id is missing', () => {
  const api = buildApi({
    phoneByIdElement: null,
    phoneByNameElement: { name: 'phoneNumber', type: 'tel' },
    emailInputElement: { id: 'emailInput', type: 'email' },
  });
  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'phone_entry');
  assert.equal(snapshot.detectedBy, 'phoneNumber-name');
});

test('inspectSignupEntryState detects phone_entry via input[autocomplete="tel"] as last marker', () => {
  const api = buildApi({
    phoneByIdElement: null,
    phoneByNameElement: null,
    phoneByAutocompleteElement: { autocomplete: 'tel', type: 'tel' },
    emailInputElement: { id: 'emailInput', type: 'email' },
  });
  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'phone_entry');
  assert.equal(snapshot.detectedBy, 'autocomplete-tel');
});

test('getActiveSignupDialog prefers the signup-form dialog when a marketing promo dialog also visible', () => {
  // 回归：chatgpt.com 主页营销弹窗（"Images 2.0 重磅登场 / 登录或注册即可创作"）和真正的
  // 注册 modal 同时可见时，必须挑后者；否则后续所有 input/button 检测全失败、流程死循环点 免费注册。
  const promoDialog = {
    tagName: 'DIV',
    getAttribute: () => null,
    inert: false,
    getBoundingClientRect: () => ({ width: 448, height: 100 }),
    querySelector: (selector) => {
      // 营销弹窗里没有任何 email/phone/Google/Apple 按钮 —— 只有"登录或注册即可创作"和"暂不"
      void selector;
      return null;
    },
    querySelectorAll: () => [
      { textContent: '登录或注册即可创作' },
      { textContent: '暂不' },
    ],
  };
  const signupDialog = {
    tagName: 'DIV',
    getAttribute: () => null,
    inert: false,
    getBoundingClientRect: () => ({ width: 388, height: 608 }),
    querySelector: (selector) => {
      if (/#phoneNumberInput/.test(selector)) return null; // currently in email mode
      if (/type="email"|id="email"|name="email"|autocomplete="email"/.test(selector)) {
        return { id: 'email', type: 'email' };
      }
      return null;
    },
    querySelectorAll: () => [
      { textContent: '使用 Google 账户继续' },
      { textContent: '使用 Apple 账户继续' },
      { textContent: '使用电话号码继续' },
      { textContent: '继续' },
    ],
  };

  const api = new Function(`
const promoDialog = arguments[0];
const signupDialog = arguments[1];
const document = {
  querySelectorAll(selector) {
    if (/\\[role="dialog"\\]/.test(selector)) return [promoDialog, signupDialog];
    return [];
  },
};
const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
${require('node:fs').readFileSync('flows/openai/content/openai-auth.js', 'utf8').match(/function getActiveSignupDialog\([\s\S]*?\n\}/)[0]}
return { getActiveSignupDialog };
`)(promoDialog, signupDialog);

  const chosen = api.getActiveSignupDialog();
  assert.strictEqual(chosen, signupDialog, 'should pick the dialog containing email/phone/Google/Apple buttons over the promo dialog');
});

test('getActiveSignupDialog falls back to the first visible dialog when none has signup signals', () => {
  // 守卫：如果所有 visible dialog 都不含注册表单标记（比如全是营销/通用提示框），
  // 仍然返回第一个，保持旧行为不破坏其他场景。
  const dialogA = {
    tagName: 'DIV',
    getAttribute: () => null,
    inert: false,
    getBoundingClientRect: () => ({ width: 300, height: 200 }),
    querySelector: () => null,
    querySelectorAll: () => [{ textContent: '其它操作' }],
  };
  const dialogB = {
    tagName: 'DIV',
    getAttribute: () => null,
    inert: false,
    getBoundingClientRect: () => ({ width: 200, height: 100 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const api = new Function(`
const dialogA = arguments[0];
const dialogB = arguments[1];
const document = {
  querySelectorAll(selector) {
    if (/\\[role="dialog"\\]/.test(selector)) return [dialogA, dialogB];
    return [];
  },
};
const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
${require('node:fs').readFileSync('flows/openai/content/openai-auth.js', 'utf8').match(/function getActiveSignupDialog\([\s\S]*?\n\}/)[0]}
return { getActiveSignupDialog };
`)(dialogA, dialogB);

  const chosen = api.getActiveSignupDialog();
  assert.strictEqual(chosen, dialogA, 'should fall back to the first visible dialog when no signup signals found');
});

test('inspectSignupEntryState returns phone_entry_pending when switch-to-email button is in dialog but phone input not yet rendered', () => {
  // Critical chatgpt.com bug: after clicking "use phone number to continue",
  // the dialog switch button text changes to "switch to email" immediately
  // (marks "we're in phone mode") but the phoneNumberInput takes a few seconds
  // to render (OpenAI does IP geolocation). During that gap, email input is
  // still in DOM. Old code misjudged this as email_entry and re-clicked the
  // (now reversed) switch button, flipping the modal back to email. We must
  // return phone_entry_pending so the loop only waits, never clicks.
  const switchToEmailBtn = { tagName: 'BUTTON', textContent: '使用电子邮箱继续' };
  const staleEmailInput = { id: 'email', type: 'email' };
  const api = new Function(`
const switchToEmailBtn = ${JSON.stringify(switchToEmailBtn)};
const staleEmailInput = ${JSON.stringify(staleEmailInput)};
const activeDialog = {
  getAttribute() { return null; },
  inert: false,
  getBoundingClientRect() { return { width: 400, height: 600 }; },
  querySelector(selector) {
    if (/type="email"|id="email"/.test(selector)) return staleEmailInput;
    return null;
  },
  querySelectorAll(selector) {
    if (/button/.test(selector)) {
      return [switchToEmailBtn];
    }
    return [];
  },
};
const location = { href: 'https://chatgpt.com/', pathname: '/' };
const window = { getComputedStyle() { return { display: 'block', visibility: 'visible' }; } };
const document = {
  title: 'ChatGPT',
  querySelectorAll(selector) {
    if (/\\[role="dialog"\\]/.test(selector)) return [activeDialog];
    return [];
  },
  querySelector() { return null; },
  getElementById() { return null; },
};

function isPhoneVerificationPageReady() { return false; }
function getStep4PostVerificationState() { return null; }
function isVerificationPageStillVisible() { return false; }
function isSignupPasswordPage() { return false; }
function getSignupPasswordInput() { return null; }
function getSignupPasswordSubmitButton() { return null; }
function getSignupPasswordDisplayedEmail() { return ''; }
function getSignupPasswordFieldErrorText() { return ''; }
function getSignupEmailInput() { return null; }
function getSignupEmailContinueButton() { return null; }
function getSignupPhoneInput() { return null; }
function isChatgptAuthLoginEntryUrl() { return false; }
function findSignupEntryTrigger() { return null; }
function getVerificationCodeTarget() { return null; }
function getPhoneVerificationDisplayedPhone() { return ''; }
function isVisibleElement() { return true; }
function isActionEnabled() { return true; }
function getActionText(el) { return (el?.textContent || '').trim(); }
const SIGNUP_WORK_EMAIL_PATTERN = /\\u5de5\\u4f5c|business|work\\s+email/i;
const SIGNUP_SWITCH_TO_EMAIL_PATTERN = /\\u4f7f\\u7528\\u7535\\u5b50\\u90ae\\u7bb1\\u7ee7\\u7eed|\\u7ee7\\u7eed\\u4f7f\\u7528\\u7535\\u5b50\\u90ae\\u4ef6/i;
const SIGNUP_SWITCH_ACTION_PATTERN = /\\u4f7f\\u7528/;
const SIGNUP_EMAIL_ACTION_PATTERN = /\\u7535\\u5b50\\u90ae\\u7bb1/;

${extractFunction('getActiveSignupDialog')}
${extractFunction('findSignupUseEmailTrigger')}
${extractFunction('inspectSignupEntryState')}

return { inspectSignupEntryState };
`)();

  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'phone_entry_pending');
  assert.equal(snapshot.dialogOpen, true);
  assert.ok(snapshot.switchToEmailTrigger, 'should expose the switch-to-email trigger for diagnostics');
});

test('inspectSignupEntryState scopes to active dialog when present: phone input only in dialog', () => {
  // Replicate the chatgpt.com modal scenario: page DOM has no phone input outside,
  // but the modal contains #phoneNumberInput. Must detect phone_entry.
  const dialogPhoneInput = { id: 'phoneNumberInput', type: 'tel' };
  const api = new Function(`
const dialogPhoneInput = ${JSON.stringify(dialogPhoneInput)};
const activeDialog = {
  getAttribute() { return null; },
  inert: false,
  getBoundingClientRect() { return { width: 400, height: 600 }; },
  querySelector(selector) {
    if (/#phoneNumberInput/.test(selector)) return dialogPhoneInput;
    if (/type="tel"/.test(selector)) return dialogPhoneInput;
    return null;
  },
  querySelectorAll() { return []; },
};
const location = { href: 'https://chatgpt.com/', pathname: '/' };
const window = { getComputedStyle() { return { display: 'block', visibility: 'visible' }; } };
const document = {
  title: 'ChatGPT',
  querySelectorAll(selector) {
    if (/\\[role="dialog"\\]/.test(selector)) return [activeDialog];
    return [];
  },
  querySelector() { return null; },
  getElementById() { return null; },
};

function isPhoneVerificationPageReady() { return false; }
function getStep4PostVerificationState() { return null; }
function isVerificationPageStillVisible() { return false; }
function isSignupPasswordPage() { return false; }
function getSignupPasswordInput() { return null; }
function getSignupPasswordSubmitButton() { return null; }
function getSignupPasswordDisplayedEmail() { return ''; }
function getSignupPasswordFieldErrorText() { return ''; }
function getSignupEmailInput() { return null; }
function getSignupEmailContinueButton() { return null; }
function findSignupUsePhoneTrigger() { return null; }
function findSignupUseEmailTrigger() { return null; }
function getSignupPhoneInput() { return null; }
function isChatgptAuthLoginEntryUrl() { return false; }
function findSignupEntryTrigger() { return null; }
function getVerificationCodeTarget() { return null; }
function getPhoneVerificationDisplayedPhone() { return ''; }
function isVisibleElement() { return true; }
function isActionEnabled() { return true; }
function getActionText() { return ''; }

${extractFunction('getActiveSignupDialog')}
${extractFunction('inspectSignupEntryState')}

return { inspectSignupEntryState };
`)();

  const snapshot = api.inspectSignupEntryState();
  assert.equal(snapshot.state, 'phone_entry');
  assert.equal(snapshot.detectedBy, 'phoneNumberInput-id-in-dialog');
  assert.equal(snapshot.dialogOpen, true);
});
