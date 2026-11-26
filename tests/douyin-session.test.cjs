'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DouyinConnections, partitionName, allowedNavigation, classifyObservation, LOGIN_URL } = require('../app/core/douyin-session.cjs');

function fixture() {
  const sessions = new Map(), windows = [], updates = [];
  const accounts = [{ id: 'one', label: '主号备注', platform: 'douyin', status: 'unconnected' }, { id: 'two', label: '另一个备注', platform: 'douyin', status: 'unconnected' }, { id: 'three', platform: 'tencent' }];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.popupHandler = handler; };
      this.webContents.getURL = () => this.url || 'about:blank';
      this.webContents.executeJavaScript = async () => this.observation || { origin: 'https://creator.douyin.com', pathname: '/', loginVisible: true };
      windows.push(this);
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.dead; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const session = { fromPartition(name) {
    if (!sessions.has(name)) {
      const item = new EventEmitter();
      item.setPermissionRequestHandler = fn => { item.permission = fn; };
      item.setPermissionCheckHandler = fn => { item.check = fn; };
      sessions.set(name, item);
    }
    return sessions.get(name);
  } };
  const service = new DouyinConnections({ BrowserWindow: FakeWindow, session, findAccount: id => accounts.find(a => a.id === id), onUpdate: event => updates.push(event) });
  return { service, windows, sessions, updates, accounts };
}

test('导航只允许HTTPS抖音域，拒绝伪后缀、凭据URL、非标准端口及本机文件', () => {
  for (const value of [LOGIN_URL, 'https://creator.douyin.com/creator-micro/home', 'https://sso.douyin.com/']) assert(allowedNavigation(value));
  for (const value of ['http://creator.douyin.com', 'https://douyin.com.evil.example', 'https://notdouyin.com', 'file:///tmp/test', 'javascript:alert(1)', 'https://name:secret@creator.douyin.com/', 'https://creator.douyin.com:444/', 'not a url']) assert(!allowedNavigation(value), value);
});

test('每个备注独立临时分区，不使用persist或个人浏览器资料', () => {
  assert.notEqual(partitionName('one'), partitionName('two'));
  assert(!partitionName('one').startsWith('persist:'));
  assert.equal(partitionName('one'), partitionName('one'));
});

test('没有备注或选错平台时不得打开窗口；同备注重复点击复用一个窗口', () => {
  const { service, windows } = fixture();
  assert.throws(() => service.connect('missing'), /抖音账号备注/);
  assert.throws(() => service.connect('three'), /抖音账号备注/);
  assert.equal(windows.length, 0);
  service.connect('one'); service.connect('one');
  assert.equal(windows.length, 1);
  assert(windows[0].focused);
});

test('远程窗口不带本机桥接，保持沙箱隔离并拒绝权限、弹窗和下载', () => {
  const { service, windows, sessions } = fixture();
  service.connect('one');
  const win = windows[0], prefs = win.options.webPreferences;
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true);
  assert.equal(prefs.preload, undefined); assert.equal(prefs.webviewTag, false);
  assert.equal(win.url, LOGIN_URL); assert.equal(win.popupHandler({ url: 'https://evil.example' }).action, 'deny');
  const s = [...sessions.values()][0]; let granted;
  s.permission(null, 'geolocation', value => { granted = value; }); assert.equal(granted, false); assert.equal(s.check(), false);
  let prevented = false; s.emit('will-download', { preventDefault() { prevented = true; } }); assert(prevented);
  prevented = false; win.emit('page-title-updated', { preventDefault() { prevented = true; } }); assert(prevented);
  prevented = false; win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://evil.example'); assert(prevented);
});

test('登录页、登录后迹象及字段字样都不能升级成账号已验证或可发布', async () => {
  const { service, windows, accounts } = fixture();
  service.connect('one');
  assert.equal((await service.inspect('one')).state, 'awaiting_login');
  windows[0].url = 'https://creator.douyin.com/creator-micro/home?private=must-not-export';
  windows[0].observation = { origin: 'https://creator.douyin.com', pathname: '/creator-micro/home?private=must-not-export', loginVisible: false, workspaceDetected: true, fields: { declaration: true, collection: true } };
  const result = await service.inspect('one');
  assert.equal(result.state, 'awaiting_identity'); assert.equal(result.fields.declaration, true); assert.equal(result.fields.portrait, false);
  assert(!JSON.stringify(result).includes('must-not-export'));
  assert.equal(accounts[0].status, 'unconnected');
});

test('单有URL路径、缺少登录后界面证据，保留待检查', () => {
  assert.equal(classifyObservation({ origin: 'https://creator.douyin.com', pathname: '/creator-micro/home' }).state, 'checking');
  assert.equal(classifyObservation({ origin: 'https://creator.douyin.com', pathname: '/creator-micro/home', loginVisible: true, workspaceDetected: true }).state, 'awaiting_login');
});

test('窗口关闭后失效的只读检查不得覆盖关闭状态；关闭主程序的窗口清理互不漏掉', async () => {
  const { service, windows } = fixture(); service.connect('one'); service.connect('two');
  let complete;
  windows[0].webContents.executeJavaScript = () => new Promise(resolve => { complete = resolve; });
  const pending = service.inspect('one'); service.close('one');
  complete({ origin: 'https://creator.douyin.com', pathname: '/creator-micro/home', workspaceDetected: true });
  await pending;
  assert.equal(service.snapshot().one.state, 'not_open');
  service.closeAll(); assert(windows.every(w => w.dead));
  assert.equal(service.snapshot().two.windowOpen, false);
});
