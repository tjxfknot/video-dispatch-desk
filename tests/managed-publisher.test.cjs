'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ManagedPublisher } = require('../app/core/managed-publisher.cjs');

// ---------------------------------------------------------------------------
// 测试替身：只用内存 store、fake builder 和 fake executor
// ---------------------------------------------------------------------------

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryStore(initial = { runs: [] }) {
  let data = clone(initial);
  return {
    load() {
      return clone(data);
    },
    update(fn) {
      fn(data);
      return data;
    },
    raw() {
      return data;
    },
  };
}

function allTrueChecks() {
  return {
    video: true,
    covers: true,
    text: true,
    declaration: true,
    collection: true,
    schedule: true,
    visibility: true,
    savePermission: true,
  };
}

function createBuilder(overrides = {}) {
  const settings = {
    accountId: 'account-1',
    teacherId: 'teacher-1',
    platform: 'douyin',
    fingerprint: 'fingerprint-1',
    revision: 1,
    environmentId: 'environment-1',
    platformAccountId: 'account-1',
    summary: '测试任务摘要',
    error: null,
    ...overrides,
  };

  function buildJob(draft, state) {
    if (settings.error) throw settings.error;
    const fingerprint = typeof settings.fingerprint === 'function'
      ? settings.fingerprint(draft, state)
      : settings.fingerprint;
    return {
      draft: clone(draft),
      summary: settings.summary,
      teacherId: settings.teacherId,
      accountId: settings.accountId,
      platform: settings.platform,
      fingerprint,
      expectedBinding: {
        revision: settings.revision,
        environmentId: settings.environmentId,
        platformAccountId: settings.platformAccountId,
      },
    };
  }

  return { buildJob, settings };
}

function createExecutor(options = {}) {
  const calls = { verify: 0, prepare: 0, submit: 0, stop: 0 };

  return {
    calls,
    async verify() {
      calls.verify += 1;
      if (options.verifyError) throw options.verifyError;
      return true;
    },
    async prepare(job, context) {
      calls.prepare += 1;
      if (options.onPrepare) {
        await options.onPrepare(context, calls, job);
      }
      if (options.prepareError) throw options.prepareError;
      if (options.prepareGate) await options.prepareGate;
      return { checks: clone(options.checks || allTrueChecks()) };
    },
    async submit(job) {
      calls.submit += 1;
      if (typeof options.submit === 'function') {
        return options.submit(job, calls);
      }
      if (options.submitError) throw options.submitError;
      return {
        status: 'submitted',
        workId: 'work-1',
        workUrl: 'https://example.invalid/work-1',
        message: '已提交（本地测试替身）',
      };
    },
    stop() {
      calls.stop += 1;
      if (options.stopError) throw options.stopError;
    },
  };
}

function setup(options = {}) {
  const store = memoryStore(options.initial || { runs: [] });
  const builder = createBuilder(options.builder);
  const executor = createExecutor(options.executor);
  let executorCalls = 0;

  const publisher = new ManagedPublisher({
    store,
    onUpdate: options.onUpdate || (() => {}),
    buildJob: builder.buildJob,
    getExecutor: options.getExecutor || (async () => {
      executorCalls += 1;
      return executor;
    }),
    submitTimeoutMs: options.submitTimeoutMs,
  });

  return {
    publisher,
    store,
    builder,
    executor,
    executorCalls: () => executorCalls,
  };
}

let requestSeq = 0;
function nextRequestId(prefix = 'req') {
  requestSeq += 1;
  return `${prefix}_${String(requestSeq).padStart(20, '0')}`;
}

function draftFor(videoId = 'video-1', extra = {}) {
  return {
    title: '测试视频-' + videoId,
    video: { id: videoId, path: '/tmp/fake-' + videoId + '.mp4' },
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, label = '条件', timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error('等待超时：' + label);
    }
    await sleep(5);
  }
}

