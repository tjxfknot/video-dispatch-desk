'use strict';

// 新 ChromePublisher 的 Node 原生隔离测试。
// 只使用临时目录中的合成素材、合成账号和 127.0.0.1 回环请求；
// 不读取真实素材、浏览器、登录态、凭据或外网，也不安装任何依赖。

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  ChromePublisher,
  buildJob,
  parseEvent,
  validWorkUrl
} = require('../app/core/chrome-publisher.cjs');
const domain = require('../app/core/domain.cjs');
const { JsonStore } = require('../app/core/store.cjs');

const EXT_A = `chrome-extension://${'a'.repeat(32)}`;
const EXT_B = `chrome-extension://${'b'.repeat(32)}`;
const CHECKS = Object.freeze({
  video: true,
  covers: true,
  text: true,
  declaration: true,
  collection: true,
  schedule: true
});

async function writeSyntheticFile(dir, name, contents) {
  const filePath = path.join(dir, name);
  await fsp.writeFile(filePath, contents);
  const stat = await fsp.stat(filePath);
  return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function tempFixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chrome-publisher-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const videoFile = await writeSyntheticFile(dir, '成片.mp4', Buffer.from('video-content-0123456789'));
  const landscapeFile = await writeSyntheticFile(dir, '横版封面.png', Buffer.from('landscape-cover-content'));
  const portraitFile = await writeSyntheticFile(dir, '竖版封面.png', Buffer.from('portrait-cover-content'));

  const video = { id: randomUUID(), kind: 'video', name: '成片.mp4', ...videoFile };
  const landscape = {
    id: randomUUID(), kind: 'landscape', name: '横版封面.png',
    ...landscapeFile, width: 1600, height: 900
  };
  const portrait = {
    id: randomUUID(), kind: 'portrait', name: '竖版封面.png',
    ...portraitFile, width: 900, height: 1600
  };
  const account = {
    id: randomUUID(), platform: 'douyin', label: '隔离测试抖音账号',
    status: 'unconnected', createdAt: new Date().toISOString()
  };
  const tencentAccount = {
    id: randomUUID(), platform: 'tencent', label: '隔离测试视频号账号',
    status: 'unconnected', createdAt: new Date().toISOString()
  };

  const stateFile = path.join(dir, 'state.json');
  const store = new JsonStore(stateFile, domain.emptyState());
  store.update(state => {
    state.assets.push(video, landscape, portrait);
    state.accounts.push(account, tencentAccount);
  });

  const draft = {
    id: `draft-${randomUUID()}`,
    name: '隔离测试草稿',
    video: { id: video.id },
    covers: { landscape: { id: landscape.id }, portrait: { id: portrait.id } },
    common: { title: '隔离测试标题', description: '隔离测试描述', tags: ['测试', '隔离'] },
    targets: [{ platform: 'douyin', enabled: true, accountId: account.id, inherit: true }]
  };

  return {
    dir, stateFile, store, video, landscape, portrait,
    account, tencentAccount, draft,
    files: { video: videoFile, landscape: landscapeFile, portrait: portraitFile }
  };
}

function makePublisher(t, fixture, options = {}) {
  const publisher = new ChromePublisher({ store: fixture.store, ports: [0], ...options });
  t.after(async () => {
    try { await publisher.closeAll(); } catch {}
  });
  return publisher;
}

function newRequestId() {
  return `req-${randomUUID()}`;
}

function request(port, urlPath, options = {}) {
  const { method = 'GET', origin = EXT_A, token, body, headers = {}, host } = options;
  const hasBody = body !== undefined;
  const payload = hasBody
    ? (Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body))
    : null;

  const merged = { ...headers };
  if (host !== undefined && merged.Host === undefined) merged.Host = host;
  if (origin !== null && merged.Origin === undefined) merged.Origin = origin;
  if (token !== undefined && merged.Authorization === undefined) merged.Authorization = `Bearer ${token}`;
  if (hasBody && merged['Content-Type'] === undefined) merged['Content-Type'] = 'application/json';
  if (hasBody && merged['Content-Length'] === undefined && merged['Transfer-Encoding'] === undefined) {
    merged['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, headers: merged
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, buffer, text, json });
      });
    });
    req.on('error', reject);
    if (hasBody) req.end(payload); else req.end();
  });
}

function connect(port, code, origin = EXT_A, extra = null) {
  const body = extra ? { code, ...extra } : { code };
  return request(port, '/job/connect', { method: 'POST', origin, body });
}

function sendEvent(port, token, type, data = {}, options = {}) {
  return request(port, '/job/event', {
    method: 'POST', token, origin: options.origin ?? EXT_A, body: { type, data }
  });
}

function beginSubmit(port, token, fingerprint) {
  return request(port, '/job/begin-submit', {
    method: 'POST', token, body: { fingerprint }
  });
}

function getStatus(port, token, options = {}) {
  return request(port, '/job/status', { token, ...options });
}

async function waitUntil(check, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}

