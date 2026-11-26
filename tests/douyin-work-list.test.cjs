'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDouyinWorkListResponse,
  matchDouyinWorkListItem,
  observeDouyinWorkList,
  parsePlatformQuickCheck,
} = require('../app/core/douyin-work-list.cjs');
const { ManagedPublisher } = require('../app/core/managed-publisher.cjs');
const { listRecordEvidence } = require('../app/core/douyin-publish-driver.cjs');

test('parseDouyinWorkListResponse 解析官方作品列表并剥离敏感字段', () => {
  const payload = {
    status_code: 0,
    total: 2,
    aweme_list: [
      {
        aweme_id: '1000000000000000101',
        title: '发布台实测11131bb',
        create_time: 1794555660, // 2026-11-13 15:41:00 +08:00
        video: { duration: 8000, play_addr: { url_list: ['https://signed.example/secret?sign=123'] } },
        status: { private_status: 1, in_reviewing: true },
        status_desc: '审核中',
      },
      {
        item_id_plain: '1000000000000000109',
        desc: '另一条公开测试',
        create_time: 1794555720,
        duration: 120,
        status: { private_status: 0, reviewed: 1, is_delete: false },
        status_desc: '已发布',
      },
    ],
  };

  const parsed = parseDouyinWorkListResponse(payload);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].workId, '1000000000000000101');
  assert.equal(parsed.items[0].visibility, 'self');
  assert.equal(parsed.items[0].platformStatus, 'under_review');
  assert.equal(parsed.items[0].duration, '00:08');
  assert.equal(parsed.items[1].visibility, 'public');
  assert.equal(parsed.items[1].platformStatus, 'published');
  assert.equal(parsed.items[1].duration, '02:00');
  assert.equal(JSON.stringify(parsed).includes('signed.example'), false);
  assert.equal(parsed.schema.count, 2);
  assert.ok(parsed.schema.statusKeys.includes('private_status'));
});

test('matchDouyinWorkListItem 严格核对编号、标题与创建时间，拒绝旧稿、重名与编号冲突', () => {
  const tsNew = Date.parse('2026-11-13T07:41:00Z');
  const tsOld = Date.parse('2026-11-12T07:41:00Z');
  const items = [
    { workId: '1000000000000000101', title: '发布台实测11131bb', createTimeMs: tsNew, visibility: 'self', platformStatus: 'under_review' },
    { workId: '1000000000000000100', title: '旧同名作品', createTimeMs: tsOld, visibility: 'self', platformStatus: 'published' },
    { workId: '1000000000000000111', title: '重名作品', createTimeMs: tsNew, visibility: 'self', platformStatus: 'published' },
    { workId: '1000000000000000122', title: '重名作品', createTimeMs: tsNew, visibility: 'self', platformStatus: 'published' },
  ];

  // 精确匹配新稿
  const ok = matchDouyinWorkListItem(items, { copy: { title: '发布台实测11131bb' }, runCreatedAt: '2026-11-13T07:40:32Z' });
  assert.equal(ok.status, 'matched');
  assert.equal(ok.item.workId, '1000000000000000101');

  // 拒绝早于任务创建的旧同名作品
  const oldReject = matchDouyinWorkListItem(items, { copy: { title: '旧同名作品' }, runCreatedAt: '2026-11-13T07:40:32Z' });
  assert.equal(oldReject.status, 'none');

  // 拒绝多个同名新作品
  const dup = matchDouyinWorkListItem(items, { copy: { title: '重名作品' }, runCreatedAt: '2026-11-13T07:40:32Z' });
  assert.equal(dup.status, 'ambiguous');

  // 已有候选编号但只找到不同编号时判定冲突
  const conflict = matchDouyinWorkListItem(items, {
    copy: { title: '发布台实测11131bb' },
    expectedWorkId: '9999999999999999999',
    runCreatedAt: '2026-11-13T07:40:32Z',
  });
  assert.equal(conflict.status, 'conflict');

  // 定时发布任务在没有候选编号时，不把非定时状态的同名作品冒认为回执
  const schedReject = matchDouyinWorkListItem(items, {
    copy: { title: '发布台实测11131bb' },
    schedule: { mode: 'scheduled', at: '2026-11-14T12:00' },
    runCreatedAt: '2026-11-13T07:40:32Z',
  });
  assert.equal(schedReject.status, 'none');
});

