'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitForVideoUpload,readUploadSnapshot,uploadSurface,UPLOAD_MAX_MS}=require('../app/core/upload-wait.cjs');

function clock(){let time=0;return {now:()=>time,pause:async ms=>{time+=ms;}};}
test('162MB慢速上传持续前进超过三分钟和十五分钟，等待完成而不重传',async()=>{
  const c=clock(),events=[];let reads=0;
  const result=await waitForVideoUpload({...c,pollMs:30000,onProgress:s=>events.push(s),read:async()=>{reads++;return {loaded:c.now()/1000*154*1024,complete:c.now()>=20*60000,summary:'162.3MB 视频正在上传'};}});
  assert.equal(result.complete,true);assert.equal(c.now(),20*60000);assert.equal(reads,41);assert(events.length>3);assert(UPLOAD_MAX_MS>c.now());
});
test('上传停滞使用最后一次实际进展计时，速度或剩余时间波动不能无限续命',async()=>{
  const c=clock();let n=0;
  await assert.rejects(waitForVideoUpload({...c,pollMs:1000,idleMs:5000,maxMs:60000,read:async()=>({loaded:25*1024*1024,complete:false,summary:`速度${++n}KB/s`})}),{code:'UPLOAD_STALLED'});
  assert.equal(c.now(),5000);
});
test('100%进度必须等待平台完成证据；实际上传错误立即停止',async()=>{
  const c=clock();let n=0;
  await assert.rejects(waitForVideoUpload({...c,read:async()=>({percent:100,complete:false,failed:++n===2?'转码失败':''})}),{code:'UPLOAD_PLATFORM_FAILED'});
  assert.equal(n,2);
});
test('等待期间停止任务不再读取或触发下一阶段，原上传不自动重试',async()=>{
  const c=clock(),controller=new AbortController();let reads=0;
  await assert.rejects(waitForVideoUpload({...c,signal:controller.signal,read:async()=>{reads++;controller.abort();return {complete:true};}}),{code:'UPLOAD_STOPPED'});
  assert.equal(reads,1);
});
test('持续有进度仍遵守总等待上限，不无限等待',async()=>{
  const c=clock();
  await assert.rejects(waitForVideoUpload({...c,pollMs:1000,maxMs:5000,idleMs:3000,read:async()=>({loaded:c.now(),complete:false})}),{code:'UPLOAD_WAIT_LIMIT'});
  assert.equal(c.now(),5000);
});

const {chromium}=require('playwright-core');
const available=require('../app/core/browser-driver.cjs').browserAvailability().find(b=>b.available);
test('真实浏览器只读取本机合成的上传进度，不把本地视频预览当成上传完成',{skip:!available,timeout:20000},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  await page.setContent('<video style="width:200px;height:100px" src="blob:synthetic"></video><p>已上传：25.8MB/162.3MB</p><p>当前速度：154.0KB/s</p><button>取消上传</button><div>上传成功</div><span>重新上传</span>');
  await page.locator('video').evaluate(v=>Object.defineProperty(v,'readyState',{value:1}));
  for(const mode of ['native','douyin']){
    const state=await page.locator('body').evaluate(readUploadSnapshot,{mode,before:{sources:[],completeMarkers:0}});
    assert.equal(state.complete,false);assert.equal(state.loaded,25.8*1024**2);assert.match(state.summary,/25.8MB/);
  }
  await page.setContent('<p>上传完成</p><span>重新上传</span>');
  for(const mode of ['native','douyin'])assert.equal((await page.locator('body').evaluate(readUploadSnapshot,{mode,before:{sources:[],completeMarkers:0}})).complete,true);
});

test('抖音实际页面说明和可发布的预览转码不冒充仍在上传',{skip:!available,timeout:20000},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  const advice='<p>点击发布后，如作品还在上传中，请勿关闭页面，等待上传发布完成。</p>';
  const preview='<p>预览转码中，请稍后</p><p>转码过程也可以发布作品</p>';
  const read=mode=>page.locator('body').evaluate(readUploadSnapshot,{mode,before:{sources:[],completeMarkers:0}});
  await page.setContent(advice+preview+'<span>重新上传</span><p>上传成功</p>');
  assert.equal((await read('douyin')).complete,true);
  await page.setContent(advice+preview+'<p>已上传：160.7MB/162.3MB</p><button>取消上传</button><span>重新上传</span>');
  assert.equal((await read('douyin')).complete,false);
  await page.setContent(advice+preview);
  assert.equal((await read('douyin')).complete,false);
  await page.setContent(advice+'<p>正在转码，请稍后</p><span>重新上传</span><p>上传成功</p>');
  assert.equal((await read('douyin')).complete,false);
  assert.equal((await read('native')).complete,false);
  await page.setContent(preview+'<p>上传成功</p>');
  assert.equal((await read('native')).complete,false);
  await page.setContent(advice+'<span>重新上传</span><p>上传失败</p>');
  assert.equal((await read('douyin')).failed,'上传失败');
});

