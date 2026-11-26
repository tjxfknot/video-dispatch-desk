'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol, net, nativeImage, shell, Menu, session, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { JsonStore, replaceFileSync } = require('./core/store.cjs');
const restrictPathMode = (targetPath, mode) => { if (process.platform !== 'win32') fs.chmodSync(targetPath, mode); };
const domain = require('./core/domain.cjs');
const { RunService } = require('./core/service.cjs');
const { ChromeBridge } = require('./core/chrome-bridge.cjs');
const { ChromePublisher } = require('./core/chrome-publisher.cjs');
const managedAccounts = require('./core/accounts.cjs');
const { AccountBroker } = require('./core/account-broker.cjs');
const { ConnectionVault } = require('./core/connection-vault.cjs');
const { ManagedBrowsers } = require('./core/managed-browser.cjs');
const { ManagedPublisher } = require('./core/managed-publisher.cjs');
const { buildManagedJob } = require('./core/managed-publish-job.cjs');
const {startManagedPlan}=require('./core/managed-plan.cjs');
const {reviewManagedPublish}=require('./core/publish-review.cjs');
const { loadPilotAccess, assertPilotAccess } = require('./core/pilot-access.cjs');
const { inspectManagedResult } = require('./core/managed-result.cjs');
const {workReference}=require('./core/managed-receipt.cjs');
const {PreparationTests}=require('./core/preparation-tests.cjs');
const {buildOfflineJob,createOfflineExecutor}=require('./core/preparation-test-fixture.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('视频发布台');
// Product rename must preserve the established library and browser environments.
app.setPath('userData', path.join(app.getPath('appData'), '分发台'));
// Keep test processes separate from the user's real local library.
const testIndex = process.argv.indexOf('--test-data-dir');
if (testIndex !== -1 && process.argv[testIndex + 1]) app.setPath('userData', path.resolve(process.argv[testIndex + 1]));
const primaryInstance = app.requestSingleInstanceLock();
let window, store, service, connections, livePublisher, managedPublisher, preparationTests, accountBroker, browsers, accountConnectionError = '', quitting = false, browserCleanupDone = false;
const pilotAccess=loadPilotAccess({productionEnabled:true,isPackaged:app.isPackaged,developmentFlag:process.env.DISPATCH_LIVE_PILOT,file:path.join(app.getPath('userData'),'真实试发范围.json')});
const livePilotEnabled=pilotAccess.enabled;
// Reuse only the previously explicit test-account allowlist, never the broad
// productionEnabled policy. No implicit development flag opens real testing.
const preparationAccess=loadPilotAccess({isPackaged:true,file:path.join(app.getPath('userData'),'真实试发范围.json')});
const buildPilotJob=(draft,state)=>{
  const job=buildManagedJob(draft,state);assertPilotAccess(pilotAccess,job);
  return job;
};
const managedActive = () => preparationTests?.hasActive() || managedPublisher?.hasPendingOperations() || (managedPublisher && Object.values(managedPublisher.snapshot()).some(s=>['queued','preparing','ready_to_submit','awaiting_confirmation','approved','submitting','verifying_result'].includes(s.state)));
let teacherFormState = { dirty: false, busy: false }, closePromptOpen = false;
const indexPath = path.join(__dirname, 'renderer', 'index.html');
const indexUrl = pathToFileURL(indexPath).href;

function notify(data) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('desk:update', data);
    if(data?.type==='run' && data.run?.mode==='managed_prepare' && data.run.status==='awaiting_confirmation'){
      if(window.isMinimized())window.restore();window.show();window.focus();
    }
  }
}

function protectPayload(value) {
  if (JSON.stringify(value ?? null).length > 2_000_000) throw new Error('本条输入过大，请缩短内容。');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame?.url?.split('#')[0];
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || url !== indexUrl) throw new Error('无法验证操作来源。');
    protectPayload(args);
    return fn(...args);
  });
}

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

