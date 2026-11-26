'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { normalizeDraft, validateDraft, snapshotHash } = require('./domain.cjs');
const { resolveDeclaration } = require('./publish-settings.cjs');
const CHECKS = ['video', 'covers', 'text', 'declaration', 'collection', 'schedule'];
const TERMINAL = new Set(['submitted', 'awaiting_verification', 'failed', 'canceled']);
const MIME = { video: 'video/mp4', landscape: 'image/png', portrait: 'image/png' };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const safeText = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008]/.test(v);
const sameSecret = (a, b) => typeof a === 'string' && /^[a-f0-9]{32}$/.test(a) && typeof b === 'string' && /^[a-f0-9]{32}$/.test(b)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
function validWorkUrl(value) { return typeof value === 'string' && /^https:\/\/(?:www\.)?douyin\.com\/video\/\d{10,30}$/.test(value); }

function buildJob(input, state, inspectFile = fs.statSync) {
  const draft = normalizeDraft(input, state);
  const result = validateDraft(draft, state, 'rehearsal', inspectFile);
  if (!result.ok) throw new Error(result.issues.filter(x => x.severity === 'error').map(x => x.message).join('\n'));
  const selected = draft.targets.filter(x => x.enabled);
  if (selected.length !== 1 || selected[0].platform !== 'douyin') throw new Error('真实试验目前仅支持单条抖音，请只勾选抖音。');
  const effective = resolveDeclaration(draft.sharedDeclaration, selected[0].declaration, 'douyin');
  if (Object.values(selected[0].specialSettings || {}).some(value => value !== 'platform_default')) throw new Error('本条特殊设置的自动填写尚未接通，不能忽略后继续发布。');
  if (draft.sharedDeclaration?.intent !== 'none' && draft.sharedDeclaration?.intent && effective.origin === 'shared' && effective.required) throw new Error('共同声明尚未从本账号发布页核对，不能忽略后继续发布。');
  if (effective.required && selected[0].declaration.intent && selected[0].declaration.intent !== 'none') throw new Error('原生声明选项已记录，自动填写尚未接通，不能忽略后继续发布。');
  const target = { ...selected[0], declaration: { ...selected[0].declaration, required: effective.required, text: effective.nativeText || effective.text } };
  if (!draft.schedule || !['immediate', 'scheduled'].includes(draft.schedule.mode) || draft.schedule.timeZone !== 'Asia/Shanghai') throw new Error('发布时间配置未核对，请升级操作台并重新检查。');
  const files = [draft.video, target.covers.landscape || draft.covers.landscape, target.covers.portrait || draft.covers.portrait];
  if (files.some(x => !x)) throw new Error('抖音真实试验需要视频、横版封面和竖版封面各一份。');
  for (const file of files) {
    const stat = inspectFile(file.path);
    if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error('素材已改变，请重新选择后核对。');
    if (file.size > (file.kind === 'video' ? 512 : 20) * 1024 * 1024) throw new Error('本轮真实试验支持视频不超过512MB，单张封面不超过20MB。');
  }
  const copy = target.inherit ? draft.common : target;
  const account = state.accounts.find(a => a.id === target.accountId && a.platform === 'douyin');
  return { draft, summary: result.summary, account, target, files,
    job: { fingerprint: snapshotHash(draft), accountLabel: account.label,
      common: { title: copy.title, description: copy.description, tags: copy.tags }, declaration: target.declaration, collection: target.collection, schedule: structuredClone(draft.schedule),
      files: files.map(f => ({ id: f.id, kind: f.kind, name: f.name, size: f.size,
        type: /\.jpe?g$/i.test(f.name) ? 'image/jpeg' : /\.webp$/i.test(f.name) ? 'image/webp' : /\.mov$/i.test(f.name) ? 'video/quicktime' : MIME[f.kind] })) } };
}

function parseEvent(body) {
  const event = JSON.parse(body);
  if (!exact(event, ['type', 'data']) || !['identified', 'preparing', 'needs_manual', 'prepared', 'submitted', 'awaiting_verification', 'failed', 'canceled'].includes(event.type)) throw new Error('Invalid event');
  const d = event.data;
  const keys = ['message', 'accountDisplay', 'checks', 'workId', 'workUrl', 'platformStatus'];
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !keys.includes(k))) throw new Error('Invalid data');
  for (const [key, limit] of [['message', 500], ['accountDisplay', 120], ['platformStatus', 100]]) if (Object.hasOwn(d, key) && !safeText(d[key], limit)) throw new Error('Invalid text');
  if (Object.hasOwn(d, 'checks') && (!exact(d.checks, CHECKS) || CHECKS.some(k => typeof d.checks[k] !== 'boolean'))) throw new Error('Invalid checks');
  if (Object.hasOwn(d, 'workId') && (typeof d.workId !== 'string' || !/^\d{10,30}$/.test(d.workId))) throw new Error('Invalid work id');
  if (Object.hasOwn(d, 'workUrl') && !validWorkUrl(d.workUrl)) throw new Error('Invalid work URL');
  if (d.workId && d.workUrl && !d.workUrl.endsWith('/' + d.workId)) throw new Error('Mismatched work');
  return { type: event.type, data: { ...d, ...(d.checks ? { checks: { ...d.checks } } : {}) } };
}

