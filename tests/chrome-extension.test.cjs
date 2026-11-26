'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, 'chrome-connector/popup.js'), 'utf8');
const PROBE_SOURCE = fs.readFileSync(path.join(ROOT, 'chrome-connector/probe.js'), 'utf8');
const PAIR_CODE = 'a'.repeat(32);
const OBSERVATION = {
  pageOrigin: 'https://creator.douyin.com',
  pagePath: '/creator-micro/upload',
  loginVisible: false,
  workspaceDetected: true,
  fields: { landscape: true, portrait: false, tags: true, declaration: false, collection: true }
};

function popupHarness({ url = 'https://creator.douyin.com/creator-micro/upload', code = PAIR_CODE, port = '48627', executeResult = OBSERVATION, response = { ok: true, receipt: { ok: true } }, fetchError } = {}) {
  const elements = new Map();
  for (const id of ['port', 'code', 'connect', 'status']) {
    elements.set(id, { value: '', disabled: false, textContent: '', dataset: {}, listeners: {} });
  }
  elements.get('port').value = port;
  elements.get('code').value = code;
  elements.get('connect').addEventListener = (type, callback) => { elements.get('connect').listeners[type] = callback; };

  const calls = { query: 0, execute: [], fetch: [], storage: 0, localStorage: 0 };
  const chrome = {
    tabs: { query: async query => { calls.query++; calls.queryArgs = query; return [{ id: 41, url }]; } },
    scripting: { executeScript: async options => { calls.execute.push(options); return [{ result: executeResult }]; } }
  };
  Object.defineProperty(chrome, 'storage', { get() { calls.storage++; throw new Error('storage must not be accessed'); } });
  const sandbox = {
    chrome,
    document: { getElementById: id => elements.get(id) },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (...args) => {
      calls.fetch.push(args);
      if (fetchError) throw fetchError;
      return { ok: response.ok, json: async () => response.receipt };
    }
  };
  Object.defineProperty(sandbox, 'localStorage', { get() { calls.localStorage++; throw new Error('localStorage must not be accessed'); } });
  vm.runInNewContext(POPUP_SOURCE, sandbox, { filename: 'popup.js' });
  return { elements, calls, click: () => elements.get('connect').listeners.click() };
}

function probeElement(text, { parent = null, style = {}, nodeType = 1, valueGetter } = {}) {
  const element = {
    nodeType,
    parentElement: parent,
    getClientRects: () => [1],
    _style: style
  };
  if (valueGetter) Object.defineProperty(element, 'value', { get: valueGetter });
  Object.defineProperty(element, 'innerText', { get: () => text });
  return element;
}

function runProbe({ labels = [], spans = [], pathname = '/creator-micro/upload?secret=1#part' } = {}) {
  const queried = [];
  const document = {
    querySelectorAll(selector) {
      queried.push(selector);
      if (/input|img|canvas|video/i.test(selector)) throw new Error(`probe inspected forbidden selector: ${selector}`);
      if (selector === 'button,label,[role="button"],h1,h2,h3,h4,a') return labels;
      if (selector === 'span') return spans;
      return [];
    }
  };
  const sandbox = {
    document,
    location: { origin: 'https://creator.douyin.com', pathname },
    getComputedStyle: element => ({ visibility: 'visible', display: 'block', opacity: '1', ...element._style })
  };
  const result = vm.runInNewContext(PROBE_SOURCE, sandbox, { filename: 'probe.js' });
  return { result, queried };
}

test('弹窗初始化时不查询标签、不注入脚本、不联网', async () => {
  const harness = popupHarness();
  assert.equal(harness.calls.query, 0);
  assert.equal(harness.calls.execute.length, 0);
  assert.equal(harness.calls.fetch.length, 0);
});

test('后缀仿冒域名被拒绝，且不注入脚本或联网', async () => {
  const harness = popupHarness({ url: 'https://creator.douyin.com.attacker.example/page' });
  await harness.click();
  assert.equal(harness.calls.query, 1);
  assert.equal(harness.calls.execute.length, 0);
  assert.equal(harness.calls.fetch.length, 0);
  assert.equal(harness.elements.get('status').dataset.state, 'error');
});

