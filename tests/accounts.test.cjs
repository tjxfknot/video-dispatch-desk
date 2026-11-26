'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const accounts = require('../app/core/accounts.cjs');

test('初始化后的只读快照不反复写盘', () => {
  const store = memoryStore({ schemaVersion: 1, assets: [], accounts: [], templates: [], drafts: [], runs: [] });
  accounts.ensureAccountState(store); const writes = store.updates;
  accounts.snapshotAccounts(store); accounts.snapshotAccounts(store);
  assert.equal(store.updates, writes);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function memoryStore(initial) {
  let data = structuredClone(initial);
  let updates = 0;
  return {
    load() {
      return structuredClone(data);
    },
    update(mutator) {
      const next = structuredClone(data);
      const result = mutator(next);
      if (result && typeof result.then === 'function') throw new TypeError('mutator必须同步完成');
      data = next;
      updates += 1;
      return structuredClone(data);
    },
    dump() {
      return structuredClone(data);
    },
    get updates() {
      return updates;
    }
  };
}

function legacyState() {
  return {
    schemaVersion: 1,
    assets: [{ id: 'asset-legacy', kind: 'video', name: '旧素材.mp4' }],
    accounts: [{
      id: 'legacy-account',
      platform: 'douyin',
      label: '旧账号备注',
      status: 'unconnected',
      createdAt: '2025-01-01T00:00:00.000Z',
      legacyOnly: { keep: true }
    }],
    templates: [{ id: 'template-legacy' }],
    drafts: [{ id: 'draft-legacy' }],
    runs: [{ id: 'run-legacy' }]
  };
}

function setup() {
  const store = memoryStore(legacyState());
  accounts.ensureAccountState(store);
  const t1 = accounts.saveTeacher(store, { name: '张老师' });
  const t2 = accounts.saveTeacher(store, { name: '李老师' });
  return { store, t1, t2 };
}

function addAccount(store, teacherId, label, platform = 'douyin') {
  return accounts.saveManagedAccount(store, { teacherId, platform, label });
}

function bind(store, account, connectorInstanceId, platformAccountId, options = {}) {
  return accounts.bindManagedAccount(store, {
    accountId: account.id,
    connectorInstanceId,
    platformAccountId,
    displayName: options.displayName ?? '测试展示名',
    environmentLabel: options.environmentLabel ?? '本机Chrome环境'
  }, options.now ?? '2026-01-01T00:00:00.000Z');
}

function accountFrom(store, id) {
  return store.dump().accounts.find(item => item.id === id);
}

test('旧数据补全一次后完全幂等：保留数组、旧账号与未知字段，不自动标connected', () => {
  const original = legacyState();
  const store = memoryStore(original);
  const first = accounts.ensureAccountState(store);

  assert.match(first.deviceId, UUID);
  assert.deepEqual(first.teachers, []);
  assert.deepEqual(first.environments, []);
  assert.deepEqual(store.dump().assets, original.assets);
  assert.deepEqual(store.dump().templates, original.templates);
  assert.deepEqual(store.dump().drafts, original.drafts);
  assert.deepEqual(store.dump().runs, original.runs);

  const legacy = accountFrom(store, 'legacy-account');
  assert.equal(legacy.platform, 'douyin');
  assert.equal(legacy.label, '旧账号备注');
  assert.equal(legacy.status, 'unconnected');
  assert.equal(legacy.teacherId, null);
  assert.equal(legacy.binding, null);
  assert.deepEqual(legacy.legacyOnly, { keep: true });

  const before = store.dump();
  const deviceId = first.deviceId;
  accounts.ensureAccountState(store);
  assert.deepEqual(store.dump(), before);
  assert.equal(store.dump().deviceId, deviceId);
  assert.notEqual(accountFrom(store, 'legacy-account').status, 'connected');
  assert.equal(store.dump().accounts[0].online, undefined);
});

test('ensure补全缺失数组并拒绝损坏的数据形状', () => {
  const store = memoryStore({ schemaVersion: 1 });
  const state = accounts.ensureAccountState(store);
  for (const key of ['assets', 'accounts', 'templates', 'drafts', 'runs', 'teachers', 'environments']) {
    assert(Array.isArray(state[key]), `${key}应为数组`);
  }
  assert.match(state.deviceId, UUID);

  assert.throws(() => accounts.ensureAccountState(memoryStore({ schemaVersion: 2 })), /版本/);
  assert.throws(() => accounts.ensureAccountState(memoryStore({ schemaVersion: 1, accounts: {} })), /数组/);
  assert.throws(() => accounts.ensureAccountState(memoryStore({
    schemaVersion: 1,
    accounts: [{ id: 'a', platform: 'douyin', label: 'x', status: 'bound', createdAt: '2025-01-01T00:00:00.000Z' }]
  })), /绑定/);
});

test('旧未绑定账号可以明确分配老师并保留创建时间与未知字段', () => {
  const { store, t1 } = setup();
  const before = accountFrom(store, 'legacy-account');
  assert.equal(before.teacherId, null);
  assert.equal(before.binding, null);
  assert.equal(before.status, 'unconnected');

  const assigned = accounts.saveManagedAccount(store, {
    id: 'legacy-account', teacherId: t1.id, platform: 'douyin', label: '旧账号新备注'
  });
  assert.equal(assigned.id, 'legacy-account');
  assert.equal(assigned.teacherId, t1.id);
  assert.equal(assigned.label, '旧账号新备注');
  assert.equal(assigned.createdAt, before.createdAt);
  assert.equal(assigned.status, 'unconnected');
  assert.equal(assigned.binding, null);

  const stored = accountFrom(store, 'legacy-account');
  assert.equal(stored.teacherId, t1.id);
  assert.deepEqual(stored.legacyOnly, { keep: true });

  const env = randomUUID();
  const bound = bind(store, assigned, env, 'legacy_douyin');
  assert.equal(bound.teacherId, t1.id);
  assert.equal(bound.status, 'bound');
  assert.equal(bound.createdAt, before.createdAt);
  assert.equal(accountFrom(store, 'legacy-account').legacyOnly.keep, true);
});

test('两个老师在不同环境绑定成功，快照包含契约字段且不冒充在线', () => {
  const { store, t1, t2 } = setup();
  const a1 = addAccount(store, t1.id, '张老师抖音');
  const a2 = addAccount(store, t2.id, '李老师抖音');
  const e1 = randomUUID();
  const e2 = randomUUID();

  const b1 = bind(store, a1, e1, 'zhang_douyin', {
    displayName: '张老师展示名', environmentLabel: '张老师本机Chrome', now: '2026-01-01T00:00:00.000Z'
  });
  const b2 = bind(store, a2, e2, 'li_douyin', {
    displayName: '李老师展示名', environmentLabel: '李老师本机Chrome', now: '2026-01-02T00:00:00.000Z'
  });

  assert.equal(b1.status, 'bound');
  assert.equal(b2.status, 'bound');
  assert.equal(b1.binding.environmentId, e1);
  assert.equal(b2.binding.environmentId, e2);
  assert.equal(b1.teacherId, t1.id);
  assert.equal(b2.teacherId, t2.id);
  assert.notEqual(b1.binding.platformAccountId, b2.binding.platformAccountId);

  const snapshot = accounts.snapshotAccounts(store);
  assert.deepEqual(Object.keys(snapshot).sort(), ['accounts', 'deviceId', 'environments', 'teachers']);
  assert.match(snapshot.deviceId, UUID);
  assert.equal(snapshot.environments.length, 2);

  const env1 = snapshot.environments.find(item => item.id === e1);
  assert.deepEqual(Object.keys(env1).sort(), [
    'connectorInstanceId', 'createdAt', 'deviceId', 'id', 'label', 'lastSeenAt'
  ]);
  assert.equal(env1.online, undefined);
  assert.equal(env1.teacherId, undefined);
  assert.equal(env1.label, '张老师本机Chrome');

  assert.equal(accounts.assertIdentity(store, {
    accountId: a1.id, connectorInstanceId: e1, platformAccountId: 'zhang_douyin'
  }).id, a1.id);
  assert.equal(accounts.assertIdentity(store, {
    accountId: a2.id, connectorInstanceId: e2, platformAccountId: 'li_douyin'
  }).id, a2.id);
});

test('错老师、错环境、错号都被阻止，已绑定不能直接覆盖', () => {
  const { store, t1, t2 } = setup();
  const a1 = addAccount(store, t1.id, '张老师抖音');
  const e1 = randomUUID();
  const e2 = randomUUID();
  bind(store, a1, e1, 'zhang_douyin');

  assert.throws(() => accounts.saveManagedAccount(store, {
    id: a1.id, teacherId: t2.id, platform: 'douyin', label: '换老师'
  }), /老师/);

  const a2 = addAccount(store, t2.id, '李老师抖音');
  assert.throws(() => bind(store, a2, e1, 'li_in_other_env'), /老师/);
  assert.equal(accountFrom(store, a2.id).binding, null);

  assert.throws(() => accounts.assertIdentity(store, {
    accountId: a1.id, connectorInstanceId: e2, platformAccountId: 'zhang_douyin'
  }), /环境/);
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: a1.id, connectorInstanceId: e1, platformAccountId: 'other_number'
  }), /真实账号/);

  assert.throws(() => bind(store, a1, e2, 'zhang_douyin'), /先解除/);
  assert.throws(() => bind(store, a1, e1, 'another_number'), /先解除/);
  assert.equal(accountFrom(store, a1.id).binding.environmentId, e1);
  assert.equal(accountFrom(store, a1.id).binding.platformAccountId, 'zhang_douyin');
});