function waitForStatus(publisher, id, status, timeoutMs = 2000) {
  return waitFor(() => {
    const run = publisher.run(id);
    return run.status === status ? run : null;
  }, `run ${id} 状态为 ${status}`, timeoutMs);
}

test('结构化发布摘要保留文案与权限，不能被当成非字符串丢弃',async()=>{
  const summary=[{title:'测试标题',description:'测试简介',specialSettings:{visibility:'self',savePermission:'deny'}}];
  const {publisher}=setup({builder:{summary}});
  const run=publisher.start({draft:draftFor(),requestId:nextRequestId()});
  summary[0].title='外部修改';
  const ready=await waitForStatus(publisher,run.id,'awaiting_confirmation');
  assert.equal(ready.summary[0].title,'测试标题');
  assert.equal(ready.summary[0].specialSettings.visibility,'self');
  await publisher.shutdown();
});

function legacyRun(id, mode, status, overrides = {}) {
  const time = '2026-11-06T00:00:00.000Z';
  return {
    id,
    mode,
    requestId: 'seed_' + id,
    snapshot: { title: '种子任务', video: { id: 'video-' + id } },
    summary: '旧任务摘要',
    teacherId: 'teacher-seed',
    accountId: 'account-' + id,
    platform: 'douyin',
    fingerprint: 'fingerprint-' + id,
    expectedBinding: {
      revision: 1,
      environmentId: 'environment-seed',
      platformAccountId: 'account-' + id,
    },
    checks: null,
    status,
    message: '旧状态',
    progress: 50,
    events: [],
    items: [{
      id: id + ':item',
      status,
      message: '旧状态',
      progress: 50,
    }],
    item: {
      id: id + ':item',
      status,
      message: '旧状态',
      progress: 50,
    },
    result: null,
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('正常准备只到等待确认，不自动提交', async () => {
  let updates = 0;
  const { publisher, executor } = setup({
    onUpdate: () => {
      updates += 1;
      if (updates === 1) throw new Error('onUpdate 故意抛错');
    },
  });

  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  assert.equal(run.status, 'queued');
  assert.equal(run.mode, 'managed_prepare');
  assert.equal(run.items.length, 1);
  assert.equal(run.item.id, run.items[0].id);
  assert.equal(run.item.status, 'queued');
  assert.equal(run.progress, 0);
  assert.equal(publisher.snapshot()[run.id].state, 'queued');

  const ready = await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  assert.equal(executor.calls.verify, 1);
  assert.equal(executor.calls.prepare, 1);
  assert.equal(executor.calls.submit, 0, '准备完成绝不能自动提交');
  assert.deepEqual(ready.checks, allTrueChecks());
  assert.equal(ready.status, 'awaiting_confirmation');
  assert.equal(ready.item.status, 'awaiting_confirmation');
  assert.equal(ready.items[0].status, 'awaiting_confirmation');
  assert.equal(ready.progress, 100);
  assert.ok(updates >= 3);

  assert.ok(ready.events.length >= 2);
  for (const event of ready.events) {
    assert.deepEqual(Object.keys(event).sort(), ['itemId', 'message', 'status', 'time']);
    assert.equal(event.itemId, ready.item.id);
  }

  const projection = publisher.snapshot()[run.id];
  assert.deepEqual(Object.keys(projection).sort(), ['checks', 'message', 'runId', 'state']);
  assert.equal(projection.state, 'awaiting_confirmation');
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.checks), true);
  assert.equal('executor' in projection, false);
  assert.equal('signal' in projection, false);
});

test('任务快照在 start 后冻结，不受外部 draft 修改影响', async () => {
  const draft = draftFor('video-freeze');
  const { publisher } = setup();
  const run = publisher.start({ draft, requestId: nextRequestId() });

  draft.title = '被外部篡改的标题';
  draft.video.id = 'video-mutated';

  await waitForStatus(publisher, run.id, 'awaiting_confirmation');
  const stored = publisher.run(run.id);
  assert.equal(stored.snapshot.title, '测试视频-video-freeze');
  assert.equal(stored.snapshot.video.id, 'video-freeze');
});

