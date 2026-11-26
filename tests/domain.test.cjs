'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../app/core/domain.cjs');

function fixture() {
  const state = d.emptyState();
  const video = { id: 'video', kind: 'video', name: '测试.mp4', path: '/test-fixtures/test.mp4', size: 8, mtimeMs: 100 };
  const landscape = { id: 'landscape', kind: 'landscape', name: '横封面.png', path: '/test-fixtures/cover.png', size: 8, mtimeMs: 100, width: 1600, height: 900 };
  state.assets.push(video, landscape);
  state.accounts.push({ id: 'a', platform: 'douyin', label: '本机测试备注', status: 'unconnected' });
  const draft = { video: structuredClone(video), covers: { landscape: structuredClone(landscape) }, common: { title: '测试标题', tags: ['志愿填报'] }, targets: [{ platform: 'douyin', enabled: true, accountId: 'a', inherit: true }] };
  const stat = () => ({ size: 8, mtimeMs: 100, isFile: () => true });
  return { state, draft, stat };
}

function memoryStore(state) {
  let data = structuredClone(state);
  return { load: () => structuredClone(data), update: mutator => { const next = structuredClone(data); mutator(next); data = next; return structuredClone(data); } };
}

test('老师进入任务快照与草稿，跨老师账号不能通过检查', () => {
  const { state, draft, stat } = fixture();
  state.teachers = [{ id: 'teacher-a', name: '甲老师' }, { id: 'teacher-b', name: '乙老师' }];
  state.accounts[0].teacherId = 'teacher-a'; draft.teacherId = 'teacher-a';
  assert.equal(d.validateDraft(draft, state, 'rehearsal', stat).ok, true);
  const clean = d.normalizeDraft(draft, state), hash = d.snapshotHash(clean);
  assert.equal(clean.teacherId, 'teacher-a');
  draft.teacherId = 'teacher-b';
  assert.equal(d.validateDraft(draft, state, 'rehearsal', stat).ok, false);
  assert.notEqual(d.snapshotHash(d.normalizeDraft(draft, state)), hash);
  const store = memoryStore(state); assert.equal(d.saveDraft(store, { ...draft, teacherId: 'teacher-a' }).teacherId, 'teacher-a');
});

test('模板保存明确老师归属，不能把其他老师账号塞入模板', () => {
  const { state, draft } = fixture(); state.teachers = [{ id: 'teacher-a' }, { id: 'teacher-b' }]; state.accounts[0].teacherId = 'teacher-a';
  const store = memoryStore(state);
  assert.equal(d.saveTemplate(store, { ...draft, teacherId: 'teacher-a', name: '甲栏目' }).teacherId, 'teacher-a');
  assert.throws(() => d.saveTemplate(store, { ...draft, teacherId: 'teacher-b', name: '错老师' }), /其他老师/);
  assert.throws(() => d.saveTemplate(store, { ...draft, teacherId: 'missing', name: '缺老师' }), /老师不存在/);
});

test('演练可记录要求，但原生声明和合集始终显示尚未核对', () => {
  const { state, draft, stat } = fixture();
  Object.assign(draft.targets[0], { declaration: { required: true, text: '本人观点（待核对）' }, collection: { required: true, name: '已有合集（待核对）' } });
  const result = d.validateDraft(draft, state, 'rehearsal', stat);
  assert.equal(result.ok, true);
  assert.equal(result.issues.filter(i => i.severity === 'warning').length, 2);
  const real = d.validateDraft(draft, state, 'publish', stat);
  assert.equal(real.ok, false);
  assert(real.issues.some(i => i.field === 'engine'));
  assert(real.issues.some(i => i.field === 'declaration' && i.severity === 'error'));
  assert(real.issues.some(i => i.field === 'account'));
});

test('素材只从已登记记录解析，伪造路径无效', () => {
  const { state, draft } = fixture();
  draft.video.path = '/unselected/another-file.mp4';
  const clean = d.normalizeDraft(draft, state);
  assert.equal(clean.video.path, state.assets[0].path);
  draft.video.id = 'unregistered';
  assert.throws(() => d.normalizeDraft(draft, state), /重新选择/);
});

