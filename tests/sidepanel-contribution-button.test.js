const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('sidepanel html no longer renders the header contribution button, ad bar, or update-hint layer (AutoPilot rebrand)', () => {
  // AutoPilot 1.0.0 重命名时移除了头部「贡献/使用教程」按钮、自营广告栏、以及公告更新提示层。
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  assert.equal((html.match(/id="btn-contribution-mode"/g) || []).length, 0, '头部贡献按钮应已移除');
  assert.equal(html.indexOf('id="auto-run-ad-bar"'), -1, '自营广告栏应已移除');
  assert.equal(html.indexOf('id="contribution-update-layer"'), -1, '公告更新提示层应已移除');
  assert.equal(html.indexOf('id="contribution-update-hint"'), -1, '公告更新提示应已移除');
});

test('sidepanel source no longer keeps the legacy upload-page handler on the header contribution button', () => {
  const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

  assert.doesNotMatch(source, /openContributionUploadPage/);
  assert.doesNotMatch(source, /await openContributionUploadPage\(\)/);
});
