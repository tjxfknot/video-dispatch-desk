'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'chrome-connector/publisher-content.js'), 'utf8');
const EXTENSION_ID = 'a'.repeat(32);
const NONCE = 'b'.repeat(32);
const bytesToBase64 = bytes => Buffer.from(bytes).toString('base64');
const asPlain = value => JSON.parse(JSON.stringify(value));

function makeJob(overrides = {}) {
  return {
    runId: 'run-test-1',
    fingerprint: 'fingerprint-test-1',
    common: { title: '一条测试标题', description: '简介正文 #只是文字', tags: [] },
    declaration: { required: false, text: '' },
    collection: { required: false, name: '' },
    schedule: { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' },
    files: [{ id: 'video-1', kind: 'video', name: 'sample.mp4', size: 3, type: 'video/mp4' }],
    ...overrides
  };
}

function makeEnvironment({ origin = 'https://creator.douyin.com', pathname = '/creator-micro/content/upload', job = makeJob(), videoInputs, titleInputs, descriptionEditors, buttons } = {}) {
  const calls = { listeners: [], queriedSelectors: [], fileConstructs: 0, transferConstructs: 0 };
  const style = { display: 'block', visibility: 'visible', opacity: '1' };
  const makeElement = properties => ({
    nodeType: 1,
    parentElement: null,
    disabled: false,
    getClientRects: () => [1],
    dispatchEvent(event) { this.events ||= []; this.events.push(event.type); return true; },
    getAttribute(name) { return this.attributes?.[name] ?? null; },
    ...properties
  });

  class FakeHTMLInputElement {
    constructor(attributes = {}) {
      this.nodeType = 1;
      this.parentElement = null;
      this.attributes = attributes;
      this.disabled = false;
      this.events = [];
      this.getClientRects = () => [1];
      this.getAttribute = name => this.attributes[name] ?? null;
      this.dispatchEvent = event => { this.events.push(event.type); return true; };
    }
  }
  Object.defineProperty(FakeHTMLInputElement.prototype, 'value', {
    get() { return this._value || ''; },
    set(value) { this._value = String(value); },
    configurable: true
  });

  const files = (videoInputs || [{ accept: 'video/*', disabled: false }]).map(attributes => {
    const input = makeElement({
      disabled: attributes.disabled === true,
      files: [],
      attributes: { accept: attributes.accept || '' },
      getAttribute(name) { return this.attributes[name] ?? null; },
      dispatchEvent(event) { this.events ||= []; this.events.push(event.type); return true; }
    });
    return input;
  });
  const titles = (titleInputs === undefined ? [{ placeholder: '请填写作品标题' }] : titleInputs).map(attributes => new FakeHTMLInputElement({ placeholder: attributes.placeholder || '' }));
  const editors = (descriptionEditors === undefined ? [{ 'aria-label': '作品简介' }] : descriptionEditors).map(attributes => {
    let text = '';
    return makeElement({
      attributes,
      innerText: text,
      textContent: text,
      focus() { this.focused = true; },
      setText(value) { this.innerText = value; this.textContent = value; }
    });
  });
  const publishButtons = (buttons || []).map(button => makeElement({ innerText: button.text, disabled: button.disabled === true, click() { this.clicks = (this.clicks || 0) + 1; } }));
  const querySelectorAll = selector => {
    calls.queriedSelectors.push(selector);
    if (selector === 'input[type="file"]') return files;
    if (selector === 'input') return [...titles, ...files];
    if (selector === '[contenteditable="true"]') return editors;
    if (selector === 'button') return publishButtons;
    return [];
  };
  const document = {
    querySelectorAll,
    createRange() {
      return { selectNodeContents(editor) { this.editor = editor; } };
    },
    execCommand(command, _ui, text) {
      if (command !== 'insertText' || !selection.range?.editor) return false;
      selection.range.editor.setText(text);
      return true;
    }
  };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('cookie access forbidden'); } });
  const selection = {
    range: null,
    removeAllRanges() { this.range = null; },
    addRange(range) { this.range = range; }
  };

  class FakeFile {
    constructor(parts, name, options = {}) {
      calls.fileConstructs++;
      this.parts = parts;
      this.name = name;
      this.type = options.type || '';
      this.size = parts.reduce((size, part) => size + part.length, 0);
    }
  }
  class FakeDataTransfer {
    constructor() {
      calls.transferConstructs++;
      this._files = [];
      this.items = { add: file => this._files.push(file) };
    }
    get files() { return this._files; }
  }
  class FakeEvent { constructor(type) { this.type = type; } }
  class FakeInputEvent extends FakeEvent { constructor(type, init = {}) { super(type); Object.assign(this, init); } }
  const runtime = { id: EXTENSION_ID, onMessage: { addListener: listener => calls.listeners.push(listener) } };
  const chrome = { runtime };
  Object.defineProperty(chrome, 'storage', { get() { throw new Error('chrome.storage forbidden'); } });
  const sandbox = {
    chrome,
    document,
    location: { origin, pathname },
    getComputedStyle: element => ({ ...style, ...element._style }),
    HTMLInputElement: FakeHTMLInputElement,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    window: { getSelection: () => selection }
  };
  Object.defineProperty(sandbox, 'fetch', { get() { throw new Error('network forbidden'); } });
  Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('storage forbidden'); } });
  Object.defineProperty(sandbox, 'sessionStorage', { get() { throw new Error('storage forbidden'); } });
  const context = vm.createContext(sandbox);
  vm.runInContext(SOURCE, context, { filename: 'publisher-content.js' });

  function send(type, fields = {}, senderId = EXTENSION_ID, messageNonce = NONCE) {
    let response;
    const listener = calls.listeners[0];
    listener({ type, nonce: messageNonce, ...fields }, { id: senderId }, value => { response = value; });
    return response;
  }
  function init(inputJob = job, inputNonce = NONCE, senderId = EXTENSION_ID) {
    return send('VD_INIT', { nonce: inputNonce, job: inputJob }, senderId, inputNonce);
  }
  return { calls, files, titles, editors, publishButtons, send, init, context, selection };
}

