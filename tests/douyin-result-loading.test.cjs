'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {browserAvailability}=require('../app/core/browser-driver.cjs');
const {createDouyinPublisher}=require(process.env.DISPATCH_RESULT_DRIVER || '../app/core/douyin-publish-driver.cjs');
const available=browserAvailability().find(b=>b.available);
const origin='https://creator.douyin.com', manage='/creator-micro/content/manage', edit='/creator-micro/content/post/video', workListApi='/janus/douyin/creator/pc/work_list';
const workId='1234567890123456789',otherId='9876543210987654321';
const job={copy:{title:'合成加载测试'},runCreatedAt:'2026-11-07T07:33:00Z'};

test('结果读取等待实际数据，并从当前作品列表查询；仅使用隔离合成页面', {skip:!available,concurrency:true},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});
  t.after(()=>browser.close());
  async function fixture({loadedTitle=job.copy.title,changeId=false,duplicate=false,initialCurrent=false,recordTime='2026年11月07日 15:36',listedId=workId,delayedMountMs=0,cardClass='video-card-sfaSzz',titleClass='info-title-text-Zob9RV',cardPrivateLabel='私密',apiPayload=null}={}){
    const context=await browser.newContext({serviceWorkers:'block'});
    const requests=[],unexpected=[];
    const counts={manage:0,edit:0,api:0};
    // Every request is fulfilled or aborted locally. No real account,
    // platform response, persistent profile, upload or submit is involved.
    await context.route('**/*',async route=>{
      const request=route.request(),u=new URL(request.url());
      requests.push({method:request.method(),path:u.pathname});
      if(request.method()!=='GET' || u.origin!==origin || ![manage,edit,'/unsaved',workListApi].includes(u.pathname)){
        unexpected.push(request.url());return route.abort();
      }
      if(u.pathname===workListApi){
        counts.api++;
        return route.fulfill({status:200,contentType:'application/json; charset=utf-8',body:JSON.stringify(apiPayload || {status_code:0,aweme_list:[]})});
      }
      let html='';
      if(u.pathname===manage){
        counts.manage++;
        const card=`<div class="${cardClass}"><span class="${titleClass}">${job.copy.title}</span><div>00:30</div><div>${recordTime}</div><div>审核中</div><div>${cardPrivateLabel}</div><button onclick="location.href='${edit}?mid=${listedId}'">编辑作品</button></div>`;
        const fullCard=card+(duplicate?card:'');
        const apiCall=apiPayload?`fetch('${workListApi}');`:'';
        html=delayedMountMs>0
          ? `<div id="root"></div><script>setTimeout(()=>{${apiCall}document.getElementById('root').innerHTML=${JSON.stringify(fullCard)};},${delayedMountMs});</script>`
          : (apiPayload?`<script>${apiCall}</script>`+fullCard:fullCard);
      } else if(u.pathname===edit){
        counts.edit++;
        html=`<input placeholder="填写作品标题，为作品获得更多流量" value=""><script>setTimeout(()=>{document.querySelector('input').value=${JSON.stringify(loadedTitle)};${changeId?`history.replaceState(null,'','${edit}?mid=${otherId}');`:''}},900)</script>`;
      } else html='<textarea>未保存的合成文案</textarea>';
      return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
    });
    const stale=await context.newPage();await stale.goto(origin+manage);
    if(!initialCurrent)await stale.setContent(`<p>旧列表，尚无本条记录</p><p>${job.copy.title}</p>`);
    const draft=await context.newPage();await draft.goto(origin+'/unsaved');
    const publisher=createDouyinPublisher({context,verifyIdentity:async()=>{},onVerifyFiles:async()=>{}});
    return {context,stale,draft,publisher,counts,requests,unexpected};
  }
  await t.test('空标题框先出现、900毫秒后才载入标题时，核对作品成功；再次查询刷新自有标签',async()=>{
    const f=await fixture({initialCurrent:true});
    try {
      const result=await f.publisher.inspectResult(job);
      assert.equal(result.status,'submitted');assert.equal(result.workId,workId);
      assert.equal(result.platformStatus,'under_review');assert.equal(result.visibility,'self');
      assert.equal(f.context.pages().length,3);
      assert.equal(f.stale.url(),origin+manage);
      assert.equal(await f.stale.locator('.video-card-sfaSzz').count(),1);
      assert.equal(await f.draft.inputValue('textarea'),'未保存的合成文案');
      const again=await f.publisher.inspectResult(job);
      assert.equal(again.workId,workId);assert.equal(f.context.pages().length,3);
      assert.equal(f.counts.manage,3);assert.deepEqual(f.unexpected,[]);
      assert.ok(f.requests.every(r=>r.method==='GET'));
    } finally {await f.context.close();}
  });
  await t.test('预先打开的旧列表没有本条记录时，仍能从新服务器页面取得结果',async()=>{
    const f=await fixture();
    try {
      assert.equal((await f.publisher.inspectResult(job)).workId,workId);
      assert.equal(await f.stale.innerText('body'),'旧列表，尚无本条记录\n\n'+job.copy.title);
      assert.deepEqual(f.unexpected,[]);
    } finally {await f.context.close();}
  });
  for(const [name,options,expected] of [
    ['候选编号不能靠旧同名列表升级成功',{recordTime:'2026年11月06日 15:36'},'awaiting_verification'],
    ['候选编号与列表另一编号冲突时不能成功',{listedId:otherId},'awaiting_verification'],
    ['候选编号、列表时间和详情一致后才完成',{},'submitted']
  ])await t.test(name,async()=>{
    const f=await fixture(options);
    try{
      const candidate=await f.context.newPage();await candidate.goto(origin+edit+'?mid='+workId);
      const result=await f.publisher.inspectResult({...job,expectedWorkId:workId,requireListEvidence:true});
      assert.equal(result.status,expected);assert.equal(result.workId,workId);assert.deepEqual(f.unexpected,[]);
    }finally{await f.context.close();}
  });
  // Run bounded negative waits together, rather than spending a minute on
  // serial cases. A visible empty/wrong title or a changed mid is no receipt.
  await Promise.all([
    ['载入其他标题不能冒认本条作品',{loadedTitle:'其他作品'}],
    ['等待期间作品编号变化不能沿用旧编号',{changeId:true}],
    ['一直为空的标题不能升级为已提交',{loadedTitle:''}]
  ].map(([name,options])=>t.test(name,async()=>{
    const f=await fixture(options);
    try {assert.equal((await f.publisher.inspectResult(job)).status,'awaiting_verification');assert.deepEqual(f.unexpected,[]);}
    finally {await f.context.close();}
  })));
  await t.test('两个同名候选不能凭其中一条编辑页冒认',async()=>{
    const f=await fixture({duplicate:true});
    try {assert.equal((await f.publisher.inspectResult(job)).status,'awaiting_verification');assert.equal(f.counts.edit,0);}
    finally {await f.context.close();}
  });
  await t.test('管理页初始空壳延迟800ms挂载且随机样式名变更时，语义兜底仍能核对成功',async()=>{
    const f=await fixture({delayedMountMs:800,cardClass:'video-card-Renamed99',titleClass:'info-title-Renamed88'});
    try {
      const result=await f.publisher.inspectResult(job);
      assert.equal(result.status,'submitted');
      assert.equal(result.workId,workId);
      assert.equal(result.visibility,'self');
      assert.deepEqual(f.unexpected,[]);
    } finally {await f.context.close();}
  });
  await t.test('复现467976ae：卡片无私密字样且编辑页无权限控件时，通过官方work_list接口确认私密回执',async()=>{
    const f=await fixture({
      delayedMountMs:400,
      cardPrivateLabel:'',
      apiPayload:{
        status_code:0,
        aweme_list:[{
          aweme_id:workId,
          title:job.copy.title,
          create_time:Math.floor(Date.parse('2026-11-07T07:36:00Z')/1000),
          video:{duration:30000},
          status:{private_status:1,in_reviewing:true},
          status_desc:'审核中',
        }],
      },
    });
    try {
      const result=await f.publisher.inspectResult(job);
      assert.equal(result.status,'submitted');
      assert.equal(result.workId,workId);
      assert.equal(result.visibility,'self');
      assert.equal(result.visibilityVerification,'creator_work_list_api');
      assert.equal(result.platformStatus,'under_review');
      assert.ok(f.counts.api>=1);
      assert.deepEqual(f.unexpected,[]);
    } finally {await f.context.close();}
  });
});
