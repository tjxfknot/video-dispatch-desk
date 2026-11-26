'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chrome-connector/console.js'), 'utf8');
const checks = { video: true, covers: true, text: true, declaration: true, collection: true, schedule: true };

function harness({ url = 'https://creator.douyin.com/creator-micro/content/upload', failKind, alreadyApplied = false, submitError = false, scheduleVerified = true } = {}) {
  const elements = new Map();
  function element() {
    return { value: '', textContent: '', dataset: {}, checked: false, disabled: false, hidden: true, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, append() {}, replaceChildren() {} };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('port').value = '48637'; get('code').value = 'c'.repeat(32);
  get('account').value = '合成测试账号 123456789'; get('account-confirm').checked = true;
  const job = { runId: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64), accountLabel: '合成备注',
    schedule: { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' },
    common: { title: '合成测试标题', description: '', tags: [] }, declaration: { required: false, text: '' }, collection: { required: false, name: '' },
    files: ['video', 'landscape', 'portrait'].map((kind, i) => ({ id: `${i + 2}1111111-1111-4111-8111-111111111111`, kind, name: kind + (i ? '.png' : '.mp4'), type: i ? 'image/png' : 'video/mp4', size: 3 })) };
  const calls = { fetch: [], messages: [], inject: [], tabs: 0, storage: 0 };
  const timers = new Map(); let timerId = 0, approved = false, currentUrl = url;
  const sandbox = {
    document: { getElementById: get, createElement: element, visibilityState: 'visible' },
    location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/console.html?tabId=41' },
    URL, AbortController, Uint8Array, crypto: webcrypto,
    btoa: str => Buffer.from(str, 'binary').toString('base64'),
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    chrome: {
      tabs: { get: async id => { assert.equal(id, 41); calls.tabs++; return { url: currentUrl }; },
        sendMessage: async (id, message) => {
          assert.equal(id, 41); calls.messages.push(structuredClone(message));
          if (message.type === 'VD_FILE_START' && alreadyApplied) return { ok: true, alreadyApplied: true };
          if (message.type === 'VD_FILE_END' && job.files.find(f => f.id === message.fileId).kind === failKind) return { ok: false, message: '合成封面控件未核实' };
          if (message.type === 'VD_SUBMIT' && submitError) throw new Error('合成回执中断');
          return { ok: true, checks: { ...checks, schedule: scheduleVerified } };
        } },
      scripting: { executeScript: async options => calls.inject.push(options) }
    },
    fetch: async (url, options) => {
      calls.fetch.push({ url, options });
      const route = new URL(url).pathname.replace('/job/', '');
      let value = { ok: true };
      if (route === 'connect') value = { ok: true, token: 'd'.repeat(32), job };
      if (route === 'status') value = { ok: true, approved, status: approved ? 'approved' : 'awaiting_confirmation' };
      if (route === 'begin-submit') value = { ok: true, submitOnce: true };
      let read = false;
      return { ok: true, json: async () => value, body: { getReader: () => ({
        read: async () => read ? { done: true } : (read = true, { done: false, value: Uint8Array.of(1, 2, 3) }), cancel: async () => {}
      }) } };
    }
  };
  for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(sandbox, key, { get() { calls.storage++; throw new Error('Storage forbidden'); } });
  Object.defineProperty(sandbox.chrome, 'storage', { get() { calls.storage++; throw new Error('Storage forbidden'); } });
  vm.runInNewContext(source, sandbox);
  return { calls, get, job, click: id => get(id).listeners.click(), setApproved: value => { approved = value; },
    setUrl: value => { currentUrl = value; },
    async poll() { const entry = [...timers.entries()].find(([, t]) => t.ms === 2000); assert.ok(entry, '等待一次可见助手轮询'); timers.delete(entry[0]); await entry[1].fn(); },
    events: () => calls.fetch.filter(c => c.url.endsWith('/event')).map(c => JSON.parse(c.options.body).type),
    routes: () => calls.fetch.map(c => new URL(c.url).pathname) };
}

test('发布助手加载时不联网、不读标签、不注入、不读存储', () => {
  const h = harness(); assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.tabs, 0);
  assert.equal(h.calls.inject.length, 0); assert.equal(h.calls.messages.length, 0); assert.equal(h.calls.storage, 0);
});

test('接收快照不会上传：只连接本机并初始化已核实标签', async () => {
  const h = harness(); await h.click('connect');
  assert.deepEqual(h.routes(), ['/job/connect']);
  assert.deepEqual(h.calls.messages.map(m => m.type), ['VD_INIT']);
  assert.equal(h.get('code').value, ''); assert.equal(h.calls.storage, 0);
  assert.equal(h.calls.fetch[0].options.credentials, 'omit');
  assert.equal(h.calls.fetch[0].options.redirect, 'error');
});

