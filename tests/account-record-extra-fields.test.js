const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/account-run-history.js', 'utf8');
const api = new Function('self', `${source}; return self.MultiPageBackgroundAccountRunHistory;`)({});

function makeHelpers() {
  return api.createAccountRunHistoryHelpers({
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    getState: async () => ({}),
    normalizeAccountRunHistoryHelperBaseUrl: (value) => String(value || '').trim(),
  });
}

test('buildAccountRunHistoryRecord records phone SMS verification code + activation info from state', () => {
  const helpers = makeHelpers();
  const record = helpers.buildAccountRunHistoryRecord({
    accountIdentifierType: 'phone',
    accountIdentifier: '+573237462004',
    signupPhoneNumber: '+573237462004',
    password: 'Secret123!',
    currentPhoneVerificationCode: '260294',
    signupMethod: 'phone',
    mailProvider: 'duck',
    signupPhoneActivation: {
      activationId: 'A12345',
      phoneNumber: '+573237462004',
      provider: 'hero-sms',
      countryLabel: 'Colombia',
    },
  }, 'failed', '步骤 4：手机验证码超时。');

  assert.equal(record.verificationCode, '260294');
  assert.equal(record.smsActivationId, 'A12345');
  assert.equal(record.smsProvider, 'hero-sms');
  assert.equal(record.countryLabel, 'Colombia');
  assert.equal(record.signupMethod, 'phone');
  assert.equal(record.mailProvider, 'duck');
});

test('buildAccountRunHistoryRecord prefers completed activation over in-progress one', () => {
  const helpers = makeHelpers();
  const record = helpers.buildAccountRunHistoryRecord({
    accountIdentifierType: 'phone',
    accountIdentifier: '+10000000',
    signupPhoneNumber: '+10000000',
    signupPhoneCompletedActivation: { activationId: 'DONE', provider: 'five-sim', countryLabel: 'Vietnam' },
    signupPhoneActivation: { activationId: 'PENDING', provider: 'hero-sms', countryLabel: 'Thailand' },
  }, 'success');

  assert.equal(record.smsActivationId, 'DONE');
  assert.equal(record.smsProvider, 'five-sim');
  assert.equal(record.countryLabel, 'Vietnam');
});

test('normalizeAccountRunHistoryRecord preserves extra fields on read (not stripped)', () => {
  const helpers = makeHelpers();
  const normalized = helpers.normalizeAccountRunHistoryRecord({
    recordId: 'phone:+573237462004',
    accountIdentifierType: 'phone',
    accountIdentifier: '+573237462004',
    phoneNumber: '+573237462004',
    finalStatus: 'failed',
    verificationCode: '260294',
    smsActivationId: 'A12345',
    smsProvider: 'hero-sms',
    countryLabel: 'Colombia',
    signupMethod: 'phone',
    mailProvider: 'duck',
  });

  assert.equal(normalized.verificationCode, '260294');
  assert.equal(normalized.smsActivationId, 'A12345');
  assert.equal(normalized.smsProvider, 'hero-sms');
  assert.equal(normalized.countryLabel, 'Colombia');
  assert.equal(normalized.signupMethod, 'phone');
  assert.equal(normalized.mailProvider, 'duck');
});

test('upsert inherits verification code from a prior record when the new build lost it (running -> failed)', () => {
  const helpers = makeHelpers();
  // 第一条：running 时带着验证码
  const runningRecord = helpers.buildAccountRunHistoryRecord({
    accountIdentifierType: 'phone',
    accountIdentifier: '+573237462004',
    signupPhoneNumber: '+573237462004',
    password: 'Secret123!',
    currentPhoneVerificationCode: '260294',
    signupPhoneActivation: { activationId: 'A12345', provider: 'hero-sms', countryLabel: 'Colombia' },
  }, 'running');
  const history1 = helpers.upsertAccountRunHistoryRecord([], runningRecord);

  // 第二条：同号但 state 已清空验证码/activation（progress 到 failed）
  const failedRecord = helpers.buildAccountRunHistoryRecord({
    accountIdentifierType: 'phone',
    accountIdentifier: '+573237462004',
    signupPhoneNumber: '+573237462004',
    password: 'Secret123!',
  }, 'failed', '步骤 4：手机验证码超时。');
  const history2 = helpers.upsertAccountRunHistoryRecord(history1, failedRecord);

  const merged = history2.find((r) => r.phoneNumber === '+573237462004');
  assert.equal(merged.finalStatus, 'failed');
  assert.equal(merged.verificationCode, '260294', 'verification code should be inherited from the prior running record');
  assert.equal(merged.smsActivationId, 'A12345', 'activation id should be inherited too');
  assert.equal(merged.countryLabel, 'Colombia');
});

test('extra fields are empty strings (not undefined) for plain email records', () => {
  const helpers = makeHelpers();
  const record = helpers.buildAccountRunHistoryRecord({
    email: 'user@example.com',
    password: 'pw',
  }, 'success');
  assert.equal(record.verificationCode, '');
  assert.equal(record.smsActivationId, '');
  assert.equal(record.smsProvider, '');
  assert.equal(record.countryLabel, '');
  assert.equal(record.signupMethod, '');
});
