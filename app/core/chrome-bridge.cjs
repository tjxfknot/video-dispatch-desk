'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const FIELD_KEYS = ['landscape', 'portrait', 'tags', 'declaration', 'collection'];
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));

function parsePayload(body) {
  const data = JSON.parse(body);
  if (!exactKeys(data, ['code', 'observation']) || typeof data.code !== 'string' || !/^[a-f0-9]{32}$/.test(data.code)) throw new Error('Invalid payload');
  const o = data.observation;
  if (!exactKeys(o, ['pageOrigin', 'pagePath', 'loginVisible', 'workspaceDetected', 'fields'])
    || o.pageOrigin !== 'https://creator.douyin.com'
    || typeof o.pagePath !== 'string' || !/^\/[a-zA-Z0-9/_.,~%+-]{0,199}$/.test(o.pagePath)
    || typeof o.loginVisible !== 'boolean' || typeof o.workspaceDetected !== 'boolean'
    || !exactKeys(o.fields, FIELD_KEYS) || !FIELD_KEYS.every(key => typeof o.fields[key] === 'boolean')) throw new Error('Invalid observation');
  return { code: data.code, observation: { pageOrigin: o.pageOrigin, pagePath: o.pagePath, loginVisible: o.loginVisible,
    workspaceDetected: o.workspaceDetected, fields: Object.fromEntries(FIELD_KEYS.map(key => [key, o.fields[key]])) } };
}

class ChromeBridge {
  constructor({ findAccount, onUpdate = () => {}, ports = Array.from({ length: 10 }, (_, i) => 48627 + i), ttlMs = 5 * 60_000 }) {
    this.findAccount = findAccount; this.onUpdate = onUpdate; this.ports = ports; this.ttlMs = ttlMs;
    this.records = new Map(); this.pending = null; this.serial = Promise.resolve();
  }
  account(id) {
    const account = this.findAccount(id);
    if (!account || account.platform !== 'douyin') throw new Error('请先选择已登记的抖音账号备注。');
    return account;
  }
  update(id, record) {
    const result = { accountId: id, source: 'chrome', ready: false, windowOpen: false, ...record };
    this.records.set(id, result);
    try { this.onUpdate({ type: 'connection', connection: structuredClone(result) }); } catch { /* Closing UI is harmless. */ }
    return structuredClone(result);
  }
  snapshot() { return Object.fromEntries([...this.records].map(([id, record]) => [id, structuredClone(record)])); }
  enqueue(operation) {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => {});
    return result;
  }
  async retire(pending, state, message) {
    if (!pending || this.pending !== pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.code = '';
    this.update(pending.id, { state, message });
    await new Promise(resolve => {
      pending.server.close(resolve);
      pending.server.closeAllConnections();
    });
  }
  start(id) {
    return this.enqueue(async () => {
      this.account(id);
      await this.retire(this.pending, 'not_open', '已取消上一次配对；如需读取，请重新连接。');
      const pending = { id, code: randomBytes(16).toString('hex'), server: null, timer: null, port: null };
      let listening = false;
      for (const port of this.ports) {
        const server = http.createServer((req, res) => this.receive(pending, req, res));
        server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 24;
        const error = await new Promise(resolve => {
          const failed = error => resolve(error);
          server.once('error', failed);
          server.listen(port, '127.0.0.1', () => { server.removeListener('error', failed); resolve(null); });
        });
        if (error) { if (error.code === 'EADDRINUSE') continue; throw new Error('无法启动本机配对，请检查本机网络权限。'); }
        pending.server = server; pending.port = server.address().port; listening = true;
        server.on('error', () => { void this.enqueue(() => this.retire(pending, 'error', '本机配对已停止，请重新连接。')); });
        break;
      }
      if (!listening) throw new Error('本机配对端口均被占用，请关闭其他视频发布台配对后重试。');
      this.pending = pending;
      const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
      pending.timer = setTimeout(() => { void this.enqueue(() => this.retire(pending, 'expired', '本次配对已过期，未收到有效结果。需要时请重新连接。')); }, this.ttlMs);
      pending.timer.unref();
      return this.update(id, { state: 'awaiting_pair', port: pending.port, pairCode: pending.code, expiresAt,
        message: '请在已登录的抖音Chrome标签页点开扩展，输入端口和配对码，再主动读取。本次配对5分钟有效，不上传或发布。' });
    });
  }
  stop(id) {
    return this.enqueue(async () => {
      this.account(id);
      if (this.pending?.id === id) await this.retire(this.pending, 'not_open', '本次配对已停止，未继续读取Chrome。');
      return this.update(id, { state: 'not_open', message: '配对已停止；Chrome原有登录不受影响。' });
    });
  }
  closeAll() { return this.enqueue(() => this.retire(this.pending, 'not_open', '操作台已关闭配对。')); }
  receive(pending, req, res) {
    const reply = (status, value) => {
      const body = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    req.setTimeout(5000, () => req.destroy());
    if (this.pending !== pending || req.url !== '/pair' || req.headers.host !== `127.0.0.1:${pending.port}`
      || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '')) return reply(403, { ok: false });
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] !== 'POST'
        || (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).some(x => x !== 'content-type')) return reply(403, { ok: false });
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204, { 'Cache-Control': 'no-store', Connection: 'close' }); res.end(); return;
    }
    if (req.method !== 'POST' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return reply(400, { ok: false });
    if (Number(req.headers['content-length']) > 32768) return reply(413, { ok: false });
    let size = 0, chunks = [], rejected = false;
    req.on('error', () => {});
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > 32768) { rejected = true; chunks = []; reply(413, { ok: false }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || this.pending !== pending) { if (!rejected) reply(403, { ok: false }); return; }
      let data;
      try { data = parsePayload(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { ok: false }); return; }
      if (!timingSafeEqual(Buffer.from(data.code, 'hex'), Buffer.from(pending.code, 'hex'))) return reply(403, { ok: false });
      // Consume before notifying or replying, so simultaneous requests cannot reuse the code.
      this.pending = null; clearTimeout(pending.timer); pending.code = '';
      const o = data.observation;
      const state = o.loginVisible ? 'awaiting_login' : 'awaiting_identity';
      this.update(pending.id, { state, checkedAt: new Date().toISOString(), pagePath: o.pagePath, fields: o.fields, workspaceDetected: o.workspaceDetected,
        message: o.loginVisible ? '当前Chrome页面仍显示登录入口；请核对标签页。本程序不会发起扫码或重试登录。'
          : o.workspaceDetected ? '已收到当前Chrome页面的只读结果，账号身份和真实发布仍需核对。字段仅表示检测到字样，不表示已设置。'
            : '已收到当前Chrome页面的只读结果，但未检测到已登录后台的明确字样。请核对标签页；账号身份和发布仍未验证。' });
      res.once('finish', () => {
        // finish means handed to the OS, not received by Chrome. Stop accepting
        // new clients, but let the successful response drain normally first.
        pending.server.close();
        const cutoff = setTimeout(() => pending.server.closeAllConnections(), 1000);
        cutoff.unref();
        pending.server.once('close', () => clearTimeout(cutoff));
      });
      reply(200, { ok: true });
    });
  }
}

module.exports = { ChromeBridge, parsePayload };