test('缺少检查项或检查项为 false 时阻止进入待确认', async (t) => {
  const cases = [
    ['false', { ...allTrueChecks(), covers: false }, 'covers'],
    ['missing', (() => {
      const checks = allTrueChecks();
      delete checks.savePermission;
      return checks;
    })(), 'savePermission'],
  ];

  for (const [name, checks, key] of cases) {
    await t.test('检查项 ' + name, async () => {
      const { publisher, executor } = setup({ executor: { checks } });
      const run = publisher.start({ draft: draftFor('video-' + name), requestId: nextRequestId() });

      const failed = await waitForStatus(publisher, run.id, 'failed');
      assert.equal(executor.calls.submit, 0);
      assert.match(failed.message, /未提交/);
      assert.equal(failed.checks[key], false);
      assert.equal(failed.item.status, 'failed');
      assert.equal(failed.items[0].status, 'failed');

      await assert.rejects(
        publisher.approve(run.id, run.fingerprint),
        /等待确认/,
      );
      assert.equal(executor.calls.submit, 0);
    });
  }
});

test('requestId 相同且指纹相同返回原任务，指纹不同拒绝', async () => {
  const { publisher, executor, builder, store } = setup();
  const requestId = nextRequestId();

  const first = publisher.start({ draft: draftFor('video-1'), requestId });
  const second = publisher.start({ draft: draftFor('video-1'), requestId });
  assert.equal(second.id, first.id, '幂等请求必须返回原 run');
  assert.equal(store.raw().runs.length, 1);

  await waitForStatus(publisher, first.id, 'awaiting_confirmation');
  assert.equal(executor.calls.verify, 1);

  const third = publisher.start({ draft: draftFor('video-1'), requestId });
  assert.equal(third.id, first.id);
  await sleep(20);
  assert.equal(executor.calls.verify, 1, '幂等命中不能再次运行执行器');

  builder.settings.fingerprint = 'fingerprint-tampered';
  assert.throws(
    () => publisher.start({ draft: draftFor('video-2'), requestId }),
    /不同指纹/,
  );
  assert.equal(store.raw().runs.length, 1);

  assert.throws(
    () => publisher.start({ draft: draftFor('video-1'), requestId: 'too-short' }),
    /16到100/,
  );
});

test('同一 requestId 被其他 mode 使用时拒绝', async () => {
  const existing = legacyRun('chrome-1', 'chrome_prepare', 'queued', {
    requestId: nextRequestId('chrome'),
  });
  const { publisher } = setup({ initial: { runs: [existing] } });

  assert.throws(
    () => publisher.start({ draft: draftFor('video-1'), requestId: existing.requestId }),
    /其他模式/,
  );
});

test('同账号有活动任务时拒绝，跨账号允许', async () => {
  const { publisher, builder, executor } = setup();

  const first = publisher.start({ draft: draftFor('video-a'), requestId: nextRequestId() });
  await waitForStatus(publisher, first.id, 'awaiting_confirmation');

  assert.throws(
    () => publisher.start({ draft: draftFor('video-b'), requestId: nextRequestId() }),
    /已有进行中/,
  );

  builder.settings.accountId = 'account-2';
  builder.settings.platformAccountId = 'account-2';
  const second = publisher.start({ draft: draftFor('video-a'), requestId: nextRequestId() });
  assert.equal(second.status, 'queued');
  await waitForStatus(publisher, second.id, 'awaiting_confirmation');

  assert.equal(executor.calls.verify, 2, '另一个账号应能独立准备');
});

