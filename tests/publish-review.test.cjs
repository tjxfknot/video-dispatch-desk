'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JsonStore } = require('../app/core/store.cjs');
const { emptyState, exportReport, recoverRuns } = require('../app/core/domain.cjs');
const { reviewManagedPublish } = require('../app/core/publish-review.cjs');
const { ManagedPublisher } = require('../app/core/managed-publisher.cjs');
const { buildManagedJob } = require('../app/core/managed-publish-job.cjs');
const { recordForRun } = require('../app/renderer/publish-record-model.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = path.join(dir, '素材');fs.mkdirSync(media);
  const file = path.join(media, 'video.mp4');fs.writeFileSync(file, 'synthetic-video');
  const stat = fs.statSync(file), video = { id: 'video', kind: 'video', path: file, name: 'video.mp4', size: stat.size, mtimeMs: stat.mtimeMs };
  const platforms = ['douyin', 'tencent'];
  const state = { ...emptyState(), accountEnvironmentVersion: 2, assets: [video], teachers: [{ id: 'teacher', name: '合成老师' }],
    environments: platforms.map(p => ({ id: p, source: 'managed_browser', platform: p, teacherId: 'teacher' })),
    accounts: platforms.map(p => ({ id: p, teacherId: 'teacher', platform: p, status: 'bound', label: '原账号'+p, browserEnvironmentId: p,
      binding: { source: 'managed_browser', revision: 'r1', environmentId: p, platformAccountId: 'synthetic_'+p } })) };
  const draft = { teacherId: 'teacher', video, common: { title: '合成发布标题六个字', description: '', tags: ['合成话题'] },
    targets: platforms.map(p => ({ platform: p, enabled: true, accountId: p, ...(p==='douyin'?{specialSettings:{visibility:'self'}}:{}) })) };
  const store = new JsonStore(path.join(dir, 'library.json'), state), notices = [];
  store.load();
  const review = () => reviewManagedPublish({ draft, store, appVersion: '0.6.12-alpha.10', onBlocked: run => notices.push(run) });
  return { dir, media, video, draft, store, notices, review };
}

test('素材目录改名后的失败留在发布记录，重开库仍能读到内容、账号和检查版本', t => {
  const f = fixture(t);
  fs.renameSync(f.media, path.join(f.dir, '素材_改名后'));
  assert.throws(f.review, /素材不存在[\s\S]*已保存在发布记录/);
  const data = new JsonStore(f.store.filePath, {}).load(), run = data.runs[0];
  assert.equal(data.runs.length, 1);assert.equal(run.mode, 'publish_check');
  assert.equal(run.appVersion, '0.6.12-alpha.10');assert.equal(run.result, null);
  assert.equal(f.notices.length, 1);
  const record = recordForRun(run, data);
  assert.equal(record.isRehearsal, false);assert.equal(record.rows.length, 2);
  assert.equal(record.statusLabel, '未启动 · 发布前检查未通过');
  assert.equal(record.title, f.draft.common.title);assert.equal(record.teacherLabel, '合成老师');
  assert.match(record.rows[0].accountLabel, /原账号/);assert.match(record.issue, /video.mp4/);
  assert.equal(record.submittedAt, '');assert.equal(record.publishedAt, '');
  for (const row of record.rows) { assert.equal(row.statusKey, 'precheck_failed');assert.equal(row.workId, ''); }
  const report = exportReport(run);
  assert.equal(report.appVersion, run.appVersion);assert.match(report.notice, /未启动上传或提交/);
  assert.doesNotMatch(JSON.stringify(report), /dispatch-review-test-|\/素材\//);
});

test('检查失败不启动执行器，程序恢复也不会上传、批准或重跑，原失败记录不被改写', t => {
  const f = fixture(t), old = { id: 'old', mode: 'managed_prepare', status: 'failed', events: [{ time: '2026-11-11', status: 'failed', message: '原失败' }] };
  f.store.update(d => d.runs.push(old));fs.unlinkSync(f.video.path);
  assert.throws(f.review);const check = f.store.load().runs.find(r => r.mode === 'publish_check');
  let executions = 0;
  recoverRuns(f.store);
  const publisher = new ManagedPublisher({ store: f.store, buildJob: buildManagedJob, getExecutor: async () => { executions++;throw new Error('不应执行'); } });
  assert.equal(executions, 0);assert.equal(publisher.snapshot()[check.id], undefined);
  assert.deepEqual(f.store.load().runs.find(r => r.id === 'old'), old);
  assert.deepEqual(f.store.load().runs.find(r => r.id === check.id), check);
  assert.throws(() => publisher.run(check.id), /不属于本服务/);
});

test('正常总览保持只读，不产生一次失败或一次上传任务', t => {
  const f = fixture(t), before = fs.readFileSync(f.store.filePath);
  const result = f.review();assert.equal(result.targets.length, 2);assert.equal(result.files.length, 1);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(f.store.filePath), before);assert.equal(f.notices.length, 0);
});

