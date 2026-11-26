'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const accounts = require('../app/core/accounts.cjs');
const domain = require('../app/core/domain.cjs');

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const MANAGED_PLATFORMS = ['douyin', 'tencent', 'xiaohongshu'];
const PLATFORM_SUFFIX = {
  douyin: '抖音', tencent: '视频号', xiaohongshu: '小红书'
};

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

function teacherRecord(id, name) {
  return { id, name, createdAt: CREATED_AT, defaultPlatforms: [] };
}

function managedEnvironment(teacherId, overrides = {}) {
  return {
    id: randomUUID(),
    source: 'managed_browser',
    connectorInstanceId: null,
    browserKind: 'chrome',
    teacherId,
    deviceId: DEVICE_ID,
    label: '旧专属浏览器环境',
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
    ...overrides
  };
}

function createdAccount(store, teacherId, platform, label) {
  return accounts.saveManagedAccount(store, { teacherId, platform, label });
}

function accountRecord(store, accountId) {
  return store.dump().accounts.find(account => account.id === accountId);
}

function environmentRecord(store, environmentId) {
  return store.dump().environments.find(environment => environment.id === environmentId);
}

test('平台矩阵为3项，小红书字段精确且真实发布保持关闭', () => {
  assert.equal(accounts.PLATFORM_IDS.length, 3);
  assert.equal(Object.keys(accounts.PLATFORM_LABELS).length, 3);
  assert.equal(accounts.PLATFORM_IDS[2], 'xiaohongshu');
  assert.equal(accounts.PLATFORM_LABELS.xiaohongshu, '小红书');

  assert.equal(domain.PLATFORMS.length, 3);
  const xiaohongshu = domain.PLATFORMS.find(platform => platform.id === 'xiaohongshu');
  assert.deepEqual(xiaohongshu, {
    id: 'xiaohongshu',
    label: '小红书',
    color: '#e94d64',
    coverSlots: ['portrait'],
    capabilities: { dualCover: false, declaration: false, collection: false },
    creatorUrl: 'https://creator.xiaohongshu.com/publish/publish'
  });
  assert.deepEqual(Object.keys(xiaohongshu.capabilities).sort(), ['collection', 'declaration', 'dualCover']);
  assert.equal(Object.values(xiaohongshu.capabilities).every(value => value === false), true);

  assert.equal(domain.ENGINE.ready, false);
  assert.equal(domain.ENGINE.douyinPilot, false);
  assert.match(domain.ENGINE.reason, /抖音.*视频号.*小红书/);
  assert.match(domain.ENGINE.reason, /(?:真实|自动)上传与发布尚未完成/);
});

test('老师可一次勾选3个默认平台，旧2平台草稿归一化补小红书且不改输入', () => {
  const store = memoryStore(emptyState());
  const profile = accounts.saveTeacherProfile(store, {
    name: '三平台老师',
    defaultPlatforms: [...accounts.PLATFORM_IDS],
    accounts: []
  });

  assert.equal(profile.accounts.length, 3);
  assert.deepEqual(profile.teacher.defaultPlatforms, [...accounts.PLATFORM_IDS]);
  for (const platform of accounts.PLATFORM_IDS) {
    const account = profile.accounts.find(item => item.platform === platform);
    assert(account, `应生成${platform}占位账号`);
    assert.equal(account.label, `三平台老师 · ${PLATFORM_SUFFIX[platform]}`);
    assert.equal(account.status, 'unconnected');
    assert.equal(account.browserEnvironmentId, undefined);
  }
  assert.throws(() => accounts.saveTeacher(store, {
    id: profile.teacher.id,
    name: '三平台老师',
    defaultPlatforms: [...accounts.PLATFORM_IDS, 'weibo']
  }), /最多3/);

  const oldDraft = {
    name: '旧两平台草稿',
    teacherId: profile.teacher.id,
    video: null,
    covers: {},
    common: { title: '旧标题', description: '', tags: [] },
    targets: ['douyin', 'tencent'].map((platform, index) => ({
      platform,
      enabled: index === 0,
      accountId: '',
      inherit: true,
      title: '旧标题'
    }))
  };
  const original = structuredClone(oldDraft);
  const normalized = domain.normalizeDraft(oldDraft, store.dump());

  assert.deepEqual(oldDraft, original, '归一化不得修改调用方草稿');
  assert.equal(normalized.targets.length, 3);
  const xiaohongshu = normalized.targets.find(target => target.platform === 'xiaohongshu');
  assert(xiaohongshu, '旧草稿应补出小红书目标');
  assert.equal(xiaohongshu.enabled, false);
  assert.equal(xiaohongshu.accountId, '');
  assert.equal(xiaohongshu.inherit, true);
  assert.deepEqual(xiaohongshu.covers, { landscape: null, portrait: null });
  assert.deepEqual(xiaohongshu.declaration, { required: false, text: '' });
  assert.deepEqual(xiaohongshu.collection, { required: false, name: '' });
  assert.equal(normalized.targets.find(target => target.platform === 'douyin').enabled, true);
});

