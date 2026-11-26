'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitForCoverReady,readCoverReadiness}=require('../app/core/cover-readiness.cjs');
const {chromium}=require('playwright-core');
const available=require('../app/core/browser-driver.cjs').browserAvailability().find(b=>b.available);

test('封面入口在一分钟以后才启用仍持续等待，启用前没有交付文件的机会',async()=>{
  let time=0,reads=0;const progress=[];
  const result=await waitForCoverReady({read:async()=>{reads++;return {ready:time>=95000,reason:'平台处理视频中'};},now:()=>time,pause:async ms=>{time+=ms;},pollMs:1000,onProgress:s=>progress.push(s)});
  assert.equal(result.ready,true);assert.equal(time,95000);assert.equal(reads,96);assert.ok(progress.length>=4);
});
test('封面入口一直禁用或等待中取消，不自动上传封面或重传视频',async()=>{
  let time=0,stopped=false;
  await assert.rejects(waitForCoverReady({read:async()=>({ready:false,reason:'平台仍禁用入口'}),maxMs:2000,now:()=>time,pause:async ms=>{time+=ms;}}),{code:'COVER_NOT_READY'});
  time=0;
  await assert.rejects(waitForCoverReady({read:async()=>({ready:false}),assertRunning(){if(stopped)throw new Error('用户已停止');},now:()=>time,pause:async ms=>{time+=ms;stopped=true;}}),/用户已停止/);
});
test('只检查实际编辑入口；无鼠标事件的预览外框不挡住其已启用的子按钮，真正禁用仍停止',{skip:!available},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());const page=await context.newPage();
  await page.setContent('<div style="pointer-events:none"><div id="cover" style="pointer-events:none"><button style="pointer-events:auto">编辑</button></div></div><input type="file" style="display:none;pointer-events:none">');
  assert.equal((await page.locator('#cover').evaluate(readCoverReadiness,{wrapper:true})).ready,true);
  assert.equal((await page.getByRole('button').evaluate(readCoverReadiness)).ready,true);
  assert.equal((await page.locator('input').evaluate(readCoverReadiness)).ready,true);
  await page.getByRole('button').evaluate(el=>el.disabled=true);assert.equal((await page.getByRole('button').evaluate(readCoverReadiness)).ready,false);
  await page.locator('input').evaluate(el=>el.disabled=true);assert.equal((await page.locator('input').evaluate(readCoverReadiness)).ready,false);
  await page.locator('#cover').evaluate(el=>el.setAttribute('aria-disabled','true'));assert.equal((await page.locator('#cover').evaluate(readCoverReadiness,{wrapper:true})).ready,false);
});