test('可能已发布的同视频仍拒绝重发，只新增未启动检查，不覆盖原平台凭据', t => {
  const f = fixture(t), draft = { ...f.draft, targets: f.draft.targets.map(p => ({ ...p, enabled: p.platform==='douyin' })) };
  const job = buildManagedJob(draft, f.store.load());
  const old = { id: 'maybe-submitted', mode: 'managed_prepare', platform: 'douyin', accountId: 'douyin', status: 'awaiting_verification',
    videoKey: job.videoKey, expectedBinding: job.expectedBinding, snapshot: job.draft, events: [], result: { workId: 'synthetic' } };
  f.store.update(d => d.runs.push(old));assert.throws(f.review, /不能重发/);
  assert.deepEqual(f.store.load().runs[0], old);assert.equal(f.store.load().runs[1].mode, 'publish_check');
});

test('记录写盘失败时如实说明没有保存，不把通知成功或原错误当作已留档', t => {
  const f = fixture(t);fs.unlinkSync(f.video.path);
  const store = { load: () => f.store.load(), update: () => { throw new Error('合成磁盘写入失败'); } };
  assert.throws(() => reviewManagedPublish({ draft: f.draft, store, onBlocked: () => { throw new Error('不应通知'); } }),
    e => /素材不存在/.test(e.message) && /未能保存.*合成磁盘写入失败/.test(e.message) && !e.message.includes('已保存在发布记录'));
  assert.equal(f.store.load().runs.length, 0);
});

test('无法规范化的输入不保存客户端伪造路径或任意字段', t => {
  const f = fixture(t);
  const draft = { common: { title: '坏输入' }, video: { id: 'unknown', path: '/private/should-not-save' }, secret: 'should-not-save' };
  assert.throws(() => reviewManagedPublish({ draft, store: f.store }), /已保存在发布记录/);
  const run = f.store.load().runs[0], record = recordForRun(run);
  assert.equal(record.isRehearsal, false);assert.equal(record.statusKey, 'precheck_failed');assert.match(record.issue, /素材未经/);
  assert.doesNotMatch(JSON.stringify(run), /should-not-save/);
});

test('检查记录即使混入错误的作品结果也不能显示为已提交或发布成功', () => {
  const record = recordForRun({ mode: 'publish_check', status: 'submitted', snapshot: { common: { title: '检查记录' }, targets: [{ platform: 'douyin', enabled: true }] },
    message: '本次检查失败', result: { platformStatus: 'published', publishedAt: '2026-11-13', workId: 'wrong' }, events: [{ status: 'submitting', time: '2026-11-13' }] });
  assert.equal(record.statusKey, 'precheck_failed');assert.equal(record.submittedAt, '');assert.equal(record.publishedAt, '');assert.equal(record.rows[0].workId, '');
});

test('真实任务保存创建时的程序版本，重启不会改成新版本', t => {
  const f = fixture(t);f.draft.targets = f.draft.targets.map(p => ({...p, enabled: p.platform==='douyin'}));
  const publisher = new ManagedPublisher({ store:f.store, appVersion:'0.6.12-alpha.10', buildJob:buildManagedJob,
    getExecutor:async()=>{throw new Error('隔离测试不执行平台动作');} });
  const run = publisher.start({draft:f.draft,requestId:'version_record_test_0001',executionMode:'prepare_only'});
  assert.equal(run.appVersion,'0.6.12-alpha.10');
  new ManagedPublisher({store:f.store,appVersion:'0.6.12-alpha.11',buildJob:buildManagedJob,getExecutor:async()=>{throw new Error('不应执行');}});
  assert.equal(f.store.load().runs.find(r=>r.id===run.id).appVersion,'0.6.12-alpha.10');
});
