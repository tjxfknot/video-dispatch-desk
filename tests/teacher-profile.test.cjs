'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const accounts = require('../app/core/accounts.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2025-01-01T00:00:00.000Z';

function memoryStore(initial) {
  let data = structuredClone(initial);
  let updates = 0;
  let updating = false;
  return {
    load() {
      return structuredClone(data);
    },
    update(mutator) {
      if (updating) throw new Error('不允许嵌套写盘');
      updating = true;
      const next = structuredClone(data);
      try {
        const result = mutator(next);
        if (result && typeof result.then === 'function') throw new TypeError('mutator必须同步完成');
        data = next;
        updates += 1;
        return structuredClone(data);
      } finally {
        updating = false;
      }
    },
    dump() {
      return structuredClone(data);
    },
    get updates() {
      return updates;
    }
  };
}

function emptyState(overrides = {}) {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    assets: [],
    accounts: [],
    templates: [],
    drafts: [],
    runs: [],
    teachers: [],
    environments: [],
    ...overrides
  };
}

function legacyTeacherState() {
  return emptyState({
    assets: [{ id: 'asset-legacy', kind: 'video', name: '旧素材.mp4' }],
    templates: [{ id: 'template-legacy' }],
    drafts: [{ id: 'draft-legacy' }],
    runs: [{ id: 'run-legacy' }],
    teachers: [{
      id: 'teacher-legacy',
      name: '旧老师',
      createdAt: CREATED_AT,
      legacyTeacherField: { keep: true }
    }]
  });
}

function teacherRecord(store, id) {
  return store.dump().teachers.find(item => item.id === id);
}

function accountRecord(store, id) {
  return store.dump().accounts.find(item => item.id === id);
}

function assertRejected(store, action, pattern) {
  const before = store.dump();
  const writes = store.updates;
  assert.throws(action, pattern);
  assert.equal(store.updates, writes, '失败时不应写盘');
  assert.deepEqual(store.dump(), before, '失败时应整体保持原状');
}

function createdAccount(store, teacherId, platform, label) {
  return accounts.saveManagedAccount(store, { teacherId, platform, label });
}

test('旧老师缺少 defaultPlatforms 时迁移为 []，只写一次且幂等', () => {
  const store = memoryStore(legacyTeacherState());
  const first = accounts.ensureAccountState(store);

  assert.deepEqual(first.teachers[0].defaultPlatforms, []);
  assert.equal(store.updates, 1);
  assert.deepEqual(teacherRecord(store, 'teacher-legacy').legacyTeacherField, { keep: true });

  const before = store.dump();
  accounts.ensureAccountState(store);
  accounts.snapshotAccounts(store);
  accounts.snapshotAccounts(store);
  assert.equal(store.updates, 1);
  assert.deepEqual(store.dump(), before);
});

test('既有 defaultPlatforms 非法时拒绝加载，不静默纠正也不写盘', () => {
  const invalidValues = [
    'douyin',
    null,
    {},
    ['weibo'],
    ['douyin', 'douyin'],
    ['douyin', 'tencent', 'xiaohongshu', 'weibo'],
    ['douyin', 1]
  ];
  for (const defaultPlatforms of invalidValues) {
    const state = legacyTeacherState();
    state.teachers[0].defaultPlatforms = defaultPlatforms;
    const store = memoryStore(state);
    assertRejected(store, () => accounts.ensureAccountState(store), /默认平台|重复|最多3/);
    assert.deepEqual(teacherRecord(store, 'teacher-legacy').defaultPlatforms, defaultPlatforms);
  }
});

