'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const model = require('../app/core/accounts.cjs');
const { ManagedBrowsers } = require('../app/core/managed-browser.cjs');
const { parseIdentity, observationFromPage, allowedNavigation, profileDirectory, browserAvailability } = require('../app/core/browser-driver.cjs');

function setup(t, options = {}) {
  const { platforms = ['douyin', 'douyin'], ...managerOptions } = options;
  let value = { schemaVersion: 1 };
  const store = { load: () => structuredClone(value), update: fn => { const next = structuredClone(value); fn(next); value = next; return structuredClone(next); } };
  model.ensureAccountState(store);
  const teachers = ['合成甲', '合成乙'].map(name => model.saveTeacher(store, { name }));
  const accounts = teachers.map((teacher, index) => model.saveManagedAccount(store, { teacherId: teacher.id, platform: platforms[index], label: '合成测试备注' }));
  const drivers = new Map(), opened = [];
  const launch = async ({ environment, onClosed }) => {
    opened.push(environment.id);
    let open = true;
    const driver = {
      data: { identity: { platformAccountId: `synthetic_${opened.length}`, displayName: '合成账号' }, state: 'identified' },
      reads: 0, focuses: 0,
      read: async () => { driver.reads++; if (driver.nextRead) return driver.nextRead(); return structuredClone(driver.data); },
      focus: async () => { driver.focuses++; }, isOpen: () => open,
      close: async () => { open = false; onClosed(); }
    };
    drivers.set(environment.id, driver);
    return driver;
  };
  const manager = new ManagedBrowsers({ store, profilesRoot: '/synthetic/not-used', launch,
    availability: () => [{ id: 'chrome', available: true }, { id: 'msedge', available: true }], pollMs: 1_000_000, ...managerOptions });
  t.after(() => manager.closeAll());
  const getDriver = account => drivers.get(store.load().accounts.find(a => a.id === account.id).browserEnvironmentId);
  return { store, teachers, accounts, manager, drivers, opened, getDriver };
}
const open = (m, a, browserKind = 'chrome') => m.open({ accountId: a.id, browserKind });

test('从老师平台卡片主动连接时，双次读号一致后自动保存，无需再点确认', async t => {
  const {manager,accounts:[a],getDriver,store}=setup(t,{platforms:['tencent','douyin']});
  const result=await manager.open({accountId:a.id,browserKind:'chrome',autoBind:true});
  assert.equal(result.state,'bound');assert.equal(getDriver(a).reads,2);
  assert.equal(store.load().accounts[0].binding.platformAccountId,'synthetic_1');
  assert.equal((await manager.checkReady({accountIds:[a.id]})).ready,true);
  assert.equal(store.load().runs.length,0);
});
test('自动连接的复核失败时不写绑定，原窗口可继续连接；页面错误有具体阶段', async t => {
  const {manager,accounts:[a],getDriver,store}=setup(t,{platforms:['tencent','douyin']});
  await open(manager,a);
  const d=getDriver(a);d.nextRead=()=>{if(d.reads%2===0){const e=new Error('net::ERR_CONNECTION_TIMED_OUT https://secret.invalid/?token=secret');e.connectionStage='open_identity';throw e;}return structuredClone(d.data);};
  const failed=await manager.open({accountId:a.id,autoBind:true});
  assert.equal(failed.state,'unverifiable');assert.match(failed.message,/打开账号校验页.*ERR_CONNECTION_TIMED_OUT|打开账号校验页.*超时/);
  assert.equal(failed.message.includes('secret'),false);assert.equal(store.load().accounts[0].binding,null);
  d.nextRead=null;assert.equal((await manager.open({accountId:a.id,autoBind:true})).state,'bound');
});
test('自动连接等待期间取消或更改老师时，迟到复核不能保存绑定或恢复状态', async t => {
  const {manager,accounts:[a],getDriver,store}=setup(t);await open(manager,a);
  const d=getDriver(a);let release;d.nextRead=()=>d.reads===2?Promise.resolve(structuredClone(d.data)):new Promise(resolve=>{release=resolve;});
  const pending=manager.open({accountId:a.id,autoBind:true});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  manager.cancel(a.id);release(structuredClone(d.data));await pending;
  assert.equal(store.load().accounts[0].binding,null);assert.equal(manager.snapshot().browserSessions[a.id].state,'canceled');
});
test('自动连接遇到账号切换或他人已绑定的真实号时拒绝，不覆盖老师归属',async t=>{
  const {manager,accounts:[a,b],getDriver,store}=setup(t);await manager.open({accountId:a.id,autoBind:true});await open(manager,b);
  const d=getDriver(b);d.data.identity.platformAccountId='synthetic_1';
  const result=await manager.open({accountId:b.id,autoBind:true});
  assert.equal(result.state,'unverifiable');assert.match(result.message,/其他老师/);assert.equal(store.load().accounts[1].binding,null);
});