test('已提交同账号同素材拒绝再发，跨账号或换素材允许', async () => {
  const { publisher, builder, executor } = setup();

  const first = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, first.id, 'awaiting_confirmation');
  const submitted = await publisher.approve(first.id, first.fingerprint);
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.workId, 'work-1');
  assert.equal(executor.calls.submit, 1);

  assert.throws(
    () => publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() }),
    /相同素材/,
  );

  const otherVideo = publisher.start({ draft: draftFor('video-2'), requestId: nextRequestId() });
  await waitForStatus(publisher, otherVideo.id, 'awaiting_confirmation');

  builder.settings.accountId = 'account-2';
  builder.settings.platformAccountId = 'account-2';
  const otherAccount = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, otherAccount.id, 'awaiting_confirmation');
});

test('批准时原账号变化会阻止提交', async () => {
  const { publisher, builder, executor } = setup();
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  builder.settings.accountId = 'account-changed';
  builder.settings.platformAccountId = 'account-changed';

  const after = await publisher.approve(run.id, run.fingerprint);
  assert.equal(after.status, 'failed');
  assert.equal(executor.calls.submit, 0, '账号变化后绝不能提交');
  assert.equal(executor.calls.verify, 1, '变化应在重新 verify 之前被拦住');
  assert.match(after.message, /账号|绑定|变化/);
  assert.match(after.message, /未提交/);
});

test('批准时素材指纹变化会阻止提交', async () => {
  const { publisher, builder, executor } = setup();
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  builder.settings.fingerprint = 'fingerprint-changed';

  const after = await publisher.approve(run.id, run.fingerprint);
  assert.equal(after.status, 'failed');
  assert.equal(executor.calls.submit, 0);
  assert.match(after.message, /指纹|素材|变化/);
});

test('批准指纹不匹配时拒绝且不提交', async () => {
  const { publisher, executor } = setup();
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  await assert.rejects(
    publisher.approve(run.id, 'wrong-fingerprint'),
    /指纹不匹配/,
  );
  assert.equal(publisher.run(run.id).status, 'awaiting_confirmation');
  assert.equal(executor.calls.submit, 0);
});

test('并发批准最多触发一次提交', async () => {
  const { publisher, executor } = setup();
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  const results = await Promise.allSettled([
    publisher.approve(run.id, run.fingerprint),
    publisher.approve(run.id, run.fingerprint),
  ]);

  const fulfilled = results.filter((item) => item.status === 'fulfilled');
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(executor.calls.submit, 1, '并发批准只能提交一次');
  assert.equal(executor.calls.verify, 2, '准备一次 + 批准前一次');

  const after = publisher.run(run.id);
  assert.equal(after.status, 'submitted');

  await assert.rejects(publisher.approve(run.id, run.fingerprint), /等待确认/);
  assert.equal(executor.calls.submit, 1);
});

test('提交抛错时保留待核查状态，不记失败也不重试', async () => {
  const { publisher, executor } = setup({
    executor: {
      submit: async () => {
        throw new Error('测试通道中断');
      },
    },
  });
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  const after = await publisher.approve(run.id, run.fingerprint);
  assert.equal(after.status, 'awaiting_verification');
  assert.notEqual(after.status, 'failed');
  assert.notEqual(after.status, 'submitted');
  assert.equal(after.workId, undefined);
  assert.match(after.message, /人工核查/);
  assert.match(after.message, /测试通道中断/);
  assert.equal(executor.calls.submit, 1);

  await assert.rejects(publisher.approve(run.id, run.fingerprint), /等待确认/);
  assert.equal(executor.calls.submit, 1, '待核查状态不允许自动重试');
});

test('没有作品凭据时绝不记为 submitted', async (t) => {
  const cases = [
    ['缺少 workId 和 workUrl', { status: 'submitted', message: '适配器说完成了' }],
    ['workId 为空白字符串', { status: 'submitted', workId: '   ', workUrl: '', message: '空凭据' }],
    ['返回待核查状态', { status: 'awaiting_verification', message: '请人工核查' }],
  ];

  for (const [name, result] of cases) {
    await t.test(name, async () => {
      const { publisher, executor } = setup({
        executor: { submit: () => clone(result) },
      });
      const run = publisher.start({ draft: draftFor('video-' + name), requestId: nextRequestId() });
      await waitForStatus(publisher, run.id, 'awaiting_confirmation');

      const after = await publisher.approve(run.id, run.fingerprint);
      assert.equal(after.status, 'awaiting_verification');
      assert.equal(after.workId, undefined);
      assert.equal(after.workUrl, undefined);
      assert.equal(executor.calls.submit, 1);
      assert.match(after.message, /人工核查|未视为成功/);
    });
  }
});