test('小红书账号与模板可保存，模板不继承视频、封面或凭据', () => {
  const store = memoryStore(emptyState());
  const profile = accounts.saveTeacherProfile(store, {
    name: '小红书老师',
    defaultPlatforms: ['xiaohongshu'],
    accounts: [{ platform: 'xiaohongshu', label: '小红书主号' }]
  });
  assert.equal(profile.accounts.length, 1);
  const account = profile.accounts[0];
  assert.equal(account.platform, 'xiaohongshu');
  assert.equal(account.label, '小红书主号');
  assert.equal(account.status, 'unconnected');

  const template = domain.saveTemplate(store, {
    name: '小红书栏目',
    teacherId: profile.teacher.id,
    common: { title: '笔记标题', tags: ['志愿填报'] },
    targets: [{
      platform: 'xiaohongshu',
      enabled: true,
      accountId: account.id,
      inherit: true,
      cookie: 'must-not-be-saved'
    }]
  });

  assert.equal(template.targets.length, 3);
  const target = template.targets.find(item => item.platform === 'xiaohongshu');
  assert.equal(target.enabled, true);
  assert.equal(target.accountId, account.id);
  assert.equal(target.cookie, undefined);
  assert.equal(template.common.title, '笔记标题');
  assert(!JSON.stringify(template).includes('must-not-be-saved'));
  assert.equal(store.dump().accounts.filter(item => item.platform === 'xiaohongshu').length, 1);
});

test('同老师三平台各自独立环境，绑定后可按本机身份核验', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacher(store, { name: '三平台老师' });
  const environmentIds = {};

  for (const platform of MANAGED_PLATFORMS) {
    const account = createdAccount(store, teacher.id, platform, `${platform}账号`);
    const environment = accounts.assignBrowserEnvironment(store, account.id, 'chrome');

    assert.equal(environment.platform, platform);
    assert.equal(environment.teacherId, teacher.id);
    assert.equal(environment.source, 'managed_browser');
    assert.match(environment.label, new RegExp(PLATFORM_SUFFIX[platform]));
    assert.deepEqual(Object.keys(environment).sort(), [
      'browserKind', 'connectorInstanceId', 'createdAt', 'deviceId', 'id', 'label',
      'lastSeenAt', 'platform', 'source', 'teacherId'
    ]);

    const bound = accounts.bindBrowserAccount(store, {
      accountId: account.id,
      environmentId: environment.id,
      platformAccountId: `${platform}_managed_1`,
      displayName: `${PLATFORM_SUFFIX[platform]}展示名`
    });
    assert.equal(bound.binding.environmentId, environment.id);
    assert.equal(bound.binding.source, 'managed_browser');
    assert.equal(accounts.assertBrowserIdentity(store, {
      accountId: account.id,
      environmentId: environment.id,
      platformAccountId: `${platform}_managed_1`
    }).id, account.id);

    environmentIds[platform] = environment.id;
  }

  assert.equal(new Set(Object.values(environmentIds)).size, 3);
  assert.equal(store.dump().environments.length, 3);
  assert.equal(accounts.snapshotAccounts(store).environments.length, 3);
});

