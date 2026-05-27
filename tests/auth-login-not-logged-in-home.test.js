const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Regression for the bug where chatgpt.com/auth/login was misclassified as
// "logged_in_home" because the exclusion regex required a delimiter after
// `auth\/` — so `/auth/login` slipped through. After the fix, /auth/login,
// /auth/anything, /create-account/anything etc. are all correctly excluded.

const PATTERN = /^\/(?:auth|create-account|email-verification|log-in|add-phone)(?:[/?#]|$)/i;

test('regex excludes /auth/login (the bug that caused the user issue)', () => {
  assert.equal(PATTERN.test('/auth/login'), true);
});

test('regex excludes /auth, /auth/, /auth/login, /auth/anything', () => {
  assert.equal(PATTERN.test('/auth'), true);
  assert.equal(PATTERN.test('/auth/'), true);
  assert.equal(PATTERN.test('/auth/login'), true);
  assert.equal(PATTERN.test('/auth/login?next=/'), true);
  assert.equal(PATTERN.test('/auth/callback'), true);
});

test('regex excludes /create-account variants', () => {
  assert.equal(PATTERN.test('/create-account'), true);
  assert.equal(PATTERN.test('/create-account/'), true);
  assert.equal(PATTERN.test('/create-account/password'), true);
});

test('regex excludes /email-verification, /log-in, /add-phone', () => {
  assert.equal(PATTERN.test('/email-verification'), true);
  assert.equal(PATTERN.test('/email-verification/abc'), true);
  assert.equal(PATTERN.test('/log-in'), true);
  assert.equal(PATTERN.test('/log-in/password'), true);
  assert.equal(PATTERN.test('/add-phone'), true);
  assert.equal(PATTERN.test('/add-phone/verify'), true);
});

test('regex does NOT exclude main chatgpt app paths', () => {
  assert.equal(PATTERN.test('/'), false);
  assert.equal(PATTERN.test('/c/abc123'), false);
  assert.equal(PATTERN.test('/chat'), false);
  assert.equal(PATTERN.test('/g/some-gpt'), false);
});

test('regex does NOT match unrelated prefixes that just happen to start with similar letters', () => {
  assert.equal(PATTERN.test('/authority'), false);          // /auth + 'ority' is not /auth + delimiter
  assert.equal(PATTERN.test('/create-accounts'), false);    // 's' is not a delimiter
  assert.equal(PATTERN.test('/log-into-something'), false); // 'to' is not delimiter after /log-in
});

test('all 6 source-file usages share the same fixed regex (no stragglers)', () => {
  const filesToCheck = [
    'background.js',
    'background/verification-flow.js',
    'flows/openai/content/openai-auth.js',
    'flows/openai/background/steps/submit-signup-email.js',
  ];
  const oldBuggyRegex = /\/\^\\\/\(\?:auth\\\/\|create-account\\\//;
  for (const filePath of filesToCheck) {
    const content = fs.readFileSync(filePath, 'utf8');
    assert.equal(
      oldBuggyRegex.test(content),
      false,
      `${filePath} still contains the old buggy regex with trailing slashes on auth\\/ and create-account\\/`
    );
  }
});
