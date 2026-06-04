const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/update-service.js', 'utf8');
const CACHE_KEY = 'flowpilot-release-snapshot-v1';
const LEGACY_CACHE_KEY = 'multipage-release-snapshot-v1';

function createUpdateService(options = {}) {
  const manifest = options.manifest || {
    version: '1.0',
    version_name: 'FlowPilot1.0',
  };
  const cache = new Map();
  const windowObject = {};
  let fetchCalls = 0;

  const localStorage = {
    getItem(key) {
      return cache.has(key) ? cache.get(key) : null;
    },
    setItem(key, value) {
      cache.set(key, String(value));
    },
    removeItem(key) {
      cache.delete(key);
    },
  };

  if (options.cachedSnapshot) {
    cache.set(
      CACHE_KEY,
      JSON.stringify(options.cachedSnapshot)
    );
  }
  if (options.legacyCachedSnapshot) {
    cache.set(
      LEGACY_CACHE_KEY,
      JSON.stringify(options.legacyCachedSnapshot)
    );
  }

  const fetchImpl = options.fetchImpl || (async () => ({
    ok: true,
    async json() {
      return [];
    },
  }));

  const wrappedFetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };

  const api = new Function(
    'window',
    'localStorage',
    'fetch',
    'chrome',
    'AbortController',
    'setTimeout',
    'clearTimeout',
    `${source}; return window.SidepanelUpdateService;`
  )(
    windowObject,
    localStorage,
    wrappedFetch,
    {
      runtime: {
        getManifest() {
          return manifest;
        },
      },
    },
    AbortController,
    setTimeout,
    clearTimeout
  );

  return {
    api,
    getFetchCalls() {
      return fetchCalls;
    },
  };
}


// 更新检查已停用（update-service.js: UPDATE_CHECK_DISABLED = true）。
// fetchReleases 直接短路返回空列表、不发任何网络请求，getReleaseSnapshot 永远是 'empty'。
// 以下测试锁定这个新现实：即使远端有更新，也不提示、不联网。
test('getReleaseSnapshot returns empty without any network request when update check is disabled', async () => {
  const { api, getFetchCalls } = createUpdateService({
    manifest: { version: '1.0.0', version_name: 'AutoPilot1.0.0' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [
          {
            tag_name: 'AutoPilot9.9',
            name: 'AutoPilot9.9',
            html_url: 'https://example.com/AutoPilot9.9',
            published_at: '2026-04-20T00:00:00.000Z',
            body: '- newer release',
            draft: false,
            prerelease: false,
          },
        ];
      },
    }),
  });

  const snapshot = await api.getReleaseSnapshot({ force: true });
  assert.equal(snapshot.status, 'empty');
  assert.equal(getFetchCalls(), 0, 'disabled update check must not hit the network');
  assert.deepEqual(snapshot.newerReleases || [], []);
});

test('getReleaseSnapshot never hits the network on repeated forced calls when update check is disabled', async () => {
  const { api, getFetchCalls } = createUpdateService({
    manifest: { version: '1.0.0', version_name: 'AutoPilot1.0.0' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [
          {
            tag_name: 'AutoPilot2.0',
            name: 'AutoPilot2.0',
            html_url: 'https://example.com/AutoPilot2.0',
            published_at: '2026-04-21T00:00:00.000Z',
            body: '- newer release',
            draft: false,
            prerelease: false,
          },
        ];
      },
    }),
  });

  await api.getReleaseSnapshot({ force: true });
  await api.getReleaseSnapshot({ force: true });
  assert.equal(getFetchCalls(), 0, 'disabled update check must not hit the network on any call');
});
