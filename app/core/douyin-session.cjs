'use strict';

const { createHash } = require('node:crypto');

const LOGIN_URL = 'https://creator.douyin.com/';
const partitionName = id => `douyin-${createHash('sha256').update(String(id)).digest('hex')}`;

function allowedNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
  } catch { return false; }
}

// This script only reads visible UI labels and input metadata. It does not read
// input values, cookies, storage, account metrics, QR data, tokens, or requests.
const PROBE_SCRIPT = `(() => {
  const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
    && getComputedStyle(element).visibility !== 'hidden';
  const nodes = [...document.querySelectorAll('button,label,a,[role="button"],h1,h2,h3,span')].filter(visible);
  const loginVisible = nodes.some(node => ['扫码登录','手机号登录','二维码已失效','二维码失效'].includes((node.innerText || '').trim()))
    || [...document.querySelectorAll('img[aria-label="二维码"],#animate_qrcode_container img,[class*="scan_qrcode_login_content"]')].some(visible);
  const controls = [...document.querySelectorAll('button,label,[role="button"],input:not([type="password"]):not([type="tel"]):not([type="hidden"]),textarea')]
    .filter(visible).slice(0,500).map(node => ((node.getAttribute('placeholder') || node.getAttribute('aria-label') || node.innerText || '').trim()).slice(0,100));
  const match = expression => controls.some(label => expression.test(label));
  const workspaceDetected = nodes.some(node => ['作品管理','内容管理','数据中心','发布视频'].includes((node.innerText || '').trim()));
  const uploadInput = [...document.querySelectorAll('input[type="file"]')].some(node => /video|mp4|mov/.test(node.getAttribute('accept') || ''));
  return { origin: location.origin, pathname: location.pathname, loginVisible, workspaceDetected, uploadInput,
    fields: { landscape: match(/横版封面|横封面/), portrait: match(/竖版封面|竖封面/),
      tags: match(/添加话题|输入标签|添加标签|话题/), declaration: match(/内容声明|作品声明|自主声明|个人观点|个人意见/), collection: match(/合集/) } };
})()`;