test('提交超时记为待核查而不是失败或成功', async () => {
  const { publisher, executor } = setup({
    executor: { submit: () => new Promise(() => {}) },
    submitTimeoutMs: 30,
  });
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  const after = await publisher.approve(run.id, run.fingerprint);
  assert.equal(after.status, 'awaiting_verification');
  assert.equal(after.workId, undefined);
  assert.match(after.message, /超时/);
  assert.match(after.message, /人工核查/);
  assert.equal(executor.calls.submit, 1);
});

test('取消竞态：迟到的 prepare 结果不能覆盖 canceled', async () => {
  let releasePrepare;
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  const { publisher, executor } = setup({ executor: { prepareGate } });
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });

  await waitFor(() => executor.calls.prepare === 1, 'prepare 已开始');
  const stopped = await publisher.stop(run.id);
  assert.equal(stopped.status, 'canceled');
  assert.equal(stopped.item.status, 'canceled');
  assert.equal(executor.calls.stop, 1, '取消时应调用执行器 stop');

  releasePrepare();
  await sleep(30);

  const after = publisher.run(run.id);
  assert.equal(after.status, 'canceled');
  assert.equal(after.item.status, 'canceled');
  assert.equal(executor.calls.submit, 0);
  await assert.rejects(publisher.approve(run.id, run.fingerprint), /等待确认/);
});

test('取消等待确认的任务后不能批准', async () => {
  const { publisher, executor } = setup();
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  const stopped = await publisher.stop(run.id);
  assert.equal(stopped.status, 'canceled');
  await assert.rejects(publisher.approve(run.id, run.fingerprint), /等待确认/);
  assert.equal(executor.calls.submit, 0);
});

test('已进入 submitting 时 stop 只记待核查，不释放成可重发', async () => {
  let resolveSubmit;
  const submitPromise = new Promise((resolve) => {
    resolveSubmit = resolve;
  });
  const { publisher, executor } = setup({
    executor: { submit: () => submitPromise },
  });
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  const approval = publisher.approve(run.id, run.fingerprint);
  await waitForStatus(publisher, run.id, 'submitting');

  const stopped = await publisher.stop(run.id);
  assert.equal(stopped.status, 'awaiting_verification');
  assert.equal(executor.calls.submit, 1);
  assert.equal(executor.calls.stop, 0, '进入提交阶段后不应再调用 stop 假装取消');

  resolveSubmit({
    status: 'submitted',
    workId: 'late-work',
    workUrl: 'https://example.invalid/late-work',
    message: '迟到的提交结果',
  });
  const after = await approval;

  assert.equal(after.status, 'awaiting_verification');
  assert.equal(after.workId, undefined);
  assert.equal(executor.calls.submit, 1);
  assert.throws(
    () => publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() }),
    /相同素材/,
    '待核查记录必须继续阻止同账号同素材自动再发',
  );
});