async function openConnected(t, fixture, options = {}) {
  const publisher = makePublisher(t, fixture, options);
  const requestId = newRequestId();
  const { run, session } = await publisher.start({ draft: fixture.draft, requestId });
  const connected = await connect(session.port, session.pairCode);
  assert.equal(connected.status, 200);
  return {
    publisher, requestId, run, session,
    port: session.port,
    token: connected.json.token,
    connectResponse: connected
  };
}

async function markPrepared(opened) {
  const { publisher, port, token, run } = opened;
  let response = await sendEvent(port, token, 'identified', { accountDisplay: '隔离测试抖音账号' });
  assert.equal(response.status, 200);
  response = await sendEvent(port, token, 'preparing', { message: '开始上传填写' });
  assert.equal(response.status, 200);
  response = await sendEvent(port, token, 'prepared', { message: '五项已核对', checks: { ...CHECKS } });
  assert.equal(response.status, 200);
  assert.equal(response.json.status, 'awaiting_confirmation');
  return publisher.run(run.id);
}

async function armForSubmit(t, fixture, options = {}) {
  const opened = await openConnected(t, fixture, options);
  await markPrepared(opened);
  opened.publisher.approve(opened.run.id);
  const begun = await beginSubmit(opened.port, opened.token, opened.run.fingerprint);
  assert.equal(begun.status, 200);
  assert.equal(opened.publisher.run(opened.run.id).status, 'submitting');
  return opened;
}

test('定时要求进入不可变快照；缺第六项核对不能授权发布', async t => {
  const f = await tempFixture(t);
  const at = new Date(Date.now() + 24 * 3600_000 + 8 * 3600_000).toISOString().slice(0, 16);
  f.draft.schedule = { mode: 'scheduled', at, timeZone: 'Asia/Shanghai' };
  const opened = await openConnected(t, f);
  assert.deepEqual(opened.publisher.run(opened.run.id).snapshot.schedule, f.draft.schedule);
  assert.deepEqual(buildJob(f.draft, f.store.load()).job.schedule, f.draft.schedule);
  await sendEvent(opened.port, opened.token, 'identified', { accountDisplay: '合成定时测试账号' });
  await sendEvent(opened.port, opened.token, 'preparing', {});
  const five = { ...CHECKS }; delete five.schedule;
  assert.equal((await sendEvent(opened.port, opened.token, 'prepared', { checks: five })).status, 400);
  assert.equal((await sendEvent(opened.port, opened.token, 'prepared', { checks: { ...CHECKS, schedule: false } })).status, 409);
  assert.throws(() => opened.publisher.approve(opened.run.id), /尚未完成/);
  assert.equal(opened.publisher.run(opened.run.id).status, 'preparing');
});

test('buildJob：仅单条抖音、视频与横竖封面齐全，job 不泄漏绝对路径', async t => {
  const f = await tempFixture(t);
  const state = f.store.load();
  const built = buildJob(f.draft, state);

  assert.equal(built.job.files.length, 3);
  assert.deepEqual(built.job.files.map(file => file.kind), ['video', 'landscape', 'portrait']);
  assert.deepEqual(built.job.files.map(file => file.type), ['video/mp4', 'image/png', 'image/png']);
  assert.equal(built.job.accountLabel, f.account.label);
  assert.equal(built.job.common.title, '隔离测试标题');
  assert.deepEqual(built.job.common.tags, ['测试', '隔离']);
  assert.equal(built.job.fingerprint, domain.snapshotHash(built.draft));
  assert.equal(built.job.files.some(file => Object.hasOwn(file, 'path')), false);
  assert.equal(JSON.stringify(built.job).includes(f.dir), false);

  assert.throws(
    () => buildJob({ ...f.draft, targets: [] }, state),
    /至少勾选一个平台/
  );
  assert.throws(
    () => buildJob({
      ...f.draft,
      targets: [{ platform: 'tencent', enabled: true, accountId: f.tencentAccount.id, inherit: true }]
    }, state),
    /仅支持单条抖音/
  );
  assert.throws(
    () => buildJob({
      ...f.draft,
      targets: [
        { platform: 'douyin', enabled: true, accountId: f.account.id, inherit: true },
        { platform: 'tencent', enabled: true, accountId: f.tencentAccount.id, inherit: true }
      ]
    }, state),
    /仅支持单条抖音/
  );
  assert.throws(
    () => buildJob({ ...f.draft, covers: { landscape: f.draft.covers.landscape } }, state),
    /各一份/
  );
  assert.throws(
    () => buildJob({ ...f.draft, video: null }, state),
    /请选择本地视频/
  );
});

