'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const publisher = window.publisher;
  const apiMethods = ['bootstrap', 'chooseAsset', 'saveDraft', 'saveTemplate', 'validate', 'startRun', 'cancelRun', 'exportRun', 'openCreator', 'onUpdate'];
  const bridgeAvailable = !!publisher && apiMethods.every(name => typeof publisher[name] === 'function');
  const connectionApiAvailable = bridgeAvailable && ['startChromePair', 'stopChromePair'].every(name => typeof publisher[name] === 'function');
  const teacherApiMethods = ['saveTeacher', 'saveManagedAccount', 'saveTeacherProfile'];
  const teacherApiAvailable = bridgeAvailable && teacherApiMethods.every(name => typeof publisher[name] === 'function');
  const pairApiMethods = ['startAccountPair', 'cancelAccountPair', 'confirmAccountPair', 'inspectManagedAccount', 'openManagedAccount', 'unbindManagedAccount'];
  const pairApiAvailable = bridgeAvailable && pairApiMethods.every(name => typeof publisher[name] === 'function');
  const browserApiAvailable = bridgeAvailable && !!window.ManagedBrowserUI && ['openAccountBrowser', 'confirmBrowserAccount', 'closeAccountBrowser', 'cancelBrowserBinding'].every(name => typeof publisher[name] === 'function');
  const realTestMethods = ['startChromePrepare', 'stopChromePrepare', 'authorizeChromePublish'];
  const realTestApiAvailable = !!publisher && realTestMethods.every(name => typeof publisher[name] === 'function');
  const REAL_ACTIVE_STATUSES = new Set(['queued', 'running', 'awaiting_browser', 'preparing', 'needs_manual', 'awaiting_confirmation', 'approved', 'submitting']);
  const REAL_PANEL_STATUSES = new Set([...REAL_ACTIVE_STATUSES, 'submitted', 'awaiting_verification']);
  const platformDefaults = [
    { id: 'douyin', label: '抖音', color: '#2b3439', coverSlots: ['landscape', 'portrait'], capabilities: {} },
    { id: 'tencent', label: '视频号', color: '#e89a30', coverSlots: ['portrait'], capabilities: {} },
    { id: 'xiaohongshu', label: '小红书', color: '#e94d64', coverSlots: ['portrait'], capabilities: {} }
  ];
  const managedPlatform = platform => ['douyin', 'tencent', 'xiaohongshu'].includes(platform);
  const SCHEDULE_TIME_ZONE = 'Asia/Shanghai';
  const SCHEDULE_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  function immediateSchedule() {
    return { mode: 'immediate', at: '', timeZone: SCHEDULE_TIME_ZONE };
  }
  function scheduleOf(draft) {
    const value = draft?.schedule;
    if (value === undefined) return immediateSchedule();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: 'invalid', at: '', timeZone: '' };
    return {
      mode: value.mode,
      at: value.mode === 'scheduled' ? String(value.at || '') : '',
      timeZone: value.timeZone === undefined ? '' : value.timeZone
    };
  }
  function scheduleLabel(schedule) {
    if (schedule === undefined || schedule?.mode === 'immediate') return '立即发布';
    if (!schedule || typeof schedule !== 'object' || schedule.mode !== 'scheduled' || schedule.timeZone !== SCHEDULE_TIME_ZONE) return '发布时间配置无效，需重新核对';
    const at = typeof schedule.at === 'string' ? schedule.at.trim() : '';
    return at ? `${at.replace('T', ' ')} 北京时间` : '定时发布 · 尚未选择时间（北京时间）';
  }
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
  function scheduleTimingError(schedule) {
    if (schedule === undefined) return '';
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return '发布方式格式不正确，请选择立即发布或定时发布。';
    if (!['immediate', 'scheduled'].includes(schedule.mode)) return '发布方式无法识别，请选择立即发布或定时发布。';
    if (schedule.timeZone !== SCHEDULE_TIME_ZONE) return '定时发布时区必须是 Asia/Shanghai（北京时间 UTC+08:00）。';
    if (schedule.mode !== 'scheduled') return '';
    const at = typeof schedule.at === 'string' ? schedule.at.trim() : '';
    if (!at) return '定时发布请先选择发布时间（北京时间）。';
    if (!SCHEDULE_AT_PATTERN.test(at)) return '定时发布时间格式不正确，请重新选择（北京时间）。';
    const date = parseScheduleAt(at);
    if (!date) return '定时发布时间不是真实存在的日期或时间，请重新选择（北京时间）。';
    if (date.getTime() <= Date.now()) return '定时发布时间已过，请选择未来的北京时间。';
    return '';
  }
  const state = {
    bootstrapped: false, platforms: platformDefaults, connections: {}, connectionBusy: new Set(), chromeConnectorPath: 'chrome-connector',
    teachers: [], environments: [], deviceId: '', accountPairs: {}, accountChecks: {}, browserSessions: {}, browserAvailability: [],
    accounts: [], templates: [], drafts: [], runs: [], liveSessions: {},
    engine: { ready: false, reason: '真实发布尚未接通；当前仅支持本地演练。' },
    currentDraft: newDraft(), dirty: false, currentView: 'home', wizardStep: 1, libraryTab: 'tags',
    commonTags: {}, showUnselectedPlatforms: false, review: null,
    realReview: null, publishReview: null, stopReview: null, unbindReview: null,
    realStarting: false, realStopping: false, authorizing: false,
    saving: false, starting: false, savingTeacher: false, savingAccount: false,
    unbindBusy: false, readinessBusy: false, pairBusy: new Set(), inspectBusy: new Set(), assignBusy: new Set(),
    unsubscribe: null, expandedRuns: new Set()
  };
  const pairExpiryTimers = new Map();
  let teacherProfileUI;
  let managedPilotUI;
  let publishHistoryUI;
  const connectionPanels = new Set();
  let refreshingIndicators = false;

  function newTarget(platform) {
    return {
      platform, enabled: false, accountId: '', inherit: true,
      title: '', description: '', tags: [], covers: { landscape: null, portrait: null },
      declaration: { required: false, text: '' }, collection: { required: false, name: '' },
      location: { mode: 'none', name: '' }
    };
  }
  function newDraft() {
    return {
      teacherId: '', name: '', video: null, covers: { landscape: null, portrait: null },
      schedule: immediateSchedule(),
      common: { title: '', description: '', tags: [] },
      sharedDeclaration: { intent: 'none' },
      targets: platformDefaults.map(p => newTarget(p.id))
    };
  }
  const targetFor = id => {
    state.currentDraft.targets ||= [];
    let target = state.currentDraft.targets.find(target => target.platform === id);
    if (!target) { target = newTarget(id); state.currentDraft.targets.push(target); }
    return target;
  };
  const platformFor = id => state.platforms.find(platform => platform.id === id) || platformDefaults.find(platform => platform.id === id) || { id, label: id, color: '#77827b', coverSlots: ['landscape'], capabilities: {} };
  const platformTheme = id => ({ douyin: 'platform-douyin', tencent: 'platform-tencent', xiaohongshu: 'platform-xiaohongshu' })[id] || 'platform-neutral';
  const copyDraft = draft => structuredClone(draft);
  const splitTags = value => [...new Set(String(value || '').split(/[,，\n#]+/).map(tag => tag.trim()).filter(Boolean))];
  const text = (parent, value) => { parent.textContent = value == null ? '' : String(value); return parent; };
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const button = (label, className, handler, disabled = false) => {
    const node = el('button', className, label);
    node.type = 'button';
    node.disabled = disabled;
    if (handler) node.addEventListener('click', handler);
    return node;
  };
  const option = (label, value) => {
    const node = el('option', '', label); node.value = value; return node;
  };
  function toast(message, isError = false) {
    const host = $('#toast-region');
    const item = el('div', `toast${isError ? ' error' : ''}`, message);
    host.replaceChildren(item);
    setTimeout(() => item.remove(), 4200);
  }
  async function invoke(method, ...args) {
    if (!bridgeAvailable) throw new Error('请在桌面版中使用此功能；浏览器预览没有连接本机桥接。');
    return publisher[method](...args);
  }
  async function invokeReal(method, ...args) {
    if (!realTestApiAvailable) throw new Error('此桌面版本尚未接入真实测试桥接；本地演练仍可使用。');
    return publisher[method](...args);
  }
  function hasPublisherMethod(name) {
    return !!publisher && typeof publisher[name] === 'function';
  }
  async function invokeTeacher(method, ...args) {
    if (!teacherApiAvailable || !hasPublisherMethod(method)) throw new Error('此桌面版本尚未接入老师账号管理桥接；旧账号和任务历史仍可查看，但不能新增或迁移。');
    return publisher[method](...args);
  }
  async function invokePair(method, ...args) {
    if (!pairApiAvailable || !hasPublisherMethod(method)) throw new Error('此桌面版本尚未接入账号连接桥接；账号备注和历史仍可查看，但不能连接、核对或解除。');
    return publisher[method](...args);
  }
  function controlCharacter(value) {
    return /[\u0000-\u001f\u007f]/.test(String(value || ''));
  }
  function labelError(value, kind) {
    const label = String(value || '').trim();
    if (!label) return `请填写${kind}。`;
    if (label.length > 100) return `${kind}不能超过 100 个字符。`;
    if (controlCharacter(label)) return `${kind}不能包含控制字符。`;
    return '';
  }
  function teacherById(id) {
    return typeof id === 'string' && id ? state.teachers.find(teacher => teacher.id === id) || null : null;
  }
  function teacherName(id) {
    const teacher = teacherById(id);
    return teacher ? String(teacher.name || '') : '';
  }
  function teacherLabel(id) {
    if (!id) return '未分配';
    const teacher = teacherById(id);
    return teacher ? (String(teacher.name || '') || '未命名老师') : '老师记录缺失';
  }
  function teacherAccounts(id) {
    return state.accounts.filter(account => accountTeacherId(account) === (typeof id === 'string' ? id : ''));
  }
  function accountById(id) {
    return typeof id === 'string' && id ? state.accounts.find(account => account.id === id) || null : null;
  }
  function accountTeacherId(account) {
    return account && typeof account.teacherId === 'string' ? account.teacherId : '';
  }
  function accountTeacherLabel(account) {
    const id = accountTeacherId(account);
    if (!id) return '未分配老师（旧备注）';
    const teacher = teacherById(id);
    return teacher ? (String(teacher.name || '') || '未命名老师') : '老师记录缺失';
  }
  function bindingOf(account) {
    const binding = account && account.binding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    if (!String(binding.platformAccountId || '').trim()) return null;
    if (binding.source !== 'managed_browser' && !String(binding.connectorInstanceId || '').trim()) return null;
    if (!String(binding.environmentId || '').trim()) return null;
    return binding;
  }
  function accountStatusMismatch(account) {
    if (!account) return false;
    const bound = !!bindingOf(account);
    const status = account.status;
    return (status === 'bound' && !bound) || (bound && typeof status === 'string' && status !== 'bound');
  }
  function environmentFor(account) {
    const binding = bindingOf(account);
    if (!binding) return null;
    return state.environments.find(environment =>
      environment && (environment.id === binding.environmentId || (binding.connectorInstanceId && environment.connectorInstanceId === binding.connectorInstanceId))
    ) || null;
  }
  function environmentLabelFor(account) {
    const binding = bindingOf(account);
    if (!binding) {
      const assigned = state.environments.find(environment => environment.id === account.browserEnvironmentId);
      return assigned?.label || (account.browserEnvironmentId ? '已分配专属浏览器' : '暂无环境');
    }
    const environment = environmentFor(account);
    const label = environment && typeof environment.label === 'string' ? environment.label.trim() : '';
    return label || binding.environmentId;
  }
  function accountOnline(account) {
    if (!bindingOf(account)) return false;
    const environment = environmentFor(account);
    return environment?.online === true;
  }
  // 账号页的核对状态文字。窗口开着且上次核对一致时显示核对时间，
  // 不因为超过5分钟就写成“当前未核对”。
  function accountCheckLabel(account) {
    if (accountOnline(account)) return '近期核对一致';
    const session = state.browserSessions?.[account.id];
    const checkedAt = Date.parse(session?.checkedAt || '');
    if (session?.windowOpen && ['verified', 'bound'].includes(session.state) && Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5000) {
      const minutes = Math.max(5, Math.floor((Date.now() - checkedAt) / 60000));
      return `${minutes >= 120 ? Math.floor(minutes / 60) + '小时前' : minutes + '分钟前'}核对一致`;
    }
    return '当前未核对';
  }
  function accountRealId(account) {
    const binding = bindingOf(account);
    return binding ? String(binding.platformAccountId) : '';
  }
  function accountDisplay(account) {
    if (!account) return '未选择';
    const realId = accountRealId(account);
    return `${account.label || '未命名账号'} · ${realId ? `真实号 ${realId}` : '未绑定真实号'}`;
  }
  function targetAccountEligible(account, platform, teacherId) {
    return !!account && !!teacherById(teacherId) && account.platform === platform && accountTeacherId(account) === teacherId;
  }
  function availableAccountsFor(platform) {
    const teacherId = state.currentDraft.teacherId || '';
    if (!teacherById(teacherId)) return [];
    return state.accounts.filter(account => targetAccountEligible(account, platform, teacherId));
  }
  function sanitizeDraftAccounts() {
    const teacherId = state.currentDraft.teacherId || '';
    let changed = false;
    (state.currentDraft.targets || []).forEach(target => {
      if (!target.accountId) return;
      const account = accountById(target.accountId);
      if (!targetAccountEligible(account, target.platform, teacherId)) {
        target.accountId = '';
        changed = true;
      }
    });
    return changed;
  }
  function clearTeacherScopedTargets() {
    state.currentDraft.sharedDeclaration = { intent: 'none' };
    (state.currentDraft.targets || []).forEach(target => {
      target.accountId = '';
      target.declaration = { required: false, text: '' };
      target.collection = { required: false, name: '' };
      target.location = { mode: 'none', name: '' };
      target.specialSettings = {};
      target.title = '';
      target.description = '';
      target.tags = [];
      target.covers = { landscape: null, portrait: null };
      target.inherit = true;
    });
  }
  function normalizeDraftTeacher({ announce = false } = {}) {
    const raw = state.currentDraft.teacherId;
    const id = typeof raw === 'string' ? raw : '';
    if (!id) {
      state.currentDraft.teacherId = '';
      return typeof raw !== 'string' && raw !== undefined && raw !== null;
    }
    if (teacherById(id)) return false;
    state.currentDraft.teacherId = '';
    if (announce) toast('原任务老师记录不存在，已恢复为“未选择老师”；请重新选择老师和账号。', true);
    return true;
  }
  function reconcileDraftAfterBootstrap({ announce = false } = {}) {
    const teacherChanged = normalizeDraftTeacher({ announce });
    const accountsChanged = sanitizeDraftAccounts();
    return teacherChanged || accountsChanged;
  }
  function applyTeacherDefaults() {
    const defaults = new Set(teacherById(state.currentDraft.teacherId)?.defaultPlatforms || []);
    state.currentDraft.targets.forEach(target => {
      target.enabled = defaults.has(target.platform);
      target.accountId = '';
      const accounts = availableAccountsFor(target.platform);
      if (target.enabled && accounts.length === 1) target.accountId = accounts[0].id;
    });
  }
  function draftHasContent(draft) {
    return !!(draft.id || draft.video || draft.common?.title || draft.common?.description || draft.common?.tags?.length
      || draft.schedule?.mode === 'scheduled' || draft.sharedDeclaration?.intent && draft.sharedDeclaration.intent !== 'none' || draft.targets?.some(t => t.enabled || t.accountId || t.title || t.description
        || t.tags?.length || t.covers?.landscape || t.covers?.portrait || t.declaration?.required || t.collection?.required || Object.values(t.specialSettings || {}).some(v => v !== 'platform_default')));
  }
  async function selectDraftTeacher(teacherId) {
    const next = teacherById(teacherId) ? teacherId : '';
    const previous = state.currentDraft.teacherId || '';
    if (previous === next) { renderTeacherSelection(); return; }
    if (state.saving || state.starting || state.realStarting) { renderTeacherSelection(); return; }
    state.saving = true; renderTeacherSelection(); updateOverview();
    try {
      if (draftHasContent(state.currentDraft)) {
        const saved = await invoke('saveDraft', { ...copyDraft(state.currentDraft), name: currentDraftName() });
        state.drafts = [saved, ...state.drafts.filter(draft => draft.id !== saved.id)];
      }
      delete state.currentDraft.id; delete state.currentDraft.updatedAt; state.currentDraft.name = '';
      state.currentDraft.teacherId = next;
      clearTeacherScopedTargets(); applyTeacherDefaults(); state.dirty = true;
      if (state.review) closeReview();
      renderAccounts(); renderTemplates(); renderDraftPicker(); syncDraftForm();
      toast(next
        ? '已切换老师并带入默认平台。原任务已保留为草稿；本页保留视频和通用文案，账号、声明、合集及独立内容已重置。'
        : '已取消老师选择。原任务已保留为草稿；请重新选择老师和账号。');
    } catch (error) { toast(`原任务保存失败，尚未切换老师：${error.message}`, true); }
    finally { state.saving = false; renderTeacherSelection(); updateOverview(); }
  }
  function sanitizePair(pair) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) return null;
    const clean = { ...pair };
    const originalCode = typeof pair.pairCode === 'string' ? pair.pairCode : '';
    ['token', 'pairToken', 'cookie', 'cookies', 'secret', 'accessToken', 'refreshToken', 'storageState', 'credentials']
      .forEach(key => { delete clean[key]; });
    if (clean.state !== 'awaiting_pair') {
      if (originalCode && typeof clean.message === 'string') clean.message = clean.message.split(originalCode).join('[一次性码已隐藏]');
      clean.pairCode = '';
    }
    if (typeof clean.pairCode !== 'string') clean.pairCode = '';
    if (clean.state === 'awaiting_confirmation' && clean.candidate && typeof clean.candidate === 'object' && !Array.isArray(clean.candidate)) {
      clean.candidate = {
        platformAccountId: typeof clean.candidate.platformAccountId === 'string' ? clean.candidate.platformAccountId : '',
        displayName: typeof clean.candidate.displayName === 'string' ? clean.candidate.displayName : '',
        environmentLabel: typeof clean.candidate.environmentLabel === 'string' ? clean.candidate.environmentLabel : ''
      };
    } else clean.candidate = null;
    return clean;
  }
  function pairExpired(pair) {
    if (!pair || !pair.expiresAt) return false;
    const time = Date.parse(String(pair.expiresAt));
    return Number.isFinite(time) && time <= Date.now();
  }
  function visiblePairCode(pair) {
    if (!pair || pair.state !== 'awaiting_pair' || !pair.pairCode) return '';
    const expires = Date.parse(String(pair.expiresAt || ''));
    if (!Number.isFinite(expires) || expires <= Date.now()) return '';
    return String(pair.pairCode).trim().slice(0, 128);
  }
  function pairFor(accountId) {
    return typeof accountId === 'string' ? state.accountPairs[accountId] || null : null;
  }
  function pairErrorMessage(error, accountId) {
    let message = realErrorMessage(error);
    const pair = pairFor(accountId);
    const code = pair && typeof pair.pairCode === 'string' ? pair.pairCode : '';
    if (code) message = message.split(code).join('[一次性码已隐藏]');
    return message;
  }
  function clearPairExpiry(accountId) {
    const timer = pairExpiryTimers.get(accountId);
    if (timer) clearTimeout(timer);
    pairExpiryTimers.delete(accountId);
  }
  function schedulePairExpiry(accountId, pair) {
    clearPairExpiry(accountId);
    if (!pair || pair.state !== 'awaiting_pair' || !pair.expiresAt) return;
    const expires = Date.parse(String(pair.expiresAt));
    if (!Number.isFinite(expires)) return;
    const delay = expires - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      pairExpiryTimers.delete(accountId);
      const current = state.accountPairs[accountId];
      if (!current || current !== pair || current.state !== 'awaiting_pair') return;
      current.state = 'expired';
      current.pairCode = '';
      current.candidate = null;
      current.message = '连接码已过期，请重新连接。';
      renderAccounts();
      if (state.currentView === 'new') syncPlatformCards();
    }, Math.min(delay + 50, 2147483000));
    pairExpiryTimers.set(accountId, timer);
  }
  function pairStateLabel(pair) {
    return ({
      not_started: '尚未连接',
      awaiting_pair: '等待扩展提交一次只读识别结果',
      awaiting_confirmation: '已识别到候选账号，等待你明确确认',
      bound: '绑定已确认',
      error: '连接遇到问题',
      expired: '连接码已过期',
      canceled: '本次连接已取消'
    })[pair?.state] || '连接状态待核对';
  }
  function candidateFor(pair) {
    const candidate = pair && pair.candidate;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    return {
      platformAccountId: safeShort(candidate.platformAccountId, 80),
      displayName: safeShort(candidate.displayName, 120),
      environmentLabel: safeShort(candidate.environmentLabel, 100)
    };
  }
  function normalizePairCollection(value) {
    pairExpiryTimers.forEach(timer => clearTimeout(timer));
    pairExpiryTimers.clear();
    const result = {};
    const entries = Array.isArray(value)
      ? value.map(pair => [pair?.accountId, pair])
      : Object.entries(value && typeof value === 'object' ? value : {});
    entries.forEach(([key, pair]) => {
      const clean = sanitizePair(pair);
      if (!clean) return;
      if (typeof clean.accountId !== 'string' && typeof key === 'string' && key) clean.accountId = key;
      if (typeof clean.accountId !== 'string') return;
      if (clean.state === 'awaiting_pair' && pairExpired(clean)) {
        const expiredCode = clean.pairCode;
        clean.state = 'expired';
        clean.message = clean.message || '连接码已过期，请重新连接。';
        if (expiredCode && typeof clean.message === 'string') clean.message = clean.message.split(expiredCode).join('[一次性码已隐藏]');
        clean.pairCode = '';
      }
      result[clean.accountId] = clean;
    });
    Object.values(result).forEach(pair => schedulePairExpiry(pair.accountId, pair));
    return result;
  }
  function mergeAccountPair(input) {
    const pair = sanitizePair(input);
    if (!pair || typeof pair.accountId !== 'string') return;
    const previous = state.accountPairs[pair.accountId] || null;
    if (pair.state === 'awaiting_pair' && pairExpired(pair)) {
      const expiredCode = pair.pairCode;
      pair.state = 'expired';
      pair.message = pair.message || '连接码已过期，请重新连接。';
      if (expiredCode && typeof pair.message === 'string') pair.message = pair.message.split(expiredCode).join('[一次性码已隐藏]');
      pair.pairCode = '';
    }
    state.accountPairs[pair.accountId] = pair;
    schedulePairExpiry(pair.accountId, pair);
    if (pair.state === 'awaiting_confirmation' && previous?.state !== 'awaiting_confirmation') {
      toast('已识别到候选账号；请核对真实号，只有你点击确认才会绑定。');
    } else if (pair.state === 'bound' && previous?.state !== 'bound') {
      refreshBootstrap({ preserveDraft: true }).catch(error => toast(error.message, true));
    } else if (pair.state === 'error' && previous?.state !== 'error') {
      toast(pair.message || '账号连接遇到问题。', true);
    } else if (pair.state === 'expired' && previous?.state !== 'expired') {
      toast('账号连接码已过期，请重新连接。', true);
    }
    renderAccounts();
    if (state.currentView === 'new') syncPlatformCards();
  }
  function mergeTeacherRecord(record) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) return null;
    const index = state.teachers.findIndex(teacher => teacher.id === record.id);
    if (index >= 0) {
      state.teachers[index] = { ...state.teachers[index], ...record };
      return state.teachers[index];
    }
    state.teachers.push(record);
    return record;
  }
  function mergeAccountRecord(record) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) return null;
    const index = state.accounts.findIndex(account => account.id === record.id);
    if (index >= 0) {
      state.accounts[index] = { ...state.accounts[index], ...record };
      return state.accounts[index];
    }
    state.accounts.push(record);
    return record;
  }
  function accountProviderNote() {
    if (!bridgeAvailable) return '浏览器预览没有桌面桥接；老师、账号与连接操作不可用。';
    if (!teacherApiAvailable) return '此桌面版本尚未接入老师账号管理桥接；旧账号和任务历史仍可查看，但不能新增老师、账号或迁入。';
    if (!pairApiAvailable) return '老师与账号可管理；此桌面版本尚未接入账号连接桥接，连接、核对和解除会安全停用。';
    return '默认平台只用于新任务的初始选择。五个平台均可在此连接专属浏览器并核对；新平台仍需逐个完成本机真实验收。';
  }
  function renderTeacherSelection() {
    const select = $('#draft-teacher');
    if (!select) return;
    const current = state.currentDraft.teacherId || '';
    select.replaceChildren(option('不选择老师（未分配）', ''));
    state.teachers.forEach(teacher => select.append(option(teacher.name || '未命名老师', teacher.id)));
    select.value = current && teacherById(current) ? current : '';
    select.disabled = !bridgeAvailable || state.saving || state.starting;
    renderStep1Teachers();
  }

  function isRealRun(run) { return run?.mode === 'chrome_prepare'; }
  function safeShort(value, limit = 120) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }
  function realErrorMessage(error) {
    const raw = error && typeof error.message === 'string' ? error.message : '操作失败。';
    return raw
      .replace(/\b[a-f0-9]{32}\b/gi, '[任务码已隐藏]')
      .replace(/(配对码|一次性码|任务码|pairCode|pair code)\s*[：:=]\s*[A-Za-z0-9_-]{4,}/gi, '$1：[已隐藏]')
      .slice(0, 500);
  }
  function runAccountDisplay(run) {
    const item = run?.items?.[0];
    const values = [
      run?.accountDisplay, run?.actualAccount, run?.actualAccountLabel,
      run?.account?.displayName, run?.account?.nickname,
      item?.accountDisplay, item?.actualAccount, item?.actualAccountLabel,
      item?.account?.displayName, item?.account?.nickname
    ];
    return values.map(value => safeShort(value, 120)).find(Boolean) || '';
  }
  function realRunStatusLabel(status) {
    return ({
      queued: '等待本机交接', running: '正在上传填写', awaiting_browser: '等待助手连接',
      preparing: '正在上传填写', needs_manual: '需人工核对', awaiting_confirmation: '等待确认发布',
      approved: '已授权，等待助手提交', submitting: '正在提交', submitted: '已提交，待平台审核',
      awaiting_verification: '结果待核查', canceled: '已停止', failed: '明确失败'
    })[status] || safeShort(status, 80) || '状态未知';
  }
  function realItemStatusLabel(status) {
    return ({
      queued: '等待交接', running: '上传填写中', awaiting_browser: '等待助手',
      preparing: '上传填写中', needs_manual: '需人工核对', awaiting_confirmation: '等待确认',
      approved: '已授权', submitting: '提交中', submitted: '已提交',
      awaiting_verification: '结果待核查', canceled: '已停止', failed: '失败'
    })[status] || safeShort(status, 80) || '状态未知';
  }
  function realRunBadgeClass(status) {
    if (['awaiting_confirmation', 'needs_manual', 'awaiting_verification'].includes(status)) return 'attention';
    if (status === 'submitted') return 'pending';
    if (status === 'failed') return 'failed';
    if (status === 'canceled') return 'canceled';
    if (['queued', 'running', 'awaiting_browser', 'preparing', 'approved', 'submitting'].includes(status)) return 'real-active';
    return '';
  }
  function realPanelRun() {
    const realRuns = state.runs.filter(isRealRun);
    return realRuns.find(run => REAL_ACTIVE_STATUSES.has(run.status))
      || realRuns.find(run => REAL_PANEL_STATUSES.has(run.status))
      || realRuns.find(run => !['canceled', 'failed'].includes(run.status))
      || null;
  }
  function activeRealRun() {
    return state.runs.find(run => isRealRun(run) && REAL_ACTIVE_STATUSES.has(run.status)) || null;
  }
  function hasActiveRealTask() {
    return state.runs.some(run => isRealRun(run) && !['submitted', 'awaiting_verification', 'canceled', 'failed'].includes(run.status));
  }
  function sessionFor(run) { return run?.id ? state.liveSessions[run.id] || null : null; }
  function realSessionStateLabel(session) {
    return ({
      awaiting_browser: '等待助手连接', awaiting_helper: '等待助手连接', awaiting_pair: '等待助手连接', waiting: '等待助手连接',
      connected: '助手已连接', active: '助手已连接', ready: '助手已连接',
      submitted: '本机交接已关闭', awaiting_verification: '结果待核查', canceled: '本机交接已停止',
      closed: '本机交接已关闭', expired: '任务码已过期', error: '连接遇到问题', failed: '连接遇到问题'
    })[session?.state] || (session?.state ? `本机状态：${safeShort(session.state, 60)}` : '等待本机交接信息');
  }
  function visibleSessionCode(run, session) {
    if (!session?.pairCode || run?.status !== 'awaiting_browser' || session.state !== 'awaiting_browser') return '';
    return safeShort(session.pairCode, 128);
  }
  function canStopRealRun(run) {
    return !!run && ['queued', 'running', 'awaiting_browser', 'preparing', 'needs_manual', 'awaiting_confirmation', 'approved'].includes(run.status);
  }
  function realCovers(draft, target) {
    return {
      landscape: target?.covers?.landscape || draft?.covers?.landscape || null,
      portrait: target?.covers?.portrait || draft?.covers?.portrait || null
    };
  }
  function realCopy(draft, target) {
    return target?.inherit === false ? target : draft?.common || {};
  }
  function realPublishReady() {
    return state.engine?.ready === true && state.engine?.douyinPilot === true;
  }
  function realSnapshotFor(draft, target) {
    const copy = realCopy(draft, target);
    const covers = realCovers(draft, target);
    const teacherId = typeof draft?.teacherId === 'string' ? draft.teacherId : '';
    const account = state.accounts.find(item => item.id === target?.accountId && item.platform === 'douyin' && accountTeacherId(item) === teacherId);
    const binding = account ? bindingOf(account) : null;
    const accountLabel = account
      ? `${account.label}${binding ? ` · 抖音号 ${binding.platformAccountId}` : ' · 未绑定真实号'}`
      : '未选择';
    return {
      platform: '抖音', teacherId, teacherLabel: teacherLabel(teacherId), accountLabel,
      video: draft?.video || null, title: copy.title || '', description: copy.description || '', tags: copy.tags || [],
      covers,
      schedule: scheduleOf(draft),
      declaration: target?.declaration?.required ? target.declaration.text || '' : '',
      declarationRequired: target?.declaration?.required === true,
      collection: target?.collection?.required ? target.collection.name || '' : '',
      collectionRequired: target?.collection?.required === true,
      location: '不填写定位'
    };
  }
  function realTaskBlocker() {
    if (!bridgeAvailable) return '浏览器预览无法使用真实测试。';
    if (!realPublishReady()) return '自动发布流程仍在开发；当前可连接账号、检查身份及本地演练。';
    if (!realTestApiAvailable) return '此桌面版本尚未接入真实测试桥接；本地演练仍可使用。';
    if (state.realStarting) return '正在创建真实测试，请稍候。';
    if (state.realStopping) return '正在停止本机交接，请稍候。';
    if (hasActiveRealTask()) return '已有真实任务进行中；同一时间只允许一个。';
    const enabled = activeTargets();
    if (!enabled.length) return '请先只勾选抖音一个平台。';
    if (enabled.length !== 1 || enabled[0].platform !== 'douyin') return '真实测试只支持单独勾选抖音。';
    const target = enabled[0];
    const draft = state.currentDraft;
    if (!teacherById(draft.teacherId)) return '请先选择有效的任务归属老师。';
    if (!draft.video) return '请先选择本次视频。';
    const covers = realCovers(draft, target);
    if (!covers.landscape) return '请先选择横版封面。';
    if (!covers.portrait) return '请先选择竖版封面。';
    if (covers.landscape.width && covers.landscape.height && covers.landscape.width <= covers.landscape.height) return '横版封面的图片方向不符合用途，请重新选择。';
    if (covers.portrait.width && covers.portrait.height && covers.portrait.height <= covers.portrait.width) return '竖版封面的图片方向不符合用途，请重新选择。';
    if (!state.accounts.some(account => account.id === target.accountId && account.platform === 'douyin' && accountTeacherId(account) === draft.teacherId)) return '请为抖音选择当前老师名下的账号；未绑定真实号也不能视为可发布。';
    const copy = realCopy(draft, target);
    if (!String(copy.title || '').trim()) return '请填写标题。';
    const timing = scheduleTimingError(draft.schedule);
    if (timing) return timing;
    if (target.declaration?.required && !String(target.declaration.text || '').trim()) return '已要求原生声明，请填写声明原文。';
    if (target.collection?.required && !String(target.collection.name || '').trim()) return '已要求已有合集，请填写合集名称。';
    return '';
  }

  function showModal(selector, focusSelector) {
    const modal = $(selector);
    if (!modal) return;
    $('#toast-region').replaceChildren();
    modal.hidden = false;
    $('.app-shell').inert = true;
    const focus = focusSelector ? $(focusSelector) : null;
    if (focus && typeof focus.focus === 'function') focus.focus();
  }
  function hideModal(selector) {
    const modal = $(selector);
    if (!modal) return;
    modal.hidden = true;
    if (!$('.modal-backdrop:not([hidden])')) $('.app-shell').inert = false;
  }
  function setDirty() {
    state.dirty = true;
    if (state.review) {
      state.review.valid = false;
      $('#confirm-rehearsal').disabled = true;
      const warning = el('div', 'validation-item error', '设置已变化，请关闭总览后重新检查。');
      $('#validation-list').replaceChildren(warning);
    }
    updateOverview();
  }
  function currentDraftName() {
    return state.currentDraft.common.title.trim().slice(0, 42) || state.currentDraft.name || '未命名草稿';
  }
  function activeTargets() { return state.currentDraft.targets.filter(target => target.enabled); }
  function setValue(selector, value) { $(selector).value = value || ''; }
  function selectedAccountLabel(target) {
    const teacherId = state.currentDraft.teacherId || '';
    const account = state.accounts.find(item => item.id === target.accountId && item.platform === target.platform && accountTeacherId(item) === teacherId);
    return account ? accountDisplay(account) : '未选择';
  }
  function connectionFor(accountId) {
    return state.connections[accountId] || { accountId, state: 'not_open', message: '尚未开始Chrome配对。' };
  }
  function extensionDirectoryLabel() { return String(state.chromeConnectorPath || 'chrome-connector'); }
  function connectionStateLabel(connection) {
    if (connection?.state === 'awaiting_login' && connection.source === 'chrome') return '当前Chrome标签页仍显示登录入口，请核对标签';
    return ({ not_open: '尚未开始配对', awaiting_pair: '等待Chrome扩展提交一次只读结果', awaiting_login: '等待登录', checking: '正在接收只读结果', awaiting_identity: connection?.source === 'chrome' ? '已收到Chrome只读结果 · 身份待核验' : '检测到页面迹象 · 身份待核验', rate_limited: '请求过于频繁，请稍后再试', expired: '配对已过期，请重新开始', error: '连接遇到问题' })[connection?.state] || '状态待更新';
  }
  function safePagePath(value) { return String(value || '').split(/[?#]/, 1)[0]; }
  function mergeConnection(connection) {
    if (!connection || typeof connection.accountId !== 'string') return;
    // 旧版 Chrome 只读探针仅保留历史数据；新账号连接使用 account_pair，不再覆盖账号面板。
    state.connections[connection.accountId] = connection;
  }
  function connectionFieldsView(connection) {
    const fields = connection?.fields;
    if (!fields || typeof fields !== 'object') return null;
    const labels = [['landscape', '横版封面'], ['portrait', '竖版封面'], ['tags', '标签'], ['declaration', '声明'], ['collection', '合集']];
    const list = el('div', 'connection-fields');
    labels.forEach(([key, label]) => {
      if (typeof fields[key] !== 'boolean') return;
      const detected = fields[key];
      const chip = el('span', `field-detection${detected ? ' detected' : ''}`, `${label}：${detected ? '当前页面检测到' : '当前页面未检测到'}`);
      list.append(chip);
    });
    list.append(el('small', 'connection-field-note', '这里只检查当前页面可见字样，未检测到不代表平台不支持，也不代表字段已设置成功。'));
    return list;
  }
  function runConnectionAction(action, accountId) {
    if (!connectionApiAvailable || !accountId || state.connectionBusy.has(accountId)) return;
    state.connectionBusy.add(accountId);
    updateConnectionPanels(accountId);
    Promise.resolve().then(() => publisher[action](accountId)).then(mergeConnection).catch(() => {
      toast('Chrome配对操作失败。请回到账号备注后重试；配对码不会显示在错误提示中。', true);
    }).finally(() => {
      state.connectionBusy.delete(accountId);
      renderAccounts(); updateConnectionPanels(accountId);
    });
  }
  function connectionSummary(parent, connection, accountId) {
    parent.replaceChildren();
    const stateLine = el('div', 'connection-state');
    stateLine.append(el('b', '', connectionStateLabel(connection)), el('span', '', connection?.message || '登录身份与字段仍待核验。'));
    parent.append(stateLine);
    if (connection?.state === 'awaiting_pair') {
      const pairDetails = el('div', 'pair-details');
      pairDetails.append(el('span', '', `本机端口：${connection.port ?? '未提供'}`));
      pairDetails.append(el('span', '', '一次性配对码：'));
      pairDetails.append(el('code', 'pair-code', connection.pairCode || '等待配对码'));
      pairDetails.append(el('small', '', `有效至：${formatDate(connection.expiresAt)}`));
      parent.append(pairDetails);
    }
    const path = safePagePath(connection?.pagePath);
    if (path) parent.append(el('small', 'connection-path', `当前页面：${path}`));
    if (connection?.checkedAt) parent.append(el('small', 'connection-checked', `检查时间：${formatDate(connection.checkedAt)}`));
    if (connection?.source === 'chrome' && connection?.checkedAt) parent.append(el('small', 'connection-source', '来源：用户主动点击扩展读取的当前Chrome标签页；身份和真实发布仍待核对。'));
    const fields = connectionFieldsView(connection);
    if (fields) parent.append(fields);
    parent.append(el('small', 'extension-location', `扩展目录：${extensionDirectoryLabel()}。这里只显示路径；安装仍需你确认，本操作台不会打开或安装。`));
    if (!connectionApiAvailable) parent.append(el('small', 'connection-unavailable', '此桌面版本尚未接入Chrome配对桥接。'));
  }
  function connectionButtons(parent, accountId, connection, variant = 'library') {
    const controls = el('div', `connection-buttons ${variant}`);
    const busy = !!accountId && state.connectionBusy.has(accountId);
    const isPairing = connection?.state === 'awaiting_pair';
    if (isPairing) {
      controls.append(button(busy ? '正在启动…' : '配对进行中', 'button button-outline', null, true));
      controls.append(button('停止配对', 'button button-quiet', () => runConnectionAction('stopChromePair', accountId), !connectionApiAvailable || !accountId || busy));
    } else {
      controls.append(button(busy ? '处理中…' : '连接已登录Chrome', variant === 'library' ? 'button button-outline' : 'tiny-link', () => runConnectionAction('startChromePair', accountId), !connectionApiAvailable || !accountId || busy));
    }
    parent.append(controls);
  }
  function updateConnectionPanels(accountId) {
    const account = state.accounts.find(item => item.id === accountId && item.platform === 'douyin');
    if (account) {
      const row = $$('#account-list [data-account-id]').find(item => item.dataset.accountId === accountId);
      if (row) {
        const status = $('.account-connection', row);
        connectionSummary(status, connectionFor(accountId), accountId);
        const buttonsHost = $('.account-connection-actions', row);
        if (buttonsHost) { buttonsHost.replaceChildren(); connectionButtons(buttonsHost, accountId, connectionFor(accountId)); }
      }
    }
    $$('.platform-card[data-platform="douyin"]').forEach(card => {
      const select = $('select[data-field="accountId"]', card);
      if (!select || select.value !== accountId) return;
      const status = $('.douyin-connection-status', card);
      if (status) connectionSummary(status, connectionFor(accountId), accountId);
      const actions = $('.douyin-connection-actions', card);
      if (actions) { actions.replaceChildren(); connectionButtons(actions, accountId, connectionFor(accountId), 'compact'); }
    });
  }
  function currentCopy(target) { return target.inherit ? state.currentDraft.common : target; }
  function byteLabel(size) {
    if (!Number.isFinite(size)) return '';
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderAssetSlot(kind, asset) {
    const slotId = kind === 'video' ? 'video-slot' : `${kind}-slot`;
    const slot = $(`#${slotId}`);
    if (!slot) return;
    const placeholder = $('.asset-placeholder, .cover-preview', slot);
    const meta = $('.asset-meta', slot);
    const previewVideo = $('.asset-video', slot);
    const previewImage = $('.asset-user-image', slot);
    slot.classList.toggle('has-asset', !!asset);
    meta.hidden = !asset;
    if (asset) {
      text($('.asset-name', meta), asset.name);
      text($('.asset-size', meta), [byteLabel(asset.size), asset.width && asset.height ? `${asset.width} × ${asset.height}` : ''].filter(Boolean).join(' · '));
      if (kind === 'video' && previewVideo) {
        previewVideo.src = asset.url || '';
        previewVideo.hidden = !asset.url;
      } else if (kind !== 'video') {
        if (!previewImage) {
          const image = document.createElement('img');
          image.className = 'asset-user-image'; image.alt = `${kind === 'landscape' ? '横版' : '竖版'}封面预览`;
          image.addEventListener('error', () => { image.hidden = true; });
          slot.insertBefore(image, meta || $('.asset-action', slot));
        }
        const image = $('.asset-user-image', slot);
        image.src = asset.url || '';
        image.hidden = !asset.url;
      }
    } else {
      if (previewVideo) { previewVideo.pause(); previewVideo.removeAttribute('src'); previewVideo.load(); previewVideo.hidden = true; }
      if (previewImage) { previewImage.removeAttribute('src'); previewImage.hidden = true; }
    }
    const action = $('.asset-action', slot);
    if (action) action.textContent = asset ? '重新选择' : (kind === 'video' ? '＋ 选择视频' : `＋ 选择${kind === 'landscape' ? '横版' : '竖版'}封面`);
    if (placeholder) placeholder.setAttribute('aria-hidden', asset ? 'true' : 'false');
    if (action) action.disabled = !bridgeAvailable;
    renderAssetDropBanner();
  }

  function fieldLabel(label, input, className = 'platform-field') {
    const wrapper = el('label', className);
    wrapper.append(el('span', '', label), input);
    return wrapper;
  }
  function textInput(placeholder, maxLength, value = '') {
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = placeholder; input.maxLength = maxLength; input.value = value; return input;
  }
  function textarea(placeholder, rows, value = '') {
    const input = document.createElement('textarea'); input.placeholder = placeholder; input.rows = rows; input.value = value; return input;
  }

  function renderPlatformCards() {
    const host = $('#platform-grid');
    host.replaceChildren();
    const defaults = new Set(teacherById(state.currentDraft.teacherId)?.defaultPlatforms || []);
    [...state.platforms].sort((a, b) => Number(defaults.has(b.id)) - Number(defaults.has(a.id))).forEach(platform => host.append(makePlatformCard(platform)));
    syncPlatformCards();
  }
  function reorderPlatformCards() {
    const host = $('#platform-grid');
    const defaults = new Set(teacherById(state.currentDraft.teacherId)?.defaultPlatforms || []);
    const order = [...state.platforms].sort((a,b) => Number(defaults.has(b.id))-Number(defaults.has(a.id)));
    const rank = new Map(order.map((platform,index) => [platform.id,index]));
    const cards = [...host.children].sort((a,b) => Number(targetFor(b.dataset.platform).enabled)-Number(targetFor(a.dataset.platform).enabled)
      || rank.get(a.dataset.platform)-rank.get(b.dataset.platform));
    const focused = document.activeElement;
    cards.forEach((card,index) => { if (host.children[index] !== card) host.insertBefore(card,host.children[index] || null); });
    if (focused && host.contains(focused) && document.activeElement !== focused) focused.focus({preventScroll:true});
  }
  function makePlatformCard(platform) {
    const target = targetFor(platform.id);
    const card = el('article', 'platform-card');
    card.dataset.platform = platform.id;
    const head = el('div', 'platform-card-head');
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'platform-check'; enabled.setAttribute('aria-label', `选择${platform.label}`);
    enabled.addEventListener('change', () => { target.enabled = enabled.checked; setDirty(); syncPlatformCards(); });
    const mark = el('span', `platform-mark ${platformTheme(platform.id)}`, platform.label.slice(0, 1));
    const title = el('div', 'platform-title'); title.append(el('b', '', platform.label), el('small', '', state.engine.managedPilot ? platform.id==='douyin'?'立即发布 · 账号与平台结果独立核对':'立即发布接入 · 待本机首次验收' : '请先连接当前老师的平台账号'));
    const capability = el('span', 'cap-chip'); capability.dataset.loginBadge = platform.id;
    head.append(enabled, mark, title, capability);
    if (window.PublishSchedule) { const limit = el('small', 'schedule-limit-chip', window.PublishSchedule.limitLabel(platform.id)); limit.dataset.scheduleLimit = platform.id; title.append(limit); }
    if (teacherById(state.currentDraft.teacherId)?.defaultPlatforms?.includes(platform.id)) title.append(el('span', 'task-default-badge', '老师默认平台 · 本次可取消'));

    const body = el('div', 'platform-body');
    const accountArea = el('div', 'platform-account-area');
    const accountRow = el('div', 'target-account');
    accountRow.append(el('span', '', '当前老师账号'));
    const accountSelect = document.createElement('select'); accountSelect.setAttribute('aria-label', `${platform.label}当前老师账号`); accountSelect.dataset.field = 'accountId';
    const teacherId = teacherById(state.currentDraft.teacherId) ? state.currentDraft.teacherId : '';
    if (!teacherId) accountSelect.append(option('先选择任务归属老师', ''));
    else {
      const accounts = availableAccountsFor(platform.id);
      if (!accounts.length) accountSelect.append(option('该老师暂无此平台账号', ''));
      else {
        accountSelect.append(option(accounts.length > 1 ? '请选择这位老师的具体账号' : '请选择账号（尚未选择）', ''));
        accounts.forEach(account => {
        const realId = accountRealId(account);
        accountSelect.append(option(`${account.label} · ${realId ? `真实号 ${realId}` : '未绑定'}`, account.id));
        });
      }
    }
    accountSelect.addEventListener('change', () => {
      target.accountId = accountSelect.value; setDirty(); syncPlatformCards();
    });
    const quickAdd = button('管理此老师账号', 'tiny-link', () => {
      switchView('accounts');
      teacherProfileUI?.open(state.currentDraft.teacherId || null, teacherId ? platform.id : undefined);
      if (!teacherId) toast('请先在完整表单中添加老师，再准备平台账号。');
    }, !teacherApiAvailable);
    accountRow.append(accountSelect, quickAdd);
    accountArea.append(accountRow);
    const accountSummary = el('div', 'target-account-state');
    accountSummary.dataset.accountSummary = 'selected';
    accountArea.append(accountSummary);
    const connection = el('div', 'publish-account-connection'); connection.dataset.connectionPanel = platform.id;
    accountArea.append(connection);

    const overrides = el('details', 'platform-content-overrides');
    if(platform.id==='tencent')body.append(el('p','field-note','标题、简介和话题一起写入视频描述，短标题留空。使用3:4竖封面，视频上传完成后再设置；通用横封面不用于视频号。默认不添加定位，并清除平台预填地点。'));
    overrides.append(el('summary', '', '单独调整本平台文案、标签或封面'));
    const inheritLabel = el('label', 'inherit-row');
    const inherit = document.createElement('input'); inherit.type = 'checkbox'; inherit.checked = true; inherit.dataset.field = 'inherit';
    inheritLabel.append(inherit, el('span', '', '使用通用文案与标签'));
    overrides.append(inheritLabel);

    const platformCopy = el('div', 'platform-copy'); platformCopy.hidden = true;
    const titleField = textInput('本平台标题', 300); titleField.dataset.field = 'title';
    const titleLabel = fieldLabel('独立标题', titleField);
    const descField = textarea('本平台简介', 2); descField.dataset.field = 'description';
    const descLabel = fieldLabel('独立简介', descField);
    const tagsField = textInput('标签以逗号分隔', 2000); tagsField.dataset.field = 'tags';
    const tagsLabel = fieldLabel('独立标签', tagsField);
    [titleField, descField, tagsField].forEach(input => input.addEventListener('input', () => {
      if (input.dataset.field === 'tags') target.tags = splitTags(input.value);
      else target[input.dataset.field] = input.value;
      setDirty();
    }));
    platformCopy.append(titleLabel, descLabel, tagsLabel);
    inherit.addEventListener('change', () => { target.inherit = inherit.checked; platformCopy.hidden = inherit.checked; setDirty(); });
    overrides.append(platformCopy);

    const coverRow = el('div', 'config-row'); coverRow.append(el('span', '', '封面覆盖'));
    const coverActions = el('div', 'target-cover-row');
    platform.coverSlots.forEach(kind => {
      const coverButton = button(`${kind === 'landscape' ? '横版' : '竖版'}：用通用封面`, 'cover-override-button', async () => {
        if (!bridgeAvailable) return;
        try {
          const asset = await invoke('chooseAsset', kind);
          if (asset) { target.covers[kind] = asset; setDirty(); syncPlatformCards(); }
        } catch (error) { toast(error.message, true); }
      }, !bridgeAvailable);
      coverButton.dataset.coverSlot = kind;
      coverActions.append(coverButton);
      const reset = button('恢复通用封面', 'tiny-link cover-reset', () => {
        target.covers[kind] = null; setDirty(); syncPlatformCards();
      }, !bridgeAvailable);
      reset.dataset.resetSlot = kind;
      reset.hidden = !target.covers[kind];
      coverActions.append(reset);
    });
    if (!platform.coverSlots.includes('portrait')) {
      coverActions.append(el('span', 'expectation-tag', '当前界面按单封面用途记录'));
    }
    coverRow.append(coverActions); overrides.append(coverRow);

    body.append(window.PublishSettingsUI.render({ platform, target, onChange: () => { setDirty(); syncPlatformCards(); } }));
    body.append(overrides);
    const legacySettings = el('details', 'legacy-settings');
    legacySettings.append(el('summary', '', '以前记录的声明与合集（保留，待平台核对）'));
    legacySettings.hidden = true;
    const declarationRow = el('div', 'config-row'); declarationRow.append(el('span', '', '原生声明'));
    const declarationLabel = el('label', '');
    const declarationToggle = document.createElement('input'); declarationToggle.type = 'checkbox'; declarationToggle.dataset.field = 'declaration-required';
    declarationLabel.append(declarationToggle, document.createTextNode('记录期望选项'));
    const declarationText = textInput('填写平台界面显示的准确原文', 500); declarationText.dataset.field = 'declaration-text'; declarationText.disabled = true;
    const declarationNote = el('small', 'expectation-tag', '尚未核验平台或账号是否提供该选项');
    declarationToggle.addEventListener('change', () => { target.declaration.required = declarationToggle.checked; declarationText.disabled = !declarationToggle.checked; setDirty(); });
    declarationText.addEventListener('input', () => { target.declaration.text = declarationText.value; setDirty(); });
    declarationLabel.append(declarationText, declarationNote); declarationRow.append(declarationLabel); legacySettings.append(declarationRow);

    const collectionRow = el('div', 'config-row'); collectionRow.append(el('span', '', '已有合集'));
    const collectionLabel = el('label', '');
    const collectionToggle = document.createElement('input'); collectionToggle.type = 'checkbox'; collectionToggle.dataset.field = 'collection-required';
    collectionLabel.append(collectionToggle, document.createTextNode('记录目标账号已有合集'));
    const collectionText = textInput('填写已有合集名称', 500); collectionText.dataset.field = 'collection-name'; collectionText.disabled = true;
    const collectionNote = el('small', 'expectation-tag', '不会创建合集；名称尚未核验');
    collectionToggle.addEventListener('change', () => { target.collection.required = collectionToggle.checked; collectionText.disabled = !collectionToggle.checked; setDirty(); });
    collectionText.addEventListener('input', () => { target.collection.name = collectionText.value; setDirty(); });
    collectionLabel.append(collectionText, collectionNote); collectionRow.append(collectionLabel); legacySettings.append(collectionRow);
    body.append(legacySettings);

    const creatorButton = button('打开官方创作中心 ↗', 'tiny-link creator-link', async () => {
      try { await invoke('openCreator', platform.id); } catch (error) { toast(error.message, true); }
    }, !bridgeAvailable);
    body.append(creatorButton);
    card.append(head, accountArea, body);
    return card;
  }

  function renderPlatformAccountStatus(card) {
    const platform = platformFor(card.dataset.platform);
    const readiness = window.PublishReadiness.platformState(platform, state);
    const badge = $('[data-login-badge]', card);
    badge.textContent = readiness.label; badge.className = `cap-chip login-badge ${readiness.tone}`;
    card.dataset.accountState = readiness.key;
    const summary = $('[data-account-summary]', card);
    summary.textContent = readiness.account
      ? `${readiness.account.label} · ${readiness.account.binding?.platformAccountId || '尚无真实号'}。${readiness.message}`
      : readiness.message;
    const host = $('[data-connection-panel]', card); host.replaceChildren();
    const account = readiness.account;
    if (!account) return;
    const busy = state.pairBusy.has(account.id) || state.inspectBusy.has(account.id) || state.readinessBusy;
    const actions = el('div', 'publish-account-actions');
    const openConnection = async () => {
      connectionPanels.add(account.id); renderPlatformAccountStatus(card);
      if (account.binding?.source === 'managed_browser' && state.browserSessions[account.id]?.windowOpen && ['verified', 'verified_earlier', 'bound_unchecked'].includes(readiness.key)) {
        await inspectManagedAccount(account.id);
      } else {
        const assigned = state.environments.find(e => e.id === account.browserEnvironmentId);
        const browserKind = assigned?.browserKind || state.browserAvailability.find(b => b.available)?.id;
        await browserAction(account.id, 'openAccountBrowser', { accountId: account.id, ...(browserKind ? { browserKind } : {}) });
      }
    };
    if (['unsupported', 'invalid_binding'].includes(readiness.key)) {
      actions.append(button('管理账号连接', 'button button-outline', () => { switchView('accounts'); teacherProfileUI?.open(account.teacherId, account.platform); }, !bridgeAvailable));
    } else if (readiness.key === 'awaiting_confirmation') {
      actions.append(button('核对并确认绑定 ↓', 'button button-outline', () => { connectionPanels.add(account.id); renderPlatformAccountStatus(card); }, busy));
    } else {
      const label = readiness.key === 'identity_unavailable' ? '继续连接' : readiness.key === 'unbound' ? '登录并连接账号'
        : readiness.key === 'login_required' ? '打开原窗口重新扫码'
        : ['mismatch', 'unverifiable'].includes(readiness.key) ? '打开原窗口核对'
        : readiness.key === 'checking' ? '正在识别账号…' : '检查登录状态';
      const available = state.browserAvailability.some(b => b.available);
      actions.append(button(label, 'button button-outline', openConnection, !browserApiAvailable || !available || busy || readiness.key === 'checking'));
      if (readiness.key === 'checking') actions.append(button('停止本次检查', 'button button-quiet', () => browserAction(account.id, 'cancelBrowserBinding', account.id), !browserApiAvailable));
      if (!available) actions.append(el('small', '', '未检测到可用的 Chrome 或 Edge 浏览器。'));
    }
    host.append(actions);
    const details = el('details', 'publish-connection-details');
    details.append(el('summary', '', '登录与绑定详情'));
    details.open = connectionPanels.has(account.id) || readiness.key === 'awaiting_confirmation';
    details.addEventListener('toggle', () => { if (details.open) connectionPanels.add(account.id); else connectionPanels.delete(account.id); });
    details.append(renderBrowserPanel(account)); host.append(details);
  }

  function renderPublishReadiness() {
    const host = $('#publish-account-readiness');
    if (!host) return;
    const readiness = window.PublishReadiness.summary(state);
    host.replaceChildren(); host.classList.toggle('has-blockers', readiness.blockers.length > 0);
    const title = !teacherById(state.currentDraft.teacherId) ? '先选择任务归属老师，再连接各平台账号'
      : !readiness.selected.length ? '先勾选发布平台；下方可提前连接各平台账号'
      : readiness.blockers.length ? `${readiness.blockers.length} 个所选平台需要处理，尚未开始发布`
      : `${readiness.selected.length} 个所选平台已绑定，发布前仍会核对登录`;
    host.append(el('b', '', title));
    for (const row of readiness.selected) {
      const line = el('div', `readiness-row ${row.tone}`);
      line.append(el('span', '', `${row.platformLabel}：${row.label}`));
      if (row.blocked) line.append(button('去处理', 'tiny-link', () => {
        if (row.key === 'no_teacher') { $('#draft-teacher').focus(); $('#draft-teacher').scrollIntoView({ block: 'center' }); return; }
        const card = $(`.platform-card[data-platform="${row.platform}"]`);
        card?.scrollIntoView({ block: 'center' });
        if (row.key === 'no_account') { switchView('accounts'); teacherProfileUI?.open(state.currentDraft.teacherId, row.platform); }
        else if (row.key === 'not_selected') $('select[data-field="accountId"]', card)?.focus();
        else $('.publish-account-actions button', card)?.focus();
      }));
      host.append(line);
    }
    if (readiness.blockers.length) host.append(el('p', '', '先处理账号，或取消勾选本次暂不发布的平台。勾选平台不会自动登录或绑定账号。'));
    return readiness;
  }

  // 定时发布：逐个列出已勾选平台的可选范围，以及当前所选时间在该平台行不行。
  function renderScheduleLimits() {
    const host = $('#schedule-limits'), api = window.PublishSchedule;
    if (!host || !api) return;
    const schedule = scheduleOf(state.currentDraft), scheduled = schedule.mode === 'scheduled';
    host.hidden = !scheduled; host.replaceChildren();
    $$('.platform-card').forEach(card => {
      const chip = $('[data-schedule-limit]', card);
      if (chip) chip.classList.toggle('blocked', scheduled && targetFor(card.dataset.platform).enabled && !!api.scheduleIssue(card.dataset.platform, schedule));
    });
    if (!scheduled) return;
    const input = $('#schedule-at'), targets = activeTargets();
    const windows = targets.map(t => api.windowFor(t.platform)).filter(Boolean);
    if (input) {
      // 时间选择器只放开所有“已接通”平台都接受的区间。
      input.min = windows.length ? api.formatAt(Math.max(...windows.map(w => w.earliest))) : '';
      input.max = windows.length ? api.formatAt(Math.min(...windows.map(w => w.latest))) : '';
    }
    host.append(el('b', '', targets.length ? '各平台定时范围（北京时间）' : '勾选平台后，这里会列出各平台的定时范围'));
    host.append(el('small', '', '本任务各平台共用一个北京时间。为上传填写预留30分钟，最晚时间另收紧1小时，这些是工具预留。'));
    for (const target of targets) {
      const issue = api.scheduleIssue(target.platform, schedule);
      const supported = api.limitFor(target.platform)?.supported;
      const row = el('div', `schedule-limit-row ${issue ? 'blocked' : 'ok'}`);
      row.dataset.platform = target.platform;
      row.append(el('span', 'schedule-limit-name', platformFor(target.platform).label), el('span', 'schedule-limit-range', api.limitLabel(target.platform).replace(/^定时：/, '')),
        el('span', 'schedule-limit-state', !issue ? '所选时间可用' : !supported ? '暂不能定时：请取消勾选本平台，或改成立即发布' : (!schedule.at ? '请选择时间' : issue)));
      host.append(row);
    }
  }
  function syncPlatformCards() {
    renderScheduleLimits();
    $$('.platform-card').forEach(card => {
      const id = card.dataset.platform;
      const target = targetFor(id);
      const enabled = $('.platform-check', card);
      enabled.checked = target.enabled;
      const defaultBadge = $('.task-default-badge', card);
      if (defaultBadge) defaultBadge.textContent = target.enabled ? '老师默认平台 · 本次已勾选' : '老师默认平台 · 本次未勾选';
      card.classList.toggle('selected', target.enabled);
      const body = $('.platform-body', card);
      body.classList.toggle('disabled', !target.enabled);
      const teacherId = teacherById(state.currentDraft.teacherId) ? state.currentDraft.teacherId : '';
      const accountSelect = $('select[data-field="accountId"]', card);
      const selected = target.accountId ? accountById(target.accountId) : null;
      const validSelection = targetAccountEligible(selected, id, teacherId);
      if (target.accountId && !validSelection) target.accountId = '';
      $$('.platform-body input, .platform-body textarea, .platform-body select, .platform-body button', card).forEach(control => {
        if (control.classList.contains('creator-link') || control.classList.contains('account-manage-link')) control.disabled = !bridgeAvailable;
        else if (control.dataset.field === 'accountId') control.disabled = !bridgeAvailable || !target.enabled || !teacherId;
        else if (control.dataset.field === 'declaration-text') control.disabled = !target.enabled || !target.declaration.required;
        else if (control.dataset.field === 'collection-name') control.disabled = !target.enabled || !target.collection.required;
        else control.disabled = !bridgeAvailable || !target.enabled;
      });
      if (accountSelect) {
        accountSelect.value = target.accountId && validSelection ? target.accountId : '';
        accountSelect.disabled = !bridgeAvailable || !teacherId;
      }
      renderPlatformAccountStatus(card);
      const inherit = $('input[data-field="inherit"]', card); if (inherit) inherit.checked = target.inherit !== false;
      const custom = $('.platform-copy', card); if (custom) custom.hidden = target.inherit !== false;
      const title = $('[data-field="title"]', card); if (title) title.value = target.title || '';
      const description = $('[data-field="description"]', card); if (description) description.value = target.description || '';
      const tags = $('[data-field="tags"]', card); if (tags) tags.value = (target.tags || []).join(', ');
      const declaration = $('[data-field="declaration-required"]', card); if (declaration) declaration.checked = !!target.declaration?.required;
      const declarationText = $('[data-field="declaration-text"]', card); if (declarationText) { declarationText.value = target.declaration?.text || ''; declarationText.disabled = !bridgeAvailable || !target.enabled || !target.declaration?.required; }
      const collection = $('[data-field="collection-required"]', card); if (collection) collection.checked = !!target.collection?.required;
      const collectionText = $('[data-field="collection-name"]', card); if (collectionText) { collectionText.value = target.collection?.name || ''; collectionText.disabled = !bridgeAvailable || !target.enabled || !target.collection?.required; }
      window.PublishSettingsUI.sync(card, target, state.currentDraft.sharedDeclaration);
      $$('.cover-override-button', card).forEach(cover => {
        const kind = cover.dataset.coverSlot;
        const override = target.covers?.[kind];
        const fallback = state.currentDraft.covers?.[kind];
        cover.textContent = `${kind === 'landscape' ? '横版' : '竖版'}：${override ? `覆盖 · ${override.name}` : fallback ? `用通用 · ${fallback.name}` : '尚未选择'}`;
        cover.classList.toggle('has-file', !!override);
        cover.disabled = !bridgeAvailable || !target.enabled;
      });
      $$('.cover-reset', card).forEach(reset => { reset.hidden = !target.covers?.[reset.dataset.resetSlot]; });
    });
    reorderPlatformCards();
    renderStep3PlatformRow();
    updateOverview();
  }

  function bindCommonFields() {
    $('#shared-declaration').addEventListener('change', event => {
      state.currentDraft.sharedDeclaration = { intent: event.target.value }; setDirty(); syncPlatformCards();
    });
    $('#common-title').addEventListener('input', event => {
      state.currentDraft.common.title = event.target.value;
      const counter = $('#title-count');
      if (counter) counter.textContent = `${state.currentDraft.common.title.length} / 300`;
      setDirty();
    });
    $('#common-description').addEventListener('input', event => { state.currentDraft.common.description = event.target.value; setDirty(); });
    $('#common-tags').addEventListener('input', event => {
      state.currentDraft.common.tags = splitTags(event.target.value);
      renderStep2Tags();
      setDirty();
    });
    $('#schedule-mode').addEventListener('change', event => {
      const mode = event.target.value === 'scheduled' ? 'scheduled' : 'immediate';
      const previous = scheduleOf(state.currentDraft);
      state.currentDraft.schedule = { mode, at: mode === 'scheduled' ? previous.at : '', timeZone: SCHEDULE_TIME_ZONE };
      setDirty(); syncDraftForm();
    });
    $('#schedule-at').addEventListener('input', event => {
      state.currentDraft.schedule = { mode: 'scheduled', at: String(event.target.value || '').slice(0, 16), timeZone: SCHEDULE_TIME_ZONE };
      setDirty(); renderScheduleLimits();
    });
    $$('.remove-asset').forEach(remove => remove.addEventListener('click', () => {
      const slot = remove.closest('.asset-card');
      const kind = slot.id === 'video-slot' ? 'video' : slot.id.replace('-slot', '');
      if (kind === 'video') state.currentDraft.video = null;
      else state.currentDraft.covers[kind] = null;
      setDirty(); renderAssetSlot(kind, null); syncPlatformCards();
    }));
    $$('.asset-action').forEach(action => action.addEventListener('click', async () => {
      if (!bridgeAvailable) return;
      const kind = action.dataset.assetKind;
      try {
        const asset = await invoke('chooseAsset', kind);
        if (!asset) return;
        if (kind === 'video') {
          if (state.currentDraft.video && state.currentDraft.video.id !== asset.id) {
            state.currentDraft.covers = { landscape: null, portrait: null };
            state.currentDraft.targets.forEach(target => { target.covers = { landscape: null, portrait: null }; });
            renderAssetSlot('landscape', null); renderAssetSlot('portrait', null);
            toast('已更换视频，请重新选择本条视频的横竖封面。');
          }
          state.currentDraft.video = asset;
        }
        else state.currentDraft.covers[kind] = asset;
        setDirty(); renderAssetSlot(kind, asset); syncPlatformCards();
      } catch (error) { toast(error.message, true); }
    }));
    bindSmartDropAndTags();
  }

  function syncDraftForm() {
    state.currentDraft.teacherId = typeof state.currentDraft.teacherId === 'string' ? state.currentDraft.teacherId : '';
    renderTeacherSelection();
    const schedule = scheduleOf(state.currentDraft);
    state.currentDraft.schedule = schedule;
    setValue('#shared-declaration', state.currentDraft.sharedDeclaration?.intent || 'none');
    setValue('#common-title', state.currentDraft.common.title);
    const titleCount = $('#title-count');
    if (titleCount) titleCount.textContent = `${(state.currentDraft.common.title || '').length} / 300`;
    setValue('#common-description', state.currentDraft.common.description);
    setValue('#common-tags', state.currentDraft.common.tags.join(', '));
    setValue('#schedule-mode', schedule.mode);
    setValue('#schedule-at', schedule.at);
    const scheduleField = $('#schedule-at-field');
    if (scheduleField) scheduleField.hidden = schedule.mode !== 'scheduled';
    const scheduleInput = $('#schedule-at');
    if (scheduleInput) scheduleInput.disabled = schedule.mode !== 'scheduled';
    renderScheduleLimits();
    renderAssetSlot('video', state.currentDraft.video);
    renderAssetSlot('landscape', state.currentDraft.covers.landscape);
    renderAssetSlot('portrait', state.currentDraft.covers.portrait);
    renderStep2Tags();
    renderPlatformCards();
    renderStep4Summary();
  }

  function updateOverview() {
    managedPilotUI?.sync();
    const publishReadiness = renderPublishReadiness();
    renderAccountAlerts();
    const readinessButton = $('#check-account-readiness');
    if (readinessButton) {
      readinessButton.disabled = !bridgeAvailable || typeof publisher?.checkAccountReadiness !== 'function' || state.readinessBusy || !activeTargets().some(t => t.accountId)
        || activeTargets().some(t => state.pairBusy.has(t.accountId) || state.inspectBusy.has(t.accountId));
      readinessButton.textContent = state.readinessBusy ? '正在提前检查…' : '提前检查选中账号登录';
    }
    const active = activeTargets();
    const teacherId = state.currentDraft.teacherId || '';
    const teacher = teacherById(teacherId);
    const currentAccounts = teacher ? teacherAccounts(teacherId) : [];
    const readyAccounts = active.filter(target => targetAccountEligible(accountById(target.accountId), target.platform, teacherId)).length;
    const hasTitle = !!state.currentDraft.common.title.trim() || active.some(target => !target.inherit && !!target.title.trim());
    const hasVideo = !!state.currentDraft.video;
    $('#selected-count').textContent = `${active.length} 个平台`;
    $('#rail-target-count').textContent = `${active.length} / ${state.platforms.length}`;
    $('#rail-asset-count').textContent = hasVideo ? '已选择视频' : '未选择';
    $('#rail-account-count').textContent = `${currentAccounts.length} 个`;
    $('#asset-state').textContent = hasVideo ? '视频已选择' : '等待选择';
    $('#history-count').textContent = String(window.PublishRecordModel?state.runs.filter(r=>!window.PublishRecordModel.recordForRun(r,state).isRehearsal).length:state.runs.length);
    if(!publishHistoryUI)$('#history-total').textContent = `${state.runs.length} 条记录`;
    [['teacher', !!teacher], ['video', hasVideo], ['title', hasTitle], ['platform', active.length > 0], ['account', !!teacher && active.length > 0 && readyAccounts === active.length]].forEach(([name, done]) => {
      const item = $(`#check-${name}`); if (item) item.classList.toggle('done', done);
    });
    const teacherNote = $('#draft-teacher-note');
    if (teacherNote) {
      if (!bridgeAvailable) teacherNote.textContent = '浏览器预览没有老师数据；老师、账号和连接操作不可用。';
      else if (!teacher) teacherNote.textContent = '默认不选择老师；选择后只显示该老师名下账号，不会自动套用第一个账号。';
      else teacherNote.textContent = `${teacher.name || '未命名老师'} · ${currentAccounts.length} 个账号；切换老师会清空平台账号、声明、合集、独立文案和封面。`;
    }
    const blocker = realTaskBlocker();
    const publishReady = realPublishReady();
    const runningReal = activeRealRun();
    const panelRun = realPanelRun();
    $('#engine-chip').classList.toggle('ready', bridgeAvailable);
    $('#engine-chip span').textContent = bridgeAvailable
      ? (publishReady ? '桌面桥接 · 真实发布开关已就绪' : '桌面桥接 · 真实发布未接通')
      : '浏览器预览';
    $('#environment-title').textContent = bridgeAvailable ? '多老师账号 · 本地核对' : '浏览器预览';
    $('#environment-copy').textContent = bridgeAvailable
      ? (publishReady
        ? '账号绑定与在线只用于识别真实号；真实发布仍需逐条核对与最终确认。'
        : '账号绑定与在线只用于识别本机真实号；当前真实发布未接通，二者都不代表可发布。')
      : '尚未连接桌面能力，文件选择及持久化不可用。';
    $('#action-status').classList.toggle('ready', publishReady && !blocker && !panelRun);
    if (runningReal && !publishReady) {
      $('#action-status-title').textContent = '真实任务记录进行中';
      $('#engine-reason').textContent = `当前状态：${realRunStatusLabel(runningReal.status)}；真实发布未接通，不能在这里确认提交。`;
    } else if (runningReal) {
      $('#action-status-title').textContent = '抖音真实任务进行中';
      $('#engine-reason').textContent = runningReal.status === 'awaiting_confirmation'
        ? '助手已完成填写；请核对最终快照后再确认发布。'
        : `当前状态：${realRunStatusLabel(runningReal.status)}。`;
    } else if (blocker) {
      $('#action-status-title').textContent = publishReady ? (realTestApiAvailable ? '抖音真实测试未就绪' : '真实发布未接通') : '真实发布未接通';
      $('#engine-reason').textContent = publishReady ? (realTestApiAvailable ? blocker : (state.engine.reason || blocker)) : blocker;
    } else if (panelRun && ['submitted', 'awaiting_verification'].includes(panelRun.status)) {
      $('#action-status-title').textContent = '抖音任务已有回执';
      $('#engine-reason').textContent = panelRun.status === 'submitted' ? '已提交，平台审核结果仍需核查；不等于已发布。' : '结果待核查；操作台不会自动重发。';
    } else {
      $('#action-status-title').textContent = '抖音真实测试可用';
      $('#engine-reason').textContent = '仅单条抖音；先核对不可变快照，最终提交仍需再次确认。';
    }
    const realButton = $('#douyin-real-test');
    if (realButton) {
      realButton.hidden = state.engine.managedPilot === true;
      if (!publishReady) {
        realButton.textContent = '真实发布未接通';
        realButton.disabled = true;
        realButton.title = blocker || '真实发布能力尚未接通；账号绑定与在线不代表可发布。';
      } else {
        realButton.textContent = state.realStarting ? '正在创建…' : hasActiveRealTask() ? '真实任务进行中' : (!realTestApiAvailable && bridgeAvailable ? '真实测试 · 未接入' : '抖音真实测试');
        realButton.disabled = !!blocker;
        realButton.title = blocker || '仅单条抖音；先核对不可变快照，最终提交仍需再次确认。';
      }
    }
    if (state.engine.managedPilot) {
      $('#engine-chip span').textContent = state.engine.managedPilotLabel || '多平台发布';
      $('#environment-title').textContent = '本机独立执行';
      $('#environment-copy').textContent = '各平台账号分别核对。总览确认后由程序执行，各平台独立记录结果；账号或页面检查不符会停止该平台。';
      $('#action-status-title').textContent = publishReadiness?.blockers.length ? '所选平台账号尚未就绪' : '发布到所选平台';
      $('#engine-reason').textContent = publishReadiness?.blockers.length
        ? publishReadiness.blockers.map(r => `${r.platformLabel}：${r.label}`).join('；')
        : '总览确认后发布，也可选择只准备。已绑定但登录待检查的账号会在执行前重新核对。';
    }
    const previewButton = $('#review-button');
    previewButton.textContent = state.engine.managedPilot ? '本地演练（不发布）' : '检查并预览 →';
    previewButton.classList.toggle('button-primary', !state.engine.managedPilot);
    previewButton.classList.toggle('button-quiet', !!state.engine.managedPilot);
    $('#preview-banner').hidden = bridgeAvailable;
    $('#save-draft').disabled = !bridgeAvailable || state.saving;
    $('#save-draft-top').disabled = !bridgeAvailable || state.saving;
    $('#draft-teacher').disabled = !bridgeAvailable || state.saving || state.starting;
    $('#new-draft').disabled = !bridgeAvailable || state.saving || state.starting || state.realStarting;
    $('#review-button').disabled = !bridgeAvailable || state.starting || state.realStarting;
    $('#save-template').disabled = !bridgeAvailable || !teacherById(teacherId);
    const saveTemplate = $('#save-template');
    if (saveTemplate) saveTemplate.title = teacherById(teacherId) ? '模板会绑定当前任务老师。' : '请先选择任务归属老师，模板必须绑定老师。';
    const bridgeNote = $('#account-bridge-note');
    if (bridgeNote) {
      bridgeNote.textContent = accountProviderNote();
      bridgeNote.classList.toggle('unavailable', !teacherApiAvailable);
    }
    renderHome();
    renderStep4Summary();
  }

  async function saveCurrentDraft() {
    if (!bridgeAvailable || state.saving) return;
    state.saving = true; updateOverview(); $('#draft-feedback').textContent = '';
    state.currentDraft.teacherId = typeof state.currentDraft.teacherId === 'string' ? state.currentDraft.teacherId : '';
    if (sanitizeDraftAccounts()) state.dirty = true;
    const source = copyDraft(state.currentDraft);
    const draft = copyDraft(source); draft.name = currentDraftName(); draft.teacherId = source.teacherId || '';
    try {
      const saved = await invoke('saveDraft', draft);
      const stored = { ...saved, teacherId: typeof saved.teacherId === 'string' ? saved.teacherId : draft.teacherId };
      const changedDuringSave = JSON.stringify(state.currentDraft) !== JSON.stringify(source);
      if (!changedDuringSave) {
        state.currentDraft = copyDraft(stored);
        state.currentDraft.name ||= draft.name;
        state.currentDraft.teacherId = typeof state.currentDraft.teacherId === 'string' ? state.currentDraft.teacherId : draft.teacherId;
        sanitizeDraftAccounts();
      } else state.currentDraft.id ||= stored.id;
      state.drafts = [stored, ...state.drafts.filter(item => item.id !== stored.id)];
      state.dirty = changedDuringSave;
      $('#draft-feedback').textContent = changedDuringSave ? '已保存检查前的版本；刚输入的修改仍待保存' : '已保存到这台电脑';
      renderDraftPicker(); syncDraftForm(); toast('本地草稿已保存。');
      return stored;
    } catch (error) { toast(error.message, true); $('#draft-feedback').textContent = error.message; }
    finally { state.saving = false; updateOverview(); }
  }
  function renderDraftPicker() {
    const picker = $('#draft-picker');
    picker.replaceChildren(option('恢复本地草稿…', ''));
    state.drafts.forEach(draft => {
      const owner = teacherById(draft.teacherId);
      const prefix = owner ? `${owner.name} · ` : '';
      picker.append(option(`${prefix}${draft.name || draft.common?.title || '未命名草稿'} · ${formatDate(draft.updatedAt)}`, draft.id));
    });
    $('#restore-draft').disabled = !bridgeAvailable || !picker.value;
  }
  function restoreDraftById(draftId) {
    const saved = state.drafts.find(item => item.id === draftId);
    if (!saved) return;
    state.currentDraft = copyDraft(saved); state.currentDraft.targets ||= platformDefaults.map(p => newTarget(p.id));
    state.currentDraft.covers ||= { landscape: null, portrait: null }; state.currentDraft.common ||= { title: '', description: '', tags: [] };
    state.currentDraft.teacherId = typeof state.currentDraft.teacherId === 'string' ? state.currentDraft.teacherId : '';
    state.currentDraft.schedule = scheduleOf(state.currentDraft);
    const changed = reconcileDraftAfterBootstrap();
    state.dirty = false;
    state.wizardStep = state.currentDraft.video ? 2 : 1;
    renderAccounts(); renderTemplates(); syncDraftForm(); switchView('new');
    toast(changed ? '已恢复本地草稿；原老师或账号已不可用，已清空对应选择，请重新核对。' : '已恢复本地草稿。');
  }
  $('#draft-picker').addEventListener('change', () => { $('#restore-draft').disabled = !bridgeAvailable || !$('#draft-picker').value; });
  $('#restore-draft').addEventListener('click', () => restoreDraftById($('#draft-picker').value));

  async function reviewCurrentDraft() {
    if (!bridgeAvailable || state.starting) return;
    const teacherId = state.currentDraft.teacherId || '';
    if (!teacherById(teacherId)) {
      toast('请先选择当前任务归属老师；未选择老师时不会自动套用账号。', true);
      const select = $('#draft-teacher');
      if (select) select.focus();
      return;
    }
    if (sanitizeDraftAccounts()) {
      state.dirty = true; syncPlatformCards();
      toast('有账号不属于当前老师，已清空对应选择；请重新选择账号后再检查。', true);
      return;
    }
    state.starting = true; updateOverview();
    try {
      const draft = copyDraft(state.currentDraft);
      const result = await invoke('validate', { draft, mode: 'rehearsal' });
      if (JSON.stringify(draft) !== JSON.stringify(state.currentDraft)) { toast('检查期间设置发生变化，请重新检查。', true); return; }
      state.review = { draft, result, requestId: crypto.randomUUID(), valid: true };
      renderReview(result);
      $('#confirm-rehearsal').disabled = !result.ok;
      showModal('#review-modal', '#confirm-rehearsal');
    } catch (error) { toast(error.message, true); }
    finally { state.starting = false; updateOverview(); }
  }
  function renderReview(result) {
    const issueList = $('#validation-list'); issueList.replaceChildren();
    if (!result.issues?.length) issueList.append(el('div', 'validation-item', '本地结构检查未发现需要阻止演练的问题。平台真实字段仍未验证。'));
    else result.issues.forEach(issue => {
      const row = el('div', `validation-item${issue.severity === 'error' ? ' error' : ''}`);
      row.append(el('span', 'issue-level', issue.severity === 'error' ? '需处理' : '提醒'), el('span', '', `${issue.platform ? `${platformFor(issue.platform).label} · ` : ''}${issue.message}`));
      issueList.append(row);
    });
    const summary = $('#review-summary'); summary.replaceChildren();
    const reviewDraft = state.review?.draft || state.currentDraft;
    const teacherCard = el('div', 'summary-card');
    teacherCard.append(el('div', 'summary-top', '任务归属老师'));
    const teacherLine = el('div', 'summary-line');
    teacherLine.append(el('b', '', '老师'), el('span', '', teacherById(reviewDraft.teacherId)?.name || '未选择'));
    teacherCard.append(teacherLine);
    const ownerLine = el('div', 'summary-line');
    ownerLine.append(el('b', '', '账号范围'), el('span', '', '只使用该老师名下账号；绑定和在线都不代表可发布。'));
    teacherCard.append(ownerLine);
    summary.append(teacherCard);
    const videoCard = el('div', 'summary-card');
    videoCard.append(el('div', 'summary-top', '本地视频'));
    const videoLine = el('div', 'summary-line'); videoLine.append(el('b', '', '文件'), el('span', '', state.review?.draft.video?.name || '未选择')); videoCard.append(videoLine);
    summary.append(videoCard);
    (result.summary || []).forEach(item => {
      const card = el('div', 'summary-card'); const top = el('div', 'summary-top');
      const draftTarget = (reviewDraft.targets || []).find(target => target.platform === item.platform);
      const account = draftTarget ? accountById(draftTarget.accountId) : null;
      const accountText = account ? accountDisplay(account) : (item.account || '未选择');
      top.append(el('b', '', platformFor(item.platform).label), el('span', '', `账号：${accountText}（绑定/在线不代表可发布）`)); card.append(top);
      const lines = [
        ['标题', item.title || '未填写'], ['封面', Object.entries(item.covers || {}).map(([slot, name]) => `${slot === 'landscape' ? '横版' : '竖版'}：${name}`).join('；') || '未选择'],
        ['简介', item.description || '无'],
        ['标签', Array.isArray(item.tags) ? item.tags.join('、') || '无' : '无'],
        ['发布时间', scheduleLabel(item.schedule)],
        ['原生声明', item.declaration || '不设置'], ['已有合集', item.collection || '不加入']
      ];
      if (item.specialSettings?.visibility && item.specialSettings.visibility !== 'platform_default') lines.push(['谁可以看', ({public:'公开',friends:'好友可见',self:'仅自己可见'})[item.specialSettings.visibility]]);
      if (item.specialSettings?.savePermission && item.specialSettings.savePermission !== 'platform_default') lines.push(['保存权限', item.specialSettings.savePermission === 'allow' ? '允许保存' : '不允许保存']);
      lines.forEach(([label, value]) => { const line = el('div', 'summary-line'); line.append(el('b', '', label), el('span', '', value)); card.append(line); });
      summary.append(card);
    });
    if (!result.summary?.length) summary.append(el('div', 'empty-state', '选择至少一个平台后可生成平台总览。'));
  }
  function closeReview() { hideModal('#review-modal'); state.review = null; }
  async function confirmRehearsal() {
    if (!bridgeAvailable || !state.review?.valid || !state.review.result.ok || state.starting) return;
    if (JSON.stringify(state.review.draft) !== JSON.stringify(state.currentDraft)) { closeReview(); toast('设置已变化，请重新检查。', true); return; }
    state.starting = true; $('#confirm-rehearsal').disabled = true;
    try {
      const run = await invoke('startRun', { draft: state.review.draft, mode: 'rehearsal', requestId: state.review.requestId });
      mergeRun(run); closeReview(); switchView('history'); toast('已开始本地演练；未上传、未发布。');
    } catch (error) { toast(error.message, true); $('#confirm-rehearsal').disabled = false; }
    finally { state.starting = false; updateOverview(); }
  }

  function snapshotLine(label, value) {
    const line = el('div', 'snapshot-line');
    line.append(el('b', '', label), el('span', '', value == null || value === '' ? '—' : String(value)));
    return line;
  }
  function snapshotCard(title, lines, className = '') {
    const card = el('div', `snapshot-card${className ? ` ${className}` : ''}`);
    if (title) card.append(el('h3', '', title));
    lines.forEach(([label, value]) => card.append(snapshotLine(label, value)));
    return card;
  }
  function renderRealReview() {
    const host = $('#real-review-body');
    if (!host) return;
    host.replaceChildren();
    const review = state.realReview;
    if (!review) return;
    const snapshot = review.snapshot;
    const lock = el('div', 'snapshot-lock');
    lock.append(el('b', '', '已锁定本次快照'), el('span', '', '确认后桌面桥接按这份内容创建任务；总览打开期间原表单不可编辑。'));
    host.append(lock);
    const account = el('div', 'snapshot-account');
    account.append(
      el('small', '', `任务老师：${snapshot.teacherLabel || teacherLabel(snapshot.teacherId)}`),
      el('b', '', snapshot.accountLabel),
      el('span', '', '真实号来自本机绑定；实际登录账号仍需助手回传核对。绑定/在线不代表可发布。')
    );
    host.append(account);
    const videoText = snapshot.video ? [snapshot.video.name, byteLabel(snapshot.video.size)].filter(Boolean).join(' · ') : '未选择';
    host.append(snapshotCard('视频与封面', [
      ['视频', videoText],
      ['横版封面', snapshot.covers.landscape?.name || '未选择'],
      ['竖版封面', snapshot.covers.portrait?.name || '未选择'],
      ['定位', snapshot.location]
    ]));
    host.append(snapshotCard('发布方式', [
      ['发布时间', scheduleLabel(snapshot.schedule)],
      ['说明', snapshot.schedule?.mode === 'scheduled' ? '使用平台自己的定时功能；是否设置成功以平台作品记录为准。' : '立即发布；不设置平台定时。']
    ]));
    host.append(snapshotCard('抖音文案', [
      ['标题', snapshot.title || '未填写'],
      ['简介', snapshot.description || '无'],
      ['标签', Array.isArray(snapshot.tags) && snapshot.tags.length ? snapshot.tags.join('、') : '无']
    ]));
    host.append(snapshotCard('平台设置', [
      ['平台', '抖音（仅此一条）'],
      ['原生声明', snapshot.declarationRequired ? (snapshot.declaration || '已勾选但未填写') : '不设置'],
      ['已有合集', snapshot.collectionRequired ? (snapshot.collection || '已勾选但未填写') : '不加入'],
      ['最终提交', '仍需你在操作台再次确认']
    ]));
  }
  function openRealReview() {
    const blocker = realTaskBlocker();
    if (blocker) { toast(blocker, true); return; }
    const draft = copyDraft(state.currentDraft);
    const target = draft.targets.find(item => item.platform === 'douyin' && item.enabled);
    if (!target) { toast('真实测试只支持单独勾选抖音。', true); return; }
    state.realReview = { draft, requestId: crypto.randomUUID(), snapshot: realSnapshotFor(draft, target), valid: true };
    renderRealReview();
    $('#confirm-real-start').disabled = false;
    $('#confirm-real-start').textContent = '确认并启动本机交接';
    showModal('#real-review-modal', '#confirm-real-start');
  }
  function closeRealReview() {
    if (state.realStarting) return;
    state.realReview = null;
    hideModal('#real-review-modal');
  }
  async function confirmRealStart() {
    const review = state.realReview;
    if (!review || state.realStarting) return;
    if (!realPublishReady()) {
      state.realReview = null; hideModal('#real-review-modal');
      toast('真实发布能力尚未接通；不能启动真实提交。账号绑定与在线不代表可发布。', true);
      return;
    }
    if (!review.valid || JSON.stringify(review.draft) !== JSON.stringify(state.currentDraft)) {
      state.realReview = null; hideModal('#real-review-modal');
      toast('设置已变化，请重新打开真实测试总览。', true);
      return;
    }
    state.realStarting = true;
    $('#confirm-real-start').disabled = true;
    $('#confirm-real-start').textContent = '正在创建…';
    updateOverview();
    try {
      const result = await invokeReal('startChromePrepare', { draft: review.draft, requestId: review.requestId });
      const run = result?.run || result;
      if (result?.session) mergeLiveSession(result.session);
      if (run?.id) mergeRun(run);
      state.realReview = null;
      hideModal('#real-review-modal');
      renderRealPanel();
      toast('本机交接已启动；尚未提交发布。请按面板步骤在助手中输入任务码。');
    } catch (error) {
      toast(`无法启动真实测试：${realErrorMessage(error)}`, true);
      $('#confirm-real-start').disabled = false;
    } finally {
      state.realStarting = false;
      $('#confirm-real-start').textContent = '确认并启动本机交接';
      updateOverview(); renderRealPanel();
    }
  }

  function publishSnapshotView(run) {
    const snapshot = run?.snapshot || {};
    const target = (snapshot.targets || []).find(item => item.platform === 'douyin' && item.enabled);
    const copy = realCopy(snapshot, target);
    const covers = realCovers(snapshot, target);
    const summary = run?.summary?.[0] || {};
    return {
      target, copy, covers, summary,
      schedule: snapshot.schedule,
      scheduleText: scheduleLabel(snapshot.schedule),
      scheduled: snapshot.schedule?.mode === 'scheduled',
      title: copy.title || summary.title || '未记录',
      description: copy.description || summary.description || '无',
      tags: Array.isArray(copy.tags) ? copy.tags : (Array.isArray(summary.tags) ? summary.tags : []),
      declaration: target?.declaration?.required ? (target.declaration.text || '已勾选但未填写') : '不设置',
      collection: target?.collection?.required ? (target.collection.name || '已勾选但未填写') : '不加入',
      landscape: covers.landscape?.name || summary.covers?.landscape || '未记录',
      portrait: covers.portrait?.name || summary.covers?.portrait || '未记录'
    };
  }
  function publishReceiptLines(run, item) {
    const workId = safeShort(item?.workId || run?.workId, 120);
    const workUrl = safeShort(item?.workUrl || run?.workUrl, 500);
    const platformStatus = safeShort(item?.platformStatus || run?.platformStatus, 100);
    const lines = [];
    if (platformStatus) lines.push(['平台状态', platformStatus]);
    if (workId) lines.push(['作品标识', workId]);
    if (workUrl) lines.push(['作品链接', workUrl]);
    return lines;
  }
  function renderPublishConfirm() {
    const host = $('#publish-confirm-body');
    const note = $('#publish-confirm-note');
    const confirm = $('#confirm-publish');
    const cancel = $('#cancel-publish-confirm');
    if (!host || !note || !confirm) return;
    host.replaceChildren();
    const run = state.runs.find(item => item.id === state.publishReview?.runId);
    if (!run) {
      host.append(el('div', 'snapshot-empty', '任务记录已不存在，无法确认发布。'));
      note.className = 'publish-confirm-note error';
      note.textContent = '请关闭本窗口并回到任务记录重新核对。';
      confirm.disabled = true;
      if (cancel) cancel.disabled = state.authorizing;
      return;
    }
    const view = publishSnapshotView(run);
    const account = runAccountDisplay(run);
    const lock = el('div', 'snapshot-lock');
    lock.append(el('b', '', '不可变快照'), el('span', '', '授权只适用于这条视频、这份文案和这组封面；不会带入后续修改。'));
    host.append(lock);
    const accountCard = el('div', `snapshot-account${account ? '' : ' pending'}`);
    accountCard.append(el('small', '', '实际发布账号'), el('b', '', account || '尚未核对（助手未回传实际账号）'), el('span', '', account ? '来自助手回传；请确认与你要发布的账号一致。' : '不要用本机备注猜测账号；请先在助手或平台页面核对。'));
    host.append(accountCard);
    host.append(snapshotCard('发布方式', [
      ['发布时间', view.scheduleText],
      ['说明', view.scheduled ? '使用平台自己的定时功能；是否设置成功以平台作品记录为准。' : '立即发布；不设置平台定时。']
    ]));
    host.append(snapshotCard('视频与封面', [
      ['平台', '抖音（仅此一条）'],
      ['视频', run.snapshot?.video ? [run.snapshot.video.name, byteLabel(run.snapshot.video.size)].filter(Boolean).join(' · ') : '未记录'],
      ['横版封面', view.landscape],
      ['竖版封面', view.portrait],
      ['定位', '不填写定位']
    ]));
    host.append(snapshotCard('即将提交的文案', [
      ['标题', view.title],
      ['简介', view.description],
      ['标签', view.tags.length ? view.tags.join('、') : '无'],
      ['原生声明', view.declaration],
      ['已有合集', view.collection]
    ]));
    const receipt = publishReceiptLines(run, run.items?.[0]);
    if (receipt.length) host.append(snapshotCard('平台回执', receipt));
    const publishReady = realPublishReady();
    const canConfirm = run.status === 'awaiting_confirmation' && !state.authorizing && realTestApiAvailable && publishReady;
    note.className = `publish-confirm-note${run.status === 'awaiting_confirmation' && publishReady ? ' ready' : ' error'}`;
    note.textContent = !publishReady
      ? '自动发布流程仍在开发，不能在这里提交作品。'
      : run.status === 'awaiting_confirmation'
        ? '授权后桌面桥接会先持久标记提交中，再向助手发出一次提交许可；不会自动重试。'
        : `当前任务状态为“${realRunStatusLabel(run.status)}”，已不能在这里授权发布。`;
    confirm.disabled = !canConfirm;
    confirm.textContent = !publishReady ? '真实发布未接通' : (state.authorizing ? '正在授权…' : '确认发布到抖音');
    if (cancel) cancel.disabled = state.authorizing;
  }
  function openPublishConfirm(runId) {
    const run = state.runs.find(item => item.id === runId);
    if (!run || !isRealRun(run)) return;
    if (!realPublishReady()) { toast('真实发布能力尚未接通；不能在这里打开最终提交。账号绑定与在线不代表可发布。', true); return; }
    if (!realTestApiAvailable) { toast('此桌面版本尚未接入真实测试桥接；不能在这里授权发布。', true); return; }
    if (run.status !== 'awaiting_confirmation') { toast(`当前状态为“${realRunStatusLabel(run.status)}”，不能在这里确认发布。`, true); return; }
    state.publishReview = { runId };
    renderPublishConfirm();
    showModal('#publish-confirm-modal', '#confirm-publish');
    const host = $('#publish-confirm-body'); if (host) host.scrollTop = 0;
  }
  function closePublishConfirm() {
    if (state.authorizing) return;
    state.publishReview = null;
    hideModal('#publish-confirm-modal');
  }
  async function confirmPublish() {
    const review = state.publishReview;
    if (!review || state.authorizing) return;
    const run = state.runs.find(item => item.id === review.runId);
    if (!run || run.status !== 'awaiting_confirmation') {
      renderPublishConfirm();
      toast('任务状态已变化，不能在这里授权发布。', true);
      return;
    }
    if (!realPublishReady()) {
      toast('真实发布能力尚未接通；不能授权提交。账号绑定与在线不代表可发布。', true);
      return;
    }
    state.authorizing = true;
    renderPublishConfirm();
    updateOverview();
    try {
      const result = await invokeReal('authorizeChromePublish', run.id);
      const updated = result?.run || result;
      if (updated?.id) mergeRun(updated);
      state.publishReview = null;
      hideModal('#publish-confirm-modal');
      toast('已授权本次单次提交；等待助手回执。收到回执前不等于已发布。');
    } catch (error) {
      toast(`未能授权发布：${realErrorMessage(error)}`, true);
    } finally {
      state.authorizing = false;
      if (state.publishReview) renderPublishConfirm();
      updateOverview(); renderRealPanel();
    }
  }

  function renderStopConfirm() {
    const host = $('#stop-confirm-body');
    const confirm = $('#confirm-stop');
    const cancel = $('#cancel-stop');
    if (!host || !confirm) return;
    host.replaceChildren();
    const run = state.runs.find(item => item.id === state.stopReview?.runId);
    if (!run) {
      host.append(el('div', 'snapshot-empty', '任务记录已不存在。'));
      confirm.disabled = true;
      return;
    }
    host.append(snapshotCard('将停止的本机交接', [
      ['任务', run.id],
      ['当前状态', realRunStatusLabel(run.status)],
      ['实际账号', runAccountDisplay(run) || '尚未核对'],
      ['标题', run.snapshot?.common?.title || run.summary?.[0]?.title || '未记录']
    ]));
    confirm.disabled = state.realStopping || !canStopRealRun(run) || !realTestApiAvailable;
    confirm.textContent = state.realStopping ? '正在停止…' : '停止本机交接';
    if (cancel) cancel.disabled = state.realStopping;
  }
  function openStopConfirm(runId) {
    const run = state.runs.find(item => item.id === runId);
    if (!run) return;
    if (!realTestApiAvailable) { toast('此桌面版本尚未接入真实测试桥接；不能停止本机交接。', true); return; }
    if (!canStopRealRun(run)) { toast('当前状态不能停止本机交接；请以任务记录为准。', true); return; }
    state.stopReview = { runId };
    renderStopConfirm();
    showModal('#stop-confirm-modal', '#cancel-stop');
  }
  function closeStopConfirm() {
    if (state.realStopping) return;
    state.stopReview = null;
    hideModal('#stop-confirm-modal');
  }
  async function confirmStop() {
    const review = state.stopReview;
    if (!review || state.realStopping) return;
    const run = state.runs.find(item => item.id === review.runId);
    if (!run || !canStopRealRun(run)) {
      renderStopConfirm();
      toast('任务状态已变化，不能停止本机交接。', true);
      return;
    }
    state.realStopping = true;
    renderStopConfirm(); updateOverview();
    try {
      const result = await invokeReal('stopChromePrepare', run.id);
      const updated = result?.run || result;
      if (updated?.id) mergeRun(updated);
      state.stopReview = null;
      hideModal('#stop-confirm-modal');
      toast('已停止本机交接；如已上传，平台草稿需你自行核对，操作台不会删除或重发。');
    } catch (error) {
      toast(`未能停止本机交接：${realErrorMessage(error)}`, true);
    } finally {
      state.realStopping = false;
      if (state.stopReview) renderStopConfirm();
      updateOverview(); renderRealPanel();
    }
  }

  function realPanelWarning(run) {
    if (run.status === 'awaiting_confirmation' && !realPublishReady()) return '真实发布能力尚未接通，不能在这里确认提交；账号绑定和在线状态不代表可发布。';
    return ({
      queued: '本机交接已登记，等待助手连接。',
      running: '助手正在上传填写；上传可能已产生平台草稿。',
      awaiting_browser: '下一步助手会上传视频并填写文案、封面、声明与合集；操作台不会自动提交。',
      preparing: '助手正在上传填写；请勿关闭原标签页。上传可能已产生平台草稿。',
      needs_manual: '助手无法确定部分字段，请在已登录页面人工核对；操作台不会猜测成功。',
      awaiting_confirmation: '助手已完成填写，等待你在操作台核对并确认；确认后只提交一次。',
      approved: '已授权本次单次提交，等待助手回执；不会自动重试。',
      submitting: '正在提交；不要重复点击或关闭助手。',
      submitted: '已收到提交回执，平台审核结果仍需核查；这不等于已发布。',
      awaiting_verification: '结果未明或已中断；请到平台核对，操作台不会自动重发。'
    })[run.status] || `真实状态为“${realRunStatusLabel(run.status)}”；请以任务记录和平台页面为准。`;
  }
  function setPanelText(selector, value) {
    const node = $(selector);
    if (node) node.textContent = value == null ? '' : String(value);
  }
  function renderRealPanel() {
    const host = $('#real-task-panel');
    if (!host) return;
    const run = realPanelRun();
    host.hidden = !run;
    if (!run) return;
    const session = sessionFor(run);
    const view = publishSnapshotView(run);
    const actualAccount = runAccountDisplay(run);
    const code = visibleSessionCode(run, session);
    setPanelText('#real-panel-task', typeof run.id === 'string' ? `#${run.id.slice(0, 8)}` : '—');
    setPanelText('#real-panel-account', actualAccount || '尚未核对（以助手回传为准）');
    setPanelText('#real-panel-title', view.title);
    setPanelText('#real-panel-schedule', view.scheduleText);
    setPanelText('#real-panel-mode', `单条抖音 · ${view.target?.declaration?.required ? '含声明' : '不设声明'} · ${view.target?.collection?.required ? '含合集' : '不加入合集'} · 不填写定位`);
    setPanelText('#real-panel-port', session?.port != null ? session.port : '等待本机交接');
    setPanelText('#real-panel-expiry', session?.expiresAt ? formatDate(session.expiresAt) : '—');
    setPanelText('#real-panel-code', code || '—');
    setPanelText('#real-panel-code-note', code
      ? `任务码只在本机显示，请手工输入独立助手，不要发到聊天或日志。${session?.state ? ` 当前：${realSessionStateLabel(session)}。` : ''}`
      : (session ? `${realSessionStateLabel(session)}。任务码已失效或不再显示。` : '尚未收到本机交接信息；如已重启，请以任务记录和平台页面为准。'));
    const stateChip = $('#real-panel-state');
    if (stateChip) {
      stateChip.textContent = realRunStatusLabel(run.status);
      stateChip.className = `real-panel-state ${realRunBadgeClass(run.status)}`.trim();
    }
    setPanelText('#real-panel-warning', realPanelWarning(run));
    const confirm = $('#real-panel-confirm');
    if (confirm) {
      const publishReady = realPublishReady();
      confirm.hidden = run.status !== 'awaiting_confirmation';
      confirm.disabled = state.authorizing || !realTestApiAvailable || !publishReady;
      confirm.textContent = !publishReady ? '真实发布未接通' : (state.authorizing ? '正在授权…' : '核对并确认发布到抖音');
    }
    const stop = $('#real-panel-stop');
    if (stop) {
      stop.hidden = !canStopRealRun(run);
      stop.disabled = state.realStopping || !realTestApiAvailable;
      stop.textContent = state.realStopping ? '正在停止…' : '停止本机交接';
    }
  }
  function mergeLiveSession(session) {
    if (!session || typeof session !== 'object' || typeof session.runId !== 'string') return;
    state.liveSessions[session.runId] = { ...session };
    renderRealPanel();
  }
  function notifyRealTransition(previous, run) {
    if (!isRealRun(run) || !previous || previous.status === run.status) return;
    if (run.status === 'awaiting_confirmation') toast(realPublishReady()
      ? '助手已完成填写，等待你核对并确认发布；操作台不会自动授权。'
      : '助手已完成填写，但真实发布能力尚未接通，不能在这里确认提交。');
    else if (run.status === 'needs_manual') toast('助手需要人工核对，请查看任务记录和平台页面。');
    else if (run.status === 'submitted') toast('已收到提交回执；平台审核结果仍需核查，未标记为已发布。');
    else if (run.status === 'awaiting_verification') toast('结果待核查；操作台不会自动重发。');
    else if (run.status === 'failed') toast('抖音真实测试明确失败；请查看任务记录，操作台未自动重试。', true);
  }

  function pairEffectiveState(pair) {
    if (!pair || typeof pair.state !== 'string') return 'not_started';
    if (pair.state === 'awaiting_pair' && pairExpired(pair)) return 'expired';
    return pair.state;
  }
  function pairMessage(pair) {
    let message = pair && typeof pair.message === 'string' ? pair.message.trim().slice(0, 300) : '';
    const code = pair && typeof pair.pairCode === 'string' ? pair.pairCode : '';
    if (message && code) message = message.split(code).join('[一次性码已隐藏]');
    return message
      .replace(/\b[a-f0-9]{32}\b/gi, '[任务码已隐藏]')
      .replace(/(配对码|一次性码|任务码|pairCode|pair code)\s*[：:=]\s*[A-Za-z0-9_-]{4,}/gi, '$1：[已隐藏]');
  }
  function renderAccounts() {
    renderAccountAlerts(); renderTeacherSelection();
    teacherProfileUI?.render();
  }
  function renderAccountRow(account, groupKind) {
    const platform = platformFor(account.platform);
    const row = el('div', `account-row${groupKind === 'unassigned' ? ' unassigned' : ''}${accountTeacherId(account) === state.currentDraft.teacherId && state.currentDraft.teacherId ? ' current-teacher' : ''}`);
    row.dataset.accountId = account.id;
    const mark = el('span', `account-platform-mark ${platformTheme(platform.id)}`, platform.label.slice(0, 1));
    const details = el('div', 'account-details');
    const info = el('div', 'account-info');
    const binding = bindingOf(account);
    const realId = accountRealId(account);
    const metaParts = [accountTeacherLabel(account), platform.label, realId ? `真实号：${realId}` : '未绑定真实号'];
    metaParts.push(binding ? `环境：${environmentLabelFor(account)}（${accountCheckLabel(account)}）` : `环境：${environmentLabelFor(account)}`);
    info.append(el('b', '', account.label || '未命名账号'), el('small', 'account-meta-line', metaParts.join(' · ')));
    details.append(info);
    const badges = el('div', 'account-badges');
    badges.append(el('span', `account-chip ${binding ? 'bound' : 'unbound'}`, binding ? '已绑定' : '未绑定真实号'));
    if (binding) badges.append(el('span', `account-chip ${accountCheckLabel(account) === '当前未核对' ? 'offline' : 'online'}`, accountCheckLabel(account)));
    if (accountStatusMismatch(account)) badges.append(el('span', 'account-chip warning', '状态与绑定信息不一致'));
    const displayName = binding && typeof binding.displayName === 'string' ? binding.displayName.trim() : '';
    if (displayName) badges.append(el('span', 'account-chip neutral', `显示名：${safeShort(displayName, 120)}`));
    details.append(badges);
    const check = renderInspectResult(account.id);
    if (check) details.append(check);
    details.append(renderAccountPairPanel(account));
    details.append(renderAccountActions(account));
    row.append(mark, details);
    return row;
  }
  function renderInspectResult(accountId) {
    const check = state.accountChecks[accountId];
    if (!check) return null;
    const labels = { verified: '已核对一致', mismatch: '身份不一致', login_required: '需要重新登录', offline: '窗口未打开，尚未检查', unverifiable: '无法核验', pending: '正在检查' };
    const stateName = check.pending ? 'pending' : (['verified', 'mismatch', 'login_required', 'offline', 'unverifiable'].includes(check.state) ? check.state : 'unverifiable');
    const line = el('div', `inspect-line ${stateName}`);
    line.setAttribute('aria-live', 'polite');
    line.append(el('b', '', `身份检查：${labels[stateName] || '无法核验'}`));
    if (check.platformAccountId) line.append(el('span', 'account-real-id', `识别号 ${safeShort(check.platformAccountId, 80)}`));
    if (check.message) line.append(el('span', '', safeShort(check.message, 300)));
    return line;
  }
  function usesManagedBrowserUi(account) {
    return browserApiAvailable && managedPlatform(account.platform) && !!account.teacherId
      && (!account.binding || account.binding.source === 'managed_browser');
  }
  function renderAccountAlerts() {
    const host = $('#account-alerts');
    if (!host) return;
    const affected = state.accounts.filter(a => bindingOf(a) && !state.accountChecks[a.id]?.pending && !['opening', 'checking'].includes(state.browserSessions?.[a.id]?.state) && ['login_required', 'mismatch', 'unverifiable'].includes(state.accountChecks[a.id]?.state));
    host.hidden = !affected.length; host.replaceChildren();
    if (!affected.length) return;
    host.append(el('b', '', `${affected.length} 个已绑定账号需要核对本次登录；原绑定保留`));
    for (const account of affected) {
      const loginRequired = state.accountChecks[account.id].state === 'login_required';
      const saved = state.drafts.filter(d => (d.targets || []).some(t => t.enabled && t.accountId === account.id)).length;
      const editing = activeTargets().some(t => t.accountId === account.id);
      const row = el('div', 'account-alert-row');
      row.append(el('span', '', `${accountTeacherLabel(account)} · ${platformFor(account.platform).label} · ${accountRealId(account)}：${loginRequired ? '需要在原窗口重新登录' : state.accountChecks[account.id].state === 'mismatch' ? '当前账号与绑定不一致'  : (safeShort(state.accountChecks[account.id].message, 200) || '本次登录尚未核对成功，自动检查已停止').replace(/[。；]+$/, '')}${saved ? `；关联 ${saved} 条本地草稿` : ''}${editing ? '；影响当前编辑任务' : ''}。原绑定与环境保留。`));
      row.append(button(loginRequired ? '打开原窗口重新登录' : '打开原窗口核对账号', 'button button-outline', () => browserAction(account.id, 'openAccountBrowser', { accountId: account.id }), state.pairBusy.has(account.id) || state.inspectBusy.has(account.id) || state.readinessBusy));
      row.append(button('已登录，重新核对', 'button button-quiet', () => inspectManagedAccount(account.id), state.inspectBusy.has(account.id) || state.pairBusy.has(account.id) || state.readinessBusy));
      host.append(row);
    }
  }
  async function checkSelectedReadiness() {
    if (state.readinessBusy || typeof publisher?.checkAccountReadiness !== 'function') return;
    const accountIds = [...new Set(activeTargets().map(t => t.accountId).filter(Boolean))];
    if (!accountIds.length) return;
    if (accountIds.some(id => state.pairBusy.has(id) || state.inspectBusy.has(id))) return;
    state.readinessBusy = true; updateOverview(); syncPlatformCards();
    const note = $('#account-readiness-note');
    try {
      const result = await publisher.checkAccountReadiness({ accountIds, openMissing: true });
      await refreshBootstrap({ preserveDraft: true });
      if (note) note.textContent = result.ready ? '所选账号刚刚核对一致。状态之后仍可能变化，上传与提交前须再次核对。' : result.results.map(r => `${accountById(r.accountId)?.label || '所选账号'}：${({ login_required: '需要重新登录', offline: '尚未打开检查', mismatch: '账号不一致', unbound: '尚未绑定', unsupported: '此平台暂未接入', unverifiable: '无法核验', verified: '已核对一致' })[r.state] || '尚未核验'}`).join('；');
    } catch (error) { if (note) note.textContent = error.message || '提前检查未完成，请重试。'; }
    finally { state.readinessBusy = false; updateOverview(); syncPlatformCards(); }
  }
  async function browserAction(accountId, method, payload) {
    const stopping = ['cancelBrowserBinding','closeAccountBrowser'].includes(method);
    if (!stopping && (state.pairBusy.has(accountId) || state.inspectBusy.has(accountId) || state.readinessBusy)) return;
    const ownsBusy = !state.pairBusy.has(accountId);
    state.pairBusy.add(accountId); renderAccounts();
    if (state.currentView === 'new') syncPlatformCards();
    try {
      // Choosing this teacher/platform and requesting a connection is already
      // the user's intent to associate its signed-in account. The main process
      // still checks a fresh identity twice before saving it.
      const result = await publisher[method](method === 'openAccountBrowser' ? { ...payload, autoBind: true } : payload);
      await refreshBootstrap({ preserveDraft: true });
      if (method === 'openAccountBrowser' && ['bound','verified'].includes(result?.state)) toast('账号已连接并保存，可以继续发布。');
    } catch (error) { toast(error.message || '操作未完成，请重试。', true); await refreshBootstrap({ preserveDraft: true }).catch(() => {}); }
    finally { if (ownsBusy) state.pairBusy.delete(accountId); renderAccounts(); if (state.currentView === 'new') syncPlatformCards(); }
  }

  async function refreshAccountIndicators() {
    if (!bridgeAvailable || !state.bootstrapped || document.hidden || refreshingIndicators) return;
    refreshingIndicators = true;
    try {
      // Read only the app's in-memory observations. This never opens a browser,
      // queries an external platform, or changes the draft being edited.
      const data = await invoke('bootstrap');
      state.accounts = data.accounts || state.accounts;
      state.environments = data.environments || state.environments;
      state.accountChecks = data.accountChecks || {};
      state.browserSessions = data.browserSessions || {};
      $$('.platform-card').forEach(renderPlatformAccountStatus);
      updateOverview();
    } catch { /* Preserve the last known state; a failed local read is not a login expiry. */ }
    finally { refreshingIndicators = false; }
  }
  function renderBrowserPanel(account) {
    const environment = state.environments.find(e => e.id === account.browserEnvironmentId);
    const session = state.browserSessions[account.id] || { state: environment ? 'closed' : 'not_started', browserKind: environment?.browserKind, windowOpen: false };
    const panel = window.ManagedBrowserUI.render({ document, account, session, availability: state.browserAvailability,
      busy: state.pairBusy.has(account.id) || state.inspectBusy.has(account.id) || state.readinessBusy || state.unbindBusy,
      onOpen: browserKind => browserAction(account.id, 'openAccountBrowser', { accountId: account.id, browserKind }),
      onConfirm: () => browserAction(account.id, 'confirmBrowserAccount', account.id),
      onCheck: () => inspectManagedAccount(account.id),
      onClose: () => browserAction(account.id, 'closeAccountBrowser', account.id),
      onCancel: () => browserAction(account.id, 'cancelBrowserBinding', account.id),
      onUnbind: () => openUnbindConfirm(account.id)
    });
    panel.classList.add('managed-browser-panel');
    return panel;
  }
  function renderAccountPairPanel(account) {
    if (usesManagedBrowserUi(account)) return renderBrowserPanel(account);
    const panel = el('div', 'account-pair');
    if (account.platform !== 'douyin') {
      panel.dataset.pairState = 'unavailable';
      const line = el('div', 'pair-state-line');
      line.append(el('b', '', '连接状态'), el('span', '', '未接入'));
      panel.append(line);
      panel.append(el('div', 'pair-wait-note', '非抖音平台尚未接入账号连接；不会显示配对码，也不能绑定真实号。'));
      return panel;
    }
    if (!pairApiAvailable) {
      panel.dataset.pairState = 'unavailable';
      const line = el('div', 'pair-state-line');
      line.append(el('b', '', '连接状态'), el('span', '', '桥接未接入'));
      panel.append(line);
      panel.append(el('div', 'pair-wait-note', '此桌面版本尚未接入账号连接桥接；不会显示一次性码，也不能确认身份。现有绑定信息仍可在账号行查看。'));
      return panel;
    }
    const pair = pairFor(account.id);
    const effective = pairEffectiveState(pair);
    panel.dataset.pairState = effective;
    const stateLine = el('div', 'pair-state-line');
    stateLine.append(el('b', '', '连接状态'), el('span', '', pairStateLabel({ state: effective })));
    panel.append(stateLine);
    if (effective === 'not_started') {
      panel.append(el('div', 'pair-wait-note', bindingOf(account)
        ? '已绑定真实号；重新连接时会再次核对相同号，不会自动改绑定。'
        : '连接后会显示一次性码；只有你点击候选身份确认才会绑定，不会自动确认。'));
      return panel;
    }
    if (effective === 'awaiting_pair') {
      const code = visiblePairCode(pair);
      if (code) {
        const details = el('div', 'pair-details');
        details.append(el('span', '', `本机端口：${pair.port ?? '未提供'}`));
        details.append(el('span', '', '一次性码：'));
        details.append(el('code', 'pair-code', code));
        if (pair.expiresAt) details.append(el('small', 'pair-expiry', `有效至：${formatDate(pair.expiresAt)}`));
        panel.append(details);
        panel.append(el('div', 'pair-wait-note', '请按扩展提示提交一次只读识别结果；码只在本机显示，确认、过期或取消后立即清除。'));
      } else {
        panel.append(el('div', 'pair-wait-note', '连接码已过期或当前不可显示；请先取消本次连接，再重新发起。一次性码不会继续展示。'));
      }
      const message = pairMessage(pair);
      if (message) panel.append(el('small', 'pair-code-clear-note', message));
      const actions = el('div', 'pair-candidate-actions');
      actions.append(button('取消本次连接', 'button button-quiet', () => cancelAccountPair(account.id), !pairApiAvailable || state.pairBusy.has(account.id)));
      panel.append(actions);
      return panel;
    }
    if (effective === 'awaiting_confirmation') {
      const candidate = candidateFor(pair);
      if (!candidate || !candidate.platformAccountId) {
        panel.append(el('div', 'pair-wait-note', '已进入确认阶段，但未收到可核对的身份；操作台不会自动绑定。'));
        return panel;
      }
      const binding = bindingOf(account);
      const owner = teacherById(accountTeacherId(account));
      const teacher = owner ? owner.name : '未分配（需先迁入老师）';
      const candidateBox = el('div', 'pair-candidate');
      candidateBox.setAttribute('aria-live', 'polite');
      candidateBox.append(el('b', '', `实际识别到抖音号 ${candidate.platformAccountId}`));
      if (candidate.displayName) candidateBox.append(el('small', '', `显示名：${candidate.displayName}`));
      candidateBox.append(el('small', '', `环境：${candidate.environmentLabel || '未提供'}`));
      candidateBox.append(el('small', '', `确认绑定到老师 ${teacher}？`));
      const sameBinding = !binding || String(binding.platformAccountId) === candidate.platformAccountId;
      candidateBox.append(el('small', '', binding
        ? (sameBinding ? '与当前绑定真实号一致；确认只刷新核对记录，不会自动改绑定。' : '识别号与当前绑定不一致；桌面连接服务会拒绝覆盖，请先解除绑定再重新连接。')
        : '确认后才会写入本机绑定；不会自动确认，也不会登录平台。'));
      if (!owner) candidateBox.append(el('small', '', '该旧备注还没有归属老师；请先在上方选择老师并迁入，再确认绑定。'));
      const actions = el('div', 'pair-candidate-actions');
      const confirm = button(owner ? `确认绑定到 ${teacher}` : '先迁入老师再确认', 'button button-primary', () => confirmAccountPair(account.id), !pairApiAvailable || !sameBinding || !owner || state.pairBusy.has(account.id));
      confirm.title = !owner ? '先选择归属老师并迁入旧备注。' : (sameBinding ? '只有你点击这里才会确认绑定。' : '识别号与当前绑定不同，请先解除绑定。');
      actions.append(confirm, button('取消本次连接', 'button button-quiet', () => cancelAccountPair(account.id), !pairApiAvailable || state.pairBusy.has(account.id)));
      candidateBox.append(actions);
      panel.append(candidateBox);
      return panel;
    }
    if (effective === 'bound') {
      const binding = bindingOf(account);
      if (!binding) {
        panel.append(el('div', 'pair-wait-note', '已收到绑定完成事件，但本地账号还没有绑定信息；请刷新核对，不要当作已绑定或可发布。'));
        return panel;
      }
      panel.append(el('div', 'pair-wait-note', '已绑定到上方老师和浏览器环境。'));
      const verifiedAt = pair?.verifiedAt || binding.verifiedAt;
      if (verifiedAt) panel.append(el('small', 'pair-expiry', `核对时间：${formatDate(verifiedAt)}`));
      return panel;
    }
    const message = pairMessage(pair);
    if (message) panel.append(el('div', 'pair-wait-note', message));
    panel.append(el('div', 'pair-code-clear-note', '一次性码已清除；如需继续请重新发起连接。'));
    return panel;
  }
  function renderAccountActions(account) {
    const host = el('div', 'account-actions');
    if (usesManagedBrowserUi(account)) return host;
    const bound = !!bindingOf(account);
    const pairBusy = state.pairBusy.has(account.id);
    const inspectBusy = state.inspectBusy.has(account.id);
    if (account.platform !== 'douyin') {
      host.append(
        button('连接（未接入）', 'button button-quiet', null, true),
        button('检查（未接入）', 'button button-quiet', null, true),
        button('打开（未接入）', 'button button-quiet', null, true),
        button('解除（未接入）', 'button button-quiet', null, true)
      );
      host.append(el('small', 'account-unavailable', '非抖音平台尚未接入账号连接；不可连接、检查、打开或绑定真实号。'));
      appendMigrationAction(host, account);
      return host;
    }
    if (!pairApiAvailable) {
      host.append(
        button('连接（桥接未接入）', 'button button-quiet', null, true),
        button('检查（桥接未接入）', 'button button-quiet', null, true),
        button('打开（桥接未接入）', 'button button-quiet', null, true),
        button('解除（桥接未接入）', 'button button-quiet', null, true)
      );
      host.append(el('small', 'account-unavailable', '此桌面版本尚未接入账号连接桥接；不会创建假绑定。'));
      appendMigrationAction(host, account);
      return host;
    }
    const effective = pairEffectiveState(pairFor(account.id));
    const awaiting = ['awaiting_pair', 'awaiting_confirmation'].includes(effective);
    const retry = ['error', 'expired', 'canceled'].includes(effective);
    const connect = button(awaiting ? '连接进行中' : bound ? '重新核对连接' : retry ? '重新连接' : '连接账号', 'button button-quiet', () => startAccountPair(account.id), pairBusy || awaiting);
    connect.title = bound ? '重新连接仍会核对真实号，不会自动改绑定。' : '连接后在扩展中提交一次只读识别结果。';
    host.append(connect);
    const check = button(inspectBusy ? '检查中…' : '检查身份', 'button button-quiet', () => inspectManagedAccount(account.id), inspectBusy || !bound);
    check.title = bound ? '逐项核对当前连接与已绑定真实号。' : '先绑定真实号后再检查。';
    host.append(check);
    const open = button('打开账号', 'button button-quiet', () => openManagedAccount(account.id), pairBusy || !bound);
    open.title = bound ? '打开本机绑定关联的账号页面或环境。' : '先绑定真实号后再打开。';
    host.append(open);
    const unbind = button('解除绑定', 'button button-quiet', () => openUnbindConfirm(account.id), state.unbindBusy || !bound || awaiting);
    unbind.title = awaiting ? '请先确认或取消本次连接，再解除绑定。' : (bound ? '只解除本机绑定，不退出网站、不删除环境或历史。' : '当前没有本机绑定。');
    host.append(unbind);
    appendMigrationAction(host, account);
    return host;
  }
  function appendMigrationAction(host, account) {
    if (accountTeacherId(account) && teacherById(accountTeacherId(account))) return;
    if (!teacherApiAvailable) {
      host.append(button('迁入（桥接未接入）', 'tiny-link', null, true));
      return;
    }
    if (bindingOf(account)) {
      host.append(button('已绑定，不能换老师', 'tiny-link', null, true));
      return;
    }
    const targetTeacher = !teacherProfileUI?.dirty ? teacherById(teacherProfileUI?.teacherId) : null;
    if (targetTeacher) {
      const move = button(`迁入 ${targetTeacher.name}`, 'tiny-link', () => moveAccountToTeacher(account), state.assignBusy.has(account.id));
      move.title = '旧备注不会自动归入老师；点击后才迁入当前正在编辑且已保存的老师。';
      host.append(move);
    } else {
      host.append(button('先保存或选择右侧老师再迁入', 'tiny-link', null, true));
    }
  }
  function emptyCard(title, description) { const card = el('div', 'empty-state'); card.append(el('b', '', title), el('p', '', description)); return card; }

  async function moveAccountToTeacher(account) {
    if (!teacherApiAvailable || state.assignBusy.has(account.id)) return;
    if (teacherProfileUI?.dirty) { toast('请先保存正在编辑的老师资料，再迁入旧账号。', true); return; }
    const targetTeacher = teacherById(teacherProfileUI?.teacherId);
    if (!targetTeacher) { toast('请先保存或选择正在编辑的老师，再迁入旧备注。', true); return; }
    state.assignBusy.add(account.id); renderAccounts();
    try {
      const result = await invokeTeacher('saveManagedAccount', { id: account.id, teacherId: targetTeacher.id, platform: account.platform, label: account.label });
      const source = result?.account || result;
      const record = source && typeof source === 'object' && source.id
        ? mergeAccountRecord({ ...account, teacherId: targetTeacher.id, ...source })
        : null;
      if (!record) await refreshBootstrap({ preserveDraft: true });
      renderAccounts(); renderPlatformCards(); updateOverview();
      toast(`旧备注已迁入 ${targetTeacher.name}；绑定状态和真实号不会被伪造。`);
    } catch (error) { toast(`未能迁入旧备注：${error.message}`, true); }
    finally { state.assignBusy.delete(account.id); renderAccounts(); }
  }
  async function startAccountPair(accountId) {
    if (!pairApiAvailable || state.pairBusy.has(accountId)) return;
    const account = accountById(accountId);
    if (!account) { toast('账号记录不存在；请刷新后重试。', true); return; }
    if (account.platform !== 'douyin') { toast('当前只支持抖音账号连接；不会为其他平台创建假绑定。', true); return; }
    if (['awaiting_pair', 'awaiting_confirmation'].includes(pairEffectiveState(pairFor(accountId)))) {
      toast('这个账号已有连接在进行；请先确认或取消本次连接。', true);
      return;
    }
    state.pairBusy.add(accountId); renderAccounts();
    try {
      const result = await invokePair('startAccountPair', accountId);
      const pair = result?.pair || result;
      if (!pair || typeof pair !== 'object') throw new Error('连接服务没有返回配对信息。');
      mergeAccountPair({ ...pair, accountId: typeof pair.accountId === 'string' ? pair.accountId : accountId });
      toast('连接已开始；一次性码只在等待扩展提交时显示，确认或结束后立即清除。');
    } catch (error) {
      toast(`无法开始账号连接：${pairErrorMessage(error, accountId)}`, true);
    } finally {
      state.pairBusy.delete(accountId); renderAccounts();
      if (state.currentView === 'new') syncPlatformCards();
    }
  }
  async function cancelAccountPair(accountId) {
    if (!pairApiAvailable || state.pairBusy.has(accountId)) return;
    const pair = pairFor(accountId);
    if (!pair) return;
    if (!['awaiting_pair', 'awaiting_confirmation'].includes(pairEffectiveState(pair))) {
      toast('当前没有可取消的账号连接。', true);
      return;
    }
    state.pairBusy.add(accountId); renderAccounts();
    try {
      const result = await invokePair('cancelAccountPair', accountId);
      const returned = result?.pair || result;
      const current = state.accountPairs[accountId] || { accountId };
      const returnedCode = (returned && typeof returned.pairCode === 'string' && returned.pairCode)
        || (typeof current.pairCode === 'string' ? current.pairCode : '');
      let cancelMessage = (returned && typeof returned.message === 'string' && returned.message) || '本次连接已取消。';
      if (returnedCode) cancelMessage = cancelMessage.split(returnedCode).join('[一次性码已隐藏]');
      state.accountPairs[accountId] = sanitizePair({
        ...current,
        ...(returned && typeof returned === 'object' ? returned : {}),
        accountId,
        state: 'canceled',
        pairCode: '',
        candidate: null,
        message: cancelMessage
      });
      clearPairExpiry(accountId);
      toast('本次账号连接已取消；一次性码已清除。');
    } catch (error) {
      toast(`未能取消账号连接：${pairErrorMessage(error, accountId)}`, true);
    } finally {
      state.pairBusy.delete(accountId); renderAccounts();
      if (state.currentView === 'new') syncPlatformCards();
    }
  }
  async function confirmAccountPair(accountId) {
    if (!pairApiAvailable || state.pairBusy.has(accountId)) return;
    const account = accountById(accountId);
    const pair = pairFor(accountId);
    const candidate = candidateFor(pair);
    if (!account || pairEffectiveState(pair) !== 'awaiting_confirmation' || !candidate?.platformAccountId) {
      toast('当前没有可确认的候选身份；不会自动创建绑定。', true);
      return;
    }
    if (!teacherById(accountTeacherId(account))) {
      toast('账号还没有归属老师；请先选择老师并迁入旧备注，再确认绑定。', true);
      return;
    }
    const binding = bindingOf(account);
    if (binding && String(binding.platformAccountId) !== candidate.platformAccountId) {
      toast('候选真实号与当前绑定不一致；桌面连接服务会拒绝覆盖，请先解除绑定再重新连接。', true);
      return;
    }
    state.pairBusy.add(accountId); renderAccounts();
    try {
      const result = await invokePair('confirmAccountPair', accountId);
      const confirmed = result?.account || result;
      if (confirmed && typeof confirmed === 'object' && confirmed.id) mergeAccountRecord(confirmed);
      const provisionalPair = {
        accountId, state: 'bound', pairCode: '', candidate: null,
        message: '已确认绑定。', verifiedAt: new Date().toISOString()
      };
      state.accountPairs[accountId] = provisionalPair;
      let refreshError = '';
      try { await refreshBootstrap({ preserveDraft: true }); } catch (error) { refreshError = error.message; }
      const accountNow = accountById(accountId);
      const bindingNow = bindingOf(accountNow);
      clearPairExpiry(accountId);
      if (bindingNow) {
        state.accountPairs[accountId] = { ...provisionalPair, verifiedAt: bindingNow.verifiedAt || provisionalPair.verifiedAt };
        const success = `已确认抖音号 ${candidate.platformAccountId} 绑定到老师 ${teacherLabel(accountTeacherId(accountNow || account))}；绑定不代表在线或可发布。`;
        toast(refreshError ? `${success} 但刷新账号列表失败：${refreshError}` : success, !!refreshError);
      } else {
        state.accountPairs[accountId] = {
          accountId, state: 'error', pairCode: '', candidate: null,
          message: '绑定已确认，但本地账号仍未显示绑定；请刷新核对，不要当作在线或可发布。'
        };
        toast(`绑定已确认，但本地账号列表没有显示绑定；请刷新核对。${refreshError ? ` 刷新失败：${refreshError}` : ''}`, true);
      }
    } catch (error) {
      toast(`未能确认绑定：${pairErrorMessage(error, accountId)}`, true);
    } finally {
      state.pairBusy.delete(accountId); renderAccounts();
      if (state.currentView === 'new') syncPlatformCards();
    }
  }
  async function inspectManagedAccount(accountId) {
    if (!pairApiAvailable || state.inspectBusy.has(accountId) || state.pairBusy.has(accountId) || state.readinessBusy) return;
    const account = accountById(accountId);
    if (!account || (!usesManagedBrowserUi(account) && account.platform !== 'douyin')) { toast('此平台尚未接入身份检查。', true); return; }
    if (!bindingOf(account)) { toast('请先绑定真实号，再检查身份。', true); return; }
    state.inspectBusy.add(accountId);
    state.accountChecks[accountId] = { pending: true };
    renderAccounts();
    try {
      const result = await invokePair('inspectManagedAccount', accountId);
      const check = result && typeof result === 'object' ? result : {};
      const stateName = ['verified', 'mismatch', 'login_required', 'offline', 'unverifiable'].includes(check.state) ? check.state : 'unverifiable';
      state.accountChecks[accountId] = {
        state: stateName,
        checkedAt: check.checkedAt || null,
        platformAccountId: safeShort(check.platformAccountId, 80),
        message: safeShort(check.message, 300)
      };
      if (stateName === 'verified') toast('本次身份核对一致；后续上传与提交前仍需重新检查。');
      else if (stateName === 'mismatch') toast(check.message || '身份检查不一致；不会自动改绑定。', true);
      else if (stateName === 'offline') toast(check.message || '当前连接离线，无法核验身份。', true);
      else toast(check.message || '当前无法核验身份。', true);
    } catch (error) {
      state.accountChecks[accountId] = { state: 'unverifiable', message: pairErrorMessage(error, accountId) };
      toast(`未能检查身份：${pairErrorMessage(error, accountId)}`, true);
    } finally {
      state.inspectBusy.delete(accountId); renderAccounts(); updateOverview();
      if (state.currentView === 'new') syncPlatformCards();
    }
  }
  async function openManagedAccount(accountId) {
    if (!pairApiAvailable) { toast('此桌面版本尚未接入账号连接桥接；不能打开账号。', true); return; }
    const account = accountById(accountId);
    if (!account || (!usesManagedBrowserUi(account) && account.platform !== 'douyin')) { toast('此平台尚未接入账号连接。', true); return; }
    if (!bindingOf(account)) { toast('请先绑定真实号，再打开账号。', true); return; }
    try {
      const result = await invokePair('openManagedAccount', accountId);
      if (result?.opened === true) toast('已请求打开本机绑定关联的账号页面；登录状态仍需自行核对。');
      else toast('连接服务没有确认已打开账号页面；请以实际窗口为准。', true);
    } catch (error) {
      toast(`未能打开账号：${pairErrorMessage(error, accountId)}`, true);
    }
  }
  function openUnbindConfirm(accountId) {
    const account = accountById(accountId);
    if (!account) { toast('账号记录不存在；请刷新后重试。', true); return; }
    if (!bindingOf(account)) { toast('当前没有本机绑定可解除。', true); return; }
    if (!pairApiAvailable) { toast('此桌面版本尚未接入账号连接桥接；不能解除绑定。', true); return; }
    state.unbindReview = { accountId };
    renderUnbindConfirm();
    showModal('#unbind-modal', '#cancel-unbind');
  }
  function renderUnbindConfirm() {
    const host = $('#unbind-account-body');
    const note = $('#unbind-note');
    const confirm = $('#confirm-unbind');
    const cancel = $('#cancel-unbind');
    if (!host || !confirm) return;
    host.replaceChildren();
    const account = accountById(state.unbindReview?.accountId);
    if (!account) {
      host.append(el('div', 'snapshot-empty', '账号记录已不存在，无法解除绑定。'));
      confirm.disabled = true;
      if (cancel) cancel.disabled = state.unbindBusy;
      return;
    }
    host.append(snapshotCard('将解除的本机绑定', [
      ['老师', accountTeacherLabel(account)],
      ['平台', platformFor(account.platform).label],
      ['账号备注', account.label || '未命名账号'],
      ['真实号', accountRealId(account) || '未绑定'],
      ['环境', environmentLabelFor(account)],
      ['当前状态', accountCheckLabel(account)]
    ]));
    if (note) {
      note.className = 'publish-confirm-note';
      note.textContent = '解除只清除本机保存的真实号绑定；不会退出网站、不会删除浏览器环境、账号备注或任务历史。当前真实发布仍未接通。';
    }
    confirm.disabled = state.unbindBusy || !bindingOf(account) || !pairApiAvailable;
    confirm.textContent = state.unbindBusy ? '正在解除…' : '确认解除绑定';
    if (cancel) cancel.disabled = state.unbindBusy;
  }
  function closeUnbindConfirm() {
    if (state.unbindBusy) return;
    state.unbindReview = null;
    hideModal('#unbind-modal');
  }
  async function confirmUnbind() {
    const accountId = state.unbindReview?.accountId;
    if (!accountId || state.unbindBusy) return;
    const account = accountById(accountId);
    if (!account || !bindingOf(account)) {
      state.unbindReview = null; hideModal('#unbind-modal');
      toast('当前没有本机绑定可解除。', true); return;
    }
    state.unbindBusy = true; renderUnbindConfirm(); updateOverview();
    try {
      const result = await invokePair('unbindManagedAccount', accountId);
      const updated = result?.account || result;
      if (updated && typeof updated === 'object' && updated.id) {
        const existing = accountById(accountId) || {};
        mergeAccountRecord({ ...existing, ...updated, id: accountId, binding: null, status: 'unconnected' });
      }
      delete state.accountPairs[accountId];
      delete state.accountChecks[accountId];
      clearPairExpiry(accountId);
      let refreshError = '';
      try { await refreshBootstrap({ preserveDraft: true }); } catch (error) { refreshError = error.message; }
      state.unbindReview = null; hideModal('#unbind-modal');
      toast(refreshError
        ? `已解除本机绑定；未退出网站、未删除环境或历史。刷新账号列表失败：${refreshError}`
        : '已解除本机绑定；未退出网站、未删除浏览器环境、账号备注或历史。', !!refreshError);
    } catch (error) {
      toast(`未能解除绑定：${pairErrorMessage(error, accountId)}`, true);
    } finally {
      state.unbindBusy = false;
      if (state.unbindReview) renderUnbindConfirm();
      renderAccounts(); updateOverview();
    }
  }
  $('#draft-teacher').addEventListener('change', event => selectDraftTeacher(event.target.value));
  $('#manage-teachers').addEventListener('click', () => {
    switchView('accounts');
    teacherProfileUI?.open(state.currentDraft.teacherId || null);
  });
  $('#close-unbind').addEventListener('click', closeUnbindConfirm);
  $('#cancel-unbind').addEventListener('click', closeUnbindConfirm);
  $('#confirm-unbind').addEventListener('click', confirmUnbind);
  $('#unbind-modal').addEventListener('click', event => { if (event.target === $('#unbind-modal')) closeUnbindConfirm(); });

  function renderTemplates() {
    $('#template-context').textContent = `当前发布任务归属：${teacherLabel(state.currentDraft.teacherId)}。模板按这位老师保存，独立于上方正在编辑的老师资料。`;
    const host = $('#template-list'); host.replaceChildren();
    if (!state.templates.length) { host.append(emptyCard('还没有模板', '保存当前文案和平台设置后，可在同一老师的新任务中应用。')); return; }
    state.templates.forEach(template => {
      const row = el('div', 'template-row'); const info = el('div', 'template-info');
      const enabledCount = (template.targets || []).filter(target => target.enabled).length;
      const ownerId = typeof template.teacherId === 'string' ? template.teacherId : '';
      const ownerLabel = ownerId ? teacherLabel(ownerId) : '未分配（旧模板）';
      const sameTeacher = ownerId === (state.currentDraft.teacherId || '');
      info.append(el('b', '', template.name), el('small', '', `归属：${ownerLabel} · ${enabledCount} 个平台配置 · 不含视频与封面`));
      const actions = el('div', 'template-row-actions');
      const apply = button('应用', 'button button-outline', () => applyTemplate(template), !bridgeAvailable || !sameTeacher);
      apply.title = sameTeacher
        ? '只复制文案和平台配置，不带入视频、封面和旧定时日期。'
        : `模板属于 ${ownerLabel}，当前任务老师是 ${teacherLabel(state.currentDraft.teacherId)}，不能跨老师应用。`;
      actions.append(apply);
      if (!sameTeacher) actions.append(el('small', 'template-owner-warning', '不可跨老师'));
      row.append(info, actions); host.append(row);
    });
  }
  async function applyTemplate(template) {
    const templateTeacherId = typeof template.teacherId === 'string' ? template.teacherId : '';
    const currentTeacherId = state.currentDraft.teacherId || '';
    if (templateTeacherId !== currentTeacherId) {
      toast(`不能应用其他老师的模板：模板属于 ${teacherLabel(templateTeacherId)}，当前任务是 ${teacherLabel(currentTeacherId)}。`, true);
      return;
    }
    const current = state.currentDraft;
    const assets = { video: current.video, covers: copyDraft(current).covers };
    const incoming = new Map((template.targets || []).map(target => [target.platform, target]));
    state.currentDraft = {
      ...current, ...assets,
      teacherId: currentTeacherId,
      schedule: copyDraft(scheduleOf(current)),
      common: copyDraft(template.common || { title: '', description: '', tags: [] }),
      sharedDeclaration: copyDraft(template.sharedDeclaration || { intent: 'none' }),
      targets: state.platforms.map(platform => {
        const original = incoming.get(platform.id) || newTarget(platform.id);
        const eligibleAccountId = targetAccountEligible(accountById(original.accountId), platform.id, currentTeacherId) ? original.accountId : '';
        return {
          ...newTarget(platform.id), ...copyDraft(original), accountId: eligibleAccountId,
          covers: { landscape: null, portrait: null },
          declaration: { required: false, text: '', ...(original.declaration || {}) },
          collection: { required: false, name: '', ...(original.collection || {}) }
        };
      })
    };
    state.dirty = true; renderAccounts(); syncDraftForm(); switchView('new');
    toast(`模板已应用到 ${teacherLabel(currentTeacherId)}；素材和本条发布时间保持当前选择。`);
  }
  $('#save-template').addEventListener('click', async () => {
    const name = $('#template-name').value.trim();
    if (!name) { toast('请填写模板名称。', true); return; }
    const teacherId = state.currentDraft.teacherId || '';
    if (!teacherById(teacherId)) {
      toast('请先选择任务归属老师；模板必须绑定老师，不能保存为跨老师模板。', true);
      const select = $('#draft-teacher');
      if (select) select.focus();
      return;
    }
    if (sanitizeDraftAccounts()) state.dirty = true;
    const targets = state.currentDraft.targets.map(target => ({
      platform: target.platform, enabled: target.enabled,
      accountId: targetAccountEligible(accountById(target.accountId), target.platform, teacherId) ? target.accountId : '',
      inherit: target.inherit,
      title: target.title, description: target.description, tags: target.tags,
      declaration: copyDraft(target.declaration), collection: copyDraft(target.collection),
      location: copyDraft(target.location || { mode: 'none', name: '' }),
      ...(target.specialSettings ? { specialSettings: copyDraft(target.specialSettings) } : {})
    }));
    try {
      const saved = await invoke('saveTemplate', { name, teacherId, common: copyDraft(state.currentDraft.common), sharedDeclaration: copyDraft(state.currentDraft.sharedDeclaration || { intent: 'none' }), targets, schedule: immediateSchedule() });
      const stored = { ...saved, teacherId: typeof saved.teacherId === 'string' ? saved.teacherId : teacherId };
      state.templates = [stored, ...state.templates.filter(item => item.id !== stored.id)];
      $('#template-name').value = ''; renderTemplates();
      toast('模板已保存并绑定当前老师；视频与封面没有写入模板。');
    } catch (error) { toast(error.message, true); }
  });

  const runStatus = (status, mode) => mode === 'chrome_prepare' ? realRunStatusLabel(status) : ({
    queued: '排队中', running: '本地演练中', awaiting_review: '演练完成 · 未上传', canceled: '已取消',
    interrupted: '演练中断', failed: '演练失败', awaiting_verification: '待核查'
  }[status] || status || '状态未知');
  const itemStatus = (status, mode) => mode === 'chrome_prepare' ? realItemStatusLabel(status) : ({ queued: '等待演练', checking: '本地检查', preparing: '本地演练', awaiting_review: '演练完成 · 未上传', canceled: '已取消', interrupted: '已中断', failed: '失败' }[status] || status || '状态未知');
  function formatDate(value) {
    if (!value) return '时间未知';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function mergeRun(run) {
    if (!run?.id) return;
    const index = state.runs.findIndex(item => item.id === run.id);
    const previous = index >= 0 ? state.runs[index] : null;
    if (index >= 0) state.runs[index] = run; else { state.runs.unshift(run); state.expandedRuns.add(run.id); }
    if (isRealRun(run) && ['submitted', 'awaiting_verification', 'canceled', 'failed'].includes(run.status)) delete state.liveSessions[run.id];
    notifyRealTransition(previous, run);
    renderRuns();
    renderRealPanel();
    if (state.publishReview?.runId === run.id) renderPublishConfirm();
    if (state.stopReview?.runId === run.id) renderStopConfirm();
    updateOverview();
  }
  function renderRuns() {
    if(publishHistoryUI){publishHistoryUI.render();updateOverview();return;}
    const host = $('#run-list'); host.replaceChildren();
    if (!state.runs.length) { host.append(emptyCard('任务记录会显示在这里', '开始一次本地演练或抖音真实测试后，可查看每个平台/助手的进度、真实事件和导出报告。')); updateOverview(); return; }
    [...state.runs].sort((a,b)=>(Date.parse(b.createdAt) || 0)-(Date.parse(a.createdAt) || 0))
      .forEach(run => host.append(makeRunCard(run)));
    updateOverview();
  }
  function makeRunCard(run) {
    if (run.mode === 'managed_prepare') return managedPilotUI.renderRun(run);
    const real = isRealRun(run);
    const card = el('article', `run-card${real ? ' real-run' : ''}`);
    const head = button('', 'run-head', () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden) state.expandedRuns.delete(run.id); else state.expandedRuns.add(run.id);
      chevron.textContent = detail.hidden ? '⌄' : '⌃';
    });
    const title = el('span', 'run-title');
    const videoName = run.snapshot?.video?.name || '视频素材未记录';
    const titleText = run.snapshot?.common?.title || run.summary?.[0]?.title || (real ? '抖音真实测试' : '本地演练任务');
    const modeLabel = real ? '抖音真实测试' : '本地演练';
    const small = el('small');
    small.append(el('span', `run-mode${real ? ' real' : ''}`, modeLabel), document.createTextNode(` · ${videoName} · ${formatDate(run.createdAt)}`));
    const titleBlock = document.createElement('span'); titleBlock.append(el('b', '', titleText), small);
    title.append(el('span', `platform-mark${real ? ' platform-douyin' : ''}`, real ? '抖' : String(run.items?.length || 0)), titleBlock);
    const badgeClass = real ? realRunBadgeClass(run.status) : (run.status === 'awaiting_review' ? 'finished' : run.status === 'canceled' ? 'canceled' : '');
    const badge = el('span', `run-status${badgeClass ? ` ${badgeClass}` : ''}`, runStatus(run.status, run.mode));
    const chevron = el('span', 'run-chevron', state.expandedRuns.has(run.id) ? '⌃' : '⌄'); head.append(title, badge, chevron);
    const detail = el('div', 'run-detail'); detail.hidden = !state.expandedRuns.has(run.id);
    if (real) {
      const account = runAccountDisplay(run);
      const accountNote = el('p', 'run-real-account');
      accountNote.append(el('b', '', '实际账号：'), document.createTextNode(account || '尚未核对（助手未回传实际账号）'));
      detail.append(accountNote);
    }
    const scheduleNote = el('p', 'run-real-account');
    scheduleNote.append(el('b', '', '发布时间：'), document.createTextNode(scheduleLabel(run.snapshot?.schedule)));
    detail.append(scheduleNote);
    const grid = el('div', 'run-detail-grid');
    (run.items || []).forEach(item => {
      const platform = platformFor(item.platform); const tile = el('div', 'run-item');
      const itemHead = el('div', 'run-item-head'); itemHead.append(el('b', '', real ? '抖音 · 本机交接' : platform.label), el('span', 'run-item-status', itemStatus(item.status, run.mode)));
      const detailText = item.detail || (real ? '助手尚未回传这一步的状态；请以平台页面为准。' : '演练状态未提供。');
      tile.append(itemHead, el('p', '', `${selectedAccountLabelFromRun(run, item)} · ${detailText}`));
      if (Number.isFinite(item.progress) && item.progress > 0) {
        const progress = document.createElement('progress'); progress.max = 100; progress.value = item.progress; progress.setAttribute('aria-label', `${real ? '抖音真实测试' : `${platform.label}本地演练`}进度`); tile.append(progress);
      }
      const checks = item.checks && Object.keys(item.checks).length ? item.checks : run.checks;
      if (real) {
        const checkWrap = el('div', 'run-checks');
        [['video', '视频'], ['covers', '封面'], ['text', '文案'], ['declaration', '声明'], ['collection', '合集']].forEach(([key, label]) => {
          if (typeof checks?.[key] !== 'boolean') return;
          checkWrap.append(el('span', `run-check${checks[key] ? ' ok' : ' bad'}`, `${label}：${checks[key] ? '通过' : '未通过'}`));
        });
        const scheduleChecked = typeof checks?.schedule === 'boolean' ? checks.schedule
          : typeof run.checks?.schedule === 'boolean' ? run.checks.schedule : undefined;
        checkWrap.append(el('span', `run-check${scheduleChecked === true ? ' ok' : scheduleChecked === false ? ' bad' : ''}`, `发布时间：${scheduleLabel(run.snapshot?.schedule)} · ${scheduleChecked === true ? '已核对' : scheduleChecked === false ? '未通过' : '尚未核对'}`));
        if (checkWrap.childElementCount) tile.append(checkWrap);
      }
      const receipt = real ? publishReceiptLines(run, item) : [];
      if (real && receipt.length) {
        const receiptBox = el('div', 'run-receipt');
        receipt.forEach(([label, value]) => { const line = el('div', 'run-receipt-line'); line.append(el('b', '', label), el('span', '', value)); receiptBox.append(line); });
        tile.append(receiptBox);
      }
      grid.append(tile);
    });
    detail.append(grid);
    const events = el('div', 'event-list');
    (run.events || []).slice().reverse().forEach(event => {
      const eventItem = (run.items || []).find(item => item.id === event.itemId);
      const prefix = eventItem ? `${real ? '抖音' : platformFor(eventItem.platform).label} · ` : '';
      const row = el('div', 'run-event'); row.append(el('time', '', formatDate(event.at)), document.createTextNode(prefix + (event.message || runStatus(event.status, run.mode)))); events.append(row);
    });
    if (!events.childElementCount) events.append(el('div', 'run-event empty', real ? '尚无助手或平台回执。' : '尚无本地演练事件。'));
    detail.append(events);
    const actions = el('div', 'run-actions');
    if (real) {
      if (run.status === 'awaiting_confirmation') {
        actions.append(button('核对并确认发布到抖音', 'button button-real', () => openPublishConfirm(run.id), !realTestApiAvailable || state.authorizing));
      }
      if (canStopRealRun(run)) {
        actions.append(button('停止本机交接', 'button button-quiet', () => openStopConfirm(run.id), !realTestApiAvailable || state.realStopping));
      }
    } else {
      const canCancel = ['queued', 'running'].includes(run.status);
      actions.append(button('取消本地演练', 'button button-quiet', async () => {
        try { mergeRun(await invoke('cancelRun', run.id)); toast('已请求取消本地演练；未上传。'); } catch (error) { toast(error.message, true); }
      }, !bridgeAvailable || !canCancel));
    }
    actions.append(button('导出报告', 'button button-outline', async () => {
      try { const result = await invoke('exportRun', run.id); if (!result.canceled) toast(`报告已导出：${result.path || '已保存'}`); } catch (error) { toast(error.message, true); }
    }, !bridgeAvailable));
    detail.append(actions); card.append(head, detail); return card;
  }
  function selectedAccountLabelFromRun(run, item) {
    if (isRealRun(run)) {
      const actual = runAccountDisplay(run) || safeShort(item?.accountDisplay, 120);
      return actual ? `${actual}（助手回传）` : '实际账号尚未核对';
    }
    const account = state.accounts.find(entry => entry.id === item.accountId);
    if (account) return `${accountDisplay(account)}${bindingOf(account) ? '（已绑定，不代表可发布）' : '（未绑定真实号）'}`;
    const snapshotTarget = run.snapshot?.targets?.find(target => target.platform === item.platform);
    const snapshotAccount = accountById(snapshotTarget?.accountId);
    if (snapshotAccount) return `${accountDisplay(snapshotAccount)}${bindingOf(snapshotAccount) ? '（已绑定，不代表可发布）' : '（未绑定真实号）'}`;
    return snapshotTarget ? '账号已不在本机列表' : '账号未记录';
  }

  /* ================= 新版几何主界面、4 步向导、三合一识别与常用标签 ================= */
  const COMMON_TAGS_LOCAL_KEY = 'video_dispatch_common_tags_v1';

  function sanitizeCommonTag(raw) {
    return String(raw || '').trim().replace(/^#+/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  }
  function commonTagOwnerKey(teacherId = state.currentDraft.teacherId) {
    return teacherId && teacherById(teacherId) ? teacherId : '__default__';
  }
  function getCommonTags(ownerKey = commonTagOwnerKey()) {
    const list = state.commonTags?.[ownerKey];
    return Array.isArray(list) ? list : [];
  }
  async function loadCommonTags() {
    let loaded = null;
    if (hasPublisherMethod('loadCommonTags')) {
      try { loaded = await publisher.loadCommonTags(); } catch {}
    }
    if (!loaded || typeof loaded !== 'object') {
      try {
        const raw = localStorage.getItem(COMMON_TAGS_LOCAL_KEY);
        if (raw) loaded = JSON.parse(raw);
      } catch {}
    }
    state.commonTags = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  }
  async function persistCommonTags() {
    try { localStorage.setItem(COMMON_TAGS_LOCAL_KEY, JSON.stringify(state.commonTags)); } catch {}
    if (hasPublisherMethod('saveCommonTags')) {
      try { state.commonTags = await publisher.saveCommonTags(state.commonTags); } catch {}
    }
  }
  async function addCommonTagFor(ownerKey, rawTag, { selectInDraft = false } = {}) {
    const tag = sanitizeCommonTag(rawTag);
    if (!tag) return false;
    const list = [...getCommonTags(ownerKey)];
    if (!list.includes(tag)) {
      list.push(tag);
      state.commonTags[ownerKey] = list.slice(0, 100);
      await persistCommonTags();
    }
    if (selectInDraft) {
      const current = Array.isArray(state.currentDraft.common.tags) ? [...state.currentDraft.common.tags] : [];
      if (!current.includes(tag)) {
        current.push(tag);
        state.currentDraft.common.tags = current;
        setValue('#common-tags', current.join(', '));
        setDirty();
      }
    }
    renderStep2Tags();
    renderHome();
    if (state.currentView === 'library') renderLibraryView(state.libraryTab);
    return true;
  }
  async function removeCommonTagFor(ownerKey, tag) {
    const list = getCommonTags(ownerKey).filter(item => item !== tag);
    state.commonTags[ownerKey] = list;
    await persistCommonTags();
    renderStep2Tags();
    renderHome();
    if (state.currentView === 'library') renderLibraryView(state.libraryTab);
  }

  function renderHome() {
    const publishSub = $('#home-publish-sub');
    if (publishSub) {
      publishSub.textContent = state.teachers.length
        ? `${state.teachers.length} 位老师 · ${state.drafts.length} 份本地草稿`
        : `${state.drafts.length} 份本地草稿 · 点击开始配置发布`;
    }
    const realRuns = window.PublishRecordModel
      ? state.runs.map(run => ({ run, record: window.PublishRecordModel.recordForRun(run, state) })).filter(x => !x.record.isRehearsal)
      : state.runs.map(run => ({ run, record: { tone: 'neutral' } }));
    const publishedCount = realRuns.filter(x => ['ok', 'success'].includes(x.record.tone)).length;
    const attentionCount = realRuns.filter(x => ['attention', 'danger', 'warn'].includes(x.record.tone)).length;
    const historySub = $('#home-history-sub');
    if (historySub) {
      historySub.textContent = realRuns.length
        ? `累计 ${realRuns.length} 条记录 · ${attentionCount} 条待关注`
        : '尚无发布记录 · 点击查看历史与回执';
    }
    const statPub = $('#stat-published');
    if (statPub) statPub.textContent = String(publishedCount);
    const statAtt = $('#stat-attention');
    if (statAtt) statAtt.textContent = String(attentionCount);

    const boundCount = state.accounts.filter(a => !!bindingOf(a)).length;
    const accountsSub = $('#home-accounts-sub');
    if (accountsSub) {
      accountsSub.replaceChildren(
        document.createTextNode(`${state.teachers.length} 位老师`),
        document.createElement('br'),
        document.createTextNode(`${boundCount} / ${state.accounts.length} 个账号已绑定`)
      );
    }

    const previewOwner = state.currentDraft.teacherId || state.teachers[0]?.id || '__default__';
    const previewTags = getCommonTags(previewOwner);
    const previewHost = $('#home-tag-preview');
    if (previewHost) {
      previewHost.replaceChildren();
      const shown = previewTags.length ? previewTags.slice(0, 2) : ['常用标签', '草稿模板'];
      shown.forEach(tag => previewHost.append(el('span', 'tile-mini-tag', previewTags.length ? `#${tag}` : tag)));
    }
    const draftHint = $('#home-draft-hint');
    if (draftHint) draftHint.textContent = `${state.drafts.length} 草稿 · ${state.templates.length} 模板`;
  }

  function renderStep1Teachers() {
    const host = $('#step1-teacher-grid');
    if (!host) return;
    host.replaceChildren();
    if (!state.teachers.length) {
      const addCard = button('', 'teacher-card', () => {
        switchView('accounts');
        teacherProfileUI?.open(null);
      });
      const copy = el('div');
      copy.append(el('b', '', '还没有老师资料'), el('small', '', '点击前往「老师与账号」添加第一位老师并绑定平台'));
      addCard.append(copy, el('span', 'check-circle', '＋'));
      host.append(addCard);
      return;
    }
    const currentId = state.currentDraft.teacherId || '';
    state.teachers.forEach(teacher => {
      const selected = teacher.id === currentId;
      const accounts = teacherAccounts(teacher.id);
      const bound = accounts.filter(a => !!bindingOf(a)).length;
      const card = button('', `teacher-card${selected ? ' selected' : ''}`, () => selectDraftTeacher(teacher.id), !bridgeAvailable || state.saving || state.starting);
      card.dataset.teacherId = teacher.id;
      const info = el('div');
      info.append(
        el('b', '', teacher.name || '未命名老师'),
        el('small', '', `已绑定 ${bound} / ${accounts.length} 个账号 · 默认 ${(teacher.defaultPlatforms || []).length} 平台`)
      );
      card.append(info, el('span', 'check-circle', selected ? '✓' : ''));
      host.append(card);
    });
  }

  function renderAssetDropBanner() {
    const video = state.currentDraft.video;
    const landscape = state.currentDraft.covers?.landscape;
    const portrait = state.currentDraft.covers?.portrait;
    const count = [video, landscape, portrait].filter(Boolean).length;
    const banner = $('#drop-banner');
    const bannerText = $('#drop-banner-text');
    if (banner && bannerText) {
      if (count > 0) {
        banner.className = 'drop-banner ready';
        const parts = [];
        if (video) parts.push('1 视频');
        if (landscape) parts.push('1 横封面');
        if (portrait) parts.push('1 竖封面');
        bannerText.textContent = `✓ 已就绪 ${count} 个文件（${parts.join(' + ')}），可继续拖入替换或进入下一步`;
      } else {
        banner.className = 'drop-banner empty';
        bannerText.textContent = '直接把素材文件夹（或视频和横竖封面）拖到这里，或点击右侧一键选择';
      }
    }
    const swapBtn = $('#btn-swap-covers');
    if (swapBtn) {
      swapBtn.hidden = !(landscape || portrait);
      swapBtn.disabled = !bridgeAvailable || !hasPublisherMethod('swapCovers');
    }
    const folderBtn = $('#btn-pick-folder');
    if (folderBtn) folderBtn.disabled = !bridgeAvailable || !hasPublisherMethod('chooseAssetFolder');
    const pickBtn = $('#btn-pick-files');
    if (pickBtn) pickBtn.disabled = !bridgeAvailable || !hasPublisherMethod('chooseAssetsBatch');
    const bv = $('#badge-video');
    if (bv) bv.textContent = video ? '主视频 · 已识别' : '主视频 · 待投递';
    const bl = $('#badge-landscape');
    if (bl) bl.textContent = landscape ? `横版封面 · ${landscape.width && landscape.height ? `${landscape.width}×${landscape.height}` : '已识别'}` : '横版封面 · 待投递';
    const bp = $('#badge-portrait');
    if (bp) bp.textContent = portrait ? `竖版封面 · ${portrait.width && portrait.height ? `${portrait.width}×${portrait.height}` : '已识别'}` : '竖版封面 · 待投递';
  }

  function handleSmartAssetResult(result) {
    if (!result) return;
    let matched = 0;
    const incomingVideo = result.video || null;
    const incomingLandscape = result.landscape || null;
    const incomingPortrait = result.portrait || null;
    if (incomingVideo) {
      const replacingVideo = state.currentDraft.video && state.currentDraft.video.id !== incomingVideo.id;
      if (replacingVideo && !incomingLandscape && !incomingPortrait) {
        state.currentDraft.covers = { landscape: null, portrait: null };
        state.currentDraft.targets.forEach(target => { target.covers = { landscape: null, portrait: null }; });
        renderAssetSlot('landscape', null);
        renderAssetSlot('portrait', null);
      }
      state.currentDraft.video = incomingVideo;
      renderAssetSlot('video', incomingVideo);
      if (!state.currentDraft.common.title.trim()) {
        const videoStem = (incomingVideo.name || '').replace(/\.[^.]+$/, '').trim();
        const looksRandomHash = /^[a-f0-9_-]{16,}$/i.test(videoStem.replace(/_raw$/i, ''));
        const folderCandidate = String(result.folderName || '').trim();
        const cleanTitle = ((looksRandomHash && folderCandidate) ? folderCandidate : (videoStem || folderCandidate)).slice(0, 300);
        if (cleanTitle) {
          state.currentDraft.common.title = cleanTitle;
          setValue('#common-title', cleanTitle);
          const counter = $('#title-count');
          if (counter) counter.textContent = `${cleanTitle.length} / 300`;
        }
      }
      matched++;
    }
    if (incomingLandscape) {
      state.currentDraft.covers.landscape = incomingLandscape;
      renderAssetSlot('landscape', incomingLandscape);
      matched++;
    }
    if (incomingPortrait) {
      state.currentDraft.covers.portrait = incomingPortrait;
      renderAssetSlot('portrait', incomingPortrait);
      matched++;
    }
    if (matched > 0) {
      setDirty();
      syncPlatformCards();
      const summaryParts = [];
      if (incomingVideo) summaryParts.push('主视频');
      if (incomingLandscape) summaryParts.push('横版封面');
      if (incomingPortrait) summaryParts.push('竖版封面');
      const warn = result.errors?.length ? `；另有 ${result.errors.length} 个文件未导入` : '';
      toast(`已自动识别并归位 ${matched} 个文件（${summaryParts.join(' + ')}）${warn}`);
    } else if (result.errors?.length) {
      toast(result.errors[0], true);
    } else {
      toast('未检测到可识别的视频或图片文件。', true);
    }
  }

  async function swapDraftCovers() {
    if (!bridgeAvailable || !hasPublisherMethod('swapCovers')) return;
    const landscapeId = state.currentDraft.covers?.landscape?.id || '';
    const portraitId = state.currentDraft.covers?.portrait?.id || '';
    if (!landscapeId && !portraitId) return;
    try {
      const swapped = await publisher.swapCovers({ landscapeId, portraitId });
      state.currentDraft.covers.landscape = swapped?.landscape || null;
      state.currentDraft.covers.portrait = swapped?.portrait || null;
      renderAssetSlot('landscape', state.currentDraft.covers.landscape);
      renderAssetSlot('portrait', state.currentDraft.covers.portrait);
      setDirty();
      syncPlatformCards();
      toast('已对调横版与竖版封面，并完成本机素材重新登记。');
    } catch (error) {
      toast(error.message || '对调封面失败，请重试。', true);
    }
  }

  function renderStep2Tags() {
    const tags = Array.isArray(state.currentDraft.common.tags) ? state.currentDraft.common.tags : [];
    const countEl = $('#picked-tag-count');
    if (countEl) countEl.textContent = `${tags.length} 个`;
    const selectedBox = $('#selected-tags-box');
    if (selectedBox) {
      selectedBox.replaceChildren();
      if (!tags.length) {
        selectedBox.append(el('span', 'sec-sub', '点下方常用标签即可快速添加，或在下方输入框批量填写'));
      } else {
        tags.forEach(tag => {
          const pill = el('span', 'tag-pill-active');
          pill.append(document.createTextNode(`#${tag}`));
          const rm = button('×', '', () => {
            state.currentDraft.common.tags = state.currentDraft.common.tags.filter(t => t !== tag);
            setValue('#common-tags', state.currentDraft.common.tags.join(', '));
            renderStep2Tags();
            setDirty();
          });
          rm.setAttribute('aria-label', `移除标签 ${tag}`);
          pill.append(rm);
          selectedBox.append(pill);
        });
      }
    }
    const ownerKey = commonTagOwnerKey();
    const ownerTeacher = teacherById(ownerKey);
    const ownerLabel = $('#tag-pool-owner');
    if (ownerLabel) ownerLabel.textContent = ownerTeacher ? `${ownerTeacher.name}常用标签` : '通用常用标签';
    const poolHost = $('#step2-tag-pool');
    if (poolHost) {
      poolHost.replaceChildren();
      const pool = getCommonTags(ownerKey);
      if (!pool.length) {
        poolHost.append(el('span', 'sec-sub', '暂无常用标签，可在下方输入并点「+ 存为常用并选中」'));
      } else {
        pool.forEach(tag => {
          const picked = tags.includes(tag);
          const chip = button(`#${tag}`, `tag-chip${picked ? ' picked' : ''}`, () => {
            const current = Array.isArray(state.currentDraft.common.tags) ? [...state.currentDraft.common.tags] : [];
            if (current.includes(tag)) state.currentDraft.common.tags = current.filter(t => t !== tag);
            else state.currentDraft.common.tags = [...current, tag];
            setValue('#common-tags', state.currentDraft.common.tags.join(', '));
            renderStep2Tags();
            setDirty();
          });
          poolHost.append(chip);
        });
      }
    }
  }

  function renderStep3PlatformRow() {
    const host = $('#platform-quick-row');
    if (!host) return;
    host.replaceChildren();
    const defaults = new Set(teacherById(state.currentDraft.teacherId)?.defaultPlatforms || []);
    const ordered = [...state.platforms].sort((a, b) => Number(defaults.has(b.id)) - Number(defaults.has(a.id)));
    ordered.forEach(platform => {
      const target = targetFor(platform.id);
      const readiness = window.PublishReadiness ? window.PublishReadiness.platformState(platform, state) : { label: '', tone: 'neutral' };
      const card = button('', `plat-card${target.enabled ? ' selected' : ''}`, () => {
        target.enabled = !target.enabled;
        setDirty();
        syncPlatformCards();
      });
      card.dataset.quickPlatform = platform.id;
      const check = el('span', 'plat-check', target.enabled ? '✓' : '');
      const icon = el('span', 'plat-icon', platform.label.slice(0, 1));
      const name = el('span', 'plat-name', platform.label);
      const status = el('span', 'plat-status');
      const dotTone = readiness.tone === 'ok' || readiness.tone === 'ready' ? '' : (readiness.tone === 'danger' || readiness.tone === 'error' ? 'danger' : 'warn');
      if (target.enabled) {
        status.append(el('i', `dot${dotTone ? ` ${dotTone}` : ''}`), document.createTextNode(readiness.label || '已勾选'));
      } else {
        status.textContent = defaults.has(platform.id) ? '老师默认 · 未勾选' : '点击勾选';
      }
      card.append(check, icon, name, status);
      host.append(card);
    });
    const grid = $('#platform-grid');
    if (grid) grid.classList.toggle('show-unselected', state.showUnselectedPlatforms);
    const toggleBtn = $('#toggle-unselected-platforms');
    if (toggleBtn) {
      const unselectedCount = state.platforms.length - activeTargets().length;
      toggleBtn.hidden = unselectedCount <= 0;
      toggleBtn.textContent = state.showUnselectedPlatforms ? '收起未勾选平台' : `展开未勾选平台（${unselectedCount}）`;
    }
  }

  function renderStep4Summary() {
    const contentHost = $('#summary-content-kv');
    const platformHost = $('#summary-platform-kv');
    if (!contentHost || !platformHost) return;
    const draft = state.currentDraft;
    const kv = (k, v) => {
      const row = el('div', 'kv-item');
      row.append(el('span', '', k), el('strong', '', v || '—'));
      return row;
    };
    contentHost.replaceChildren(
      kv('归属老师', teacherLabel(draft.teacherId)),
      kv('主视频', draft.video ? `${draft.video.name}（${byteLabel(draft.video.size)}）` : '尚未选择'),
      kv('封面准备', `${draft.covers?.landscape ? '横封面 ✓' : '横封面未选'} · ${draft.covers?.portrait ? '竖封面 ✓' : '竖封面未选'}`),
      kv('视频标题', draft.common?.title?.trim() || '未填写'),
      kv('视频简介', draft.common?.description?.trim() ? `${draft.common.description.trim().slice(0, 48)}${draft.common.description.trim().length > 48 ? '…' : ''}` : '留空'),
      kv('已选标签', draft.common?.tags?.length ? draft.common.tags.map(t => `#${t}`).join(' ') : '未添加')
    );

    const enabled = activeTargets();
    const declMap = { none: '不统一设置，各平台单独选', ai_generated: '含 AI 生成内容', personal_opinion: '个人观点或见解' };
    const readiness = window.PublishReadiness ? window.PublishReadiness.summary(state) : { blockers: [] };
    platformHost.replaceChildren(
      kv(`发布平台（${enabled.length} 个）`, enabled.length ? enabled.map(t => platformFor(t.platform).label).join('、') : '尚未勾选'),
      kv('已选账号', enabled.length ? enabled.map(t => `${platformFor(t.platform).label}：${selectedAccountLabel(t)}`).join('；') : '—'),
      kv('发布方式', scheduleLabel(draft.schedule)),
      kv('共同声明', declMap[draft.sharedDeclaration?.intent || 'none'] || '不统一设置'),
      kv('发前账号核对', readiness.blockers.length ? `${readiness.blockers.length} 项待处理，请先在第 3 步检查` : '已选平台账号结构就绪，提交前仍会逐平台核验')
    );
  }

  function renderWizardStep() {
    const step = state.wizardStep;
    $$('#stepper .step-node').forEach(btn => {
      const s = Number(btn.dataset.step);
      btn.classList.toggle('active', s === step);
      btn.classList.toggle('done', s < step);
      const numEl = $('.step-num', btn);
      if (numEl) numEl.textContent = s < step ? '✓' : String(s);
    });
    $$('#stepper .step-line').forEach(line => {
      line.classList.toggle('done', Number(line.dataset.line) < step);
    });
    for (let i = 1; i <= 4; i++) {
      const pane = $(`#pane-step-${i}`);
      if (pane) pane.hidden = step !== i;
    }
    const prevBtn = $('#btn-prev-step');
    if (prevBtn) prevBtn.hidden = step === 1;
    const nextBtn = $('#btn-next-step');
    const step4Actions = $('#step4-action-buttons');
    const nextLabels = {
      1: '下一步：文案与标签 →',
      2: '下一步：选平台与设置 →',
      3: '下一步：总览并发布 →'
    };
    if (nextBtn) {
      nextBtn.hidden = step === 4;
      if (nextLabels[step]) nextBtn.textContent = nextLabels[step];
    }
    if (step4Actions) step4Actions.hidden = step !== 4;

    if (step === 1) { renderStep1Teachers(); renderAssetDropBanner(); }
    if (step === 2) { renderStep2Tags(); renderScheduleLimits(); }
    if (step === 3) { renderStep3PlatformRow(); }
    if (step === 4) { renderStep4Summary(); }
  }

  function goToStep(nextStep) {
    const clamped = Math.max(1, Math.min(4, Number(nextStep) || 1));
    state.wizardStep = clamped;
    renderWizardStep();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderLibraryView(tab = state.libraryTab) {
    state.libraryTab = ['tags', 'drafts', 'templates'].includes(tab) ? tab : 'tags';
    $$('#library-tabs .tab-btn').forEach(btn => {
      const active = btn.dataset.lib === state.libraryTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    ['tags', 'drafts', 'templates'].forEach(name => {
      const pane = $(`#lib-pane-${name}`);
      if (pane) pane.hidden = state.libraryTab !== name;
    });

    if (state.libraryTab === 'tags') {
      const host = $('#library-tags-host');
      if (!host) return;
      host.replaceChildren();
      const owners = state.teachers.length
        ? state.teachers.map(t => ({ key: t.id, name: t.name || '未命名老师' }))
        : [{ key: '__default__', name: '通用常用标签' }];
      owners.forEach(owner => {
        const card = el('section', 'form-card');
        const head = el('div', 'sec-head');
        const title = el('h2', '', `${owner.name} · 常用标签池`);
        title.append(el('span', 'sec-sub', '发布第 2 步自动带出，点击即可加入'));
        head.append(title);
        card.append(head);

        const pool = el('div', 'tag-pool');
        const tags = getCommonTags(owner.key);
        if (!tags.length) {
          pool.append(el('span', 'sec-sub', '还没有常用标签，在下方添加第一个'));
        } else {
          tags.forEach(tag => {
            const chip = el('span', 'tag-chip');
            chip.append(document.createTextNode(`#${tag}`));
            const rm = button('×', 'tag-chip-rm', () => void removeCommonTagFor(owner.key, tag));
            rm.setAttribute('aria-label', `删除常用标签 ${tag}`);
            chip.append(rm);
            pool.append(chip);
          });
        }
        card.append(pool);

        const addRow = el('div', 'add-tag-inline');
        const input = textInput(`给 ${owner.name} 新增常用标签`, 80, '');
        const addBtn = button('+ 添加常用标签', 'button button-quiet button-sm', async () => {
          if (await addCommonTagFor(owner.key, input.value, { selectInDraft: false })) {
            input.value = '';
            toast(`已保存到「${owner.name}」常用标签池`);
          }
        });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
        addRow.append(input, addBtn);
        card.append(addRow);
        host.append(card);
      });
    } else if (state.libraryTab === 'drafts') {
      const host = $('#library-drafts-host');
      if (!host) return;
      host.replaceChildren();
      if (!state.drafts.length) {
        host.append(emptyCard('还没有本地草稿', '在发布流程中点击「保存草稿」后，随时可以从这里继续编辑。'));
        return;
      }
      state.drafts.forEach(draft => {
        const card = el('div', 'list-card');
        const info = el('div');
        const enabledCount = (draft.targets || []).filter(t => t.enabled).length;
        info.append(
          el('b', '', draft.name || draft.common?.title || '未命名草稿'),
          el('small', 'account-meta-line', `${teacherLabel(draft.teacherId)} · 已选 ${enabledCount} 个平台 · 保存于 ${formatDate(draft.updatedAt)}`)
        );
        const resume = button('继续编辑 →', 'button button-white button-sm', () => restoreDraftById(draft.id), !bridgeAvailable);
        card.append(info, resume);
        host.append(card);
      });
    } else {
      renderTemplates();
    }
  }

  function bindSmartDropAndTags() {
    const dropZone = $('#drop-zone');
    if (dropZone) {
      ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, event => {
        event.preventDefault();
        dropZone.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, event => {
        event.preventDefault();
        dropZone.classList.remove('dragover');
      }));
      dropZone.addEventListener('drop', async event => {
        if (!bridgeAvailable || !hasPublisherMethod('importAssetPaths')) {
          toast('请在桌面版中拖入本地视频和封面文件。', true);
          return;
        }
        const files = [...(event.dataTransfer?.files || [])];
        const paths = files.map(file => (hasPublisherMethod('getPathForFile') ? publisher.getPathForFile(file) : file.path || '')).filter(Boolean);
        if (!paths.length) {
          toast('未能读取拖入文件的本地路径，请点击「一次选择多个文件」。', true);
          return;
        }
        try {
          handleSmartAssetResult(await publisher.importAssetPaths(paths));
        } catch (error) {
          toast(error.message || '导入拖入素材失败。', true);
        }
      });
    }
    const folderBtn = $('#btn-pick-folder');
    if (folderBtn) {
      folderBtn.addEventListener('click', async () => {
        if (!bridgeAvailable || !hasPublisherMethod('chooseAssetFolder')) return;
        try {
          handleSmartAssetResult(await publisher.chooseAssetFolder());
        } catch (error) {
          toast(error.message || '扫描素材文件夹失败。', true);
        }
      });
    }
    const pickBtn = $('#btn-pick-files');
    if (pickBtn) {
      pickBtn.addEventListener('click', async () => {
        if (!bridgeAvailable || !hasPublisherMethod('chooseAssetsBatch')) return;
        try {
          handleSmartAssetResult(await publisher.chooseAssetsBatch());
        } catch (error) {
          toast(error.message || '选择素材失败。', true);
        }
      });
    }
    const swapBtn = $('#btn-swap-covers');
    if (swapBtn) swapBtn.addEventListener('click', () => void swapDraftCovers());

    const addTagBtn = $('#btn-add-common-tag');
    const newTagInput = $('#input-new-tag');
    if (addTagBtn && newTagInput) {
      const submitTag = async () => {
        const added = await addCommonTagFor(commonTagOwnerKey(), newTagInput.value, { selectInDraft: true });
        if (added) {
          newTagInput.value = '';
          toast('已加入常用标签并选中');
        }
      };
      addTagBtn.addEventListener('click', () => void submitTag());
      newTagInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void submitTag(); }
      });
    }
    const toggleUnselected = $('#toggle-unselected-platforms');
    if (toggleUnselected) {
      toggleUnselected.addEventListener('click', () => {
        state.showUnselectedPlatforms = !state.showUnselectedPlatforms;
        renderStep3PlatformRow();
      });
    }
  }

  function switchView(name) {
    const viewName = ['home', 'new', 'history', 'accounts', 'library'].includes(name) ? name : 'home';
    state.currentView = viewName;
    $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${viewName}`));
    const backBtn = $('#back-home-btn');
    if (backBtn) backBtn.hidden = viewName === 'home';
    const crumb = $('#crumb-current');
    if (crumb) {
      crumb.textContent = ({ home: '主界面', new: '开始新发布', history: '发布记录', accounts: '老师与账号', library: '常用标签与模板' })[viewName];
    }
    const bar = $('#action-bar');
    if (bar) bar.hidden = viewName !== 'new';
    if (viewName === 'home') renderHome();
    if (viewName === 'new') renderWizardStep();
    if (viewName === 'history') renderRuns();
    if (viewName === 'accounts') renderAccounts();
    if (viewName === 'library') renderLibraryView(state.libraryTab);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function refreshBootstrap({ preserveDraft = true } = {}) {
    const data = await invoke('bootstrap');
    state.bootstrapped = true;
    state.platforms = Array.isArray(data.platforms) && data.platforms.length ? data.platforms : platformDefaults;
    state.teachers = Array.isArray(data.teachers) ? data.teachers.filter(teacher => teacher && typeof teacher.id === 'string' && teacher.id) : [];
    state.environments = Array.isArray(data.environments) ? data.environments.filter(environment => environment && typeof environment === 'object') : [];
    state.deviceId = typeof data.deviceId === 'string' ? data.deviceId : '';
    state.browserSessions = data.browserSessions && typeof data.browserSessions === 'object' ? data.browserSessions : {};
    state.browserAvailability = Array.isArray(data.browserAvailability) ? data.browserAvailability : [];
    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    state.drafts = Array.isArray(data.drafts) ? data.drafts : [];
    state.runs = Array.isArray(data.runs) ? data.runs : [];
    state.accountPairs = data.accountPairs === undefined ? state.accountPairs : normalizePairCollection(data.accountPairs);
    state.accountChecks = data.accountChecks && typeof data.accountChecks === 'object' ? { ...data.accountChecks } : state.accountChecks;
    if (data.connections && typeof data.connections === 'object') state.connections = { ...state.connections, ...data.connections };
    if (data.liveSessions && typeof data.liveSessions === 'object') {
      const sessions = {};
      Object.entries(data.liveSessions).forEach(([runId, session]) => {
        if (!session || typeof session !== 'object') return;
        sessions[runId] = { ...session, runId: session.runId || runId };
      });
      state.liveSessions = sessions;
    }
    if (typeof data.chromeConnectorPath === 'string' && data.chromeConnectorPath.trim()) state.chromeConnectorPath = data.chromeConnectorPath;
    state.engine = data.engine || state.engine;
    if (!preserveDraft) {
      state.currentDraft = newDraft();
      state.currentDraft.targets ||= platformDefaults.map(p => newTarget(p.id));
      state.currentDraft.covers ||= { landscape: null, portrait: null };
      state.currentDraft.common ||= { title: '', description: '', tags: [] };
      state.dirty = false;
    } else if (reconcileDraftAfterBootstrap()) {
      state.dirty = true;
    }
    renderAccounts(); renderTemplates(); renderDraftPicker(); renderRuns();
    if (preserveDraft) renderPlatformCards();
    else syncDraftForm();
    renderRealPanel();
    renderHome();
    if (state.currentView === 'new') renderWizardStep();
    if (state.currentView === 'library') renderLibraryView(state.libraryTab);
    updateOverview();
  }

  async function createNewDraft(teacherId) {
    if (!bridgeAvailable || state.saving || state.starting || state.realStarting) return;
    state.saving = true; updateOverview();
    try {
      const current = state.currentDraft;
      const nextTeacherId = teacherById(teacherId) ? teacherId : '';
      if (draftHasContent(current)) {
        const saved = await invoke('saveDraft', { ...copyDraft(current), name: currentDraftName() });
        state.drafts = [saved, ...state.drafts.filter(draft => draft.id !== saved.id)];
      }
      state.currentDraft = newDraft(); state.currentDraft.teacherId = nextTeacherId;
      applyTeacherDefaults(); state.dirty = false; state.wizardStep = 1;
      closeReview(); renderAccounts(); renderTemplates(); renderDraftPicker(); syncDraftForm(); switchView('new');
      toast(nextTeacherId
        ? `已为“${teacherLabel(nextTeacherId)}”新建任务并带入默认平台，本次可以增减。上一条已保留为本地草稿。`
        : '已新建任务；上一条已保留为本地草稿。');
    } catch (error) { toast(`未能保存上一条任务，暂不清空：${error.message}`, true); }
    finally { state.saving = false; updateOverview(); }
  }

  function bindNavigation() {
    $('#brand-home')?.addEventListener('click', () => switchView('home'));
    $('#back-home-btn')?.addEventListener('click', () => switchView('home'));
    $('#tile-publish')?.addEventListener('click', () => { state.wizardStep = 1; switchView('new'); });
    $('#tile-history')?.addEventListener('click', () => switchView('history'));
    $('#tile-accounts')?.addEventListener('click', () => switchView('accounts'));
    $('#tile-library')?.addEventListener('click', () => switchView('library'));
    $$('#stepper .step-node').forEach(btn => btn.addEventListener('click', () => goToStep(Number(btn.dataset.step))));
    $('#btn-prev-step')?.addEventListener('click', () => goToStep(state.wizardStep - 1));
    $('#btn-next-step')?.addEventListener('click', () => goToStep(state.wizardStep + 1));
    $$('#library-tabs .tab-btn').forEach(btn => btn.addEventListener('click', () => renderLibraryView(btn.dataset.lib)));
    $('#check-account-readiness').addEventListener('click', checkSelectedReadiness);
    $('#save-draft').addEventListener('click', saveCurrentDraft);
    $('#save-draft-top').addEventListener('click', saveCurrentDraft);
    $('#new-draft').addEventListener('click', () => createNewDraft(state.currentDraft.teacherId));
    $('#review-button').addEventListener('click', reviewCurrentDraft);
    $('#douyin-real-test').addEventListener('click', openRealReview);
    $('#close-review').addEventListener('click', closeReview);
    $('#back-to-edit').addEventListener('click', closeReview);
    $('#confirm-rehearsal').addEventListener('click', confirmRehearsal);
    $('#review-modal').addEventListener('click', event => { if (event.target === $('#review-modal')) closeReview(); });
    $('#close-real-review').addEventListener('click', closeRealReview);
    $('#cancel-real-start').addEventListener('click', closeRealReview);
    $('#confirm-real-start').addEventListener('click', confirmRealStart);
    $('#real-review-modal').addEventListener('click', event => { if (event.target === $('#real-review-modal')) closeRealReview(); });
    $('#real-panel-history').addEventListener('click', () => switchView('history'));
    $('#real-panel-confirm').addEventListener('click', () => { const run = realPanelRun(); if (run) openPublishConfirm(run.id); });
    $('#real-panel-stop').addEventListener('click', () => { const run = realPanelRun(); if (run) openStopConfirm(run.id); });
    $('#close-publish-confirm').addEventListener('click', closePublishConfirm);
    $('#cancel-publish-confirm').addEventListener('click', closePublishConfirm);
    $('#confirm-publish').addEventListener('click', confirmPublish);
    $('#publish-confirm-modal').addEventListener('click', event => { if (event.target === $('#publish-confirm-modal')) closePublishConfirm(); });
    $('#close-stop-confirm').addEventListener('click', closeStopConfirm);
    $('#cancel-stop').addEventListener('click', closeStopConfirm);
    $('#confirm-stop').addEventListener('click', confirmStop);
    $('#stop-confirm-modal').addEventListener('click', event => { if (event.target === $('#stop-confirm-modal')) closeStopConfirm(); });
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='s' && state.currentView==='new') {
        event.preventDefault();void saveCurrentDraft();return;
      }
      if (event.key !== 'Escape') return;
      if (!$('#unbind-modal').hidden) closeUnbindConfirm();
      else if (!$('#stop-confirm-modal').hidden) closeStopConfirm();
      else if (!$('#publish-confirm-modal').hidden) closePublishConfirm();
      else if (!$('#real-review-modal').hidden) closeRealReview();
      else if (!$('#review-modal').hidden) closeReview();
    });
  }

  async function boot() {
    await loadCommonTags();
    window.PreparationTestUI?.create({publisher,getDraft:()=>structuredClone(state.currentDraft),toast});
    managedPilotUI = window.ManagedPilotUI.create({getData:()=>state,publisher,saveTask:async()=>{
      const saved=await saveCurrentDraft();if(!saved)throw new Error('当前任务尚未保存成功，请稍后重试。');
      if(state.dirty)throw new Error('保存期间内容又有变化，请再次核对最新任务。');return structuredClone(state.currentDraft);
    },onRun:run=>{mergeRun(run);switchView('history');},toast});
    publishHistoryUI=window.PublishHistoryUI.create({getData:()=>state,publisher,onRun:mergeRun,toast,onApprove:run=>managedPilotUI.confirmExisting(run)});
    teacherProfileUI = window.TeacherProfileUI.create({
      getData: () => ({ ...state, loaded: state.bootstrapped, canSave: teacherApiAvailable }),
      saveProfile: async input => {
        const result = await invokeTeacher('saveTeacherProfile', input);
        mergeTeacherRecord(result.teacher); (result.accounts || []).forEach(mergeAccountRecord);
        await refreshBootstrap({ preserveDraft: true }); return result;
      },
      renderAccount: renderAccountRow,
      renderLegacyAccount: account => renderAccountRow(account, 'unassigned'),
      onNewTask: teacherId => createNewDraft(teacherId),
      onFormState: value => publisher?.reportTeacherForm?.(value).catch(() => {}), toast
    });
    bindNavigation(); bindCommonFields(); syncDraftForm(); renderAccounts(); renderTemplates(); renderRuns(); renderRealPanel(); switchView('home');
    window.addEventListener('focus', () => { void refreshAccountIndicators(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshAccountIndicators(); });
    setInterval(() => { if (state.currentView === 'new') void refreshAccountIndicators(); }, 30000);
    if (!bridgeAvailable) {
      $('#preview-banner').hidden = false;
      $('#draft-picker').disabled = true; $('#restore-draft').disabled = true;
      updateOverview(); return;
    }
    try {
      await refreshBootstrap({ preserveDraft: false });
      state.unsubscribe = publisher.onUpdate(event => {
        if (event?.type === 'run' && event.run) mergeRun(event.run);
        else if (event?.type === 'live_session' && event.session) mergeLiveSession(event.session);
        else if (event?.type === 'account_pair' && event.pair) mergeAccountPair(event.pair);
        else if (event?.type === 'connection' && event.connection) mergeConnection(event.connection);
        else if (event?.type === 'data') refreshBootstrap({ preserveDraft: true }).catch(error => toast(error.message, true));
      });
    } catch (error) {
      $('#preview-banner').hidden = false;
      $('#preview-banner strong').textContent = '本机桥接暂不可用';
      $('#preview-banner p').textContent = `界面仍可预览；本地文件选择与保存不可用。${error.message}`;
      state.engine.reason = '桌面桥接初始化失败；当前只显示预览界面。';
      $('#real-task-panel').hidden = true;
      updateOverview();
    }
  }

  boot();
})();