test('昵称相同但真实账号ID不同，不能只按昵称核验', () => {
  const { store, t1, t2 } = setup();
  const a1 = addAccount(store, t1.id, '同名账号A');
  const a2 = addAccount(store, t2.id, '同名账号B');
  const e1 = randomUUID();
  const e2 = randomUUID();
  bind(store, a1, e1, 'douyin_alpha', { displayName: '同名展示名' });
  bind(store, a2, e2, 'douyin_beta', { displayName: '同名展示名' });

  const sameName = accounts.snapshotAccounts(store).accounts.filter(
    item => item.binding && item.binding.displayName === '同名展示名'
  );
  assert.equal(sameName.length, 2);
  assert.notEqual(sameName[0].id, sameName[1].id);
  assert.notEqual(sameName[0].binding.platformAccountId, sameName[1].binding.platformAccountId);

  assert.equal(accounts.assertIdentity(store, {
    accountId: a1.id, connectorInstanceId: e1, platformAccountId: 'douyin_alpha'
  }).id, a1.id);
  assert.equal(accounts.assertIdentity(store, {
    accountId: a2.id, connectorInstanceId: e2, platformAccountId: 'douyin_beta'
  }).id, a2.id);

  assert.throws(() => accounts.assertIdentity(store, {
    accountId: a1.id, connectorInstanceId: e1, platformAccountId: 'douyin_beta'
  }), /真实账号/);
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: a2.id, connectorInstanceId: e2, platformAccountId: 'douyin_alpha'
  }), /真实账号/);
});

