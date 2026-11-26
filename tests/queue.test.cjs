'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskQueue } = require('../app/core/queue.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const item = (id, platform = 'douyin', accountId = 'a', extra = {}) => ({ id, platform, accountId, payload: { nested: 1 }, ...extra });

test('enforces concurrency limit and serializes tasks for one platform/account', async () => {
  const gates = new Map();
  let running = 0;
  let maximum = 0;
  const queue = new TaskQueue({ concurrency: 2, worker: async task => {
    running += 1;
    maximum = Math.max(maximum, running);
    gates.set(task.id, deferred());
    await gates.get(task.id).promise;
    running -= 1;
  } });
  queue.enqueue([item('one'), item('two'), item('three', 'tencent', 'b'), item('four', 'tencent', 'c')]);
  await tick();
  assert.equal(maximum, 2);
  assert.equal(gates.has('one'), true);
  assert.equal(gates.has('two'), false);
  assert.equal(gates.has('three'), true);
  gates.get('one').resolve();
  await tick();
  assert.equal(gates.has('two'), true);
  gates.get('three').resolve();
  await tick();
  assert.equal(gates.has('four'), true);
  gates.get('two').resolve();
  gates.get('four').resolve();
  await queue.idle();
  assert.equal(maximum, 2);
});

test('same account across different platforms can run in parallel', async () => {
  const started = [];
  const gates = [];
  const queue = new TaskQueue({ concurrency: 2, worker: task => {
    started.push(task.id);
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  } });
  queue.enqueue([item('x', 'douyin', 'same'), item('y', 'tencent', 'same')]);
  await tick();
  assert.deepEqual(started.sort(), ['x', 'y']);
  gates.forEach(gate => gate.resolve());
  await queue.idle();
});

test('duplicate ids reject the entire batch without changing queue state', () => {
  const queue = new TaskQueue({ worker: async () => {} });
  assert.throws(() => queue.enqueue([item('first'), item('first', 'tencent')]), /重复/);
  assert.deepEqual(queue.snapshot(), []);
  queue.enqueue([item('first')]);
  assert.throws(() => queue.enqueue([item('second'), item('first')]), /重复/);
  assert.deepEqual(queue.snapshot().map(t => t.id), ['first']);
});

test('running cancellation does not release capacity or account lock before worker exits', async () => {
  const started = [];
  const gates = new Map();
  const signals = new Map();
  const queue = new TaskQueue({ concurrency: 1, worker: (task, { signal }) => {
    started.push(task.id);
    signals.set(task.id, signal);
    gates.set(task.id, deferred());
    return gates.get(task.id).promise;
  } });
  queue.enqueue([item('active'), item('same-account'), item('other', 'tencent', 'b')]);
  await tick();
  queue.cancel('active');
  assert.equal(signals.get('active').aborted, true);
  assert.deepEqual(started, ['active']);
  assert.equal(queue.snapshot()[0].status, 'running');
  gates.get('active').resolve();
  await tick();
  assert.equal(queue.snapshot().find(t => t.id === 'active').status, 'canceled');
  assert.equal(started.includes('same-account'), true);
  assert.equal(started.includes('other'), false);
  gates.get('same-account').resolve();
  await tick();
  assert.equal(started.includes('other'), true);
  gates.get('other').resolve();
  await queue.idle();
});

test('account lock remains held after cancellation until the worker actually exits', async () => {
  const started = [];
  const gates = new Map();
  const queue = new TaskQueue({ concurrency: 2, worker: task => {
    started.push(task.id);
    gates.set(task.id, deferred());
    return gates.get(task.id).promise;
  } });
  queue.enqueue([item('active-a'), item('active-b', 'tencent', 'b'), item('waiting-a')]);
  await tick();
  queue.cancel('active-a');
  gates.get('active-b').resolve();
  await tick();
  assert.deepEqual(started, ['active-a', 'active-b']);
  gates.get('active-a').resolve();
  await tick();
  assert.deepEqual(started, ['active-a', 'active-b', 'waiting-a']);
  gates.get('waiting-a').resolve();
  await queue.idle();
});

test('worker failures are isolated and observer exceptions do not stop scheduling', async () => {
  const queue = new TaskQueue({ concurrency: 1, onChange: () => { throw new Error('observer'); }, worker: async task => {
    if (task.id === 'bad') throw new Error('worker broke');
  } });
  queue.enqueue([item('bad'), item('good')]);
  await queue.idle();
  assert.equal(queue.snapshot().find(t => t.id === 'bad').status, 'failed');
  assert.equal(queue.snapshot().find(t => t.id === 'bad').error, 'worker broke');
  assert.equal(queue.snapshot().find(t => t.id === 'good').status, 'completed');
});

test('input, worker item, updates and emitted snapshots cannot mutate identity or internal state', async () => {
  let finish;
  const seen = [];
  const input = item('fixed', 'douyin', 'account', { title: 'original' });
  const queue = new TaskQueue({ worker: (task, { update }) => {
    task.id = 'worker-mutated';
    task.platform = 'tencent';
    task.accountId = 'other';
    update({ detail: 'working', progress: 20 });
    assert.throws(() => update({ status: 'completed' }), /只允许/);
    return new Promise(resolve => { finish = resolve; });
  }, onChange: snapshot => { seen.push(snapshot); snapshot[0].id = 'observer-mutated'; snapshot[0].status = 'completed'; } });
  queue.enqueue([input]);
  input.id = 'caller-mutated';
  input.payload.nested = 9;
  await tick();
  const current = queue.snapshot()[0];
  assert.equal(current.id, 'fixed');
  assert.equal(current.platform, 'douyin');
  assert.equal(current.accountId, 'account');
  assert.equal(current.status, 'running');
  assert.equal(current.detail, 'working');
  finish();
  await queue.idle();
  assert.equal(queue.snapshot()[0].status, 'completed');
  assert.ok(seen.length > 0);
});