test('saveTeacher 新建未传默认值为 []，更新未传保留，显式传入才替换', () => {
  const store = memoryStore(emptyState());
  const created = accounts.saveTeacher(store, { name: '张老师' });
  assert.match(created.id, UUID);
  assert.deepEqual(created.defaultPlatforms, []);
  assert.equal(store.updates, 1);

  const renamed = accounts.saveTeacher(store, { id: created.id, name: '张老师（改）' });
  assert.deepEqual(renamed.defaultPlatforms, []);
  assert.equal(renamed.createdAt, created.createdAt);

  const configured = accounts.saveTeacher(store, {
    id: created.id,
    name: '张老师（改）',
    defaultPlatforms: ['xiaohongshu', 'douyin']
  });
  assert.deepEqual(configured.defaultPlatforms, ['xiaohongshu', 'douyin']);
  assert.equal(configured.createdAt, created.createdAt);
  assert.equal(store.dump().accounts.length, 0, 'saveTeacher 不创建账号');

  const preserved = accounts.saveTeacher(store, { id: created.id, name: '张老师（再改）' });
  assert.deepEqual(preserved.defaultPlatforms, ['xiaohongshu', 'douyin']);
  assert.deepEqual(teacherRecord(store, created.id).defaultPlatforms, ['xiaohongshu', 'douyin']);

  const before = store.dump();
  const writes = store.updates;
  assert.throws(() => accounts.saveTeacher(store, {
    id: created.id, name: '非法默认', defaultPlatforms: ['weibo']
  }), /默认平台|平台/);
  assert.throws(() => accounts.saveTeacher(store, {
    id: created.id, name: '重复默认', defaultPlatforms: ['douyin', 'douyin']
  }), /重复/);
  assert.throws(() => accounts.saveTeacher(store, {
    id: randomUUID(), name: '未知老师', defaultPlatforms: ['douyin']
  }), /不存在/);
  assert.equal(store.updates, writes);
  assert.deepEqual(store.dump(), before);
});

test('saveTeacherProfile 空默认列表合法，返回老师与空账号投影', () => {
  const store = memoryStore(emptyState());
  const result = accounts.saveTeacherProfile(store, {
    name: '空默认老师', defaultPlatforms: [], accounts: []
  });

  assert.match(result.teacher.id, UUID);
  assert.deepEqual(result.teacher.defaultPlatforms, []);
  assert.deepEqual(result.accounts, []);
  assert.equal(store.updates, 1);
  assert.deepEqual(teacherRecord(store, result.teacher.id).defaultPlatforms, []);
});

test('多平台保存并自动新增未连接占位账号，已有平台不重复建', () => {
  const store = memoryStore(emptyState());
  const result = accounts.saveTeacherProfile(store, {
    name: '张老师',
    defaultPlatforms: ['douyin', 'tencent'],
    accounts: [{ platform: 'xiaohongshu', label: '小红书主号' }]
  });

  assert.equal(result.accounts.length, 3);
  assert.equal(store.updates, 1);
  const byPlatform = Object.fromEntries(result.accounts.map(account => [account.platform, account]));
  assert.equal(byPlatform.douyin.label, '张老师 · 抖音');
  assert.equal(byPlatform.tencent.label, '张老师 · 视频号');
  assert.equal(byPlatform.xiaohongshu.label, '小红书主号');
  for (const platform of ['douyin', 'tencent']) {
    const placeholder = byPlatform[platform];
    assert.equal(placeholder.status, 'unconnected');
    assert.equal(placeholder.binding, null);
    assert.equal(placeholder.teacherId, result.teacher.id);
    assert.equal(placeholder.browserEnvironmentId, undefined);
    assert(!Number.isNaN(Date.parse(placeholder.createdAt)));
  }

  const again = accounts.saveTeacherProfile(store, {
    id: result.teacher.id,
    name: '张老师（改名）',
    defaultPlatforms: ['douyin', 'tencent'],
    accounts: []
  });
  assert.equal(again.accounts.length, 3, '已有同平台账号时不能重复建占位');
  assert.equal(again.accounts.filter(account => account.platform === 'douyin').length, 1);
  assert.equal(again.accounts.find(account => account.platform === 'douyin').label, '张老师 · 抖音',
    '已有占位账号的备注不被改名隐式重写');

  const withExisting = accounts.saveTeacherProfile(store, {
    name: '李老师',
    defaultPlatforms: ['douyin'],
    accounts: [{ platform: 'douyin', label: '李老师已有抖音' }]
  });
  assert.equal(withExisting.accounts.length, 1);
  assert.equal(withExisting.accounts[0].label, '李老师已有抖音');
  assert.equal(withExisting.accounts[0].binding, null);
});

