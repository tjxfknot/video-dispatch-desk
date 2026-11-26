'use strict';

const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const accounts = require('./accounts.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validOrigin = value => /^chrome-extension:\/\/[a-p]{32}$/.test(value || '');

function identity(value) {
  if (!exact(value, ['pageOrigin', 'pagePath', 'platformAccountId', 'displayName', 'source'])
    || value.pageOrigin !== 'https://creator.douyin.com' || value.pagePath !== '/creator-micro/home'
    || value.source !== 'visible_account_label' || !/^[A-Za-z0-9_.-]{3,64}$/.test(value.platformAccountId || '')
    || typeof value.displayName !== 'string' || value.displayName.length > 120 || /[\u0000-\u001f]/.test(value.displayName)) throw new Error('没有取得唯一可核对的账号标识。');
  return structuredClone(value);
}

class AccountBroker {
  constructor({ store, vault, onUpdate = () => {}, ports = Array.from({ length: 10 }, (_, i) => 48717 + i), ttlMs = 300_000, freshMs = 25_000, operationMs = 25_000 }) {
    this.store = store; this.vault = vault; this.onUpdate = onUpdate; this.ports = ports;
    this.ttlMs = ttlMs; this.freshMs = freshMs; this.operationMs = operationMs;
    this.pairs = new Map(); this.sessions = new Map(); this.operations = new Map(); this.checks = new Map();
    this.server = null; this.port = null; this.opening = null;
    this.monitor = setInterval(() => {
      for (const s of this.sessions.values()) if (s.online && Date.now() - s.lastSeen > this.freshMs) { s.online = false; this.emit({ type: 'data' }); }
    }, 5000);
    this.monitor.unref();
  }
  emit(data) { try { this.onUpdate(structuredClone(data)); } catch {} }
  account(id) {
    const a = this.store.load().accounts.find(a => a.id === id);
    if (!a || a.platform !== 'douyin' || !a.teacherId) throw new Error('请先为老师登记一个抖音账号。');
    if (a.browserEnvironmentId || a.binding?.source === 'managed_browser') throw new Error('此账号使用工作台专属浏览器，不能经旧扩展操作。');
    return a;
  }
  pairView(p) {
    return { accountId: p.accountId, state: p.state, message: p.message,
      ...(p.state === 'awaiting_pair' ? { port: this.port, pairCode: p.code, expiresAt: p.expiresAt } : {}),
      ...(p.state === 'awaiting_confirmation' ? { candidate: { platformAccountId: p.observation.platformAccountId, displayName: p.observation.displayName, environmentLabel: p.environmentLabel } } : {}) };
  }
  updatePair(p, state, message) { p.state = state; p.message = message; if (state !== 'awaiting_pair') p.code = ''; this.emit({ type: 'account_pair', pair: this.pairView(p) }); return this.pairView(p); }
  snapshot() {
    const data = accounts.snapshotAccounts(this.store);
    data.environments = data.environments.map(e => ({ ...e, online: this.isOnline(e.connectorInstanceId) }));
    data.accountPairs = Object.fromEntries([...this.pairs].map(([id, p]) => [id, this.pairView(p)]));
    data.accountChecks = Object.fromEntries(this.checks);
    return data;
  }
  isOnline(id) { const s = this.sessions.get(id); return !!s?.bound && !!s.online && Date.now() - s.lastSeen <= this.freshMs; }
  async listen() {
    if (this.server) return this.port;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      for (const port of this.ports) {
        const server = http.createServer((req, res) => { void this.receive(req, res); });
        server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 24;
        const error = await new Promise(resolve => { server.once('error', resolve); server.listen(port, '127.0.0.1', () => { server.removeAllListeners('error'); resolve(null); }); });
        if (error?.code === 'EADDRINUSE') continue;
        if (error) throw new Error('本机账号连接未能启动。');
        this.server = server; this.port = server.address().port; server.on('error', () => this.emit({ type: 'data' }));
        return this.port;
      }
      throw new Error('本机账号连接端口暂不可用。');
    })();
    try { return await this.opening; } finally { this.opening = null; }
  }
  async start(accountId) {
    const a = this.account(accountId);
    this.vault.load(); // Fail before showing a pairing code if secure storage is unavailable.
    await this.listen(); this.cancel(accountId);
    const teacher = this.store.load().teachers.find(t => t.id === a.teacherId);
    const p = { accountId, teacherId: a.teacherId, bindingRevision: a.binding?.revision || '', state: 'awaiting_pair', code: randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + this.ttlMs).toISOString(), environmentLabel: teacher.name, message: '在该老师的独立Chrome个人资料中打开账号连接器，输入一次性码。' };
    p.timer = setTimeout(() => {
      if (['awaiting_pair', 'awaiting_confirmation'].includes(p.state)) { if (p.connectorInstanceId && !this.sessions.get(p.connectorInstanceId)?.bound) this.sessions.delete(p.connectorInstanceId); this.updatePair(p, 'expired', '账号连接已过期，请重新发起。'); }
    }, this.ttlMs); p.timer.unref();
    this.pairs.set(accountId, p); return this.updatePair(p, p.state, p.message);
  }
  cancel(accountId) {
    const p = this.pairs.get(accountId);
    if (!p) return { accountId, state: 'canceled', message: '没有等待中的连接。' };
    clearTimeout(p.timer);
    if (['awaiting_pair', 'awaiting_confirmation'].includes(p.state)) {
      if (p.connectorInstanceId && !this.sessions.get(p.connectorInstanceId)?.bound) this.sessions.delete(p.connectorInstanceId);
      return this.updatePair(p, 'canceled', '本次连接已取消，网站登录不变。');
    }
    return this.pairView(p);
  }
  confirm(accountId) {
    const p = this.pairs.get(accountId);
    if (!p || p.state !== 'awaiting_confirmation' || Date.parse(p.expiresAt) <= Date.now()) throw new Error('没有可确认的账号，请重新连接。');
    const s = this.sessions.get(p.connectorInstanceId);
    if (!s || s.pairAccountId !== accountId) throw new Error('连接已变更，请重新核对账号。');
    const target = this.account(accountId);
    if (target.teacherId !== p.teacherId || (target.binding?.revision || '') !== p.bindingRevision) throw new Error('连接期间账号归属或绑定已变更，请重新发起。');
    const input = { accountId, connectorInstanceId: p.connectorInstanceId, platformAccountId: p.observation.platformAccountId, displayName: p.observation.displayName, environmentLabel: p.environmentLabel };
    const temporary = structuredClone(this.store.load());
    accounts.bindManagedAccount({ load: () => temporary, update: fn => fn(temporary) }, input);
    const before = this.vault.get(p.connectorInstanceId);
    this.vault.set(p.connectorInstanceId, { token: s.token, origin: s.origin });
    let result;
    try { result = accounts.bindManagedAccount(this.store, input); }
    catch (error) { this.vault.set(p.connectorInstanceId, before); throw error; }
    clearTimeout(p.timer); s.bound = true; s.online = true; s.lastSeen = Date.now();
    this.updatePair(p, 'bound', '账号身份已绑定；当前仅账号连接检查可用，自动发布尚未完成。'); this.emit({ type: 'data' });
    return result;
  }
  authenticate(req, origin, id) {
    if (!UUID.test(id || '')) return null;
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    let s = this.sessions.get(id);
    if (!s) {
      const saved = this.vault.get(id);
      if (!saved || !equal(saved.token, token) || saved.origin !== origin || !this.store.load().accounts.some(a => a.binding?.connectorInstanceId === id)) return null;
      s = { token: saved.token, origin: saved.origin, bound: true, lastSeen: 0, online: false }; this.sessions.set(id, s);
    }
    return s.origin === origin && equal(s.token, token) ? s : null;
  }
  async operation(accountId, kind) {
    const a = this.account(accountId), b = a.binding;
    if (!b || !this.isOnline(b.connectorInstanceId)) return { accountId, state: 'offline', message: '该老师的Chrome连接未在线；请打开其账号连接窗口。' };
    if (this.operations.has(b.connectorInstanceId)) throw new Error('该账号正在检查，请稍候再试。');
    return new Promise(resolve => {
      const op = { id: randomUUID(), kind, accountId, expectedAccountId: b.platformAccountId, bindingRevision: b.revision, resolve };
      op.timer = setTimeout(() => { this.operations.delete(b.connectorInstanceId); resolve({ accountId, state: 'unverifiable', message: '页面检查超时，未获得可核对的账号，未执行发布。' }); }, this.operationMs); op.timer.unref();
      this.operations.set(b.connectorInstanceId, op);
    });
  }
  async inspect(accountId) { return this.operation(accountId, 'inspect'); }
  async open(accountId) {
    const result = await this.operation(accountId, 'open');
    if (result.state !== 'verified') throw new Error(result.message);
    return { opened: true };
  }
  unbind(accountId) {
    const a = this.account(accountId), id = a.binding?.connectorInstanceId;
    const result = accounts.unbindManagedAccount(this.store, accountId); this.cancel(accountId);
    this.checks.delete(accountId);
    const pair = this.pairs.get(accountId); if (pair) this.updatePair(pair, 'canceled', '本机账号绑定已解除，网站登录和历史保留。');
    if (id && !this.store.load().accounts.some(a => a.binding?.connectorInstanceId === id)) {
      this.vault.set(id, null); this.sessions.delete(id);
      const op = this.operations.get(id); if (op) { clearTimeout(op.timer); this.operations.delete(id); op.resolve({ accountId, state: 'offline', message: '账号绑定已解除。' }); }
    }
    this.emit({ type: 'data' }); return result;
  }
  async receive(req, res) {
    const origin = req.headers.origin;
    const reply = (code, value) => {
      if (res.destroyed) return;
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(validOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } : {}) });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${this.port}` || !validOrigin(origin)) return reply(403, { ok: false });
      if (!['/v05/connect', '/v05/poll', '/v05/report'].includes(req.url)) return reply(404, { ok: false });
      if (req.method === 'OPTIONS') return reply(200, { ok: true });
      if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || Number(req.headers['content-length'] || 0) > 8192) return reply(400, { ok: false });
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return reply(413, { ok: false }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/v05/connect') {
        if (!exact(body, ['code', 'connectorInstanceId', 'observation']) || !UUID.test(body.connectorInstanceId || '')) return reply(400, { ok: false });
        const p = [...this.pairs.values()].find(p => p.state === 'awaiting_pair' && equal(p.code, body.code) && Date.parse(p.expiresAt) > Date.now());
        if (!p) return reply(403, { ok: false });
        const observation = identity(body.observation), a = this.account(p.accountId);
        if (a.teacherId !== p.teacherId || (a.binding?.revision || '') !== p.bindingRevision) return reply(409, { ok: false });
        if (a.binding) accounts.assertIdentity(this.store, { accountId: a.id, connectorInstanceId: body.connectorInstanceId, platformAccountId: observation.platformAccountId });
        if ([...this.pairs.values()].some(other => other !== p && other.state === 'awaiting_confirmation' && other.connectorInstanceId === body.connectorInstanceId)) return reply(409, { ok: false });
        p.observation = observation; p.connectorInstanceId = body.connectorInstanceId;
        const token = randomBytes(32).toString('hex');
        this.sessions.set(body.connectorInstanceId, { token, origin, bound: false, pairAccountId: p.accountId, lastSeen: Date.now(), online: false });
        this.updatePair(p, 'awaiting_confirmation', '已从可见页面读到账号，请在工作台确认该号属于所选老师。');
        return reply(200, { ok: true, token, accountId: p.accountId, needsConfirmation: true });
      }
      const keys = req.url === '/v05/poll' ? ['connectorInstanceId'] : ['connectorInstanceId', 'operationId', 'observation', 'error'];
      if (!exact(body, keys)) return reply(400, { ok: false });
      const s = this.authenticate(req, origin, body.connectorInstanceId);
      if (!s) return reply(401, { ok: false });
      const wasOnline = this.isOnline(body.connectorInstanceId);
      s.lastSeen = Date.now(); s.online = s.bound;
      if (s.bound && !wasOnline) this.emit({ type: 'data' });
      const op = this.operations.get(body.connectorInstanceId);
      if (req.url === '/v05/poll') return reply(200, { ok: true, state: s.bound ? 'connected' : 'pending_confirmation', operation: s.bound && op ? { id: op.id, kind: op.kind, expectedAccountId: op.expectedAccountId, accountId: op.accountId } : null });
      if (!s.bound || !op || op.id !== body.operationId || typeof body.error !== 'string' || body.error.length > 200) return reply(409, { ok: false });
      let result;
      try {
        if (body.error) throw new Error('页面未能提供唯一账号标识，请在该老师的Chrome环境核对登录。');
        const observed = identity(body.observation), a = this.account(op.accountId);
        if (a.binding?.revision !== op.bindingRevision) throw new Error('检查期间账号绑定已变更。');
        accounts.assertIdentity(this.store, { accountId: op.accountId, connectorInstanceId: body.connectorInstanceId, platformAccountId: observed.platformAccountId });
        result = { accountId: op.accountId, state: 'verified', platformAccountId: observed.platformAccountId, message: '程序已核对真实账号与环境一致；未上传或发布。' };
      } catch (error) { result = { accountId: op.accountId, state: body.error ? 'unverifiable' : 'mismatch', message: error.message }; }
      clearTimeout(op.timer); this.operations.delete(body.connectorInstanceId); this.checks.set(op.accountId, result); op.resolve(result); this.emit({ type: 'account_check', check: result });
      return reply(200, { ok: true, state: result.state });
    } catch { return reply(400, { ok: false, message: '账号连接未被接受；请核对任务、账号和连接环境。' }); }
  }
  async close() {
    clearInterval(this.monitor);
    for (const p of this.pairs.values()) clearTimeout(p.timer);
    for (const [id, op] of this.operations) { clearTimeout(op.timer); op.resolve({ accountId: op.accountId, state: 'offline', message: '操作台已关闭，检查停止。' }); this.operations.delete(id); }
    this.sessions.clear();
    if (this.server) { const server = this.server; this.server = null; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  }
}

module.exports = { AccountBroker, identity };