test('buildJob：横竖封面方向错误被拒绝，正确方向通过', async t => {
  const f = await tempFixture(t);
  const state = f.store.load();

  f.store.update(current => {
    const asset = current.assets.find(item => item.id === f.landscape.id);
    asset.width = 900;
    asset.height = 1600;
  });
  assert.throws(
    () => buildJob(f.draft, f.store.load()),
    /横版封面的图片方向不符合所选用途/
  );

  f.store.update(current => {
    const asset = current.assets.find(item => item.id === f.landscape.id);
    asset.width = 1600;
    asset.height = 900;
    const portrait = current.assets.find(item => item.id === f.portrait.id);
    portrait.width = 1600;
    portrait.height = 900;
  });
  assert.throws(
    () => buildJob(f.draft, f.store.load()),
    /竖版封面的图片方向不符合所选用途/
  );

  f.store.update(current => {
    const asset = current.assets.find(item => item.id === f.portrait.id);
    asset.width = 900;
    asset.height = 1600;
  });
  assert.doesNotThrow(() => buildJob(f.draft, f.store.load()));
  assert.equal(state.assets.length, 3);
});

test('buildJob：文件 mtime 变化或素材缺失时拒绝', async t => {
  const changed = await tempFixture(t);
  const future = new Date(Date.now() + 5000);
  await fsp.utimes(changed.video.path, future, future);
  assert.throws(
    () => buildJob(changed.draft, changed.store.load()),
    /素材已变动|素材已改变/
  );

  const missing = await tempFixture(t);
  await fsp.unlink(missing.portrait.path);
  assert.throws(
    () => buildJob(missing.draft, missing.store.load()),
    /素材不存在|无法读取|素材已变动|素材已改变/
  );
});

test('buildJob：视频超过 512MiB、单张封面超过 20MiB 时拒绝', async t => {
  const bigVideo = await tempFixture(t);
  const videoLimit = 512 * 1024 * 1024;
  await fsp.truncate(bigVideo.video.path, videoLimit + 1);
  const videoStat = await fsp.stat(bigVideo.video.path);
  bigVideo.store.update(current => {
    const asset = current.assets.find(item => item.id === bigVideo.video.id);
    asset.size = videoStat.size;
    asset.mtimeMs = videoStat.mtimeMs;
  });
  assert.throws(() => buildJob(bigVideo.draft, bigVideo.store.load()), /512MB/);

  const bigCover = await tempFixture(t);
  const coverLimit = 20 * 1024 * 1024;
  await fsp.truncate(bigCover.landscape.path, coverLimit + 1);
  const coverStat = await fsp.stat(bigCover.landscape.path);
  bigCover.store.update(current => {
    const asset = current.assets.find(item => item.id === bigCover.landscape.id);
    asset.size = coverStat.size;
    asset.mtimeMs = coverStat.mtimeMs;
  });
  assert.throws(() => buildJob(bigCover.draft, bigCover.store.load()), /20MB/);
});

test('parseEvent：作品 ID/URL 与 checks 的严格类型校验', () => {
  assert.throws(
    () => parseEvent(JSON.stringify({ type: 'submitted', data: { workId: 1234567890123 } })),
    /Invalid work id/
  );
  assert.throws(
    () => parseEvent(JSON.stringify({ type: 'submitted', data: { workUrl: 1234567890123 } })),
    /Invalid work URL/
  );
  assert.throws(
    () => parseEvent(JSON.stringify({
      type: 'identified', data: { accountDisplay: '账号', checks: null }
    })),
    /Invalid checks/
  );
  assert.throws(
    () => parseEvent(JSON.stringify({
      type: 'identified',
      data: { accountDisplay: '账号', checks: { video: true, covers: true, text: true, declaration: true } }
    })),
    /Invalid checks/
  );
  assert.throws(
    () => parseEvent(JSON.stringify({ type: 'submitted', data: { workId: '1234567890123', extra: 1 } })),
    /Invalid data/
  );
  assert.throws(
    () => parseEvent(JSON.stringify({ type: 'published', data: {} })),
    /Invalid event/
  );
  assert.throws(
    () => parseEvent(JSON.stringify({
      type: 'identified', data: { accountDisplay: '账号', checks: false }
    })),
    /Invalid checks/
  );

  assert.equal(validWorkUrl('https://www.douyin.com/video/1234567890123'), true);
  assert.equal(validWorkUrl('https://douyin.com/video/1234567890123'), true);
  assert.equal(validWorkUrl('https://www.douyin.com/video/1234567890123?from=test'), false);
  assert.equal(validWorkUrl('https://www.douyin.com.evil.example/video/1234567890123'), false);
  assert.equal(validWorkUrl(1234567890123), false);

  const parsed = parseEvent(JSON.stringify({
    type: 'submitted',
    data: {
      workId: '1234567890123',
      workUrl: 'https://www.douyin.com/video/1234567890123',
      platformStatus: '审核中'
    }
  }));
  assert.equal(parsed.data.workId, '1234567890123');
  assert.equal(parsed.data.workUrl, 'https://www.douyin.com/video/1234567890123');
});