test('listRecordEvidence 识别仅自己可见与好友可见且不被标题字样欺骗', () => {
  const priv = listRecordEvidence('00:08\n普通标题\n2026年11月13日 15:41\n仅自己可见', { runCreatedAt: '2026-11-13T07:40:00Z' });
  assert.equal(priv.visibility, 'self');
  const friends = listRecordEvidence('00:08\n普通标题\n2026年11月13日 15:41\n好友可见', { runCreatedAt: '2026-11-13T07:40:00Z' });
  assert.equal(friends.visibility, 'friends');
  // 标题本身含“私密”不应伪造私密状态
  const spoof = listRecordEvidence('00:08\n私密\n2026年11月13日 15:41\n审核中', { copy: { title: '私密' }, runCreatedAt: '2026-11-13T07:40:00Z' });
  assert.equal(spoof.visibility, 'unverified');
});

test('parsePlatformQuickCheck 正确区分检测中、通过、与任务矛盾的建议及无控件场景（R01）', () => {
  const jobWithCovers = { coverMode: 'custom', files: { portrait: { path: '/p.png' }, landscape: { path: '/l.png' } } };

  // 检测中（11-17 真实页面文案）
  const checking = parsePlatformQuickCheck('发文助手\n快速检测\n检测中36%\n封面优化建议共1条\n横封面缺失', jobWithCovers);
  assert.equal(checking.state, 'checking');
  assert.equal(checking.percent, 36);
  assert.equal(checking.requiresConfirmation, true);

  // 通过（11-17 51秒后真实页面文案）
  const passed = parsePlatformQuickCheck('封面效果检测通过\n发文助手\n快速检测\n封面检测通过\n暂未发现封面低质问题', jobWithCovers);
  assert.equal(passed.state, 'passed');
  assert.equal(passed.requiresConfirmation, false);

  // 检测已结束但仍报“横封面缺失”，与已上传横封面矛盾 -> 暂停转人工确认
  const conflict = parsePlatformQuickCheck('发文助手\n快速检测\n封面优化建议共1条\n横封面缺失', jobWithCovers);
  assert.equal(conflict.state, 'advisory');
  assert.equal(conflict.requiresConfirmation, true);
  assert.match(conflict.summary, /横封面缺失/);

  // 无横封面任务时不因“横封面缺失”误报矛盾
  const noLandscape = parsePlatformQuickCheck('发文助手\n快速检测\n封面优化建议共1条\n横封面缺失', { coverMode: 'video_default', files: {} });
  assert.equal(noLandscape.requiresConfirmation, false);

  // 控件不存在时不阻断
  const absent = parsePlatformQuickCheck('基础信息\n作品描述\n发布', jobWithCovers);
  assert.equal(absent.state, 'not_present');
  assert.equal(absent.requiresConfirmation, false);
});