test('无效配对码或端口不会查询标签、注入脚本或联网', async t => {
  for (const input of [{ code: 'A'.repeat(32) }, { port: '1023' }]) {
    await t.test(JSON.stringify(input), async () => {
      const harness = popupHarness(input);
      await harness.click();
      assert.equal(harness.calls.query, 0);
      assert.equal(harness.calls.execute.length, 0);
      assert.equal(harness.calls.fetch.length, 0);
      assert.equal(harness.elements.get('status').dataset.state, 'error');
    });
  }
});

test('有效配对仅注入当前主框架并向正确 loopback 路径 POST 一次摘要', async () => {
  const harness = popupHarness();
  await harness.click();

  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.queryArgs)), { active: true, currentWindow: true });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.execute)), [{ target: { tabId: 41 }, files: ['probe.js'] }]);
  assert.equal(harness.calls.fetch.length, 1);
  const [url, options] = harness.calls.fetch[0];
  assert.equal(url, 'http://127.0.0.1:48627/pair');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.redirect, 'error');
  assert.equal(options.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(options.body), { code: PAIR_CODE, observation: OBSERVATION });
  assert.equal(harness.elements.get('code').value, '');
  assert.equal(harness.calls.storage, 0);
  assert.equal(harness.calls.localStorage, 0);
  assert.equal(harness.elements.get('status').dataset.state, 'success');
});

test('探针排除隐藏父级与透明祖先，只输出白名单布尔摘要，不输出个人标题或输入值', () => {
  let inputValueReads = 0;
  const hiddenParent = probeElement('', { style: { display: 'none' } });
  const transparentParent = probeElement('', { style: { opacity: '0' } });
  const personalHeading = probeElement('张三的草稿标题');
  const forbiddenInput = probeElement('', { valueGetter: () => { inputValueReads++; throw new Error('input value read'); } });
  const labels = [
    personalHeading,
    forbiddenInput,
    probeElement('作品管理', { parent: hiddenParent }),
    probeElement('添加话题', { parent: transparentParent }),
    probeElement('横版封面'),
    probeElement('竖版封面'),
    probeElement('内容声明'),
    probeElement('合集')
  ];
  const hiddenLogin = probeElement('扫码登录', { parent: transparentParent });
  const { result, queried } = runProbe({ labels, spans: [hiddenLogin] });

  assert.equal(result.pageOrigin, 'https://creator.douyin.com');
  assert.equal(result.pagePath, '/creator-micro/upload');
  assert.equal(result.loginVisible, false);
  assert.equal(result.workspaceDetected, false);
  assert.deepEqual({ ...result.fields }, { landscape: true, portrait: true, tags: false, declaration: true, collection: true });
  assert.deepEqual(Object.keys(result).sort(), ['fields', 'loginVisible', 'pageOrigin', 'pagePath', 'workspaceDetected'].sort());
  assert.deepEqual(Object.keys(result.fields).sort(), ['collection', 'declaration', 'landscape', 'portrait', 'tags'].sort());
  assert.equal(JSON.stringify(result).includes('张三的草稿标题'), false);
  assert.equal(inputValueReads, 0);
  assert.equal(queried.some(selector => /input|img|canvas|video/i.test(selector)), false);
});

test('探针识别可见 span 登录标签，但不会把个人标题带入摘要', () => {
  const heading = probeElement('李四的待发布作品');
  const { result } = runProbe({ labels: [heading], spans: [probeElement('二维码已失效')] });
  assert.equal(result.loginVisible, true);
  assert.equal(JSON.stringify(result).includes('李四的待发布作品'), false);
});

test('错误收据或 fetch 失败均不显示成功，并清空配对码', async t => {
  const cases = [
    ['错误收据', { response: { ok: true, receipt: { ok: false } } }],
    ['fetch 拒绝', { fetchError: new Error('sensitive low-level detail') }]
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const harness = popupHarness(options);
      await harness.click();
      assert.equal(harness.elements.get('status').dataset.state, 'error');
      assert.match(harness.elements.get('status').textContent, /本机分发台|无法连接本机/);
      assert.equal(harness.elements.get('status').textContent.includes('sensitive low-level detail'), false);
      assert.equal(harness.elements.get('status').textContent.includes(PAIR_CODE), false);
      assert.equal(harness.elements.get('code').value, '');
    });
  }
});