test('start：只监听 127.0.0.1；同 requestId 同快照复用，改快照拒绝', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const requestId = newRequestId();

  const first = await publisher.start({ draft: f.draft, requestId });
  assert.equal(publisher.current.server.address().address, '127.0.0.1');
  assert.equal(first.run.status, 'awaiting_browser');
  assert.match(first.session.pairCode, /^[a-f0-9]{32}$/);
  assert.ok(first.session.port > 0);
  assert.ok(Date.parse(first.session.expiresAt) > Date.now());
  assert.equal(f.store.load().runs.length, 1);

  const second = await publisher.start({
    draft: { ...f.draft, id: 'metadata-only-change', name: '仅改元数据' },
    requestId
  });
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.session.runId, first.run.id);
  assert.equal(second.session.pairCode, first.session.pairCode);
  assert.equal(f.store.load().runs.length, 1);

  await assert.rejects(
    publisher.start({
      draft: { ...f.draft, common: { ...f.draft.common, title: '改变后的标题' } },
      requestId
    }),
    /配置发生变化/
  );
  assert.equal(f.store.load().runs.length, 1);
  assert.equal(publisher.run(first.run.id).status, 'awaiting_browser');
});

test('start：同一时间只允许一个活动任务；停止后可新建', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);

  const first = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  await assert.rejects(
    publisher.start({ draft: f.draft, requestId: newRequestId() }),
    /已有真实试验尚未结束/
  );
  assert.equal(f.store.load().runs.length, 1);

  const stopped = await publisher.stop(first.run.id);
  assert.equal(stopped.status, 'canceled');
  assert.equal(publisher.hasActiveSession(), false);

  const second = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(publisher.hasActiveSession(), true);
});

test('start：端口占用时尝试下一个；全部占用时安全失败', async t => {
  const occupied = http.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const occupiedPort = occupied.address().port;

  const f = await tempFixture(t);
  const publisher = makePublisher(t, f, { ports: [occupiedPort, 0] });
  const started = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  assert.notEqual(started.session.port, occupiedPort);
  assert.equal(publisher.current.server.address().address, '127.0.0.1');

  const blockedFixture = await tempFixture(t);
  const blocked = makePublisher(t, blockedFixture, { ports: [occupiedPort] });
  await assert.rejects(
    blocked.start({ draft: blockedFixture.draft, requestId: newRequestId() }),
    /端口已占用/
  );
  assert.equal(blocked.hasActiveSession(), false);
  assert.equal(blockedFixture.store.load().runs.length, 0);
});

test('HTTP：严格拒绝 Host 伪装、非扩展 Origin、查询串、未知路径和错误方法', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const { session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;

  const badBeforeConnect = [
    ['Host 伪装', '/job/connect', { method: 'POST', host: `localhost:${port}`, body: { code: session.pairCode } }],
    ['网页 Origin', '/job/connect', { method: 'POST', origin: 'https://creator.douyin.com', body: { code: session.pairCode } }],
    ['缺少 Origin', '/job/connect', { method: 'POST', origin: null, body: { code: session.pairCode } }],
    ['非法扩展 ID', '/job/connect', {
      method: 'POST', origin: `chrome-extension://${'q'.repeat(32)}`, body: { code: session.pairCode }
    }],
    ['查询串', '/job/connect?x=1', { method: 'POST', body: { code: session.pairCode } }],
    ['未知路径', '/job/not-allowed', { method: 'POST', body: { code: session.pairCode } }],
    ['目录穿越', '/job/asset/../../etc/passwd', { method: 'GET' }],
    ['GET connect', '/job/connect', { method: 'GET' }]
  ];
  for (const [name, urlPath, options] of badBeforeConnect) {
    const response = await request(port, urlPath, options);
    assert.ok(response.status >= 400, name);
    assert.equal(response.text.includes(session.pairCode), false, name);
  }

  const preflight = await request(port, '/job/event', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Authorization'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], EXT_A);
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);

  const badPreflight = await request(port, '/job/event', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'X-Not-Allowed'
    }
  });
  assert.equal(badPreflight.status, 403);

  const connected = await connect(port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  const badAfterConnect = [
    ['PUT event', '/job/event', { method: 'PUT', token, body: { type: 'preparing', data: {} } }],
    ['POST status', '/job/status', { method: 'POST', token, body: {} }],
    ['GET begin-submit', '/job/begin-submit', { method: 'GET', token }],
    ['POST asset', `/job/asset/${f.video.id}`, { method: 'POST', token, body: {} }],
    ['错误 Content-Type', '/job/event', {
      method: 'POST', token, headers: { 'Content-Type': 'text/plain' },
      body: { type: 'preparing', data: {} }
    }]
  ];
  for (const [name, urlPath, options] of badAfterConnect) {
    const response = await request(port, urlPath, options);
    assert.ok(response.status >= 400, name);
  }

  const status = await getStatus(port, token);
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { ok: true, status: 'awaiting_browser', approved: false });
});