test('saveTeacherProfile 更新未传 defaultPlatforms 时保留原值', () => {
  const store = memoryStore(emptyState());
  const created = accounts.saveTeacherProfile(store, {
    name: '王老师', defaultPlatforms: ['xiaohongshu'], accounts: []
  });

  const updated = accounts.saveTeacherProfile(store, {
    id: created.teacher.id, name: '王老师（改）', accounts: []
  });
  assert.deepEqual(updated.teacher.defaultPlatforms, ['xiaohongshu']);
  assert.equal(updated.teacher.name, '王老师（改）');
  assert.equal(updated.accounts.filter(account => account.platform === 'xiaohongshu').length, 1);

  const replaced = accounts.saveTeacherProfile(store, {
    id: created.teacher.id, name: '王老师（改）', defaultPlatforms: ['douyin', 'tencent'], accounts: []
  });
  assert.deepEqual(replaced.teacher.defaultPlatforms, ['douyin', 'tencent']);
  assert(replaced.accounts.some(account => account.platform === 'xiaohongshu'), '清除默认平台不删除原账号');
  assert(replaced.accounts.some(account => account.platform === 'douyin'));
  assert(replaced.accounts.some(account => account.platform === 'tencent'));
});

test('saveTeacherProfile 拒绝非法平台、重复默认、超量与重复账号描述', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacherProfile(store, {
    name: '校验老师', defaultPlatforms: [], accounts: []
  });
  const id = teacher.teacher.id;

  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: ['weibo'], accounts: []
  }), /默认平台|平台/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: ['douyin', 'douyin'], accounts: []
  }), /重复/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: 'douyin', accounts: []
  }), /默认平台/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: [],
    accounts: Array.from({ length: 17 }, (_, index) => ({
      id: `missing-${index}`, platform: 'douyin', label: `账号${index}`
    }))
  }), /最多16/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: [],
    accounts: [
      { id: 'missing-a', platform: 'douyin', label: 'A' },
      { id: 'missing-a', platform: 'tencent', label: 'B' }
    ]
  }), /重复/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: [],
    accounts: [
      { platform: 'tencent', label: '视频号1' },
      { platform: 'tencent', label: '视频号2' }
    ]
  }), /平台|新增/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id, name: '校验老师', defaultPlatforms: [],
    accounts: [{ platform: 'weibo', label: '非法平台' }]
  }), /平台/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id: randomUUID(), name: '未知老师', defaultPlatforms: [], accounts: []
  }), /不存在/);
});

