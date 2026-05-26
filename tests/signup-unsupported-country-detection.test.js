const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const backgroundSource = fs.readFileSync('background.js', 'utf8');

function extractFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (!Number.isInteger(start) || start < 0) {
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
  for (let end = braceStart; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, end + 1);
      }
    }
  }
  throw new Error(`missing closing brace for ${name}`);
}

const api = new Function(`
  function getErrorMessage(error) {
    return String(typeof error === 'string' ? error : error?.message || '');
  }
  ${extractFunction(backgroundSource, 'isSignupUnsupportedCountryFailure')}
  return { isSignupUnsupportedCountryFailure };
`)();

test('matches SIGNUP_UNSUPPORTED_COUNTRY error prefix from content script', () => {
  assert.equal(
    api.isSignupUnsupportedCountryFailure(
      new Error('SIGNUP_UNSUPPORTED_COUNTRY::步骤 5：当前 IP 所在区域被 OpenAI 拒绝（unsupported_country）。')
    ),
    true
  );
});

test('matches the raw unsupported_country error code from OpenAI', () => {
  assert.equal(
    api.isSignupUnsupportedCountryFailure(new Error('错误代码：unsupported_country')),
    true
  );
});

test('matches the Chinese page copy "OpenAI 服务在你所在的国家/地区不可用"', () => {
  assert.equal(
    api.isSignupUnsupportedCountryFailure(new Error('OpenAI 服务在你所在的国家/地区不可用。')),
    true
  );
});

test('matches English copy "OpenAI services are not available in your country"', () => {
  assert.equal(
    api.isSignupUnsupportedCountryFailure(
      new Error('OpenAI services are not available in your country.')
    ),
    true
  );
  assert.equal(
    api.isSignupUnsupportedCountryFailure(
      new Error("OpenAI's service is not available in your region")
    ),
    true
  );
});

test('does not misfire on unrelated errors', () => {
  assert.equal(api.isSignupUnsupportedCountryFailure(new Error('SIGNUP_PHONE_PASSWORD_MISMATCH::...')), false);
  assert.equal(api.isSignupUnsupportedCountryFailure(new Error('STEP8_EMAIL_IN_USE::abc')), false);
  assert.equal(api.isSignupUnsupportedCountryFailure(new Error('PHONE_RESEND_BANNED_NUMBER::...')), false);
  assert.equal(api.isSignupUnsupportedCountryFailure(new Error('网络异常')), false);
  assert.equal(api.isSignupUnsupportedCountryFailure(null), false);
  assert.equal(api.isSignupUnsupportedCountryFailure(''), false);
});
