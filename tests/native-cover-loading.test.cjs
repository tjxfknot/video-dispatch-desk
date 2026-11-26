'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright-core'),{browserAvailability}=require('../app/core/browser-driver.cjs');
const {createNativePublisher,NATIVE_CONFIG}=require('../app/core/native-publish-driver.cjs');
const available=browserAvailability().find(b=>b.available);
test('封面组件慢于普通控件时仍继续本条准备，加载期间停止也不上传图片',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-cover-loading-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const video=path.join(dir,'synthetic.mp4');fs.writeFileSync(video,'offline only');
 async function fixture(){
  const context=await browser.newContext({serviceWorkers:'block'}),cfg=NATIVE_CONFIG.xiaohongshu;
  await context.route('**/*',route=>{
   const url=route.request().url();if(url===cfg.entry)return route.fulfill({contentType:'text/html; charset=utf-8',body:`<a href="${cfg.upload}">发布视频笔记</a>`});
   if(url!==cfg.upload)return route.abort();
   return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><input type="file" accept="video/mp4" onchange="document.getElementById('status').textContent='上传成功'"><p id="status"></p><input placeholder="填写标题"><div contenteditable="true"></div>
    <div class="upload-cover" onclick="window.openCover()"><img style="width:90px;height:120px;object-fit:cover"></div><div class="d-modal" hidden>设置封面</div><button id="publish">发布</button>
    <script>window.coverUploads=0;window.publishes=0;document.getElementById('publish').onclick=()=>window.publishes++;
    window.openCover=()=>{const modal=document.querySelector('.d-modal');modal.hidden=false;setTimeout(()=>{const input=document.createElement('input');input.type='file';input.accept='image/png';input.onchange=()=>{window.coverUploads++;const reader=new FileReader();reader.onload=()=>window.cover=reader.result;reader.readAsDataURL(input.files[0]);};const done=document.createElement('button');done.textContent='完成';done.onclick=()=>{document.querySelector('.upload-cover img').src=window.cover;modal.hidden=true};modal.append(input,done);},1600);};</script>`});
  });
  const publisher=createNativePublisher({context,platform:'xiaohongshu',verifyIdentity:async()=>{},waitMs:1000,uploadWaitMs:5000});
  const job={platform:'xiaohongshu',fingerprint:'synthetic',copy:{title:'加载测试',description:'合成正文',tags:[]},declarationText:'',settings:{visibility:'platform_default'},files:{video:{path:video},portrait:{path:path.resolve(__dirname,'./fixtures/cover-portrait-3x4.png')}},draft:{targets:[{enabled:true,collection:{required:false}}]}};
  return {context,publisher,job};
 }
 await t.test('等待延迟加载的上传控件，使用已上传视频继续而非重新上传视频',async()=>{
  const f=await fixture();try{assert.ok(Object.values((await f.publisher.prepare(f.job)).checks).every(Boolean));assert.equal(await f.context.pages()[0].evaluate(()=>window.coverUploads),1);assert.equal(await f.context.pages()[0].evaluate(()=>window.publishes),0);}finally{await f.publisher.stop();await f.context.close();}
 });
 await t.test('等待时停止不再上传图片或点击完成',async()=>{
  const f=await fixture();try{let ready;const entered=new Promise(resolve=>{ready=resolve});const outcome=f.publisher.prepare(f.job,{onStep:step=>{if(step.message.startsWith('封面编辑器正在加载'))ready();}}).then(()=>null,e=>e);await entered;await f.publisher.stop();assert.match((await outcome).message,/已停止/);assert.equal(await f.context.pages()[0].evaluate(()=>window.coverUploads),0);assert.equal(await f.context.pages()[0].evaluate(()=>window.publishes),0);}finally{await f.context.close();}
 });
});