test('同一个真实账号不能被两条账号重复绑定，失败不写入半成品', () => {
  const { store, t1, t2 } = setup();
  const a1 = addAccount(store, t1.id, '张老师抖音');
  const a2 = addAccount(store, t2.id, '李老师抖音');
  const e1 = randomUUID();
  const e2 = randomUUID();
  bind(store, a1, e1, 'douyin_same');

  assert.throws(() => bind(store, a2, e2, 'douyin_same'), /已绑定其他账号|重复/);
  assert.equal(accountFrom(store, a2.id).binding, null);
  assert.equal(accountFrom(store, a2.id).status, 'unconnected');
  assert.equal(accounts.snapshotAccounts(store).environments.length, 1);
  assert.equal(accounts.assertIdentity(store, {
    accountId: a1.id, connectorInstanceId: e1, platformAccountId: 'douyin_same'
  }).id, a1.id);
});

test('同一环境同平台只能一个真实号，且环境不能混用不同老师', () => {
  const { store, t1, t2 } = setup();
  const a1 = addAccount(store, t1.id, '张老师抖音1');
  const e1 = randomUUID();
  bind(store, a1, e1, 'zhang_one');

  const a2 = addAccount(store, t1.id, '张老师抖音2');
  assert.throws(() => bind(store, a2, e1, 'zhang_two'), /抖音账号/);

  const a3 = addAccount(store, t2.id, '李老师抖音');
  assert.throws(() => bind(store, a3, e1, 'li_one'), /老师/);
  assert.equal(accountFrom(store, a2.id).binding, null);
  assert.equal(accountFrom(store, a3.id).binding, null);

  accounts.unbindManagedAccount(store, a1.id);
  const a4 = addAccount(store, t2.id, '李老师抖音换绑');
  assert.throws(() => bind(store, a4, e1, 'li_two'), /老师/);
  assert.equal(accounts.snapshotAccounts(store).environments.length, 1);
});

