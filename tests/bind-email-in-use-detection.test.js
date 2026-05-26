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
  ${extractFunction(backgroundSource, 'isBindEmailAddressInUseFailure')}
  return { isBindEmailAddressInUseFailure };
`)();

test('detects STEP8_EMAIL_IN_USE error prefix (the canonical content-script throw)', () => {
  assert.equal(
    api.isBindEmailAddressInUseFailure(
      new Error('STEP8_EMAIL_IN_USE::email_in_use on add-email verification page; choose a different email.')
    ),
    true
  );
});

test('detects raw OpenAI error code email_already_in_use (was missed by old /email_in_use/ regex)', () => {
  assert.equal(
    api.isBindEmailAddressInUseFailure(new Error('错误代码：email_already_in_use')),
    true
  );
});

test('detects raw OpenAI error code email_in_use', () => {
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('email_in_use')), true);
});

test('detects Chinese phrase 该邮箱地址已有关联账户', () => {
  assert.equal(
    api.isBindEmailAddressInUseFailure(new Error('该邮箱地址已有关联账户。请改为登录。')),
    true
  );
});

test('detects Chinese phrase 该邮箱已被使用 / 该邮箱已被绑定 / 该邮箱已被占用', () => {
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('该邮箱已被使用')), true);
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('该邮箱已被绑定')), true);
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('该邮箱已被占用')), true);
});

test('does not match unrelated errors', () => {
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('SIGNUP_PHONE_PASSWORD_MISMATCH::...')), false);
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('PHONE_RESEND_BANNED_NUMBER::...')), false);
  assert.equal(api.isBindEmailAddressInUseFailure(new Error('网络异常')), false);
  assert.equal(api.isBindEmailAddressInUseFailure(null), false);
  assert.equal(api.isBindEmailAddressInUseFailure(''), false);
});