test('文件移动、替换与删除阻止后续执行', () => {
  const { state, draft, stat } = fixture();
  assert.equal(d.validateDraft(draft, state, 'rehearsal', () => ({ ...stat(), size: 9 })).ok, false);
  assert.equal(d.validateDraft(draft, state, 'rehearsal', () => ({ ...stat(), mtimeMs: 101 })).ok, false);
  assert.equal(d.validateDraft(draft, state, 'rehearsal', () => { throw new Error('missing'); }).ok, false);
});

test('相同备注不允许跨平台串用账号', () => {
  const { state, draft, stat } = fixture();
  state.accounts[0].platform = 'tencent';
  assert(d.validateDraft(draft, state, 'rehearsal', stat).issues.some(i => i.field === 'account' && i.severity === 'error'));
});

test('横竖封面不能交换用途或忽略平台覆盖要求', () => {
  const { state, draft, stat } = fixture();
  state.assets[1].width = 900; state.assets[1].height = 1600;
  assert.equal(d.validateDraft(draft, state, 'rehearsal', stat).ok, false);
  assert.throws(() => d.normalizeDraft({ ...draft, covers: { portrait: state.assets[1] } }, state), /重新选择/);
});

test('原生选项开关打开但空值时必须阻止', () => {
  const { state, draft, stat } = fixture();
  draft.targets[0].declaration = { required: true, text: '' };
  draft.targets[0].collection = { required: true, name: '' };
  const result = d.validateDraft(draft, state, 'rehearsal', stat);
  assert.equal(result.ok, false);
  assert.equal(result.issues.filter(i => i.severity === 'error').length, 2);
});

test('模板仅保存字段，不继承视频、封面或未声明的登录资料', () => {
  const { state, draft } = fixture();
  const store = memoryStore(state);
  draft.targets[0].covers = { landscape: state.assets[1] };
  draft.targets[0].cookie = 'test-cookie-must-not-be-exported';
  const result = d.saveTemplate(store, { name: '栏目模板', ...draft, token: 'test-token' });
  const json = JSON.stringify(result);
  assert(!json.includes('test-cookie'));
  assert(!json.includes('/test-fixtures'));
  assert(!json.includes('test-token'));
  assert.equal(result.common.title, '测试标题');
});

test('确认指纹涵盖账号、素材、平台字段，忽略草稿时间等元数据', () => {
  const { state, draft } = fixture();
  const clean = d.normalizeDraft(draft, state);
  const hash = d.snapshotHash(clean);
  assert.equal(hash, d.snapshotHash({ ...clean, updatedAt: 'later', name: '新草稿名', id: 'new-id' }));
  clean.targets[1].collection = { required: true, name: '另一个合集' };
  assert.notEqual(hash, d.snapshotHash(clean));
});

test('重启后保留中断与结果待核查，禁止恢复成成功或自动重发', () => {
  const state = d.emptyState();
  state.runs = ['rehearsal', 'publish'].map(mode => ({ mode, status: 'running', items: [{ status: 'preparing' }], events: [] }));
  const store = memoryStore(state);
  d.recoverRuns(store);
  assert.equal(store.load().runs[0].status, 'interrupted');
  assert.equal(store.load().runs[1].status, 'awaiting_verification');
});

test('报告不包含素材绝对路径或登录字段', () => {
  const { state, draft } = fixture();
  const report = d.exportReport({ id: 'run', mode: 'rehearsal', status: 'awaiting_review', snapshot: d.normalizeDraft(draft, state), summary: [], items: [], events: [] });
  assert(!JSON.stringify(report).includes('/test-fixtures'));
  assert.match(report.notice, /未上传/);
});

