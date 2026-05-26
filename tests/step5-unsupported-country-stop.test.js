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

const prefixMatch = source.match(/const SIGNUP_UNSUPPORTED_COUNTRY_ERROR_PREFIX = [^\n]+/);
const patternMatch = source.match(/const SIGNUP_UNSUPPORTED_COUNTRY_PATTERN = [^\n]+/);
if (!prefixMatch || !patternMatch) {
  throw new Error('missing SIGNUP_UNSUPPORTED_COUNTRY constants');
}
const constBlock = `${prefixMatch[0]}\n${patternMatch[0]}`;

function buildApi(pageText, title = '糟糕，出错了！') {
  return new Function(`
const document = { title: ${JSON.stringify(title)} };
function getPageTextSnapshot() { return ${JSON.stringify(pageText)}; }
${constBlock}
${extractFunction('detectSignupUnsupportedCountryError')}
${extractFunction('createSignupUnsupportedCountryError')}
return { detectSignupUnsupportedCountryError, createSignupUnsupportedCountryError };
`)();
}

test('detectSignupUnsupportedCountryError catches the Chinese unsupported_country page', () => {
  const api = buildApi('OpenAI 服务在你所在的国家/地区不可用。 错误代码：unsupported_country');
  const detail = api.detectSignupUnsupportedCountryError();
  assert.ok(detail, '应识别中文 unsupported_country 文案');
  assert.match(detail, /OpenAI|unsupported_country/);
});

test('detectSignupUnsupportedCountryError catches the English unsupported_country page', () => {
  const api = buildApi("OpenAI's services are not available in your country. error code: unsupported_country");
  const detail = api.detectSignupUnsupportedCountryError();
  assert.ok(detail, '应识别英文 unsupported_country 文案');
});

test('detectSignupUnsupportedCountryError returns empty for unrelated pages', () => {
  const api = buildApi('糟糕，出错了！ 请重试。');
  assert.equal(api.detectSignupUnsupportedCountryError(), '');
});

test('createSignupUnsupportedCountryError attaches the canonical prefix and VPN hint', () => {
  const api = buildApi('OpenAI 服务在你所在的国家/地区不可用。');
  const err = api.createSignupUnsupportedCountryError('错误代码：unsupported_country');
  assert.ok(/^SIGNUP_UNSUPPORTED_COUNTRY::/.test(err.message), '应携带 SIGNUP_UNSUPPORTED_COUNTRY 前缀');
  assert.match(err.message, /VPN|区域|unsupported_country/);
});