function classifyObservation(observation) {
  const o = observation || {};
  const fields = Object.fromEntries(['landscape', 'portrait', 'tags', 'declaration', 'collection'].map(key => [key, o.fields?.[key] === true]));
  const pagePath = typeof o.pathname === 'string' && o.pathname.startsWith('/') ? o.pathname.split(/[?#]/)[0].slice(0, 200) : '/';
  if (o.origin !== 'https://creator.douyin.com' || o.loginVisible === true) {
    return { state: 'awaiting_login', message: '请在抖音官方窗口自行扫码。这里只检查页面，不上传或发布。', pagePath, fields };
  }
  if (pagePath.startsWith('/creator-micro/') && (o.workspaceDetected === true || o.uploadInput === true)) {
    return { state: 'awaiting_identity', message: '检测到登录后页面迹象；账号身份尚未核对，不能上传或发布。部分字段可能在选择视频后才出现。', pagePath, fields };
  }
  return { state: 'checking', message: '当前页面尚不足以核实登录状态。请等待页面显示后点击“检查当前页面”。', pagePath, fields };
}

class DouyinConnections {
  constructor({ BrowserWindow, session, findAccount, onUpdate = () => {} }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.findAccount = findAccount;
    this.onUpdate = onUpdate;
    this.records = new Map();
    this.windows = new Map();
    this.revisions = new Map();
    this.guardedSessions = new WeakSet();
  }

  account(id) {
    const account = this.findAccount(id);
    if (!account || account.platform !== 'douyin') throw new Error('请先选择已登记的抖音账号备注。');
    return account;
  }

  update(id, patch) {
    const previous = this.records.get(id) || { accountId: id, state: 'not_open', windowOpen: false, message: '尚未打开抖音登录窗口。' };
    const record = { ...previous, ...patch, accountId: id };
    this.records.set(id, record);
    try { this.onUpdate({ type: 'connection', connection: structuredClone(record) }); } catch { /* UI closing does not alter the connection. */ }
    return structuredClone(record);
  }

  snapshot() { return Object.fromEntries([...this.records].map(([id, record]) => [id, structuredClone(record)])); }

  connect(id) {
    const account = this.account(id);
    const current = this.windows.get(id);
    if (current && !current.isDestroyed()) { current.show(); current.focus(); return structuredClone(this.records.get(id)); }
    // No persist: prefix: the platform session is memory-only and belongs to
    // this account note. It never imports an existing browser profile.
    const isolated = this.session.fromPartition(partitionName(id));
    if (!this.guardedSessions.has(isolated)) {
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.on('will-download', event => event.preventDefault());
      this.guardedSessions.add(isolated);
    }
    const label = String(account.label || '抖音备注').replace(/[\r\n\t]/g, ' ').slice(0, 80);
    const win = new this.BrowserWindow({
      width: 1180, height: 860, minWidth: 900, minHeight: 650,
      title: `抖音登录与核对 · ${label} · 不自动上传或发布`,
      backgroundColor: '#ffffff', show: true,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false }
    });
    this.windows.set(id, win);
    this.update(id, { state: 'checking', windowOpen: true, message: '正在打开抖音官方登录页。登录只保留到退出本程序，不会上传或发布。', fields: undefined });
    const blocked = event => {
      event.preventDefault();
      this.update(id, { state: 'error', message: '页面尝试跳转到非抖音地址，已停止。请返回登录窗口重试。' });
    };
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) blocked(event); });
    win.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => { if (mainFrame !== false && !allowedNavigation(url)) blocked(event); });
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('page-title-updated', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => { this.inspect(id).catch(() => {}); });
    win.webContents.on('did-navigate-in-page', (_event, _url, mainFrame) => { if (mainFrame !== false) this.inspect(id).catch(() => {}); });
    win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame === false || code === -3) return;
      this.update(id, { state: 'error', message: `抖音页面加载失败（网络错误 ${Number(code)}）。请检查网络后重新打开；不会绕过证书或安全提示。` });
    });
    win.webContents.on('render-process-gone', () => this.update(id, { state: 'error', message: '抖音窗口进程已停止，请关闭窗口后重新打开。' }));
    win.on('closed', () => {
      this.windows.delete(id);
      this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
      this.update(id, { state: 'not_open', windowOpen: false, fields: undefined, message: '登录窗口已关闭。本次运行中可重新打开；退出整个程序后需要重新扫码。' });
    });
    win.loadURL(LOGIN_URL).catch(() => {
      if (!win.isDestroyed()) this.update(id, { state: 'error', message: '未能打开抖音官方页面，请检查网络后关闭窗口重试。' });
    });
    return structuredClone(this.records.get(id));
  }

  async inspect(id) {
    this.account(id);
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) return this.update(id, { state: 'not_open', windowOpen: false, fields: undefined, message: '请先打开该备注对应的抖音登录窗口。' });
    if (!allowedNavigation(win.webContents.getURL())) return this.update(id, { state: 'checking', message: '抖音页面仍在打开，请等待页面显示。', fields: undefined });
    const revision = (this.revisions.get(id) || 0) + 1;
    this.revisions.set(id, revision);
    try {
      const observation = await win.webContents.executeJavaScript(PROBE_SCRIPT, false);
      if (win.isDestroyed() || this.revisions.get(id) !== revision) return structuredClone(this.records.get(id));
      if (!allowedNavigation(win.webContents.getURL())) throw new Error('Page changed');
      return this.update(id, { ...classifyObservation(observation), windowOpen: true, checkedAt: new Date().toISOString() });
    } catch {
      if (win.isDestroyed() || this.revisions.get(id) !== revision) return structuredClone(this.records.get(id));
      return this.update(id, { state: 'error', fields: undefined, message: '当前页面检查未完成，请等待页面稳定后重试。没有执行任何上传或提交。' });
    }
  }

  close(id) {
    this.account(id);
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.destroy();
    return this.update(id, { state: 'not_open', windowOpen: false, fields: undefined, message: '窗口已关闭；没有自动上传或发布。' });
  }

  closeAll() { for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy(); }
}

module.exports = { DouyinConnections, LOGIN_URL, partitionName, allowedNavigation, classifyObservation, PROBE_SCRIPT };