test('onStep 只保存有界步骤，忽略状态与额外字段，事件最多 200 条', async () => {
  let releasePrepare;
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  const { publisher, executor } = setup({
    executor: {
      prepareGate,
      onPrepare: async (context) => {
        for (let index = 0; index < 205; index += 1) {
          context.onStep({
            message: '步骤' + index,
            progress: index,
            status: 'submitted',
            secret: 'should-not-be-saved',
          });
        }
        context.onStep({ message: '长'.repeat(600), progress: 150 });
      },
    },
  });

  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitFor(() => executor.calls.prepare === 1, 'prepare 已开始');

  const during = publisher.run(run.id);
  assert.equal(during.status, 'preparing');
  assert.equal(Array.from(during.message).length, 500);
  assert.equal(during.progress, 100);
  assert.equal(during.item.progress, 100);
  assert.equal(during.item.status, 'preparing');
  assert.equal(during.events.length, 200);
  assert.equal(during.events.some((event) => event.status === 'submitted'), false);
  assert.equal(during.events.some((event) => 'secret' in event), false);
  for (const event of during.events) {
    assert.deepEqual(Object.keys(event).sort(), ['itemId', 'message', 'status', 'time']);
  }

  releasePrepare();
  const ready = await waitForStatus(publisher, run.id, 'awaiting_confirmation');
  assert.equal(ready.checks.video, true);
  assert.equal(executor.calls.submit, 0);
});

test('run 与 snapshot 返回隔离副本', async () => {
  const { publisher } = setup();
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, run.id, 'awaiting_confirmation');

  const copy = publisher.run(run.id);
  copy.status = 'submitted';
  copy.message = '被外部篡改';
  copy.checks.video = false;
  copy.items[0].status = 'submitted';
  copy.item.status = 'submitted';

  const fresh = publisher.run(run.id);
  assert.equal(fresh.status, 'awaiting_confirmation');
  assert.equal(fresh.message, '发布前检查全部通过，等待人工确认');
  assert.equal(fresh.checks.video, true);
  assert.equal(fresh.items[0].status, 'awaiting_confirmation');
  assert.equal(fresh.item.status, 'awaiting_confirmation');

  const projection = publisher.snapshot()[run.id];
  try {
    projection.state = 'submitted';
    projection.checks.video = false;
  } catch {
    // 冻结对象在严格模式下可能抛错，同样说明不可写。
  }
  assert.equal(publisher.snapshot()[run.id].state, 'awaiting_confirmation');
  assert.equal(publisher.snapshot()[run.id].checks.video, true);
});

test('重启时恢复非终态并隔离其他 mode', async () => {
  const chrome = legacyRun('chrome-1', 'chrome_prepare', 'submitting', {
    requestId: nextRequestId('chrome'),
  });
  const rehearsal = legacyRun('rehearsal-1', 'rehearsal', 'approved', {
    requestId: nextRequestId('rehearsal'),
  });
  const done = legacyRun('done-1', 'managed_prepare', 'submitted', {
    accountId: 'account-1',
    expectedBinding: {
      revision: 1,
      environmentId: 'environment-seed',
      platformAccountId: 'account-1',
    },
    snapshot: { title: '已提交', video: { id: 'video-1' } },
  });
  const verify = legacyRun('verify-1', 'managed_prepare', 'awaiting_verification');
  const failed = legacyRun('failed-1', 'managed_prepare', 'failed');
  const canceled = legacyRun('canceled-1', 'managed_prepare', 'canceled');
  const queued = legacyRun('queued-1', 'managed_prepare', 'queued');
  const preparing = legacyRun('preparing-1', 'managed_prepare', 'preparing');
  const awaiting = legacyRun('awaiting-1', 'managed_prepare', 'awaiting_confirmation');
  const approved = legacyRun('approved-1', 'managed_prepare', 'approved');
  const submitting = legacyRun('submitting-1', 'managed_prepare', 'submitting');

  const otherModeSnapshot = clone(chrome);
  const store = memoryStore({
    runs: [
      chrome,
      rehearsal,
      done,
      verify,
      failed,
      canceled,
      queued,
      preparing,
      awaiting,
      approved,
      submitting,
    ],
    meta: { keep: true },
  });

  let executorCalls = 0;
  const executor = createExecutor();
  const builder = createBuilder();
  const publisher = new ManagedPublisher({
    store,
    onUpdate: () => {},
    buildJob: builder.buildJob,
    getExecutor: async () => {
      executorCalls += 1;
      return executor;
    },
  });

  assert.equal(publisher.run(queued.id).status, 'failed');
  assert.equal(publisher.run(preparing.id).status, 'failed');
  assert.equal(publisher.run(awaiting.id).status, 'failed');
  assert.match(publisher.run(awaiting.id).message, /程序中断/);
  assert.match(publisher.run(awaiting.id).message, /不会自动重跑/);

  assert.equal(publisher.run(approved.id).status, 'awaiting_verification');
  assert.equal(publisher.run(submitting.id).status, 'awaiting_verification');
  assert.match(publisher.run(submitting.id).message, /提交状态未知/);

  assert.equal(publisher.run(done.id).status, 'submitted');
  assert.equal(publisher.run(verify.id).status, 'awaiting_verification');
  assert.equal(publisher.run(failed.id).status, 'failed');
  assert.equal(publisher.run(canceled.id).status, 'canceled');

  assert.equal(publisher.run(queued.id).item.status, 'failed');
  assert.equal(publisher.run(awaiting.id).items[0].status, 'failed');
  assert.equal(publisher.run(submitting.id).item.status, 'awaiting_verification');

  assert.deepEqual(store.raw().runs.find((run) => run.id === chrome.id), otherModeSnapshot);
  assert.equal(store.raw().runs.find((run) => run.id === rehearsal.id).status, 'approved');
  assert.equal(store.raw().meta.keep, true);
  assert.equal(executorCalls, 0, '恢复时不能自动重跑任务');

  await sleep(20);
  assert.equal(publisher.run(queued.id).status, 'failed');
  assert.equal(publisher.run(submitting.id).status, 'awaiting_verification');

  assert.throws(
    () => publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() }),
    /相同素材/,
    '重启后仍必须识别已提交账号与素材',
  );

  builder.settings.accountId = 'account-other';
  builder.settings.platformAccountId = 'account-other';
  const otherAccount = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });
  await waitForStatus(publisher, otherAccount.id, 'awaiting_confirmation');
  assert.equal(store.raw().runs.find((run) => run.id === chrome.id).status, 'submitting');
});

