'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BROWSER_PLATFORMS, parseIdentity, observationFromPage, allowedNavigation } = require('../app/core/browser-platforms.cjs');
const { createPageDriver } = require('../app/core/browser-driver.cjs');
for (const [platform, c] of Object.entries(BROWSER_PLATFORMS)) {
  test(`${c.label}：仅在官方身份首页接受明确标示的唯一账号号，昵称和作品页不认领`, () => {
    const label = c.idLabel;
    const id = 'account_123', other = 'other_456';
    assert.equal(parseIdentity(c.home, `${label}： ${id}`, platform)?.platformAccountId, id);
    assert.equal(parseIdentity(c.home, `${label}： ${id}\n${label}： ${other}`, platform), null);
    assert.equal(parseIdentity(c.home, '昵称：示例创作者', platform), null);
    assert.equal(parseIdentity(`${c.origin}/platform/post/create`, `${label}： account_123`, platform), null);
    assert.equal(parseIdentity(c.home, `作品标题：${label}： account_123`, platform), null);
    assert.equal(parseIdentity(c.home.replace(new URL(c.home).hostname, 'evil.example'), `${label}： account_123`, platform), null);
    assert.equal(observationFromPage({ url: c.home, text: `${label}： cached_id`, loginVisible: true }, platform).state, 'awaiting_login');
    assert.equal(allowedNavigation(c.origin + '.evil.example/home', platform), false);
    assert.equal(allowedNavigation(c.origin.replace('https:', 'http:'), platform), false);
    assert.equal(allowedNavigation(c.origin + ':444/home', platform), false);
    for (const other of Object.values(BROWSER_PLATFORMS).filter(o => o !== c)) assert.equal(allowedNavigation(other.home, platform), false);
  });
}
test('小红书新旧首页均识别明确账号号，作品页和其他路径仍不能冒充身份', () => {
  for(const pathname of ['/home','/new/home']){
    assert.equal(observationFromPage({url:'https://creator.xiaohongshu.com'+pathname,text:'小红书号：synthetic_xhs123',loginVisible:false},'xiaohongshu').state,'identified');
  }
  for(const pathname of ['/new/note-manager','/new/home-evil','/publish/publish']){
    assert.equal(observationFromPage({url:'https://creator.xiaohongshu.com'+pathname,text:'小红书号：synthetic_xhs123',loginVisible:false},'xiaohongshu').identity,null);
  }
  assert.equal(observationFromPage({url:'https://creator.xiaohongshu.com/new/home',text:'昵称：某老师',loginVisible:false},'xiaohongshu').identity,null);
});
test('视频号、小红书明确登录路径优先于残留账号文字', () => {
  for (const platform of ['tencent', 'xiaohongshu']) {
    const c = BROWSER_PLATFORMS[platform];
    assert.equal(observationFromPage({ url: c.entry, text: `${c.idLabel}： cached_123`, loginVisible: false }, platform).state, 'awaiting_login');
    assert.equal(observationFromPage({ url: c.home, text: '首页', loginVisible: false }, platform).state, 'checking');
  }
});
test('抖音自己的资料头部可识别与昵称同行的账号，页面其他文字不能冒充身份', () => {
  const url = BROWSER_PLATFORMS.douyin.home;
  const header = '测试昵称 抖音号： synthetic_test123 | 测试简介\n关注 130 粉丝 23 获赞 46';
  assert.equal(parseIdentity(url, header, 'douyin'), null, '正文解析仍要求独立标签，不能凭任意行内文字认领');
  const observation = observationFromPage({url,text:'消息：抖音号： other_account',profileHeaderText:header,loginVisible:false},'douyin');
  assert.equal(observation.state,'identified');
  assert.equal(observation.identity.platformAccountId,'synthetic_test123');
  assert.equal(observationFromPage({url,text:header,loginVisible:false},'douyin').state,'checking');
  assert.equal(observationFromPage({url,text:header,profileHeaderText:header+'\n另一个资料 抖音号： second_account',loginVisible:false},'douyin').state,'checking');
  assert.equal(observationFromPage({url,text:header,profileHeaderText:header,loginVisible:true},'douyin').state,'awaiting_login');
  assert.equal(observationFromPage({url:'https://creator.douyin.com/creator-micro/content/upload',text:header,profileHeaderText:header,loginVisible:false},'douyin').state,'checking');
});
// readPage waits for any body, then reads all body layers with evaluateAll.
const fakeBody = read => ({ first: () => ({ waitFor: async () => {} }), evaluate: read, evaluateAll: read });
function driverFixture(platform = 'tencent', settleMs = 0) {
  const config = BROWSER_PLATFORMS[platform];
  let now = 1_000_000, open = true;
  const pages = [];
  function makePage() {
    const p = { currentUrl: config.home, text: `${config.idLabel}： same_account`, loginVisible: false, reloads: 0, visits: [],
      url: () => p.currentUrl, isClosed: () => !open || !!p.closed, bringToFront: async () => {}, close:async()=>{p.closed=true;},
      reload: async options => { p.reloadOptions=options;p.reloads++; if (p.onReload) await p.onReload();return {status:()=>p.responseStatus || 200}; },
      goto: async url => { p.visits.push(url); p.currentUrl = url;return {status:()=>200}; },
      locator: () => fakeBody(async () => {if(p.timeoutReads>0){p.timeoutReads--;const e=new Error('body loading');e.name='TimeoutError';throw e;}return { url: p.currentUrl, text: p.text, loginVisible: p.loginVisible };}) };
    pages.push(p); return p;
  }
  const page = makePage(), context = { newPage: async () => makePage(), close: async () => { open = false; } };
  const driver = createPageDriver({ context, page, platform, now: () => now, settleMs,pause:async ms=>{now+=ms;} });
  return { driver, page, pages, context, makePage, advance: ms => { now += ms; } };
}
test('主动核验必须重新访问服务端；普通观察不反复刷新；间隔复查可发现过期', async () => {
  const { driver, page, advance } = driverFixture('douyin');
  assert.equal((await driver.read()).state, 'identified'); assert.equal(page.reloads, 0);
  assert.equal((await driver.read({ fresh: true })).state, 'identified'); assert.equal(page.reloads, 1);
  page.onReload = () => { page.currentUrl = BROWSER_PLATFORMS.douyin.entry; page.loginVisible = true; };
  advance(300_001);
  assert.equal((await driver.read()).state, 'awaiting_login'); assert.equal(page.reloads, 2);
  await driver.read({ fresh: true }); advance(400_000); await driver.read();
  assert.equal(page.reloads, 2, '登录页不自动刷新二维码');
});
test('等待登录的被动观察即使身份曾成功或时间已过，也不能反复新开或刷新页面',async()=>{
 const f=driverFixture('tencent');assert.equal((await f.driver.read()).state,'identified');f.page.text='首页';f.advance(600000);
 for(let i=0;i<5;i++)assert.equal((await f.driver.read({passive:true})).state,'checking');
 assert.equal(f.pages.length,1);assert.equal(f.page.reloads,0);
});
test('新的身份校验页没有本次账号时停止并保留原已登录页，不把失败页当成当前页',async()=>{
 const f=driverFixture('tencent');const originalText=f.page.text;
 f.context.newPage=async()=>{const p=f.makePage();p.text='登录中';p.loginVisible=true;return p;};
 const result=await f.driver.read({fresh:true});assert.equal(result.state,'unverifiable');assert.equal(f.pages[1].closed,true);assert.equal(f.page.closed,undefined);assert.equal(f.page.text,originalText);
 assert.equal((await f.driver.read({passive:true})).state,'unverifiable');assert.equal(f.pages.length,2,'失败后不会自动再开页面或沿用原页旧身份');
});
test('被动观察遇到登录跳转的临时文档销毁只等待原页，不打开新页也不锁死后续识别',async()=>{
 const f=driverFixture('tencent');f.page.timeoutReads=1;
 assert.equal((await f.driver.read({passive:true})).state,'checking');
 assert.equal((await f.driver.read({passive:true})).state,'identified');assert.equal(f.pages.length,1);
});
test('用户切到编辑页时，核验新开同窗口标签，不刷新或关闭原输入页面', async () => {
  const { driver, page, pages } = driverFixture('xiaohongshu');
  page.currentUrl = 'https://creator.xiaohongshu.com/publish/publish'; page.text = '用户未保存的文案';
  assert.equal((await driver.read({ fresh: true })).state, 'identified');
  assert.equal(page.reloads, 0); assert.equal(page.text, '用户未保存的文案'); assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].visits, [BROWSER_PLATFORMS.xiaohongshu.home]);
});
test('刷新失败不能返回旧的身份成功', async () => {
  const { driver, page } = driverFixture('douyin'); await driver.read();
  page.onReload = () => { throw new Error('离线'); };
  await assert.rejects(driver.read({ fresh: true }), /离线/);
});

