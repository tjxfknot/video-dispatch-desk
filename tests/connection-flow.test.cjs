'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright-core');
const {browserAvailability,createPageDriver}=require('../app/core/browser-driver.cjs');
const {observeSelfIdentity}=require('../app/core/browser-self-identity.cjs');
const {ManagedBrowsers}=require('../app/core/managed-browser.cjs');
const {JsonStore}=require('../app/core/store.cjs');
const model=require('../app/core/accounts.cjs'),{emptyState}=require('../app/core/domain.cjs');
const readiness=require('../app/renderer/publish-readiness.js');
const {buildManagedPlan}=require('../app/core/managed-publish-job.cjs');
const {BROWSER_PLATFORMS}=require('../app/core/browser-platforms.cjs');
const available=browserAvailability().find(b=>b.available);

test('真实浏览器中的登录→自动识别→复核→业务库保存→发布就绪与总览完整连接；所有网页和响应均为本机合成',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'connection-flow-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const platform of ['tencent','xiaohongshu'])await t.test(platform,async()=>{
  const config=BROWSER_PLATFORMS[platform],context=await browser.newContext({serviceWorkers:'block'}),requests=[];
  const expected=platform==='tencent'?'synthetic_video_account':'0123456789abcdef01234567';
  let failProbe=false;
  await context.route('**/*',async route=>{
   const r=route.request();requests.push({url:r.url(),method:r.method(),navigation:r.isNavigationRequest()});
   if(r.method()!=='GET')return route.abort();
   if(r.url()===config.entry)return route.fulfill({contentType:'text/html; charset=utf-8',body:`<h1>扫码登录</h1><button onclick="location.href='${config.home}'">模拟用户已登录</button>`});
   if(r.url()===config.home){
    if(failProbe)return route.fulfill({status:503,body:'isolated server failure'});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<h1>合成官方首页</h1><input aria-label="原输入" value="原输入不能丢失">${platform==='tencent'?'<p>视频号ID：'+expected+'</p>':'<p>此版首页不主动请求账号信息</p>'}`});
   }
   if(platform==='xiaohongshu' && r.url()===config.origin+'/api/galaxy/user/info')return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,code:0,data:{userId:expected,userName:'合成当前账号'}})});
   return route.abort();
  });
  const own=observeSelfIdentity(context,platform),initial=await context.newPage();let originalReloads=0;
  const oldReload=initial.reload.bind(initial);initial.reload=(...args)=>{originalReloads++;return oldReload(...args);};
  const store=new JsonStore(path.join(root,platform+'.json'),emptyState());model.ensureAccountState(store);
  const teacher=model.saveTeacher(store,{name:'合成老师'}),account=model.saveManagedAccount(store,{teacherId:teacher.id,platform,label:'合成账号'});
  const manager=new ManagedBrowsers({store,profilesRoot:root,pollMs:10,diagnosticsRoot:path.join(root,'diagnostics'),availability:()=>[{id:available.id,available:true}],launch:async({onReadPage})=>{
   await initial.goto(config.entry,{waitUntil:'commit'});
   return createPageDriver({context,page:initial,platform,readOwnIdentity:own,onReadPage,settleMs:1000});
  }});
  try{
   assert.equal((await manager.open({accountId:account.id,browserKind:available.id,autoBind:true})).state,'awaiting_login');
   await initial.getByRole('button',{name:'模拟用户已登录'}).click();
   await initial.getByRole('textbox',{name:'原输入'}).waitFor();
   await manager.poll(manager.sessions.get(account.id));
   // 10ms自动观察可能正读登录跳转前的文档；等待产品自己的下一次被动观察，
   // 不代发fresh请求。最终必须自动绑定并停止。
   const deadline=Date.now()+3000;
   while(manager.sessions.get(account.id).state!=='bound' && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(manager.sessions.get(account.id).state,'bound');
   const disk=JSON.parse(fs.readFileSync(store.filePath));assert.equal(disk.accounts[0].binding.platformAccountId,expected);
   assert.equal(manager.sessions.get(account.id).timer,null,'真实浏览器完成连接后停止自动轮询');
   assert.equal(originalReloads,0);assert.equal(await initial.getByRole('textbox',{name:'原输入'}).inputValue(),'原输入不能丢失');
   assert.equal(context.pages().length,2,'保留原页面，最多一个自建校验页');
   const identityTab=context.pages().find(p=>p!==initial);
   if(platform==='tencent')await identityTab.evaluate(()=>document.querySelector('p').remove());
   else await identityTab.evaluate(()=>history.replaceState({},'',location.pathname+'?tab=notes'));
   const navigations=requests.filter(r=>r.navigation).length;
   await new Promise(resolve=>setTimeout(resolve,100));
   assert.equal(requests.filter(r=>r.navigation).length,navigations,'连接成功后原SPA变化不会在后台循环开新页');
   assert.equal((await manager.poll(manager.sessions.get(account.id))).state,'verified','连接后普通复查应处理SPA切换或重新读取当前账号，不能立即丢失连接');
   assert.equal(context.pages().length,2);assert.equal(originalReloads,0);
   const beforeExplicit=requests.filter(r=>r.navigation).length;
   const simultaneous=await Promise.all([manager.inspect(account.id),manager.inspect(account.id),manager.checkReady({accountIds:[account.id]})]);
   assert.equal(simultaneous[2].ready,true);assert.equal(context.pages().length,2);
   assert.equal(requests.filter(r=>r.navigation).length,beforeExplicit+1,'同时的显式检查合并成一次服务器校验');
   const current=store.load().accounts[0];assert.equal(readiness.accountState(current,{...store.load(),...manager.snapshot(),accountChecks:manager.snapshot().browserChecks}).key,'verified');
   const video={id:'synthetic-video',kind:'video',path:'/synthetic/never-uploaded.mp4',name:'隔离视频.mp4',size:10,mtimeMs:1};
   store.update(s=>s.assets.push(video));
   const draft={teacherId:teacher.id,video,common:{title:'连接完整流程',description:'完全本机合成',tags:[]},targets:[{platform,enabled:true,accountId:account.id}]};
   const plan=buildManagedPlan(draft,store.load(),()=>({isFile:()=>true,size:10,mtimeMs:1}));assert.equal(plan.jobs.length,1);assert.equal(plan.jobs[0].expectedBinding.platformAccountId,expected);
   failProbe=true;const failed=await manager.inspect(account.id);assert.equal(failed.state,'unverifiable');assert.match(failed.message,/HTTP 503/);
   assert.equal(store.load().accounts[0].binding.platformAccountId,expected);assert.equal(await initial.getByRole('textbox',{name:'原输入'}).inputValue(),'原输入不能丢失');
   const record=JSON.parse(fs.readFileSync(path.join(root,'diagnostics',current.browserEnvironmentId+'.json')));assert.equal(record.failure.httpStatus,503);
   assert.equal(JSON.stringify(record).includes(expected),false);assert.equal(store.load().runs.length,0);
   assert.ok(requests.every(r=>r.method==='GET'));assert.ok(requests.every(r=>[config.entry,config.home,config.origin+'/api/galaxy/user/info'].includes(r.url)));
  }finally{await manager.closeAll();await context.close();}
 });
});

test('小红书只接受本页自身用户响应，错误响应、非法标识和重载前缓存不能认领',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'}),origin=BROWSER_PLATFORMS.xiaohongshu.origin;
 let payload={success:true,data:{userId:'0123456789abcdef01234567',userName:'合成用户'}};
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/new/home')return route.fulfill({contentType:'text/html',body:'<body>Own creator home</body>'});
  if(u.pathname==='/api/galaxy/user/info')return route.fulfill({contentType:'application/json',body:JSON.stringify(payload)});
  return route.abort();
 });
 const read=observeSelfIdentity(context,'xiaohongshu'),page=await context.newPage();await page.goto(origin+'/new/home');
 const fetchOwn=()=>page.evaluate(()=>fetch('/api/galaxy/user/info').then(r=>r.json()));
 await fetchOwn();assert.equal((await read(page)).identity.platformAccountId,payload.data.userId);
 payload={success:false,data:{userId:'0123456789abcdef01234567'}};await page.reload();assert.equal((await read(page)).identity,null);
 payload={success:false,data:{userId:'0123456789abcdef01234567'}};await fetchOwn();assert.equal((await read(page)).identity,null);
 payload={success:true,data:{userId:'nickname_is_not_an_id'}};await fetchOwn();assert.equal((await read(page)).identity,null);
 await context.close();
});