test('buildJob 抛错时原样抛出，且不创建任务', () => {
  const original = new Error('构建器原始错误');
  const { publisher, store } = setup({ builder: { error: original } });

  assert.throws(
    () => publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() }),
    (thrown) => thrown === original,
  );
  assert.equal(store.raw().runs.length, 0);
});

test('准备阶段 verify 失败记为 failed 且未提交', async () => {
  const { publisher, executor } = setup({
    executor: { verifyError: new Error('账号不符') },
  });
  const run = publisher.start({ draft: draftFor('video-1'), requestId: nextRequestId() });

  const failed = await waitForStatus(publisher, run.id, 'failed');
  assert.match(failed.message, /未提交/);
  assert.match(failed.message, /账号不符/);
  assert.equal(failed.item.status, 'failed');
  assert.equal(executor.calls.prepare, 0);
  assert.equal(executor.calls.submit, 0);
});

test('shutdown 只取消本服务未终结任务并调用 stop', async () => {
  const chrome = legacyRun('chrome-shutdown', 'chrome_prepare', 'awaiting_confirmation');
  const { publisher, store, executor } = setup({ initial: { runs: [chrome] } });

  const first = publisher.start({ draft: draftFor('video-a'), requestId: nextRequestId() });
  await waitForStatus(publisher, first.id, 'awaiting_confirmation');
  const submitted = await publisher.approve(first.id, first.fingerprint);
  assert.equal(submitted.status, 'submitted');

  const second = publisher.start({ draft: draftFor('video-b'), requestId: nextRequestId() });
  await waitForStatus(publisher, second.id, 'awaiting_confirmation');

  await publisher.shutdown();

  assert.equal(publisher.run(first.id).status, 'submitted');
  assert.equal(publisher.run(second.id).status, 'canceled');
  assert.ok(executor.calls.stop >= 1);
  assert.equal(store.raw().runs.find((run) => run.id === chrome.id).status, 'awaiting_confirmation');
});