function registerAssetFromPath(rawPath, forcedKind = null) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('文件路径无效。');
  const assetPath = fs.realpathSync(rawPath);
  const extension = path.extname(assetPath).slice(1).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(extension);
  const isImage = IMAGE_EXTENSIONS.includes(extension);
  if (!isVideo && !isImage) throw new Error('不支持该文件格式，请使用视频（MP4/MOV/WebM/M4V）或图片（PNG/JPG/WebP）。');
  if (forcedKind === 'video' && !isVideo) throw new Error('文件类型与素材用途不符。');
  if ((forcedKind === 'landscape' || forcedKind === 'portrait') && !isImage) throw new Error('文件类型与素材用途不符。');
  const info = fs.statSync(assetPath);
  if (!info.isFile() || !info.size) throw new Error('文件为空或无法读取。');
  if (!isVideo && info.size > 100 * 1024 * 1024) throw new Error('封面图片超过 100 MB，请先缩小图片。');
  let kind = forcedKind;
  let sizeMeta = null;
  if (isVideo) {
    kind = 'video';
  } else {
    const image = nativeImage.createFromPath(assetPath);
    if (image.isEmpty()) throw new Error('图片格式无法预览，请使用 PNG、JPG 或 WebP。');
    sizeMeta = image.getSize();
    if (!kind) kind = sizeMeta.width >= sizeMeta.height ? 'landscape' : 'portrait';
  }
  const id = randomUUID();
  const asset = { id, kind, path: assetPath, name: path.basename(assetPath), size: info.size, mtimeMs: info.mtimeMs, url: `asset://local/${id}` };
  if (sizeMeta) Object.assign(asset, sizeMeta);
  store.update(state => state.assets.push(asset));
  return asset;
}

async function chooseAsset(kind) {
  if (!['video', 'landscape', 'portrait'].includes(kind)) throw new Error('素材用途无效。');
  const video = kind === 'video';
  const extensions = video ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  const response = await dialog.showOpenDialog(window, {
    title: video ? '选择本地视频' : `选择${kind === 'landscape' ? '横版' : '竖版'}封面`, properties: ['openFile'],
    filters: [{ name: video ? '视频' : '封面图片', extensions }]
  });
  if (response.canceled || !response.filePaths[0]) return null;
  return registerAssetFromPath(response.filePaths[0], kind);
}

function expandCandidatePaths(rawPaths) {
  const expanded = [];
  let folderName = '';
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
    let real;
    try { real = fs.realpathSync(rawPath); } catch { continue; }
    let stat;
    try { stat = fs.statSync(real); } catch { continue; }
    if (stat.isDirectory()) {
      if (!folderName) folderName = path.basename(real);
      const entries = fs.readdirSync(real, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name || entry.name.startsWith('.')) continue;
        if (entry.isFile()) expanded.push(path.join(real, entry.name));
      }
    } else if (stat.isFile()) {
      const base = path.basename(real);
      if (!base.startsWith('.')) expanded.push(real);
    }
  }
  return { expanded, folderName };
}

function classifyAndRegisterPaths(paths) {
  if (!Array.isArray(paths)) throw new Error('素材路径列表格式无效。');
  const { expanded, folderName } = expandCandidatePaths(paths);
  if (expanded.length > 60) throw new Error('单次文件夹或批量投递最多扫描 60 个文件。');
  const result = { video: null, landscape: null, portrait: null, folderName, ignored: [], errors: [] };
  // 按文件体积降序优先选主视频和主图，避免误选极小缩略图
  const candidates = expanded.map(filePath => {
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}
    return { filePath, size };
  }).sort((a, b) => b.size - a.size);

  for (const { filePath } of candidates) {
    const base = path.basename(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext) && !IMAGE_EXTENSIONS.includes(ext)) {
      result.ignored.push(base);
      continue;
    }
    if (VIDEO_EXTENSIONS.includes(ext) && result.video) continue;
    try {
      const asset = registerAssetFromPath(filePath, null);
      if (!result[asset.kind]) result[asset.kind] = asset;
    } catch (error) {
      result.errors.push(`${base}：${error.message}`);
    }
  }
  return result;
}