function sendVideo(environment, { size = 3, data = bytesToBase64([1, 2, 3]), fileId = 'video-1' } = {}) {
  const started = environment.send('VD_FILE_START', { fileId });
  assert.equal(started.ok, true);
  const chunked = environment.send('VD_FILE_CHUNK', { fileId, index: 0, data });
  assert.equal(chunked.ok, true);
  assert.equal(chunked.nextIndex, 1);
  return environment.send('VD_FILE_END', { fileId });
}

test('仅在精确 origin 和 creator-micro 路径安装一次监听，并验证扩展 sender 与任务 nonce', () => {
  const wrongOrigin = makeEnvironment({ origin: 'https://creator.douyin.com.evil.test' });
  assert.equal(wrongOrigin.calls.listeners.length, 0);
  const wrongPath = makeEnvironment({ pathname: '/creator-micro' });
  assert.equal(wrongPath.calls.listeners.length, 0);

  const environment = makeEnvironment();
  assert.equal(environment.calls.listeners.length, 1);
  vm.runInContext(SOURCE, environment.context, { filename: 'publisher-content-second.js' });
  assert.equal(environment.calls.listeners.length, 1);
  assert.equal(environment.init(makeJob(), NONCE, 'other-extension-id'), undefined);
  assert.equal(environment.init(makeJob(), 'not-a-32-hex-code').ok, false);
  assert.equal(environment.init().ok, true);
  assert.equal(environment.send('VD_STATUS', {}, EXTENSION_ID, 'c'.repeat(32)).ok, false);
  assert.equal(environment.send('VD_STATUS').ok, true);
  assert.equal(environment.send('VD_STATUS', { unexpected: true }).ok, false);
});

test('同源 creator-micro SPA 路径变化保留状态；离开该路径后停止且不恢复旧任务', () => {
  const environment = makeEnvironment();
  environment.init();
  environment.context.location.pathname = '/creator-micro/after-upload';
  assert.equal(environment.send('VD_STATUS').ok, true);
  environment.context.location.pathname = '/user/profile';
  const stopped = environment.send('VD_STATUS');
  assert.equal(stopped.ok, false);
  assert.match(stopped.message, /页面已离开/);
  environment.context.location.pathname = '/creator-micro/content/upload';
  assert.equal(environment.send('VD_STATUS'), undefined);
});

