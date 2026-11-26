'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { TaskQueue } = require('./queue.cjs');
const { normalizeDraft, validateDraft, snapshotHash } = require('./domain.cjs');

class RunService {
  constructor({ store, onUpdate = () => {}, stepMs = 700, inspectFile }) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.inspectFile = inspectFile;
    this.queue = new TaskQueue({
      concurrency: 2,
      worker: async (item, { signal, update }) => {
        update({ detail: '检查本地任务快照和素材记录；未联网', progress: 15 });
        await delay(stepMs, undefined, { signal });
        update({ detail: '演练填写顺序：封面、文案、标签、声明与合集；未上传', progress: 55 });
        await delay(stepMs, undefined, { signal });
        update({ detail: '本地演练结束。真实账号和页面字段仍需单独验证。', progress: 100 });
      },
      onChange: snapshot => this.handleQueue(snapshot)
    });
  }

  notify(run) {
    try { this.onUpdate({ type: 'run', run: structuredClone(run) }); } catch { /* Closing UI must not change task state. */ }
  }

  handleQueue(snapshot) {
    const changed = [];
    this.store.update(state => {
      for (const run of state.runs) {
        if (run.mode !== 'rehearsal') continue;
        if (!['queued', 'running'].includes(run.status)) continue;
        let dirty = false;
        for (const item of run.items) {
          const current = snapshot.find(q => q.id === item.id);
          if (!current) continue;
          const next = current.status === 'completed' ? 'awaiting_review'
            : current.status === 'running' ? ((current.progress || 0) >= 50 ? 'preparing' : 'checking')
              : current.status;
          const detail = current.status === 'completed' ? '演练完成 · 未上传、未发布'
            : current.status === 'canceled' ? '本地演练已取消；未上传'
              : current.status === 'failed' ? `本地演练失败：${current.error || '执行异常'}`
                : current.detail || '等待本机队列，未联网';
          if (next === item.status && detail === item.detail && (current.progress || 0) === item.progress) continue;
          item.status = next;
          item.detail = detail;
          item.progress = current.progress || 0;
          run.events.push({ at: new Date().toISOString(), itemId: item.id, status: next, message: detail });
          dirty = true;
        }
        if (dirty) {
          run.updatedAt = new Date().toISOString();
          const working = run.items.some(i => ['checking', 'preparing'].includes(i.status));
          run.status = working ? 'running' : run.items.some(i => i.status === 'queued') ? 'queued'
            : run.items.every(i => i.status === 'canceled') ? 'canceled'
              : run.items.some(i => i.status === 'failed') ? 'failed' : 'awaiting_review';
          changed.push(structuredClone(run));
        }
      }
    });
    changed.forEach(run => this.notify(run));
  }

  start({ draft: input, mode, requestId }) {
    if (mode !== 'rehearsal') throw new Error('真实上传和发布尚未接通。请先使用本地演练。');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new Error('确认凭据无效，请重新打开发布总览。');
    const state = this.store.load();
    const draft = normalizeDraft(input, state);
    const fingerprint = snapshotHash(draft);
    const previous = state.runs.find(r => r.requestId === requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.mode !== mode) throw new Error('确认后配置发生变化，请重新检查并确认。');
      return structuredClone(previous);
    }
    const result = validateDraft(draft, state, mode, this.inspectFile);
    if (!result.ok) throw new Error(result.issues.filter(i => i.severity === 'error').map(i => i.message).join('\n'));
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(), mode, requestId, fingerprint, createdAt: now, updatedAt: now, status: 'queued',
      snapshot: structuredClone(draft), summary: result.summary,
      items: draft.targets.filter(t => t.enabled).map(t => ({ id: randomUUID(), platform: t.platform, accountId: t.accountId, status: 'queued', detail: '等待本机演练；未联网', progress: 0 })),
      events: [{ at: now, status: 'queued', message: '已确认本次不可变任务快照，仅执行本地演练。' }]
    };
    this.store.update(data => data.runs.unshift(run));
    this.notify(run);
    this.queue.enqueue(run.items.map(item => ({ ...item, runId: run.id })));
    return this.store.load().runs.find(r => r.id === run.id);
  }

  cancel(runId) {
    const run = this.store.load().runs.find(r => r.id === runId);
    if (!run) throw new Error('任务记录不存在。');
    for (const item of run.items) if (['queued', 'checking', 'preparing'].includes(item.status)) this.queue.cancel(item.id);
    return this.store.load().runs.find(r => r.id === runId);
  }

  activeRuns() {
    return this.store.load().runs.filter(r => ['queued', 'running'].includes(r.status));
  }

  async stop() {
    this.activeRuns().forEach(run => this.cancel(run.id));
    await this.queue.idle();
  }
}

module.exports = { RunService };