test('旧草稿缺少schedule时按立即发布兼容，并在summary与导出中保留', () => {
  const { state, draft, stat } = fixture();
  assert.equal(draft.schedule, undefined);
  const clean = d.normalizeDraft(draft, state);
  assert.deepEqual(clean.schedule, { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' });
  const result = d.validateDraft(draft, state, 'rehearsal', stat);
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary[0].schedule, clean.schedule);
  const report = d.exportReport({ id: 'run', mode: 'rehearsal', status: 'awaiting_review', snapshot: clean, summary: result.summary, items: [], events: [] });
  assert.deepEqual(report.summary[0].schedule, { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' });
});

test('定时使用北京时间与真实日历时间，明确写错时不静默回退', () => {
  const { state, draft } = fixture();
  const scheduled = (at, extra = {}) => ({ ...draft, schedule: { mode: 'scheduled', at, timeZone: 'Asia/Shanghai', ...extra } });
  for (const at of ['2027-02-30T10:00', '2027-13-01T10:00', '2027-01-01T24:00', '2027-01-01T10:60', '2027-1-1T10:00']) {
    assert.throws(() => d.normalizeDraft(scheduled(at), state), /定时发布时间/);
  }
  assert.throws(() => d.normalizeDraft({ ...draft, schedule: { mode: 'scheduled', at: '2099-12-31T23:59', timeZone: 'UTC' } }, state), /时区/);
  assert.throws(() => d.normalizeDraft({ ...draft, schedule: { mode: 'later', at: '', timeZone: 'Asia/Shanghai' } }, state), /发布方式无法识别/);
  assert.throws(() => d.normalizeDraft({ ...draft, schedule: null }, state), /发布方式格式不正确/);
  const clean = d.normalizeDraft(scheduled('2099-12-31T23:59'), state);
  assert.deepEqual(clean.schedule, { mode: 'scheduled', at: '2099-12-31T23:59', timeZone: 'Asia/Shanghai' });
  const immediate = d.normalizeDraft({ ...draft, schedule: { mode: 'immediate', at: '2099-12-31T23:59', timeZone: 'Asia/Shanghai' } }, state);
  assert.deepEqual(immediate.schedule, { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' });
});

test('格式合法的过去时间可保留展示，但不能启动演练或真实任务', () => {
  const { state, draft, stat } = fixture();
  draft.schedule = { mode: 'scheduled', at: '2020-01-01T09:00', timeZone: 'Asia/Shanghai' };
  const clean = d.normalizeDraft(draft, state);
  assert.equal(clean.schedule.at, '2020-01-01T09:00');
  assert.equal(d.snapshotHash(clean).length, 64);
  for (const mode of ['rehearsal', 'prepare', 'publish']) {
    const result = d.validateDraft(draft, state, mode, stat);
    assert.equal(result.ok, false);
    assert(result.issues.some(issue => issue.field === 'schedule' && issue.severity === 'error'));
  }
});

test('定时时间变化会改变确认指纹', () => {
  const { state, draft, stat } = fixture();
  const first = d.normalizeDraft({ ...draft, schedule: { mode: 'scheduled', at: '2099-12-31T23:59', timeZone: 'Asia/Shanghai' } }, state);
  const second = d.normalizeDraft({ ...draft, schedule: { mode: 'scheduled', at: '2099-12-31T23:58', timeZone: 'Asia/Shanghai' } }, state);
  const immediate = d.normalizeDraft(draft, state);
  assert.equal(d.validateDraft(first, state, 'rehearsal', stat).ok, true);
  assert.equal(d.validateDraft(second, state, 'rehearsal', stat).ok, true);
  assert.notEqual(d.snapshotHash(first), d.snapshotHash(second));
  assert.notEqual(d.snapshotHash(first), d.snapshotHash(immediate));
});

test('保存与恢复草稿保留schedule', () => {
  const { state, draft } = fixture();
  const store = memoryStore(state);
  draft.schedule = { mode: 'scheduled', at: '2099-12-31T23:59', timeZone: 'Asia/Shanghai' };
  const saved = d.saveDraft(store, draft);
  assert.deepEqual(saved.schedule, draft.schedule);
  const stored = store.load().drafts.find(item => item.id === saved.id);
  assert.deepEqual(stored.schedule, draft.schedule);
  assert.deepEqual(d.normalizeDraft(stored, store.load()).schedule, draft.schedule);
});

test('模板只保存立即发布默认，不继承一次性定时', () => {
  const { state, draft } = fixture();
  const store = memoryStore(state);
  draft.schedule = { mode: 'scheduled', at: '2099-12-31T23:59', timeZone: 'Asia/Shanghai' };
  const template = d.saveTemplate(store, { name: '栏目模板', ...draft });
  assert.deepEqual(template.schedule, { mode: 'immediate', at: '', timeZone: 'Asia/Shanghai' });
  assert.equal(template.common.title, '测试标题');
  assert(!JSON.stringify(template).includes('2099-12-31T23:59'));
  assert.deepEqual(store.load().templates.find(item => item.id === template.id).schedule, template.schedule);
});

module.exports = { fixture, memoryStore };