test('账号ID必须属于该老师且平台一致，不能借接口迁入或覆盖', () => {
  const store = memoryStore(emptyState());
  const teacherA = accounts.saveTeacher(store, { name: '甲老师' });
  const teacherB = accounts.saveTeacher(store, { name: '乙老师' });
  const accountA = createdAccount(store, teacherA.id, 'douyin', '甲抖音');
  const accountB = createdAccount(store, teacherB.id, 'douyin', '乙抖音');

  store.update(state => {
    state.accounts.push({
      id: 'legacy-unassigned', platform: 'tencent', label: '未分配旧账号',
      status: 'unconnected', createdAt: CREATED_AT, teacherId: null, binding: null, legacyOnly: true
    });
  });

  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id: teacherA.id, name: '甲老师', defaultPlatforms: [],
    accounts: [{ id: accountB.id, platform: 'douyin', label: '迁入乙账号' }]
  }), /不属于/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id: teacherA.id, name: '甲老师', defaultPlatforms: [],
    accounts: [{ id: 'legacy-unassigned', platform: 'tencent', label: '迁入未分配' }]
  }), /不属于/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id: teacherA.id, name: '甲老师', defaultPlatforms: [],
    accounts: [{ id: accountA.id, platform: 'tencent', label: '换平台' }]
  }), /平台/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id: teacherA.id, name: '甲老师', defaultPlatforms: [],
    accounts: [{ id: 'missing-account', platform: 'douyin', label: '不存在' }]
  }), /不存在/);
  assertRejected(store, () => accounts.saveTeacherProfile(store, {
    id: teacherA.id, name: '甲老师', defaultPlatforms: [],
    accounts: [{ platform: 'douyin', label: '无ID覆盖现有' }]
  }), /现有账号ID/);

  assert.equal(accountRecord(store, accountA.id).label, '甲抖音');
  assert.equal(accountRecord(store, accountB.id).label, '乙抖音');
  assert.equal(accountRecord(store, 'legacy-unassigned').label, '未分配旧账号');
});

test('保存失败整体回滚，不留下老师改名、备注或占位账号', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacherProfile(store, {
    name: '回滚老师', defaultPlatforms: ['douyin'], accounts: []
  });
  const existing = store.dump().accounts.find(account => account.platform === 'douyin');
  const before = store.dump();
  const writes = store.updates;

  assert.throws(() => accounts.saveTeacherProfile(store, {
    id: teacher.teacher.id,
    name: '不应保存的新名字',
    defaultPlatforms: ['xiaohongshu', 'tencent'],
    accounts: [
      { id: existing.id, platform: 'douyin', label: '不应保存的新备注' },
      { platform: 'xiaohongshu', label: '不应保存的新账号' },
      { id: 'missing-account', platform: 'douyin', label: '触发失败' }
    ]
  }), /不存在/);

  assert.equal(store.updates, writes);
  assert.deepEqual(store.dump(), before);
});

test('改备注保留状态、绑定、专属浏览器、创建时间与未知兼容字段', () => {
  const store = memoryStore(emptyState());
  const teacherA = accounts.saveTeacher(store, { name: '甲老师' });
  const teacherB = accounts.saveTeacher(store, { name: '乙老师' });
  const managed = createdAccount(store, teacherA.id, 'douyin', '专属浏览器账号');
  const legacy = createdAccount(store, teacherA.id, 'douyin', '旧扩展账号');
  const untouched = createdAccount(store, teacherB.id, 'douyin', '乙老师账号');

  const environment = accounts.assignBrowserEnvironment(store, managed.id, 'chrome');
  const bound = accounts.bindBrowserAccount(store, {
    accountId: managed.id,
    environmentId: environment.id,
    platformAccountId: 'managed_douyin_1',
    displayName: '专属展示名'
  });
  const legacyBound = accounts.bindManagedAccount(store, {
    accountId: legacy.id,
    connectorInstanceId: randomUUID(),
    platformAccountId: 'legacy_douyin_1',
    displayName: '旧扩展展示名',
    environmentLabel: '旧扩展环境'
  }, '2026-01-01T00:00:00.000Z');
  store.update(state => {
    state.accounts.find(account => account.id === managed.id).legacyAccountField = { keep: true };
  });

  const beforeManaged = accountRecord(store, managed.id);
  const beforeLegacy = accountRecord(store, legacy.id);
  const beforeUntouched = accountRecord(store, untouched.id);
  const beforeEnvironment = store.dump().environments.find(item => item.id === environment.id);

  const result = accounts.saveTeacherProfile(store, {
    id: teacherA.id,
    name: '甲老师（改）',
    defaultPlatforms: ['tencent'],
    accounts: [
      { id: managed.id, platform: 'douyin', label: '专属账号新备注' },
      { id: legacy.id, platform: 'douyin', label: '旧扩展新备注' }
    ]
  });

  const afterManaged = accountRecord(store, managed.id);
  const afterLegacy = accountRecord(store, legacy.id);
  assert.equal(afterManaged.label, '专属账号新备注');
  assert.equal(afterManaged.status, beforeManaged.status);
  assert.deepEqual(afterManaged.binding, beforeManaged.binding);
  assert.equal(afterManaged.browserEnvironmentId, beforeManaged.browserEnvironmentId);
  assert.equal(afterManaged.createdAt, beforeManaged.createdAt);
  assert.deepEqual(afterManaged.legacyAccountField, { keep: true });
  assert.equal(afterManaged.teacherId, teacherA.id);
  assert.equal(afterManaged.platform, 'douyin');

  assert.equal(afterLegacy.label, '旧扩展新备注');
  assert.equal(afterLegacy.status, 'bound');
  assert.deepEqual(afterLegacy.binding, beforeLegacy.binding);
  assert.equal(afterLegacy.createdAt, beforeLegacy.createdAt);

  assert.deepEqual(accountRecord(store, untouched.id), beforeUntouched);
  assert.deepEqual(store.dump().environments.find(item => item.id === environment.id), beforeEnvironment);
  assert(bound.binding);
  assert(legacyBound.binding);
  assert(result.accounts.some(account => account.id === managed.id));
  assert(result.accounts.some(account => account.id === legacy.id));
  assert(!result.accounts.some(account => account.id === untouched.id));
});