test('未知id不创建，参数注入字段不透传，返回值不泄露凭据', () => {
  const { store, t1 } = setup();
  const missing = randomUUID();

  assert.throws(() => accounts.saveManagedAccount(store, {
    id: missing, teacherId: t1.id, platform: 'douyin', label: '未知账号'
  }), /不存在/);
  assert.throws(() => accounts.saveTeacher(store, { id: missing, name: '未知老师' }), /不存在/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: missing,
    connectorInstanceId: randomUUID(),
    platformAccountId: 'douyin_x',
    displayName: '',
    environmentLabel: ''
  }), /不存在/);
  assert.throws(() => accounts.unbindManagedAccount(store, missing), /不存在/);

  const injected = accounts.saveManagedAccount(store, {
    teacherId: t1.id,
    platform: 'douyin',
    label: '注入测试账号',
    cookie: 'secret-cookie',
    token: 'secret-token',
    status: 'connected',
    binding: { environmentId: 'fake', platformAccountId: 'fake' }
  });
  assert.equal(injected.status, 'unconnected');
  assert.equal(injected.binding, null);
  assert.equal(accountFrom(store, injected.id).cookie, undefined);
  assert.equal(accountFrom(store, injected.id).token, undefined);
  assert.equal(accountFrom(store, injected.id).binding, null);

  const env = randomUUID();
  const bound = accounts.bindManagedAccount(store, {
    accountId: injected.id,
    connectorInstanceId: env,
    platformAccountId: 'safe_account_1',
    displayName: '注入绑定',
    environmentLabel: '注入环境',
    revision: 'attacker-revision',
    verifiedAt: '1999-01-01T00:00:00.000Z',
    status: 'connected',
    cookie: 'secret-cookie-2'
  }, '2026-02-02T00:00:00.000Z');

  assert.match(bound.binding.revision, UUID);
  assert.notEqual(bound.binding.revision, 'attacker-revision');
  assert.equal(bound.binding.verifiedAt, '2026-02-02T00:00:00.000Z');
  assert.equal(bound.status, 'bound');
  assert.equal(bound.cookie, undefined);
  assert.equal(accountFrom(store, injected.id).binding.revision, bound.binding.revision);

  const serialized = JSON.stringify(accounts.snapshotAccounts(store));
  assert(!serialized.includes('secret-cookie'));
  assert(!serialized.includes('secret-token'));
  assert(!serialized.includes('attacker-revision'));
});

