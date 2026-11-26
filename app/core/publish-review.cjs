'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeDraft, validateDraft } = require('./domain.cjs');
const { buildManagedPlan } = require('./managed-publish-job.cjs');
const { assertPlanAvailable } = require('./managed-plan.cjs');

// A blocked review is a local check, never a publisher job. Keep it separate
// from managed_prepare so recovery, approval and duplicate-post guards cannot
// interpret it as an upload or a submission.
function reviewManagedPublish({ draft, store, appVersion = '', onBlocked = () => {}, inspectFile }) {
  const state = store.load();
  try {
    const plan = buildManagedPlan(draft, state, inspectFile);
    assertPlanAvailable(plan, state);
    return {
      fingerprint: plan.fingerprint,
      accountDisplay: plan.jobs.map(job => job.accountDisplay).join('\n'),
      summary: plan.summary,
      targets: plan.jobs.map(job => ({ platform: job.platform, accountDisplay: job.accountDisplay, settings: job.settings })),
      files: [...new Map(plan.jobs.flatMap(job => Object.values(job.files).filter(Boolean)).map(file => [file.id || file.path, file])).values()]
        .map(file => ({ name: file.name, size: file.size }))
    };
  } catch (error) {
    const reason = String(error?.message || '发布前检查未通过。').slice(0, 8000);
    let snapshot = { common: { title: String(draft?.common?.title || '').slice(0, 200) }, targets: [] };
    let summary = [];
    try {
      snapshot = normalizeDraft(draft, state);
      summary = validateDraft(snapshot, state, 'rehearsal', inspectFile).summary;
    } catch { /* A malformed draft is recorded without trusting raw paths. */ }
    const now = new Date().toISOString(), id = randomUUID();
    const message = `发布前检查未通过，本次未启动上传或提交：${reason}`;
    const run = {
      id, mode: 'publish_check', status: 'failed', appVersion,
      stage: 'review', createdAt: now, updatedAt: now,
      teacherId: snapshot.teacherId || '',
      teacherLabel: state.teachers?.find(teacher => teacher.id === snapshot.teacherId)?.name || '',
      snapshot, summary, message,
      items: (snapshot.targets || []).filter(target => target.enabled).map(target => ({
        id: `${id}:${target.platform}`, platform: target.platform, accountId: target.accountId,
        status: 'failed', message,
        platformAccountId: state.accounts?.find(account => account.id === target.accountId && account.platform === target.platform)?.binding?.platformAccountId || ''
      })),
      events: [{ time: now, status: 'failed', message }],
      result: null
    };
    try { store.update(data => data.runs.push(run)); }
    catch (storageError) {
      throw new Error(`${message}\n本次原因未能保存到发布记录：${storageError.message}`, { cause: error });
    }
    // Notification failure must not turn a saved check into a lost record.
    try { onBlocked(structuredClone(run)); } catch {}
    throw new Error(`${message}\n本次原因已保存在发布记录。`, { cause: error });
  }
}

module.exports = { reviewManagedPublish };
