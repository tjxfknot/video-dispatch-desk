'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordForRun } = require('../app/renderer/publish-record-model.js');

const clone = value => structuredClone(value);
const WORK_ID = '1234567890123456789';
const WORK_URL = `https://www.douyin.com/video/${WORK_ID}`;

function managedRun(overrides = {}) {
  return {
    id: 'run-managed',
    mode: 'managed_prepare',
    status: 'submitted',
    createdAt: '2026-11-07T03:30:00.000Z',
    updatedAt: '2026-11-07T04:30:00.000Z',
    teacherId: 'teacher-1',
    teacherLabel: '王老师',
    platform: 'douyin',
    snapshot: {
      teacherId: 'teacher-1',
      common: { title: '历史标题', description: '历史简介', tags: ['历史标签'] },
      video: { name: '历史视频.mp4' },
      schedule: { mode: 'scheduled', at: '2026-11-08T10:00', timeZone: 'Asia/Shanghai' },
      covers: { landscape: { name: '公共横版.png' }, portrait: { name: '公共竖版.png' } },
      targets: [{
        platform: 'douyin',
        enabled: true,
        inherit: true,
        accountId: 'acct-old',
        title: '目标标题',
        description: '目标简介',
        tags: ['目标标签'],
        covers: { landscape: { name: '目标横版.png' }, portrait: null },
        declaration: { required: false, text: '' },
        collection: { required: false, name: '' },
        specialSettings: { visibility: 'self', savePermission: 'deny' }
      }]
    },
    summary: [{
      platform: 'douyin',
      account: '旧账号备注',
      title: '历史标题',
      description: '历史简介',
      tags: ['历史标签'],
      covers: { landscape: '历史横版.png' },
      declaration: '不设置',
      collection: '不加入合集',
      schedule: { mode: 'scheduled', at: '2026-11-08T10:00', timeZone: 'Asia/Shanghai' },
      specialSettings: { visibility: 'self', savePermission: 'deny' }
    }],
    expectedBinding: { revision: 'r1', environmentId: 'env-1', platformAccountId: 'platform-old' },
    items: [{ id: 'run-managed:item', status: 'submitted', message: '已提交' }],
    events: [
      { time: '2026-11-07T03:31:00.000Z', itemId: 'run-managed:item', status: 'queued', message: '任务已排队' },
      { time: '2026-11-07T03:32:00.000Z', itemId: 'run-managed:item', status: 'submitting', message: '正在提交' },
      { time: '2026-11-07T03:33:00.000Z', itemId: 'run-managed:item', status: 'submitted', message: '已提交' }
    ],
    result: { status: 'submitted', workId: WORK_ID, workUrl: WORK_URL },
    ...overrides
  };
}

test('历史内容只取原任务，不被当前老师、账号或草稿覆盖', () => {
  const run = managedRun();
  const context = {
    teachers: [{ id: 'teacher-1', name: '王老师（当前改名）' }],
    accounts: [{ id: 'acct-old', platform: 'douyin', label: '当前账号新备注' }],
    platforms: [{ id: 'douyin', label: '抖音' }],
    currentDraft: { common: { title: '当前草稿标题', tags: ['当前标签'] } },
    currentAccount: { id: 'acct-old', label: '当前账号新备注' }
  };

  const record = recordForRun(run, context);
  assert.equal(record.title, '历史标题');
  assert.equal(record.teacherLabel, '王老师');
  assert.equal(record.rows[0].accountLabel, '旧账号备注');
  assert.equal(record.rows[0].title, '历史标题');
  assert.equal(record.rows[0].description, '历史简介');
  assert.deepEqual(record.rows[0].tags, ['历史标签']);
  assert.equal(record.rows[0].videoName, '历史视频.mp4');
  assert.equal(record.rows[0].platformAccountId, 'platform-old');
  assert.equal(record.rows[0].workUrl, WORK_URL);
  assert.equal(record.rows[0].platformStatus, '');
});