test('分块必须顺序到达；乱序、总量超限和单片超限都会清除未完成内容', () => {
  const environment = makeEnvironment({ job: makeJob({ common: { title: 't', description: '', tags: [] } }) });
  assert.equal(environment.init().ok, true);
  assert.equal(environment.send('VD_FILE_START', { fileId: 'video-1' }).ok, true);
  const outOfOrder = environment.send('VD_FILE_CHUNK', { fileId: 'video-1', index: 1, data: bytesToBase64([1]) });
  assert.equal(outOfOrder.ok, false);
  assert.equal(environment.send('VD_FILE_CHUNK', { fileId: 'video-1', index: 0, data: bytesToBase64([1, 2, 3]) }).ok, false);

  assert.equal(environment.send('VD_FILE_START', { fileId: 'video-1' }).ok, true);
  assert.equal(environment.send('VD_FILE_CHUNK', { fileId: 'video-1', index: 0, data: bytesToBase64([1, 2, 3, 4]) }).ok, false);
  assert.equal(environment.send('VD_FILE_END', { fileId: 'video-1' }).ok, false);

  const tooLargeChunk = Buffer.alloc(512 * 1024 + 1, 7).toString('base64');
  assert.equal(environment.send('VD_FILE_START', { fileId: 'video-1' }).ok, true);
  assert.equal(environment.send('VD_FILE_CHUNK', { fileId: 'video-1', index: 0, data: tooLargeChunk }).ok, false);
  const tooLargeJob = makeJob({ files: [{ id: 'video-1', kind: 'video', name: 'oversize.mp4', size: 512 * 1024 * 1024 + 1, type: 'video/mp4' }] });
  assert.equal(makeEnvironment({ job: tooLargeJob }).init().ok, false);
});

test('视频仅交给唯一匹配的视频输入；重复 FILE_END 不再次派发 input/change', () => {
  const environment = makeEnvironment();
  assert.equal(environment.init().ok, true);
  const first = sendVideo(environment);
  assert.equal(first.ok, true);
  assert.equal(first.checks.video, true);
  assert.match(first.message, /平台接收状态仍待确认/);
  assert.deepEqual(environment.files[0].events, ['input', 'change']);
  assert.equal(environment.calls.fileConstructs, 1);
  assert.equal(environment.calls.transferConstructs, 1);
  const duplicate = environment.send('VD_FILE_END', { fileId: 'video-1' });
  assert.equal(duplicate.alreadyApplied, true);
  assert.equal(duplicate.checks.video, true);
  const duplicateStart = environment.send('VD_FILE_START', { fileId: 'video-1' });
  assert.equal(duplicateStart.alreadyApplied, true);
  assert.deepEqual(environment.files[0].events, ['input', 'change']);
  assert.deepEqual(asPlain(environment.send('VD_STATUS').appliedFileIds), ['video-1']);

  const ambiguous = makeEnvironment({ videoInputs: [{ accept: 'video/*' }, { accept: 'video/mp4' }] });
  ambiguous.init();
  const manual = sendVideo(ambiguous);
  assert.equal(manual.ok, false);
  assert.equal(manual.phase, 'needs_manual');
  assert.equal(ambiguous.files.every(input => !input.events), true);
});

test('封面文件收齐后不猜控件、不选择文件，只返回 needs_manual 且重复结束不再处理', () => {
  const job = makeJob({ files: [
    { id: 'video-1', kind: 'video', name: 'sample.mp4', size: 3, type: 'video/mp4' },
    { id: 'cover-1', kind: 'landscape', name: 'cover.png', size: 2, type: 'image/png' }
  ] });
  const environment = makeEnvironment({ job });
  environment.init();
  assert.equal(environment.send('VD_FILE_START', { fileId: 'cover-1' }).ok, true);
  assert.equal(environment.send('VD_FILE_CHUNK', { fileId: 'cover-1', index: 0, data: bytesToBase64([1, 2]) }).ok, true);
  const first = environment.send('VD_FILE_END', { fileId: 'cover-1' });
  assert.equal(first.phase, 'needs_manual');
  assert.equal(first.checks.covers, false);
  assert.equal(environment.calls.fileConstructs, 0);
  assert.equal(environment.calls.transferConstructs, 0);
  const duplicate = environment.send('VD_FILE_END', { fileId: 'cover-1' });
  assert.deepEqual(asPlain(duplicate), asPlain(first));
});