test('改备注保留绑定、老师、平台、创建时间和revision', () => {
  const { store, t1, t2 } = setup();
  const account = addAccount(store, t1.id, '旧备注');
  const env = randomUUID();
  const bound = bind(store, account, env, 'douyin_keep');
  const before = accountFrom(store, account.id);

  const updated = accounts.saveManagedAccount(store, {
    id: account.id,
    teacherId: t1.id,
    platform: 'douyin',
    label: '新备注',
    status: 'connected',
    binding: null,
    cookie: 'should-not-write'
  });

  assert.equal(updated.label, '新备注');
  assert.equal(updated.status, 'bound');
  assert.equal(updated.teacherId, t1.id);
  assert.equal(updated.platform, 'douyin');
  assert.equal(updated.createdAt, bound.createdAt);
  assert.deepEqual(updated.binding, bound.binding);

  const after = accountFrom(store, account.id);
  assert.deepEqual(after.binding, before.binding);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.status, 'bound');
  assert.equal(after.cookie, undefined);

  assert.throws(() => accounts.saveManagedAccount(store, {
    id: account.id, teacherId: t2.id, platform: 'douyin', label: '再换老师'
  }), /老师/);
  assert.throws(() => accounts.saveManagedAccount(store, {
    id: account.id, teacherId: t1.id, platform: 'tencent', label: '再换平台'
  }), /平台/);
  assert.equal(accountFrom(store, account.id).label, '新备注');
  assert.deepEqual(accountFrom(store, account.id).binding, before.binding);
});

test('解除绑定保留账号和环境但立即失效，重新绑定生成新revision', () => {
  const { store, t1 } = setup();
  const account = addAccount(store, t1.id, '待解除账号');
  const env = randomUUID();
  const bound = bind(store, account, env, 'douyin_rebind', { now: '2026-01-05T00:00:00.000Z' });
  const oldRevision = bound.binding.revision;
  const environmentBefore = accounts.snapshotAccounts(store).environments.find(item => item.id === env);

  const unbound = accounts.unbindManagedAccount(store, account.id);
  assert.equal(unbound.binding, null);
  assert.equal(unbound.status, 'unconnected');
  assert.equal(unbound.teacherId, t1.id);
  assert.equal(unbound.label, '待解除账号');
  assert.equal(unbound.createdAt, bound.createdAt);

  const afterUnbind = accounts.snapshotAccounts(store);
  assert(afterUnbind.accounts.some(item => item.id === account.id));
  const environmentAfter = afterUnbind.environments.find(item => item.id === env);
  assert(environmentAfter, '解除绑定不应删除浏览器环境');
  assert.equal(environmentAfter.label, environmentBefore.label);
  assert.equal(environmentAfter.createdAt, environmentBefore.createdAt);

  assert.throws(() => accounts.assertIdentity(store, {
    accountId: account.id, connectorInstanceId: env, platformAccountId: 'douyin_rebind'
  }), /尚未绑定/);

  const again = accounts.unbindManagedAccount(store, account.id);
  assert.equal(again.binding, null);
  assert.equal(again.status, 'unconnected');

  const rebound = bind(store, account, env, 'douyin_rebind', { now: '2026-03-03T00:00:00.000Z' });
  assert.equal(rebound.status, 'bound');
  assert.equal(rebound.binding.environmentId, env);
  assert.equal(rebound.binding.platformAccountId, 'douyin_rebind');
  assert.match(rebound.binding.revision, UUID);
  assert.notEqual(rebound.binding.revision, oldRevision);
  assert.equal(rebound.binding.verifiedAt, '2026-03-03T00:00:00.000Z');
  assert.equal(accounts.assertIdentity(store, {
    accountId: account.id, connectorInstanceId: env, platformAccountId: 'douyin_rebind'
  }).id, account.id);
  assert.equal(afterUnbind.environments.filter(item => item.id === env).length, 1);
});

test('相同绑定重试幂等，保留revision和核验时间', () => {
  const { store, t1 } = setup();
  const account = addAccount(store, t1.id, '幂等账号');
  const env = randomUUID();
  const first = bind(store, account, env, 'douyin_idem', { now: '2026-04-01T00:00:00.000Z' });
  const snapshot = accounts.snapshotAccounts(store);

  const second = bind(store, account, env, 'douyin_idem', {
    displayName: '另一个昵称', environmentLabel: '另一个环境名', now: '2026-04-02T00:00:00.000Z'
  });

  assert.deepEqual(second.binding, first.binding);
  assert.equal(second.binding.revision, first.binding.revision);
  assert.equal(second.binding.verifiedAt, '2026-04-01T00:00:00.000Z');
  assert.equal(second.binding.displayName, '测试展示名');
  assert.deepEqual(accounts.snapshotAccounts(store), snapshot);
});

