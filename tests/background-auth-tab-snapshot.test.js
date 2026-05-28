const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background.js', 'utf8');

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

function createApi(chrome) {
  return new Function('chrome', `
${extractFunction('readAuthTabSnapshot')}
return { readAuthTabSnapshot };
`)(chrome);
}

test('readAuthTabSnapshot returns synthetic HTTP 500 text when script execution fails on auth contact-verification error pages', async () => {
  // OpenAI 的 /contact-verification 端点在后端 5xx 时，Chrome 渲染原生错误页（chrome-error://chromewebdata/）。
  // 内容脚本被屏蔽 → executeScript 抛错，body 文本读不到。
  // readAuthTabSnapshot 必须返回合成 HTTP 500 文字，让上游 isPhoneResendServerError 正则命中、
  // 触发活动取消 + 换号重跑，避免流程卡死在无法读取的错误页上。
  const chrome = {
    scripting: {
      executeScript: async () => {
        throw new Error('Cannot access contents of url "chrome-error://chromewebdata/".');
      },
    },
    tabs: {
      get: async () => ({
        id: 1,
        url: 'https://auth.openai.com/contact-verification',
        title: 'auth.openai.com',
      }),
    },
  };

  const api = createApi(chrome);
  const snapshot = await api.readAuthTabSnapshot(1);
  assert.equal(snapshot.url, 'https://auth.openai.com/contact-verification');
  assert.equal(snapshot.title, 'auth.openai.com');
  // The synthetic text must contain a pattern that isPhoneResendServerError matches
  // (in particular "HTTP ERROR 500"), so the existing detection chain fires.
  assert.match(snapshot.text, /HTTP ERROR 500/);
  assert.match(snapshot.text, /contact-verification/);
});

test('readAuthTabSnapshot returns empty text for unrelated error pages (no synthetic 500 injection)', async () => {
  // 守卫：合成 5xx 文字只应在 URL 是 /contact-verification 这种已知会触发 5xx 的端点上注入。
  // 任意其他页面 script 失败时只返回空 text，避免错误地把别的页面也标成 500。
  const chrome = {
    scripting: {
      executeScript: async () => {
        throw new Error('Cannot access contents of url "chrome-error://chromewebdata/".');
      },
    },
    tabs: {
      get: async () => ({
        id: 1,
        url: 'https://auth.openai.com/log-in/password',
        title: 'OpenAI',
      }),
    },
  };

  const api = createApi(chrome);
  const snapshot = await api.readAuthTabSnapshot(1);
  assert.equal(snapshot.url, 'https://auth.openai.com/log-in/password');
  assert.equal(snapshot.text || '', '');
});