test('视频号确认读取旧DOM异常时独立获取新文档，原账号页不刷新，失败不得复用旧身份',async()=>{
 const {driver,page,pages,context,makePage}=driverFixture('tencent');
 page.locator=()=>fakeBody(async()=>{throw new Error('Execution context was destroyed');});
 const result=await driver.read({fresh:true});assert.equal(result.state,'identified');
 assert.equal(page.reloads,0);assert.equal(page.closed,undefined);assert.equal(pages.length,2);
 // 2026-11-11：第二次校验复用同一个校验页（不再新开一页、关上一页）。它加载失败时同样必须报错，不能返回旧身份。
 context.newPage=async()=>{throw new Error('复用校验页时不应再新开标签页');};
 pages[1].goto=async()=>{throw new Error('net::ERR_FAILED');};
 await assert.rejects(driver.read({fresh:true}),/ERR_FAILED/);assert.equal(page.closed,undefined);assert.equal(pages.length,2);
});

test('连续多次主动核验复用同一个校验页：不新开、不关闭，每次都重新向服务器取首页；换号或读不到时不沿用旧结果',async()=>{
 const {driver,page,pages}=driverFixture('xiaohongshu');
 page.currentUrl='https://creator.xiaohongshu.com/publish/publish';page.text='用户尚未保存的文案';
 for(let i=0;i<3;i++)assert.equal((await driver.read({fresh:true})).state,'identified');
 assert.equal(pages.length,2,'三次核验只应有原页和一个校验页');
 assert.equal(pages[1].visits.length,3,'每次核验都重新访问服务器');assert.equal(pages[1].closed,undefined);
 assert.equal(page.closed,undefined);assert.equal(page.reloads,0);assert.equal(page.text,'用户尚未保存的文案');
 // 同一校验页这次读到了另一个号：必须如实返回新号，由上层判定不一致
 pages[1].text='小红书号： other_account';
 const changed=await driver.read({fresh:true});assert.equal(changed.identity.platformAccountId,'other_account');
 // 同一校验页这次读不到账号：不得沿用之前的成功，也不为此开关标签页
 pages[1].text='页面没有账号标识';
 const failed=await driver.read({fresh:true});assert.equal(failed.state,'unverifiable');assert.equal(failed.identity,null);
 assert.equal(pages.length,2);assert.equal(pages[1].closed,undefined);
 assert.equal((await driver.read({passive:true})).state,'unverifiable','失败后被动读取不能恢复成已识别');
});

