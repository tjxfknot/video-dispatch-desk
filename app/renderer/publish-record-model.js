'use strict';

/**
 * 发布记录纯数据整理模块。
 *
 * 只读取调用方传入的 run / context，不读取当前草稿、账号库、浏览器或网络。
 * 输出是普通对象，可在浏览器中挂到 window.PublishRecordModel，也可在 Node 中 require。
 * events 按输出契约固定为空数组；提交时间与“提交后异常”只读取原 run.events 判定。
 */
(function () {
  const DEFAULT_PLATFORM_LABELS = Object.freeze({
    douyin: '抖音',
    tencent: '视频号',
    xiaohongshu: '小红书'
  });

  // 只有这些模式被当作真实执行。未知模式一律按非真实处理，绝不显示发布成功。
  const REAL_MODES = new Set(['managed_prepare', 'douyin_pilot', 'chrome_prepare', 'publish']);

  const ACCOUNT_PLACEHOLDERS = new Set([
    '未选择', '未记录', '未绑定', '账号未记录', '实际账号尚未核对', '待核对'
  ]);

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => (typeof value === 'string' ? value : '');
  const hasText = value => typeof value === 'string' && value.trim() !== '';
  const lowerText = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (hasText(value)) return value;
    }
    return '';
  }

  function errorText(value) {
    if (typeof value === 'string') return value;
    if (isObject(value) && typeof value.message === 'string') return value.message;
    return '';
  }

  function clone(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    const visited = seen || new WeakMap();
    if (visited.has(value)) return visited.get(value);
    if (Array.isArray(value)) {
      const array = [];
      visited.set(value, array);
      for (const entry of value) array.push(clone(entry, visited));
      return array;
    }
    const object = {};
    visited.set(value, object);
    for (const key of Object.keys(value)) object[key] = clone(value[key], visited);
    return object;
  }

  function tagsOf(value) {
    if (Array.isArray(value)) {
      return value.filter(entry => typeof entry === 'string');
    }
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
  }

  function eventsOf(run) {
    return Array.isArray(run && run.events) ? run.events.filter(isObject) : [];
  }

  function eventStatus(event) {
    return lowerText(event && event.status);
  }

  function eventTime(event) {
    return firstText(event && event.time, event && event.at);
  }

  function submittingEvents(run) {
    return eventsOf(run).filter(event => eventStatus(event) === 'submitting');
  }

  function platformLabelOf(platform, context) {
    const platforms = Array.isArray(context && context.platforms) ? context.platforms : [];
    for (const entry of platforms) {
      if (!isObject(entry) || text(entry.id) !== platform) continue;
      if (hasText(entry.label)) return entry.label;
    }
    if (hasText(DEFAULT_PLATFORM_LABELS[platform])) return DEFAULT_PLATFORM_LABELS[platform];
    return platform || '未知平台';
  }

  function teacherLabelOf(run, snapshot, context) {
    const direct = firstText(
      run && run.teacherLabel,
      run && run.teacherName,
      run && run.teacher && run.teacher.name,
      run && run.teacher && run.teacher.label,
      snapshot && snapshot.teacherLabel,
      snapshot && snapshot.teacherName,
      snapshot && snapshot.teacher && snapshot.teacher.name,
      snapshot && snapshot.teacher && snapshot.teacher.label
    );
    if (direct) return direct;

    const teacherId = firstText(run && run.teacherId, snapshot && snapshot.teacherId);
    if (teacherId) {
      const teachers = Array.isArray(context && context.teachers) ? context.teachers : [];
      const teacher = teachers.find(entry => isObject(entry) && text(entry.id) === teacherId);
      if (teacher) {
        const name = firstText(teacher.name, teacher.label, teacher.displayName);
        if (name) return name;
      }
    }
    return '老师未记录';
  }

  function summaryListOf(run) {
    if (Array.isArray(run && run.summary)) return run.summary.filter(isObject);
    if (isObject(run && run.summary)) return [run.summary];
    return [];
  }

  function targetsOf(snapshot) {
    return Array.isArray(snapshot && snapshot.targets) ? snapshot.targets.filter(isObject) : [];
  }

  function itemsOf(run) {
    const items = Array.isArray(run && run.items) ? run.items.filter(isObject) : [];
    if (items.length) return items;
    if (isObject(run && run.item)) return [run.item];
    return [];
  }

  function rowsFor(run, summaryList) {
    const items = itemsOf(run);
    if (items.length) {
      return items.map((item, index) => ({ item, index, fromSummary: false }));
    }
    if (summaryList.length) {
      return summaryList.map((summary, index) => ({
        item: {
          status: run && run.status,
          message: run && run.message,
          platform: summary.platform
        },
        index,
        fromSummary: true
      }));
    }
    const snapshot = isObject(run && run.snapshot) ? run.snapshot : {};
    return targetsOf(snapshot)
      .filter(target => target.enabled === true)
      .map((target, index) => ({
        item: {
          status: run && run.status,
          message: run && run.message,
          platform: target.platform,
          accountId: target.accountId
        },
        index,
        fromSummary: true
      }));
  }

  function platformFor(item, index, total, run, summaryList) {
    const direct = firstText(item && item.platform);
    if (direct) return direct;
    if (total === 1) {
      const fromRun = firstText(run && run.platform);
      if (fromRun) return fromRun;
      const fromSummary = summaryList[0] && firstText(summaryList[0].platform);
      if (fromSummary) return fromSummary;
      return '';
    }
    const summary = summaryList[index];
    return summary ? firstText(summary.platform) : '';
  }

  function summaryFor(platform, index, total, summaryList) {
    if (platform) {
      const exact = summaryList.find(entry => firstText(entry.platform) === platform);
      if (exact) return exact;
    }
    if (summaryList.length === 1 && total === 1) {
      const only = summaryList[0];
      const onlyPlatform = firstText(only.platform);
      if (!onlyPlatform || !platform || onlyPlatform === platform) return only;
    }
    if (!platform && summaryList[index]) return summaryList[index];
    return null;
  }

  function snapshotTargetFor(platform, snapshot, total) {
    const targets = targetsOf(snapshot);
    if (platform) {
      const exact = targets.find(entry => firstText(entry.platform) === platform);
      if (exact) return exact;
    }
    if (targets.length === 1 && total === 1) {
      const onlyPlatform = firstText(targets[0].platform);
      if (!onlyPlatform || !platform || onlyPlatform === platform) return targets[0];
    }
    return null;
  }

  function runFieldsApply(run, platform, total) {
    const runPlatform = firstText(run && run.platform);
    if (runPlatform) return platform === runPlatform;
    return total === 1;
  }

  function copySourceFor(target, snapshot) {
    if (target && target.inherit === false) return target;
    return isObject(snapshot && snapshot.common) ? snapshot.common : {};
  }

  function coversFor(summary, target, snapshot) {
    if (summary && isObject(summary.covers)) return clone(summary.covers);
    const targetCovers = isObject(target && target.covers) ? target.covers : {};
    const commonCovers = isObject(snapshot && snapshot.covers) ? snapshot.covers : {};
    const inherit = !target || target.inherit !== false;
    const primary = inherit ? commonCovers : targetCovers;
    const secondary = inherit ? targetCovers : commonCovers;
    const result = {};
    for (const slot of ['landscape', 'portrait']) {
      const asset = primary[slot] || secondary[slot];
      if (typeof asset === 'string' && asset.trim()) {
        result[slot] = asset;
      } else if (isObject(asset) && typeof asset.name === 'string' && asset.name.trim()) {
        result[slot] = asset.name;
      }
    }
    return result;
  }

  function scheduleFor(summary, snapshot) {
    if (summary && isObject(summary.schedule)) return clone(summary.schedule);
    if (summary && typeof summary.schedule === 'string' && summary.schedule.trim()) return summary.schedule;
    if (isObject(snapshot && snapshot.schedule)) return clone(snapshot.schedule);
    if (typeof (snapshot && snapshot.schedule) === 'string' && snapshot.schedule.trim()) return snapshot.schedule;
    return null;
  }

  function declarationFor(summary, target) {
    if (summary && typeof summary.declaration === 'string') return summary.declaration;
    const declaration = isObject(target && target.declaration) ? target.declaration : null;
    if (declaration && declaration.required === true) return firstText(declaration.text);
    return '';
  }

  function collectionFor(summary, target) {
    if (summary && typeof summary.collection === 'string') return summary.collection;
    const collection = isObject(target && target.collection) ? target.collection : null;
    if (collection && collection.required === true) return firstText(collection.name);
    return '';
  }

  function specialSettingsFor(summary, target) {
    const fromSummary = isObject(summary && summary.specialSettings) ? summary.specialSettings : {};
    const fromTarget = isObject(target && target.specialSettings) ? target.specialSettings : {};
    return {
      visibility: firstText(
        fromSummary.visibility,
        summary && summary.visibility,
        fromTarget.visibility
      ),
      savePermission: firstText(
        fromSummary.savePermission,
        summary && summary.savePermission,
        fromTarget.savePermission
      )
    };
  }

  function videoNameFor(snapshot, summary, item) {
    const video = isObject(snapshot && snapshot.video) ? snapshot.video : null;
    return firstText(
      video && video.name,
      summary && summary.videoName,
      summary && summary.video && summary.video.name,
      item && item.videoName,
      item && item.video && item.video.name
    );
  }

  function accountLabelFor(options) {
    const { run, snapshot, summary, item, target, platform, total, context } = options;
    const summaryAccount = text(summary && summary.account);
    if (hasText(summaryAccount) && !ACCOUNT_PLACEHOLDERS.has(summaryAccount.trim())) {
      return summaryAccount;
    }

    const itemAccount = firstText(
      item && item.accountDisplay,
      item && item.actualAccount,
      item && item.actualAccountLabel,
      item && item.account && item.account.displayName,
      item && item.account && item.account.nickname
    );
    if (itemAccount) return itemAccount;

    const runApplies = runFieldsApply(run, platform, total);
    if (runApplies) {
      const runAccount = firstText(
        run && run.accountDisplay,
        run && run.actualAccount,
        run && run.actualAccountLabel,
        run && run.account && run.account.displayName,
        run && run.account && run.account.nickname,
        snapshot && snapshot.accountLabel,
        snapshot && snapshot.accountDisplay
      );
      if (runAccount) return runAccount;
    }

    const accountId = firstText(item && item.accountId, target && target.accountId);
    if (accountId) {
      const accounts = Array.isArray(context && context.accounts) ? context.accounts : [];
      const matchingPlatform = accounts.find(entry => (
        isObject(entry)
        && text(entry.id) === accountId
        && (!platform || !text(entry.platform) || text(entry.platform) === platform)
      ));
      const matchingId = matchingPlatform || accounts.find(entry => isObject(entry) && text(entry.id) === accountId);
      if (matchingId) {
        const label = firstText(matchingId.label, matchingId.name, matchingId.displayName);
        if (label) return label;
      }
      return '账号已不在本机列表';
    }

    return '账号未记录';
  }

  function platformAccountIdFor(run, snapshot, summary, item, platform, total) {
    const direct = firstText(item && item.platformAccountId, summary && summary.platformAccountId);
    if (direct) return direct;
    const runApplies = runFieldsApply(run, platform, total);
    if (!runApplies) return '';
    return firstText(
      run && run.expectedBinding && run.expectedBinding.platformAccountId,
      snapshot && snapshot.expectedBinding && snapshot.expectedBinding.platformAccountId,
      run && run.result && run.result.platformAccountId
    );
  }

  function resultForRow(run, item, platform, total) {
    const itemResult = isObject(item && item.result) ? item.result : null;
    if (itemResult) return itemResult;
    const runResult = isObject(run && run.result) ? run.result : null;
    if (!runResult) return null;
    const runApplies = runFieldsApply(run, platform, total);
    return runApplies ? runResult : null;
  }

  function workFieldsFor(run, item, result, platform, total) {
    const runApplies = runFieldsApply(run, platform, total);
    return {
      workId: firstText(
        item && item.workId,
        result && result.workId,
        runApplies ? run && run.workId : ''
      ),
      workUrl: firstText(
        item && item.workUrl,
        result && result.workUrl,
        runApplies ? run && run.workUrl : ''
      ),
      platformStatus: firstText(
        item && item.platformStatus,
        result && result.platformStatus,
        runApplies ? run && run.platformStatus : ''
      )
    };
  }

  function rowSubmittedAt(item, platform, total, submittingList) {
    if (item && hasText(item.id)) {
      const match = submittingList.find(event => firstText(event.itemId) === item.id);
      if (match) return eventTime(match);
    }
    if (platform) {
      const match = submittingList.find(event => firstText(event.platform) === platform);
      if (match) return eventTime(match);
    }
    if (total === 1) return eventTime(submittingList[0]);
    return '';
  }

  function rowHasSubmitting(item, platform, total, submittingList) {
    if (!submittingList.length) return false;
    if (item && hasText(item.id)) {
      if (submittingList.some(event => firstText(event.itemId) === item.id)) return true;
    }
    if (platform) {
      if (submittingList.some(event => firstText(event.platform) === platform)) return true;
    }
    return total === 1;
  }

  function rowIssue(run, item, result, statusKey) {
    const needsReason = new Set([
      'after_submit_issue', 'precheck_failed', 'prep_failed', 'rejected', 'awaiting_verification',
      'needs_manual', 'interrupted', 'failed'
    ]);
    if (!needsReason.has(statusKey)) return '';
    if (statusKey === 'rejected') {
      return firstText(
        result && result.message,
        errorText(item && item.error),
        item && item.message,
        item && item.detail,
        run && run.message
      );
    }
    if (['after_submit_issue', 'prep_failed', 'awaiting_verification'].includes(statusKey)) {
      return firstText(
        run && run.message,
        errorText(item && item.error),
        item && item.message,
        item && item.detail,
        result && result.message
      );
    }
    return firstText(
      errorText(item && item.error),
      item && item.detail,
      item && item.message,
      run && run.message,
      result && result.message
    );
  }

  function statusLabelFor(options) {
    const { real, status, platformStatus, resultStatus, hasSubmitting } = options;
    const platformState = lowerText(platformStatus);
    const resultState = lowerText(resultStatus);

    if (!real) {
      switch (status) {
        case 'queued': return { statusKey: 'queued', statusLabel: '排队中', tone: 'pending' };
        case 'running': return { statusKey: 'running', statusLabel: '本地演练中', tone: 'pending' };
        case 'checking': return { statusKey: 'checking', statusLabel: '本地检查', tone: 'pending' };
        case 'preparing': return { statusKey: 'preparing', statusLabel: '本地演练中', tone: 'pending' };
        case 'awaiting_review': return { statusKey: 'awaiting_review', statusLabel: '演练完成 · 未上传', tone: 'neutral' };
        case 'canceled': return { statusKey: 'canceled', statusLabel: '已取消 · 未上传', tone: 'neutral' };
        case 'interrupted': return { statusKey: 'interrupted', statusLabel: '演练中断', tone: 'attention' };
        case 'failed': return { statusKey: 'failed', statusLabel: '演练失败', tone: 'danger' };
        case 'awaiting_verification': return { statusKey: 'awaiting_verification', statusLabel: '结果待核查', tone: 'attention' };
        case 'prepared':
        case 'awaiting_confirmation':
        case 'ready_to_submit':
        case 'approved':
          return { statusKey: 'not_confirmed', statusLabel: '未发布 · 待确认', tone: 'attention' };
        case 'submitting':
        case 'verifying_result':
          return { statusKey: 'running', statusLabel: '本地演练中', tone: 'pending' };
        case 'submitted':
        case 'published':
          return { statusKey: 'rehearsed', statusLabel: '演练完成 · 未上传', tone: 'neutral' };
        case 'needs_manual': return { statusKey: 'needs_manual', statusLabel: '需人工核对', tone: 'attention' };
        case 'awaiting_browser': return { statusKey: 'awaiting_browser', statusLabel: '等待助手连接', tone: 'pending' };
        default:
          return { statusKey: 'unknown', statusLabel: '状态未知', tone: 'neutral' };
      }
    }

    // 平台明确给出 published 时才显示发布成功，且不把其他本地状态误当成成功。
    if (platformState === 'published') {
      return { statusKey: 'published', statusLabel: '发布成功', tone: 'success' };
    }

    if (status === 'failed') {
      if (hasSubmitting) {
        return { statusKey: 'after_submit_issue', statusLabel: '提交后异常 · 待核查', tone: 'danger' };
      }
      return { statusKey: 'prep_failed', statusLabel: '未发布 · 准备失败', tone: 'danger' };
    }

    if (status === 'canceled' || status === 'interrupted') {
      if (hasSubmitting) {
        return { statusKey: 'awaiting_verification', statusLabel: '结果待核查', tone: 'attention' };
      }
      if (status === 'canceled') {
        return { statusKey: 'canceled', statusLabel: '已停止 · 未提交', tone: 'neutral' };
      }
      return { statusKey: 'interrupted', statusLabel: '执行中断 · 待核查', tone: 'attention' };
    }

    if (status === 'awaiting_verification') {
      return { statusKey: 'awaiting_verification', statusLabel: '结果待核查', tone: 'attention' };
    }

    const looksSubmitted = status === 'submitted'
      || status === 'published'
      || (resultState === 'submitted' && (!status || status === 'unknown'));

    if (looksSubmitted) {
      if (platformState === 'under_review') {
        return { statusKey: 'under_review', statusLabel: '审核中', tone: 'pending' };
      }
      if (platformState === 'rejected') {
        return { statusKey: 'rejected', statusLabel: '审核未通过', tone: 'danger' };
      }
      return { statusKey: 'submitted_unknown', statusLabel: '已提交 · 待平台确认', tone: 'pending' };
    }

    switch (status) {
      case 'queued': return { statusKey: 'queued', statusLabel: '排队中', tone: 'pending' };
      case 'preparing': return { statusKey: 'preparing', statusLabel: '上传填写中', tone: 'pending' };
      case 'running': return { statusKey: 'running', statusLabel: '执行中', tone: 'pending' };
      case 'checking': return { statusKey: 'checking', statusLabel: '检查中', tone: 'pending' };
      case 'awaiting_browser': return { statusKey: 'awaiting_browser', statusLabel: '等待助手连接', tone: 'pending' };
      case 'needs_manual': return { statusKey: 'needs_manual', statusLabel: '需人工核对', tone: 'attention' };
      case 'ready_to_submit': return { statusKey: 'ready_to_submit', statusLabel: '检查通过 · 待提交', tone: 'attention' };
      case 'approved': return { statusKey: 'approved', statusLabel: '已授权 · 待提交', tone: 'attention' };
      case 'prepared':
      case 'awaiting_confirmation':
        return { statusKey: 'not_confirmed', statusLabel: '未发布 · 待确认', tone: 'attention' };
      case 'submitting': return { statusKey: 'submitting', statusLabel: '提交中', tone: 'pending' };
      case 'verifying_result': return { statusKey: 'verifying_result', statusLabel: '正在核查平台结果 · 不会重发', tone: 'pending' };
      case 'awaiting_review': return { statusKey: 'awaiting_verification', statusLabel: '结果待核查', tone: 'attention' };
      default:
        return { statusKey: 'unknown', statusLabel: '状态未知', tone: 'neutral' };
    }
  }

  function aggregateStatus(rows) {
    if (!rows.length) return null;
    if (rows.length === 1) {
      return {
        statusKey: rows[0].statusKey,
        statusLabel: rows[0].statusLabel,
        tone: rows[0].tone
      };
    }

    const published = rows.filter(row => row.statusKey === 'published');
    if (published.length === rows.length) {
      return { statusKey: 'published', statusLabel: '全部平台已发布', tone: 'success' };
    }
    if (published.length > 0) {
      return {
        statusKey: 'mixed_published',
        statusLabel: `部分平台已发布（${published.length}/${rows.length}）· 需逐平台核对`,
        tone: 'attention'
      };
    }

    const keys = new Set(rows.map(row => row.statusKey));
    if (keys.size === 1) {
      return {
        statusKey: rows[0].statusKey,
        statusLabel: rows[0].statusLabel,
        tone: rows[0].tone
      };
    }

    const priority = [
      ['after_submit_issue', 'mixed_after_submit_issue', '跨平台存在提交后异常 · 需逐平台核查', 'danger'],
      ['awaiting_verification', 'mixed_awaiting_verification', '跨平台结果待核查', 'attention'],
      ['prep_failed', 'mixed_prep_failed', '跨平台存在未发布项 · 需逐平台核对', 'danger'],
      ['rejected', 'mixed_rejected', '跨平台存在审核未通过 · 需逐平台处理', 'danger'],
      ['submitted_unknown', 'mixed_submitted_unknown', '跨平台已提交 · 待平台确认', 'pending'],
      ['under_review', 'mixed_under_review', '跨平台审核中', 'pending'],
      ['not_confirmed', 'mixed_not_confirmed', '跨平台存在待确认项 · 未发布', 'attention'],
      ['interrupted', 'mixed_interrupted', '部分平台执行中断 · 需核对', 'attention'],
      ['canceled', 'mixed_canceled', '部分平台已停止 · 其余待核对', 'attention'],
      ['failed', 'mixed_failed', '跨平台存在失败项 · 需核对', 'danger'],
      ['needs_manual', 'mixed_needs_manual', '跨平台需人工核对', 'attention'],
      ['ready_to_submit', 'mixed_ready', '跨平台待提交', 'attention'],
      ['approved', 'mixed_approved', '跨平台待提交', 'attention'],
      ['queued', 'mixed_queued', '跨平台排队中', 'pending'],
      ['preparing', 'mixed_preparing', '跨平台上传填写中', 'pending'],
      ['submitting', 'mixed_submitting', '跨平台提交中', 'pending'],
      ['verifying_result', 'mixed_verifying', '跨平台结果核查中', 'pending']
    ];
    for (const [key, aggregateKey, label, tone] of priority) {
      if (keys.has(key)) return { statusKey: aggregateKey, statusLabel: label, tone };
    }
    return { statusKey: 'mixed', statusLabel: '跨平台状态不一致 · 需逐平台核对', tone: 'attention' };
  }

  function aggregateIssue(run, rows, aggregate) {
    if (hasText(run && run.issue)) return run.issue;
    if (aggregate.statusKey === 'published') return '';
    if (!rows.length) {
      if (['prep_failed', 'after_submit_issue', 'awaiting_verification', 'rejected', 'needs_manual', 'interrupted', 'failed'].includes(aggregate.statusKey)) {
        return firstText(run && run.message);
      }
      return '';
    }
    if (rows.length === 1) return rows[0].issue;
    const rowText = row => {
      if (row.issue && row.issue !== row.statusLabel) return `${row.platformLabel}：${row.statusLabel}（${row.issue}）`;
      return `${row.platformLabel}：${row.statusLabel}`;
    };
    if (aggregate.statusKey.indexOf('mixed') === 0) {
      return rows.map(rowText).join('；');
    }
    const issues = rows.filter(row => row.issue);
    if (!issues.length) return '';
    if (issues.length === rows.length && issues.every(row => row.issue === issues[0].issue)) {
      return issues[0].issue;
    }
    return rows.map(rowText).join('；');
  }

  function publishedAtOf(rows, run, real) {
    if (!real) return '';
    if (rows.length === 1) return rows[0].publishedAt;
    if (!rows.length) {
      return firstText(run && run.result && run.result.publishedAt);
    }
    if (rows.every(row => row.statusKey === 'published' && hasText(row.publishedAt))) {
      const first = rows[0].publishedAt;
      if (rows.every(row => row.publishedAt === first)) return first;
    }
    return '';
  }

  function recordForRun(run, context = {}) {
    const source = isObject(run) ? run : {};
    const options = isObject(context) ? context : {};
    const mode = lowerText(source.mode);
    const real = REAL_MODES.has(mode);
    const precheck = mode === 'publish_check';
    const isRehearsal = !real && !precheck;
    const precheckStatus = { statusKey: 'precheck_failed', statusLabel: '未启动 · 发布前检查未通过', tone: 'danger' };
    const snapshot = isObject(source.snapshot) ? source.snapshot : {};
    const summaryList = summaryListOf(source);
    const submittingList = submittingEvents(source);
    const rowSeeds = rowsFor(source, summaryList);
    const total = rowSeeds.length;

    const rows = rowSeeds.map(seed => {
      const item = seed.item;
      const platform = platformFor(item, seed.index, total, source, summaryList);
      const summary = summaryFor(platform, seed.index, total, summaryList);
      const target = snapshotTargetFor(platform, snapshot, total);
      const copySource = copySourceFor(target, snapshot);
      const result = real ? resultForRow(source, item, platform, total) : null;
      const work = real ? workFieldsFor(source, item, result, platform, total) : { workId: '', workUrl: '', platformStatus: '' };
      const submittedAt = real ? rowSubmittedAt(item, platform, total, submittingList) : '';
      const publishedAt = real && result ? firstText(result.publishedAt) : '';

      const status = lowerText(real && total === 1
        ? firstText(source.status, item.status)
        : firstText(item.status, source.status));
      const hasSubmitting = real && rowHasSubmitting(item, platform, total, submittingList);
      const statusInfo = precheck ? precheckStatus : statusLabelFor({
        real,
        status,
        platformStatus: work.platformStatus,
        resultStatus: result ? firstText(result.status) : '',
        hasSubmitting
      });

      const title = summary && typeof summary.title === 'string'
        ? summary.title
        : firstText(copySource.title, snapshot.title);
      const description = summary && typeof summary.description === 'string'
        ? summary.description
        : firstText(copySource.description);
      const tags = summary && (Array.isArray(summary.tags) || typeof summary.tags === 'string')
        ? tagsOf(summary.tags)
        : tagsOf(copySource.tags);
      const covers = coversFor(summary, target, snapshot);
      const special = specialSettingsFor(summary, target);

      return {
        platform,
        platformLabel: platformLabelOf(platform, options),
        accountLabel: accountLabelFor({
          run: source,
          snapshot,
          summary,
          item,
          target,
          platform,
          total,
          context: options
        }),
        platformAccountId: platformAccountIdFor(source, snapshot, summary, item, platform, total),
        statusKey: statusInfo.statusKey,
        statusLabel: statusInfo.statusLabel,
        tone: statusInfo.tone,
        submittedAt,
        publishedAt,
        issue: rowIssue(source, item, result, statusInfo.statusKey),
        title,
        description,
        tags,
        covers,
        videoName: videoNameFor(snapshot, summary, item),
        declaration: declarationFor(summary, target),
        collection: collectionFor(summary, target),
        location: clone(summary?.location || target?.location || null),
        schedule: scheduleFor(summary, snapshot),
        visibility: special.visibility,
        savePermission: special.savePermission,
        workId: work.workId,
        workUrl: work.workUrl,
        platformStatus: work.platformStatus
      };
    });

    let aggregate = aggregateStatus(rows);
    if (!aggregate) {
      const fallbackResult = isObject(source.result) ? source.result : null;
      const fallback = precheck ? precheckStatus : statusLabelFor({
        real,
        status: lowerText(firstText(source.status)),
        platformStatus: real ? firstText(source.platformStatus, fallbackResult && fallbackResult.platformStatus) : '',
        resultStatus: real && fallbackResult ? firstText(fallbackResult.status) : '',
        hasSubmitting: real && submittingList.length > 0
      });
      aggregate = {
        statusKey: fallback.statusKey,
        statusLabel: fallback.statusLabel,
        tone: fallback.tone
      };
    }

    const rowTitles = rows.map(row => row.title).filter(title => title !== '');
    let title = '';
    if (rowTitles.length && rowTitles.every(value => value === rowTitles[0])) title = rowTitles[0];
    if (!title) title = firstText(snapshot.common && snapshot.common.title);
    if (!title && summaryList.length) title = firstText(summaryList[0].title);
    if (!title && rowTitles.length) title = rowTitles[0];

    const submittedAt = real ? eventTime(submittingList[0]) : '';
    const publishedAt = publishedAtOf(rows, source, real);

    return {
      id: firstText(source.id),
      isRehearsal,
      title,
      teacherLabel: teacherLabelOf(source, snapshot, options),
      statusKey: aggregate.statusKey,
      statusLabel: aggregate.statusLabel,
      tone: aggregate.tone,
      createdAt: firstText(source.createdAt),
      submittedAt,
      publishedAt,
      issue: precheck ? firstText(source.message) : aggregateIssue(source, rows, aggregate),
      rows,
      events: clone(eventsOf(source))
    };
  }

  const api = Object.freeze({ recordForRun });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window === 'object' && window) window.PublishRecordModel = api;
})();