test('清除默认平台不删除该平台账号，空默认列表仍合法', () => {
  const store = memoryStore(emptyState());
  const created = accounts.saveTeacherProfile(store, {
    name: '保留老师',
    defaultPlatforms: ['douyin', 'tencent', 'xiaohongshu'],
    accounts: []
  });
  const before = accounts.snapshotAccounts(store).accounts;
  assert.equal(before.length, 3);

  const cleared = accounts.saveTeacherProfile(store, {
    id: created.teacher.id,
    name: '保留老师',
    defaultPlatforms: [],
    accounts: []
  });
  assert.deepEqual(cleared.teacher.defaultPlatforms, []);
  assert.deepEqual(accounts.snapshotAccounts(store).accounts, before);

  const clearedBySaveTeacher = accounts.saveTeacher(store, {
    id: created.teacher.id,
    name: '保留老师',
    defaultPlatforms: []
  });
  assert.deepEqual(clearedBySaveTeacher.defaultPlatforms, []);
  assert.deepEqual(accounts.snapshotAccounts(store).accounts, before);
});

test('保存老师档案不改动草稿、模板、环境、运行历史、schemaVersion 与 deviceId', () => {
  const teacherId = 'teacher-keep';
  const environmentId = '22222222-2222-4222-8222-222222222222';
  const store = memoryStore(emptyState({
    assets: [{ id: 'asset-keep', kind: 'video', name: '素材.mp4', legacy: true }],
    templates: [{ id: 'template-keep', name: '模板', targets: [] }],
    drafts: [{ id: 'draft-keep', name: '草稿', legacy: true }],
    runs: [{ id: 'run-keep', status: 'done', events: [{ at: CREATED_AT }] }],
    teachers: [{ id: teacherId, name: '保留老师', createdAt: CREATED_AT, defaultPlatforms: [] }],
    environments: [{
      id: environmentId,
      source: 'managed_browser',
      connectorInstanceId: null,
      browserKind: 'chrome',
      teacherId,
      deviceId: DEVICE_ID,
      label: '专属浏览器',
      createdAt: CREATED_AT,
      lastSeenAt: CREATED_AT
    }],
    accounts: [{
      id: 'account-keep', platform: 'douyin', label: '已有账号', status: 'unconnected',
      createdAt: CREATED_AT, teacherId, binding: null, browserEnvironmentId: environmentId
    }]
  }));
  const before = store.dump();

  const result = accounts.saveTeacherProfile(store, {
    id: teacherId,
    name: '保留老师（改）',
    defaultPlatforms: ['xiaohongshu', 'tencent'],
    accounts: [{ id: 'account-keep', platform: 'douyin', label: '已有账号（改）' }]
  });
  const after = store.dump();

  assert.equal(after.schemaVersion, before.schemaVersion);
  assert.equal(after.deviceId, before.deviceId);
  for (const key of ['assets', 'templates', 'drafts', 'runs', 'environments']) {
    assert.deepEqual(after[key], before[key], `${key} 不应改变`);
  }
  assert.equal(after.accounts.find(account => account.id === 'account-keep').label, '已有账号（改）');
  assert(result.accounts.some(account => account.platform === 'xiaohongshu'));
  assert(result.accounts.some(account => account.platform === 'tencent'));
});