test('HTTP：拒绝 JSON 未知字段，并执行 32KiB 字节上限', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const { run, session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;

  const unknownConnect = await connect(port, session.pairCode, EXT_A, { extra: true });
  assert.equal(unknownConnect.status, 403);

  const connected = await connect(port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  let response = await request(port, '/job/event', {
    method: 'POST', token,
    body: { type: 'identified', data: { accountDisplay: '隔离账号' }, extra: true }
  });
  assert.equal(response.status, 400);

  response = await request(port, '/job/event', {
    method: 'POST', token,
    body: { type: 'identified', data: { accountDisplay: '隔离账号', cookie: 'must-not-store' } }
  });
  assert.equal(response.status, 400);
  assert.equal(f.store.load().runs[0].accountDisplay, undefined);

  response = await request(port, '/job/begin-submit', {
    method: 'POST', token,
    body: { fingerprint: run.fingerprint, extra: true }
  });
  assert.equal(response.status, 409);

  response = await sendEvent(port, token, 'identified', { accountDisplay: '隔离账号' });
  assert.equal(response.status, 200);

  const tooLarge = 'x'.repeat(32769);
  response = await request(port, '/job/event', {
    method: 'POST', token, body: tooLarge,
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(response.status, 413);

  response = await request(port, '/job/event', {
    method: 'POST', token, body: tooLarge,
    headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }
  });
  assert.equal(response.status, 413);

  response = await request(port, '/job/event', {
    method: 'POST', token, body: ' '.repeat(32768),
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(response.status, 400);

  const status = await getStatus(port, token);
  assert.equal(status.status, 200);
  assert.equal(status.json.status, 'awaiting_browser');
});

test('connect：任务码一次使用，token 绑定首个扩展 Origin，不能串用', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const { run, session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;

  const first = await connect(port, session.pairCode, EXT_A);
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.match(first.json.token, /^[a-f0-9]{32}$/);
  assert.equal(first.json.job.runId, run.id);
  assert.equal(first.json.job.files.length, 3);
  assert.equal(JSON.stringify(first.json.job).includes(f.dir), false);
  assert.equal(JSON.stringify(first.json).includes(session.pairCode), false);

  const replay = await connect(port, session.pairCode, EXT_B);
  assert.equal(replay.status, 403);

  const otherOrigin = await getStatus(port, first.json.token, { origin: EXT_B });
  assert.equal(otherOrigin.status, 403);

  const sameOrigin = await getStatus(port, first.json.token, { origin: EXT_A });
  assert.equal(sameOrigin.status, 200);
  assert.deepEqual(sameOrigin.json, { ok: true, status: 'awaiting_browser', approved: false });

  const reuse = await connect(port, session.pairCode, EXT_A);
  assert.equal(reuse.status, 403);

  const noToken = await request(port, '/job/status', { origin: EXT_A });
  assert.equal(noToken.status, 403);
});

test('资产：仅本任务三个文件可读；未知 ID、目录穿越、文件变化拒绝；完整流字节一致', async t => {
  const f = await tempFixture(t);

  const extraFile = await writeSyntheticFile(f.dir, '额外素材.mp4', Buffer.from('extra-asset'));
  const extraId = randomUUID();
  f.store.update(state => {
    state.assets.push({ id: extraId, kind: 'video', name: '额外素材.mp4', ...extraFile });
  });

  const publisher = makePublisher(t, f);
  const { session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;
  const connected = await connect(port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  const videoResponse = await request(port, `/job/asset/${f.video.id}`, { token });
  assert.equal(videoResponse.status, 200);
  assert.equal(videoResponse.headers['content-type'], 'video/mp4');
  assert.equal(videoResponse.headers['content-length'], String(f.video.size));
  assert.equal(videoResponse.headers['cache-control'], 'no-store');
  assert.deepEqual(videoResponse.buffer, await fsp.readFile(f.video.path));

  for (const [asset, mime] of [[f.landscape, 'image/png'], [f.portrait, 'image/png']]) {
    const response = await request(port, `/job/asset/${asset.id}`, { token });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], mime);
    assert.deepEqual(response.buffer, await fsp.readFile(asset.path));
  }

  const unknown = await request(port, `/job/asset/${randomUUID()}`, { token });
  assert.equal(unknown.status, 404);

  const notRegisteredInTask = await request(port, `/job/asset/${extraId}`, { token });
  assert.equal(notRegisteredInTask.status, 404);

  const traversal = await request(port, '/job/asset/..%2F..%2Fetc%2Fpasswd', { token });
  assert.equal(traversal.status, 403);

  const noToken = await request(port, `/job/asset/${f.video.id}`, { origin: EXT_A });
  assert.equal(noToken.status, 403);

  const changedTime = new Date(Date.now() + 5000);
  await fsp.utimes(f.landscape.path, changedTime, changedTime);
  const changedMtime = await request(port, `/job/asset/${f.landscape.id}`, { token });
  assert.equal(changedMtime.status, 409);
  assert.match(changedMtime.json.message, /素材已改变/);
  assert.equal(publisher.run(session.runId).status, 'failed');
  await waitUntil(() => !publisher.hasActiveSession());
});

test('资产：大小变化终止任务；已获提交许可时保留待核查', async t => {
  for (const afterSubmit of [false, true]) {
    const f = await tempFixture(t);
    const opened = afterSubmit ? await armForSubmit(t, f) : await openConnected(t, f);
    await fsp.appendFile(f.video.path, Buffer.from('x'));
    const changedSize = await request(opened.port, `/job/asset/${f.video.id}`, { token: opened.token });
  assert.equal(changedSize.status, 409);
  assert.match(changedSize.json.message, /素材已改变/);
    assert.equal(opened.publisher.run(opened.run.id).status, afterSubmit ? 'awaiting_verification' : 'failed');
    await waitUntil(() => !opened.publisher.hasActiveSession());
  }
});

test('确认闸门：缺账号、缺五 checks 不进入确认，approve 过早拒绝', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const { run, session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;
  const connected = await connect(port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  assert.throws(() => publisher.approve(run.id), /尚未完成本条真实填写与核对/);

  let response = await sendEvent(port, token, 'preparing', { message: '未识别账号' });
  assert.equal(response.status, 409);

  response = await sendEvent(port, token, 'identified', {});
  assert.equal(response.status, 409);

  response = await sendEvent(port, token, 'identified', { accountDisplay: '隔离测试抖音账号' });
  assert.equal(response.status, 200);

  response = await sendEvent(port, token, 'preparing', { message: '开始上传填写' });
  assert.equal(response.status, 200);
  assert.equal(publisher.run(run.id).status, 'preparing');

  response = await sendEvent(port, token, 'prepared', { message: '没有 checks' });
  assert.equal(response.status, 409);

  response = await sendEvent(port, token, 'prepared', {
    message: '一项为 false',
    checks: { ...CHECKS, collection: false }
  });
  assert.equal(response.status, 409);

  response = await sendEvent(port, token, 'prepared', {
    message: '只有四项',
    checks: { video: true, covers: true, text: true, declaration: true }
  });
  assert.equal(response.status, 400);

  assert.equal(publisher.run(run.id).status, 'preparing');
  assert.throws(() => publisher.approve(run.id), /尚未完成本条真实填写与核对/);

  response = await sendEvent(port, token, 'prepared', {
    message: '五项均已核对',
    checks: { ...CHECKS }
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.status, 'awaiting_confirmation');

  const ready = publisher.run(run.id);
  assert.equal(ready.status, 'awaiting_confirmation');
  assert.deepEqual(ready.checks, CHECKS);
  assert.equal(ready.accountDisplay, '隔离测试抖音账号');

  const approved = publisher.approve(run.id);
  assert.equal(approved.status, 'approved');
  assert.equal(publisher.run(run.id).status, 'approved');
});

test('prepared：账号未识别时即使五 checks 全真也不能进入确认', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const { run, session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;
  const connected = await connect(port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  let response = await sendEvent(port, token, 'needs_manual', { message: '无法识别当前账号' });
  assert.equal(response.status, 200);
  assert.equal(response.json.status, 'needs_manual');

  response = await sendEvent(port, token, 'prepared', {
    message: '五项为真但没有账号',
    checks: { ...CHECKS }
  });
  assert.equal(response.status, 409);
  assert.equal(publisher.run(run.id).status, 'needs_manual');
  assert.throws(() => publisher.approve(run.id), /尚未完成本条真实填写与核对/);
});

test('完整流：prepared→approve→begin-submit→submitted，begin-submit 最多一次且先持久化', async t => {
  const f = await tempFixture(t);
  let persistedBeforeReply = false;
  const publisher = makePublisher(t, f, {
    onUpdate: event => {
      if (event.type !== 'run' || event.run.status !== 'submitting') return;
      const stored = f.store.load().runs.find(item => item.id === event.run.id);
      if (stored?.status === 'submitting') persistedBeforeReply = true;
    }
  });
  const { run, session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });
  const port = session.port;
  const connected = await connect(port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  let response = await beginSubmit(port, token, run.fingerprint);
  assert.equal(response.status, 409);

  const ready = await markPrepared({ publisher, port, token, run });
  assert.equal(ready.status, 'awaiting_confirmation');

  response = await getStatus(port, token);
  assert.deepEqual(response.json, { ok: true, status: 'awaiting_confirmation', approved: false });

  publisher.approve(run.id);
  response = await getStatus(port, token);
  assert.deepEqual(response.json, { ok: true, status: 'approved', approved: true });

  const wrongFingerprint = await beginSubmit(port, token, 'f'.repeat(64));
  assert.equal(wrongFingerprint.status, 409);
  assert.equal(publisher.run(run.id).status, 'approved');

  const first = await beginSubmit(port, token, run.fingerprint);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true, submitOnce: true });
  assert.equal(publisher.run(run.id).status, 'submitting');
  assert.equal(persistedBeforeReply, true);

  const second = await beginSubmit(port, token, run.fingerprint);
  assert.equal(second.status, 409);
  assert.equal(publisher.run(run.id).status, 'submitting');

  response = await sendEvent(port, token, 'submitted', {
    message: '已提交，等待平台审核',
    workId: '1234567890123',
    workUrl: 'https://www.douyin.com/video/1234567890123',
    platformStatus: '审核中'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, status: 'submitted' });

  const submitted = publisher.run(run.id);
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.workId, '1234567890123');
  assert.equal(submitted.workUrl, 'https://www.douyin.com/video/1234567890123');
  assert.equal(submitted.platformStatus, '审核中');
  assert.equal(submitted.items[0].status, 'submitted');
  assert.match(submitted.items[0].detail, /已提交/);
  const report = domain.exportReport(submitted);
  assert.equal(report.accountDisplay, submitted.accountDisplay);
  assert.deepEqual(report.checks, CHECKS);
  assert.equal(report.workUrl, submitted.workUrl);
  assert.equal(report.workId, submitted.workId);
  assert.equal(report.platformStatus, '审核中');

  await waitUntil(() => publisher.snapshot()[run.id]?.state === 'submitted');
  assert.equal(publisher.hasActiveSession(), false);

  await assert.rejects(
    publisher.start({ draft: f.draft, requestId: newRequestId() }),
    /相同视频已有提交或待核查/
  );
});

test('submitted：没有作品 ID/URL 时进入待核查，不冒充已发布', async t => {
  const f = await tempFixture(t);
  const opened = await armForSubmit(t, f);

  const response = await sendEvent(opened.port, opened.token, 'submitted', {
    message: '上传完成但未取得作品标识'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, status: 'awaiting_verification' });

  const run = opened.publisher.run(opened.run.id);
  assert.equal(run.status, 'awaiting_verification');
  assert.equal(run.workId, undefined);
  assert.equal(run.workUrl, undefined);
  await waitUntil(() => opened.publisher.snapshot()[opened.run.id]?.state === 'awaiting_verification');
});

test('失败：submitting 收到 failed 变待核查，拒绝新任务自动重发', async t => {
  const f = await tempFixture(t);
  const opened = await armForSubmit(t, f);

  const response = await sendEvent(opened.port, opened.token, 'failed', { message: '平台返回失败' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, status: 'awaiting_verification' });

  const run = opened.publisher.run(opened.run.id);
  assert.equal(run.status, 'awaiting_verification');
  assert.equal(run.items[0].status, 'awaiting_verification');
  assert.equal(run.events.at(-1).message, '平台返回失败');
  await waitUntil(() => opened.publisher.snapshot()[opened.run.id]?.state === 'awaiting_verification');
  assert.equal(opened.publisher.hasActiveSession(), false);

  await assert.rejects(
    opened.publisher.start({ draft: f.draft, requestId: newRequestId() }),
    /相同视频已有提交或待核查/
  );
});

test('关闭：submitting 时 closeAll 变待核查，不自动续传或重发', async t => {
  const f = await tempFixture(t);
  const opened = await armForSubmit(t, f);

  await opened.publisher.closeAll();
  const run = opened.publisher.run(opened.run.id);
  assert.equal(run.status, 'awaiting_verification');
  assert.equal(run.items[0].status, 'awaiting_verification');
  assert.match(run.items[0].detail, /核对平台记录/);
  assert.equal(opened.publisher.hasActiveSession(), false);

  await assert.rejects(
    opened.publisher.start({ draft: f.draft, requestId: newRequestId() }),
    /相同视频已有提交或待核查/
  );
});

test('重启：持久化的 submitting/approved 恢复为待核查，preparing 转为需人工，不自动续传', async t => {
  const f = await tempFixture(t);
  const now = new Date().toISOString();
  const makeRun = (status, requestId) => ({
    id: randomUUID(),
    mode: 'chrome_prepare',
    requestId,
    fingerprint: 'f'.repeat(64),
    createdAt: now,
    updatedAt: now,
    status,
    snapshot: {
      video: { path: f.video.path, size: f.video.size, mtimeMs: f.video.mtimeMs }
    },
    summary: [],
    items: [{
      id: randomUUID(), platform: 'douyin', accountId: f.account.id,
      status, detail: '旧状态'
    }],
    events: []
  });
  const submitting = makeRun('submitting', newRequestId());
  const approved = makeRun('approved', newRequestId());
  const preparing = makeRun('preparing', newRequestId());
  f.store.update(state => { state.runs.push(submitting, approved, preparing); });

  const restarted = makePublisher(t, f);
  assert.equal(restarted.run(submitting.id).status, 'awaiting_verification');
  assert.equal(restarted.run(submitting.id).items[0].status, 'awaiting_verification');
  assert.match(restarted.run(submitting.id).items[0].detail, /程序已重启/);
  assert.equal(restarted.run(approved.id).status, 'awaiting_verification');
  assert.equal(restarted.run(preparing.id).status, 'needs_manual');
  assert.match(restarted.run(preparing.id).items[0].detail, /程序已重启/);
  assert.equal(restarted.hasActiveSession(), false);

  await assert.rejects(
    restarted.start({ draft: f.draft, requestId: newRequestId() }),
    /相同视频已有提交或待核查/
  );
  assert.equal(f.store.load().runs.length, 3);
});

test('重复视频：已有 submitted/awaiting_verification 记录拒绝新任务，换视频可建', async t => {
  const f = await tempFixture(t);
  const now = new Date().toISOString();
  const existing = {
    id: randomUUID(),
    mode: 'chrome_prepare',
    requestId: newRequestId(),
    fingerprint: 'e'.repeat(64),
    createdAt: now,
    updatedAt: now,
    status: 'awaiting_verification',
    snapshot: {
      video: { path: f.video.path, size: f.video.size, mtimeMs: f.video.mtimeMs }
    },
    summary: [],
    items: [{
      id: randomUUID(), platform: 'douyin', accountId: f.account.id,
      status: 'awaiting_verification', detail: '等待核对平台记录'
    }],
    events: []
  };
  f.store.update(state => { state.runs.push(existing); });

  const publisher = makePublisher(t, f);
  for (const status of ['awaiting_verification', 'submitted']) {
    f.store.update(state => { state.runs[0].status = status; });
    await assert.rejects(
      publisher.start({ draft: f.draft, requestId: newRequestId() }),
      /相同视频已有提交或待核查/
    );
    assert.equal(f.store.load().runs.length, 1);
  }

  f.store.update(state => { state.runs[0].status = 'failed'; });
  const otherFile = await writeSyntheticFile(f.dir, '另一条成片.mp4', Buffer.from('another-video'));
  const otherVideo = { id: randomUUID(), kind: 'video', name: '另一条成片.mp4', ...otherFile };
  f.store.update(state => { state.assets.push(otherVideo); });

  const started = await publisher.start({
    draft: { ...f.draft, video: { id: otherVideo.id } },
    requestId: newRequestId()
  });
  assert.equal(started.run.status, 'awaiting_browser');
  assert.equal(f.store.load().runs.length, 2);
});

test('秘密：任务码与 token 不进入业务 store、run 或导出报告', async t => {
  const f = await tempFixture(t);
  const publisher = makePublisher(t, f);
  const { run, session } = await publisher.start({ draft: f.draft, requestId: newRequestId() });

  let disk = await fsp.readFile(f.stateFile, 'utf8');
  assert.equal(disk.includes(session.pairCode), false);

  const connected = await connect(session.port, session.pairCode);
  assert.equal(connected.status, 200);
  const token = connected.json.token;

  disk = await fsp.readFile(f.stateFile, 'utf8');
  assert.equal(disk.includes(session.pairCode), false);
  assert.equal(disk.includes(token), false);

  const storedRun = f.store.load().runs.find(item => item.id === run.id);
  assert.equal(JSON.stringify(storedRun).includes(session.pairCode), false);
  assert.equal(JSON.stringify(storedRun).includes(token), false);

  const report = JSON.stringify(domain.exportReport(storedRun));
  assert.equal(report.includes(session.pairCode), false);
  assert.equal(report.includes(token), false);

  const live = JSON.stringify(publisher.snapshot());
  assert.equal(live.includes(session.pairCode), false);
  assert.equal(live.includes(token), false);
});

test('作品标识：HTTP 层拒绝非法 workUrl/workId，合法字符串回执被保留', async t => {
  const f = await tempFixture(t);
  const opened = await armForSubmit(t, f);

  const bad = [
    ['workUrl 非抖音域', { workId: '1234567890123', workUrl: 'https://evil.example/video/1234567890123' }],
    ['workUrl 非 https', { workUrl: 'http://www.douyin.com/video/1234567890123' }],
    ['workUrl 类型错误', { workUrl: 1234567890123 }],
    ['workId 类型错误', { workId: 1234567890123 }],
    ['workId 非数字', { workId: 'not-a-number' }],
    ['workUrl 带查询串', { workUrl: 'https://www.douyin.com/video/1234567890123?from=test' }],
    ['workUrl 与 workId 不匹配', {
      workId: '1234567890123',
      workUrl: 'https://www.douyin.com/video/9999999999999'
    }]
  ];
  for (const [name, data] of bad) {
    const response = await sendEvent(opened.port, opened.token, 'submitted', data);
    assert.equal(response.status, 400, name);
    assert.equal(opened.publisher.run(opened.run.id).status, 'submitting', name);
  }

  const accepted = await sendEvent(opened.port, opened.token, 'submitted', {
    workId: '1234567890123',
    workUrl: 'https://www.douyin.com/video/1234567890123',
    platformStatus: '审核中'
  });
  assert.equal(accepted.status, 200);
  const run = opened.publisher.run(opened.run.id);
  assert.equal(run.status, 'submitted');
  assert.equal(run.workId, '1234567890123');
  assert.equal(run.workUrl, 'https://www.douyin.com/video/1234567890123');
});