test('真实准备阶段失败显示未发布·准备失败，不产生提交或发布时间', () => {
  const message = '发布前检查未全部通过，未提交：covers';
  const run = managedRun({
    status: 'failed',
    message,
    result: null,
    items: [{ id: 'run-managed:item', status: 'failed', message }],
    events: [
      { time: '2026-11-07T03:31:00.000Z', itemId: 'run-managed:item', status: 'queued', message: '任务已排队' },
      { time: '2026-11-07T03:32:00.000Z', itemId: 'run-managed:item', status: 'failed', message }
    ]
  });

  const record = recordForRun(run);
  assert.equal(record.statusKey, 'prep_failed');
  assert.equal(record.statusLabel, '未发布 · 准备失败');
  assert.equal(record.tone, 'danger');
  assert.equal(record.rows[0].statusKey, 'prep_failed');
  assert.match(record.issue, /covers/);
  assert.equal(record.submittedAt, '');
  assert.equal(record.publishedAt, '');
  assert.equal(record.rows[0].publishedAt, '');
});

test('已提交但平台未回传审核状态时，只显示已提交·待平台确认', () => {
  const run = managedRun({ result: { status: 'submitted', workId: WORK_ID, workUrl: WORK_URL } });
  const record = recordForRun(run);

  assert.equal(record.statusKey, 'submitted_unknown');
  assert.equal(record.statusLabel, '已提交 · 待平台确认');
  assert.notEqual(record.tone, 'success');
  assert.equal(record.rows[0].statusLabel, '已提交 · 待平台确认');
  assert.equal(record.rows[0].platformStatus, '');
  assert.equal(record.publishedAt, '');
  assert.equal(record.rows[0].publishedAt, '');
});

test('平台明确 under_review 时显示审核中', () => {
  const base = managedRun().result;
  const run = managedRun({ result: { ...base, platformStatus: 'under_review' } });
  const record = recordForRun(run);

  assert.equal(record.statusKey, 'under_review');
  assert.equal(record.statusLabel, '审核中');
  assert.equal(record.tone, 'pending');
  assert.equal(record.rows[0].platformStatus, 'under_review');
  assert.equal(record.publishedAt, '');
});

test('只有平台明确 published 才显示发布成功，并保留平台原始发布时间字符串', () => {
  const base = managedRun().result;
  const publishedAt = '2026年11月07日 12:00';
  const run = managedRun({
    result: { ...base, platformStatus: 'published', publishedAt }
  });
  const record = recordForRun(run);

  assert.equal(record.statusKey, 'published');
  assert.equal(record.statusLabel, '发布成功');
  assert.equal(record.tone, 'success');
  assert.equal(record.rows[0].platformStatus, 'published');
  assert.equal(record.publishedAt, publishedAt);
  assert.equal(record.rows[0].publishedAt, publishedAt);
  assert.notEqual(record.publishedAt, run.createdAt);
  assert.notEqual(record.publishedAt, run.updatedAt);
  assert.equal(record.rows[0].workUrl, WORK_URL);
});

test('平台明确 rejected 时显示审核未通过，并保留平台原因', () => {
  const base = managedRun().result;
  const run = managedRun({
    result: { ...base, platformStatus: 'rejected', message: '平台审核未通过：社区规范' }
  });
  const record = recordForRun(run);

  assert.equal(record.statusKey, 'rejected');
  assert.equal(record.statusLabel, '审核未通过');
  assert.equal(record.tone, 'danger');
  assert.match(record.issue, /社区规范/);
  assert.notEqual(record.tone, 'success');
});

