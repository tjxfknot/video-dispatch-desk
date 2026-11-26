'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createDouyinPublisher}=require('./douyin-publish-driver.cjs');
const UPLOAD='https://creator.douyin.com/creator-micro/content/upload';

function buildOfflineJob(scenario,root){
  fs.mkdirSync(root,{recursive:true,mode:0o700});const video=path.join(root,'offline-fixture.mp4');
  // The local page tests the file-input/await boundary, not video decoding.
  if(!fs.existsSync(video))fs.writeFileSync(video,'offline synthetic input; never sent to a server',{mode:0o600});
  return {platform:'douyin',accountId:'offline-synthetic',accountDisplay:'离线模拟账号（不连接真实平台）',fingerprint:'offline-upload-v1-'+scenario,
    expectedBinding:{platformAccountId:'offline-synthetic'},files:{video:{path:video}},copy:{title:'离线上传与定位场景',tags:[]},location:{mode:'none',name:''},schedule:{mode:'immediate'},settings:{}};
}
async function createOfflineExecutor({job,scenario}){
  const {chromium}=require('playwright-core');
  const available=require('./browser-driver.cjs').browserAvailability().find(b=>b.available);
  if(!available)throw new Error('离线网页测试需要本机已安装的Chrome或Edge。');
  const browser=await chromium.launch({channel:available.id,headless:true});
  try{
    const context=await browser.newContext({serviceWorkers:'block'}),delay=scenario==='slow_upload'?65000:1200;
    // All browser traffic is fulfilled locally or aborted. No official server
    // is contacted even though the driver retains its real navigation URL.
    await context.route('**/*',route=>{
      if(route.request().method()!=='GET' || route.request().url()!==UPLOAD)return route.abort();
      return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><body>
        <h1>离线模拟页面</h1><input type="file" accept="video/*" onchange="window.uploads++;document.getElementById('state').textContent='正在上传';setTimeout(()=>{document.getElementById('state').textContent='${scenario==='upload_failure'?'上传失败':'重新上传'}';document.getElementById('progress').value=100},${delay})">
        <p id="state">请选择视频</p><progress id="progress" value="0" max="100"></progress>
        <label>地点<input aria-label="地点" value="${scenario==='location_residue'?'旧地点':''}" oninput="window.writes++"></label>
        <input type="file" accept="image/*" onchange="window.covers++"><button onclick="window.publishes++">发布</button>
        <script>window.uploads=0;window.covers=0;window.publishes=0;window.writes=0;document.addEventListener('click',()=>window.clicks=(window.clicks||0)+1)</script>
        </body></html>`});
    });
    const executor=createDouyinPublisher({context,verifyIdentity:async()=>{},onVerifyFiles:async()=>{},allowSubmit:false,uploadWaitMs:100000});
    return {...executor,dispose:()=>browser.close(),readFixtureCounts:async()=>context.pages()[0].evaluate(()=>({uploads,covers,publishes,writes,clicks:window.clicks || 0}))};
  }catch(error){await browser.close();throw error;}
}
module.exports={buildOfflineJob,createOfflineExecutor};