async function chooseAssetsBatch() {
  const response = await dialog.showOpenDialog(window, {
    title: '一次选择视频与横竖封面（自动识别归位）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频与封面图片', extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] }]
  });
  if (response.canceled || !response.filePaths?.length) return null;
  return classifyAndRegisterPaths(response.filePaths);
}

async function chooseAssetFolder() {
  const response = await dialog.showOpenDialog(window, {
    title: '选择素材文件夹（自动筛选视频、横版封面、竖版封面）',
    properties: ['openDirectory']
  });
  if (response.canceled || !response.filePaths?.length) return null;
  return classifyAndRegisterPaths(response.filePaths);
}

function swapCovers({ landscapeId = '', portraitId = '' } = {}) {
  const assets = store.load().assets || [];
  const oldLandscape = landscapeId ? assets.find(a => a.id === landscapeId && a.kind === 'landscape') : null;
  const oldPortrait = portraitId ? assets.find(a => a.id === portraitId && a.kind === 'portrait') : null;
  const nextLandscape = oldPortrait ? registerAssetFromPath(oldPortrait.path, 'landscape') : null;
  const nextPortrait = oldLandscape ? registerAssetFromPath(oldLandscape.path, 'portrait') : null;
  return { landscape: nextLandscape, portrait: nextPortrait };
}

function commonTagsFile() {
  return path.join(app.getPath('userData'), 'common-tags.json');
}

function sanitizeCommonTagsMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const clean = {};
  for (const [key, list] of Object.entries(input)) {
    const k = String(key || '').trim().slice(0, 120);
    if (!k || !Array.isArray(list)) continue;
    const seen = new Set();
    const tags = [];
    for (const item of list) {
      const tag = String(item ?? '').trim().replace(/^#+/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= 100) break;
    }
    clean[k] = tags;
  }
  return clean;
}

function loadCommonTags() {
  try {
    const file = commonTagsFile();
    if (!fs.existsSync(file)) return {};
    return sanitizeCommonTagsMap(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

function saveCommonTags(input) {
  const clean = sanitizeCommonTagsMap(input);
  const file = commonTagsFile();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(clean, null, 2), { mode: 0o600 });
    replaceFileSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) try { fs.unlinkSync(temp); } catch {}
  }
  return clean;
}