test('只允许抖音绑定，UUID与真实账号格式、长度和未知参数均严格校验', () => {
  const { store, t1 } = setup();
  const tencent = addAccount(store, t1.id, '视频号账号', 'tencent');
  assert.throws(() => bind(store, tencent, randomUUID(), 'tencent_123'), /抖音/);

  const account = addAccount(store, t1.id, '参数校验账号');
  const validEnv = randomUUID();
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: 'not-a-uuid', platformAccountId: 'abc',
    displayName: '', environmentLabel: ''
  }), /UUID/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'ab',
    displayName: '', environmentLabel: ''
  }), /真实账号/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'a'.repeat(65),
    displayName: '', environmentLabel: ''
  }), /真实账号/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'bad id',
    displayName: '', environmentLabel: ''
  }), /真实账号/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'abc',
    displayName: '名'.repeat(121), environmentLabel: ''
  }), /显示名称/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'abc',
    displayName: '', environmentLabel: '环'.repeat(101)
  }), /环境/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'abc',
    displayName: undefined, environmentLabel: ''
  }), /显示名称/);
  assert.throws(() => accounts.bindManagedAccount(store, {
    accountId: account.id, connectorInstanceId: validEnv, platformAccountId: 'abc',
    displayName: '', environmentLabel: ''
  }, 'not-a-date'), /时间/);

  assert.equal(accountFrom(store, account.id).binding, null);
  assert.equal(accounts.snapshotAccounts(store).environments.length, 0);
});

test('老师与账号备注拒绝空值、控制字符、过长和非文本', () => {
  const { store, t1 } = setup();
  for (const name of ['', '   ', 'a'.repeat(101), '张\n老师', '张\u0000老师', null, 123]) {
    assert.throws(() => accounts.saveTeacher(store, { name }), /姓名/);
  }
  for (const label of ['', '   ', 'a'.repeat(101), '备\t注', '备\u007F注', undefined, {}]) {
    assert.throws(() => accounts.saveManagedAccount(store, {
      teacherId: t1.id, platform: 'douyin', label
    }), /备注/);
  }
  assert.throws(() => accounts.saveManagedAccount(store, {
    teacherId: t1.id, platform: 'weibo', label: '平台错误'
  }), /平台/);
  assert.throws(() => accounts.saveManagedAccount(store, {
    teacherId: randomUUID(), platform: 'douyin', label: '老师不存在'
  }), /老师/);
  assert.throws(() => accounts.saveManagedAccount(store, null), /参数/);
  assert.throws(() => accounts.saveTeacher(store, []), /参数/);
});

test('身份核验拒绝缺失参数、未知账号和错误环境设备', () => {
  const { store, t1 } = setup();
  const account = addAccount(store, t1.id, '核验账号');
  const env = randomUUID();
  bind(store, account, env, 'douyin_assert');

  assert.throws(() => accounts.assertIdentity(store, null), /参数/);
  assert.throws(() => accounts.assertIdentity(store, {}), /账号ID/);
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: randomUUID(), connectorInstanceId: env, platformAccountId: 'douyin_assert'
  }), /账号不存在/);
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: account.id, connectorInstanceId: 'bad-env', platformAccountId: 'douyin_assert'
  }), /UUID/);
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: account.id, connectorInstanceId: env, platformAccountId: '不合法 号码'
  }), /真实账号/);

  store.update(state => {
    state.environments.find(item => item.id === env).deviceId = randomUUID();
  });
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: account.id, connectorInstanceId: env, platformAccountId: 'douyin_assert'
  }), /不属于本机/);
});