test('两个同平台老师用同一种浏览器，独立分配环境并确认各自真实号', async t => {
  const { store, accounts, manager, opened } = setup(t);
  for (const a of accounts) { const s = await open(manager, a); assert.equal(s.state, 'awaiting_confirmation'); assert.equal(store.load().accounts.find(x => x.id === a.id).binding, null); await manager.confirm(a.id); }
  assert.notEqual(opened[0], opened[1]);
  for (const a of accounts) { assert.equal((await manager.inspect(a.id)).state, 'verified'); const binding = store.load().accounts.find(x => x.id === a.id).binding; assert.equal(binding.source, 'managed_browser'); assert.equal(binding.connectorInstanceId, null); }
});
test('同一账号重复打开复用窗口，不能改用另一浏览器', async t => {
  const { accounts: [a], manager, opened, getDriver } = setup(t);
  const p1 = open(manager, a), p2 = open(manager, a); assert.equal(p1, p2); await p1;
  await open(manager, a); assert.equal(opened.length, 1); assert.equal(getDriver(a).focuses, 1);
  await assert.rejects(open(manager, a, 'msedge'), /另一种浏览器/);
});
test('已绑定账号重新打开直接进入官方首页核查，不再强制落到登录入口',async t=>{
 const {manager,accounts:[a]}=setup(t),launch=manager.launch,entries=[];
 manager.launch=options=>{entries.push(options.preferHome);return launch(options);};
 await open(manager,a);await manager.confirm(a.id);await manager.close(a.id);await open(manager,a);
 assert.deepEqual(entries,[false,true]);
});
test('Edge可独立分配，未安装的浏览器不留下环境或绑定', async t => {
  const { manager, accounts, store } = setup(t, { availability: () => [{ id: 'msedge', available: true }] });
  await assert.rejects(open(manager, accounts[0]), /未检测到/); assert.equal(store.load().environments.length, 0);
  assert.equal((await open(manager, accounts[0], 'msedge')).browserKind, 'msedge');
});
test('候选确认前重新读号，账号已切换时拒绝绑定', async t => {
  const { manager, accounts: [a], getDriver, store } = setup(t);
  await open(manager, a); getDriver(a).data.identity.platformAccountId = 'unexpected_account';
  await assert.rejects(manager.confirm(a.id), /已变化/); assert.equal(store.load().accounts[0].binding, null);
});
test('一个真实号不能绑定到两位老师', async t => {
  const { manager, accounts: [a, b], getDriver } = setup(t);
  await open(manager, a); await manager.confirm(a.id);
  await open(manager, b); getDriver(b).data.identity.platformAccountId = getDriver(a).data.identity.platformAccountId;
  manager.cancel(b.id); await open(manager, b);
  await assert.rejects(manager.confirm(b.id), /真实账号已绑定/);
});
test('绑定后换号会停止该账号，另一位老师仍可核对', async t => {
  const { manager, accounts: [a, b], getDriver } = setup(t);
  for (const x of [a, b]) { await open(manager, x); await manager.confirm(x.id); }
  getDriver(a).data.identity.platformAccountId = 'wrong_account';
  assert.equal((await manager.inspect(a.id)).state, 'mismatch');
  assert.equal((await manager.inspect(b.id)).state, 'verified');
  assert.equal(manager.isOnline(manager.snapshot().browserSessions[a.id].environmentId), false);
});
test('关闭及重启保留绑定和环境，但不得把旧记录显示为在线', async t => {
  const { manager, accounts: [a], store, opened } = setup(t);
  await open(manager, a); const bound = await manager.confirm(a.id); await manager.close(a.id);
  assert.equal((await manager.inspect(a.id)).state, 'offline');
  assert.equal(store.load().accounts[0].binding.platformAccountId, bound.binding.platformAccountId);
  const restarted = new ManagedBrowsers({ store, profilesRoot: '/not-used', availability: () => [] });
  t.after(() => restarted.closeAll()); assert.equal(restarted.isOnline(bound.binding.environmentId), false);
  assert.deepEqual(restarted.snapshot().browserSessions, {});
  await open(manager, a); assert.equal(opened[0], opened[1]); // fresh driver here intentionally returns another synthetic identity
  assert.equal((await manager.inspect(a.id)).state, 'mismatch');
});
test('没有唯一账号时等待登录，平台限频停止自动轮询', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); const d = getDriver(a);
  d.data = { identity: null, state: 'awaiting_login', message: '等待扫码' };
  await manager.poll(manager.sessions.get(a.id)); assert.equal(manager.snapshot().browserSessions[a.id].state, 'awaiting_login');
  d.data = { identity: null, state: 'error', message: '平台提示登录频繁' };
  await manager.poll(manager.sessions.get(a.id)); assert.equal(manager.sessions.get(a.id).timer, null);
  assert.equal(manager.snapshot().browserSessions[a.id].state, 'error');
});
test('取消期间的迟到身份回读不能恢复候选', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); let resolve;
  getDriver(a).nextRead = () => new Promise(r => { resolve = r; });
  const pending = manager.poll(manager.sessions.get(a.id)); manager.cancel(a.id);
  resolve({ identity: { platformAccountId: 'late_identity' }, state: 'identified' }); await pending;
  assert.equal(manager.snapshot().browserSessions[a.id].state, 'canceled'); assert.equal(manager.snapshot().browserSessions[a.id].candidate, undefined);
});
test('确认期间关闭窗口，不能保存绑定', async t => {
  const { manager, accounts: [a], getDriver, store } = setup(t);
  await open(manager, a); let resolve;
  getDriver(a).nextRead = () => new Promise(r => { resolve = r; });
  const pending = manager.confirm(a.id); await manager.close(a.id);
  resolve({ identity: { platformAccountId: 'synthetic_1' }, state: 'identified' });
  await assert.rejects(pending, /已变化/); assert.equal(store.load().accounts[0].binding, null);
});
test('老师归属在候选期间改变，不能确认旧候选', async t => {
  const { manager, accounts: [a], store, teachers } = setup(t);
  await open(manager, a);
  model.saveManagedAccount(store, { id: a.id, teacherId: teachers[1].id, platform: a.platform, label: a.label });
  await assert.rejects(manager.confirm(a.id), /有效的候选/); assert.equal(store.load().accounts[0].binding, null);
});
test('解除绑定保留环境与登录窗口，清掉旧身份结果', async t => {
  const { manager, accounts: [a], store, getDriver } = setup(t);
  await open(manager, a); await manager.confirm(a.id); manager.unbind(a.id);
  assert.equal(store.load().accounts[0].binding, null); assert.ok(store.load().accounts[0].browserEnvironmentId);
  assert.equal(getDriver(a).isOpen(), true); assert.equal(manager.snapshot().browserChecks[a.id], undefined);
});
test('页面读取失败或登录过期会撤销旧的在线身份结论', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); const bound = await manager.confirm(a.id);
  getDriver(a).nextRead = () => { throw new Error('fixture read error'); };
  assert.equal((await manager.inspect(a.id)).state, 'unverifiable'); assert.equal(manager.isOnline(bound.binding.environmentId), false);
});
test('旧扩展与专属浏览器环境不能互相冒充', async t => {
  const { manager, accounts: [a], store } = setup(t);
  await open(manager, a);
  assert.throws(() => model.bindManagedAccount(store, { accountId: a.id, connectorInstanceId: randomUUID(), platformAccountId: 'legacy_fake', displayName: '', environmentLabel: '' }), /专属浏览器/);
  await manager.confirm(a.id);
  assert.throws(() => model.assertIdentity(store, { accountId: a.id, connectorInstanceId: randomUUID(), platformAccountId: 'synthetic_1' }), /专属浏览器/);
  assert.throws(() => model.bindBrowserAccount(store, { accountId: a.id, environmentId: randomUUID(), platformAccountId: 'fake', displayName: '' }), /归属不一致/);
});
test('官方页面只有唯一可见抖音号才识别，不能从其他页面或多个号认领', () => {
  const url = 'https://creator.douyin.com/creator-micro/home';
  assert.equal(parseIdentity(url, '抖音号： abc_123\n抖音号： abc_123').platformAccountId, 'abc_123');
  assert.equal(parseIdentity(url, '抖音号： abc_123\n抖音号： other_456'), null);
  assert.equal(parseIdentity(url.replace('creator.douyin.com', 'evil.example'), '抖音号： abc_123'), null);
  assert.equal(parseIdentity(url.replace('/home', '/content'), '抖音号： abc_123'), null);
  assert.equal(parseIdentity(url, '昵称：老师'), null);
  assert.equal(allowedNavigation('https://creator.douyin.com.evil.example/'), false);
  assert.equal(allowedNavigation('https://creator.douyin.com:444/'), false);
});
test('本机目录只接受内部UUID，拒绝路径穿越和符号链接', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-profile-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'profiles'), id = randomUUID();
  assert.throws(() => profileDirectory(root, '../other'), /无效/);
  const target = profileDirectory(root, id); assert.equal(path.dirname(target), fs.realpathSync(root));
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); const linked = randomUUID(); fs.symlinkSync(outside, path.join(root, linked), process.platform === 'win32' ? 'junction' : undefined);
  assert.throws(() => profileDirectory(root, linked), /符号链接/);
});
test('浏览器检测区分Mac/Windows和Chrome/Edge，不读取用户资料', () => {
  assert.deepEqual(browserAvailability('darwin', {}, p => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').map(x => x.available), [true, false]);
  assert.deepEqual(browserAvailability('win32', { PROGRAMFILES: '/programs' }, p => p.replaceAll('\\', '/').endsWith('Microsoft/Edge/Application/msedge.exe')).map(x => x.available), [false, true]);
  assert.deepEqual(browserAvailability('win32', { ProgramFiles: 'C:\\Program Files' }, p => p.replaceAll('\\', '/').endsWith('Google/Chrome/Application/chrome.exe')).map(x => x.available), [true, false]);
});
test('退出登录明确提示重新登录，同号回到原环境后恢复核验，绑定版本不变', async t => {
  const { manager, accounts: [a], getDriver, store, opened } = setup(t);
  await open(manager, a); const original = await manager.confirm(a.id);
  const d = getDriver(a), identity = { ...d.data.identity };
  d.data = { identity: null, state: 'awaiting_login', message: '扫码登录' };
  assert.equal((await manager.inspect(a.id)).state, 'login_required');
  assert.equal(manager.snapshot().browserSessions[a.id].state, 'login_required');
  assert.equal(manager.isOnline(original.binding.environmentId), false);
  assert.ok(manager.sessions.get(a.id).timer); // keep reading this same page; no login refresh
  d.data = { identity, state: 'identified' };
  assert.equal((await manager.inspect(a.id)).state, 'verified');
  assert.deepEqual(store.load().accounts[0].binding, original.binding); assert.equal(opened.length, 1);
});
test('退出后登成别的号不会恢复原任务身份，也不会改绑定', async t => {
  const { manager, accounts: [a], getDriver, store } = setup(t);
  await open(manager, a); const original = await manager.confirm(a.id);
  getDriver(a).data = { identity: null, state: 'awaiting_login' }; await manager.inspect(a.id);
  getDriver(a).data = { identity: { platformAccountId: 'another_teacher' }, state: 'identified' };
  assert.equal((await manager.inspect(a.id)).state, 'mismatch'); assert.deepEqual(store.load().accounts[0].binding, original.binding);
});
test('提前检查区分窗口未开与登录失效，打开后使用新回读而非旧成功记录', async t => {
  const { manager, accounts: [a], opened } = setup(t);
  await open(manager, a); await manager.confirm(a.id); await manager.close(a.id);
  const closed = await manager.checkReady({ accountIds: [a.id] });
  assert.equal(closed.ready, false); assert.equal(closed.results[0].state, 'offline'); assert.equal(opened.length, 1);
  const reopened = await manager.checkReady({ accountIds: [a.id], openMissing: true });
  assert.equal(opened.length, 2); assert.equal(reopened.ready, false); assert.equal(reopened.results[0].state, 'mismatch');
});
test('提前检查按所选账号汇总，去重并拒绝无界限或伪造参数', async t => {
  const { manager, accounts } = setup(t);
  for (const a of accounts) { await open(manager, a); await manager.confirm(a.id); }
  const result = await manager.checkReady({ accountIds: [accounts[0].id, accounts[1].id, accounts[0].id], openMissing: true });
  assert.equal(result.ready, true); assert.equal(result.results.length, 2); assert.ok(Date.parse(result.checkedAt));
  await assert.rejects(manager.checkReady({ accountIds: [], openMissing: true }), /不超过8/);
  await assert.rejects(manager.checkReady({ accountIds: [accounts[0].id], arbitraryPath: '/anything' }), /不超过8/);
});
test('明确登录界面优先于残留的账号文字，不能拿旧页面标识当作已登录', () => {
  assert.equal(observationFromPage({ url: 'https://creator.douyin.com/creator-micro/home', text: '抖音号： old_cached_id', loginVisible: true }).state, 'awaiting_login');
});
test('正常首页的作品标题含登录频繁文字时，不凭作品文字判定账号失效', () => {
  assert.equal(observationFromPage({ url: 'https://creator.douyin.com/creator-micro/home', text: '抖音号： valid_account\n最新作品：登录频繁怎么办', loginVisible: false }).state, 'identified');
  assert.equal(observationFromPage({ url: 'https://creator.douyin.com/', text: '登录频繁，请稍后再试', loginVisible: true }).state, 'error');
});

for (const platform of ['tencent', 'xiaohongshu']) {
  test(`${platform}：官方登录、确认归属、同号重登及异号阻止均走独立连接服务`, async t => {
    const { manager, accounts: [a], getDriver, store } = setup(t, { platforms: [platform, 'douyin'] });
    assert.equal((await open(manager, a)).platform, platform);
    const original = await manager.confirm(a.id), d = getDriver(a), identity = { ...d.data.identity };
    const env = store.load().environments.find(e => e.id === original.binding.environmentId);
    assert.equal(env.platform, platform);
    d.data = { state: 'awaiting_login', identity: null, message: '等待重新登录' };
    assert.equal((await manager.checkReady({ accountIds: [a.id] })).ready, false);
    assert.equal(manager.snapshot().browserSessions[a.id].state, 'login_required');
    d.data = { state: 'identified', identity };
    assert.equal((await manager.checkReady({ accountIds: [a.id] })).ready, true);
    assert.deepEqual(store.load().accounts.find(x => x.id === a.id).binding, original.binding);
    d.data.identity.platformAccountId = 'wrong_teacher';
    assert.equal((await manager.inspect(a.id)).state, 'mismatch');
    assert.deepEqual(store.load().accounts.find(x => x.id === a.id).binding, original.binding);
  });
}
test('提前复查不能直接复用正在进行的普通观察；必须另发 fresh 请求发现已失效', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); await manager.confirm(a.id);
  const d = getDriver(a), requests = [];
  d.read = async options => {
    requests.push(options?.fresh === true);
    return options?.fresh ? { state: 'awaiting_login', identity: null } : structuredClone(d.data);
  };
  const passive = manager.poll(manager.sessions.get(a.id));
  const result = await manager.checkReady({ accountIds: [a.id] }); await passive;
  assert.deepEqual(requests, [false, true]); assert.equal(result.ready, false); assert.equal(result.results[0].state, 'login_required');
});
test('取消观察后不能沿用旧成功，主动复查恢复新鲜核对', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); const original = await manager.confirm(a.id); manager.cancel(a.id);
  assert.equal(manager.isOnline(original.binding.environmentId), false);
  assert.equal(manager.snapshot().browserChecks[a.id], undefined);
  getDriver(a).data = { state: 'awaiting_login', identity: null };
  assert.equal((await manager.checkReady({ accountIds: [a.id] })).ready, false);
});
test('服务端检查时间过旧时，持续读到同一账号文字也不能延长在线结论', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); const original = await manager.confirm(a.id);
  getDriver(a).data.serverCheckedAt = Date.now() - 600_000;
  await manager.poll(manager.sessions.get(a.id));
  assert.equal(manager.isOnline(original.binding.environmentId), false);
});