test('仿冒域与无效任务码在传输前被拒绝', async () => {
  for (const url of ['https://creator.douyin.com.evil.test/creator-micro/upload', 'https://creator.douyin.com/login']) {
    const h = harness({ url }); await h.click('connect');
    assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.inject.length, 0);
  }
  const h = harness(); h.get('code').value = 'A'.repeat(32); await h.click('connect');
  assert.equal(h.calls.tabs, 0); assert.equal(h.calls.fetch.length, 0);
});

test('没有核对实际账号不会开始传输', async () => {
  const h = harness(); await h.click('connect'); h.get('account-confirm').checked = false;
  await h.click('prepare'); assert.deepEqual(h.events(), []);
  assert.equal(h.calls.messages.some(m => m.type === 'VD_FILE_START'), false);
});

test('字段齐全仍等待桌面批准；批准后只有一次提交，回执未登记前不称成功', async () => {
  const h = harness(); await h.click('connect'); await h.click('prepare');
  assert.deepEqual(h.events(), ['identified', 'preparing', 'prepared']);
  assert.equal(h.routes().includes('/job/begin-submit'), false);
  assert.equal(h.calls.messages.some(m => m.type === 'VD_SUBMIT'), false);
  assert.equal(h.calls.messages.filter(m => m.type === 'VD_FILE_END').length, 3);
  h.setApproved(true); await h.poll(); await h.click('prepare');
  assert.equal(h.routes().filter(r => r === '/job/begin-submit').length, 1);
  assert.equal(h.calls.messages.filter(m => m.type === 'VD_SUBMIT').length, 1);
  assert.equal(h.get('result-panel').hidden, false);
  assert.equal(h.events().includes('submitted'), false);
  assert.match(h.get('status').textContent, /等待核对/);
  for (const c of h.calls.fetch.filter(c => !c.url.endsWith('/connect'))) assert.equal(c.options.headers.Authorization, 'Bearer ' + 'd'.repeat(32));
});

test('封面无确认即停止；再次继续不重传已交付的视频', async () => {
  const h = harness({ failKind: 'landscape' }); await h.click('connect'); await h.click('prepare');
  assert.equal(h.events().includes('needs_manual'), true);
  assert.equal(h.events().includes('prepared'), false);
  assert.equal(h.routes().includes('/job/begin-submit'), false);
  await h.click('prepare');
  assert.equal(h.calls.messages.filter(m => m.type === 'VD_FILE_START' && m.fileId === h.job.files[0].id).length, 1);
  assert.equal(h.events().filter(e => e === 'identified').length, 1);
});

test('页面已有文件的幂等回执跳过本机二次读取和分块发送', async () => {
  const h = harness({ alreadyApplied: true }); await h.click('connect'); await h.click('prepare');
  assert.equal(h.routes().some(r => r.includes('/asset/')), false);
  assert.equal(h.calls.messages.some(m => m.type === 'VD_FILE_CHUNK'), false);
  assert.equal(h.events().includes('prepared'), true);
});

test('提交回执中断不会再次提交；只能登记待核查', async () => {
  const h = harness({ submitError: true }); await h.click('connect'); await h.click('prepare');
  h.setApproved(true); await h.poll(); await h.click('prepare');
  assert.equal(h.calls.messages.filter(m => m.type === 'VD_SUBMIT').length, 1);
  assert.match(h.get('status').textContent, /尚未确认/);
  await h.click('record-unknown'); assert.equal(h.events().at(-1), 'awaiting_verification');
  assert.equal(h.events().includes('submitted'), false);
});

test('发布时间未核实即使其他五项通过也不能提交', async () => {
  const h = harness({ scheduleVerified: false }); await h.click('connect'); h.setApproved(true);
  await h.click('prepare');
  assert.equal(h.events().includes('prepared'), false);
  assert.equal(h.events().at(-1), 'needs_manual');
  assert.equal(h.routes().includes('/job/begin-submit'), false);
  assert.equal(h.calls.messages.some(m => m.type === 'VD_SUBMIT'), false);
});

test('停止后清理本次助手，禁止后续传输与轮询', async () => {
  const h = harness(); await h.click('connect'); await h.click('prepare'); await h.click('stop');
  assert.equal(h.events().at(-1), 'canceled');
  const count = h.calls.fetch.length; await h.click('prepare'); assert.equal(h.calls.fetch.length, count);
  assert.equal(h.calls.messages.at(-1).type, 'VD_CANCEL');
});