test('公开快照只输出白名单字段，不泄露旧数据或注入的凭据字段', () => {
  const { store, t1 } = setup();
  const account = addAccount(store, t1.id, '脱敏账号');
  const env = randomUUID();
  bind(store, account, env, 'douyin_private');

  store.update(state => {
    state.teachers[0].token = 'secret-teacher-token';
    state.teachers[0].cookie = 'secret-teacher-cookie';
    state.environments[0].cookie = 'secret-env-cookie';
    const target = state.accounts.find(item => item.id === account.id);
    target.cookie = 'secret-account-cookie';
    target.token = 'secret-account-token';
    target.binding.token = 'secret-binding-token';
  });

  const snapshot = accounts.snapshotAccounts(store);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    'secret-teacher-token', 'secret-teacher-cookie', 'secret-env-cookie',
    'secret-account-cookie', 'secret-account-token', 'secret-binding-token'
  ]) {
    assert(!serialized.includes(secret), `快照不应包含${secret}`);
  }

  const teacher = snapshot.teachers.find(item => item.id === t1.id);
  assert.deepEqual(Object.keys(teacher).sort(), ['createdAt', 'defaultPlatforms', 'id', 'name']);
  const environment = snapshot.environments.find(item => item.id === env);
  assert.deepEqual(Object.keys(environment).sort(), [
    'connectorInstanceId', 'createdAt', 'deviceId', 'id', 'label', 'lastSeenAt'
  ]);
  const saved = snapshot.accounts.find(item => item.id === account.id);
  assert.deepEqual(Object.keys(saved).sort(), [
    'binding', 'createdAt', 'id', 'label', 'platform', 'status', 'teacherId'
  ]);
  assert.deepEqual(Object.keys(saved.binding).sort(), [
    'connectorInstanceId', 'displayName', 'environmentId', 'platformAccountId', 'revision', 'verifiedAt'
  ]);
});

test('所有导出函数返回结构化克隆，外部修改返回值不会污染store', () => {
  const { store, t1 } = setup();
  const account = addAccount(store, t1.id, '克隆测试');
  const env = randomUUID();
  const bound = bind(store, account, env, 'douyin_clone');

  bound.label = '外部篡改';
  bound.binding.platformAccountId = 'hacked';
  assert.equal(accountFrom(store, account.id).label, '克隆测试');
  assert.equal(accountFrom(store, account.id).binding.platformAccountId, 'douyin_clone');

  const snapshot = accounts.snapshotAccounts(store);
  snapshot.accounts.find(item => item.id === account.id).label = '快照篡改';
  snapshot.environments[0].label = '环境篡改';
  assert.equal(accountFrom(store, account.id).label, '克隆测试');
  assert.equal(store.dump().environments[0].label, '本机Chrome环境');

  const ensured = accounts.ensureAccountState(store);
  ensured.accounts.find(item => item.id === account.id).label = '状态篡改';
  assert.equal(accountFrom(store, account.id).label, '克隆测试');

  const teacher = accounts.saveTeacher(store, { name: '克隆老师' });
  teacher.name = '篡改老师';
  assert.equal(store.dump().teachers.find(item => item.id === teacher.id).name, '克隆老师');
});

test('老师改名保留ID和创建时间，未知ID不创建', () => {
  const { store, t1 } = setup();
  const renamed = accounts.saveTeacher(store, { id: t1.id, name: '张老师（改）' });
  assert.equal(renamed.id, t1.id);
  assert.equal(renamed.name, '张老师（改）');
  assert.equal(renamed.createdAt, t1.createdAt);
  assert.equal(store.dump().teachers.find(item => item.id === t1.id).name, '张老师（改）');

  const before = store.dump().teachers.length;
  assert.throws(() => accounts.saveTeacher(store, { id: randomUUID(), name: '无主老师' }), /不存在/);
  assert.equal(store.dump().teachers.length, before);
});

test('不同老师使用各自环境成功绑定，快照deviceId在各函数间保持一致', () => {
  const { store, t1, t2 } = setup();
  const a1 = addAccount(store, t1.id, '环境一致性A');
  const a2 = addAccount(store, t2.id, '环境一致性B');
  const e1 = randomUUID();
  const e2 = randomUUID();
  bind(store, a1, e1, 'env_consistency_a');
  bind(store, a2, e2, 'env_consistency_b');

  const snapshot = accounts.snapshotAccounts(store);
  const ensured = accounts.ensureAccountState(store);
  assert.equal(snapshot.deviceId, ensured.deviceId);
  assert.equal(snapshot.deviceId, store.dump().deviceId);
  for (const environment of ensured.environments) {
    assert.equal(environment.deviceId, snapshot.deviceId);
  }
});
