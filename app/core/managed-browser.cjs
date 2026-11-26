'use strict';

const model = require('./accounts.cjs');
const fs = require('node:fs'), path = require('node:path');
const { BROWSER_PLATFORMS, observationFromPage, isIdentityPage } = require('./browser-platforms.cjs');
const { launchBrowser, browserAvailability } = require('./browser-driver.cjs');
const { browserFailure } = require('./browser-errors.cjs');
const { createFocusCoordinator } = require('./focus-coordinator.cjs');

function freshServerObservation(observation) {
  const at = observation.serverCheckedAt;
  return at === undefined || (Number.isFinite(at) && at > 0 && Date.now() - at < 30_000 && at <= Date.now() + 5000);
}

class ManagedBrowsers {
  constructor({ store, profilesRoot, launch = launchBrowser, availability = browserAvailability,
    onUpdate = () => {}, pollMs = 2000, candidateMs = 300_000, checkingMs = 90_000, diagnosticsRoot, focusCoordinator }) {
    this.store = store; this.profilesRoot = profilesRoot; this.launch = launch;
    this.availability = availability; this.onUpdate = onUpdate;
    this.pollMs = pollMs; this.candidateMs = candidateMs; this.checkingMs = checkingMs;
    this.diagnosticsRoot = diagnosticsRoot;
    this.focusCoordinator = focusCoordinator || createFocusCoordinator();
    this.sessions = new Map(); this.opening = new Map(); this.inspections = new Map(); this.checks = new Map(); this.stopping = false;
  }
  account(id) {
    const a = this.store.load().accounts.find(a => a.id === id);
    if (!a || !a.teacherId || !Object.hasOwn(BROWSER_PLATFORMS, a.platform)) throw new Error('请先为老师登记支持连接的平台账号。');
    return a;
  }
  view(s) {
    return { accountId: s.accountId, source: 'managed_browser', environmentId: s.environmentId,
      platform: s.platform, browserKind: s.browserKind, checkedAt: s.verifiedAt ? new Date(s.verifiedAt).toISOString() : null, state: s.state, message: s.message, autoBind: s.autoBind === true,
      windowOpen: !!s.driver?.isOpen() && !s.closed,
      ...(s.state === 'awaiting_confirmation' && s.candidate ? { candidate: { ...s.candidate }, expiresAt: s.expiresAt } : {}) };
  }
  emit(s) {
    try { this.onUpdate({ type: 'data' }); } catch {}
    return this.view(s);
  }
  set(s, state, message) {
    if (['bound','verified','mismatch','unverifiable','error','canceled','closed','awaiting_confirmation'].includes(state)) this.stopWatch(s);
    const changed = s.state !== state || s.message !== message;
    s.state = state; s.message = message;
    return changed ? this.emit(s) : this.view(s);
  }
  stopWatch(s) { clearInterval(s.timer); s.timer = null; }
  recordPage(s, snapshot) {
    if (!this.diagnosticsRoot) return;
    try {
      const url = new URL(snapshot.url), observation = observationFromPage(snapshot, s.platform);
      const config = BROWSER_PLATFORMS[s.platform];
      const knownPaths = [...config.identityPaths, new URL(config.entry).pathname];
      const record = { platform: s.platform, origin: url.origin, path: url.href==='about:blank' ? 'about:blank' : knownPaths.includes(url.pathname.replace(/\/$/,'')) ? url.pathname : '[other_path]',
        blankPage: url.href === 'about:blank', identityPage: isIdentityPage(url.href, s.platform),
        state: observation.state, loginVisible: snapshot.loginVisible === true,
        labeledIdentityCount: [...String(snapshot.text || '').matchAll(new RegExp(BROWSER_PLATFORMS[s.platform].idPattern))].length,
        ...(snapshot.selfIdentityEvidence ? { selfIdentityEvidence: {
          requestSeen:snapshot.selfIdentityEvidence.requestSeen===true,
          requestFailed:snapshot.selfIdentityEvidence.requestFailed===true,
          httpStatus:Number.isInteger(snapshot.selfIdentityEvidence.httpStatus)?snapshot.selfIdentityEvidence.httpStatus:null,
          success:snapshot.selfIdentityEvidence.success===true,
          dataFields:Array.isArray(snapshot.selfIdentityEvidence.dataFields)?snapshot.selfIdentityEvidence.dataFields.filter(k=>/^[A-Za-z_]{1,40}$/.test(k)).slice(0,40):[],
          hasUserId:snapshot.selfIdentityEvidence.hasUserId===true,userIdFormatValid:snapshot.selfIdentityEvidence.userIdFormatValid===true } } : {}),
        navigationFailed: snapshot.navigationFailed === true,
        errorCode: /^(?:net::)?ERR_[A-Z_]+$/.test(snapshot.failure?.errorCode || snapshot.errorCode || '') ? (snapshot.failure?.errorCode || snapshot.errorCode) : '',
        ...(snapshot.failure ? { failure: browserFailure({connectionStage:snapshot.failure.operation,httpStatus:snapshot.failure.httpStatus,
          name:snapshot.failure.category==='timeout'?'TimeoutError':'Error',message:snapshot.failure.errorCode || (snapshot.failure.category==='window_closed'?'closed':'')},snapshot.failure.operation) } : {}) };
      const signature = JSON.stringify(record);
      if (s.diagnosticSignature === signature && Date.now() - (s.diagnosticAt || 0) < 30000) return;
      fs.mkdirSync(this.diagnosticsRoot, {recursive:true,mode:0o700});
      fs.writeFileSync(path.join(this.diagnosticsRoot, s.environmentId + '.json'), JSON.stringify({at:new Date().toISOString(),...record},null,2), {mode:0o600});
      s.diagnosticSignature=signature;s.diagnosticAt=Date.now();
    } catch { /* Diagnostics must not change login or binding decisions. */ }
  }
  recordOperation(s, error) {
    if (!this.diagnosticsRoot) return;
    try {
      const file = path.join(this.diagnosticsRoot, s.environmentId + '.json');
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : { platform:s.platform };
      fs.mkdirSync(this.diagnosticsRoot,{recursive:true,mode:0o700});
      fs.writeFileSync(file,JSON.stringify({...previous,at:new Date().toISOString(),connectionOutcome:error?'failed':'connected',
        failure:error?browserFailure(error):null},null,2),{mode:0o600});
    } catch { /* Diagnostic failures must not modify connection decisions. */ }
  }
  current(s) {
    if (this.stopping || s.closed || this.sessions.get(s.accountId) !== s) return false;
    const a = this.account(s.accountId);
    return a.teacherId === s.teacherId && a.platform === s.platform && a.browserEnvironmentId === s.environmentId
      && (a.binding?.revision || null) === s.revision
      && (!a.binding || a.binding.source === 'managed_browser');
  }
  snapshot() {
    return {
      browserAvailability: this.availability(),
      browserSessions: Object.fromEntries([...this.sessions].map(([id, s]) => [id, this.view(s)])),
      browserChecks: Object.fromEntries(this.checks)
    };
  }
  isOnline(environmentId) {
    return [...this.sessions.values()].some(s => s.environmentId === environmentId && s.driver?.isOpen() && !s.closed
      && ['bound', 'verified'].includes(s.state) && Date.now() - (s.verifiedAt || 0) < 330_000);
  }
  open(input) {
    const id = input?.accountId;
    if (this.stopping) return Promise.reject(new Error('工作台正在退出，请稍后重新打开。'));
    if (this.opening.has(id)) return this.opening.get(id);
    if (this.inspections.has(id) && this.sessions.get(id)?.driver?.isOpen()) return this.inspections.get(id).then(() => this.view(this.sessions.get(id)));
    const work = this.openOnce(input).finally(() => this.opening.delete(id));
    this.opening.set(id, work);
    return work;
  }
  async openOnce(input) {
    if (input?.autoBind !== undefined && typeof input.autoBind !== 'boolean') throw new Error('自动连接参数无效。');
    const a = this.account(input?.accountId);
    const assigned = this.store.load().environments.find(e => e.id === a.browserEnvironmentId);
    const kind = input.browserKind || assigned?.browserKind || 'chrome';
    if (!this.availability().some(b => b.id === kind && b.available)) throw new Error('未检测到所选浏览器，未创建或更改绑定。');
    const env = model.assignBrowserEnvironment(this.store, a.id, kind);
    const old = this.sessions.get(a.id);
    if (old?.driver?.isOpen() && !old.closed) {
      if (!this.current(old)) throw new Error('老师或绑定已变更，请先关闭原专属浏览器。');
      const beforeFocus = old.generation;
      await old.driver.focus();
      if (!this.current(old) || beforeFocus !== old.generation) return this.view(old);
      old.generation++; old.candidate = null; old.startedAt = Date.now(); old.autoBind = input.autoBind === true;
      const generation = old.generation;
      this.set(old, 'checking', '正在核对原专属浏览器中的账号。');
      if (old.reading) await old.reading;
      if (!this.current(old) || generation !== old.generation || old.state === 'canceled') return this.view(old);
      this.watch(old); await this.poll(old, { fresh: true });
      return this.view(old);
    }
    if (old?.driver) {
      // 防御 macOS 关窗后残留无窗口浏览器进程占锁：重开前确保旧 driver 的进程已退出。
      await old.driver.close().catch(() => {});
    }
    const s = { accountId: a.id, platform: a.platform, teacherId: a.teacherId, environmentId: env.id, browserKind: kind,
      revision: a.binding?.revision || null, state: 'opening', message: '正在打开老师专属浏览器。',
      startedAt: Date.now(), closed: false, generation: 0, candidate: null, driver: null, autoBind: input.autoBind === true };
    this.sessions.set(a.id, s); this.emit(s);
    try {
      s.driver = await this.launch({ environment: env, platform: a.platform, profilesRoot: this.profilesRoot, preferHome: !!a.binding, onClosed: () => this.didClose(s), onReadPage: snapshot => this.recordPage(s, snapshot) });
      if (!this.current(s)) { await s.driver.close(); throw new Error('打开过程中老师归属或绑定已改变，本次已停止。'); }
      if (s.state === 'canceled') return this.view(s);
      this.set(s, 'checking', '正在等待官方页面的账号标识。');
      this.watch(s); await this.poll(s);
      return this.view(s);
    } catch (error) {
      this.stopWatch(s); s.candidate = null;
      if (s.driver?.isOpen()) await s.driver.close().catch(() => {});
      if (!s.closed) this.set(s, 'error', '浏览器未能完成启动。请检查浏览器安装、网络或是否已被其他工作台占用，再重试。');
      throw new Error(s.closed ? '专属浏览器已关闭，本次连接未完成。' : s.message);
    }
  }
  watch(s) {
    this.stopWatch(s);
    if (!['opening','checking','awaiting_login','login_required'].includes(s.state) || s.closed || this.stopping) return;
    // 自动等待登录只能读已有页面，不能刷新二维码或新开校验页。
    s.timer = setInterval(() => { this.poll(s, { passive: true }).catch(() => {}); }, this.pollMs);
    s.timer.unref();
  }
  poll(s, options = {}) {
    if (s.reading) return s.reading;
    if (s.confirming || s.state === 'canceled' || s.closed) return Promise.resolve(this.view(s));
    s.reading = this.observe(s, options).finally(() => { s.reading = null; });
    return s.reading;
  }
  async observe(s, options = {}) {
    const generation = s.generation;
    try {
      if (!this.current(s)) { this.stopWatch(s); s.candidate = null; return this.set(s, 'error', '老师归属或绑定已变更，请关闭原窗口后重新连接。'); }
      if (options.passive && Date.now() - s.startedAt > (['awaiting_login','login_required'].includes(s.state) ? this.candidateMs : this.checkingMs)) {
        const message = '本次自动检查已停止，原绑定和登录窗口保留；登录完成后可手动检查一次。';
        s.verifiedAt = 0; s.candidate = null;
        this.checks.set(s.accountId, { accountId:s.accountId, state:'unverifiable', message });
        return this.set(s, 'unverifiable', message);
      }
      const observation = await s.driver.read(options);
      if (!this.current(s) || generation !== s.generation) return this.view(s);
      if (observation.state === 'error') {
        this.stopWatch(s); s.candidate = null; s.verifiedAt = 0;
        this.checks.set(s.accountId, { accountId: s.accountId, state: 'unverifiable', message: observation.message });
        return this.set(s, 'error', observation.message);
      }
      if (options.fresh && observation.state === 'identified' && !freshServerObservation(observation)) {
        s.candidate = null; s.verifiedAt = 0;
        const message = '未取得本次有效的平台回读，不能沿用旧账号结果。';
        this.checks.set(s.accountId, { accountId: s.accountId, state: 'unverifiable', message });
        return this.set(s, 'unverifiable', message);
      }
      const actual = observation.state === 'identified' ? observation.identity : null;
      if (!actual || !/^[A-Za-z0-9_.-]{3,64}$/.test(actual.platformAccountId || '')) {
        s.candidate = null; s.verifiedAt = 0;
        const bound = !!this.account(s.accountId).binding;
        if (bound && observation.state === 'awaiting_login') {
          const message = '平台已退回登录页，请在原专属浏览器重新登录；绑定和环境保留，登录后会核对是否仍为原账号。';
          this.checks.set(s.accountId, { accountId: s.accountId, state: 'login_required', message });
          return this.set(s, 'login_required', message);
        }
        const timedOut = Date.now() - s.startedAt > this.checkingMs && observation.state !== 'awaiting_login';
        if (timedOut || observation.state === 'unverifiable') this.stopWatch(s);
        const state = timedOut || observation.state === 'unverifiable' ? 'unverifiable' : observation.state === 'awaiting_login' ? 'awaiting_login' : 'checking';
        // 页面仍在加载或等待登录时，上一次“核对一致”同样不能沿用；但这只是
        // “正在检查”，不是“检查已停止”。pending 让界面不把它当成失败提醒。
        if (this.account(s.accountId).binding) this.checks.set(s.accountId, state === 'unverifiable'
          ? { accountId: s.accountId, state: 'unverifiable', message: '当前页面没有唯一账号标识，不能沿用上一次身份检查。' }
          : { accountId: s.accountId, state: 'unverifiable', pending: true, message: '正在读取当前登录身份，尚未得出结论。' });
        return this.set(s, state, timedOut ? '页面尚未显示唯一账号标识，请检查登录状态后重试。' : observation.message);
      }
      const a = this.account(s.accountId);
      if (a.binding) {
        let state = 'verified', message = '专属浏览器中的真实账号与绑定一致；当前不上传或发布。';
        try { model.assertBrowserIdentity(this.store, { accountId: a.id, environmentId: s.environmentId, platformAccountId: actual.platformAccountId }); }
        catch (error) {
          // 只有平台账号号确实不同才叫“账号不一致”。老师归属、设备、环境被
          // 占用或数据格式等其他原因同样阻止操作，但要如实说明，免得用户反复扫码。
          const reason = String(error?.message || '').slice(0, 200);
          if (/真实账号不一致/.test(reason)) { state = 'mismatch'; message = '当前真实账号与绑定不一致，已停止此账号操作。'; }
          else { state = 'unverifiable'; message = `登录账号已读到，但绑定信息需要处理，已停止此账号操作：${reason || '原因未知'}`; }
          this.stopWatch(s);
        }
        this.checks.set(a.id, { accountId: a.id, state, message, checkedAt: new Date().toISOString(), platformAccountId: actual.platformAccountId });
        s.candidate = null; s.verifiedAt = state === 'verified' ? (observation.serverCheckedAt || Date.now()) : 0;
        return this.set(s, state, message);
      }
      if (s.candidate && s.candidate.platformAccountId !== actual.platformAccountId) {
        s.candidate = null; this.stopWatch(s);
        return this.set(s, 'mismatch', '候选账号已经变化，请取消本次绑定后重新核对。');
      }
      if (!s.candidate) { s.candidate = { platformAccountId: actual.platformAccountId, displayName: String(actual.displayName || '').slice(0, 120) }; s.expiresAt = new Date(Date.now() + this.candidateMs).toISOString(); }
      if (Date.now() >= Date.parse(s.expiresAt)) { s.candidate = null; this.stopWatch(s); return this.set(s, 'error', '候选账号确认已过期，请重新打开并识别。'); }
      if (s.autoBind) {
        // The user already chose the teacher/platform and explicitly requested
        // connection. Complete that request after a second fresh identity read.
        // Never invoke confirm() here: it would await this very poll promise.
        s.confirming = true;
        try {
          this.set(s, 'checking', '已识别登录账号，正在复核并保存连接。');
          await this.bindCandidate(s, { ...s.candidate });
          return this.view(s);
        } finally { s.confirming = false; }
      }
      return this.set(s, 'awaiting_confirmation', '程序已识别候选账号，请在工作台确认老师归属。');
    } catch (error) {
      if (generation !== s.generation || s.closed) return this.view(s);
      s.candidate = null; s.verifiedAt = 0; this.stopWatch(s);
      this.recordOperation(s,error);
      const failure = browserFailure(error);
      const message = error.connectionUserMessage || failure.message;
      this.checks.set(s.accountId, { accountId: s.accountId, state: 'unverifiable', message });
      return this.set(s, 'unverifiable', message);
    }
  }
  async bindCandidate(s, candidate) {
    const generation = s.generation;
    const observation = await s.driver.read({ fresh: true });
    if (!this.current(s) || generation !== s.generation) throw new Error('确认时真实账号或归属已变化，未保存绑定。');
    if (!s.candidate || !s.driver.isOpen()
      || Date.now() >= Date.parse(s.expiresAt) || !freshServerObservation(observation) || observation.state !== 'identified'
      || observation.identity?.platformAccountId !== candidate.platformAccountId) {
      s.candidate = null; this.stopWatch(s);
      const error = new Error('确认时真实账号或归属已变化，未保存绑定。');
      error.connectionUserMessage = observation.state === 'awaiting_login'
        ? '账号复核时官方页面回到了登录页，请在原窗口登录后继续连接。'
        : '两次账号回读不一致或未完成，未保存绑定。原登录保留，请继续连接。';
      this.set(s, 'mismatch', error.connectionUserMessage);
      throw error;
    }
    let account;
    try { account = model.bindBrowserAccount(this.store, { accountId: s.accountId, environmentId: s.environmentId, ...candidate }); }
    catch (error) {
      error.connectionStage = 'save_binding';
      if (/真实账号已绑定其他老师/.test(error.message)) error.connectionUserMessage = '这个平台账号已经连接到其他老师或账号记录，请检查老师归属；本次没有覆盖原连接。';
      throw error;
    }
    s.revision = account.binding.revision; s.candidate = null; s.verifiedAt = observation.serverCheckedAt || Date.now();
    this.checks.set(s.accountId, { accountId: s.accountId, state: 'verified', platformAccountId: candidate.platformAccountId, checkedAt: new Date().toISOString(), message: '登录账号已复核并保存，可继续填写发布内容。' });
    this.set(s, 'bound', '账号已连接并保存，可继续发布；正式提交前会再次核对账号。');
    this.recordOperation(s);
    return account;
  }
  async confirm(id) {
    const s = this.sessions.get(id);
    if (!s || s.confirming || s.state !== 'awaiting_confirmation' || !s.candidate
      || Date.now() >= Date.parse(s.expiresAt) || !s.driver?.isOpen() || !this.current(s)) throw new Error('没有有效的候选账号，请重新识别。');
    s.confirming = true;
    const candidate = { ...s.candidate };
    const generation = s.generation;
    try {
      if (s.reading) await s.reading;
      return await this.bindCandidate(s, candidate);
    } catch (error) {
      if (generation === s.generation && this.current(s)) {
        s.candidate = null; s.verifiedAt = 0; this.stopWatch(s);
        this.recordOperation(s,error);
        const message = error.connectionUserMessage || browserFailure(error,'confirm_identity').message;
        this.checks.set(id, { accountId: id, state: 'unverifiable', message });
        this.set(s, 'unverifiable', message);
      }
      throw error;
    } finally { s.confirming = false; }
  }
  inspect(id) {
    if (this.inspections.has(id)) return this.inspections.get(id);
    const work = this.inspectOnce(id).finally(() => this.inspections.delete(id));
    this.inspections.set(id, work);
    return work;
  }
  async inspectOnce(id) {
    if (this.opening.has(id)) {
      const session = this.sessions.get(id);
      await this.opening.get(id);
      if (session && (!this.current(session) || session.state==='canceled')) return {accountId:id,state:'unverifiable',message:'本次检查已停止，原绑定和登录保留。'};
      const checked = this.checks.get(id);
      if (checked) return checked;
    }
    const a = this.account(id);
    if (a.binding?.source !== 'managed_browser') throw new Error('此账号未绑定工作台专属浏览器。');
    const s = this.sessions.get(id);
    if (!s || !s.driver?.isOpen() || s.closed) {
      const result = { accountId: id, state: 'offline', message: '请先打开该老师的专属浏览器，再核对身份。' };
      this.checks.set(id, result); this.onUpdate({ type: 'data' }); return result;
    }
    const generation = s.generation;
    if (s.reading) await s.reading;
    if (!this.current(s) || generation !== s.generation) return {accountId:id,state:'unverifiable',message:'本次检查已停止，原绑定和登录保留。'};
    s.startedAt = Date.now();
    this.set(s, 'checking', '正在核对当前登录账号；本次检查结束后停止，不会循环打开页面。');
    this.watch(s);
    await this.poll(s, { fresh: true });
    this.emit(s);
    return this.checks.get(id) || { accountId: id, state: 'unverifiable', message: s.message };
  }
  async checkReady(input) {
    if (!input || !Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 8
      || input.accountIds.some(id => typeof id !== 'string' || !id || id.length > 200)
      || (input.openMissing !== undefined && typeof input.openMissing !== 'boolean')
      || Object.keys(input).some(key => !['accountIds', 'openMissing'].includes(key))) throw new Error('请明确选择不超过8个需要检查的账号。');
    const results = [];
    for (const accountId of new Set(input.accountIds)) {
      const account = this.store.load().accounts.find(a => a.id === accountId);
      if (!account?.binding) { results.push({ accountId, state: 'unbound', message: '尚未绑定真实账号。' }); continue; }
      if (!Object.hasOwn(BROWSER_PLATFORMS, account.platform) || account.binding.source !== 'managed_browser') { results.push({ accountId, state: 'unsupported', message: '此连接方式尚未接入提前检查。' }); continue; }
      try {
        if (input.openMissing && !this.sessions.get(accountId)?.driver?.isOpen()) {
          const opened = await this.open({ accountId });
          // open已核对这个刚取得的文档，不再紧接着发第二次fresh导航。
          results.push(this.checks.get(accountId) || { accountId, state:'unverifiable', message:opened.message });
        } else results.push(await this.inspect(accountId));
      } catch { results.push({ accountId, state: 'unverifiable', message: '本次提前检查未完成，不能视为可发布。' }); }
    }
    return { checkedAt: new Date().toISOString(), ready: results.every(r => r.state === 'verified' && !r.pending), results };
  }
  async publisherFor(job, { diagnosticsRoot, onVerifyFiles, allowSubmit=true }) {
    const original = this.account(job.accountId);
    if (!Object.hasOwn(BROWSER_PLATFORMS,original.platform) || original.binding?.source !== 'managed_browser') throw new Error('请先完成所选平台账号的真实身份绑定。');
    let openedFreshly = false;
    if (!this.sessions.get(original.id)?.driver?.isOpen()) {
      await this.open({accountId:original.id});
      openedFreshly = true;
    }
    const verifyIdentity = async () => {
      const current = this.account(original.id);
      const expected = job.expectedBinding;
      if (current.teacherId !== job.teacherId || current.binding?.revision !== expected.revision
        || current.binding?.environmentId !== expected.environmentId || current.binding?.platformAccountId !== expected.platformAccountId) throw new Error('老师或账号绑定已变化，已阻止真实操作。');
      const waitBudget = Math.min(this.checkingMs, 60_000);
      const waitPending = async (initialCheck) => {
        let check = initialCheck;
        if (!check?.pending) return check;
        // 仅当存在被动轮询周期且在等待预算内可完成至少一次轮询时等待；不新开页也不刷新。
        if (this.pollMs > waitBudget) return check;
        const pendingDeadline = Date.now() + waitBudget;
        while (check?.pending && Date.now() < pendingDeadline) {
          const currentSession = this.sessions.get(current.id);
          if (!currentSession || currentSession.closed || !currentSession.driver?.isOpen()) break;
          await new Promise(r => setTimeout(r, Math.min(250, Math.max(20, pendingDeadline - Date.now()))));
          check = this.checks.get(current.id) || check;
        }
        if (check?.pending) {
          const currentSession = this.sessions.get(current.id);
          if (currentSession?.reading) {
            await currentSession.reading.catch(() => {});
            check = this.checks.get(current.id) || check;
          }
        }
        return check;
      };
      let check = null;
      if (openedFreshly) {
        openedFreshly = false;
        const currentSession = this.sessions.get(current.id);
        const existing = this.checks.get(current.id);
        if (existing?.state === 'verified' && !existing.pending && existing.platformAccountId === expected.platformAccountId
          && Date.now() - (currentSession?.verifiedAt || 0) < 15_000) {
          check = existing;
        } else if (existing?.pending) {
          check = await waitPending(existing);
        }
      }
      if (!check) {
        check = await waitPending(await this.inspect(current.id));
      }
      if (check.pending || check.state !== 'verified' || check.platformAccountId !== expected.platformAccountId) throw new Error(`账号复查未通过：${check.message || '尚未读到一致的真实账号。'}`);
    };
    // The coordinator calls executor.verify immediately before preparing and
    // approving. Avoid a second consecutive reload merely to create it.
    const session = this.sessions.get(original.id);
    if (!session?.driver?.createPublisher) throw new Error('此浏览器驱动尚未接入真实试发。');
    return session.driver.createPublisher({verifyIdentity,diagnosticsRoot,onVerifyFiles,allowSubmit,focusCoordinator:this.focusCoordinator});
  }
  cancel(id) {
    this.account(id);
    const s = this.sessions.get(id);
    if (!s) return null;
    this.stopWatch(s); s.generation++; s.candidate = null; s.verifiedAt = 0;
    this.checks.delete(id);
    return this.set(s, 'canceled', '已取消本次绑定，浏览器登录保留在本机；没有上传或发布。');
  }
  didClose(s) {
    this.stopWatch(s); s.generation++; s.closed = true; s.candidate = null; s.verifiedAt = 0;
    if (this.sessions.get(s.accountId) === s) {
      this.checks.set(s.accountId, { accountId: s.accountId, state: 'offline', message: '专属浏览器已关闭，之前的身份核对不再代表当前在线。' });
      this.set(s, 'closed', '浏览器已关闭。登录会话留在本机，下次打开仍会重新核对身份。');
    }
  }
  async close(id) {
    this.account(id);
    const s = this.sessions.get(id);
    if (!s) return null;
    this.didClose(s);
    if (s.driver?.isOpen()) await s.driver.close();
    return this.view(s);
  }
  unbind(id) {
    this.cancel(id);
    const account = model.unbindManagedAccount(this.store, id);
    const s = this.sessions.get(id);
    if (s) s.revision = null;
    this.checks.delete(id); this.onUpdate({ type: 'data' });
    return account;
  }
  async closeAll() {
    this.stopping = true;
    for (const s of this.sessions.values()) { this.stopWatch(s); s.closed = true; s.candidate = null; }
    await Promise.allSettled([...this.sessions.values()].map(s => s.driver?.close()));
    await Promise.allSettled(this.opening.values());
  }
}

module.exports = { ManagedBrowsers };