test('本地演练即使带有伪造回执也不显示发布成功，不输出作品字段或发布时间', () => {
  const run = {
    id: 'rehearsal-1',
    mode: 'rehearsal',
    status: 'awaiting_review',
    createdAt: '2026-11-07T01:00:00.000Z',
    updatedAt: '2026-11-07T01:05:00.000Z',
    snapshot: {
      common: { title: '演练标题' },
      video: { name: '演练.mp4' },
      schedule: { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' },
      targets: [{
        platform: 'tencent', enabled: true, accountId: 't1', inherit: true,
        title: '', covers: {}, declaration: { required: false, text: '' },
        collection: { required: false, name: '' }
      }]
    },
    summary: [{
      platform: 'tencent', account: '视频号演练账号', title: '演练标题',
      description: '', tags: [], covers: {}, declaration: '不设置',
      collection: '不加入合集',
      schedule: { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' }
    }],
    items: [{
      id: 'rehearsal-1:item', platform: 'tencent', accountId: 't1',
      status: 'awaiting_review', detail: '演练完成，未上传'
    }],
    events: [{ at: '2026-11-07T01:05:00.000Z', status: 'awaiting_review', message: '演练完成，未上传' }],
    result: { status: 'submitted', platformStatus: 'published', publishedAt: '2026-11-07 12:00' },
    platformStatus: 'published',
    workId: WORK_ID,
    workUrl: WORK_URL
  };

  const record = recordForRun(run, { platforms: [{ id: 'tencent', label: '视频号' }] });
  assert.equal(record.isRehearsal, true);
  assert.equal(record.statusKey, 'awaiting_review');
  assert.equal(record.statusLabel, '演练完成 · 未上传');
  assert.notEqual(record.tone, 'success');
  assert.equal(record.submittedAt, '');
  assert.equal(record.publishedAt, '');
  assert.equal(record.rows[0].workId, '');
  assert.equal(record.rows[0].workUrl, '');
  assert.equal(record.rows[0].platformStatus, '');
  assert.equal(record.rows[0].publishedAt, '');
});

test('跨平台一成功一失败时，顶部显示部分平台已发布并要求逐平台核对', () => {
  const run = {
    id: 'mixed-1',
    mode: 'managed_prepare',
    status: 'submitted',
    platform: 'douyin',
    createdAt: '2026-11-07T01:00:00.000Z',
    teacherLabel: '李老师',
    snapshot: {
      common: { title: '混合任务', description: '混合简介', tags: ['混合标签'] },
      video: { name: '混合.mp4' },
      targets: [
        { platform: 'douyin', enabled: true, inherit: true, accountId: 'd1' },
        { platform: 'tencent', enabled: true, inherit: true, accountId: 't1' }
      ]
    },
    summary: [
      { platform: 'douyin', account: '抖音原账号', title: '抖音标题', tags: ['抖音标签'] },
      { platform: 'tencent', account: '视频号原账号', title: '视频号标题', tags: ['视频号标签'] }
    ],
    items: [
      { id: 'mixed-1:d', platform: 'douyin', status: 'submitted', message: '已提交' },
      { id: 'mixed-1:t', platform: 'tencent', status: 'failed', message: '准备阶段缺少封面' }
    ],
    events: [
      { time: '2026-11-07T01:10:00.000Z', itemId: 'mixed-1:d', status: 'submitting' },
      { time: '2026-11-07T01:11:00.000Z', itemId: 'mixed-1:d', status: 'submitted' }
    ],
    result: {
      status: 'submitted', platformStatus: 'published', publishedAt: '2026-11-07 09:11',
      workId: WORK_ID, workUrl: WORK_URL
    }
  };

  const record = recordForRun(run);
  assert.equal(record.rows.length, 2);
  assert.equal(record.rows[0].statusKey, 'published');
  assert.equal(record.rows[1].statusKey, 'prep_failed');
  assert.equal(record.statusKey, 'mixed_published');
  assert.notEqual(record.tone, 'success');
  assert.match(record.statusLabel, /部分平台已发布（1\/2）/);
  assert.match(record.statusLabel, /需逐平台核对/);
  assert.match(record.issue, /视频号/);
  assert.match(record.issue, /未发布 · 准备失败/);
  assert.notEqual(record.publishedAt, '2026-11-07 09:11');
});

test('创建时间、首次 submitting 提交时间和平台 publishedAt 分别取正确来源', () => {
  const run = managedRun({
    createdAt: '2026-11-07T01:00:00.000Z',
    updatedAt: '2026-11-07T09:00:00.000Z',
    events: [
      { time: '2026-11-07T01:05:00.000Z', itemId: 'run-managed:item', status: 'queued' },
      { time: '2026-11-07T01:10:00.000Z', itemId: 'run-managed:item', status: 'submitting' },
      { time: '2026-11-07T01:11:00.000Z', itemId: 'run-managed:item', status: 'submitted' }
    ],
    result: {
      ...managedRun().result,
      platformStatus: 'published',
      publishedAt: '2026-11-07 09:15 北京时间'
    }
  });

  const record = recordForRun(run);
  assert.equal(record.createdAt, '2026-11-07T01:00:00.000Z');
  assert.equal(record.submittedAt, '2026-11-07T01:10:00.000Z');
  assert.notEqual(record.submittedAt, record.createdAt);
  assert.notEqual(record.submittedAt, run.updatedAt);
  assert.equal(record.publishedAt, '2026-11-07 09:15 北京时间');
  assert.equal(record.rows[0].submittedAt, '2026-11-07T01:10:00.000Z');
  assert.equal(record.rows[0].publishedAt, '2026-11-07 09:15 北京时间');

  const noPublishedAt = managedRun({ result: { ...managedRun().result, platformStatus: 'published' } });
  const another = recordForRun(noPublishedAt);
  assert.equal(another.statusLabel, '发布成功');
  assert.equal(another.publishedAt, '');
  assert.equal(another.rows[0].publishedAt, '');
});

test('优先平台 summary 文案并保留 tags 当时值，inherit=false 用 target、inherit=true 用 common', () => {
  const run = {
    id: 'content-1',
    mode: 'rehearsal',
    status: 'awaiting_review',
    snapshot: {
      common: {
        title: '公共标题', description: '公共简介', tags: ['公共标签']
      },
      covers: { landscape: { name: '公共横.png' }, portrait: { name: '公共竖.png' } },
      schedule: { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' },
      targets: [
        {
          platform: 'douyin', enabled: true, inherit: false, accountId: 'd1',
          title: '抖音目标标题', description: '抖音目标简介', tags: ['抖音目标标签'],
          covers: { landscape: { name: '抖音目标横.png' }, portrait: null }
        },
        {
          platform: 'tencent', enabled: true, inherit: true, accountId: 't1',
          title: '腾讯目标标题（inherit=true 时不应采用）', description: '腾讯目标简介',
          tags: ['腾讯目标标签'], covers: { landscape: { name: '腾讯目标横.png' }, portrait: null }
        }
      ]
    },
    summary: [{
      platform: 'douyin', title: '摘要抖音标题', description: '摘要抖音简介',
      tags: ['摘要标签', '摘要标签'],
      covers: { landscape: '摘要横.png', portrait: '摘要竖.png' }
    }],
    items: [
      { id: 'content-1:d', platform: 'douyin', status: 'awaiting_review' },
      { id: 'content-1:t', platform: 'tencent', status: 'awaiting_review' }
    ],
    events: []
  };

  const record = recordForRun(run);
  const douyin = record.rows[0];
  const tencent = record.rows[1];

  assert.equal(douyin.title, '摘要抖音标题');
  assert.equal(douyin.description, '摘要抖音简介');
  assert.deepEqual(douyin.tags, ['摘要标签', '摘要标签']);
  assert.deepEqual(douyin.covers, { landscape: '摘要横.png', portrait: '摘要竖.png' });

  assert.equal(tencent.title, '公共标题');
  assert.equal(tencent.description, '公共简介');
  assert.deepEqual(tencent.tags, ['公共标签']);
  assert.deepEqual(tencent.covers, { landscape: '公共横.png', portrait: '公共竖.png' });
  assert.notEqual(tencent.title, '腾讯目标标题（inherit=true 时不应采用）');
});

test('缺字段时保守留空，不抛错也不发明状态', () => {
  const record = recordForRun({ id: 'minimal' });
  assert.deepEqual(record, {
    id: 'minimal',
    isRehearsal: true,
    title: '',
    teacherLabel: '老师未记录',
    statusKey: 'unknown',
    statusLabel: '状态未知',
    tone: 'neutral',
    createdAt: '',
    submittedAt: '',
    publishedAt: '',
    issue: '',
    rows: [],
    events: []
  });

  const empty = recordForRun();
  assert.equal(empty.id, '');
  assert.equal(empty.isRehearsal, true);
  assert.equal(empty.teacherLabel, '老师未记录');
  assert.deepEqual(empty.rows, []);
});

test('不修改输入对象，输出也不与输入共享可变引用', () => {
  const run = managedRun();
  const context = {
    teachers: [{ id: 'teacher-1', name: '王老师（当前改名）' }],
    accounts: [{ id: 'acct-old', platform: 'douyin', label: '当前账号新备注' }],
    platforms: [{ id: 'douyin', label: '抖音' }]
  };
  const runBefore = clone(run);
  const contextBefore = clone(context);

  const record = recordForRun(run, context);
  assert.deepEqual(run, runBefore);
  assert.deepEqual(context, contextBefore);

  record.rows[0].tags.push('输出新增标签');
  record.rows[0].covers.landscape = '输出修改封面';
  record.rows[0].schedule.at = '2099-01-01T00:00';
  assert.deepEqual(run, runBefore);
  assert.deepEqual(context, contextBefore);
});

test('HTML 字符串原样作为纯数据返回，不执行也不做 DOM 解析', () => {
  const html = '<img src=x onerror="globalThis.__publishRecordModelPwned=1">';
  const script = '<script>globalThis.__publishRecordModelPwned=2</script>';
  const run = managedRun();
  run.snapshot.common.title = html;
  run.summary[0].title = html;
  run.summary[0].description = script;
  run.summary[0].tags = ['<b>标签</b>'];

  const record = recordForRun(run);
  assert.equal(record.title, html);
  assert.equal(record.rows[0].title, html);
  assert.equal(record.rows[0].description, script);
  assert.deepEqual(record.rows[0].tags, ['<b>标签</b>']);
  assert.equal(globalThis.__publishRecordModelPwned, undefined);
  delete globalThis.__publishRecordModelPwned;
});

test('仅一个 item 且没有 platform 时，按 run.platform 和 summary 对应', () => {
  const run = {
    id: 'single-item',
    mode: 'managed_prepare',
    status: 'submitted',
    platform: 'douyin',
    createdAt: '2026-11-07T01:00:00.000Z',
    teacherId: 'teacher-1',
    snapshot: {
      common: { title: '单条历史标题' },
      video: { name: '单条.mp4' },
      targets: [{ platform: 'douyin', enabled: true, inherit: true, accountId: 'a1' }]
    },
    summary: [{
      platform: 'douyin', account: '抖音原账号', title: '抖音摘要标题',
      tags: ['抖音标签'], covers: { landscape: '抖音封面.png' }
    }],
    items: [{ id: 'single-item:item', status: 'submitted', message: '已提交' }],
    events: [
      { time: '2026-11-07T02:00:00.000Z', itemId: 'single-item:item', status: 'submitting' }
    ],
    expectedBinding: { platformAccountId: 'pa-single' },
    result: {
      status: 'submitted', platformStatus: 'published', publishedAt: '2026-11-07 10:00',
      workId: WORK_ID, workUrl: WORK_URL
    }
  };

  const record = recordForRun(run);
  assert.equal(record.rows.length, 1);
  assert.equal(record.rows[0].platform, 'douyin');
  assert.equal(record.rows[0].platformLabel, '抖音');
  assert.equal(record.rows[0].title, '抖音摘要标题');
  assert.equal(record.rows[0].accountLabel, '抖音原账号');
  assert.equal(record.rows[0].platformAccountId, 'pa-single');
  assert.equal(record.rows[0].statusKey, 'published');
  assert.equal(record.rows[0].submittedAt, '2026-11-07T02:00:00.000Z');
});

test('awaiting_verification 显示结果待核查，提交后失败显示提交后异常·待核查', () => {
  const awaiting = managedRun({
    status: 'awaiting_verification',
    message: '提交超时，未取得可靠作品凭据，请人工核查',
    result: null,
    items: [{ id: 'run-managed:item', status: 'awaiting_verification', message: '结果待核查' }],
    events: [
      { time: '2026-11-07T03:31:00.000Z', itemId: 'run-managed:item', status: 'queued' },
      { time: '2026-11-07T03:32:00.000Z', itemId: 'run-managed:item', status: 'submitting' },
      { time: '2026-11-07T03:33:00.000Z', itemId: 'run-managed:item', status: 'awaiting_verification' }
    ]
  });
  const first = recordForRun(awaiting);
  assert.equal(first.statusKey, 'awaiting_verification');
  assert.equal(first.statusLabel, '结果待核查');
  assert.notEqual(first.statusLabel, '未发布');
  assert.equal(first.tone, 'attention');
  assert.match(first.issue, /人工核查/);
  assert.equal(first.submittedAt, '2026-11-07T03:32:00.000Z');
  assert.equal(first.publishedAt, '');

  const failedAfterSubmit = managedRun({
    status: 'failed',
    message: '提交异常，未取得可靠作品凭据，请人工核查',
    result: null,
    items: [{ id: 'run-managed:item', status: 'failed', message: '提交异常' }],
    events: [
      { time: '2026-11-07T03:31:00.000Z', itemId: 'run-managed:item', status: 'queued' },
      { time: '2026-11-07T03:32:00.000Z', itemId: 'run-managed:item', status: 'submitting' },
      { time: '2026-11-07T03:33:00.000Z', itemId: 'run-managed:item', status: 'failed' }
    ]
  });
  const second = recordForRun(failedAfterSubmit);
  assert.equal(second.statusKey, 'after_submit_issue');
  assert.equal(second.statusLabel, '提交后异常 · 待核查');
  assert.equal(second.tone, 'danger');
  assert.match(second.issue, /人工核查/);
  assert.doesNotMatch(second.statusLabel, /可重试/);
});

test('prepared 与 awaiting_confirmation 都显示未发布·待确认', () => {
  for (const status of ['prepared', 'awaiting_confirmation']) {
    const run = managedRun({
      status,
      result: null,
      items: [{ id: 'run-managed:item', status }],
      events: [
        { time: '2026-11-07T03:31:00.000Z', itemId: 'run-managed:item', status: 'queued' },
        { time: '2026-11-07T03:32:00.000Z', itemId: 'run-managed:item', status }
      ]
    });
    const record = recordForRun(run);
    assert.equal(record.statusKey, 'not_confirmed', status);
    assert.equal(record.statusLabel, '未发布 · 待确认', status);
    assert.notEqual(record.tone, 'success', status);
    assert.equal(record.publishedAt, '', status);
  }
});

test('managed_prepare、douyin_pilot、chrome_prepare 按真实处理，未知本地模式不显示成功', () => {
  for (const mode of ['managed_prepare', 'douyin_pilot', 'chrome_prepare']) {
    const run = managedRun({
      mode,
      result: {
        status: 'submitted', platformStatus: 'published', publishedAt: '2026-11-07 10:00',
        workId: WORK_ID, workUrl: WORK_URL
      }
    });
    const record = recordForRun(run);
    assert.equal(record.isRehearsal, false, mode);
    assert.equal(record.statusLabel, '发布成功', mode);
    assert.equal(record.tone, 'success', mode);
  }

  const unknown = managedRun({
    mode: 'local_unknown',
    result: {
      status: 'submitted', platformStatus: 'published', publishedAt: '2026-11-07 10:00',
      workId: WORK_ID, workUrl: WORK_URL
    }
  });
  const record = recordForRun(unknown);
  assert.equal(record.isRehearsal, true);
  assert.notEqual(record.statusLabel, '发布成功');
  assert.notEqual(record.tone, 'success');
});

test('只有原回执里的作品链接才输出，绝不拿作品编号拼接 URL', () => {
  const run = managedRun({
    result: { status: 'submitted', platformStatus: 'published', workId: WORK_ID }
  });
  const record = recordForRun(run);
  assert.equal(record.statusLabel, '发布成功');
  assert.equal(record.rows[0].workId, WORK_ID);
  assert.equal(record.rows[0].workUrl, '');
  assert.equal(record.publishedAt, '');
  assert.doesNotMatch(JSON.stringify(record), /douyin\.com\/video/);
});

test('同构：浏览器挂载 window.PublishRecordModel，Node 只导出 recordForRun', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../app/renderer/publish-record-model.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'publish-record-model.js' });
  assert.deepEqual(Object.keys(window.PublishRecordModel), ['recordForRun']);
  assert.deepEqual(Object.keys(require('../app/renderer/publish-record-model.js')), ['recordForRun']);
  assert.equal(window.PublishRecordModel.recordForRun({ id: 'browser' }).id, 'browser');
});
