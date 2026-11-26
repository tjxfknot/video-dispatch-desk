'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunService } = require('../app/core/service.cjs');
const { emptyState } = require('../app/core/domain.cjs');

function setup() {
  let state = emptyState();
  state.assets = [{ id: 'v', kind: 'video', name: '本地测试.mp4', path: '/test-fixtures/demo.mp4', size: 1 }];
  state.accounts = [{ id: 'one', platform: 'douyin', label: '演练备注', status: 'unconnected' }];
  const store = { load: () => structuredClone(state), update: fn => { const next = structuredClone(state); fn(next); state = next; return structuredClone(state); } };
  const service = new RunService({ store, stepMs: 3, inspectFile: () => ({ size: 1, isFile: () => true }) });
  const draft = { video: state.assets[0], common: { title: '测试' }, targets: [{ platform: 'douyin', enabled: true, accountId: 'one' }] };
  return { store, service, options: { draft, mode: 'rehearsal', requestId: 'test-request-01234567' } };
}

test('确认连点只入队一次，编辑相同确认凭据的任务必须拒绝', async () => {
  const { store, service, options } = setup();
  const first = service.start(options);
  const repeat = service.start(options);
  assert.equal(first.id, repeat.id);
  assert.equal(store.load().runs.length, 1);
  options.draft.common.title = '已修改';
  assert.throws(() => service.start(options), /发生变化/);
  assert.equal(store.load().runs[0].snapshot.common.title, '测试');
  await service.queue.idle();
  const run = store.load().runs[0];
  assert.equal(run.status, 'awaiting_review');
  assert(run.items.every(i => i.status === 'awaiting_review'));
  assert(!JSON.stringify(run).includes('published'));
});

test('实际上传与发布入口均无法用演练确认调用', () => {
  const { service, options } = setup();
  assert.throws(() => service.start({ ...options, mode: 'publish' }), /尚未接通/);
  assert.throws(() => service.start({ ...options, mode: 'prepare' }), /尚未接通/);
});

test('点击停止后任务终止且留取消记录，没有发布成功状态', async () => {
  const { store, service, options } = setup();
  const run = service.start(options);
  service.cancel(run.id);
  await service.queue.idle();
  assert.equal(store.load().runs[0].status, 'canceled');
  assert.equal(service.activeRuns().length, 0);
});
