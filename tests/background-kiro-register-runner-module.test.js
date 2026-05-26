const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadRegisterRunnerApi() {
  const stateSource = fs.readFileSync('flows/kiro/background/state.js', 'utf8');
  const runnerSource = fs.readFileSync('flows/kiro/background/register-runner.js', 'utf8');
  const globalScope = {};
  new Function('self', `${stateSource}; ${runnerSource}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundKiroRegisterRunner;
}

function getKiroRuntime(state = {}) {
  return state?.runtimeState?.flowState?.kiro || {};
}

test('kiro register runner module exposes a factory and Kiro official sign-in entry', () => {
  const api = loadRegisterRunnerApi();
  assert.equal(typeof api?.createKiroRegisterRunner, 'function');
  assert.equal(api?.KIRO_SIGNIN_URL, 'https://app.kiro.dev/signin');
});

test('kiro register runner removed the old AWS device authorization bootstrap', () => {
  const source = fs.readFileSync('flows/kiro/background/register-runner.js', 'utf8');
  assert.doesNotMatch(source, /startBuilderIdDeviceLogin/);
  assert.doesNotMatch(source, /device_authorization/);
  assert.doesNotMatch(source, /verificationUriComplete/);
  assert.match(source, /https:\/\/app\.kiro\.dev\/signin/);
});

test('kiro register runner uses a shared 3-minute page-load timeout budget', () => {
  const source = fs.readFileSync('flows/kiro/background/register-runner.js', 'utf8');
  assert.match(source, /DEFAULT_KIRO_PAGE_LOAD_TIMEOUT_MS/);
  assert.match(source, /createTimeoutBudget/);
  assert.match(source, /resolveTimeoutBudget/);
  assert.match(source, /timeoutBudget\.getRemainingMs\(1000\)/);
  assert.match(source, /onRetryableError: buildKiroRetryRecovery\(tabId, \{\s*\.\.\.options,\s*timeoutBudget,/);
});

test('kiro register consent step treats Kiro Web signed-in page as completion', () => {
  const source = fs.readFileSync('flows/kiro/background/register-runner.js', 'utf8');
  assert.match(source, /readKiroRegisterPageState\(tabId, \{/);
  assert.match(source, /\['authorization_page', 'success_page', 'kiro_web_signed_in'\]\.includes\(landingResult\?\.state\)/);
  assert.match(source, /landingResult\?\.state === 'authorization_page'/);
  assert.doesNotMatch(source, /landingResult\?\.state !== 'success_page'/);
});

test('kiro register runner uses registration-only page states instead of shared OpenAI names', () => {
  const source = fs.readFileSync('flows/kiro/background/register-runner.js', 'utf8');
  assert.match(source, /KIRO_REGISTER_PAGE_STATES/);
  assert.match(source, /'register_otp_page'/);
  assert.match(source, /'create_password_page'/);
  assert.match(source, /'login_password_page'/);
  assert.match(source, /'login_otp_page'/);
  assert.doesNotMatch(source, /targetStates: \['otp_page'\]/);
  assert.doesNotMatch(source, /targetStates: \['password_page'\]/);
  assert.doesNotMatch(source, /fromStates: \['password_page'\]/);
});

test('kiro register runner fails existing-account login branches during registration', () => {
  const source = fs.readFileSync('flows/kiro/background/register-runner.js', 'utf8');
  assert.match(source, /KIRO_REGISTER_EXISTING_ACCOUNT_STATES/);
  assert.match(source, /assertKiroRegistrationOnlyState\(landingResult, currentState, 2, resolvedEmail\)/);
  assert.match(source, /邮箱.*已进入 AWS Builder ID 登录页/);
  assert.match(source, /Kiro 注册流程只处理新账号注册/);
});

test('kiro submit-email stops immediately when AWS routes the email to login', async () => {
  const api = loadRegisterRunnerApi();
  const currentState = {
    runtimeState: {
      flowState: {
        kiro: {
          session: {
            registerTabId: 101,
          },
          register: {
            loginUrl: 'https://app.kiro.dev/signin',
          },
        },
      },
    },
  };
  const sentMessages = [];
  const statePatches = [];
  let completed = false;
  const runner = api.createKiroRegisterRunner({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    completeNodeFromBackground: async () => {
      completed = true;
    },
    getState: async () => currentState,
    getTabId: async () => 101,
    isTabAlive: async () => true,
    resolveSignupEmailForFlow: async () => 'existing-user@duck.com',
    sendToContentScriptResilient: async (_sourceId, message) => {
      sentMessages.push(message);
      if (message.type === 'ENSURE_KIRO_PAGE_STATE') {
        return { state: 'email_entry', url: 'https://us-east-1.signin.aws/platform/d/signup' };
      }
      if (message.type === 'EXECUTE_NODE') {
        return { submitted: true, state: 'email_submitted' };
      }
      if (message.type === 'ENSURE_KIRO_STATE_CHANGE') {
        return {
          state: 'login_password_page',
          url: 'https://us-east-1.signin.aws/platform/d/login',
          email: 'existing-user@duck.com',
        };
      }
      return {};
    },
    setState: async (patch) => {
      statePatches.push(patch);
    },
  });

  await assert.rejects(
    () => runner.executeKiroSubmitEmail({ nodeId: 'kiro-submit-email', ...currentState }),
    /existing-user@duck\.com.*已进入 AWS Builder ID 登录页/
  );

  assert.equal(completed, false);
  assert.equal(sentMessages.some((message) => message.type === 'EXECUTE_NODE'), true);
  assert.equal(statePatches.some((patch) => /已进入 AWS Builder ID 登录页/.test(getKiroRuntime(patch).session?.lastError || '')), true);
});

test('kiro submit-email can adopt an already-open registration OTP page without allocating a new mailbox', async () => {
  const api = loadRegisterRunnerApi();
  const currentState = {
    runtimeState: {
      flowState: {
        kiro: {
          session: {
            registerTabId: 102,
          },
          register: {
            loginUrl: 'https://app.kiro.dev/signin',
          },
        },
      },
    },
  };
  const sentMessages = [];
  let completedPayload = null;
  const runner = api.createKiroRegisterRunner({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    getState: async () => currentState,
    getTabId: async () => 102,
    isTabAlive: async () => true,
    sendToContentScriptResilient: async (_sourceId, message) => {
      sentMessages.push(message);
      assert.equal(message.type, 'ENSURE_KIRO_PAGE_STATE');
      return {
        state: 'register_otp_page',
        url: 'https://us-east-1.signin.aws/platform/d/signup',
        email: 'manual-user@duck.com',
      };
    },
    setState: async () => {},
  });

  await runner.executeKiroSubmitEmail({ nodeId: 'kiro-submit-email', ...currentState });

  assert.equal(getKiroRuntime(completedPayload).register?.email, 'manual-user@duck.com');
  assert.equal(getKiroRuntime(completedPayload).register?.status, 'waiting_otp');
  assert.equal(getKiroRuntime(completedPayload).register?.verificationRequestedAt, 0);
  assert.equal(sentMessages.some((message) => message.type === 'EXECUTE_NODE'), false);
});