test('新校验标签加载失败时关闭失败空白页，保留原编辑页和输入；不能返回旧身份成功',async()=>{
 const {driver,page,pages,context,makePage}=driverFixture('xiaohongshu');
 page.currentUrl='https://creator.xiaohongshu.com/publish/publish';page.text='用户尚未保存的文案';
 context.newPage=async()=>{const probe=makePage();probe.currentUrl='about:blank';probe.goto=async()=>{throw new Error('net::ERR_CONNECTION_TIMED_OUT');};return probe;};
 await assert.rejects(driver.read({fresh:true}),/ERR_CONNECTION_TIMED_OUT/);
 assert.equal(pages[1].closed,true);assert.equal(page.closed,undefined);assert.equal(page.text,'用户尚未保存的文案');
 assert.equal(page.currentUrl,'https://creator.xiaohongshu.com/publish/publish');
 // The retained page is still the driver target; the closed failed probe is
 // never adopted. A new explicit attempt can recover in the same environment.
 context.newPage=async()=>makePage();
 const result=await driver.read({fresh:true});assert.equal(result.state,'identified');assert.equal(pages[2].visits[0],BROWSER_PLATFORMS.xiaohongshu.home);
});

test('新校验页服务器异常也保留原页；空白页只显示未打开，不能生成绑定候选',async()=>{
 const {driver,page,pages,context,makePage}=driverFixture('xiaohongshu');page.currentUrl='about:blank';page.text='';
 assert.equal((await driver.read()).state,'unverifiable');
 context.newPage=async()=>{const probe=makePage();probe.goto=async url=>{probe.currentUrl=url;return {status:()=>503};};return probe;};
 await assert.rejects(driver.read({fresh:true}),/本次服务器响应/);assert.equal(pages[1].closed,true);assert.equal(page.currentUrl,'about:blank');
});