test('不同老师、同老师同平台的不同账号都不复用环境', () => {
  const store = memoryStore(emptyState());
  const teacherA = accounts.saveTeacher(store, { name: '甲老师' });
  const teacherB = accounts.saveTeacher(store, { name: '乙老师' });

  const a1 = createdAccount(store, teacherA.id, 'douyin', '甲老师抖音1');
  const a2 = createdAccount(store, teacherA.id, 'douyin', '甲老师抖音2');
  const b1 = createdAccount(store, teacherB.id, 'douyin', '乙老师抖音');
  const b2 = createdAccount(store, teacherB.id, 'xiaohongshu', '乙老师小红书');

  const environments = [a1, a2, b1, b2].map(account => accounts.assignBrowserEnvironment(store, account.id, 'chrome'));
  assert.equal(new Set(environments.map(environment => environment.id)).size, 4);
  assert.equal(store.dump().environments.length, 4);
  assert.equal(environmentRecord(store, accountRecord(store, a1.id).browserEnvironmentId).teacherId, teacherA.id);
  assert.equal(environmentRecord(store, accountRecord(store, a2.id).browserEnvironmentId).teacherId, teacherA.id);
  assert.equal(environmentRecord(store, accountRecord(store, b1.id).browserEnvironmentId).teacherId, teacherB.id);
  assert.equal(environmentRecord(store, accountRecord(store, b2.id).browserEnvironmentId).platform, 'xiaohongshu');
});

test('重复打开同一账号的专属浏览器保持同一目录与绑定', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacher(store, { name: '重复打开老师' });
  const account = createdAccount(store, teacher.id, 'tencent', '视频号账号');

  const first = accounts.assignBrowserEnvironment(store, account.id, 'chrome');
  const before = store.dump();
  const second = accounts.assignBrowserEnvironment(store, account.id, 'chrome');
  assert.equal(second.id, first.id);
  assert.deepEqual(store.dump(), before, '重复打开不应新建或改写环境');

  const bound = accounts.bindBrowserAccount(store, {
    accountId: account.id,
    environmentId: first.id,
    platformAccountId: 'tencent_reopen',
    displayName: '重复打开'
  });
  const third = accounts.assignBrowserEnvironment(store, account.id, 'chrome');
  assert.equal(third.id, first.id);
  assert.equal(store.dump().environments.length, 1);
  assert.deepEqual(accountRecord(store, account.id).binding, bound.binding);
});

test('跨平台环境冒充与跨老师核验都被拒绝', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacher(store, { name: '冒充测试老师' });
  const otherTeacher = accounts.saveTeacher(store, { name: '被冒充老师' });
  const douyin = createdAccount(store, teacher.id, 'douyin', '抖音账号');
  const xiaohongshu = createdAccount(store, teacher.id, 'xiaohongshu', '小红书账号');
  const douyinEnvironment = accounts.assignBrowserEnvironment(store, douyin.id, 'chrome');
  const xiaohongshuEnvironment = accounts.assignBrowserEnvironment(store, xiaohongshu.id, 'chrome');

  store.update(state => {
    state.accounts.find(item => item.id === xiaohongshu.id).browserEnvironmentId = douyinEnvironment.id;
  });
  const before = store.dump();
  assert.throws(() => accounts.bindBrowserAccount(store, {
    accountId: xiaohongshu.id,
    environmentId: douyinEnvironment.id,
    platformAccountId: 'xhs_cross_platform',
    displayName: '冒充'
  }), /平台|归属/);
  assert.throws(() => accounts.assignBrowserEnvironment(store, xiaohongshu.id, 'chrome'), /平台|归属/);
  assert.deepEqual(store.dump(), before, '拒绝时不得写入半成品');

  store.update(state => {
    state.accounts.find(item => item.id === xiaohongshu.id).browserEnvironmentId = xiaohongshuEnvironment.id;
    state.environments.find(item => item.id === xiaohongshuEnvironment.id).teacherId = otherTeacher.id;
  });
  assert.throws(() => accounts.assignBrowserEnvironment(store, xiaohongshu.id, 'chrome'), /老师|归属/);
});

test('旧专属环境缺platform时沿用原目录，不强制迁移', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacher(store, { name: '旧环境老师' });
  const account = createdAccount(store, teacher.id, 'xiaohongshu', '旧环境小红书');
  const legacyManaged = managedEnvironment(teacher.id, { label: '旧小红书专属环境' });

  store.update(state => {
    state.environments.push(legacyManaged);
    state.accounts.find(item => item.id === account.id).browserEnvironmentId = legacyManaged.id;
  });

  const assigned = accounts.assignBrowserEnvironment(store, account.id, 'chrome');
  assert.equal(assigned.id, legacyManaged.id);
  assert.equal(assigned.platform, undefined);
  assert.equal(environmentRecord(store, legacyManaged.id).platform, undefined, '不得强制补platform或改目录');
  assert.equal(environmentRecord(store, legacyManaged.id).label, '旧小红书专属环境');

  const bound = accounts.bindBrowserAccount(store, {
    accountId: account.id,
    environmentId: legacyManaged.id,
    platformAccountId: 'xhs_legacy_env',
    displayName: '旧环境绑定'
  });
  assert.equal(bound.binding.environmentId, legacyManaged.id);
  assert.equal(accounts.assertBrowserIdentity(store, {
    accountId: account.id,
    environmentId: legacyManaged.id,
    platformAccountId: 'xhs_legacy_env'
  }).id, account.id);

  const projected = accounts.snapshotAccounts(store).environments.find(item => item.id === legacyManaged.id);
  assert.equal(projected.teacherId, teacher.id);
  assert.equal('platform' in projected, false);
});