test('R01：自动发布模式下平台快速检测要求确认时，暂停在 awaiting_confirmation 且不自动点击发布', async () => {
  let state = { runs: [] };
  const store = {
    load: () => structuredClone(state),
    update: fn => { fn(state); return structuredClone(state); },
  };
  let submitCalls = 0;
  const fp = 'fp-r01-test';
  const draft = { video: { id: 'v1' }, title: 'R01测试视频' };
  const job = {
    draft: structuredClone(draft),
    platform: 'douyin',
    teacherId: 't1',
    accountId: 'a1',
    fingerprint: fp,
    videoId: 'v1',
    videoKey: 'vk1',
    expectedBinding: { environmentId: 'env1', platformAccountId: 'demo_dy_001', revision: 1 },
    copy: { title: 'R01测试视频' },
    settings: { visibility: 'self' },
    summary: [{ platform: 'douyin', title: 'R01测试视频', specialSettings: { visibility: 'self' } }],
  };
  const executor = {
    capabilities: { submit: true, submissionProtocol: 1 },
    verify: async () => {},
    prepare: async () => ({
      checks: { video: true, covers: true, text: true, declaration: true, collection: true, schedule: true, visibility: true, savePermission: true },
      advisory: { present: true, state: 'advisory', percent: 100, issues: ['横封面缺失'], summary: '横封面缺失', requiresConfirmation: true },
    }),
    submit: async (_job, hooks) => {
      submitCalls++;
      await hooks.beforeDispatch('publish');
      await hooks.afterDispatch('publish');
      return { status: 'submitted', workId: '1000000000000000101', workUrl: 'https://www.douyin.com/video/1000000000000000101', visibility: 'self' };
    },
    stop: async () => {},
  };

  const svc = new ManagedPublisher({
    store,
    buildJob: () => structuredClone(job),
    getExecutor: async () => executor,
    checkAccess: () => {},
  });

  const started = svc.start({
    requestId: 'req-r01-advisory-pause-001',
    draft,
    executionMode: 'automatic',
    authorization: { action: 'publish', fingerprint: fp, confirmedAt: new Date().toISOString() },
  });

  // 等待准备完成
  for (let i = 0; i < 40; i++) {
    const r = svc.run(started.id);
    if (r.status !== 'queued' && r.status !== 'preparing') break;
    await new Promise(res => setTimeout(res, 15));
  }

  const paused = svc.run(started.id);
  assert.equal(paused.status, 'awaiting_confirmation');
  assert.equal(submitCalls, 0);
  assert.equal(paused.advisory.requiresConfirmation, true);
  assert.match(paused.message, /横封面缺失/);

  // 人工明确确认后仍可正常提交一次
  const approved = await svc.approve(started.id, fp);
  assert.equal(approved.status, 'submitted');
  assert.equal(submitCalls, 1);
  assert.equal(approved.workId, '1000000000000000101');
});

test('2026-11-21 真实抖音 work_list 字段校准：status_value=141、高精度 aweme_id 与多响应合并', async () => {
  const realSample = {
    status_code: 0,
    total: 31,
    aweme_list: [{
      aweme_id: '1000000000000000101',
      item_id: 1000000000000000000, // float64 丢精度
      item_title: '发布台实测11131bb',
      create_time: 1794555712,
      duration: 8010,
      status_value: 141,
      status: { aweme_id: '1000000000000000101', in_reviewing: false, is_delete: false, is_private: true, is_prohibited: false, private_status: 1, reviewed: false, self_see: true },
      video: { duration: 8010 },
    }],
  };
  const parsed = parseDouyinWorkListResponse(realSample);
  assert.equal(parsed.items[0].workId, '1000000000000000101');
  assert.equal(parsed.items[0].visibility, 'self');
  assert.equal(parsed.items[0].platformStatus, 'published');
  assert.equal(parsed.items[0].duration, '00:08');

  // 模拟管理页先后发出 12 条主列表与 1 条副列表：后者不能抹掉前者
  let handler = null;
  const fakePage = {
    on: (ev, fn) => { if (ev === 'response') handler = fn; },
    off: () => { handler = null; },
  };
  const obs = observeDouyinWorkList(fakePage);
  const mkRes = payload => ({
    url: () => 'https://creator.douyin.com/janus/douyin/creator/pc/work_list?status=0',
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => payload,
  });
  handler(mkRes(realSample));
  handler(mkRes({
    status_code: 0,
    total: 31,
    aweme_list: [{
      aweme_id: '1000000000000000202',
      item_title: '夺冠版',
      create_time: 1794705230,
      status_value: 102,
      status: { in_reviewing: false, is_delete: false, is_private: false, is_prohibited: false, private_status: 0, reviewed: false },
      video: { duration: 14334 },
    }],
  }));
  const snap = await obs.flush();
  assert.equal(snap.responseCount, 2);
  assert.equal(snap.items.length, 2);
  assert.ok(snap.items.some(it => it.workId === '1000000000000000101'));
  assert.ok(snap.items.some(it => it.workId === '1000000000000000202' && it.platformStatus === 'published'));
  obs.detach();
});