test('账号刷新以新服务器文档和身份回读为准，服务端异常不能沿用旧身份',async()=>{
 const {driver,page}=driverFixture('douyin');await driver.read({fresh:true});
 assert.equal(page.reloadOptions.waitUntil,'commit');page.responseStatus=503;
 await assert.rejects(driver.read({fresh:true}),/本次服务器响应/);
});

test('新服务器文档暂时没有body时有限等待，回读新身份，不沿用刷新前账号',async()=>{
 const {driver,page}=driverFixture('douyin',1000);await driver.read();
 page.onReload=()=>{page.timeoutReads=2;page.text=BROWSER_PLATFORMS.douyin.idLabel+'： changed_account';};
 const check=await driver.read({fresh:true});assert.equal(check.identity.platformAccountId,'changed_account');
 page.onReload=()=>{page.timeoutReads=100;};await assert.rejects(driver.read({fresh:true}),/body loading/);
});
test('登录路径尚无登录控件时等待恢复跳转，不能在空白占位阶段误报已掉线',async()=>{
 const {driver,page}=driverFixture('xiaohongshu',1000);let reads=0;
 page.currentUrl=BROWSER_PLATFORMS.xiaohongshu.entry;page.text='';
 page.locator=()=>fakeBody(async()=>{
  reads++;if(reads===1)return {url:page.currentUrl,text:'',loginVisible:false};
  page.currentUrl=BROWSER_PLATFORMS.xiaohongshu.home;
  return {url:page.currentUrl,text:'小红书号：synthetic_owner',loginVisible:false};
 });
 assert.equal((await driver.read()).state,'identified');assert.ok(reads>=3);
});

test('复用校验页导航失败后保留失败状态；旧DOM即使有账号也不能被动恢复，手动重试才恢复', async () => {
  const f = driverFixture('xiaohongshu');
  await f.driver.read({ fresh: true });
  const probe = f.pages[1], goto = probe.goto;
  probe.goto = async () => { throw new Error('net::ERR_FAILED'); };
  await assert.rejects(f.driver.read({ fresh: true }), /ERR_FAILED/);
  assert.equal(probe.closed, undefined);
  for (let i = 0; i < 3; i++) {
    const result = await f.driver.read({ passive: true });
    assert.equal(result.state, 'unverifiable'); assert.equal(result.identity, null); assert.equal(result.serverCheckedAt, 0);
  }
  assert.equal(f.pages.length, 2);
  probe.goto = goto; probe.text = '小红书号： recovered_account';
  const recovered = await f.driver.read({ fresh: true });
  assert.equal(recovered.identity.platformAccountId, 'recovered_account');
  assert.equal(f.pages.length, 2); assert.equal(f.page.closed, undefined);
});