test('没有进度文字也不能把刚选文件就出现的本地预览当作上传完成',{skip:!available,timeout:20000},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  await page.setContent('<video style="width:200px;height:100px" src="blob:https://local.invalid/new-video"></video>');
  await page.locator('video').evaluate(v=>Object.defineProperty(v,'readyState',{value:1}));
  const read=()=>page.locator('body').evaluate(readUploadSnapshot,{mode:'native',before:{sources:[],completeMarkers:0}});
  assert.equal((await read()).complete,false);assert.equal((await read()).previewOnly,true);
  await page.locator('video').evaluate(v=>v.src='https://media.invalid/completed-video.mp4');
  assert.equal((await read()).complete,true);
  await page.locator('body').evaluate(el=>{const bar=document.createElement('progress');bar.max=100;bar.value=45;el.append(bar);});
  assert.equal((await read()).complete,false,'远程预览也不能盖过尚未走完的上传进度');
  await page.locator('progress').evaluate(el=>el.value=100);assert.equal((await read()).complete,true);
});

test('上传区域被页面替换时立即停止，不把旧层文字当进度或完成，也不重传',async()=>{
  const c=clock();let reads=0;
  await assert.rejects(waitForVideoUpload({...c,read:async()=>(++reads===2?{lost:true,complete:false}:{complete:false,loaded:reads})}),{code:'UPLOAD_SURFACE_LOST'});
  assert.equal(reads,2);
});

test('页面有两层 body（视频号助手）时，上传进度只读视频控件所在那层；shadow 与普通嵌套两种结构都覆盖',{skip:!available,timeout:20000},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  const form='<input type="file" accept="video/mp4"><p>已上传：25.8MB/162.3MB</p><button>取消上传</button>';
  const outer='<nav>视频号 · 助手 首页 内容管理 上传成功（旧通知）</nav>';
  const layouts={
    shadow:`<body data-ml-root="true" class="__finder-page">${outer}<div id="host"></div><script>{const root=host.attachShadow({mode:'open'}),html=document.createElement('html'),body=document.createElement('body');body.setAttribute('data-ml-root','true');body.className='__finder-page';body.innerHTML=${JSON.stringify(form)};html.append(body);root.append(html);}</script></body>`,
    light:`<body data-ml-root="true" class="__finder-page">${outer}<div id="layer"></div><script>{const body=document.createElement('body');body.setAttribute('data-ml-root','true');body.className='__finder-page';body.innerHTML=${JSON.stringify(form)};layer.append(body);}</script></body>`
  };
  for(const [name,html] of Object.entries(layouts)){
    await page.setContent(html);
    assert.equal(await page.locator('body').count(),2,name);
    await assert.rejects(page.locator('body').evaluate(b=>b.tagName,null,{timeout:1000}),/strict mode violation/,name);
    const surface=await uploadSurface(page.locator('input[type="file"]'));
    assert.deepEqual(await surface.describe(),{inShadowRoot:name==='shadow',isDocumentBody:false},name);
    // 外层的旧“上传成功”不进入基线，也不让本次判成完成。
    assert.deepEqual(await surface.baseline(),{sources:[],completeMarkers:0},name);
    let state=await surface.read({mode:'native',before:{sources:[],completeMarkers:0}});
    assert.equal(state.complete,false,name);assert.equal(state.loaded,25.8*1024**2,name);
    await page.locator('input[type="file"]').evaluate(input=>{const body=input.closest('body');body.innerHTML='<p>上传完成</p>';});
    state=await surface.read({mode:'native',before:{sources:[],completeMarkers:0}});
    assert.equal(state.complete,true,name);
    await page.locator('nav').evaluate((nav,isShadow)=>{if(isShadow)document.getElementById('host').remove();else document.getElementById('layer').remove();},name==='shadow');
    assert.equal((await surface.read({mode:'native',before:{sources:[],completeMarkers:0}})).lost,true,name);
  }
});