test('共享旧环境在分配或绑定时被拒绝，原会话不被覆盖', () => {
  const teacherId = 'teacher-shared';
  const teacher = teacherRecord(teacherId, '共享环境老师');
  const accountA = {
    id: 'shared-a', platform: 'xiaohongshu', label: '共享A', status: 'unconnected',
    createdAt: CREATED_AT, teacherId, binding: null
  };
  const accountB = {
    id: 'shared-b', platform: 'xiaohongshu', label: '共享B', status: 'unconnected',
    createdAt: CREATED_AT, teacherId, binding: null
  };
  const shared = managedEnvironment(teacherId);

  const byBrowserId = memoryStore(emptyState({
    teachers: [teacher],
    accounts: [structuredClone(accountA), structuredClone(accountB)],
    environments: [shared]
  }));
  byBrowserId.update(state => {
    state.accounts[0].browserEnvironmentId = shared.id;
    state.accounts[1].browserEnvironmentId = shared.id;
  });
  assert.doesNotThrow(() => accounts.ensureAccountState(byBrowserId), '旧数据本身应可读');
  const before = byBrowserId.dump();
  assert.throws(() => accounts.assignBrowserEnvironment(byBrowserId, accountA.id, 'chrome'), /其他账号|复用/);
  assert.throws(() => accounts.bindBrowserAccount(byBrowserId, {
    accountId: accountA.id,
    environmentId: shared.id,
    platformAccountId: 'shared_a_xhs',
    displayName: '共享A'
  }), /其他账号|复用/);
  assert.deepEqual(byBrowserId.dump(), before, '拒绝共享环境时不得改写原数据');

  const byBinding = memoryStore(emptyState({
    teachers: [teacher],
    accounts: [
      {
        ...structuredClone(accountA),
        status: 'bound',
        browserEnvironmentId: shared.id,
        binding: {
          source: 'managed_browser',
          environmentId: shared.id,
          connectorInstanceId: null,
          platformAccountId: 'shared_owner_xhs',
          displayName: '原绑定',
          verifiedAt: CREATED_AT,
          revision: randomUUID()
        }
      },
      structuredClone(accountB)
    ],
    environments: [{ ...shared, id: randomUUID() }]
  }));
  const bindingEnvironment = byBinding.dump().environments[0];
  byBinding.update(state => {
    state.accounts[0].browserEnvironmentId = bindingEnvironment.id;
    state.accounts[0].binding.environmentId = bindingEnvironment.id;
    state.accounts[1].browserEnvironmentId = bindingEnvironment.id;
  });
  assert.throws(() => accounts.assignBrowserEnvironment(byBinding, accountB.id, 'chrome'), /其他账号|复用/);
  assert.equal(byBinding.dump().accounts[0].binding.platformAccountId, 'shared_owner_xhs');
});

test('legacy extension仍只允许抖音，非抖音绑定与核验都拒绝', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacher(store, { name: '旧协议老师' });
  const xiaohongshu = createdAccount(store, teacher.id, 'xiaohongshu', '旧协议小红书');
  const tencent = createdAccount(store, teacher.id, 'tencent', '旧协议视频号');

  for (const account of [xiaohongshu, tencent]) {
    assert.throws(() => accounts.bindManagedAccount(store, {
      accountId: account.id,
      connectorInstanceId: randomUUID(),
      platformAccountId: `${account.platform}_legacy`,
      displayName: '旧扩展',
      environmentLabel: '旧扩展环境'
    }, CREATED_AT), /抖音/);
  }
  assert.equal(store.dump().environments.length, 0, '旧协议拒绝时不应创建环境');
  assert.equal(accountRecord(store, xiaohongshu.id).binding, null);

  const connectorInstanceId = randomUUID();
  store.update(state => {
    state.environments.push({
      id: connectorInstanceId,
      connectorInstanceId,
      label: '手工旧扩展环境',
      deviceId: DEVICE_ID,
      createdAt: CREATED_AT,
      lastSeenAt: CREATED_AT,
      teacherId: teacher.id
    });
    const account = state.accounts.find(item => item.id === xiaohongshu.id);
    account.status = 'bound';
    account.binding = {
      environmentId: connectorInstanceId,
      connectorInstanceId,
      platformAccountId: 'xhs_legacy_assert',
      displayName: '旧扩展',
      verifiedAt: CREATED_AT,
      revision: randomUUID()
    };
  });
  assert.throws(() => accounts.assertIdentity(store, {
    accountId: xiaohongshu.id,
    connectorInstanceId,
    platformAccountId: 'xhs_legacy_assert'
  }), /抖音/);
});