test('ManagedBrowsers.publisherFor 在首页仍在渲染账号号(pending:true)时被动等待至verified，不立刻报错', async t => {
  const model = require('../app/core/accounts.cjs');
  const { ManagedBrowsers } = require('../app/core/managed-browser.cjs');
  let value = { schemaVersion: 1 };
  const store = {
    load: () => structuredClone(value),
    update: fn => { const next = structuredClone(value); fn(next); value = next; return structuredClone(next); },
  };
  model.ensureAccountState(store);
  const teacher = model.saveTeacher(store, { name: '测试创作者' });
  const account = model.saveManagedAccount(store, { teacherId: teacher.id, platform: 'douyin', label: '测试创作者抖音' });
  let readCount = 0;
  let forcePending = false;
  let capturedVerify = null;
  let open = true;
  const fakeDriver = {
    isOpen: () => open,
    focus: async () => {},
    read: async () => {
      readCount++;
      if (forcePending && readCount <= 4) {
        return { state: 'checking', identity: null, message: '正在加载首页' };
      }
      return { state: 'identified', identity: { platformAccountId: 'demo_dy_001', displayName: '测试创作者' }, message: '已识别' };
    },
    createPublisher: ({ verifyIdentity }) => {
      capturedVerify = verifyIdentity;
      return { verify: verifyIdentity };
    },
    close: async () => { open = false; },
  };
  const mb = new ManagedBrowsers({
    store,
    profilesRoot: '/synthetic/not-used',
    launch: async () => fakeDriver,
    availability: () => [{ id: 'chrome', available: true }],
    pollMs: 40,
    checkingMs: 3000,
  });
  t.after(() => mb.closeAll());
  await mb.open({ accountId: account.id, browserKind: 'chrome', autoBind: true });
  const bound = store.load().accounts.find(a => a.id === account.id);
  forcePending = true;
  readCount = 0;
  await mb.publisherFor(
    { accountId: bound.id, teacherId: teacher.id, expectedBinding: bound.binding },
    { diagnosticsRoot: '', onVerifyFiles: async () => {} },
  );
  await assert.doesNotReject(() => capturedVerify());
  assert.ok(readCount >= 5);
});

