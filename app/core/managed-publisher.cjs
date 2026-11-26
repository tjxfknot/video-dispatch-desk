'use strict';

/**
 * ManagedPublisher
 *
 * 只负责本地任务状态、防重复和并发保护。
 * 不包含浏览器、网络、账号读取或真实提交实现；真实执行器由外部注入。
 */

const { randomUUID } = require('node:crypto');
const {expectedWorkId,mergeResultEvidence,dispatched,pendingOperation}=require('./submission-evidence.cjs');

const MODE = 'managed_prepare';
const PLATFORMS = new Set(['douyin','tencent','xiaohongshu']);

const CHECK_KEYS = Object.freeze([
  'video',
  'covers',
  'text',
  'declaration',
  'collection',
  'schedule',
  'visibility',
  'savePermission',
]);

const ACTIVE_STATUSES = Object.freeze([
  'queued',
  'preparing',
  'ready_to_submit',
  'awaiting_confirmation',
  'approved',
  'submitting',
  'verifying_result',
]);

const ACTIVE_STATUS_SET = new Set(ACTIVE_STATUSES);
const TERMINAL_STATUS_SET = new Set([
  'submitted',
  'awaiting_verification',
  'failed',
  'canceled',
  'prepared',
]);

const STATUS_PROGRESS = Object.freeze({
  queued: 0,
  preparing: 5,
  ready_to_submit: 100,
  prepared: 100,
  verifying_result: 100,
  awaiting_confirmation: 100,
  approved: 100,
  submitting: 100,
  awaiting_verification: 100,
  submitted: 100,
});

const MAX_EVENTS = 200;
const MAX_STEP_CHARS = 500;
const MAX_MESSAGE_CHARS = 500;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120000;

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(deepClone);
  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = deepClone(value[key]);
  }
  return result;
}

function truncate(value, max = MAX_MESSAGE_CHARS) {
  const chars = Array.from(String(value == null ? '' : value));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

function promiseCatchQuietly(value) {
  if (value && typeof value.then === 'function' && typeof value.catch === 'function') {
    value.catch(() => {});
  }
}

function errorText(error) {
  if (error == null) return '未知错误';
  if (typeof error === 'string') return truncate(error, MAX_MESSAGE_CHARS) || '未知错误';
  if (typeof error.message === 'string' && error.message.trim()) {
    return truncate(error.message.trim(), MAX_MESSAGE_CHARS);
  }
  return '未知错误';
}

function normalizeChecks(raw) {
  const checks = {};
  for (const key of CHECK_KEYS) {
    checks[key] = Boolean(raw && raw[key] === true);
  }
  return checks;
}

function allChecksTrue(checks) {
  return CHECK_KEYS.every((key) => checks[key] === true);
}

function missingChecks(checks) {
  return CHECK_KEYS.filter((key) => checks[key] !== true);
}

function clampProgress(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed : '';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = stableValue(value[key]);
    }
    return result;
  }
  return value;
}

function sameValue(left, right) {
  try {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
  } catch {
    return false;
  }
}

function videoIdOf(draft) {
  if (!draft || typeof draft !== 'object') return '';
  const video = draft.video;
  if (!video || typeof video !== 'object') return '';
  const id = video.id;
  if (id === undefined || id === null) return '';
  return String(id);
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) {
    throw new Error('requestId 必须是16到100位 ASCII 字母、数字、下划线或横线');
  }
}

function validateBuiltJob(built) {
  if (!built || typeof built !== 'object' || Array.isArray(built)) {
    throw new Error('buildJob 必须返回对象');
  }
  if (!built.draft || typeof built.draft !== 'object' || Array.isArray(built.draft)) {
    throw new Error('buildJob 返回的 draft 必须是对象');
  }
  if (typeof built.fingerprint !== 'string' || !built.fingerprint) {
    throw new Error('buildJob 返回的 fingerprint 必须是非空字符串');
  }
  if (typeof built.accountId !== 'string' || !built.accountId) {
    throw new Error('buildJob 返回的 accountId 必须是非空字符串');
  }
  if (!PLATFORMS.has(built.platform)) {
    throw new Error('buildJob 返回的平台无法识别');
  }
  if (!built.expectedBinding || typeof built.expectedBinding !== 'object' || Array.isArray(built.expectedBinding)) {
    throw new Error('buildJob 返回的 expectedBinding 必须是对象');
  }
  for (const key of ['revision', 'environmentId', 'platformAccountId']) {
    if (!(key in built.expectedBinding) || built.expectedBinding[key] === undefined || built.expectedBinding[key] === null) {
      throw new Error('buildJob 返回的 expectedBinding.' + key + ' 缺失');
    }
  }
}