test('服务端旧结果不能通过发布前新鲜复查，即使账号号与绑定一致', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); await manager.confirm(a.id);
  getDriver(a).data.serverCheckedAt = Date.now() - 600_000;
  const result = await manager.checkReady({ accountIds: [a.id] });
  assert.equal(result.ready, false); assert.equal(result.results[0].state, 'unverifiable');
});

test('明确退回登录页即使上一次服务端时间过旧，也应提示重新登录', async t => {
  const { manager, accounts: [a], getDriver } = setup(t);
  await open(manager, a); await manager.confirm(a.id);
  getDriver(a).data = { identity: null, state: 'awaiting_login', serverCheckedAt: Date.now() - 600_000 };
  assert.equal((await manager.inspect(a.id)).state, 'login_required');
});
test('账号双次核对并绑定成功后立即停止自动检查，保留登录窗口', async t=>{
 const {manager,accounts:[a],getDriver}=setup(t,{pollMs:5});
 await manager.open({accountId:a.id,autoBind:true});
 const d=getDriver(a),reads=d.reads;
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(manager.sessions.get(a.id).timer,null);assert.equal(d.reads,reads);assert.equal(d.isOpen(),true);
});
test('同时从多个检查入口核对同一账号只发一次新鲜读取',async t=>{
 const {manager,accounts:[a],getDriver}=setup(t);await manager.open({accountId:a.id,autoBind:true});
 const d=getDriver(a);let release;const reads=d.reads;d.nextRead=()=>new Promise(resolve=>{release=resolve;});
 const first=manager.inspect(a.id);while(!release)await new Promise(resolve=>setImmediate(resolve));
 const second=manager.inspect(a.id),third=manager.checkReady({accountIds:[a.id]});
 release(structuredClone(d.data));d.nextRead=null;
 const results=await Promise.all([first,second,third]);assert.equal(results[0].state,'verified');assert.equal(results[2].ready,true);assert.equal(d.reads,reads+1);
});
test('提前检查首次打开已绑定账号后直接使用本次结果，不立即再开第二次校验',async t=>{
 const {manager,accounts:[a],getDriver}=setup(t);await manager.open({accountId:a.id,autoBind:true});await manager.close(a.id);
 await manager.checkReady({accountIds:[a.id],openMissing:true});assert.equal(getDriver(a).reads,1);
});
test('等待扫码的自动观察只允许读取当前页，超过本轮期限后停止',async t=>{
 const {manager,accounts:[a],getDriver}=setup(t);await open(manager,a);const s=manager.sessions.get(a.id),d=getDriver(a);
 d.data={state:'awaiting_login',identity:null};s.startedAt=Date.now()-manager.candidateMs-1;
 await manager.poll(s,{passive:true});assert.equal(s.timer,null);assert.match(s.message,/停止/);
});
test('检查等待旧读取期间点击停止，迟到结果不能重新启动计时器或新鲜检查',async t=>{
 const {manager,accounts:[a],getDriver}=setup(t);await manager.open({accountId:a.id,autoBind:true});
 const d=getDriver(a);let release;d.nextRead=()=>new Promise(resolve=>{release=resolve;});
 const passive=manager.poll(manager.sessions.get(a.id),{passive:true});
 const inspection=manager.inspect(a.id);manager.cancel(a.id);d.nextRead=null;release(structuredClone(d.data));
 await Promise.all([passive,inspection]);assert.equal(manager.sessions.get(a.id).state,'canceled');assert.equal(manager.sessions.get(a.id).timer,null);
});
test('用户停止后仍可明确发起一次新检查，成功后绑定不变且不自动继续',async t=>{
 const {manager,accounts:[a],store}=setup(t);await manager.open({accountId:a.id,autoBind:true});const binding=structuredClone(store.load().accounts[0].binding);
 manager.cancel(a.id);assert.equal((await manager.inspect(a.id)).state,'verified');assert.equal(manager.sessions.get(a.id).timer,null);assert.deepEqual(store.load().accounts[0].binding,binding);
});
test('打开与检查同时等待读取时停止，两个入口都不能迟到恢复检查',async t=>{
 const {manager,accounts:[a],getDriver}=setup(t);await manager.open({accountId:a.id,autoBind:true});
 const d=getDriver(a),s=manager.sessions.get(a.id);let release;d.nextRead=()=>new Promise(resolve=>{release=resolve;});
 const passive=manager.poll(s,{passive:true}),opening=manager.open({accountId:a.id});
 while(s.state!=='checking')await new Promise(resolve=>setImmediate(resolve));
 const inspection=manager.inspect(a.id);manager.cancel(a.id);d.nextRead=null;release(structuredClone(d.data));
 await Promise.all([passive,opening,inspection]);assert.equal(s.state,'canceled');assert.equal(s.timer,null);
});
test('同时请求正常打开与核验可共享已完成的本次结果，不误判为停止',async t=>{
 const {manager,accounts:[a],getDriver}=setup(t);await manager.open({accountId:a.id,autoBind:true});
 const d=getDriver(a),reads=d.reads;const opening=manager.open({accountId:a.id}),inspection=manager.inspect(a.id);
 const result=await Promise.all([opening,inspection]);assert.equal(result[0].state,'verified');assert.equal(result[1].state,'verified');assert.equal(d.reads,reads+1);assert.equal(manager.sessions.get(a.id).timer,null);
});
