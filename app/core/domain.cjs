'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const settings = require('./publish-settings.cjs');

const PLATFORMS = Object.freeze([
  { id: 'douyin', label: '抖音', color: '#2b3439', coverSlots: ['landscape', 'portrait'], capabilities: { dualCover: true, declaration: true, collection: true }, creatorUrl: 'https://creator.douyin.com/creator-micro/content/upload' },
  { id: 'tencent', label: '视频号', color: '#e89a30', coverSlots: ['portrait'], capabilities: { dualCover: false, declaration: false, collection: true }, creatorUrl: 'https://channels.weixin.qq.com/platform/post/create' },
  { id: 'xiaohongshu', label: '小红书', color: '#e94d64', coverSlots: ['portrait'], capabilities: { dualCover: false, declaration: false, collection: false }, creatorUrl: 'https://creator.xiaohongshu.com/publish/publish' }
]);
const PLATFORM_IDS = new Set(PLATFORMS.map(p => p.id));
const ENGINE = Object.freeze({ ready: false, douyinPilot: false, reason: '可在账号与模板中连接并核对抖音、视频号和小红书；视频号与小红书的真实登录仍待验证。自动上传与发布尚未完成。请使用本地演练，账号连接成功不代表可发布。' });
const clone = value => structuredClone(value);
const text = (value, limit = 2000) => String(value ?? '').trim().slice(0, limit);
const tags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，\n#]+/)).map(t => text(t, 80)).filter(Boolean))].slice(0, 100);
const content = value => ({ title: text(value?.title, 300), description: text(value?.description, 10000), tags: tags(value?.tags) });
const SCHEDULE_TIME_ZONE = 'Asia/Shanghai';
const SCHEDULE_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const immediateSchedule = () => ({ mode: 'immediate', at: '', timeZone: SCHEDULE_TIME_ZONE });
const emptyState = () => ({ schemaVersion: 1, assets: [], accounts: [], templates: [], drafts: [], runs: [] });