test('小红书真实发布仍由未完成引擎与未连接账号双重阻止', () => {
  const state = domain.emptyState();
  state.teachers = [{ id: 'teacher-publish', name: '发布测试老师' }];
  state.accounts = [{
    id: 'xhs-publish', platform: 'xiaohongshu', label: '未连接小红书',
    status: 'unconnected', teacherId: 'teacher-publish'
  }];
  const video = {
    id: 'video-publish', kind: 'video', name: '测试.mp4',
    path: '/test-fixtures/publish.mp4', size: 8, mtimeMs: 100
  };
  state.assets.push(video);
  const draft = {
    teacherId: 'teacher-publish',
    video: { id: video.id },
    covers: {},
    common: { title: '发布测试标题', tags: [] },
    targets: [{ platform: 'xiaohongshu', enabled: true, accountId: 'xhs-publish', inherit: true }]
  };
  const stat = () => ({ size: 8, mtimeMs: 100, isFile: () => true });

  const publish = domain.validateDraft(draft, state, 'publish', stat);
  assert.equal(publish.ok, false);
  assert(publish.issues.some(issue => issue.field === 'engine'));
  assert(publish.issues.some(issue => issue.field === 'account' && /尚未连接/.test(issue.message)));
  assert.equal(domain.ENGINE.ready, false);
  assert.equal(domain.ENGINE.douyinPilot, false);
});

test('专属环境公开老师与平台字段但继续脱敏，非法平台和平台错配被拒绝', () => {
  const store = memoryStore(emptyState());
  const teacher = accounts.saveTeacher(store, { name: '投影测试老师' });
  const account = createdAccount(store, teacher.id, 'xiaohongshu', '投影小红书');
  const environment = accounts.assignBrowserEnvironment(store, account.id, 'chrome');

  store.update(state => {
    state.teachers[0].cookie = 'secret-teacher-cookie';
    state.environments[0].cookie = 'secret-env-cookie';
    const target = state.accounts.find(item => item.id === account.id);
    target.cookie = 'secret-account-cookie';
  });
  const snapshot = accounts.snapshotAccounts(store);
  const projected = snapshot.environments.find(item => item.id === environment.id);
  assert.deepEqual(Object.keys(projected).sort(), [
    'browserKind', 'connectorInstanceId', 'createdAt', 'deviceId', 'id', 'label',
    'lastSeenAt', 'platform', 'source', 'teacherId'
  ]);
  assert.equal(projected.teacherId, teacher.id);
  assert.equal(projected.platform, 'xiaohongshu');
  assert(!JSON.stringify(snapshot).includes('secret-'));

  const invalidPlatform = memoryStore(emptyState({
    teachers: [teacherRecord('teacher-env', '环境老师')],
    environments: [managedEnvironment('teacher-env', { platform: 'unknown_platform' })]
  }));
  assert.throws(() => accounts.ensureAccountState(invalidPlatform), /平台/);

  const missingPlatform = memoryStore(emptyState({
    teachers: [teacherRecord('teacher-env', '环境老师')],
    environments: [managedEnvironment('teacher-env')]
  }));
  assert.doesNotThrow(() => accounts.ensureAccountState(missingPlatform), '旧环境可缺platform');

  const mismatched = managedEnvironment(teacher.id, { platform: 'douyin' });
  const mismatchStore = memoryStore(emptyState({
    teachers: [teacher],
    accounts: [{
      id: 'mismatch-xhs', platform: 'xiaohongshu', label: '错配账号', status: 'unconnected',
      createdAt: CREATED_AT, teacherId: teacher.id, binding: null, browserEnvironmentId: mismatched.id
    }],
    environments: [mismatched]
  }));
  assert.throws(() => accounts.ensureAccountState(mismatchStore), /平台/);
});