class ChromePublisher {
  constructor({ store, onUpdate = () => {}, ports = Array.from({ length: 10 }, (_, i) => 48637 + i), ttlMs = 2 * 60 * 60_000, inspectFile = fs.statSync }) {
    this.store = store; this.onUpdate = onUpdate; this.ports = ports; this.ttlMs = ttlMs; this.inspectFile = inspectFile;
    this.current = null; this.records = new Map(); this.serial = Promise.resolve();
    this.store.update(state => {
      for (const run of state.runs) if (run.mode === 'chrome_prepare' && !TERMINAL.has(run.status)) {
        const status = ['submitting', 'approved'].includes(run.status) ? 'awaiting_verification' : 'needs_manual';
        run.status = status; run.updatedAt = new Date().toISOString();
        run.items.forEach(item => { item.status = status; item.detail = '程序已重启。先核对平台记录，不自动续传或重复发布。'; });
        run.events.push({ at: run.updatedAt, status, message: '真实试验中断；需要核对平台草稿或作品记录。' });
      }
    });
  }
  enqueue(fn) { const result = this.serial.then(fn); this.serial = result.catch(() => {}); return result; }
  emit(event) { try { this.onUpdate(structuredClone(event)); } catch {} }
  session(s, state, message) {
    const value = { runId: s.runId, accountId: s.accountId, state, message, ...(state === 'awaiting_browser' ? { port: s.port, pairCode: s.code, expiresAt: s.expiresAt } : {}) };
    this.records.set(s.runId, value); this.emit({ type: 'live_session', session: value }); return structuredClone(value);
  }
  snapshot() { return Object.fromEntries([...this.records].map(([id, r]) => [id, structuredClone(r)])); }
  run(id) { return this.store.load().runs.find(r => r.id === id && r.mode === 'chrome_prepare'); }
  patch(id, status, message, data = {}) {
    this.store.update(state => {
      const run = state.runs.find(r => r.id === id);
      if (!run) throw new Error('真实试验任务不存在。');
      run.status = status; run.updatedAt = new Date().toISOString();
      Object.assign(run, data);
      Object.assign(run.items[0], { status, detail: message });
      run.events.push({ at: run.updatedAt, status, message });
    });
    const run = this.run(id); this.emit({ type: 'run', run }); return run;
  }
  async listen(s) {
    for (const port of this.ports) {
      const server = http.createServer((req, res) => this.receive(s, req, res));
      server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 24;
      const error = await new Promise(resolve => {
        const fail = e => resolve(e); server.once('error', fail);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); resolve(null); });
      });
      if (error) { if (error.code === 'EADDRINUSE') continue; throw new Error('无法启动本机真实试验接收器。'); }
      s.server = server; s.port = server.address().port;
      server.on('error', () => { void this.enqueue(() => this.stop(s.runId, '本机连接异常，先核对是否已上传或提交。')); });
      return;
    }
    throw new Error('真实试验端口已占用，请先停止其他试验。');
  }
  start({ draft, requestId } = {}) {
    return this.enqueue(async () => {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new Error('确认凭据无效，请重新核对本次任务。');
      const state = this.store.load(); const built = buildJob(draft, state, this.inspectFile);
      const previous = state.runs.find(r => r.requestId === requestId);
      if (previous) {
        if (previous.mode !== 'chrome_prepare' || previous.fingerprint !== built.job.fingerprint) throw new Error('确认后配置发生变化，请重新核对。');
        return { run: previous, session: this.records.get(previous.id) || null };
      }
      if (this.current) throw new Error('已有真实试验尚未结束，请先核对并停止原任务。');
      if (state.runs.some(r => r.mode === 'chrome_prepare' && ['submitting', 'submitted', 'awaiting_verification'].includes(r.status)
        && r.items?.[0]?.accountId === built.account.id && r.snapshot?.video?.path === built.draft.video.path
        && r.snapshot.video.size === built.draft.video.size && r.snapshot.video.mtimeMs === built.draft.video.mtimeMs)) throw new Error('相同视频已有提交或待核查记录，请先核对平台，当前不会重复上传发布。');
      const now = new Date().toISOString(); const id = randomUUID();
      const run = { id, mode: 'chrome_prepare', requestId, fingerprint: built.job.fingerprint, createdAt: now, updatedAt: now,
        status: 'awaiting_browser', snapshot: built.draft, summary: built.summary,
        items: [{ id: randomUUID(), platform: 'douyin', accountId: built.account.id, status: 'awaiting_browser', detail: '等待Chrome助手；尚未上传。' }],
        events: [{ at: now, status: 'awaiting_browser', message: '已确认不可变真实试验快照，等待浏览器核对账号后上传填写；最终发布尚未授权。' }] };
      const s = { runId: id, accountId: built.account.id, code: randomBytes(16).toString('hex'), token: '', origin: '',
        job: { ...built.job, runId: id }, files: new Map(built.files.map(f => [f.id, f])), streams: new Set(), server: null,
        expiresAt: new Date(Date.now() + this.ttlMs).toISOString() };
      await this.listen(s);
      try { this.store.update(data => data.runs.unshift(run)); } catch (e) { s.server.close(); throw e; }
      this.current = s;
      s.timer = setTimeout(() => { void this.enqueue(() => this.stop(s.runId, '真实试验已过期，先核对平台草稿和作品记录。')); }, this.ttlMs); s.timer.unref();
      this.emit({ type: 'run', run });
      return { run, session: this.session(s, 'awaiting_browser', '在已登录抖音发布页打开扩展助手，核对本条任务和当前账号后开始上传。') };
    });
  }
  approve(id) {
    const run = this.run(id);
    if (!run || run.status !== 'awaiting_confirmation' || this.current?.runId !== id) throw new Error('尚未完成本条真实填写与核对，不能授权发布。');
    if (!run.accountDisplay || !run.checks || CHECKS.some(k => run.checks[k] !== true)) throw new Error('账号或必需字段仍未核对齐全，不能发布。');
    return this.patch(id, 'approved', '操作者已在本条总览确认真实发布；只允许该快照提交一次。');
  }
  async closeSession(s, state, message, graceful = false) {
    if (!s) return;
    if (this.current === s) this.current = null;
    clearTimeout(s.timer); s.code = ''; s.token = '';
    for (const stream of s.streams) stream.destroy();
    this.session(s, state, message);
    s.server.close();
    if (!graceful) s.server.closeAllConnections();
    else { const cutoff = setTimeout(() => s.server.closeAllConnections(), 1000); cutoff.unref(); s.server.once('close', () => clearTimeout(cutoff)); }
  }
  async stop(id, message = '真实试验已停止；可能已有平台草稿或提交，请先核对，不会自动删除或重发。') {
    const run = this.run(id); if (!run) throw new Error('真实试验任务不存在。');
    if (TERMINAL.has(run.status)) return run;
    const status = ['submitting', 'approved'].includes(run.status) ? 'awaiting_verification' : 'canceled';
    const result = this.patch(id, status, message);
    if (this.current?.runId === id) await this.closeSession(this.current, status, message);
    return result;
  }
  hasActiveSession() { return !!this.current; }
  async closeAll() { if (this.current) await this.stop(this.current.runId, '程序关闭，先核对平台记录，不会自动续传或重复发布。'); }
  receive(s, req, res) {
    const reply = (status, value) => {
      const body = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', Connection: 'close', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
    };
    req.on('error', () => {}); req.setTimeout(15000, () => req.destroy());
    const origin = req.headers.origin || '';
    if (this.current !== s || req.headers.host !== `127.0.0.1:${s.port}` || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)
      || (s.origin && s.origin !== origin) || req.url.includes('?') || !/^\/job\/(connect|event|status|begin-submit|asset\/[a-f0-9-]{36})$/.test(req.url)) return reply(403, { ok: false });
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      if (!['POST', 'GET'].includes(req.headers['access-control-request-method']) || (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).some(x => !['content-type', 'authorization'].includes(x))) return reply(403, { ok: false });
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.writeHead(204, { Connection: 'close' }); res.end(); return;
    }
    const isConnect = req.url === '/job/connect';
    if (!isConnect && !sameSecret((req.headers.authorization || '').replace(/^Bearer /, ''), s.token)) return reply(403, { ok: false });
    if (req.method === 'GET' && req.url === '/job/status') { const run = this.run(s.runId); return reply(200, { ok: true, status: run.status, approved: run.status === 'approved' }); }
    if (req.method === 'GET' && req.url.startsWith('/job/asset/')) {
      const file = s.files.get(req.url.slice('/job/asset/'.length)); if (!file) return reply(404, { ok: false });
      let fd;
      try {
        fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error('Changed');
      } catch {
        if (fd !== undefined) fs.closeSync(fd);
        const status = ['approved', 'submitting'].includes(this.run(s.runId)?.status) ? 'awaiting_verification' : 'failed';
        this.patch(s.runId, status, '素材已改变或无法读取，本次真实试验已停止；请重新选取素材并核对平台草稿或作品记录。');
        res.once('finish', () => { void this.closeSession(s, status, '素材已改变，本机交接已关闭。', true); });
        return reply(409, { ok: false, message: '素材已改变，本次任务已停止，请重新核对。' });
      }
      const stream = fs.createReadStream(file.path, { fd, autoClose: true }); s.streams.add(stream);
      stream.on('error', () => res.destroy()); stream.on('close', () => s.streams.delete(stream));
      res.on('close', () => stream.destroy());
      res.writeHead(200, { 'Content-Type': s.job.files.find(f => f.id === file.id).type, 'Content-Length': file.size, 'Cache-Control': 'no-store', Connection: 'close' }); stream.pipe(res); return;
    }
    if (req.method !== 'POST' || !['/job/connect', '/job/event', '/job/begin-submit'].includes(req.url)
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return reply(400, { ok: false });
    if (Number(req.headers['content-length']) > 32768) return reply(413, { ok: false });
    let chunks = [], size = 0, rejected = false;
    req.on('data', chunk => { if (rejected) return; size += chunk.length; if (size > 32768) { rejected = true; chunks = []; reply(413, { ok: false }); } else chunks.push(chunk); });
    req.on('end', () => {
      if (rejected) return;
      if (this.current !== s) return reply(403, { ok: false });
      try {
        const body = Buffer.concat(chunks).toString('utf8'); const data = JSON.parse(body);
        if (isConnect) {
          if (!exact(data, ['code']) || !sameSecret(data.code, s.code) || s.token) return reply(403, { ok: false });
          s.token = randomBytes(16).toString('hex'); s.code = ''; s.origin = origin;
          this.session(s, 'connected', 'Chrome助手已取得本条快照，请先核对当前账号后开始上传。');
          return reply(200, { ok: true, token: s.token, job: s.job });
        }
        const run = this.run(s.runId);
        if (req.url === '/job/begin-submit') {
          if (!exact(data, ['fingerprint']) || data.fingerprint !== run.fingerprint || run.status !== 'approved') return reply(409, { ok: false });
          this.patch(run.id, 'submitting', '已发出本条唯一提交许可；结果未明时不会自动重试。');
          return reply(200, { ok: true, submitOnce: true });
        }
        const event = parseEvent(body); const d = event.data;
        if (TERMINAL.has(run.status)) return reply(409, { ok: false });
        let status = run.status, patch = {};
        if (event.type === 'identified') {
          if (!d.accountDisplay || run.status !== 'awaiting_browser') return reply(409, { ok: false });
          patch.accountDisplay = d.accountDisplay;
        } else if (event.type === 'preparing') {
          if (!run.accountDisplay || !['awaiting_browser', 'preparing', 'needs_manual'].includes(run.status)) return reply(409, { ok: false });
          status = 'preparing';
        } else if (event.type === 'prepared') {
          if (!run.accountDisplay || !['preparing', 'needs_manual'].includes(run.status) || !d.checks || CHECKS.some(k => !d.checks[k])) return reply(409, { ok: false });
          status = 'awaiting_confirmation'; patch.checks = d.checks;
        } else if (event.type === 'submitted') {
          if (run.status !== 'submitting') return reply(409, { ok: false });
          status = d.workId || d.workUrl ? 'submitted' : 'awaiting_verification';
          patch = { ...(d.workId ? { workId: d.workId } : {}), ...(d.workUrl ? { workUrl: d.workUrl } : {}), ...(d.platformStatus ? { platformStatus: d.platformStatus } : {}) };
        } else if (event.type === 'awaiting_verification' || event.type === 'failed') {
          status = run.status === 'submitting' ? 'awaiting_verification' : event.type;
        } else if (event.type === 'needs_manual') {
          status = ['submitting', 'approved'].includes(run.status) ? 'awaiting_verification' : 'needs_manual';
          if (d.checks) patch.checks = d.checks;
        } else if (event.type === 'canceled') {
          status = ['submitting', 'approved'].includes(run.status) ? 'awaiting_verification' : 'canceled';
        }
        const result = this.patch(run.id, status, d.message || '已收到本次真实试验状态，请核对目标平台。', patch);
        if (TERMINAL.has(status)) res.once('finish', () => { void this.closeSession(s, status, result.items[0].detail, true); });
        reply(200, { ok: true, status });
      } catch { reply(400, { ok: false }); }
    });
  }
}
module.exports = { ChromePublisher, buildJob, parseEvent, validWorkUrl };
