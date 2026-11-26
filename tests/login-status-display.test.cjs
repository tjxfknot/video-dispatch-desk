'use strict';
// 2026-11-11 登录误判修复：加载中不算失败；绑定信息问题不冒充“账号不一致”。
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../app/core/accounts.cjs');
const { ManagedBrowsers } = require('../app/core/managed-browser.cjs');

function setup(t) {
  let value = { schemaVersion: 1 };
  const store = { load: () => structuredClone(value), update: fn => { const next = structuredClone(value); fn(next); value = next; return structuredClone(next); } };
  model.ensureAccountState(store);
  const teacher = model.saveTeacher(store, { name: '合成甲' });
  const account = model.saveManagedAccount(store, { teacherId: teacher.id, platform: 'douyin', label: '合成测试备注' });
  let driver;
  const launch = async ({ onClosed }) => {
    let open = true;
    driver = { data: { identity: { platformAccountId: 'synthetic_1', displayName: '合成账号' }, state: 'identified' },
      read: async () => driver.nextRead ? driver.nextRead() : structuredClone(driver.data),
      focus: async () => {}, isOpen: () => open, close: async () => { open = false; onClosed(); } };
    return driver;
  };
  const manager = new ManagedBrowsers({ store, profilesRoot: '/synthetic/not-used', launch,
    availability: () => [{ id: 'chrome', available: true }], pollMs: 1_000_000 });
  t.after(() => manager.closeAll());
  return { store, account, manager, driver: () => driver, edit: fn => store.update(fn) };
}

test('已绑定账号的页面还在加载时：记为正在检查(pending)，不是“检查已停止”；且不沿用旧的核对一致', async t => {
  const { account, manager, driver } = setup(t);
  await manager.open({ accountId: account.id, browserKind: 'chrome', autoBind: true });
  assert.equal(manager.snapshot().browserChecks[account.id].state, 'verified');
  driver().nextRead = async () => ({ identity: null, state: 'checking', message: '等待页面' });
  await manager.open({ accountId: account.id });
  const check = manager.snapshot().browserChecks[account.id];
  assert.equal(manager.snapshot().browserSessions[account.id].state, 'checking');
  assert.equal(check.pending, true);
  assert.notEqual(check.state, 'verified'); // 发布执行器仍会被拦住
  assert.doesNotMatch(check.message, /停止/);
});

test('页面明确无法核验时：仍是不带pending的无法核验', async t => {
  const { account, manager, driver } = setup(t);
  await manager.open({ accountId: account.id, browserKind: 'chrome', autoBind: true });
  driver().nextRead = async () => ({ identity: null, state: 'unverifiable', message: '当前不是允许的官方页面。' });
  await manager.open({ accountId: account.id });
  const check = manager.snapshot().browserChecks[account.id];
  assert.equal(check.state, 'unverifiable'); assert.equal(check.pending, undefined);
});

test('账号号真的不同才显示“账号不一致”；设备或绑定信息问题如实说明原因', async t => {
  const { account, manager, driver, edit } = setup(t);
  await manager.open({ accountId: account.id, browserKind: 'chrome', autoBind: true });
  driver().data.identity.platformAccountId = 'synthetic_other';
  let result = await manager.inspect(account.id);
  assert.equal(result.state, 'mismatch'); assert.match(result.message, /真实账号与绑定不一致/);
  driver().data.identity.platformAccountId = 'synthetic_1';
  edit(state => { state.environments.find(e => e.id === state.accounts[0].browserEnvironmentId).deviceId = 'another-device'; });
  result = await manager.inspect(account.id);
  assert.equal(result.state, 'unverifiable');
  assert.match(result.message, /绑定信息需要处理/); assert.doesNotMatch(result.message, /真实账号与绑定不一致/);
});

test('正在检查既不能通过提前检查，也不能通过执行器的上传/提交前身份复查', async t => {
  const { account, manager, driver, store } = setup(t);
  await manager.open({ accountId: account.id, browserKind: 'chrome', autoBind: true });
  const bound = store.load().accounts.find(a => a.id === account.id);
  const job = { accountId: bound.id, teacherId: bound.teacherId, expectedBinding: { ...bound.binding } };
  driver().createPublisher = ({ verifyIdentity }) => ({ verify: verifyIdentity });
  const publisher = await manager.publisherFor(job, {});
  driver().nextRead = async () => ({ identity: null, state: 'checking', message: '等待页面' });
  assert.equal((await manager.checkReady({ accountIds: [account.id] })).ready, false);
  await assert.rejects(publisher.verify(job), /账号复查未通过/);
  assert.equal(manager.snapshot().browserChecks[account.id].pending, true);
  // 即使未来某个内部入口拼出互相矛盾的字段，pending也不能成为通行证。
  manager.inspect = async () => ({ state: 'verified', pending: true, platformAccountId: bound.binding.platformAccountId });
  assert.equal((await manager.checkReady({ accountIds: [account.id] })).ready, false);
  await assert.rejects(publisher.verify(job), /账号复查未通过/);
});