test('快照、返回值与输入数组都不泄露引用，外部修改不污染 store', () => {
  const store = memoryStore(emptyState());
  const defaults = ['xiaohongshu', 'douyin'];
  const accountsInput = [{ platform: 'tencent', label: '视频号' }];
  const result = accounts.saveTeacherProfile(store, {
    name: '引用老师', defaultPlatforms: defaults, accounts: accountsInput
  });

  defaults.push('tencent');
  accountsInput[0].label = '篡改输入';
  result.teacher.defaultPlatforms.push('tencent');
  result.teacher.name = '篡改老师';
  result.accounts[0].label = '篡改账号';
  assert.deepEqual(teacherRecord(store, result.teacher.id).defaultPlatforms, ['xiaohongshu', 'douyin']);
  assert.equal(teacherRecord(store, result.teacher.id).name, '引用老师');
  assert.equal(store.dump().accounts.find(account => account.platform === 'tencent').label, '视频号');

  const snapshot = accounts.snapshotAccounts(store);
  const teacherView = snapshot.teachers.find(item => item.id === result.teacher.id);
  teacherView.defaultPlatforms.push('tencent');
  teacherView.name = '快照篡改';
  snapshot.accounts[0].label = '快照账号篡改';
  assert.deepEqual(teacherRecord(store, result.teacher.id).defaultPlatforms, ['xiaohongshu', 'douyin']);
  assert.equal(teacherRecord(store, result.teacher.id).name, '引用老师');
  assert.notEqual(
    accounts.snapshotAccounts(store).teachers.find(item => item.id === result.teacher.id).defaultPlatforms[0],
    'tencent'
  );
});

test('超长老师名的占位备注截短到100字符且保留平台后缀', () => {
  const store = memoryStore(emptyState());
  const name = '名'.repeat(100);
  const result = accounts.saveTeacherProfile(store, {
    name,
    defaultPlatforms: ['douyin', 'tencent', 'xiaohongshu'],
    accounts: []
  });
  assert.equal(result.teacher.name, name);
  for (const account of result.accounts) {
    assert(account.label.length <= 100, `${account.platform} 备注应不超过100字符`);
    assert(account.label.endsWith(` · ${account.platform === 'douyin' ? '抖音' : account.platform === 'tencent' ? '视频号' : '小红书'}`));
  }
  for (const account of store.dump().accounts) {
    assert(account.label.length <= 100);
  }
});

test('saveTeacherProfile 一次原子 update 完成老师、备注和占位账号', () => {
  const store = memoryStore(emptyState());
  const writes = store.updates;
  const result = accounts.saveTeacherProfile(store, {
    name: '原子老师',
    defaultPlatforms: ['xiaohongshu', 'douyin'],
    accounts: [{ platform: 'tencent', label: '视频号新号' }]
  });
  assert.equal(store.updates, writes + 1);
  assert.equal(result.accounts.length, 3);
  assert.equal(store.dump().teachers.length, 1);
  assert.equal(store.dump().accounts.length, 3);
});
