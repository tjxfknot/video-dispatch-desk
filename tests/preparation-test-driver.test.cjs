'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildOfflineJob,createOfflineExecutor}=require('../app/core/preparation-test-fixture.cjs');
const {createDouyinPublisher}=require('../app/core/douyin-publish-driver.cjs');
const {chromium}=require('playwright-core');
const available=require('../app/core/browser-driver.cjs').browserAvailability().find(b=>b.available);
test('真实抖音驱动的分步上传与只读定位：所有网页请求本地拦截',{skip:!available,timeout:120000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prepare-driver-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const scenario of ['quick','slow_upload','location_residue','upload_failure'])await t.test(scenario,async()=>{
    const job=buildOfflineJob(scenario,root),executor=await createOfflineExecutor({job,scenario});
    t.after(()=>executor.dispose());
    try{
      await executor.verify(job);const started=Date.now();
      if(scenario==='upload_failure')await assert.rejects(()=>executor.uploadVideo(job),/上传失败/);
      else{
        const checkpoint=await executor.uploadVideo(job);assert.equal(checkpoint.complete,true);
        if(scenario==='slow_upload')assert.ok(Date.now()-started>=64000,'保留实际一分钟以上的等待覆盖');
        if(scenario==='location_residue')await assert.rejects(()=>executor.inspectUploadLocation(job),/仍带有作品定位/);
        else{assert.equal((await executor.inspectUploadLocation(job)).value,'');assert.equal((await executor.inspectUploadLocation(job)).value,'');}
      }
      await assert.rejects(()=>executor.uploadVideo(job),/已经开始过上传/);
      await assert.rejects(()=>executor.submit(job),/没有发布权限/);
      assert.deepEqual(await executor.readFixtureCounts(),{uploads:1,covers:0,publishes:0,writes:0,clicks:0});
    }finally{await executor.stop();await executor.dispose();}
  });
});
test('页面刷新、任务改动、身份改变或停止后，旧检查点不能继续使用',{skip:!available,timeout:30000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prepare-checkpoint-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  for(const change of ['reload','fingerprint','identity','video','stop'])await t.test(change,async()=>{
    const context=await browser.newContext({serviceWorkers:'block'});let wrongIdentity=false;
    await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<input type="file" accept="video/*" onchange="document.getElementById(\'state\').textContent=\'重新上传\'"><p id="state">等待视频</p><input aria-label="地点">'}));
    const job=buildOfflineJob('quick',root),executor=createDouyinPublisher({context,onVerifyFiles:async()=>{},verifyIdentity:async()=>{if(wrongIdentity)throw new Error('实际账号已改变');},allowSubmit:false});
    try{
      await executor.uploadVideo(job);
      if(change==='reload')await context.pages()[0].reload();
      if(change==='fingerprint')job.fingerprint='changed';
      if(change==='identity')wrongIdentity=true;
      if(change==='video'){
        const other=path.join(root,'other-video.mp4');fs.writeFileSync(other,'another synthetic video');
        await context.pages()[0].locator('input[type="file"]').setInputFiles(other);
      }
      if(change==='stop')await executor.stop();
      await assert.rejects(()=>executor.inspectUploadLocation(job),/失效|改变|已停止/);
    }finally{await context.close();}
  });
});
test('正式prepare也使用同一个上传步骤，上传完成时停止不会继续填表',{skip:!available,timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prepare-production-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<input type="file" accept="video/*" onchange="window.uploads=(window.uploads||0)+1;document.getElementById(\'state\').textContent=\'重新上传\'"><p id="state">等待视频</p><input placeholder="填写作品标题" oninput="window.writes=true">'}));
  const controller=new AbortController(),executor=createDouyinPublisher({context,verifyIdentity:async()=>{},onVerifyFiles:async()=>{}});
  await assert.rejects(()=>executor.prepare(buildOfflineJob('quick',root),{signal:controller.signal,onStep:step=>{if(step.message.includes('本条上传步骤结束'))controller.abort();}}),/已停止/);
  assert.deepEqual(await context.pages()[0].evaluate(()=>({uploads:window.uploads,writes:!!window.writes})),{uploads:1,writes:false});
});
