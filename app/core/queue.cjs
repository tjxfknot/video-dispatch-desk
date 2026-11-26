'use strict';

function clone(value) {
  return structuredClone(value);
}

class TaskQueue {
  constructor({ concurrency = 2, worker, onChange = () => {} } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency必须是正整数');
    if (typeof worker !== 'function') throw new TypeError('worker必须是函数');
    this.concurrency = concurrency;
    this.worker = worker;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.tasks = new Map();
    this.pending = [];
    this.active = 0;
    this.locks = new Set();
    this.idleWaiters = [];
  }

  enqueue(items) {
    if (!Array.isArray(items)) throw new TypeError('items必须是数组');
    const copies = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('每个任务必须是对象');
      const copy = clone(item);
      for (const key of ['id', 'platform', 'accountId']) {
        if (typeof copy[key] !== 'string' || !copy[key]) throw new TypeError(`任务${key}必须是非空字符串`);
      }
      return copy;
    });
    const batchIds = new Set();
    for (const item of copies) {
      if (batchIds.has(item.id) || this.tasks.has(item.id)) throw new Error(`任务ID重复：${item.id}`);
      batchIds.add(item.id);
    }
    for (const item of copies) {
      const task = { item, status: 'queued', detail: item.detail, progress: item.progress, error: undefined, cancelRequested: false, controller: undefined };
      this.tasks.set(item.id, task);
      this.pending.push(task);
    }
    if (copies.length) {
      this.#emit();
      this.#pump();
    }
    return copies.map(item => this.#view(this.tasks.get(item.id)));
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task || ['completed', 'failed', 'canceled'].includes(task.status)) return task ? this.#view(task) : null;
    task.cancelRequested = true;
    if (task.status === 'queued') {
      task.status = 'canceled';
      this.#emit();
      this.#pump();
      this.#resolveIdle();
    } else if (task.status === 'running') {
      task.controller.abort();
    }
    return this.#view(task);
  }

  snapshot() {
    return [...this.tasks.values()].map(task => this.#view(task));
  }

  idle() {
    if (!this.#hasWork()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  #view(task) {
    const view = clone(task.item);
    view.status = task.status;
    if (task.detail !== undefined) view.detail = clone(task.detail);
    if (task.progress !== undefined) view.progress = clone(task.progress);
    if (task.error !== undefined) view.error = task.error;
    return view;
  }

  #emit() {
    const snapshot = this.snapshot();
    try { this.onChange(snapshot); } catch { /* Observer errors must not affect scheduling. */ }
  }

  #pump() {
    while (this.active < this.concurrency) {
      const index = this.pending.findIndex(task => task.status === 'queued' && !this.locks.has(this.#lockKey(task)));
      if (index < 0) break;
      const [task] = this.pending.splice(index, 1);
      task.status = 'running';
      task.controller = new AbortController();
      task.lockKey = this.#lockKey(task);
      this.locks.add(task.lockKey);
      this.active += 1;
      this.#emit();
      const item = clone(task.item);
      const update = patch => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('update只接受对象');
        const keys = Object.keys(patch);
        if (keys.some(key => key !== 'detail' && key !== 'progress')) throw new TypeError('update只允许修改detail和progress');
        const nextDetail = Object.hasOwn(patch, 'detail') ? clone(patch.detail) : task.detail;
        const nextProgress = Object.hasOwn(patch, 'progress') ? clone(patch.progress) : task.progress;
        task.detail = nextDetail;
        task.progress = nextProgress;
        this.#emit();
      };
      Promise.resolve().then(() => this.worker(item, { signal: task.controller.signal, update }))
        .then(() => { task.status = task.cancelRequested ? 'canceled' : 'completed'; })
        .catch(error => {
          if (task.cancelRequested) task.status = 'canceled';
          else {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
          }
        })
        .finally(() => {
          this.active -= 1;
          this.locks.delete(task.lockKey);
          task.controller = undefined;
          this.#emit();
          this.#pump();
          this.#resolveIdle();
        });
    }
  }

  #lockKey(task) { return JSON.stringify([task.item.platform, task.item.accountId]); }
  #hasWork() { return [...this.tasks.values()].some(task => task.status === 'queued' || task.status === 'running'); }
  #resolveIdle() {
    if (this.#hasWork()) return;
    const waiters = this.idleWaiters.splice(0);
    waiters.forEach(resolve => resolve());
  }
}

module.exports = { TaskQueue };
