'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../chrome-connector/account-connector.js'), 'utf8');
test('连接器只可选访问创作者站点，禁止无痕环境共用连接身份', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../chrome-connector/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, ['https://creator.douyin.com/*']);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.background, undefined);
});
const observe = id => ({ pageOrigin: 'https://creator.douyin.com', pagePath: '/creator-micro/home', platformAccountId: id, displayName: '', source: 'visible_account_label' });
const wait = async predicate => { for (let i = 0; i < 20; i++) { if (predicate()) return; await new Promise(setImmediate); } assert.fail('未等到预期异步状态'); };
async function harness({ saved = {}, observed = observe('teacher_a'), operation = null, granted = true, receiptState = 'verified' } = {}) {
  const ids = ['connection-status', 'environment-id', 'actual-account', 'authorize', 'pair-form', 'account-port', 'account-code', 'pair-account', 'disconnect-account'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '', dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } }]));
  elements['account-port'].value = '48717';
  const storage = structuredClone(saved), calls = { fetch: [], tabs: [], removed: [], execute: [], requested: [] }, listeners = new Set();
  const chrome = {
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, storage[k]])), set: async values => Object.assign(storage, structuredClone(values)), remove: async key => { delete storage[key]; } } },
    permissions: { contains: async () => granted, request: async input => { calls.requested.push(input); return granted; } },
    tabs: { create: async input => { calls.tabs.push(input); return { id: calls.tabs.length }; }, get: async () => ({ status: 'complete' }), remove: async id => { calls.removed.push(id); }, onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    scripting: { executeScript: async input => { calls.execute.push(input); return [{ result: observed }]; } }
  };
  Object.defineProperty(chrome.storage, 'sync', { get() { throw new Error('凭据不得同步到其他Chrome资料'); } });
  const sandbox = { chrome, document: { getElementById: id => elements[id] }, crypto: { randomUUID }, AbortController,
    setTimeout: (fn, ms) => ms === 3000 ? 0 : setTimeout(fn, ms), clearTimeout,
    fetch: async (url, options) => {
      calls.fetch.push({ url, options, body: JSON.parse(options.body) });
      const route = url.split('/').pop();
      const value = route === 'connect' ? { ok: true, token: 'b'.repeat(64), accountId: 'account-a', needsConfirmation: true }
        : route === 'poll' ? { ok: true, state: operation ? 'connected' : 'pending_confirmation', operation }
          : { ok: true, state: receiptState };
      return { ok: true, json: async () => value };
    }
  };
  vm.runInNewContext(source, sandbox); await wait(() => elements['environment-id'].textContent !== '');
  return { storage, calls, elements, click: id => elements[id].listeners.click(), pair: () => elements['pair-form'].listeners.submit({ preventDefault() {} }) };
}

test('每份Chrome资料生成自己的连接标识，重开沿用原标识，不读同步存储', async () => {
  const first = await harness(), second = await harness();
  assert.notEqual(first.storage.connectorInstanceId, second.storage.connectorInstanceId);
  const restored = await harness({ saved: { connectorInstanceId: first.storage.connectorInstanceId } });
  assert.equal(restored.storage.connectorInstanceId, first.storage.connectorInstanceId);
});

test('配对从程序打开精确首页并识别账号；码及时清空，候选仍等工作台确认', async () => {
  const h = await harness(); h.elements['account-code'].value = 'a'.repeat(32); await h.pair();
  assert.equal(h.elements['account-code'].value, '');
  assert.equal(h.calls.tabs[0].url, 'https://creator.douyin.com/creator-micro/home');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.execute[0].files)), ['account-identity.js']);
  assert.equal(h.calls.fetch[0].body.observation.platformAccountId, 'teacher_a');
  assert.equal(h.calls.fetch[0].options.credentials, 'omit');
  assert.equal(h.storage.accountConnection.token, 'b'.repeat(64));
  assert.match(h.elements['connection-status'].textContent, /等待.*确认/);
  assert.equal(h.elements['connection-status'].textContent.includes('b'.repeat(64)), false);
});

test('未授权、无唯一身份或非法端口时不连接工作台', async () => {
  for (const settings of [{ granted: false }, { observed: null }]) {
    const h = await harness(settings); h.elements['account-code'].value = 'a'.repeat(32); await h.pair();
    assert.equal(h.calls.fetch.length, 0); assert.equal(h.storage.accountConnection, undefined);
  }
  const h = await harness(); h.elements['account-code'].value = 'a'.repeat(32); h.elements['account-port'].value = '80'; await h.pair();
  assert.equal(h.calls.tabs.length, 0); assert.equal(h.calls.fetch.length, 0);
});

test('恢复连接后检查由程序执行，回传实际号，错号回执不显示成功且不触发上传', async () => {
  const operation = { id: randomUUID(), kind: 'inspect', expectedAccountId: 'teacher_a', accountId: 'account-a' };
  const h = await harness({ saved: { connectorInstanceId: randomUUID(), accountConnection: { port: 48717, token: 'b'.repeat(64) } }, operation, observed: observe('teacher_b'), receiptState: 'mismatch' });
  await wait(() => h.calls.fetch.some(c => c.url.endsWith('/report')));
  const report = h.calls.fetch.find(c => c.url.endsWith('/report'));
  assert.equal(report.body.observation.platformAccountId, 'teacher_b');
  await wait(() => /不符/.test(h.elements['connection-status'].textContent));
  assert.equal(h.calls.removed.length, 1);
  assert.equal(h.calls.fetch.every(c => /^http:\/\/127\.0\.0\.1:48717\/v05\/(?:poll|report)$/.test(c.url)), true);
});

test('停止本窗口连接清除本机凭据，保留环境标识且不退出网站', async () => {
  const h = await harness({ saved: { connectorInstanceId: randomUUID(), accountConnection: { port: 48717, token: 'b'.repeat(64) } } });
  await h.click('disconnect-account');
  assert.equal(h.storage.accountConnection, undefined); assert.ok(h.storage.connectorInstanceId);
  assert.equal(h.calls.tabs.length, 0); assert.match(h.elements['connection-status'].textContent, /网站登录不变/);
});
