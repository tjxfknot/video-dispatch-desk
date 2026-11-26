'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ChromeBridge, parsePayload } = require('../app/core/chrome-bridge.cjs');
const EXTENSION = `chrome-extension://${'a'.repeat(32)}`;
const observation = () => ({ pageOrigin: 'https://creator.douyin.com', pagePath: '/creator-micro/home', loginVisible: false, workspaceDetected: true,
  fields: { landscape: false, portrait: false, tags: true, declaration: false, collection: true } });
function fixture(t, options = {}) {
  const accounts = [{ id: 'one', platform: 'douyin', status: 'unconnected' }, { id: 'two', platform: 'douyin' }, { id: 'other', platform: 'tencent' }], updates = [];
  const bridge = new ChromeBridge({ findAccount: id => accounts.find(x => x.id === id), onUpdate: x => updates.push(x), ports: [0], ...options });
  t.after(() => bridge.closeAll());
  return { bridge, accounts, updates };
}
function request(record, body, options = {}) {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: record.port, path: '/pair', method: 'POST', ...options,
      headers: { Origin: EXTENSION, 'Content-Type': 'application/json', ...options.headers } }, res => {
      let result = ''; res.setEncoding('utf8'); res.on('data', part => { result += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: result }));
    });
    req.on('error', reject); req.end(serialized);
  });
}
const payload = record => ({ code: record.pairCode, observation: observation() });

test('配对仅按显式调用开始，只监听127.0.0.1；备注和平台错误时拒绝', async t => {
  const { bridge, accounts } = fixture(t);
  assert.equal(bridge.pending, null); assert.deepEqual(bridge.snapshot(), {});
  await assert.rejects(bridge.start('missing'), /抖音账号备注/);
  await assert.rejects(bridge.start('other'), /抖音账号备注/);
  const record = await bridge.start('one');
  assert.equal(bridge.pending.server.address().address, '127.0.0.1');
  assert.match(record.pairCode, /^[a-f0-9]{32}$/); assert.equal(record.ready, false);
  assert.equal(accounts[0].status, 'unconnected');
});

test('严格拒绝网页来源、Host伪装、查询参数、错误方法和内容类型；不消耗合法配对', async t => {
  const { bridge } = fixture(t); const record = await bridge.start('one');
  for (const options of [
    { headers: { Origin: 'https://creator.douyin.com' } }, { headers: { Origin: `${EXTENSION}.evil.example` } },
    { headers: { Host: `localhost:${record.port}` } }, { path: '/pair?code=bad' }, { method: 'GET' },
    { headers: { 'Content-Type': 'text/plain' } }
  ]) {
    const result = await request(record, payload(record), options);
    assert(result.status >= 400); assert(!result.body.includes(record.pairCode));
  }
  const cors = await request(record, '', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
  assert.equal(cors.status, 204); assert.equal(cors.headers['access-control-allow-origin'], EXTENSION);
  assert.equal(cors.headers['access-control-allow-credentials'], undefined);
  assert.equal((await request(record, payload(record))).status, 200);
});

test('拒绝额外字段、值类型混淆、登录信息、查询串、超大请求和错误配对码', async t => {
  const { bridge } = fixture(t); const record = await bridge.start('one');
  const bad = [
    { ...payload(record), cookies: 'must-not-store' },
    { ...payload(record), code: 'f'.repeat(32) },
    { code: record.pairCode, observation: { ...observation(), username: 'must-not-store' } },
    { code: record.pairCode, observation: { ...observation(), pageOrigin: 'https://creator.douyin.com.evil.example' } },
    { code: record.pairCode, observation: { ...observation(), pagePath: '/home?token=must-not-store' } },
    { code: record.pairCode, observation: { ...observation(), loginVisible: 'false' } },
    { code: record.pairCode, observation: { ...observation(), fields: { ...observation().fields, tags: 'yes' } } }
  ];
  for (const data of bad) assert((await request(record, data)).status >= 400);
  assert.equal((await request(record, 'x'.repeat(32769))).status, 413);
  assert(!JSON.stringify(bridge.snapshot()).includes('must-not-store'));
  assert.equal((await request(record, payload(record))).status, 200);
});

test('一次有效摘要后关闭接收器并清除码；并发重放最多成功一次，不升级身份', async t => {
  const { bridge, accounts, updates } = fixture(t); const record = await bridge.start('one');
  const responses = await Promise.allSettled([request(record, payload(record)), request(record, payload(record))]);
  assert.equal(responses.filter(x => x.status === 'fulfilled' && x.value.status === 200).length, 1);
  const result = bridge.snapshot().one;
  assert.equal(result.state, 'awaiting_identity'); assert.equal(result.source, 'chrome'); assert.equal(result.ready, false);
  assert.equal(result.fields.tags, true); assert.equal(result.pairCode, undefined); assert.equal(result.port, undefined);
  assert.equal(bridge.pending, null); assert.equal(accounts[0].status, 'unconnected');
  assert(!JSON.stringify(result).includes(record.pairCode));
  assert.equal(updates.filter(x => x.connection.state === 'awaiting_identity').length, 1);
  await assert.rejects(request(record, payload(record)), /ECONNREFUSED|ECONNRESET/);
});

test('替换、取消、过期与关闭使配对失效；关闭一个备注不取消另一备注', async t => {
  const { bridge } = fixture(t, { ttlMs: 80 });
  const old = await bridge.start('one'); const current = await bridge.start('two');
  assert.notEqual(old.pairCode, current.pairCode); assert.equal(bridge.snapshot().one.state, 'not_open');
  await assert.rejects(request(old, payload(old)), /ECONNREFUSED|ECONNRESET/);
  await bridge.stop('one'); assert.equal(bridge.pending.id, 'two');
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(bridge.pending, null); assert.equal(bridge.snapshot().two.state, 'expired');
  assert.equal(bridge.snapshot().two.pairCode, undefined);
  const canceled = await bridge.start('one'); await bridge.stop('one');
  await assert.rejects(request(canceled, payload(canceled)), /ECONNREFUSED|ECONNRESET/);
  await bridge.start('one'); await bridge.closeAll(); assert.equal(bridge.pending, null);
});

test('端口占用时尝试下一个；全部占用安全失败；登录页结果仍需用户核对标签', async t => {
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  const { bridge } = fixture(t, { ports: [port, 0] });
  const record = await bridge.start('one'); assert.notEqual(record.port, port);
  const data = payload(record); data.observation.loginVisible = true;
  assert.equal((await request(record, data)).status, 200);
  assert.equal(bridge.snapshot().one.state, 'awaiting_login');
  const blocked = fixture(t, { ports: [port] }).bridge;
  await assert.rejects(blocked.start('one'), /端口均被占用/);
  assert.equal(blocked.pending, null);
  assert.throws(() => parsePayload('{}'));
});

test('Fetch客户端能完整读取单次JSON回执，成功后不再接收连接', async t => {
  const { bridge } = fixture(t); const record = await bridge.start('one');
  const response = await fetch(`http://127.0.0.1:${record.port}/pair`, { method: 'POST',
    headers: { Origin: EXTENSION, 'Content-Type': 'application/json' }, body: JSON.stringify(payload(record)) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '11');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(bridge.snapshot().one.state, 'awaiting_identity');
  await assert.rejects(fetch(`http://127.0.0.1:${record.port}/pair`));
});