test('2026-11-21 真实抖音定时作品校准：timer.public_time 识别 scheduled 并按精确预定分钟匹配', () => {
  const payload = {
    status_code: 0,
    aweme_list: [
      {
        aweme_id: '1000000000000000001',
        item_id: 1000000000000000000,
        item_title: '定时发布验证示例B',
        create_time: 1795320000,
        status_value: 140,
        timer: { public_time: 1795320000, status: 0 },
        status: {
          aweme_id: '1000000000000000001',
          in_reviewing: false,
          is_delete: false,
          is_private: true,
          is_prohibited: false,
          private_status: 1,
          reviewed: false,
        },
        video: { duration: 600000 },
      },
      {
        aweme_id: '1000000000000000002',
        item_title: '定时发布验证示例A',
        create_time: 1795244289,
        status_value: 141,
        status: {
          aweme_id: '1000000000000000002',
          in_reviewing: false,
          is_delete: false,
          is_private: true,
          is_prohibited: false,
          private_status: 1,
          reviewed: false,
        },
        video: { duration: 8010 },
      },
    ],
  };
  const { items } = parseDouyinWorkListResponse(payload);
  assert.equal(items[0].workId, '1000000000000000001');
  assert.equal(items[0].platformStatus, 'scheduled');
  assert.equal(items[0].visibility, 'self');
  assert.equal(items[0].duration, '10:00');
  assert.equal(items[0].publishedAt, '2026年11月22日 12:00');
  assert.equal(items[1].platformStatus, 'published');

  const ok = matchDouyinWorkListItem(items, {
    copy: { title: '定时发布验证示例B' },
    runCreatedAt: '2026-11-21T07:43:13Z',
    schedule: { mode: 'scheduled', at: '2026-11-22T12:00', timeZone: 'Asia/Shanghai' },
  });
  assert.equal(ok.status, 'matched');
  assert.equal(ok.item.workId, '1000000000000000001');

  const wrongMinute = matchDouyinWorkListItem(items, {
    copy: { title: '定时发布验证示例B' },
    runCreatedAt: '2026-11-21T07:43:13Z',
    schedule: { mode: 'scheduled', at: '2026-11-22T14:00', timeZone: 'Asia/Shanghai' },
  });
  assert.equal(wrongMinute.status, 'none');

  const cardText = '10:00\n定时发布验证示例B 描述\n继续编辑\n删除作品\n2026年11月22日 12:00\n私密\n播放\n-';
  const rec = listRecordEvidence(cardText, {
    copy: { title: '定时发布验证示例B' },
    runCreatedAt: '2026-11-21T07:43:13Z',
    schedule: { mode: 'scheduled', at: '2026-11-22T12:00', timeZone: 'Asia/Shanghai' },
  });
  assert.equal(rec.platformStatus, 'scheduled');
  assert.equal(rec.visibility, 'self');
  assert.equal(rec.duration, '10:00');
  assert.equal(rec.publishedAt, '2026年11月22日 12:00');
});

test('ManagedBrowsers.publisherFor 冷启动首次核查复用刚打开的首页，第二次（提交前）仍强制 fresh 复查', async t => {
  const model = require('../app/core/accounts.cjs');
  const { ManagedBrowsers } = require('../app/core/managed-browser.cjs');
  let value = { schemaVersion: 1 };
  const store = {
    load: () => structuredClone(value),
    update: fn => { const next = structuredClone(value); fn(next); value = next; return structuredClone(next); },
  };
  model.ensureAccountState(store);
  const teacher = model.saveTeacher(store, { name: '测试创作者' });
  const account = model.saveManagedAccount(store, { teacherId: teacher.id, platform: 'douyin', label: '测试创作者抖音' });
  let freshReadCount = 0;
  let capturedVerify = null;
  let open = false;
  const fakeDriver = {
    isOpen: () => open,
    focus: async () => {},
    read: async ({ fresh = false } = {}) => {
      if (fresh) freshReadCount++;
      return { state: 'identified', identity: { platformAccountId: 'demo_dy_001', displayName: '测试创作者' }, serverCheckedAt: Date.now(), message: '已识别' };
    },
    createPublisher: ({ verifyIdentity }) => {
      capturedVerify = verifyIdentity;
      return { verify: verifyIdentity };
    },
    close: async () => { open = false; },
  };
  const mb = new ManagedBrowsers({
    store,
    profilesRoot: '/synthetic/not-used',
    launch: async () => { open = true; return fakeDriver; },
    availability: () => [{ id: 'chrome', available: true }],
    pollMs: 40,
    checkingMs: 3000,
  });
  t.after(() => mb.closeAll());
  await mb.open({ accountId: account.id, browserKind: 'chrome', autoBind: true });
  await mb.close(account.id);
  freshReadCount = 0;
  const bound = store.load().accounts.find(a => a.id === account.id);
  await mb.publisherFor(
    { accountId: bound.id, teacherId: teacher.id, expectedBinding: bound.binding },
    { diagnosticsRoot: '', onVerifyFiles: async () => {} },
  );
  // 首次 verify 复用刚 open 的新鲜结果，不重复 reload
  await assert.doesNotReject(() => capturedVerify());
  assert.equal(freshReadCount, 0);
  // 第二次 verify（模拟提交前）必须执行一次 fresh 复查
  await assert.doesNotReject(() => capturedVerify());
  assert.equal(freshReadCount, 1);
});