function registerIpc() {
  handle('desk:bootstrap', () => {
    const state = store.load();
    const accountData = accountBroker.snapshot(), browserData = browsers.snapshot();
    accountData.environments = accountData.environments.map(e => e.source === 'managed_browser' ? { ...e, online: browsers.isOnline(e.id) } : e);
    accountData.accountChecks = { ...accountData.accountChecks, ...browserData.browserChecks };
    return { version: app.getVersion(), storagePath: app.getPath('userData'), chromeConnectorPath: app.isPackaged ? path.join(process.resourcesPath, 'chrome-connector') : path.join(__dirname, '..', 'chrome-connector'), platforms: domain.PLATFORMS, ...accountData, ...browserData, accountConnectionError, templates: state.templates, drafts: state.drafts, runs: state.runs, engine: {...domain.ENGINE,managedPilot:livePilotEnabled,managedPilotLabel:pilotAccess.label,managedPilotAccountIds:pilotAccess.accounts?.map(a=>a.accountId) || null}, connections: connections.snapshot(), liveSessions: livePublisher.snapshot() };
  });
  handle('desk:choose-asset', chooseAsset);
  handle('desk:choose-assets-batch', chooseAssetsBatch);
  handle('desk:choose-asset-folder', chooseAssetFolder);
  handle('desk:import-asset-paths', classifyAndRegisterPaths);
  handle('desk:swap-covers', swapCovers);
  handle('desk:load-common-tags', loadCommonTags);
  handle('desk:save-common-tags', saveCommonTags);
  handle('desk:save-draft', draft => domain.saveDraft(store, draft));
  handle('desk:save-account', account => {
    const existing = account?.id ? store.load().accounts.find(a => a.id === account.id) : null;
    const result = existing?.teacherId ? managedAccounts.saveManagedAccount(store, { ...account, teacherId: existing.teacherId }) : domain.saveAccount(store, account);
    notify({ type: 'data' }); return result;
  });
  handle('desk:save-teacher', input => { const result = managedAccounts.saveTeacher(store, input); notify({ type: 'data' }); return result; });
  handle('desk:save-teacher-profile', input => { const result = managedAccounts.saveTeacherProfile(store, input); notify({ type: 'data' }); return result; });
  handle('desk:report-teacher-form', input => {
    teacherFormState = { dirty: input?.dirty === true, busy: input?.busy === true };
    return { accepted: true };
  });
  handle('desk:save-managed-account', input => { const result = managedAccounts.saveManagedAccount(store, input); notify({ type: 'data' }); return result; });
  handle('desk:start-account-pair', id => accountBroker.start(id));
  handle('desk:cancel-account-pair', id => accountBroker.cancel(id));
  handle('desk:confirm-account-pair', id => accountBroker.confirm(id));
  const usesBrowser = id => !!store.load().accounts.find(a => a.id === id)?.browserEnvironmentId;
  handle('desk:inspect-managed-account', id => usesBrowser(id) ? browsers.inspect(id) : accountBroker.inspect(id));
  handle('desk:open-managed-account', id => usesBrowser(id) ? browsers.open({ accountId: id }) : accountBroker.open(id));
  handle('desk:unbind-managed-account', id => usesBrowser(id) ? browsers.unbind(id) : accountBroker.unbind(id));
  handle('desk:open-account-browser', input => browsers.open(input));
  handle('desk:confirm-browser-account', id => browsers.confirm(id));
  handle('desk:close-account-browser', id => browsers.close(id));
  handle('desk:cancel-browser-binding', id => browsers.cancel(id));
  handle('desk:check-account-readiness', input => browsers.checkReady(input));
  handle('desk:save-template', template => {
    const result = domain.saveTemplate(store, template); notify({ type: 'data' }); return result;
  });
  handle('desk:validate', ({ draft, mode } = {}) => domain.validateDraft(draft, store.load(), mode));
  handle('desk:start-run', options => service.start(options));
  handle('desk:cancel-run', id => store.load().runs.find(r=>r.id===id)?.mode==='managed_prepare' ? managedPublisher.stop(id) : livePublisher.run(id) ? livePublisher.stop(id) : service.cancel(id));
  const requirePilot = () => { if(!livePilotEnabled)throw new Error('真实试发开发入口尚未启用，不会降为演练。'); };
  handle('desk:review-managed-pilot', draft => {
    requirePilot();return reviewManagedPublish({draft,store,appVersion:app.getVersion(),onBlocked:run=>notify({type:'run',run})});
  });
  handle('desk:start-managed-pilot', options => {
    requirePilot();return startManagedPlan({...options,store,publisher:managedPublisher,assertAvailable:job=>preparationTests.assertAccountAvailable(job)});
  });
  handle('desk:list-preparation-tests',()=>({sessions:preparationTests.list(),realReady:preparationAccess.enabled===true}));
  handle('desk:review-preparation-test',draft=>preparationTests.review(draft));
  handle('desk:start-preparation-test',input=>preparationTests.start(input));
  handle('desk:read-preparation-location',id=>preparationTests.readLocation(id));
  handle('desk:stop-preparation-test',id=>preparationTests.stop(id));
  handle('desk:approve-managed-pilot', input => {requirePilot();return managedPublisher.approve(input?.id,input?.fingerprint);});
  handle('desk:inspect-managed-result', id => inspectManagedResult({id,store,onUpdate:notify,trackOperation:(id,operation)=>managedPublisher.trackExternalOperation(id,operation),checkAccess:job=>{assertPilotAccess(pilotAccess,job);preparationTests.assertAccountAvailable(job);managedPublisher.assertAccountAvailable(job,id);},getReader:job=>browsers.publisherFor(job,{diagnosticsRoot:path.join(app.getPath('userData'),'live-diagnostics',job.fingerprint),onVerifyFiles:async()=>{}})}));
  handle('desk:open-published-work',async id=>{
    const run=store.load().runs.find(r=>r.id===id),reference=workReference(run?.result?.workUrl,run?.platform || 'douyin');
    if(!reference || reference.workId!==run.result.workId)throw new Error('原记录没有可靠的平台作品链接，请先核查发布结果。');
    await shell.openExternal(reference.workUrl);return {opened:true};
  });
  handle('desk:start-chrome-prepare', options => { if (!domain.ENGINE.douyinPilot) throw new Error(domain.ENGINE.reason); return livePublisher.start(options); });
  handle('desk:stop-chrome-prepare', id => livePublisher.stop(id));
  handle('desk:authorize-chrome-publish', id => { if (!domain.ENGINE.douyinPilot) throw new Error(domain.ENGINE.reason); return livePublisher.approve(id); });
  const retiredLogin = () => { throw new Error('内置扫码入口已停用。请使用“连接已登录Chrome”，避免重复扫码。'); };
  handle('desk:connect-account', retiredLogin);
  handle('desk:inspect-account', retiredLogin);
  handle('desk:close-account-window', retiredLogin);
  handle('desk:start-chrome-pair', id => connections.start(id));
  handle('desk:stop-chrome-pair', id => connections.stop(id));
  handle('desk:export-run', async id => {
    const run = store.load().runs.find(r => r.id === id);
    if (!run) throw new Error('任务记录不存在。');
    const choice = await dialog.showSaveDialog(window, { title: '导出本地任务报告（不含登录态和素材绝对路径）', defaultPath: `视频发布台-${run.mode==='rehearsal'?'演练':'真实试发'}报告-${run.id.slice(0, 8)}.json`, filters: [{ name: 'JSON 报告', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    fs.writeFileSync(choice.filePath, JSON.stringify(domain.exportReport(run), null, 2), { mode: 0o600 });
    return { canceled: false, path: choice.filePath };
  });
  handle('desk:open-creator', async id => {
    const platform = domain.PLATFORMS.find(p => p.id === id);
    if (!platform) throw new Error('平台无法识别。');
    await shell.openExternal(platform.creatorUrl);
    return { opened: true };
  });
}

async function boot() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  restrictPathMode(app.getPath('userData'), 0o700);
  store = new JsonStore(path.join(app.getPath('userData'), 'library.json'), domain.emptyState());
  domain.checkState(store.load());
  const oldLibrary = store.load();
  if (Array.isArray(oldLibrary.teachers) && oldLibrary.teachers.some(t => t.defaultPlatforms === undefined)) {
    const backup = path.join(app.getPath('userData'), `library.before-v062-${Date.now()}.json`);
    fs.copyFileSync(path.join(app.getPath('userData'), 'library.json'), backup, fs.constants.COPYFILE_EXCL);
    restrictPathMode(backup, 0o600);
  }
  if (oldLibrary.accountEnvironmentVersion !== undefined && oldLibrary.accountEnvironmentVersion !== 2) throw new Error('账号环境数据版本无法识别，已保留原数据并停止。');
  if (!oldLibrary.accountEnvironmentVersion) {
    const backup = path.join(app.getPath('userData'), `library.before-v06-${Date.now()}.json`);
    fs.copyFileSync(path.join(app.getPath('userData'), 'library.json'), backup, fs.constants.COPYFILE_EXCL);
    restrictPathMode(backup, 0o600);
  }
  if (!Array.isArray(oldLibrary.teachers) || !oldLibrary.deviceId) {
    const backup = path.join(app.getPath('userData'), `library.before-v05-${Date.now()}.json`);
    fs.copyFileSync(path.join(app.getPath('userData'), 'library.json'), backup, fs.constants.COPYFILE_EXCL);
    restrictPathMode(backup, 0o600);
  }
  managedAccounts.ensureAccountState(store);
  if (!oldLibrary.accountEnvironmentVersion) store.update(state => { state.accountEnvironmentVersion = 2; });
  domain.recoverRuns(store);
  service = new RunService({ store, onUpdate: notify });
  connections = new ChromeBridge({ findAccount: id => store.load().accounts.find(account => account.id === id), onUpdate: notify });
  livePublisher = new ChromePublisher({ store, onUpdate: notify });
  accountBroker = new AccountBroker({ store, vault: new ConnectionVault({ file: path.join(app.getPath('userData'), 'account-connections.enc'), encryption: safeStorage }), onUpdate: notify });
  browsers = new ManagedBrowsers({ store, profilesRoot: path.join(app.getPath('userData'), 'browser-profiles'), diagnosticsRoot:path.join(app.getPath('userData'),'connection-diagnostics'), onUpdate: notify });
  managedPublisher = new ManagedPublisher({store,appVersion:app.getVersion(),onUpdate:notify,buildJob:buildPilotJob,assertAvailable:job=>preparationTests?.assertAccountAvailable(job),getExecutor:async job=>{
    const refreshed=buildPilotJob(job.draft,store.load());
    if(refreshed.fingerprint!==job.fingerprint)throw new Error('开始执行前任务或绑定已改变。');
    return browsers.publisherFor(refreshed,{diagnosticsRoot:path.join(app.getPath('userData'),'live-diagnostics',job.fingerprint),onVerifyFiles:async input=>{
      const latest=buildPilotJob(input.draft,store.load());
      if(latest.fingerprint!==job.fingerprint)throw new Error('素材或绑定已改变，已停止真实操作。');
    }});
  }});
  const testsRoot=path.join(app.getPath('userData'),'preparation-tests');
  const testStore=new JsonStore(path.join(testsRoot,'sessions.json'),{sessions:[]});
  preparationTests=new PreparationTests({store:testStore,businessStore:store,appVersion:app.getVersion(),onUpdate:notify,
    buildJob:(draft,state)=>{
      const targets=(draft?.targets || []).filter(t=>t.enabled);
      if(targets.length!==1 || targets[0].platform!=='douyin')throw new Error('请只选择一个抖音账号进行准备测试。');
      return buildManagedJob(draft,state);
    },
    checkAccess:job=>assertPilotAccess(preparationAccess,job),
    buildOfflineJob:scenario=>buildOfflineJob(scenario,path.join(testsRoot,'fixtures')),
    getExecutor:async({mode,job,scenario})=>{
      if(mode==='offline')return createOfflineExecutor({job,scenario});
      assertPilotAccess(preparationAccess,job);
      return browsers.publisherFor(job,{allowSubmit:false,diagnosticsRoot:path.join(testsRoot,'diagnostics',job.fingerprint),onVerifyFiles:async()=>{
        const latest=buildManagedJob(job.draft,store.load());
        if(latest.fingerprint!==job.fingerprint)throw new Error('素材或账号绑定已改变，原测试检查点失效。');
      }});
    }});
  try { await accountBroker.listen(); } catch (error) { accountConnectionError = error.message; }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // The local renderer has no network need; official pages use isolated browser processes.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  protocol.handle('asset', async request => {
    const url = new URL(request.url);
    const id = url.pathname.slice(1);
    if (url.hostname !== 'local' || !/^[a-f0-9-]{36}$/.test(id)) return new Response('Invalid asset', { status: 403 });
    const asset = store.load().assets.find(a => a.id === id);
    if (!asset) return new Response('Unknown asset', { status: 404 });
    try {
      const stat = fs.statSync(asset.path);
      if (!stat.isFile() || stat.size !== asset.size || stat.mtimeMs !== asset.mtimeMs) return new Response('Asset changed; select it again', { status: 409 });
      return await net.fetch(pathToFileURL(asset.path).href, { headers: request.headers });
    } catch { return new Response('Asset unavailable', { status: 404 }); }
  });
  registerIpc();
  const windowIcon = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'icon.ico')
    : process.platform === 'linux'
      ? path.join(__dirname, 'assets', 'icon.png')
      : undefined;
  window = new BrowserWindow({
    width: 1450, height: 980, minWidth: 1060, minHeight: 720, title: '视频发布台', backgroundColor: '#141517', show: false,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false, backgroundThrottling: false }
  });
  if (livePilotEnabled) {
    window.setTitle(`视频发布台 · ${pilotAccess.label} ${app.getVersion()}`);
    window.webContents.on('page-title-updated',event=>event.preventDefault());
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '视频发布台', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit', label: '退出视频发布台' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'togglefullscreen', label: '全屏' }] }
  ]));
  window.once('ready-to-show', () => window.show());
  window.on('close', async event => {
    if (closePromptOpen) { event.preventDefault(); return; }
    if (!quitting && (teacherFormState.dirty || teacherFormState.busy)) {
      event.preventDefault(); closePromptOpen = true;
      try {
        const answer = await dialog.showMessageBox(window, {
          type: 'question', title: '老师资料尚未保存',
          message: teacherFormState.busy ? '正在保存老师资料，请等保存结束后再关闭。' : '老师表单有未保存的更改。要返回继续编辑，还是放弃这次更改并关闭？',
          buttons: teacherFormState.busy ? ['返回等待'] : ['返回继续编辑', '放弃更改并关闭'], defaultId: 0, cancelId: 0
        });
        if (answer.response === 1 && !teacherFormState.busy) {
          teacherFormState = { dirty: false, busy: false }; closePromptOpen = false; window.close();
        }
      } finally { closePromptOpen = false; }
      return;
    }
    if (quitting || (!service.activeRuns().length && !livePublisher.hasActiveSession() && !managedActive())) return;
    event.preventDefault();
    closePromptOpen=true;
    try{
    const answer = await dialog.showMessageBox(window, { type: 'question', title: '任务仍在运行', message: livePublisher.hasActiveSession() || managedActive() ? '任务或测试会话仍在运行。停止后保留真实平台草稿与提交记录，不会自动删除或重发。' : '等待演练结束，或停止演练并退出。当前演练没有真实上传。', buttons: ['继续等待', '停止任务并退出'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) { await Promise.all([service.stop(), livePublisher.closeAll(),managedPublisher.shutdown(),preparationTests.shutdown()]); quitting = true; app.quit(); }
    }finally{closePromptOpen=false;}
  });
  window.on('closed', () => { void connections.closeAll(); void livePublisher.closeAll(); void accountBroker.close(); });
  await window.loadFile(indexPath);
}

if (primaryInstance) app.whenReady().then(boot).catch(error => {
  dialog.showErrorBox('视频发布台无法启动', `${error.message}\n\n本机数据未被自动清空。`);
  app.quit();
});
else app.quit();
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if(!quitting && window && !window.isDestroyed() && (service?.activeRuns().length || livePublisher?.hasActiveSession() || managedActive())){
    event.preventDefault();window.close();return;
  }
  if (window && !window.isDestroyed() && (teacherFormState.dirty || teacherFormState.busy)) {
    event.preventDefault(); window.close(); return;
  }
  if (browsers && !browserCleanupDone) {
    event.preventDefault(); browserCleanupDone = true;
    Promise.resolve(managedPublisher?.shutdown()).finally(()=>browsers.closeAll()).finally(() => app.quit());
  }
});