class ManagedPublisher {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('ManagedPublisher 构造参数必须是对象');
    }
    const {
      store,
      onUpdate = () => {},
      buildJob,
      getExecutor,
      submitTimeoutMs = DEFAULT_SUBMIT_TIMEOUT_MS,
      resultAttempts = 2,
      resultDelayMs = 1500,
      resultTimeoutMs = 90000,
    } = options;

    if (!store || typeof store.load !== 'function' || typeof store.update !== 'function') {
      throw new Error('store 必须提供 load() 和 update(fn)');
    }
    if (typeof onUpdate !== 'function') {
      throw new Error('onUpdate 必须是函数');
    }
    if (typeof buildJob !== 'function') {
      throw new Error('buildJob 必须是函数');
    }
    if (typeof getExecutor !== 'function') {
      throw new Error('getExecutor 必须是函数');
    }
    if (typeof submitTimeoutMs !== 'number' || !Number.isFinite(submitTimeoutMs) || submitTimeoutMs <= 0) {
      throw new Error('submitTimeoutMs 必须是正数');
    }
    if (!Number.isInteger(resultAttempts) || resultAttempts < 1 || resultAttempts > 3
      || !Number.isFinite(resultDelayMs) || resultDelayMs < 0
      || !Number.isFinite(resultTimeoutMs) || resultTimeoutMs <= 0) throw new Error('结果核查重试配置无效');

    this.store = store;
    this.appVersion = typeof options.appVersion === 'string' ? options.appVersion : '';
    this.onUpdate = onUpdate;
    this.buildJob = buildJob;
    this.getExecutor = getExecutor;
    this.assertAvailable = options.assertAvailable || (()=>{});
    this.submitTimeoutMs = submitTimeoutMs;
    this.resultAttempts = resultAttempts;
    this.resultDelayMs = resultDelayMs;
    this.resultTimeoutMs = resultTimeoutMs;

    /** @type {Map<string, AbortController>} */
    this._controllers = new Map();
    /** @type {Map<string, object>} */
    this._executors = new Map();
    /** @type {Map<string, object>} */
    this._jobs = new Map();
    /** @type {Set<string>} */
    this._approving = new Set();
    /** @type {Set<string>} */
    this._stopCalled = new Set();
    this._operations=new Map();

    this._recover();
  }

  // ---------------------------------------------------------------------------
  // 对外接口
  // ---------------------------------------------------------------------------

  start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('start 参数必须是对象');
    }
    const { draft, requestId } = input;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('draft 必须是对象');
    }
    validateRequestId(requestId);

    const state = this._load();
    // buildJob 的异常必须原样抛出，不能转换成另一种错误。
    const built = this.buildJob(deepClone(draft), state);
    validateBuiltJob(built);
    this.assertAvailable(built);
    // Old callers retain their explicit second-confirmation flow. New normal
    // tasks must carry a grant tied to the exact review, never an implicit flag.
    const executionMode = input.executionMode || 'confirm_before_submit';
    if (!['automatic', 'prepare_only', 'confirm_before_submit'].includes(executionMode)) throw new Error('执行方式无效');
    if (executionMode === 'automatic' && (input.authorization?.action !== 'publish'
      || input.authorization.fingerprint !== built.fingerprint)) throw new Error('自动发布缺少针对本条总览的明确授权，请重新确认任务');
    if (executionMode === 'automatic' && built.settings?.visibility === 'public'
      && input.authorization?.visibility !== 'public') throw new Error('公开发布需要在本次总览中明确确认公开范围');

    const snapshot = deepClone(built.draft);
    const summary = Array.isArray(built.summary) ? deepClone(built.summary) : typeof built.summary === 'string' ? truncate(built.summary, MAX_MESSAGE_CHARS) : '';
    const teacherId = typeof built.teacherId === 'string' ? built.teacherId : '';
    const expectedBinding = deepClone(built.expectedBinding);

    let outcome = null;
    this._update((data) => {
      const existing = data.runs.find((run) => run && run.requestId === requestId);
      if (existing) {
        if (existing.mode !== MODE) {
          outcome = { error: '该 requestId 已被其他模式的任务使用，不能创建本服务任务' };
          return;
        }
        if (existing.fingerprint === built.fingerprint) {
          if ((existing.executionMode || 'confirm_before_submit') !== executionMode) {
            outcome = { error: '相同 requestId 的执行方式已固定，不能把仅准备任务改成自动发布' };
            return;
          }
          outcome = { run: deepClone(existing) };
          return;
        }
        outcome = { error: '相同 requestId 已存在不同指纹的任务，拒绝创建' };
        return;
      }

      const active = data.runs.find((run) => (
        run
        && run.mode === MODE
        && run.platform === built.platform
        && (ACTIVE_STATUS_SET.has(run.status) || pendingOperation(run))
        && (run.accountId === built.accountId || run.expectedBinding?.platformAccountId === built.expectedBinding.platformAccountId)
      ));
      if (active) {
        outcome = { error: '该账号已有进行中的发布任务，请先完成或取消后再创建' };
        return;
      }

      const videoId = videoIdOf(snapshot);
      if (videoId) {
        const duplicate = data.runs.find((run) => (
          run
          && run.mode === MODE
          && (run.status === 'submitted' || run.status === 'awaiting_verification')
          && run.platform === built.platform
          && (run.accountId === built.accountId || run.expectedBinding?.platformAccountId === built.expectedBinding.platformAccountId)
          && (videoIdOf(run.snapshot) === videoId || (built.videoKey && run.videoKey === built.videoKey))
        ));
        if (duplicate) {
          outcome = { error: '该账号已提交过相同素材，禁止自动重复发布' };
          return;
        }
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const message = '任务已排队，等待准备';
      const item = {
        id: id + ':item',
        platform:built.platform,
        accountId:built.accountId,
        status: 'queued',
        message,
        progress: 0,
      };
      const run = {
        id,
        mode: MODE,
        ...(this.appVersion ? {appVersion:this.appVersion} : {}),
        executionMode,
        authorization: executionMode === 'automatic'
          ? { action: 'publish', fingerprint: built.fingerprint, visibility: built.settings?.visibility || 'platform_default', grantedAt: now, source: 'task_review' } : null,
        requestId,
        snapshot,
        summary,
        teacherId,
        teacherLabel:built.teacherLabel || '',
        accountId: built.accountId,
        platform: built.platform,
        fingerprint: built.fingerprint,
        expectedBinding,
        videoKey: built.videoKey || null,
        accountDisplay: built.accountDisplay || '',
        checks: null,
        status: 'queued',
        message,
        progress: 0,
        events: [{
          time: now,
          itemId: item.id,
          status: 'queued',
          message,
        }],
        items: [item],
        item,
        result: null,
        submission:{version:1,phase:'not_started',actions:[],operationPending:false},
        createdAt: now,
        updatedAt: now,
      };
      data.runs.push(run);
      outcome = { created: true, run: deepClone(run), job: built };
    });

    if (!outcome) {
      throw new Error('任务创建失败');
    }
    if (outcome.error) {
      throw new Error(outcome.error);
    }
    if (outcome.created) {
      this._controllers.set(outcome.run.id, new AbortController());
      this._jobs.set(outcome.run.id, { ...outcome.job, runCreatedAt: outcome.run.createdAt });
      this._notify(outcome.run);
      Promise.resolve()
        .then(() => this._prepare(outcome.run.id))
        .catch(() => {});
    }
    return outcome.run;
  }

  run(id) {
    return deepClone(this._readManagedRun(id));
  }

  snapshot() {
    const data = this._load();
    const result = {};
    for (const run of data.runs) {
      if (!run || run.mode !== MODE) continue;
      const checks = run.checks && typeof run.checks === 'object'
        ? deepClone(run.checks)
        : {};
      result[run.id] = Object.freeze({
        runId: run.id,
        state: run.status,
        message: typeof run.message === 'string' ? run.message : '',
        checks: Object.freeze(checks),
      });
    }
    return Object.freeze(result);
  }

  async approve(id, fingerprint) {
    return this._approve(id, fingerprint, false);
  }

  async _approve(id, fingerprint, automatic) {
    if (typeof id !== 'string' || !id) {
      throw new Error('run id 必须是非空字符串');
    }
    if (typeof fingerprint !== 'string' || !fingerprint) {
      throw new Error('确认指纹必须是非空字符串');
    }

    const before = this._readManagedRun(id);
    const expectedStatus = automatic ? 'ready_to_submit' : 'awaiting_confirmation';
    if (before.status !== expectedStatus) {
      throw new Error('只有等待确认的任务才能批准');
    }
    if (automatic && (before.executionMode !== 'automatic' || before.authorization?.action !== 'publish'
      || before.authorization.fingerprint !== fingerprint || !allChecksTrue(before.checks || {}) || !this._jobs.has(id))) {
      throw new Error('原任务授权或检查记录不完整，未提交');
    }
    if (before.fingerprint !== fingerprint) {
      throw new Error('确认指纹不匹配，已拒绝批准');
    }
    if (this._approving.has(id)) {
      throw new Error('该任务正在确认中，请勿重复批准');
    }

    let reserved = null;
    this._update((data) => {
      const run = data.runs.find((item) => item && item.id === id && item.mode === MODE);
      if (!run) return;
      if (run.status !== expectedStatus || run.fingerprint !== fingerprint) return;
      if (this._approving.has(id)) return;
      this._approving.add(id);
      this._transition(run, 'approved', automatic ? '按本次任务授权自动继续，重新核对账号、素材与页面' : '已收到确认，开始重新核对账号与绑定', 100);
      reserved = {
        run: deepClone(run),
        state: deepClone(data),
      };
    });

    if (!reserved) {
      this._approving.delete(id);
      throw new Error('任务状态已变化或正在确认，无法批准');
    }
    this._notify(reserved.run);

    try {
      let job;
      try {
        job = this.buildJob(deepClone(reserved.run.snapshot), reserved.state);
        validateBuiltJob(job);
        job.runCreatedAt = reserved.run.createdAt;
      } catch (error) {
        this._failApproved(id, '批准前重新构建任务失败，未提交：' + errorText(error));
        throw error;
      }

      if (
        job.fingerprint !== reserved.run.fingerprint
        || !sameValue(job.expectedBinding, reserved.run.expectedBinding)
        || job.accountId !== reserved.run.accountId
        || job.platform !== reserved.run.platform
      ) {
        this._failApproved(id, '任务指纹、账号或绑定已变化，已阻止提交（未提交）');
        return this.run(id);
      }

      let executor = this._executors.get(id);
      if (!executor) {
        try {
          executor = await this.getExecutor(job);
        } catch (error) {
          this._failApproved(id, '批准前获取执行器失败，未提交：' + errorText(error));
          return this.run(id);
        }
        if (!executor || typeof executor !== 'object') {
          this._failApproved(id, '批准前获取执行器失败，未提交：执行器无效');
          return this.run(id);
        }
        this._executors.set(id, executor);
      }

      if (this._statusOf(id) !== 'approved') {
        await this._safeStop(id, executor);
        return this.run(id);
      }

      try {
        await executor.verify(job);
      } catch (error) {
        this._failApproved(id, '批准前重新核对账号或素材失败，未提交：' + errorText(error));
        return this.run(id);
      }

      // 再次确认没有被取消，也没有被其他路径推进。
      if (this._statusOf(id) !== 'approved') {
        return this.run(id);
      }

      const attemptId=randomUUID(),instrumented=executor.capabilities?.submissionProtocol===1;
      const armed=this._mutateAndNotify(id,run=>{
        if(run.status!=='approved')return false;
        run.submission={version:1,attemptId,protocol:instrumented?'instrumented':'legacy',phase:'reserved',reservedAt:new Date().toISOString(),actions:[],operationPending:true};
      });
      if(!armed)return this.run(id);
      const operation=Promise.resolve().then(async()=>{
        if(!instrumented)this._beforeDispatch(id,attemptId,'publish');
        const result=await executor.submit(job,{
          beforeDispatch:action=>this._beforeDispatch(id,attemptId,action),
          afterDispatch:action=>this._afterDispatch(id,attemptId,action),
        });
        if(!instrumented)this._afterDispatch(id,attemptId,'publish');
        return result;
      });
      const tracked=this._trackOperation(id,operation,
        result=>this._finishSubmit(id,{ok:true,result},attemptId),
        error=>this._finishSubmit(id,{ok:false,error},attemptId));
      let timedOut=false;
      try{await this._withTimeout(tracked,this.submitTimeoutMs);}
      catch(error){
        timedOut=error?.code==='SUBMIT_TIMEOUT';
        if(timedOut)this._finishSubmit(id,{ok:false,error,timeout:true},attemptId);
      }
      if(automatic && !timedOut && !this._readManagedRun(id).submission?.stopRequestedAt)await this._inspectAfterSubmit(id,executor,job);
      return this.run(id);
    } finally {
      this._approving.delete(id);
    }
  }

  async stop(id) {
    if (typeof id !== 'string' || !id) {
      throw new Error('run id 必须是非空字符串');
    }
    const before = this._readManagedRun(id);

    if (before.status !== 'submitted' && (before.status === 'submitting' || before.status === 'verifying_result' || before.inspection?.pending || (dispatched(before) && pendingOperation(before)))) {
      this._mutateAndNotify(id, (run) => {
        const at=new Date().toISOString();
        if(run.submission)run.submission.stopRequestedAt=at;
        if(run.inspection)run.inspection.stopRequestedAt=at;
        this._transition(run, 'awaiting_verification', '已停止后续动作；已开始的提交或核查仍会保存返回证据，不会重发', 100);
      });
      return this.run(id);
    }

    if (TERMINAL_STATUS_SET.has(before.status) && !pendingOperation(before)) return deepClone(before);

    if (!ACTIVE_STATUS_SET.has(before.status) && !pendingOperation(before)) {
      return deepClone(before);
    }

    const controller = this._controllers.get(id);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // AbortController.abort 在标准实现中不会抛错；这里仅防御自定义实现。
      }
    }

    this._mutateAndNotify(id, (run) => {
      if(run.submission){run.submission.closedAt=new Date().toISOString();run.submission.stopRequestedAt=run.submission.closedAt;}
      if (TERMINAL_STATUS_SET.has(run.status) || run.status === 'submitting') return;
      this._transition(run, 'canceled', '已取消，未提交', run.progress);
    });

    const executor = this._executors.get(id);
    if (executor) {
      await this._safeStop(id, executor);
    }
    return this.run(id);
  }

  async shutdown({graceMs=5000}={}) {
    const data = this._load();
    const ids = data.runs
      .filter((run) => run && run.mode === MODE && (!TERMINAL_STATUS_SET.has(run.status) || pendingOperation(run)))
      .map((run) => run.id);

    await Promise.all(ids.map(async (id) => {
      try {
        await this.stop(id);
      } catch {
        // 关闭流程不能让单个异常阻断其他任务取消。
      }
    }));
    if(this._operations.size && graceMs>0){
      let timer;
      await Promise.race([Promise.allSettled([...this._operations.values()]),new Promise(resolve=>{timer=setTimeout(resolve,graceMs);})]).finally(()=>clearTimeout(timer));
    }
  }

  // ---------------------------------------------------------------------------
  // 准备流程
  // ---------------------------------------------------------------------------

  async _prepare(id) {
    const queued = this._setStatus(
      id,
      ['queued'],
      'preparing',
      '正在核对账号与素材',
      STATUS_PROGRESS.preparing,
    );
    if (!queued) return;

    const run = this._findRun(id);
    if (!run) return;

    const baseJob = this._jobs.get(id) || {
      draft: deepClone(run.snapshot),
      summary: run.summary,
      teacherId: run.teacherId,
      accountId: run.accountId,
      platform: run.platform,
      fingerprint: run.fingerprint,
      expectedBinding: deepClone(run.expectedBinding),
    };
    const job = deepClone(baseJob);

    let executor;
    try {
      executor = await this.getExecutor(job);
    } catch (error) {
      this._failPreparing(id, '准备失败，未提交：' + errorText(error));
      return;
    }

    if (!executor || typeof executor !== 'object') {
      this._failPreparing(id, '准备失败，未提交：执行器无效');
      return;
    }
    this._executors.set(id, executor);

    if (this._statusOf(id) !== 'preparing') {
      await this._safeStop(id, executor);
      return;
    }

    try {
      await executor.verify(job);
    } catch (error) {
      this._failPreparing(id, '账号或素材核对失败，未提交：' + errorText(error));
      return;
    }

    if (this._statusOf(id) !== 'preparing') {
      await this._safeStop(id, executor);
      return;
    }

    const controller = this._controllers.get(id);
    const signal = controller ? controller.signal : undefined;
    let prepared;
    try {
      prepared = await executor.prepare(job, {
        signal,
        onStep: (step) => this._handleStep(id, step),
      });
    } catch (error) {
      this._failPreparing(id, '准备失败，未提交：' + errorText(error));
      return;
    }

    // 取消或状态已推进时，迟到结果一律丢弃。
    if (this._statusOf(id) !== 'preparing') {
      return;
    }

    const checks = normalizeChecks(prepared && prepared.checks);
    if (!allChecksTrue(checks)) {
      const missing = missingChecks(checks).join('、');
      this._mutateAndNotify(id, (current) => {
        if (current.status !== 'preparing') return false;
        current.checks = checks;
        this._transition(
          current,
          'failed',
          '发布前检查未全部通过，未提交：' + (missing || '未知检查项'),
          current.progress,
        );
      });
      return;
    }

    const advisory = prepared && prepared.advisory && typeof prepared.advisory === 'object'
      ? {
          present: !!prepared.advisory.present,
          state: typeof prepared.advisory.state === 'string' ? prepared.advisory.state.slice(0, 40) : 'unknown',
          percent: Number.isFinite(prepared.advisory.percent) ? prepared.advisory.percent : null,
          issues: Array.isArray(prepared.advisory.issues) ? prepared.advisory.issues.filter(v => typeof v === 'string').slice(0, 6).map(v => v.slice(0, 120)) : [],
          summary: typeof prepared.advisory.summary === 'string' ? truncate(prepared.advisory.summary, 240) : '',
          requiresConfirmation: prepared.advisory.requiresConfirmation === true,
        }
      : null;

    const ready = this._mutateAndNotify(id, (current) => {
      if (current.status !== 'preparing') return false;
      current.checks = checks;
      if (advisory) current.advisory = advisory;
      if (current.executionMode === 'prepare_only') {
        this._transition(current, 'prepared', '仅准备任务已完成，未提交；平台页面保留，程序不会继续发布', 100);
      } else if (advisory?.requiresConfirmation) {
        this._transition(
          current,
          'awaiting_confirmation',
          '八项页面检查通过，但平台快速检测提示需要人工确认（未提交）：' + (advisory.summary || '请核对平台页面提示'),
          100,
        );
      } else if (current.executionMode === 'automatic') {
        this._transition(current, 'ready_to_submit', '八项页面检查通过，按本次任务授权自动继续', 100);
      } else {
        this._transition(current, 'awaiting_confirmation', '发布前检查全部通过，等待人工确认', 100);
      }
    });
    if (ready?.status === 'ready_to_submit') {
      try { await this._approve(id, ready.fingerprint, true); }
      catch (error) {
        this._mutateAndNotify(id, current => {
          if (current.status !== 'ready_to_submit') return false;
          this._transition(current, 'failed', '任务授权核对未通过，未提交：' + errorText(error), 100);
        });
      }
    }
  }

  _handleStep(id, step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return;
    if (typeof step.message !== 'string') return;
    const message = truncate(step.message.trim(), MAX_STEP_CHARS);
    if (!message) return;
    const progress = clampProgress(step.progress);

    this._mutateAndNotify(id, (run) => {
      if (run.status !== 'preparing') return false;
      const item = this._ensureItem(run);
      run.message = message;
      if (progress !== null) run.progress = progress;
      run.updatedAt = new Date().toISOString();
      item.status = run.status;
      item.message = message;
      if (progress !== null) item.progress = progress;
      this._pushEvent(run, run.status, message);
    });
  }

  // ---------------------------------------------------------------------------
  // 提交结果
  // ---------------------------------------------------------------------------

  hasPendingOperations(){return this._operations.size>0 || this._load().runs.some(run=>run.mode===MODE && pendingOperation(run));}
  assertAccountAvailable(job,exceptId){
    const occupied=this._load().runs.some(run=>run.mode===MODE && run.id!==exceptId && run.platform===job.platform &&
      (ACTIVE_STATUS_SET.has(run.status) || pendingOperation(run)) &&
      (run.accountId===job.accountId || run.expectedBinding?.platformAccountId===job.expectedBinding?.platformAccountId));
    if(occupied)throw new Error('该账号仍有执行或核查操作在进行，请等待原操作返回。');
  }
  trackExternalOperation(id,operation){return this._trackOperation(id,operation,()=>{},()=>{});}

  _trackOperation(id,operation,onSuccess,onError){
    let tracked;
    const clear=()=>{if(this._operations.get(id)===tracked)this._operations.delete(id);};
    tracked=operation.then(value=>{try{onSuccess(value);return value;}finally{clear();}},error=>{try{onError(error);}finally{clear();}throw error;});
    this._operations.set(id,tracked);return tracked;
  }

  _beforeDispatch(id,attemptId,action='publish'){
    if(!['publish','confirmation'].includes(action))throw new Error('未知发布动作，未调用。');
    const before=this._readManagedRun(id),fresh=this.buildJob(deepClone(before.snapshot),this._load());
    if(fresh.fingerprint!==before.fingerprint || !sameValue(fresh.expectedBinding,before.expectedBinding))throw new Error('实际调用前任务或账号绑定已变化，未调用新的发布动作。');
    const changed=this._mutateAndNotify(id,run=>{
      const evidence=run.submission;
      if(evidence?.attemptId!==attemptId || evidence.closedAt || evidence.stopRequestedAt || !['approved','submitting'].includes(run.status))throw new Error('本次发布许可已失效，未调用新的发布动作。');
      if(evidence.actions.some(a=>a.name===action))throw new Error('本次发布动作已经开始，禁止重复调用。');
      if(action==='confirmation' && !evidence.actions.some(a=>a.name==='publish' && a.returnedAt))throw new Error('没有已返回的首次发布动作，不能确认发布。');
      const at=new Date().toISOString();evidence.actions.push({name:action,startedAt:at});evidence.dispatchStartedAt ||= at;evidence.phase='dispatch_started';
      if(action==='publish')this._transition(run,'submitting','已记录本次唯一尝试，开始调用平台发布动作',100);
      else this._pushEvent(run,'evidence','同一次发布尝试开始调用平台二次确认。');
    });
    if(!changed)throw new Error('原发布任务不存在，不能调用发布动作。');
    if(this._readManagedRun(id).submission?.stopRequestedAt)throw new Error('已停止，未调用新的发布动作。');
  }

  _afterDispatch(id,attemptId,action='publish'){
    this._mutateAndNotify(id,run=>{
      if(run.submission?.attemptId!==attemptId)return false;
      const evidence=run.submission.actions.find(a=>a.name===action);if(!evidence || evidence.returnedAt)return false;
      evidence.returnedAt=new Date().toISOString();run.submission.phase='action_returned';
      this._pushEvent(run,'evidence','平台动作调用已返回；作品接收和发布状态仍需核查。');
    });
  }

  _applyEvidence(run,raw,settings,source){
    const before=expectedWorkId(run),result=mergeResultEvidence(run,raw,settings,source);
    if(result.conflict)this._pushEvent(run,'evidence','读到另一作品编号，与原任务核查依据冲突；不替换原编号。');
    else if(result.candidate && !before && !result.receipt)this._pushEvent(run,'evidence','已保存本条候选作品编号；部分证据尚未通过，不视为发布成功。');
    return result.receipt;
  }

  _finishSubmit(id,outcome,attemptId){
    this._mutateAndNotify(id,run=>{
      const evidence=run.submission;
      if(evidence?.attemptId!==attemptId || evidence.settledAt)return false;
      const started=dispatched(run),at=new Date().toISOString();
      if(outcome.timeout){
        evidence.timedOutAt=at;
        if(!started){
          evidence.closedAt=at;evidence.phase='not_dispatched';
          if(run.status==='approved')this._transition(run,'failed','提交前等待超时，尚未进入发布动作，未提交；原操作结束前不会启动另一任务。',100);
        }else if(run.status!=='submitted')this._transition(run,'awaiting_verification','提交超时，未取得可靠作品凭据，请人工核查；保留原操作并等待其返回，不会重发。',100);
        return;
      }
      evidence.operationPending=false;evidence.settledAt=at;evidence.phase=started?'settled':'not_dispatched';
      if(!started){
        evidence.closedAt ||= at;
        if(run.status==='approved')this._transition(run,'failed','尚未进入发布动作，未提交：'+(outcome.ok?'执行器未提供动作记录':errorText(outcome.error)),100);
        return;
      }
      if(!['submitting','awaiting_verification'].includes(run.status))return;
      if(!outcome.ok){
        this._transition(run,'awaiting_verification','提交异常，未取得可靠作品凭据，请人工核查：'+errorText(outcome.error),100);return;
      }
      const result=outcome.result && typeof outcome.result==='object'?outcome.result:null;
      const receipt=this._applyEvidence(run,result,this._jobs.get(id)?.settings,'submit');
      const legacy=evidence.protocol==='legacy' && run.executionMode!=='automatic' && !evidence.stopRequestedAt && !evidence.timedOutAt && result?.status==='submitted' && (nonEmptyString(result.workId) || nonEmptyString(result.workUrl));
      if(receipt || legacy){
        run.result=receipt || {workId:nonEmptyString(result.workId),workUrl:nonEmptyString(result.workUrl)};
        run.workId=run.result.workId;run.workUrl=run.result.workUrl;
        this._transition(run,'submitted',result.message || '已提交并取得本条可靠作品凭据',100);
      }else this._transition(run,'awaiting_verification','本次提交已尝试一次，作品编号、链接或可见范围尚未可靠核对，未视为成功；不会重发'+(result?.message?'：'+truncate(result.message):''),100);
    });
  }

  _readOutcome(id,inspectionId,outcome,job){
    this._mutateAndNotify(id,current=>{
      if(current.inspection?.id!==inspectionId || !current.inspection.pending)return false;
      current.inspection.pending=false;current.inspection.finishedAt=new Date().toISOString();
      if(current.fingerprint!==job.fingerprint){current.inspection.error='原任务指纹已改变，不沿用本次查询结果。';return;}
      if(!outcome.ok){current.inspection.error=errorText(outcome.error);return;}
      const receipt=this._applyEvidence(current,outcome.result,job.settings,'automatic_query');
      if(receipt && ['verifying_result','awaiting_verification'].includes(current.status)){
        current.result=receipt;current.workId=receipt.workId;current.workUrl=receipt.workUrl;
        this._transition(current,'submitted',receipt.message || '程序已核对本条平台唯一作品记录',100);
      }
    });
  }

  async _inspectAfterSubmit(id,executor,job){
    const initial=this._readManagedRun(id);
    if(initial.status!=='awaiting_verification' || initial.submission?.operationPending || initial.inspection?.pending || typeof executor.inspectResult!=='function')return;
    if(!this._setStatus(id,['awaiting_verification'],'verifying_result','提交已尝试一次，程序正在只读核查平台结果，不会重发',100))return;
    for(let attempt=1;attempt<=this.resultAttempts;attempt++){
      if(this._statusOf(id)!=='verifying_result')return;
      const current=this._readManagedRun(id),inspectionId=randomUUID(),queryJob={...job,expectedWorkId:expectedWorkId(current),requireListEvidence:!!current.candidateResult && !current.result};
      this._mutateAndNotify(id,run=>{run.inspection={id:inspectionId,pending:true,startedAt:new Date().toISOString(),source:'automatic_query'};});
      const operation=Promise.resolve().then(()=>executor.inspectResult(queryJob));
      const tracked=this._trackOperation(id,operation,
        result=>this._readOutcome(id,inspectionId,{ok:true,result},queryJob),
        error=>this._readOutcome(id,inspectionId,{ok:false,error},queryJob));
      let timedOut=false;
      try{await this._withTimeout(tracked,this.resultTimeoutMs);}catch(error){timedOut=error?.code==='SUBMIT_TIMEOUT';}
      if(this._statusOf(id)!=='verifying_result')return;
      if(timedOut)break;
      if(attempt<this.resultAttempts){
        this._mutateAndNotify(id,run=>this._transition(run,'verifying_result','平台记录尚未就绪，程序将再次只读查询；不会再次提交',100));
        await new Promise(resolve=>setTimeout(resolve,this.resultDelayMs));
      }
    }
    this._setStatus(id,['verifying_result'],'awaiting_verification','自动只读核查仍未取得本条可靠作品凭据，结果待核查；不会重发',100);
  }

  _withTimeout(promise, timeoutMs) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('提交超时');
        error.code = 'SUBMIT_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  // ---------------------------------------------------------------------------
  // 构造时恢复
  // ---------------------------------------------------------------------------

  _recover() {
    const changedRuns = [];
    this._update((data) => {
      for (const run of data.runs) {
        if (!run || run.mode !== MODE) continue;
        const wasPending=pendingOperation(run);
        if(run.submission)run.submission.operationPending=false;
        if(run.inspection?.pending){run.inspection.pending=false;run.inspection.interruptedAt=new Date().toISOString();}
        if (TERMINAL_STATUS_SET.has(run.status)){if(wasPending)changedRuns.push(deepClone(run));continue;}

        if (dispatched(run) || (run.submission?.version!==1 && ['submitting','approved','verifying_result'].includes(run.status))) {
          this._transition(
            run,
            'awaiting_verification',
            '程序重启，提交状态未知，请人工核查',
            100,
          );
        } else {
          this._transition(
            run,
            'failed',
            '程序中断，未完成提交；任务不会自动重跑',
            run.progress,
          );
        }
        changedRuns.push(deepClone(run));
      }
    });
    for (const run of changedRuns) this._notify(run);
  }

  // ---------------------------------------------------------------------------
  // 内部基础设施
  // ---------------------------------------------------------------------------

  _load() {
    const data = this.store.load();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('本地状态格式无效');
    }
    const cloned = deepClone(data);
    if (!Array.isArray(cloned.runs)) cloned.runs = [];
    return cloned;
  }

  _update(fn) {
    this.store.update((data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('本地状态格式无效');
      }
      if (!Array.isArray(data.runs)) data.runs = [];
      fn(data);
    });
  }

  _findRun(id) {
    return this._load().runs.find((run) => run && run.id === id && run.mode === MODE);
  }

  _readManagedRun(id) {
    if (typeof id !== 'string' || !id) {
      throw new Error('run id 必须是非空字符串');
    }
    const run = this._findRun(id);
    if (!run) throw new Error('任务不存在或不属于本服务');
    return run;
  }

  _statusOf(id) {
    const run = this._findRun(id);
    return run ? run.status : undefined;
  }

  _setStatus(id, allowedStatuses, status, message, progress) {
    let changed = null;
    this._update((data) => {
      const run = data.runs.find((item) => item && item.id === id && item.mode === MODE);
      if (!run) return;
      if (Array.isArray(allowedStatuses) && !allowedStatuses.includes(run.status)) return;
      this._transition(run, status, message, progress);
      changed = deepClone(run);
    });
    if (changed) this._notify(changed);
    return Boolean(changed);
  }

  _mutateAndNotify(id, fn) {
    let changed = null;
    this._update((data) => {
      const run = data.runs.find((item) => item && item.id === id && item.mode === MODE);
      if (!run) return;
      if (fn(run) === false) return;
      changed = deepClone(run);
    });
    if (changed) this._notify(changed);
    return changed;
  }

  _failPreparing(id, message) {
    this._mutateAndNotify(id, (run) => {
      if (run.status !== 'preparing') return false;
      this._transition(run, 'failed', message, run.progress);
    });
  }

  _failApproved(id, message) {
    this._mutateAndNotify(id, (run) => {
      if (run.status !== 'approved') return false;
      this._transition(run, 'failed', message, run.progress);
    });
  }

  _ensureItem(run) {
    if (!Array.isArray(run.items) || run.items.length === 0) {
      const legacy = run.item && typeof run.item === 'object' ? run.item : null;
      const id = legacy && typeof legacy.id === 'string' && legacy.id
        ? legacy.id
        : String(run.id) + ':item';
      const progress = clampProgress(run.progress);
      run.items = [{
        id,
        status: typeof run.status === 'string' ? run.status : 'queued',
        message: typeof run.message === 'string' ? run.message : '',
        progress: progress === null ? 0 : progress,
      }];
    } else if (run.items.length > 1) {
      run.items = [run.items[0]];
    }

    const item = run.items[0];
    if (!item || typeof item !== 'object') {
      run.items = [{
        id: String(run.id) + ':item',
        status: typeof run.status === 'string' ? run.status : 'queued',
        message: typeof run.message === 'string' ? run.message : '',
        progress: 0,
      }];
    }
    const current = run.items[0];
    if (typeof current.id !== 'string' || !current.id) current.id = String(run.id) + ':item';
    if (typeof current.status !== 'string') current.status = typeof run.status === 'string' ? run.status : 'queued';
    if (typeof current.message !== 'string') current.message = '';
    if (typeof current.progress !== 'number' || !Number.isFinite(current.progress)) current.progress = 0;
    run.item = current;
    return current;
  }

  _transition(run, status, message, progress) {
    const item = this._ensureItem(run);
    const safeMessage = truncate(message == null ? '' : message, MAX_MESSAGE_CHARS);
    const resolvedProgress = progress === undefined || progress === null
      ? (STATUS_PROGRESS[status] !== undefined ? STATUS_PROGRESS[status] : (run.progress || 0))
      : (clampProgress(progress) === null ? (run.progress || 0) : clampProgress(progress));

    run.status = status;
    run.message = safeMessage;
    run.progress = resolvedProgress;
    run.updatedAt = new Date().toISOString();
    if (!run.createdAt) run.createdAt = run.updatedAt;

    item.status = status;
    item.message = safeMessage;
    item.progress = resolvedProgress;

    this._pushEvent(run, status, safeMessage);
  }

  _pushEvent(run, status, message) {
    if (!Array.isArray(run.events)) run.events = [];
    const item = this._ensureItem(run);
    run.events.push({
      time: new Date().toISOString(),
      itemId: item.id,
      status,
      message,
    });
    if (run.events.length > MAX_EVENTS) {
      run.events = run.events.slice(-MAX_EVENTS);
    }
  }

  _notify(run) {
    const payload = { type: 'run', run: deepClone(run) };
    try {
      const returned = this.onUpdate(payload);
      promiseCatchQuietly(returned);
    } catch {
      // onUpdate 是旁路通知，任何异常都不能影响业务状态。
    }
  }

  async _safeStop(id, executor) {
    if (!executor || this._stopCalled.has(id)) return;
    this._stopCalled.add(id);
    try {
      if (typeof executor.stop !== 'function') return;
      const returned = executor.stop();
      if (returned && typeof returned.then === 'function') {
        await returned.catch(() => {});
      }
    } catch {
      // 执行器的 stop 失败不能改变本地取消/待核查状态。
    }
  }
}

module.exports = { ManagedPublisher };
