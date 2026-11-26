'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('playwright-core');
const available=require('../app/core/browser-driver.cjs').browserAvailability().find(b=>b.available);
const root=process.env.DISPATCH_TEST_PRODUCT_ROOT || path.resolve(__dirname,'..');
test('发布记录界面区分动作、候选与可靠结果，并防止重复核查',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());
 async function fixture(pending=true){
  const page=await context.newPage();await page.setContent('<div id="history-tools"></div><div id="history-total"></div><div id="run-list"></div>');
  await page.addScriptTag({path:path.join(root,'app/renderer/publish-record-model.js')});await page.addScriptTag({path:path.join(root,'app/renderer/publish-history-ui.js')});
  await page.evaluate(pending=>{
   window.calls=[];window.PublishSettings={locationLabel:()=> '不显示位置'};
   window.data={runs:[{id:'r',mode:'managed_prepare',platform:'douyin',status:'awaiting_verification',createdAt:'2026-11-17T01:00:00Z',snapshot:{},summary:[{platform:'douyin',title:'合成候选任务'}],events:[],submission:{version:1,actions:[{name:'publish',startedAt:'2026-11-17T01:01:00Z'}],dispatchStartedAt:'2026-11-17T01:01:00Z',operationPending:pending},candidateResult:{workId:'1234567890123456789'},result:null}]};
   window.ui=window.PublishHistoryUI.create({getData:()=>window.data,publisher:{inspectManagedResult:async id=>{window.calls.push(id);return window.data.runs[0];},exportRun:async()=>{}},onRun:()=>{},toast:()=>{}});window.ui.render();
  },pending);return page;
 }
 await t.test('未返回操作禁用核查；候选明确未核实，没有查看作品按钮',async()=>{
  const page=await fixture();await page.getByText('查看发布详情',{exact:true}).click();assert.equal(await page.getByRole('button',{name:'等待原操作返回'}).isDisabled(),true);assert.equal(await page.getByText('候选作品编号（未核实）',{exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'查看作品',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'停止该平台任务'}).count(),1);await page.close();
 });
 await t.test('原操作结束后才允许只读查询；取得回执后不再显示候选提示',async()=>{
  const page=await fixture(false);await page.getByRole('button',{name:'核查发布结果'}).click();assert.deepEqual(await page.evaluate(()=>window.calls),['r']);
  await page.evaluate(()=>{window.data.runs[0].status='submitted';window.data.runs[0].result={status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789'};window.ui.render();});assert.equal(await page.getByText('候选作品编号（未核实）',{exact:true}).count(),0);await page.close();
 });
});