test('文案只处理唯一已标记的标题和简介；标签、封面、必需声明/合集未核实就阻止检查通过', () => {
  const job = makeJob({
    common: { title: '受控标题', description: '简介文字 #不是标签', tags: ['真实话题'] },
    declaration: { required: true, text: '自主声明' },
    collection: { required: true, name: '已有合集' }
  });
  const environment = makeEnvironment({ job });
  environment.init();
  const result = environment.send('VD_APPLY_TEXT');
  assert.equal(environment.titles[0].value, '受控标题');
  assert.deepEqual(environment.titles[0].events, ['input', 'change']);
  assert.equal(environment.editors[0].innerText, '简介文字 #不是标签');
  assert.deepEqual(environment.editors[0].events, ['input']);
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'needs_manual');
  assert.deepEqual(asPlain(result.checks), { video: false, covers: false, text: false, declaration: false, collection: false, schedule: false });
  assert.match(result.message, /话题标签控件尚未核实/);

  const noTags = makeEnvironment({ job: makeJob({ common: { title: '受控标题', description: '简介里有 # 但任务没有话题标签', tags: [] } }) });
  noTags.init();
  const successfulText = noTags.send('VD_APPLY_TEXT');
  assert.equal(successfulText.checks.text, true);
  assert.equal(successfulText.checks.declaration, true);
  assert.equal(successfulText.checks.collection, true);
  assert.equal(successfulText.checks.covers, false);
  const status = noTags.send('VD_STATUS');
  assert.deepEqual(Object.keys(status).sort(), ['appliedFileIds', 'checks', 'message', 'ok', 'phase'].sort());
  assert.equal(JSON.stringify(status).includes('受控标题'), false);
  assert.equal(JSON.stringify(status).includes('简介里有'), false);
});

test('标题或简介控件缺失/不唯一时返回 needs_manual', () => {
  const noTitle = makeEnvironment({ titleInputs: [] });
  noTitle.init();
  assert.equal(noTitle.send('VD_APPLY_TEXT').phase, 'needs_manual');

  const duplicateTitle = makeEnvironment({ titleInputs: [{ placeholder: '填写作品标题' }, { placeholder: '请填写作品标题' }] });
  duplicateTitle.init();
  assert.match(duplicateTitle.send('VD_APPLY_TEXT').message, /标题控件未能唯一定位/);

  const noDescription = makeEnvironment({ job: makeJob({ common: { title: '标题', description: '需要简介', tags: [] } }), descriptionEditors: [] });
  noDescription.init();
  assert.match(noDescription.send('VD_APPLY_TEXT').message, /简介控件未能唯一定位/);
});

test('任务必须明确带发布时间，定时控件未核实就拒绝提交', () => {
  const missing = makeJob(); delete missing.schedule;
  const legacy = makeEnvironment({ job: missing });
  assert.equal(legacy.init().ok, false);
  const environment = makeEnvironment({ job: makeJob({ schedule: { mode: 'scheduled', at: '2099-12-31T12:00', timeZone: 'Asia/Shanghai' } }), buttons: [{ text: '发布' }] });
  environment.init();
  assert.equal(environment.send('VD_STATUS').checks.schedule, false);
  assert.equal(environment.send('VD_SUBMIT', { permit: true }).ok, false);
  assert.equal(environment.publishButtons[0].clicks || 0, 0);
});

test('无提交许可、检查未齐或发布按钮不唯一时绝不点击；取消后停止后续操作', () => {
  const environment = makeEnvironment({ buttons: [{ text: '发布' }] });
  environment.init();
  assert.equal(environment.send('VD_SUBMIT', { permit: false }).ok, false);
  assert.equal(environment.send('VD_SUBMIT', { permit: true }).ok, false);
  assert.equal(environment.publishButtons[0].clicks || 0, 0);

  const cancelled = environment.send('VD_CANCEL');
  assert.equal(cancelled.phase, 'canceled');
  assert.equal(environment.send('VD_APPLY_TEXT').ok, false);
  assert.equal(environment.publishButtons[0].clicks || 0, 0);

  const ambiguous = makeEnvironment({ buttons: [{ text: '发布' }, { text: '发布' }] });
  ambiguous.init();
  assert.equal(ambiguous.send('VD_SUBMIT', { permit: true }).ok, false);
  assert.equal(ambiguous.publishButtons.every(button => !button.clicks), true);
});