function parseScheduleAt(value) {
  const match = SCHEDULE_AT_PATTERN.exec(typeof value === 'string' ? value : '');
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(`${value}:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  if (shifted.getUTCFullYear() !== year || shifted.getUTCMonth() + 1 !== month || shifted.getUTCDate() !== day
    || shifted.getUTCHours() !== hour || shifted.getUTCMinutes() !== minute) return null;
  return date;
}

function normalizeSchedule(input) {
  if (input === undefined) return immediateSchedule();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('发布方式格式不正确，请选择立即发布或定时发布。');
  if (!['immediate', 'scheduled'].includes(input.mode)) throw new Error('发布方式无法识别，请选择立即发布或定时发布。');
  if (input.timeZone !== SCHEDULE_TIME_ZONE) throw new Error('定时发布时区必须是 Asia/Shanghai（北京时间 UTC+08:00）。');
  if (input.mode === 'immediate') return immediateSchedule();
  const at = typeof input.at === 'string' ? input.at.trim() : '';
  if (!at) throw new Error('请选择定时发布时间（北京时间）。');
  if (!SCHEDULE_AT_PATTERN.test(at)) throw new Error('定时发布时间格式不正确，请使用 YYYY-MM-DDTHH:mm（北京时间）。');
  if (!parseScheduleAt(at)) throw new Error('定时发布时间不是真实存在的日期或时间，请重新选择。');
  return { mode: 'scheduled', at, timeZone: SCHEDULE_TIME_ZONE };
}

function checkState(state) {
  if (!state || state.schemaVersion !== 1 || !['assets', 'accounts', 'templates', 'drafts', 'runs'].every(k => Array.isArray(state[k]))) {
    throw new Error('数据版本或格式无法识别，请保留原文件并联系维护者；程序不会覆盖现有数据。');
  }
  return state;
}

function selectedAsset(candidate, assets, kind) {
  if (!candidate?.id) return null;
  const registered = assets.find(a => a.id === candidate.id && a.kind === kind);
  if (!registered) throw new Error('素材未经本机文件选择器登记，请重新选择。');
  return clone(registered);
}

function normalizeDraft(input = {}, state) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务格式不正确。');
  const incoming = Array.isArray(input.targets) ? input.targets : [];
  const duplicates = incoming.map(t => t.platform);
  if (new Set(duplicates).size !== duplicates.length || duplicates.some(p => !PLATFORM_IDS.has(p))) throw new Error('平台重复或无法识别。');
  const covers = source => ({
    landscape: selectedAsset(source?.landscape, state.assets, 'landscape'),
    portrait: selectedAsset(source?.portrait, state.assets, 'portrait')
  });
  return {
    id: text(input.id, 100) || randomUUID(), name: text(input.name, 200), teacherId: text(input.teacherId, 100),
    schedule: normalizeSchedule(input.schedule),
    video: selectedAsset(input.video, state.assets, 'video'),
    covers: covers(input.covers), common: content(input.common),
    ...(input.sharedDeclaration !== undefined ? { sharedDeclaration: settings.normalizeSharedDeclaration(input.sharedDeclaration) } : {}),
    targets: PLATFORMS.map(p => {
      const target = incoming.find(t => t.platform === p.id) || {};
      return {
        platform: p.id, enabled: target.enabled === true, accountId: text(target.accountId, 100),
        inherit: target.inherit !== false, ...content(target), covers: covers(target.covers),
        declaration: settings.normalizeTargetDeclaration(target.declaration),
        ...(target.location !== undefined ? { location: settings.normalizeLocation(target.location) } : {}),
        ...(target.specialSettings !== undefined ? { specialSettings: settings.normalizeSpecialSettings(p.id, target.specialSettings) } : {}),
        collection: { required: target.collection?.required === true, name: text(target.collection?.name, 500) }
      };
    })
  };
}

function saveDraft(store, input) {
  const draft = normalizeDraft(input, checkState(store.load()));
  draft.updatedAt = new Date().toISOString();
  store.update(state => {
    const index = state.drafts.findIndex(d => d.id === draft.id);
    if (index < 0) state.drafts.unshift(draft); else state.drafts[index] = draft;
  });
  return clone(draft);
}

function saveAccount(store, input = {}) {
  if (!PLATFORM_IDS.has(input.platform)) throw new Error('请选择正确的平台。');
  const label = text(input.label, 100);
  if (!label) throw new Error('请填写账号备注。');
  const current = checkState(store.load());
  const existing = input.id ? current.accounts.find(a => a.id === input.id) : null;
  if (input.id && !existing) throw new Error('账号备注不存在。');
  if (existing && existing.platform !== input.platform) throw new Error('已登记账号的平台不能改变，请另建账号备注。');
  const account = { id: existing?.id || randomUUID(), platform: input.platform, label, status: 'unconnected', createdAt: existing?.createdAt || new Date().toISOString() };
  store.update(state => {
    const index = state.accounts.findIndex(a => a.id === account.id);
    if (index < 0) state.accounts.push(account); else state.accounts[index] = account;
  });
  return clone(account);
}

function saveTemplate(store, input = {}) {
  const name = text(input.name, 100);
  if (!name) throw new Error('请填写模板名称。');
  const state = checkState(store.load());
  const draft = normalizeDraft({ teacherId: input.teacherId, common: input.common, sharedDeclaration: input.sharedDeclaration, targets: (input.targets || []).map(t => ({ ...t, covers: {} })) }, state);
  const previous = input.id ? state.templates.find(t => t.id === input.id) : null;
  if (input.id && !previous) throw new Error('模板不存在。');
  if (draft.teacherId && !state.teachers?.some(t => t.id === draft.teacherId)) throw new Error('模板所属老师不存在。');
  if (draft.teacherId && draft.targets.some(t => t.accountId && !state.accounts.some(a => a.id === t.accountId && a.teacherId === draft.teacherId))) throw new Error('模板不能包含其他老师的账号。');
  const template = { id: previous?.id || randomUUID(), name, teacherId: draft.teacherId, common: draft.common, ...(draft.sharedDeclaration ? { sharedDeclaration: draft.sharedDeclaration } : {}), targets: draft.targets.map(({ covers, ...rest }) => rest), schedule: immediateSchedule(), createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.update(data => {
    const index = data.templates.findIndex(t => t.id === template.id);
    if (index < 0) data.templates.unshift(template); else data.templates[index] = template;
  });
  return clone(template);
}

function validateDraft(input, state, mode = 'rehearsal', inspectFile = fs.statSync) {
  const issues = [], summary = [];
  const issue = (field, message, platform, severity = 'error') => issues.push({ field, message, ...(platform ? { platform } : {}), severity });
  if (!['rehearsal', 'prepare', 'publish'].includes(mode)) issue('mode', '无法识别的执行模式。');
  if (mode !== 'rehearsal') issue('engine', ENGINE.reason);
  let draft;
  try { draft = normalizeDraft(input, state); } catch (e) {
    return { ok: false, issues: [{ field: 'draft', severity: 'error', message: e.message }], summary, mode };
  }
  const visited = new Set();
  function file(asset, field, platform) {
    if (!asset || visited.has(asset.id)) return;
    visited.add(asset.id);
    try {
      const stat = inspectFile(asset.path);
      if (!stat.isFile() || stat.size <= 0) throw new Error('empty');
      if (stat.size !== asset.size || (asset.mtimeMs != null && stat.mtimeMs !== asset.mtimeMs)) issue(field, `素材已变动，请重新选择：${asset.name}`, platform);
    } catch { issue(field, `素材不存在、为空或无法读取：${asset.name}`, platform); }
  }
  if (!draft.video) issue('video', '请选择本地视频。'); else file(draft.video, 'video');
  if (draft.schedule.mode === 'scheduled') {
    const at = parseScheduleAt(draft.schedule.at);
    if (!at || at.getTime() <= Date.now()) issue('schedule', '定时发布时间必须是未来时间，请重新选择（北京时间）。');
  }
  const active = draft.targets.filter(t => t.enabled);
  if (!active.length) issue('platforms', '请至少勾选一个平台。');
  for (const target of active) {
    const platform = PLATFORMS.find(p => p.id === target.platform);
    const account = state.accounts.find(a => a.id === target.accountId && a.platform === target.platform);
    if (draft.teacherId && (!state.teachers?.some(t => t.id === draft.teacherId) || (account && account.teacherId !== draft.teacherId))) issue('account', '该账号不属于本条选择的老师，请重新选择。', target.platform);
    const copy = target.inherit ? draft.common : target;
    const declaration = settings.resolveDeclaration(draft.sharedDeclaration, target.declaration, target.platform);
    if (!account) issue('account', '请为该平台选择已登记的账号备注。', target.platform);
    if (!copy.title) issue('title', '请填写标题。', target.platform);
    const coverSummary = {};
    for (const slot of ['landscape', 'portrait']) {
      const asset = target.covers[slot] || draft.covers[slot];
      if (!platform.coverSlots.includes(slot)) {
        if (target.covers[slot]) issue('cover', `当前未接入该平台的独立${slot==='landscape'?'横版':'竖版'}封面入口，请清除该覆盖设置。`, target.platform);
        continue;
      }
      if (asset) {
        file(asset, 'cover', target.platform);
        if (asset.width && asset.height && ((slot === 'landscape' && asset.width <= asset.height) || (slot === 'portrait' && asset.height <= asset.width))) {
          issue('cover', `${slot === 'landscape' ? '横版' : '竖版'}封面的图片方向不符合所选用途，请重新选择。`, target.platform);
        }
        coverSummary[slot] = asset.name;
      }
    }
    if (!Object.keys(coverSummary).length) issue('cover', '尚未选封面；平台实际必需比例和数量仍待实测。', target.platform, 'warning');
    if (declaration.required && !declaration.text) issue('declaration', '已要求原生声明，请记录需要核对的选项原文。', target.platform);
    if (target.collection.required && !target.collection.name) issue('collection', '已要求加入合集，请记录目标账号的已有合集名称。', target.platform);
    if (target.location?.mode === 'place' && !target.location.name) issue('location', '添加定位时请填写准确地点名称。', target.platform);
    if (declaration.required) issue('declaration', '声明仅记录为本条要求，尚未从目标账号核对原生选项。', target.platform, mode === 'rehearsal' ? 'warning' : 'error');
    if (target.collection.required) issue('collection', '合集仅记录为本条要求，尚未核对账号所属合集及标识。', target.platform, mode === 'rehearsal' ? 'warning' : 'error');
    if (mode !== 'rehearsal' && account?.status !== 'connected') issue('account', '账号尚未连接，不能上传或发布。', target.platform);
    if (Object.values(target.specialSettings || {}).some(value => value !== 'platform_default')) issue('specialSettings', '特殊设置已保存在本条任务；平台自动填写仍待接通。', target.platform, mode === 'rehearsal' ? 'warning' : 'error');
    summary.push({ ...(target.location !== undefined ? { location: target.location } : {}), ...(target.specialSettings ? { specialSettings: target.specialSettings } : {}), ...(draft.sharedDeclaration ? { declarationOrigin: declaration.origin, declarationVerification: declaration.verification } : {}), platform: target.platform, account: account?.label || '未选择', title: copy.title, description: copy.description, covers: coverSummary, tags: copy.tags, declaration: declaration.required ? declaration.text : '不设置', collection: target.collection.required ? target.collection.name : '不加入合集', schedule: { ...draft.schedule } });
  }
  return { ok: !issues.some(i => i.severity === 'error'), issues, summary, mode };
}

function snapshotHash(draft) {
  const { id, updatedAt, name, ...payload } = draft;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function recoverRuns(store) {
  store.update(state => {
    for (const run of state.runs) {
      if (run.mode === 'managed_prepare') continue;
      if (!['queued', 'running'].includes(run.status)) continue;
      const status = run.mode === 'rehearsal' ? 'interrupted' : 'awaiting_verification';
      run.status = status;
      run.updatedAt = new Date().toISOString();
      for (const item of run.items) if (['queued', 'checking', 'preparing', 'running'].includes(item.status)) {
        item.status = status; item.detail = status === 'interrupted' ? '上次本地演练已中断，未上传；可重新检查后演练。' : '执行中断，先核对平台结果，禁止自动重发。';
      }
      run.events.push({ at: run.updatedAt, status, message: status === 'interrupted' ? '重启后保留中断记录，未自动重跑。' : '重启后等待人工核对平台记录。' });
    }
  });
}

function exportReport(run) {
  return {
    format: 'video-dispatch-report/v1', exportedAt: new Date().toISOString(),
    id: run.id, mode: run.mode, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    ...(run.appVersion ? {appVersion:run.appVersion} : {}),
    teacherId:run.teacherId || run.snapshot?.teacherId || '',teacherLabel:run.teacherLabel || '',platform:run.platform || '',accountId:run.accountId || '',
    platformAccountId:run.expectedBinding?.platformAccountId || '',
    submittedAt:run.events.find(e=>e.status==='submitting')?.time || run.events.find(e=>e.status==='submitting')?.at || '',
    publishedAt:run.result?.publishedAt || '',
    notice: run.mode === 'publish_check' ? '发布前检查未通过，本次未启动上传或提交。' : run.mode === 'rehearsal' ? '仅本地演练，未登录、未上传、未发布。' : '以平台可核对的实际记录为准。',
    video: run.snapshot.video ? { name: run.snapshot.video.name, size: run.snapshot.video.size } : null,
    summary: run.summary, items: run.items, events: run.events,
    ...(['chrome_prepare','managed_prepare'].includes(run.mode) ? {
      accountDisplay: run.accountDisplay || '', checks: run.checks || null,
      workId: run.workId || run.result?.workId || '', workUrl: run.workUrl || run.result?.workUrl || '', platformStatus: run.platformStatus || ''
    } : {}),
    ...(run.mode === 'managed_prepare' ? {
      executionMode: run.executionMode || 'confirm_before_submit',
      authorization: run.authorization ? { action: run.authorization.action, fingerprint: run.authorization.fingerprint, visibility: run.authorization.visibility,
        grantedAt: run.authorization.grantedAt, source: run.authorization.source } : null,
      submission: run.submission ? {...Object.fromEntries(['version','attemptId','protocol','phase','reservedAt','dispatchStartedAt','settledAt','timedOutAt','closedAt','stopRequestedAt','operationPending'].filter(key=>run.submission[key]!==undefined).map(key=>[key,run.submission[key]])),
        actions:(run.submission.actions || []).map(action=>Object.fromEntries(['name','startedAt','returnedAt'].filter(key=>action[key]!==undefined).map(key=>[key,action[key]])))} : null,
      candidateResult: run.candidateResult ? Object.fromEntries(['platform','workId','workUrl','visibility','visibilityVerification','verification','platformStatus','publishedAt','duration','firstObservedAt','lastObservedAt','source'].filter(key=>run.candidateResult[key]!==undefined).map(key=>[key,run.candidateResult[key]])) : null,
      candidateConflicts: (run.candidateConflicts || []).slice(-5).map(candidate=>Object.fromEntries(['platform','workId','workUrl','visibility','verification','observedAt','source'].filter(key=>candidate[key]!==undefined).map(key=>[key,candidate[key]]))),
      inspection: run.inspection ? Object.fromEntries(['id','pending','source','startedAt','finishedAt','interruptedAt','stopRequestedAt'].filter(key=>run.inspection[key]!==undefined).map(key=>[key,run.inspection[key]])) : null,
      result: run.result ? Object.fromEntries(['status','workId','workUrl','visibility','visibilityVerification','duration','publishedAt','verification','platformStatus']
        .filter(key => run.result[key] !== undefined).map(key => [key, run.result[key]])) : null
    } : {})
  };
}

module.exports = { PLATFORMS, ENGINE, emptyState, checkState, normalizeDraft, saveDraft, saveAccount, saveTemplate, validateDraft, snapshotHash, recoverRuns, exportReport };
