'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const model = require('../app/core/accounts.cjs');
const { AccountBroker } = require('../app/core/account-broker.cjs');

const origin = 'chrome-extension://' + 'a'.repeat(32);
const observation = id => ({ pageOrigin: 'https://creator.douyin.com', pagePath: '/creator-micro/home', platformAccountId: id, displayName: '', source: 'visible_account_label' });
function library() {
  let value = { schemaVersion: 1, assets: [], accounts: [], templates: [], drafts: [], runs: [] };
  return { load: () => structuredClone(value), update: fn => { const next = structuredClone(value); fn(next); value = next; return structuredClone(value); } };
}
function vaultFixture() {
  const data = new Map(); return { load: () => Object.fromEntries(data), get: id => structuredClone(data.get(id) || null), set: (id, v) => { if (v === null) data.delete(id); else data.set(id, structuredClone(v)); } };
}
async function fixture(t, options = {}) {
  const store = library(), vault = vaultFixture(); model.ensureAccountState(store);
  const teachers = ['合成甲老师', '合成乙老师'].map(name => model.saveTeacher(store, { name }));
  const list = teachers.map(teacher => model.saveManagedAccount(store, { teacherId: teacher.id, platform: 'douyin', label: teacher.name }));
  const events = [], broker = new AccountBroker({ store, vault, ports: [0], onUpdate: e => events.push(e), ...options });
  t.after(() => broker.close()); await broker.listen();
  const rpc = async (route, body, token, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${broker.port}/v05/${route}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const pair = async (index, id, connectorInstanceId = randomUUID()) => {
    const p = await broker.start(list[index].id), code = p.pairCode;
    const result = await rpc('connect', { code, connectorInstanceId, observation: observation(id) });
    assert.equal(result.status, 200); return { ...result.value, connectorInstanceId, code };
  };
  return { store, vault, broker, list, events, rpc, pair };
}

test('候选身份必须由工作台确认，公开快照不含令牌且连接码只用一次', async t => {
  const f = await fixture(t); const s = await f.pair(0, 'teacher_a');
  const snapshot = f.broker.snapshot();
  assert.equal(snapshot.accounts[0].binding, null);
  assert.equal(snapshot.accountPairs[f.list[0].id].state, 'awaiting_confirmation');
  assert.equal(JSON.stringify(snapshot).includes(s.token), false); assert.equal(JSON.stringify(snapshot).includes(s.code), false);
  assert.equal((await f.rpc('connect', { code: s.code, connectorInstanceId: s.connectorInstanceId, observation: observation('teacher_a') })).status, 403);
  assert.equal((await f.rpc('poll', { connectorInstanceId: s.connectorInstanceId }, s.token)).value.state, 'pending_confirmation');
  f.broker.confirm(f.list[0].id);
  assert.equal(f.broker.snapshot().accounts[0].binding.platformAccountId, 'teacher_a');
  assert.equal((await f.rpc('poll', { connectorInstanceId: s.connectorInstanceId }, s.token)).value.state, 'connected');
});

test('两个环境各取自己的检查指令，交换令牌或错误账号不能通过', async t => {
  const f = await fixture(t); const a = await f.pair(0, 'teacher_a'), b = await f.pair(1, 'teacher_b');
  f.broker.confirm(f.list[0].id); f.broker.confirm(f.list[1].id);
  const pending = f.broker.inspect(f.list[0].id);
  const own = await f.rpc('poll', { connectorInstanceId: a.connectorInstanceId }, a.token);
  assert.equal(own.value.operation.expectedAccountId, 'teacher_a');
  assert.equal((await f.rpc('poll', { connectorInstanceId: b.connectorInstanceId }, b.token)).value.operation, null);
  assert.equal((await f.rpc('poll', { connectorInstanceId: b.connectorInstanceId }, a.token)).status, 401);
  assert.equal((await f.rpc('report', { connectorInstanceId: a.connectorInstanceId, operationId: own.value.operation.id, observation: observation('teacher_b'), error: '' }, a.token)).value.state, 'mismatch');
  assert.equal((await pending).state, 'mismatch');
  assert.equal(f.broker.snapshot().accounts[0].binding.platformAccountId, 'teacher_a');
  const second = f.broker.inspect(f.list[1].id);
  const next = (await f.rpc('poll', { connectorInstanceId: b.connectorInstanceId }, b.token)).value.operation;
  await f.rpc('report', { connectorInstanceId: b.connectorInstanceId, operationId: next.id, observation: observation('teacher_b'), error: '' }, b.token);
  assert.equal((await second).state, 'verified');
});

test('重启只恢复明确绑定，经过凭据验证的连接恢复后才在线；解除后凭据失效', async t => {
  const f = await fixture(t); const a = await f.pair(0, 'teacher_a'); f.broker.confirm(f.list[0].id);
  await f.broker.close();
  const restarted = new AccountBroker({ store: f.store, vault: f.vault, ports: [0] }); t.after(() => restarted.close()); await restarted.listen();
  assert.equal(restarted.snapshot().environments[0].online, false);
  const response = await fetch(`http://127.0.0.1:${restarted.port}/v05/poll`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` }, body: JSON.stringify({ connectorInstanceId: a.connectorInstanceId }) });
  assert.equal(response.status, 200); assert.equal(restarted.snapshot().environments[0].online, true);
  restarted.unbind(f.list[0].id);
  const revoked = await fetch(`http://127.0.0.1:${restarted.port}/v05/poll`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` }, body: JSON.stringify({ connectorInstanceId: a.connectorInstanceId }) });
  assert.equal(revoked.status, 401); assert.equal(restarted.snapshot().accounts[0].binding, null);
});

test('拒绝不明来源、额外字段、伪造身份来源和任意文件或发布接口', async t => {
  const f = await fixture(t), p = await f.broker.start(f.list[0].id), connectorInstanceId = randomUUID();
  const body = { code: p.pairCode, connectorInstanceId, observation: observation('teacher_a') };
  assert.equal((await f.rpc('connect', body, null, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await f.rpc('connect', { ...body, cookie: 'never-accept' })).status, 400);
  assert.equal((await f.rpc('connect', { ...body, observation: { ...body.observation, source: 'manual_input' } })).status, 400);
  assert.equal((await f.rpc('connect?code=hidden', body)).status, 404);
  assert.equal((await f.rpc('asset', { path: '/etc/passwd' })).status, 404);
  assert.equal((await f.rpc('publish', body)).status, 404);
});

test('候选识别后老师归属改变，确认不能把旧候选绑定给新老师', async t => {
  const f = await fixture(t), session = await f.pair(0, 'teacher_a');
  const targetTeacherId = f.store.load().accounts[1].teacherId;
  model.saveManagedAccount(f.store, { id: f.list[0].id, teacherId: targetTeacherId, platform: 'douyin', label: '已重新归属' });
  assert.throws(() => f.broker.confirm(f.list[0].id), /归属或绑定已变更/);
  assert.equal(f.vault.get(session.connectorInstanceId), null);
  assert.equal(f.broker.snapshot().accounts[0].binding, null);
});

test('连接过期、检查超时和错误页面均停止，不把已绑定当在线或已发布', async t => {
  const f = await fixture(t, { ttlMs: 20, operationMs: 20 });
  const old = await f.broker.start(f.list[0].id); await new Promise(r => setTimeout(r, 25));
  assert.equal((await f.rpc('connect', { code: old.pairCode, connectorInstanceId: randomUUID(), observation: observation('teacher_a') })).status, 403);
  const a = await f.pair(0, 'teacher_a'); f.broker.confirm(f.list[0].id);
  assert.equal((await f.broker.inspect(f.list[0].id)).state, 'unverifiable');
  assert.equal((await f.broker.inspect(f.list[1].id)).state, 'offline');
  const check = f.broker.inspect(f.list[0].id), op = (await f.rpc('poll', { connectorInstanceId: a.connectorInstanceId }, a.token)).value.operation;
  await f.rpc('report', { connectorInstanceId: a.connectorInstanceId, operationId: op.id, observation: { ...observation('teacher_a'), pageOrigin: 'https://example.com' }, error: '' }, a.token);
  assert.equal((await check).state, 'mismatch');
});
