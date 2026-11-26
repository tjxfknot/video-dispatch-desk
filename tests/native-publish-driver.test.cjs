'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright-core');
const {browserAvailability}=require('../app/core/browser-driver.cjs');
const {createNativePublisher,NATIVE_CONFIG}=require('../app/core/native-publish-driver.cjs');
const available=browserAvailability().find(b=>b.available);
const urls={tencent:'https://channels.weixin.qq.com/platform/post/detail?feedId=synthetic_feed_123',xiaohongshu:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567'};
test('两平台原生执行器在隔离页面完成真实控件流程，外部请求全部阻止或本机合成',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-native-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const video=path.join(dir,'合成视频.mp4');fs.writeFileSync(video,'offline synthetic fixture, never sent to a server');
 async function fixture(platform,{allowSubmit=true,tags=['游戏'],cover=false,modernCover=false,coverDelay=0,uploadDelay=0,nativeCoverEdit=false,coverReadyDelay=0,passiveCoverWrapper=false,localPreview=false,uploadWaitMs=1500,coverWaitMs=1500,shortTitleValue='',omitShortTitle=false,tencentLocation=false,editableValue='true',nestedEditor=false,duplicateEditor=false,initialBlank=false,securityInstead=false,popupEntry=false,reuseEntry=false,existingEditor=false,footerFrame=false,closedFooter=false,footerDisabled=false,oldUpload=false,twoBodies=false,confirmation=false,wrongCover=false,iframe=false,missingInput=false,diagnosticThrows=false,diagnosticsRoot,topicMetrics=false,omitDeclaration=false,verifyIdentity=async()=>{}}={}){
  const config=NATIVE_CONFIG[platform],context=await browser.newContext({serviceWorkers:'block'}),requests=[],steps=[];
  const job={platform,teacherId:'t',accountId:'a',fingerprint:'fp-'+platform,copy:{title:'多平台功能验证',description:'合成正文，仅用于隔离验证',tags},declarationText:'',settings:{visibility:'platform_default',savePermission:'platform_default'},files:{video:{path:video,name:'合成视频.mp4'}},draft:{targets:[{platform,enabled:true,collection:{required:false}}]},runCreatedAt:'2026-11-07T07:33:00Z'};
  if(omitDeclaration)job.draft.targets[0].declaration={mode:'omit'};
  if(modernCover || tencentLocation)job.location={mode:'none',name:''};
  if(cover){const file=path.resolve(__dirname,'./fixtures/cover-landscape-4x3.png');job.files.landscape={path:file,name:path.basename(file)};if(['tencent','xiaohongshu'].includes(platform)){if(platform==='xiaohongshu')delete job.files.landscape;const p=path.resolve(__dirname,'./fixtures/cover-portrait-3x4.png');job.files.portrait={path:p,name:path.basename(p)};}}
  let uploadDocuments=0;
  await context.route('**/*',async route=>{
   const request=route.request();requests.push({method:request.method(),url:request.url()});
   const frameUrl=iframe==='foreign_srcdoc'?'https://unowned.invalid/frame':new URL('/micro/content/post/create',config.upload).href;
   if(request.method()!=='GET' || ![config.upload,config.manage,config.entry,...(iframe?[frameUrl]:[])].filter(Boolean).includes(request.url()))return route.abort();
   if(config.entry && request.url()===config.entry)return route.fulfill({contentType:'text/html; charset=utf-8',body:`<button onclick="${popupEntry?'window.open(\''+config.upload+'\')':'location.href=\''+config.upload+'\''}">发布视频笔记</button>`});
   if(request.url()===config.upload && ++uploadDocuments===1 && initialBlank)return route.fulfill({contentType:'text/html; charset=utf-8',body:securityInstead?'<p>请完成安全验证</p>':'<!doctype html><body></body>'});
   if(missingInput && request.url()===config.upload)return route.fulfill({contentType:'text/html',body:'<h1>发布页面加载中</h1>'});
   if(iframe && iframe!=='srcdoc' && request.url()===config.upload)return route.fulfill({contentType:'text/html; charset=utf-8',body:`<iframe style="width:1000px;height:800px" src="${frameUrl}"></iframe>`});
   if(request.url()===config.manage)return route.fulfill({contentType:'text/html; charset=utf-8',body:`<article><a href="${urls[platform]}">${job.copy.title}</a><p>2026年11月07日 16:36</p><p>已发布</p></article>`});
   const title=platform==='tencent'&&omitShortTitle?'':`<input value="${shortTitleValue}" placeholder="${platform==='tencent'?'填写短标题有机会获得更多流量':'填写标题'}">`;
   const editable=`<div class="${platform==='tencent'&&!nestedEditor?'input-editor':'editor'}" contenteditable="${editableValue}"></div>`;
   const nativeEditor=nestedEditor?`<div class="input-editor">${editable}</div>`:editable;
   const editor=nativeEditor+(duplicateEditor?nativeEditor:'');
   const topic=platform==='xiaohongshu'?'<div id="creator-editor-topic-container" hidden></div>':'';
   const kind=platform==='xiaohongshu'?'portrait':'landscape';
   const coverClass={tencent:'horizontal-cover-wrap',xiaohongshu:'upload-cover'}[platform];
   const modalClass={tencent:'weui-desktop-dialog',xiaohongshu:'d-modal'}[platform];
   const coverMarkup=platform==='tencent'&&nativeCoverEdit?`<div id="cover" class="horizontal-cover-wrap disabled" aria-disabled="true" style="pointer-events:none"><img><button class="edit-btn" disabled onclick="window.__coverTarget='cover';document.getElementById('cover-modal').hidden=false;window.__order.push('cover-editor-open')">编辑</button></div>`:modernCover?'<div class="cover-plugin-preview"><div class="cover"><div id="cover" class="default"><div class="operator"><div class="cover-edit-entry" onclick="window.__coverTarget=\'cover\';document.getElementById(\'cover-modal\').hidden=false">编辑封面</div></div></div></div><div class="recommend"><img alt="AI推荐示例"><img alt="AI推荐示例2"></div></div><div class="d-select-main"><div class="d-select-placeholder">添加地点</div></div>':`<div id="cover" class="${coverClass}" onclick="window.__coverTarget='cover';document.getElementById('cover-modal').hidden=false"><img alt="封面预览"></div>`;
   const childButton=`<button ${footerDisabled?'disabled':''} onclick="parent.__trustedClick=event.isTrusted;parent.__primaryClicks++;parent.__finish()">${config.publish}</button>`;
   const publishMarkup=(footerFrame!=='only' && (!closedFooter || closedFooter==='duplicate')?`<button id="publish">${config.publish}</button>`:'')+(footerFrame?`<iframe srcdoc="${childButton.replaceAll('"','&quot;')}"></iframe>`:'')+(closedFooter?'<div class="video-footer"></div>':'');
   const html=`<!doctype html><meta charset="utf-8"><style>[contenteditable]{min-height:80px;border:1px solid gray}#cover img{width:${kind==='portrait'?90:160}px;height:120px;object-fit:cover}#portrait-cover img{width:90px;height:120px;object-fit:cover}</style>
   <input type="file" accept="video/mp4" onchange="window.__uploads=(window.__uploads||0)+1;window.__order.push('video-selected');window.__uploadStarted=performance.now();${localPreview?`document.querySelector('video').src='blob:https://local.invalid/new-preview';`:''}setTimeout(()=>{document.getElementById('upload-status').textContent='上传成功';window.__order.push('video-complete');window.__uploadFinished=performance.now();${nativeCoverEdit?`setTimeout(()=>{for(const root of document.querySelectorAll('.horizontal-cover-wrap,.vertical-cover-wrap')){root.classList.remove('disabled');root.setAttribute('aria-disabled','false');root.style.pointerEvents='${passiveCoverWrapper?'none':'auto'}';root.querySelector('button').disabled=false;root.querySelector('button').style.pointerEvents='auto'}window.__order.push('cover-enabled')},${coverReadyDelay});`:''}},${uploadDelay})"><p id="upload-status">${oldUpload?'上传成功':''}</p>${localPreview?'<video style="width:180px;height:100px"></video>':''}${title}${editor}${topic}
   ${modernCover?'<style>.cover-plugin-preview .cover>.default{width:90px;height:120px;background-size:cover}.cover-edit-entry{display:none}.cover>.default:hover .cover-edit-entry{display:block}</style>':''}
   ${coverMarkup}
   ${platform==='tencent'?(nativeCoverEdit?`<div id="portrait-cover" class="vertical-cover-wrap disabled" aria-disabled="true" style="pointer-events:none"><img><button class="edit-btn" disabled onclick="window.__coverTarget='portrait-cover';document.getElementById('cover-modal').hidden=false;window.__order.push('cover-editor-open')">编辑</button></div>`:`<div id="portrait-cover" class="vertical-cover-wrap" onclick="window.__coverTarget='portrait-cover';document.getElementById('cover-modal').hidden=false"><img></div>`):''}
   ${tencentLocation?`<div class="location-row"><div><span>位置</span></div><div id="location-value" onclick="document.getElementById('location-options').hidden=false"><span id="place-name">杭州市</span><i>⌄</i></div></div><div id="location-options" hidden><div onclick="document.getElementById('place-name').textContent='不显示位置';document.getElementById('location-options').hidden=true">不显示位置</div></div>`:''}
   <div id="cover-modal" class="${modalClass}" role="dialog" hidden><span>上传封面</span><input type="file" accept="image/png" style="${nativeCoverEdit?'display:none;pointer-events:none':''}"><button id="cover-confirm"><span>${modernCover?'完成':config.coverConfirm}</span></button></div>
   ${omitDeclaration?'<div class="d-select-main"><div class="d-select-placeholder">添加内容类型声明</div></div>':''}
   ${publishMarkup}<script>
   window.__publishes=0;window.__primaryClicks=0;window.__order=[];${localPreview?`Object.defineProperty(document.querySelector('video'),'readyState',{value:1});`:''}function complete(){window.__publishes++;const p=document.createElement('p');p.textContent='发布成功';document.body.append(p)}
   window.__finish=complete;const primary=document.getElementById('publish');if(primary)primary.onclick=()=>{window.__primaryClicks++;${confirmation?`const modal=document.createElement('div');modal.className='ant-modal-confirm-centered';modal.textContent='确认要发布这条视频？';const b=document.createElement('button');b.textContent='确认发布';b.onclick=()=>{complete();modal.remove()};modal.append(b);document.body.append(modal);`:'complete();'}};
   ${closedFooter?`document.querySelector('.video-footer').attachShadow({mode:'closed'}).innerHTML=${JSON.stringify(childButton)};`:''}
   const input=document.querySelector('#cover-modal input');input.onchange=()=>{window.__order.push('cover-selected');window.__coverStarted=performance.now();if(!window.__order.includes('video-complete'))window.__earlyCover=true;const r=new FileReader();r.onload=()=>{window.__cover=r.result;${wrongCover?`const c=document.createElement('canvas');c.width=c.height=16;const ctx=c.getContext('2d');ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,16,16);window.__cover=c.toDataURL();`:''}};r.readAsDataURL(input.files[0])};
   document.getElementById('cover-confirm').onclick=()=>{const target=document.getElementById(window.__coverTarget);const apply=()=>{${modernCover?`target.style.backgroundImage='url('+window.__cover+')'`:`target.querySelector('img').src=window.__cover`}};${coverDelay?'setTimeout(apply,'+coverDelay+')':'apply()'};document.getElementById('cover-modal').hidden=true};
   const ti=document.getElementById('tag-input');if(ti)ti.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();const tag=document.createElement('span');tag.className='tag-item';tag.textContent=ti.value;document.getElementById('tags').append(tag);ti.value=''}};
   const ed=document.querySelector('[contenteditable]'),menu=document.getElementById('creator-editor-topic-container');
   if(ed && menu)ed.addEventListener('input',()=>{const m=ed.innerText.match(/#([^# ]+)$/);if(!m)return;menu.hidden=false;menu.innerHTML='';const item=document.createElement('button');item.className='item';item.textContent='#'+m[1];${topicMetrics?`item.innerHTML='<span>#'+m[1]+'</span><span>233.3亿浏览</span>';`:''}${topicMetrics?`const other=document.createElement('button');other.className='item';other.textContent='#'+m[1]+'祝福\\n5.1亿浏览';other.onclick=()=>{window.__wrongTopic=true};menu.append(other);`:''}item.onclick=()=>{const value=ed.innerText.replace(/#[^# ]+$/,'');ed.textContent=value;const tag=document.createElement('span');tag.contentEditable='false';tag.textContent='#'+m[1]+${topicMetrics?"'[话题]#'":"''"};ed.append(tag);menu.hidden=true};menu.append(item)});
   </script>`;
   const body=((iframe==='srcdoc' && request.url()===config.upload)||(iframe==='foreign_srcdoc' && request.url()===frameUrl)) ? '<iframe style="width:1000px;height:800px" srcdoc="'+html.replaceAll('&','&amp;').replaceAll('\"','&quot;')+'"></iframe>' : html;
   // 视频号助手 2026-11-11：外层导航一个 body、发表表单在另一个 body 里，两者都带
   // data-ml-root。外层放一条旧的“上传成功”通知，不能被当作本次上传完成。
   const twoBodyScript='<script>(()=>{const outer=document.body,inner=document.createElement("body");for(const b of [outer,inner]){b.className="__finder-page";b.setAttribute("data-ml-root","true");}while(outer.firstChild)inner.append(outer.firstChild);const nav=document.createElement("nav");nav.textContent="视频号 · 助手 首页 内容管理 上传成功（旧通知）";outer.append(nav,inner);})()</script>';
   return route.fulfill({contentType:'text/html; charset=utf-8',body:twoBodies && request.url()===config.upload?body+twoBodyScript:body});
  });
  let entryPage;if(reuseEntry){entryPage=await context.newPage();await entryPage.goto(existingEditor?config.upload:config.entry);if(existingEditor)await entryPage.locator('input[placeholder="填写标题"]').fill('不应覆盖的编辑内容');}
  const publisher=createNativePublisher({context,platform,allowSubmit,entryPage,verifyIdentity,diagnosticsRoot,getPageDiagnostics:()=>{if(diagnosticThrows)throw new Error('synthetic diagnostic unavailable');return null;},onVerifyFiles:async()=>{},waitMs:1500,coverWaitMs,...((initialBlank||missingInput)?{entryWaitMs:250}:{}),uploadWaitMs});
  return {context,publisher,job,requests,steps,entryPage};
 }
 for(const platform of Object.keys(NATIVE_CONFIG))await t.test(`${platform}上传、标题正文话题回读、仅一次提交与只读结果查询`,async()=>{
  const f=await fixture(platform);
  try{
   const result=await f.publisher.prepare(f.job,{onStep:s=>f.steps.push(s)});assert.ok(Object.values(result.checks).every(Boolean));
   const hooks=[];const published=await f.publisher.submit(f.job,{beforeDispatch:async name=>{hooks.push('before:'+name);assert.equal(await f.context.pages()[0].evaluate(()=>window.__primaryClicks),0);},afterDispatch:async name=>{hooks.push('after:'+name);assert.equal(await f.context.pages()[0].evaluate(()=>window.__primaryClicks),1);}});assert.deepEqual(hooks,['before:publish','after:publish']);assert.equal(published.status,'submitted');assert.equal(published.platformStatus,'published');
   const source=f.context.pages()[0];assert.equal(await source.evaluate(()=>window.__publishes),1);
   await assert.rejects(f.publisher.submit(f.job),/唯一准备任务/);
   const again=await f.publisher.inspectResult(f.job);assert.equal(again.workId,published.workId);assert.equal(await source.evaluate(()=>window.__publishes),1);
   assert.ok(f.requests.every(r=>r.method==='GET'));assert.ok(f.requests.every(r=>[NATIVE_CONFIG[platform].upload,NATIVE_CONFIG[platform].manage,NATIVE_CONFIG[platform].entry].filter(Boolean).includes(r.url)));
   if(platform==='xiaohongshu')assert.equal(f.requests[0].url,NATIVE_CONFIG.xiaohongshu.entry);
  }finally{await f.context.close();}
 });
 for(const [editableValue,nestedEditor] of [['',false],['plaintext-only',false],['',true]])await t.test(`视频号原生正文可编辑属性“${editableValue||'空值'}”${nestedEditor?'在容器子层':''}可以填写并准确回读`,async()=>{
  const f=await fixture('tencent',{editableValue,nestedEditor,tags:[]});
  try{const ready=await f.publisher.prepare(f.job);assert.ok(Object.values(ready.checks).every(Boolean));assert.equal(await f.context.pages()[0].locator('[contenteditable]').innerText(),[f.job.copy.title,f.job.copy.description].filter(Boolean).join('\n'));assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('视频号正文不可编辑或存在两个候选时停止，并保存根控件诊断而非静默猜选',async()=>{
  for(const options of [{editableValue:'false'},{duplicateEditor:true}]){
   const diagnosticsRoot=fs.mkdtempSync(path.join(dir,'editor-diagnostic-')),f=await fixture('tencent',{...options,diagnosticsRoot,tags:[]});
   try{await assert.rejects(()=>f.publisher.prepare(f.job),/正文输入框/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);const report=JSON.parse(fs.readFileSync(path.join(diagnosticsRoot,fs.readdirSync(diagnosticsRoot).find(n=>n.endsWith('.json'))),'utf8'));assert.equal(report.submitted,false);assert.ok(report.editorCandidates.some(c=>c.className==='input-editor'&&c.visible));assert.ok(report.editorCandidates.every(c=>!('value' in c)&&!('text' in c)));}
   finally{await f.context.close();}
  }
 });
 await t.test('视频号等待视频上传完成后才交付双封面，默认封面任务不交付图片',async()=>{
  for(const cover of [false,true]){
   const f=await fixture('tencent',{cover,uploadDelay:150,tags:[]});
   try{await f.publisher.prepare(f.job);const source=f.context.pages()[0],order=await source.evaluate(()=>window.__order);assert.deepEqual(order,['video-selected','video-complete',...(cover?['cover-selected','cover-selected']:[])]);assert.equal(await source.evaluate(()=>!!window.__earlyCover),false);assert.equal(await source.evaluate(()=>window.__publishes),0);}
   finally{await f.context.close();}
  }
 });
 await t.test('视频号带符号长标题和话题进入视频描述，清空独立短标题和平台预填杭州',async()=>{
  const f=await fixture('tencent',{shortTitleValue:'旧短标题——不能沿用',tencentLocation:true,tags:['高考','对外经贸']});
  f.job.copy.title='背景211文科之王——对外经贸大学：到底值不值得选？';
  try{
   await f.publisher.prepare(f.job);const source=f.context.pages()[0];
   assert.equal(await source.locator('input[placeholder="填写短标题有机会获得更多流量"]').inputValue(),'');
   assert.equal((await source.locator('.input-editor').innerText()).replace(/\s+/g,' ').trim(),[f.job.copy.title,f.job.copy.description,'#高考','#对外经贸'].join(' '));
   assert.equal(await source.locator('#place-name').innerText(),'不显示位置');
   await f.publisher.verify(f.job);assert.equal(await source.evaluate(()=>window.__publishes),0);
   await source.locator('#place-name').evaluate(el=>el.textContent='杭州市');await assert.rejects(()=>f.publisher.submit(f.job),/定位/);assert.equal(await source.evaluate(()=>window.__publishes),0);
  }finally{await f.context.close();}
 });
 await t.test('视频号没有短标题输入框时仍完整填写描述；描述为空也保留标题和话题',async()=>{
  const f=await fixture('tencent',{omitShortTitle:true,tags:['高考']});f.job.copy.description='';
  try{await f.publisher.prepare(f.job);assert.equal((await f.context.pages()[0].locator('.input-editor').innerText()).trim(),f.job.copy.title+' #高考');assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('视频号封面入口在视频传完后才延迟启用，点击原生编辑按钮并回读两张封面',async()=>{
  const f=await fixture('tencent',{cover:true,nativeCoverEdit:true,uploadDelay:100,coverReadyDelay:200,tags:[]});
  try{
   const ready=await f.publisher.prepare(f.job),source=f.context.pages()[0],order=await source.evaluate(()=>window.__order);
   assert.ok(Object.values(ready.checks).every(Boolean));assert.equal(order.filter(x=>x==='cover-selected').length,2);assert.equal(order.filter(x=>x==='cover-editor-open').length,2);
   assert.ok(order.indexOf('cover-enabled')>order.indexOf('video-complete'));assert.ok(order.indexOf('cover-selected')>order.indexOf('cover-enabled'));
   assert.equal(ready.evidence.coverReadback.length,2);assert.ok(ready.evidence.coverReadback.every(c=>c.matched));assert.equal(await source.evaluate(()=>window.__publishes),0);
   assert.equal(await source.locator('input[placeholder="填写短标题有机会获得更多流量"]').inputValue(),'');
  }finally{await f.context.close();}
 });
 await t.test('视频号封面入口始终未启用时停止，不能上传图片或提交',async()=>{
  const f=await fixture('tencent',{cover:true,nativeCoverEdit:true,coverReadyDelay:5000,tags:[]});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/封面入口等待已达上限/);const source=f.context.pages()[0];assert.equal((await source.evaluate(()=>window.__order)).filter(x=>x==='cover-selected').length,0);assert.equal(await source.evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('视频号预览外框屏蔽鼠标而实际编辑按钮可用，不误判禁用',async()=>{
  const f=await fixture('tencent',{cover:true,nativeCoverEdit:true,passiveCoverWrapper:true,uploadDelay:100,coverReadyDelay:100,tags:[]});
  try{await f.publisher.prepare(f.job);const source=f.context.pages()[0];assert.equal((await source.evaluate(()=>window.__order)).filter(x=>x==='cover-selected').length,2);assert.equal(await source.evaluate(()=>!!window.__earlyCover),false);assert.equal(await source.evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('四平台真实计时上传超过一分钟：本地预览先出现，完成后才选封面，完整执行器不跳过等待',{timeout:120000},async()=>{
  await Promise.all(Object.keys(NATIVE_CONFIG).map(async platform=>{
   const f=await fixture(platform,{cover:true,localPreview:true,nativeCoverEdit:platform==='tencent',uploadDelay:65000,coverReadyDelay:1000,uploadWaitMs:100000,coverWaitMs:10000,tags:[]});
   try{
    await f.publisher.prepare(f.job,{onStep:s=>f.steps.push(s)});const source=f.context.pages()[0];
    const timing=await source.evaluate(()=>({elapsed:window.__uploadFinished-window.__uploadStarted,coverAt:window.__coverStarted,finishedAt:window.__uploadFinished,order:window.__order,early:!!window.__earlyCover,uploads:window.__uploads,publishes:window.__publishes}));
    assert.ok(timing.elapsed>=64000,platform+'必须真实经历一分钟上传等待');assert.ok(timing.coverAt>=timing.finishedAt,platform+'封面必须在视频传完以后');assert.equal(timing.early,false);assert.equal(timing.uploads,1);assert.equal(timing.publishes,0);assert.ok(f.steps.filter(s=>/尚未提交/.test(s.message)).length>=2);
   }finally{await f.context.close();}
  }));
 });
 await t.test('视频号准备完成后短标题被重新填入，提交前必须发现变化',async()=>{
  const f=await fixture('tencent',{tags:[]});
  try{await f.publisher.prepare(f.job);const source=f.context.pages()[0];await source.locator('input[placeholder*="短标题"]').fill('不可沿用——旧标题');await assert.rejects(()=>f.publisher.submit(f.job),/已变化/);assert.equal(await source.evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('小红书话题候选含浏览量时仍精确选择本话题，不能误选同名前缀',async()=>{
  const f=await fixture('xiaohongshu',{tags:['高考'],topicMetrics:true});
  try{assert.ok(Object.values((await f.publisher.prepare(f.job)).checks).every(Boolean));assert.equal(await f.context.pages()[0].evaluate(()=>window.__wrongTopic===true),false);}
  finally{await f.context.close();}
 });
 await t.test('小红书空白上传页仅在上传前自动重开一次，文件只交给平台一次',async()=>{
  const f=await fixture('xiaohongshu',{initialBlank:true,tags:[]});
  try{await f.publisher.prepare(f.job);assert.equal(f.requests.filter(r=>r.url===NATIVE_CONFIG.xiaohongshu.upload).length,2);assert.equal(await f.context.pages()[0].evaluate(()=>window.__uploads),1);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('小红书出现安全验证时停止，不能把验证页当空白页刷新',async()=>{
  const f=await fixture('xiaohongshu',{initialBlank:true,securityInstead:true,tags:[]});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/未上传/);assert.equal(f.requests.filter(r=>r.url===NATIVE_CONFIG.xiaohongshu.upload).length,1);}
  finally{await f.context.close();}
 });
 await t.test('官方入口开新窗口时接管新表单，用户原首页保持打开',async()=>{
  const f=await fixture('xiaohongshu',{popupEntry:true,tags:[]});
  try{const original=await f.context.newPage();await original.goto(NATIVE_CONFIG.xiaohongshu.entry);await f.publisher.prepare(f.job);assert.equal(original.isClosed(),false);assert.equal(original.url(),NATIVE_CONFIG.xiaohongshu.entry);assert.equal(f.context.pages().length,2);}
  finally{await f.context.close();}
 });
 await t.test('小红书沿用已加载的官方首页进入视频入口，不重复打开首页',async()=>{
  const f=await fixture('xiaohongshu',{reuseEntry:true,tags:[]});
  try{await f.publisher.prepare(f.job);assert.equal(f.context.pages().length,1);assert.equal(f.entryPage.url(),NATIVE_CONFIG.xiaohongshu.upload);assert.equal(f.requests.filter(r=>r.url===NATIVE_CONFIG.xiaohongshu.entry).length,1);}
  finally{await f.context.close();}
 });
 await t.test('已在编辑内容的原标签不能被当成首页重用',async()=>{
  const f=await fixture('xiaohongshu',{reuseEntry:true,existingEditor:true,tags:[]});
  try{await f.publisher.prepare(f.job);assert.equal(f.context.pages().length,2);assert.equal(await f.entryPage.locator('input[placeholder="填写标题"]').inputValue(),'不应覆盖的编辑内容');}
  finally{await f.context.close();}
 });
 await t.test('小红书明确不设置声明时核对原生空值，准备后出现旧声明也不能提交',async()=>{
  const f=await fixture('xiaohongshu',{tags:[],omitDeclaration:true});
  try{await f.publisher.prepare(f.job);await f.context.pages()[0].locator('.d-select-placeholder').evaluate(n=>{n.className='d-select-value';n.textContent='笔记含AI合成内容';});await assert.rejects(()=>f.publisher.submit(f.job),/不设置声明/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('发布按钮在官方页面自有的内嵌底栏时识别该按钮，并且只提交一次',async()=>{
  const f=await fixture('xiaohongshu',{footerFrame:'only',tags:[]});
  try{const ready=await f.publisher.prepare(f.job);assert.equal(ready.evidence.publishControl.insideOwnedChild,true);assert.equal((await f.publisher.submit(f.job)).status,'submitted');assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),1);await assert.rejects(()=>f.publisher.submit(f.job),/唯一准备任务/);}
  finally{await f.context.close();}
 });
 await t.test('主页面和内嵌底栏同时出现发布按钮时不能任选一个',async()=>{
  const f=await fixture('xiaohongshu',{footerFrame:'duplicate',tags:[]});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/最终发布按钮不唯一/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('独立封装的原生发布按钮可由浏览器语义识别并且只触发一次真实键盘动作',async()=>{
  const f=await fixture('xiaohongshu',{closedFooter:true,tags:[]});
  try{const ready=await f.publisher.prepare(f.job);assert.equal(ready.evidence.publishControl.method,'chromium_accessibility_native_button');assert.equal(ready.evidence.publishControl.shadowMode,'closed');assert.equal((await f.publisher.submit(f.job)).status,'submitted');assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),1);assert.equal(await f.context.pages()[0].evaluate(()=>window.__trustedClick),true);await assert.rejects(()=>f.publisher.submit(f.job),/唯一准备任务/);}
  finally{await f.context.close();}
 });
 await t.test('普通层与封装层同时存在同名发布按钮时停止',async()=>{
  const f=await fixture('xiaohongshu',{closedFooter:'duplicate',tags:[]});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/最终发布按钮不唯一/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('封装层的发布按钮禁用时不能宣称准备完成',async()=>{
  const f=await fixture('xiaohongshu',{closedFooter:true,footerDisabled:true,tags:[]});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/发布按钮不可用/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('小红书当前封面须悬停编辑入口，回读实际背景封面而非旁边的AI推荐图片',async()=>{
  const f=await fixture('xiaohongshu',{cover:true,modernCover:true,topicMetrics:true,omitDeclaration:true,tags:['高考']});
  try{assert.ok(Object.values((await f.publisher.prepare(f.job)).checks).every(Boolean));assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('小红书实际背景封面被替换也必须阻止提交',async()=>{
  const f=await fixture('xiaohongshu',{cover:true,modernCover:true,omitDeclaration:true,tags:[],wrongCover:true});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/与所选图片不一致/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('封面弹窗关闭后预览延迟更新，须等待选定图片而非读取旧预览',async()=>{
  const f=await fixture('xiaohongshu',{cover:true,modernCover:true,coverDelay:450,omitDeclaration:true,tags:[]});
  try{assert.ok(Object.values((await f.publisher.prepare(f.job)).checks).every(Boolean));assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 for(const platform of Object.keys(NATIVE_CONFIG))await t.test(`${platform}用户选择的封面必须出现在已保存预览`,async()=>{
  const f=await fixture(platform,{tags:[],cover:true});
  try{assert.ok(Object.values((await f.publisher.prepare(f.job)).checks).every(Boolean));assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('确认前改正文或停止任务，都不能触发发布',async()=>{
  const f=await fixture('tencent');
  try{
   await f.publisher.prepare(f.job);await f.context.pages()[0].locator('.input-editor').fill('已修改正文');
   await assert.rejects(f.publisher.submit(f.job),/已变化/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);
   await f.publisher.stop();await assert.rejects(f.publisher.submit(f.job),/已停止/);
  }finally{await f.context.close();}
 });
 await t.test('页面遗留的上传成功字样不能冒充本条文件上传完成',async()=>{
  const f=await fixture('tencent',{tags:[],oldUpload:true});
  try{await assert.rejects(f.publisher.prepare(f.job));assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('视频号助手页有两层 body：按视频控件所在那层等待上传，不触发严格模式错误，外层旧通知不冒充完成',async()=>{
  const f=await fixture('tencent',{twoBodies:true});
  try{
   const ready=await f.publisher.prepare(f.job),source=f.context.pages()[0];
   assert.equal(await source.locator('body').count(),2);
   await assert.rejects(source.locator('body').evaluate(b=>b.tagName),/strict mode violation/);
   assert.ok(Object.values(ready.checks).every(Boolean));assert.equal(await source.evaluate(()=>window.__uploads),1);assert.equal(await source.evaluate(()=>window.__publishes),0);
  }finally{await f.context.close();}
 });
 await t.test('两层 body 时，表单层里遗留的上传成功字样同样不能冒充本条上传完成',async()=>{
  const f=await fixture('tencent',{tags:[],oldUpload:true,twoBodies:true});
  try{await assert.rejects(f.publisher.prepare(f.job));assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('持久记录失败或执行器无发布权限时，零发布点击',async()=>{
  for(const allowSubmit of [true,false]){
   const f=await fixture('tencent',{allowSubmit,tags:[]});
   try{await f.publisher.prepare(f.job);await assert.rejects(f.publisher.submit(f.job,{beforeDispatch:async()=>{throw new Error('模拟记录写入失败');}}),allowSubmit?/记录写入失败/:/没有发布权限/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__primaryClicks),0);}
   finally{await f.context.close();}
  }
 });
 await t.test('封面预览被另一张图替代时，必须阻止提交',async()=>{
  const f=await fixture('tencent',{tags:[],cover:true,wrongCover:true});
  try{await assert.rejects(f.publisher.prepare(f.job),/与所选图片不一致/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('提交前账号复查等待期间停止，复查返回后也不得点击发布',async()=>{
  let release;const f=await fixture('tencent',{verifyIdentity:()=>new Promise(r=>{release=r;})});
  try{
   await f.publisher.prepare(f.job);const pending=f.publisher.submit(f.job);
   while(!release)await new Promise(r=>setImmediate(r));await f.publisher.stop();release();
   await assert.rejects(pending,/已停止/);assert.equal(await f.context.pages()[0].evaluate(()=>window.__publishes),0);
  }finally{await f.context.close();}
 });
 await t.test('官方页面直接生成的同源srcdoc表单也能找到唯一上传控件，不遗漏继承来源的内嵌页',async()=>{
  const f=await fixture('tencent',{iframe:'srcdoc'});
  try{assert.ok(Object.values((await f.publisher.prepare(f.job)).checks).every(Boolean));const form=f.context.pages()[0].frames().find(x=>x.url()==='about:srcdoc');assert.equal(await form.locator('input[type="file"]').first().evaluate(n=>n.files.length),1);assert.equal(await form.evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('外部来源页面嵌入的srcdoc上传控件不能冒充官方表单',async()=>{
  const f=await fixture('tencent',{iframe:'foreign_srcdoc'});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/唯一视频文件控件/);const form=f.context.pages()[0].frames().find(x=>x.url()==='about:srcdoc');assert.equal(await form.locator('input[type="file"]').first().evaluate(n=>n.files.length),0);assert.equal(await form.evaluate(()=>window.__publishes),0);}
  finally{await f.context.close();}
 });
 await t.test('上传页识别失败且附加诊断不可用时，仍先落盘原失败和阶段，不留下空目录',async()=>{
  const diagnosticDir=path.join(dir,'tencent-failure');const f=await fixture('tencent',{missingInput:true,diagnosticThrows:true,diagnosticsRoot:diagnosticDir});
  try{await assert.rejects(()=>f.publisher.prepare(f.job),/唯一视频文件控件/);const files=fs.readdirSync(diagnosticDir).filter(n=>n.endsWith('.json'));assert.equal(files.length,1);const report=JSON.parse(fs.readFileSync(path.join(diagnosticDir,files[0])));assert.equal(report.platform,'tencent');assert.equal(report.errorCode,'UPLOAD_FORM_NOT_READY');assert.equal(report.diagnosticFailure.stage,'runtime_diagnostics');assert.equal(fs.statSync(path.join(diagnosticDir,files[0])).mode&0o777,0o600);}
  finally{await f.context.close();}
 });
 await t.test('视频号编辑器位于同一官方域名的内嵌页面时，仍在该表单完成准备与一次提交',async()=>{
  const f=await fixture('tencent',{iframe:true});
  try{await f.publisher.prepare(f.job);assert.equal((await f.publisher.submit(f.job)).status,'submitted');const form=f.context.pages()[0].frames().find(frame=>frame.url().includes('/micro/content/post/create'));assert.equal(await form.evaluate(()=>window.__publishes),1);}
  finally{await f.context.close();}
 });
 await t.test('视频号点击发表后在 Shadow DOM 弹出原创声明拦截弹窗时，经单次 confirmation 点击直接发表',async()=>{
  const f=await fixture('tencent',{tags:[]});
  try{
   await f.publisher.prepare(f.job);
   const page=f.context.pages()[0];
   await page.evaluate(()=>{
     const host=document.createElement('div');
     host.id='wujie-host';
     const shadow=host.attachShadow({mode:'open'});
     shadow.innerHTML='<div class="original-interceptor-footer" style="display:none"><label><input type="checkbox">不再提醒</label><button id="direct-pub" class="weui-desktop-btn weui-desktop-btn_default">直接发表</button><button id="orig-pub" class="weui-desktop-btn weui-desktop-btn_primary">声明原创</button></div>';
     document.body.append(host);
     window.__originalDeclared=0;
     shadow.getElementById('orig-pub').onclick=()=>{window.__originalDeclared++;};
     shadow.getElementById('direct-pub').onclick=()=>{
       shadow.querySelector('.original-interceptor-footer').style.display='none';
       window.__finish();
     };
     document.getElementById('publish').onclick=()=>{
       window.__primaryClicks++;
       shadow.querySelector('.original-interceptor-footer').style.display='flex';
     };
   });
   const hooks=[];
   const res=await f.publisher.submit(f.job,{beforeDispatch:async name=>hooks.push('before:'+name),afterDispatch:async name=>hooks.push('after:'+name)});
   assert.equal(res.status,'submitted');
   assert.deepEqual(hooks,['before:publish','after:publish','before:confirmation','after:confirmation']);
   assert.equal(await page.evaluate(()=>window.__primaryClicks),1);
   assert.equal(await page.evaluate(()=>window.__publishes),1);
   assert.equal(await page.evaluate(()=>window.__originalDeclared),0);
  }finally{await f.context.close();}
 });
 await t.test('视频号发表按钮带 weui-desktop-btn_disabled 类时即使无 disabled 属性也必须拦停',async()=>{
  const f=await fixture('tencent',{tags:[]});
  try{
   await f.publisher.prepare(f.job);
   const page=f.context.pages()[0];
   await page.evaluate(()=>document.getElementById('publish').classList.add('weui-desktop-btn_disabled'));
   await assert.rejects(()=>f.publisher.submit(f.job),/禁用状态/);
   assert.equal(await page.evaluate(()=>window.__primaryClicks),0);
  }finally{await f.context.close();}
 });
});
