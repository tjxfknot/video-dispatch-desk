'use strict';

// Independent native-control adapters for WeChat Channels and Xiaohongshu.
// No cookie import, stealth patch, private endpoint, LLM or automatic
// re-submission is used.
const fs=require('node:fs'),path=require('node:path');
const {workReference}=require('./managed-receipt.cjs');
const {scheduleIssue,parseAt}=require('./publish-schedule.cjs');
const {observeTencentPostList,matchTencentPostListItem}=require('./tencent-post-list.cjs');
const {observeXiaohongshuNoteList,matchXiaohongshuNoteItem}=require('./xiaohongshu-note-list.cjs');
const {normalizeCoverSource,coverPixelsMatch}=require('./douyin-publish-driver.cjs');
const {sampleCoverPixels}=require('./cover-pixels.cjs');
const {waitForVideoUpload,uploadSurface,UPLOAD_MAX_MS}=require('./upload-wait.cjs');
const {readCoverReadiness,waitForCoverReady,COVER_READY_MAX_MS}=require('./cover-readiness.cjs');
const CONFIG=Object.freeze({
  tencent:{label:'视频号',upload:'https://channels.weixin.qq.com/platform/post/create',manage:'https://channels.weixin.qq.com/platform/post/list',title:[],shortTitle:'input[placeholder*="短标题"]',editor:['div.input-editor:is([contenteditable="true" i],[contenteditable=""],[contenteditable="plaintext-only" i])','div.input-editor :is([contenteditable="true" i],[contenteditable=""],[contenteditable="plaintext-only" i])'],publish:'发表',tagMode:'text',cover:{landscape:'.horizontal-cover-wrap',portrait:'.vertical-cover-wrap'},dialog:'.weui-desktop-dialog',coverConfirm:'确认',coverConfirmAlternatives:['确定']},
  xiaohongshu:{label:'小红书',entry:'https://creator.xiaohongshu.com/new/home',entryText:'发布视频笔记',upload:'https://creator.xiaohongshu.com/publish/publish',manage:'https://creator.xiaohongshu.com/new/note-manager',title:['input[placeholder*="填写标题"]'],editor:['[contenteditable="true"]'],publish:'发布',tagMode:'candidate',topic:'#creator-editor-topic-container .item',cover:{portrait:'div.upload-cover, div.cover-plugin-preview'},dialog:'div.d-modal',coverConfirm:'完成'}
});
const CHECK_KEYS=['video','covers','text','declaration','collection','schedule','visibility','savePermission'];
const clean=s=>String(s || '').replace(/[\u200b\u00a0]/g,' ').replace(/\s+/g,' ').trim();

// 视频号定时发表控件（2026-11-22 真实页面探测）：
// .post-time-wrap 内为“不定时”(value="0") / “定时”(value="1") 单选框；
// 选中“定时”后显示 readonly 的 input[placeholder="请选择发表时间"]（格式 YYYY-MM-DD HH:mm），
// 通过 .weui-desktop-picker__date 日历与 .weui-desktop-picker__time 时/分列表选择。
// 找不到唯一控件、目标项被禁用、回读不一致或此刻已不足最早时间，均抛错停止，绝不退回不定时。
function tencentScheduleParts(schedule){
  const date=parseAt(schedule?.at);
  if(!date)throw new Error('请选择有效的定时发布时间（北京时间）。');
  const bj=new Date(date.getTime()+8*3600_000),pad=n=>String(n).padStart(2,'0');
  const yyyy=bj.getUTCFullYear(),mm=bj.getUTCMonth()+1,dd=bj.getUTCDate();
  const hhStr=pad(bj.getUTCHours()),miStr=pad(bj.getUTCMinutes());
  return {yyyy,mm,dd,hhStr,miStr,text:`${yyyy}-${pad(mm)}-${pad(dd)} ${hhStr}:${miStr}`};
}
const tencentScheduleText=job=>job?.schedule?.mode==='scheduled'?`定时 ${String(job.schedule.at).replace('T',' ')}`:'不定时';

function createTencentScheduleControl({getPage,one,now=Date.now,assertRunning=()=>{},waitMs=30_000}){
  const vis=l=>l.filter({visible:true});
  function assertCurrent(job){
    if(job?.schedule?.mode!=='scheduled')return;
    const late=scheduleIssue('tencent',job.schedule,now(),{strict:true});
    if(late)throw new Error(late);
  }
  async function read(job){
    assertRunning();
    const wrap=vis(getPage().locator('.post-time-wrap'));
    const count=await wrap.count();
    if(count>1)throw new Error('视频号定时发表控件不唯一，未提交。');
    if(count===0){
      if(job?.schedule?.mode==='scheduled')throw new Error('视频号未显示定时发表控件，已停止，未提交。');
      return '不定时';
    }
    const radio0=wrap.locator('input.weui-desktop-form__radio[value="0"]');
    const radio1=wrap.locator('input.weui-desktop-form__radio[value="1"]');
    if(await radio0.count()!==1 || await radio1.count()!==1)throw new Error('视频号定时发表单选框不唯一，未提交。');
    const c0=await radio0.isChecked(),c1=await radio1.isChecked();
    if(c0===c1)throw new Error('视频号定时发表状态无法唯一核对，未提交。');
    if(c0){
      const shown=vis(wrap.locator('input[placeholder="请选择发表时间"]'));
      if(await shown.count() && (await shown.first().inputValue()).trim())throw new Error('视频号页面仍有发表时间残留，未提交。');
      return '不定时';
    }
    const dateInput=await one(wrap.locator('input[placeholder="请选择发表时间"]'),'视频号发表时间框');
    return `定时 ${(await dateInput.inputValue()).trim()}`;
  }
  async function apply(job){
    assertRunning();
    const page=getPage();
    if(job?.schedule?.mode!=='scheduled'){
      const wrap=vis(page.locator('.post-time-wrap'));
      if(await wrap.count()>1)throw new Error('视频号定时发表控件不唯一，未提交。');
      if(await wrap.count()===1){
        const radio0=wrap.locator('input.weui-desktop-form__radio[value="0"]');
        const radio1=wrap.locator('input.weui-desktop-form__radio[value="1"]');
        if(await radio1.count()===1 && await radio1.isChecked()){
          const label0=await one(wrap.locator('label.weui-desktop-form__check-label').filter({hasText:/^\s*不定时\s*$/}),'视频号不定时选项');
          await label0.click();
          const deadline=Date.now()+Math.min(waitMs,3000);
          while((!await radio0.isChecked() || await vis(wrap.locator('input[placeholder="请选择发表时间"]')).count()>0) && Date.now()<deadline){
            assertRunning();await page.waitForTimeout(100);
          }
          if(!await radio0.isChecked())throw new Error('视频号“不定时”选项未生效，未提交。');
        }
      }
      const dates=vis(page.locator('input[placeholder*="选择日期"], input[placeholder*="发布时间"], input[placeholder*="发表时间"], input[type="datetime-local"]'));
      for(let i=0;i<await dates.count();i++)if((await dates.nth(i).inputValue()).trim())throw new Error('视频号页面仍有定时配置，未提交；请核对发布时间。');
      return;
    }
    assertCurrent(job);
    const target=tencentScheduleParts(job.schedule);
    const wrap=await one(page.locator('.post-time-wrap'),'视频号定时发表区域');
    const radio1=wrap.locator('input.weui-desktop-form__radio[value="1"]');
    if(await radio1.count()!==1)throw new Error('视频号定时发表单选框不唯一，未提交。');
    if(!await radio1.isChecked()){
      const label1=await one(wrap.locator('label.weui-desktop-form__check-label').filter({hasText:/^\s*定时\s*$/}),'视频号定时选项');
      await label1.click();
      const deadline=Date.now()+Math.min(waitMs,3000);
      while(!await radio1.isChecked() && Date.now()<deadline){assertRunning();await page.waitForTimeout(100);}
      if(!await radio1.isChecked())throw new Error('视频号“定时”选项未生效，未提交。');
    }
    const dateInput=await one(wrap.locator('input[placeholder="请选择发表时间"]'),'视频号发表时间框');
    await dateInput.scrollIntoViewIfNeeded().catch(()=>{});
    const dd=wrap.locator('.weui-desktop-picker__date > .weui-desktop-picker__dd');
    if(!await dd.isVisible().catch(()=>false)){
      await dateInput.click();
      await dd.waitFor({state:'visible',timeout:Math.min(waitMs,5000)}).catch(()=>{});
      if(!await dd.isVisible().catch(()=>false))throw new Error('视频号定时日历面板未展开，未提交。');
    }
    let matchedMonth=false;
    for(let step=0;step<6;step++){
      assertRunning();
      const labels=await wrap.locator('.weui-desktop-picker__panel__label').allTextContents();
      const curY=Number((labels[0] || '').replace(/\D/g,'')),curM=Number((labels[1] || '').replace(/\D/g,''));
      if(!curY || !curM)throw new Error('视频号定时日历年月无法识别，未提交。');
      if(curY===target.yyyy && curM===target.mm){matchedMonth=true;break;}
      const diff=(target.yyyy-curY)*12+(target.mm-curM);
      const navBtn=wrap.locator(diff>0?'.weui-desktop-btn__icon__right':'.weui-desktop-btn__icon__left');
      if(!await navBtn.isVisible().catch(()=>false))throw new Error(`视频号定时日历无法切换到 ${target.yyyy}年${target.mm}月，未提交。`);
      await navBtn.click();
      await page.waitForTimeout(200);
    }
    if(!matchedMonth)throw new Error(`视频号定时日历未能切换到 ${target.yyyy}年${target.mm}月，未提交。`);
    const dayLinks=wrap.locator('.weui-desktop-picker__table a:not(.weui-desktop-picker__faded)').filter({hasText:new RegExp(`^\\s*${target.dd}\\s*$`)});
    if(await dayLinks.count()!==1)throw new Error(`视频号定时日期 ${target.yyyy}-${String(target.mm).padStart(2,'0')}-${String(target.dd).padStart(2,'0')} 不唯一，未提交。`);
    if(await dayLinks.evaluate(el=>el.classList.contains('weui-desktop-picker__disabled')))throw new Error(`视频号定时日期 ${target.yyyy}-${String(target.mm).padStart(2,'0')}-${String(target.dd).padStart(2,'0')} 已被平台禁用，未提交。`);
    await dayLinks.click();
    await page.waitForTimeout(200);
    const timeInput=await one(wrap.locator('input[placeholder="请选择时间"]'),'视频号时间选择框');
    await timeInput.click();
    await page.waitForTimeout(200);
    const hourLis=wrap.locator('.weui-desktop-picker__time__hour li').filter({hasText:new RegExp(`^\\s*${target.hhStr}\\s*$`)});
    if(await hourLis.count()!==1)throw new Error(`视频号定时小时 ${target.hhStr} 不唯一，未提交。`);
    if(await hourLis.evaluate(el=>el.classList.contains('weui-desktop-picker__disabled')))throw new Error(`视频号定时小时 ${target.hhStr} 已被平台禁用，未提交。`);
    await hourLis.click();
    await page.waitForTimeout(200);
    const minLis=wrap.locator('.weui-desktop-picker__time__panel').nth(1).locator('li').filter({hasText:new RegExp(`^\\s*${target.miStr}\\s*$`)});
    if(await minLis.count()!==1)throw new Error(`视频号定时分钟 ${target.hhStr}:${target.miStr} 不唯一，未提交。`);
    if(await minLis.evaluate(el=>el.classList.contains('weui-desktop-picker__disabled')))throw new Error(`视频号定时分钟 ${target.hhStr}:${target.miStr} 已被平台禁用，未提交。`);
    await minLis.click();
    await page.waitForTimeout(200);
    if(await dd.isVisible().catch(()=>false)){
      await wrap.getByText('定时发表',{exact:true}).first().click().catch(()=>{});
      await page.waitForTimeout(200);
    }
    const readDeadline=Date.now()+Math.min(waitMs,5000);
    while(Date.now()<readDeadline){
      assertRunning();
      const val=(await dateInput.inputValue()).trim();
      if(await radio1.isChecked() && val===target.text)return;
      await page.waitForTimeout(200);
    }
    throw new Error(`视频号定时时间回读为“${(await dateInput.inputValue()).trim() || '空'}”，与本条要求的 ${target.text} 不一致，未提交。`);
  }
  return {read,apply,assertCurrent};
}

// 小红书定时发布控件（2026-11-24 真实页面探测）：
// .post-time-wrapper 内含 .d-switch 开关（input[type="checkbox"]）；
// 打开后展开 .date-picker-container input.d-text（北京时间 YYYY-MM-DD HH:mm），
// 平台官方提示“定时发布采用北京时间，支持选择未来 1 小时～14 天内的任意时间”，
// 1 小时内或超过 14 天会被平台自动调整/拒绝。支持直接输入 + 回车并严格回读。
const xiaohongshuScheduleText=job=>job?.schedule?.mode==='scheduled'?`定时 ${String(job.schedule.at).replace('T',' ')}`:'立即发布';

function createXiaohongshuScheduleControl({getPage,one,now=Date.now,assertRunning=()=>{},waitMs=30_000}){
  const vis=l=>l.filter({visible:true});
  function assertCurrent(job){
    if(job?.schedule?.mode!=='scheduled')return;
    const late=scheduleIssue('xiaohongshu',job.schedule,now(),{strict:true});
    if(late)throw new Error(late);
  }
  async function read(job){
    assertRunning();
    const wrap=vis(getPage().locator('.post-time-wrapper'));
    const count=await wrap.count();
    if(count>1)throw new Error('小红书定时发布控件不唯一，未提交。');
    if(count===0){
      if(job?.schedule?.mode==='scheduled')throw new Error('小红书未显示定时发布控件，已停止，未提交。');
      return '立即发布';
    }
    const checkbox=wrap.locator('.d-switch input[type="checkbox"]');
    if(await checkbox.count()!==1)throw new Error('小红书定时发布开关不唯一，未提交。');
    if(!await checkbox.isChecked()){
      const shown=vis(wrap.locator('.date-picker-container input.d-text'));
      if(await shown.count() && (await shown.first().inputValue()).trim())throw new Error('小红书页面仍有定时发布时间残留，未提交。');
      return '立即发布';
    }
    const dateInput=await one(wrap.locator('.date-picker-container input.d-text'),'小红书定时发布时间框');
    return `定时 ${(await dateInput.inputValue()).trim()}`;
  }
  async function apply(job){
    assertRunning();
    const page=getPage();
    if(job?.schedule?.mode!=='scheduled'){
      const wrap=vis(page.locator('.post-time-wrapper'));
      if(await wrap.count()>1)throw new Error('小红书定时发布控件不唯一，未提交。');
      if(await wrap.count()===1){
        const checkbox=wrap.locator('.d-switch input[type="checkbox"]');
        if(await checkbox.count()===1 && await checkbox.isChecked()){
          const sw=await one(wrap.locator('.d-switch'),'小红书定时发布开关');
          await sw.click();
          const deadline=Date.now()+Math.min(waitMs,3000);
          while((await checkbox.isChecked() || await vis(wrap.locator('.date-picker-container input.d-text')).count()>0) && Date.now()<deadline){
            assertRunning();await page.waitForTimeout(100);
          }
          if(await checkbox.isChecked())throw new Error('小红书关闭“定时发布”未生效，未提交。');
        }
      }
      const dates=vis(page.locator('.date-picker-container input.d-text, input[placeholder*="选择日期"], input[placeholder*="发布时间"], input[type="datetime-local"]'));
      for(let i=0;i<await dates.count();i++)if((await dates.nth(i).inputValue()).trim())throw new Error('小红书页面仍有定时配置，未提交；请核对发布时间。');
      return;
    }
    assertCurrent(job);
    const target=tencentScheduleParts(job.schedule);
    const wrap=await one(page.locator('.post-time-wrapper'),'小红书定时发布区域');
    const checkbox=wrap.locator('.d-switch input[type="checkbox"]');
    if(await checkbox.count()!==1)throw new Error('小红书定时发布开关不唯一，未提交。');
    if(!await checkbox.isChecked()){
      const sw=await one(wrap.locator('.d-switch'),'小红书定时发布开关');
      await sw.click();
      const deadline=Date.now()+Math.min(waitMs,3000);
      while(!await checkbox.isChecked() && Date.now()<deadline){assertRunning();await page.waitForTimeout(100);}
      if(!await checkbox.isChecked())throw new Error('小红书开启“定时发布”未生效，未提交。');
    }
    const dateInput=await one(wrap.locator('.date-picker-container input.d-text'),'小红书定时发布时间框');
    await dateInput.click({clickCount:3});
    await dateInput.fill(target.text);
    await dateInput.press('Enter');
    const tips=wrap.locator('.has-tips').first();
    if(await tips.count())await tips.click({force:true}).catch(()=>{});
    await page.waitForTimeout(350);
    const readback=(await dateInput.inputValue()).trim();
    if(readback!==target.text){
      throw new Error(`小红书定时发布时间回读为“${readback || '空'}”，与本条计划“${target.text}”不一致，未提交。`);
    }
  }
  return {read,apply,assertCurrent};
}

function createNativePublisher({context,platform,entryPage,getPageDiagnostics=()=>null,verifyIdentity,onVerifyFiles=async()=>{},diagnosticsRoot,waitMs=30_000,entryWaitMs=waitMs*2,uploadWaitMs=UPLOAD_MAX_MS,coverWaitMs=COVER_READY_MAX_MS,now=Date.now,allowSubmit=true,focusCoordinator=null,xhsReloadIntervalMs=12_000,xhsEmptyReloadMs=15_000,xhsMaxReloads=3}){
  const canSubmit=allowSubmit===true;
  const config=CONFIG[platform];if(!config)throw new Error('此平台没有原生发布执行器。');
  let page,ownedPage,reader,prepared,activeSignal,submitted=false,stopped=false,xhsInspectAttempt=0;
  let publishControlEvidence,buttonReader;
  const loadFailures=[];
  const observedPages=new WeakSet();
  let locationControl,copyReadback,uploadReadback,coverWaitReadback;
  const coverReadback=[];
  const visible=l=>l.filter({visible:true});
  const assertRunning=()=>{if(stopped || activeSignal?.aborted)throw new Error('本次发布已停止；不会继续提交。');};
  const scheduleControl=platform==='tencent'
    ? createTencentScheduleControl({getPage:()=>page,one,now,assertRunning,waitMs})
    : platform==='xiaohongshu'
      ? createXiaohongshuScheduleControl({getPage:()=>page,one,now,assertRunning,waitMs})
      : null;
  async function withFocus(stepName,targetPageFn,fn){
    if(!focusCoordinator || typeof focusCoordinator.runExclusive!=='function')return fn();
    return focusCoordinator.runExclusive(`${platform}:${stepName}`,async()=>{
      const target=typeof targetPageFn==='function'?targetPageFn():targetPageFn;
      if(target && !target.isClosed())await target.bringToFront().catch(()=>{});
      return fn();
    },{signal:activeSignal});
  }
  async function recordReceiptDiagnostic(info){
    if(!diagnosticsRoot)return;
    try{
      fs.mkdirSync(diagnosticsRoot,{recursive:true,mode:0o700});
      const pageState=reader && !reader.isClosed()
        ? await reader.evaluate(()=>({path:location.pathname,visibility:document.visibilityState,readyState:document.readyState,textLength:(document.body?.innerText || '').length})).catch(()=>({unavailable:true}))
        : {unavailable:true};
      fs.writeFileSync(path.join(diagnosticsRoot,`回执核查诊断-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),platform,...info,pageState},null,2),{mode:0o600});
    }catch{}
  }
  async function inspectEntry({follow=false}={}){
    if(platform!=='xiaohongshu')return [];
    const result=[];
    for(const candidate of context.pages()){
      let u;try{u=new URL(candidate.url());}catch{continue;}
      if(u.origin!==new URL(config.upload).origin || !['/home','/new/home'].includes(u.pathname))continue;
      await candidate.getByText('发布笔记',{exact:true}).first().waitFor({state:'visible',timeout:waitMs}).catch(()=>{});
      const entries=await candidate.getByText('发布笔记',{exact:true}).evaluateAll(nodes=>nodes.slice(0,3).map(el=>{
        const chain=[];for(let n=el;n && chain.length<4;n=n.parentElement){let link=null;if(n.href){try{const u=new URL(n.href);link={origin:u.origin,path:u.pathname,source:/^[a-z_]{1,30}$/.test(u.searchParams.get('source') || '')?u.searchParams.get('source'):null};}catch{}}
          chain.push({tag:n.tagName,role:n.getAttribute('role'),className:n.className,link});}
        return chain;
      }));
      const document=await candidate.evaluate(()=>({state:document.readyState,htmlLength:document.documentElement.outerHTML.length,textLength:document.body?.innerText.length || 0,scripts:[...document.scripts].slice(0,8).map(s=>{try{const u=new URL(s.src);return {origin:u.origin,path:u.pathname};}catch{return {inline:true}}})}));
      const frames=await Promise.all(candidate.frames().map(async frame=>{
        const at=new URL(frame.url());if(at.origin!==u.origin && frame.url()!=='about:blank')return {origin:at.origin,path:at.pathname};
        return {path:at.pathname,text:(await frame.locator('body').evaluateAll(bodies=>bodies.filter(b=>!b.parentElement?.closest('body')).map(b=>b.innerText || '').join('\n')).catch(()=>'' )).slice(0,650),buttons:await frame.getByRole('button').allTextContents().catch(()=>[]),publishTextCount:await frame.getByText('发布',{exact:true}).count()};
      }));
      const item={path:u.pathname,entries,document,frames,runtimeDiagnostics:getPageDiagnostics(candidate)};result.push(item);
      if(diagnosticsRoot){fs.mkdirSync(diagnosticsRoot,{recursive:true,mode:0o700});const shot=path.join(diagnosticsRoot,'entry-state.png');await candidate.screenshot({path:shot,timeout:5000}).then(()=>fs.chmodSync(shot,0o600)).catch(()=>{});}
      if(follow && entries.length){
        const entry=visible(candidate.getByText('发布笔记',{exact:true}));if(await entry.count()!==1)throw new Error('官方发布入口不唯一，停止。');
        const popup=context.waitForEvent('page',{timeout:waitMs});
        const samePage=candidate.waitForURL(url=>url.origin===u.origin && url.pathname===new URL(config.upload).pathname,{timeout:waitMs,waitUntil:'commit'}).then(()=>candidate);
        await entry.click();const opened=await Promise.any([popup,samePage]);
        await opened.waitForURL(url=>url.origin===u.origin && url.pathname===new URL(config.upload).pathname,{timeout:waitMs,waitUntil:'commit'});
        const at=new URL(opened.url());item.opened={origin:at.origin,path:at.pathname,source:at.searchParams.get('source')};
      }
      if(entries.length || result.length>=1)break;
    }
    return result;
  }
  async function inspectFooterSurface(){
    if(platform!=='xiaohongshu' || !ownedPage || ownedPage.isClosed())return null;
    const session=await context.newCDPSession(ownedPage);
    try{
      await session.send('DOM.enable');
      const {root}=await session.send('DOM.getDocument',{depth:0});
      const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector:'.video-footer'});
      let footer=null;
      if(nodeId){
        const {node}=await session.send('DOM.describeNode',{nodeId,depth:-1,pierce:true});
        let count=0;
        const compact=n=>{if(!n || ++count>60)return null;const attributes={};for(let i=0;i<(n.attributes || []).length;i+=2)if(['class','role','disabled','aria-disabled','aria-hidden','type','aria-label'].includes(n.attributes[i]))attributes[n.attributes[i]]=n.attributes[i+1];return {tag:n.nodeName,backendNodeId:n.backendNodeId,shadowRootType:n.shadowRootType,text:n.nodeType===3?String(n.nodeValue).slice(0,100):undefined,attributes,children:[...(n.children || []),...(n.shadowRoots || []),...(n.contentDocument?[n.contentDocument]:[])].map(compact).filter(Boolean)};};
        footer=compact(node);
      }
      const {nodes}=await session.send('Accessibility.getFullAXTree');
      return {footer,buttons:nodes.filter(n=>n.role?.value==='button' && /发布|暂存/.test(n.name?.value || '')).map(n=>({name:n.name.value,ignored:n.ignored,backendNodeId:n.backendDOMNodeId,properties:n.properties?.filter(p=>['disabled','hidden','focusable'].includes(p.name))}))};
    }finally{await session.detach().catch(()=>{});}
  }
  async function one(locator,label,{attached=false,timeout=waitMs}={}){
    const match=attached?locator:visible(locator);
    try{await match.first().waitFor({state:attached?'attached':'visible',timeout});}catch{throw new Error(`${config.label}未显示${label}，已停止；请在原窗口检查登录或页面提示。`);}
    if(await match.count()!==1)throw new Error(`${config.label}的${label}不唯一，已停止，未提交。`);
    return match;
  }
  async function firstUnique(selectors,label,scope=page){
    for(const selector of selectors){const l=visible(scope.locator(selector));const n=await l.count();if(n===1)return l;if(n>1)throw new Error(`${config.label}的${label}不唯一，未提交。`);}
    return one(scope.locator(selectors[0]),label);
  }
  function allowedOwnedFrame(frame){
    try{if(new URL(frame.url()).origin===new URL(config.upload).origin)return true;}catch{}
    return ['about:blank','about:srcdoc'].includes(frame.url()) && !!frame.parentFrame() && allowedOwnedFrame(frame.parentFrame());
  }
  const publishButtonLabel=job=>(platform==='xiaohongshu' && job?.schedule?.mode==='scheduled')?'定时发布':config.publish;
  async function finalPublishButton(job){
    const label=publishButtonLabel(job);
    const deadline=Date.now()+waitMs;
    do{
      assertRunning();const matches=[];
      for(const frame of ownedPage.frames()){
        if(!allowedOwnedFrame(frame))continue;
        const button=visible(frame.getByRole('button',{name:label,exact:true}));
        for(let i=0;i<await button.count();i++)matches.push({frame,button:button.nth(i)});
      }
      if(matches.length>1)throw new Error(`${config.label}的最终发布按钮不唯一，未提交。`);
      if(platform==='xiaohongshu'){
        if(!buttonReader)buttonReader=await require('./chromium-native-button.cjs').createChromiumButtonReader({context,page:ownedPage,expectedUrl:config.upload,assertRunning});
        if(matches.length)await buttonReader.candidates(label);
        else {const native=await buttonReader.findNative(label);if(native){publishControlEvidence=native.evidence;return native.button;}}
      }
      if(matches.length===1){const match=matches[0],at=new URL(match.frame.url());publishControlEvidence={path:at.pathname,origin:at.origin,insideOwnedChild:match.frame!==ownedPage.mainFrame(),tag:await match.button.evaluate(el=>el.tagName)};return match.button;}
      if(Date.now()>=deadline)break;await ownedPage.waitForTimeout(100);
    }while(true);
    throw new Error(`${config.label}未显示最终发布按钮，已停止；请在原窗口检查登录或页面提示。`);
  }
  function observeUploadPage(target){
    if(observedPages.has(target))return;observedPages.add(target);
    // 阻止点击入口或封面控件时弹出系统文件选择窗；始终由 input.setInputFiles 交付文件。
    if(platform==='xiaohongshu')target.on('filechooser',()=>{});
    target.on('requestfailed',request=>{try{const u=new URL(request.url());if(u.protocol==='https:' && loadFailures.length<12)loadFailures.push({origin:u.origin,path:u.pathname.replace(/[a-f0-9]{24,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi,'[id]'),type:request.resourceType(),error:request.failure()?.errorText});}catch{}});
  }
  async function openUploadPage(){
    let reuseHome=false;
    if(!ownedPage || ownedPage.isClosed()){
      if(config.entry && entryPage && !entryPage.isClosed()){
        try{const u=new URL(entryPage.url());reuseHome=u.origin===new URL(config.entry).origin && ['/home','/new/home'].includes(u.pathname);}catch{}
      }
      ownedPage=reuseHome?entryPage:await context.newPage();
    }
    page=ownedPage;observeUploadPage(ownedPage);
    if(!reuseHome)await ownedPage.goto(config.entry || config.upload,{waitUntil:'commit',timeout:waitMs});
    if(!config.entry)return;
    const home=ownedPage,expected=new URL(config.upload);
    await home.bringToFront();
    const entry=await one(home.getByText(config.entryText,{exact:true}),'官方首页的视频发布入口',{timeout:entryWaitMs});
    const popup=home.waitForEvent('popup',{timeout:waitMs});
    const inPage=home.waitForURL(url=>url.origin===expected.origin && url.pathname===expected.pathname,{timeout:waitMs,waitUntil:'commit'}).then(()=>home);
    await entry.click();ownedPage=await Promise.any([popup,inPage]);page=ownedPage;observeUploadPage(ownedPage);
    await ownedPage.waitForURL(url=>url.origin===expected.origin && url.pathname===expected.pathname,{timeout:waitMs,waitUntil:'commit'});
    await ownedPage.bringToFront();
    if(ownedPage!==home && home!==entryPage)await home.close();
  }
  async function diagnose(error){
    if(!diagnosticsRoot)return;
    let outputFile,report,diagnosticStage='minimal_record';
    try{
      fs.mkdirSync(diagnosticsRoot,{recursive:true,mode:0o700});
      const u=new URL((ownedPage || page)?.url() || 'about:blank');
      report={at:new Date().toISOString(),platform,path:u.pathname,message:String(error.message).replace(/https?:\/\/\S+/g,'[官方页面]').slice(0,800),errorCode:/^[A-Z_]{1,80}$/.test(error.code || '')?error.code:'',loadFailures,submitted};
      outputFile=path.join(diagnosticsRoot,`平台诊断-${Date.now()}.json`);
      fs.writeFileSync(outputFile,JSON.stringify(report,null,2),{mode:0o600});
      if(!page || ownedPage?.isClosed()){report.pageUnavailable=true;fs.writeFileSync(outputFile,JSON.stringify(report,null,2),{mode:0o600});return;}
      diagnosticStage='body';
      // Diagnostics cover every body layer (视频号 renders two); nested light
      // DOM bodies are already inside their outer body, so only roots count.
      const evidence=await page.locator('body').evaluateAll(bodies=>{const roots=bodies.filter(b=>!b.parentElement?.closest('body'));return {bodyCount:bodies.length,text:roots.map(b=>b.innerText || '').join('\n').slice(0,16000),controls:roots.flatMap(b=>[...b.querySelectorAll('input,textarea,button,[contenteditable="true"]')]).slice(0,100).map(el=>({tag:el.tagName,placeholder:el.getAttribute('placeholder'),type:el.getAttribute('type'),accept:el.getAttribute('accept'),text:(el.innerText || '').slice(0,100),visible:!!el.getClientRects().length}))};});
      diagnosticStage='topics';
      const topicRows=config.topic?await page.locator(config.topic).evaluateAll(nodes=>nodes.slice(0,12).map(el=>({tag:el.tagName,className:el.className,textContent:String(el.textContent || '').slice(0,180),innerText:String(el.innerText || '').slice(0,180),children:[...el.children].slice(0,5).map(n=>({tag:n.tagName,className:n.className,text:String(n.textContent || '').slice(0,100)}))}))):[];
      diagnosticStage='frames';
      const frames=ownedPage?await Promise.all(ownedPage.frames().map(async frame=>{
        try{const at=new URL(frame.url());return {origin:at.origin,path:at.pathname,files:await frame.locator('input[type="file"]').evaluateAll(nodes=>nodes.map(n=>({accept:n.accept}))),publishButtons:allowedOwnedFrame(frame)?await frame.getByRole('button',{name:config.publish,exact:true}).allTextContents():[]}}catch{return {unavailable:true};}
      })):[];
      diagnosticStage='editors';
      // Record the editable root itself and every native spelling, including
      // empty/opaque controls. Do not let hidden dialogs exhaust the budget
      // before the visible editor, and do not store field values or URLs.
      const editorCandidates=await page.locator('.input-editor,[contenteditable],[role="textbox"],textarea').evaluateAll(nodes=>nodes.map(el=>({
        tag:el.tagName,className:String(el.className || '').slice(0,240),role:el.getAttribute('role'),editable:el.getAttribute('contenteditable'),isContentEditable:el.isContentEditable,
        placeholder:el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),label:el.getAttribute('aria-label'),visible:!!el.getClientRects().length,
        ancestors:[el.parentElement,el.parentElement?.parentElement].filter(Boolean).map(n=>({tag:n.tagName,className:String(n.className || '').slice(0,180)}))
      })).sort((a,b)=>Number(b.visible)-Number(a.visible)).slice(0,30));
      const editorStructure=await page.locator('[contenteditable]').evaluateAll(nodes=>nodes.filter(el=>el.isContentEditable && el.getClientRects().length).slice(0,2).map(editor=>[...editor.querySelectorAll('*')].slice(0,35).map(n=>({tag:n.tagName,className:n.className,type:n.getAttribute('data-type'),editable:n.getAttribute('contenteditable'),text:(n.textContent || '').slice(0,160)}))));
      diagnosticStage='controls';
      const controlStructure=await page.getByText(/^(?:内容来源声明|添加内容类型声明|添加地点|设置封面|发布|确定|个人观点.*)$/).evaluateAll(nodes=>nodes.slice(0,15).map(el=>{const chain=[];for(let n=el;n && chain.length<3;n=n.parentElement)chain.push({tag:n.tagName,role:n.getAttribute('role'),className:n.className,text:(n.innerText || '').slice(0,700)});return chain;}));
      diagnosticStage='covers';
      const coverStructure=await page.locator(Object.values(config.cover).join(',')).evaluateAll(nodes=>nodes.slice(0,4).map(root=>[root,...root.querySelectorAll('*')].slice(0,80).map(el=>({tag:el.tagName,className:el.className,role:el.getAttribute('role'),label:el.getAttribute('aria-label'),title:el.getAttribute('title'),text:el.children.length?'':String(el.textContent || '').slice(0,80),visible:!!el.getClientRects().length,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,hasBackgroundImage:getComputedStyle(el).backgroundImage.startsWith('url(')}))));
      diagnosticStage='location';
      const locationStructure=await page.getByText(/^(?:作品定位|位置|地点|所在位置|地理位置)$/).evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).slice(0,3).map(label=>{
        const result=[];for(let n=label,depth=0;n && depth<3;n=n.parentElement,depth++)result.push({tag:n.tagName,className:String(n.className || '').slice(0,180),role:n.getAttribute('role'),text:String(n.innerText || '').slice(0,200),children:[...n.children].slice(0,8).map(c=>({tag:c.tagName,className:String(c.className || '').slice(0,180),role:c.getAttribute('role'),label:c.getAttribute('aria-label'),text:String(c.innerText || '').slice(0,120)}))});return result;
      }));
      diagnosticStage='dialogs';
      const dialogs=await page.locator('[role="dialog"], [class*="modal"], [class*="dialog"]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).slice(0,12).map(n=>({tag:n.tagName,className:n.className,role:n.getAttribute('role'),text:(n.innerText || '').slice(0,1500)})));
      diagnosticStage='publish_controls';
      const publishControls=await page.locator('button,[role="button"],[class*="publish"],[class*="submit"],[class*="footer"]').evaluateAll(nodes=>nodes.slice(0,100).map(n=>({tag:n.tagName,className:n.className,role:n.getAttribute('role'),text:(n.innerText || '').slice(0,200),disabled:n.disabled,ariaDisabled:n.getAttribute('aria-disabled'),visible:!!n.getClientRects().length,display:getComputedStyle(n).display})));
      diagnosticStage='viewport';
      const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollY,bodyHeight:document.body.scrollHeight,htmlLength:document.documentElement.outerHTML.length,scriptCount:document.scripts.length,visibility:document.visibilityState,documentState:document.readyState}));
      Object.assign(report,{...evidence,topicRows,editorCandidates,editorStructure,controlStructure,coverStructure,locationStructure,dialogs,publishControls,viewport,copyReadback,coverReadback,uploadReadback,coverWaitReadback,frames});
      diagnosticStage='runtime_diagnostics';
      report.runtimeDiagnostics=getPageDiagnostics(ownedPage);
      fs.writeFileSync(outputFile,JSON.stringify(report,null,2),{mode:0o600});
      if(ownedPage && !ownedPage.isClosed()){const screenshot=path.join(diagnosticsRoot,'prepare-failure-page.png');await ownedPage.screenshot({path:screenshot,fullPage:true,timeout:5000}).then(()=>fs.chmodSync(screenshot,0o600)).catch(()=>{});}
    }catch(diagnosticError){
      if(outputFile && report)try{report.diagnosticFailure={stage:diagnosticStage,name:String(diagnosticError.name || 'Error').slice(0,80)};fs.writeFileSync(outputFile,JSON.stringify(report,null,2),{mode:0o600});}catch{}
    }
  }
  async function fileInput(kind,scope=page){
    if(kind==='video' && scope===page && ownedPage){
      const deadline=Date.now()+entryWaitMs;let entryUsed=false;
      do{
        assertRunning();const matches=[];
        for(const frame of ownedPage.frames()){
          if(!allowedOwnedFrame(frame))continue;
          const all=frame.locator('input[type="file"]'),count=await all.count();
          for(let i=0;i<count;i++){
            const accept=await all.nth(i).getAttribute('accept') || '';
            if(/video|\.mp4|\.mov/i.test(accept) || (!accept && count===1))matches.push({frame,input:all.nth(i)});
          }
        }
        if(matches.length>1)throw new Error(`${config.label}出现多个视频文件控件，未上传。`);
        if(matches.length===1){page=matches[0].frame===ownedPage.mainFrame()?ownedPage:matches[0].frame;return matches[0].input;}
        if(platform==='tencent' && !entryUsed){
          const entry=visible(ownedPage.getByRole('button',{name:'发表视频',exact:true}));
          if(await entry.count()===1){await entry.click();entryUsed=true;}
        }
        if(Date.now()>=deadline)break;await ownedPage.waitForTimeout(100);
      }while(true);
      const error=new Error(`${config.label}未找到本平台页面中的唯一视频文件控件，未上传。`);error.code='UPLOAD_FORM_NOT_READY';throw error;
    }
    const all=scope.locator('input[type="file"]');
    const deadline=Date.now()+(platform==='xiaohongshu' && kind==='image'?uploadWaitMs:waitMs);
    let choices=[],lastCount=0;
    while(true){
      assertRunning();
      lastCount=await all.count();
      choices=[];
      for(let i=0;i<lastCount;i++){
        const accept=await all.nth(i).getAttribute('accept').catch(()=>'') || '';
        if((kind==='video'?/video|\.mp4|\.mov/i:/image|\.png|\.jp[e]?g/i).test(accept))choices.push(i);
      }
      if(!choices.length && lastCount===1 && !(await all.first().getAttribute('accept').catch(()=>'')))choices.push(0);
      if(choices.length>=1 || Date.now()>=deadline)break;
      await ownedPage.waitForTimeout(100);
    }
    assertRunning();
    if(!choices.length && lastCount===0)throw new Error(`${config.label}${kind==='image'?'封面编辑器仍未加载上传控件，未上传封面':'视频上传控件尚未加载，未上传'}；请检查官方窗口。`);
    if(choices.length!==1)throw new Error(`${config.label}未找到唯一${kind==='video'?'视频':'封面'}文件控件（匹配 ${choices.length}/${lastCount}），未上传。`);
    return all.nth(choices[0]);
  }
  const editor=()=>firstUnique(config.editor,'正文输入框');
  async function canReopenEmptyUploadPage(){
    if(platform!=='xiaohongshu' || page!==ownedPage)return false;
    try{
      const actual=new URL(ownedPage.url()),expected=new URL(config.upload);
      if(actual.origin!==expected.origin || actual.pathname!==expected.pathname)return false;
      return ownedPage.evaluate(()=>{
        const text=document.body?.innerText || '';
        if(/登录|扫码|二维码|验证码|安全验证|访问受限|频繁|稍后再试|captcha|access denied/i.test(text))return false;
        if([...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(el=>el.getClientRects().length))return false;
        if([...document.querySelectorAll('video')].some(v=>v.currentSrc || v.src))return false;
        return true;
      });
    }catch{return false;}
  }
  async function editorText(){const e=await editor();return e.evaluate(el=>'value' in el?el.value:el.innerText);}
  const expectedDescription=job=>config.title.length?job.copy.description:[job.copy.title,job.copy.description].filter(Boolean).join('\n');
  async function shortTitleControl(){
    if(!config.shortTitle)return null;
    const control=visible(page.locator(config.shortTitle));
    const count=await control.count();
    if(count>1)throw new Error('视频号短标题控件不唯一，未提交。');
    return count===1?control:null;
  }
  async function copyState(job){
    const value=await editorText();let tags=[];
    if(config.tagMode==='input')tags=await visible(page.locator('.label-item-v2-container .label-item-v2-content, .tag-item, .tag-container .tag, [data-tag]')).allTextContents();
    else if(config.tagMode==='candidate')tags=await (await editor()).locator('[contenteditable="false"], [data-topic], .topic-tag, a').allTextContents();
    else tags=[...value.matchAll(/#([^#\s]+)(?:\s|$)/g)].map(m=>m[1]);
    tags=tags.map(t=>clean(t).replace(/^#/,'').replace(/\[话题\]#$/,'').replace(/[×✕]$/,'').trim()).filter(Boolean);
    const title=config.title.length?await (await firstUnique(config.title,'标题输入框')).inputValue():job.copy.title;
    const plain=config.tagMode==='candidate'?await (await editor()).evaluate(editor=>{const n=editor.cloneNode(true);n.querySelectorAll('[contenteditable="false"], [data-topic], .topic-tag, a').forEach(el=>el.remove());return n.innerText || n.textContent;}):value;
    const shortTitle=await shortTitleControl();
    return {title,description:clean(value),plainDescription:clean(plain),tags:[...new Set(tags)],...(config.shortTitle?{shortTitle:shortTitle?await shortTitle.inputValue():''}:{})};
  }
  async function fillCopy(job){
    if(config.title.length)await (await firstUnique(config.title,'标题输入框')).fill(job.copy.title);
    const shortTitle=await shortTitleControl();if(shortTitle && await shortTitle.inputValue())await shortTitle.fill('');
    const e=await editor();await e.fill(expectedDescription(job));
    for(const tag of job.copy.tags){
      assertRunning();
      if(config.tagMode==='input'){
        const input=await one(page.locator(config.topic),'标签输入框');
        await input.fill(tag);await input.press('Enter');
      }else{
        await e.focus();await e.press('ControlOrMeta+End');await e.pressSequentially(' #'+tag,{delay:20});
        if(config.tagMode==='candidate'){
          // Real topic rows append their view count after the exact topic name.
          // Match the complete first token, so 高考 never selects 高考祝福.
          const exact=page.locator(config.topic).filter({hasText:new RegExp('^#?'+tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:\\s*[0-9][0-9.,]*\\s*[万亿千]?\\s*(?:次?浏览|阅读))?\\s*$')});
          await (await one(exact,`“${tag}”话题候选`)).click();
        }else await e.press('Space');
      }
    }
    const actual=await copyState(job);copyReadback=actual;
    const expected=config.tagMode==='text'?clean([expectedDescription(job),...job.copy.tags.map(t=>'#'+t)].join(' ')):clean(expectedDescription(job));
    const description=config.tagMode==='candidate'?actual.plainDescription:actual.description;
    if(actual.title!==job.copy.title || description!==expected || job.copy.tags.some(t=>!actual.tags.includes(t)) || config.shortTitle && actual.shortTitle!=='')throw new Error(`${config.label}标题、正文或话题回读不一致，未提交；不会跳过所选话题。`);
  }
  async function imagePixels(locator){
    const image=await one(locator,'已保存封面预览');
    const details=await image.evaluate(el=>{const style=getComputedStyle(el);return {source:el.tagName==='IMG'?el.currentSrc || el.src:style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1],aspect:style.objectFit==='cover' || style.backgroundSize==='cover'?el.clientWidth/el.clientHeight:null,loaded:el.tagName==='IMG'?(el.complete && el.naturalWidth>0):true};});
    const direct=details.source?await page.evaluate(sampleCoverPixels,details).catch(()=>null):null;
    if(direct)return direct;
    // 2026-11-22 视频号实测：跨域 CDN 封面在 <wujie-app> Shadow DOM 内走元素截图可能偏移截到白底（551B）；
    // 当 <img> 已在页面真实载入（complete && naturalWidth > 0）且 src 为真实 HTTPS 图片时，
    // 通过当前浏览器上下文直接拉取 currentSrc 原图做严格像素比对，规避 canvas 跨域限制与截图偏移，不放松阈值。
    if(details.loaded && details.source && /^https?:\/\//i.test(details.source) && typeof page.context==='function'){
      const fetched=await (async()=>{
        const host=new URL(details.source).hostname;
        if(/\.(?:test|example|invalid|localhost)$/i.test(host) || host==='localhost')return null;
        const response=await page.context().request.get(details.source,{timeout:7000,headers:{referer:page.url()}});
        if(!response.ok())return null;
        const ct=String(response.headers()['content-type'] || 'image/jpeg').split(';')[0].trim();
        if(!/^image\//i.test(ct))return null;
        const body=await response.body();
        if(!body.length)return null;
        return page.evaluate(sampleCoverPixels,{source:`data:${ct};base64,${body.toString('base64')}`,aspect:details.aspect});
      })().catch(()=>null);
      if(fetched)return fetched;
    }
    const previous=process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY='1';let buffer;
    // 2026-11-21 视频号实测：跨域 CDN 封面走截图兜底时，兄弟节点 .edit-btn（“编辑”白字浮标）
    // 叠在缩略图底部 18px 导致像素比对误报；仅在本地截图瞬间临时隐藏该浮标并立刻恢复，不放松像素阈值。
    const overlays = platform==='tencent' ? image.locator('xpath=..').locator('.edit-btn') : null;
    const savedVis = overlays ? await overlays.evaluateAll(els => els.map(el => { const prev = el.style.visibility; el.style.visibility = 'hidden'; return prev; })).catch(()=>null) : null;
    try{buffer=await image.screenshot({timeout:7000,animations:'disabled'});}
    finally{
      if(overlays && savedVis) await overlays.evaluateAll((els, prevs) => els.forEach((el, i) => { el.style.visibility = prevs[i] ?? ''; }), savedVis).catch(()=>{});
      if(previous===undefined)delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY=previous;
    }
    return page.evaluate(sampleCoverPixels,{source:`data:image/png;base64,${buffer.toString('base64')}`});
  }
  async function coverRoot(kind){
    // A selector can identify both the preview wrapper and its child. Only
    // the smallest matching element is retained, never an arbitrary first.
    if(platform==='xiaohongshu'){
      const current=visible(page.locator('.cover-plugin-preview .cover > .default'));
      if(await current.count()>1)throw new Error('小红书封面预览不唯一，未提交。');
      if(await current.count()===1)return current;
    }
    const root=page.locator(config.cover[kind]);
    const visibleRoot=visible(root);
    if(await visibleRoot.count()===1)return visibleRoot;
    if(platform==='xiaohongshu')return firstUnique(['div.upload-cover','div.cover-plugin-preview'],'封面区域');
    return one(root,'封面区域');
  }
  async function coverPreview(kind){
    const root=await coverRoot(kind);
    if(platform==='xiaohongshu' && await root.evaluate(el=>el.matches('.cover-plugin-preview .cover > .default')))return root;
    const images=visible(root.locator('img'));
    if(await images.count()===1)return images;
    if(platform==='xiaohongshu' && await root.evaluate(el=>/^url\(/.test(getComputedStyle(el).backgroundImage)))return root;
    return one(images,'已保存封面预览');
  }
  async function waitCoverEnabled(control,{wrapper=false,onStep=()=>{}}={}){
    await waitForCoverReady({label:`${config.label}封面`,maxMs:coverWaitMs,assertRunning,onProgress:onStep,pause:ms=>page.waitForTimeout(ms),read:async()=>{
      const count=await control.count();
      if(count>1)throw new Error(`${config.label}封面入口不唯一，未上传封面、未提交。`);
      coverWaitReadback=count===1?await control.evaluate(readCoverReadiness,{wrapper}):{ready:false,reason:'平台尚未显示入口'};
      return coverWaitReadback;
    }});
  }
  async function resolveTencentCoverAction(root, edit){
    const editState = await edit.evaluate(readCoverReadiness);
    if(editState.ready)return {ready:true,target:edit,state:editState};
    // 2026-11-21 视频号真实页面：.edit-btn（“编辑”浮标）本身固定 pointer-events:none，
    // 实际可点击热区是其直接父容器 .vertical-img-wrap / .horizontal-img-wrap（74x98 缩略图区域，
    // 不包含下方 .tips-wrap 文字）。精确点击直接父容器而非外框 .vertical-cover-wrap。
    if(editState.reason==='编辑入口尚不可操作'){
      const parent = edit.locator('xpath=..');
      const parentState = await parent.evaluate(readCoverReadiness).catch(()=>({ready:false,reason:'编辑入口尚不可操作'}));
      if(parentState.ready)return {ready:true,target:parent,state:parentState};
      const rootState = await root.evaluate(readCoverReadiness);
      if(rootState.ready)return {ready:true,target:root,state:rootState};
    }
    return {ready:false,target:edit,state:editState};
  }
  async function setCover(kind,file,onStep=()=>{}){
    if(platform==='tencent')await waitCoverEnabled(visible(page.locator(config.cover[kind])),{wrapper:true,onStep:s=>onStep(s.message,s.progress)});
    const root=await coverRoot(kind);
    await waitCoverEnabled(root,{wrapper:true,onStep:(s)=>onStep(s.message,s.progress)});
    const edit=root.locator(platform==='tencent'?'.edit-btn':'.cover-edit-entry');
    if(['xiaohongshu','tencent'].includes(platform) && await edit.count()){
      assertRunning();if(!await edit.isVisible())await root.hover();const entry=await one(edit,'编辑封面入口');
      if(platform==='tencent'){
        let clickTarget=entry;
        await waitForCoverReady({label:`${config.label}封面`,maxMs:coverWaitMs,assertRunning,onProgress:s=>onStep(s.message,s.progress),pause:ms=>page.waitForTimeout(ms),read:async()=>{
          const resolved=await resolveTencentCoverAction(root,entry);
          clickTarget=resolved.target;coverWaitReadback=resolved.state;return resolved.state;
        }});
        assertRunning();
        await ownedPage.bringToFront();
        await clickTarget.scrollIntoViewIfNeeded().catch(()=>{});
        await clickTarget.click();
        const modalCheck=visible(page.locator(config.dialog));
        const opened=await modalCheck.first().waitFor({state:'visible',timeout:Math.min(Math.max(Math.floor(waitMs/3),400),3000)}).then(()=>true).catch(()=>false);
        if(!opened){
          assertRunning();
          await ownedPage.bringToFront();
          await clickTarget.click();
        }
      }else{
        await waitCoverEnabled(entry,{onStep:(s)=>onStep(s.message,s.progress)});assertRunning();await entry.click();
      }
    }
    else {await waitCoverEnabled(root,{onStep:(s)=>onStep(s.message,s.progress)});assertRunning();if(platform==='tencent')await ownedPage.bringToFront();await root.click();}
    const modal=await one(page.locator(config.dialog),'封面编辑窗口');
    if(await modal.locator('input[type="file"]').count()===0){
      const tab=visible(modal.getByText('上传封面',{exact:true}));
      if(await tab.count()===1){assertRunning();await tab.click();}
    }
    if(platform==='xiaohongshu')onStep('封面编辑器正在加载，加载完成后继续上传所选图片。',65);
    const input=await fileInput('image',modal);await waitCoverEnabled(input,{onStep:(s)=>onStep(s.message,s.progress)});assertRunning();await input.setInputFiles(file.path);
    const confirmName=new RegExp('^\\s*(?:'+[config.coverConfirm,...(config.coverConfirmAlternatives || [])].join('|')+')\\s*$');
    const button=visible(modal.getByRole('button',{name:confirmName}));
    const submitBtn=visible(modal.locator('.button.submit').filter({hasText:confirmName}));
    const confirm=await button.count()?button:(await submitBtn.count()?submitBtn:modal.getByText(confirmName));
    const confirmation=await one(confirm,'封面确认按钮');assertRunning();await confirmation.click();
    await modal.waitFor({state:'hidden',timeout:waitMs});
    const aspect=kind==='portrait'?3/4:4/3;
    const mime=path.extname(file.path).toLowerCase()==='.png'?'image/png':'image/jpeg';
    const expected=await page.evaluate(sampleCoverPixels,{source:`data:${mime};base64,${fs.readFileSync(file.path).toString('base64')}`,aspect});
    const started=Date.now(),deadline=started+waitMs;let actual,matched=false;
    do{
      assertRunning();actual=await imagePixels(await coverPreview(kind));matched=coverPixelsMatch(expected,actual);
      if(matched || Date.now()>=deadline)break;
      await page.waitForTimeout(200);
    }while(true);
    coverReadback.push({kind,matched,waitedMs:Date.now()-started,meanAbsolutePixelError:expected.length===actual?.length?expected.reduce((sum,v,i)=>sum+Math.abs(v-actual[i]),0)/expected.length:null});
    if(!matched){
      if(diagnosticsRoot){fs.mkdirSync(diagnosticsRoot,{recursive:true,mode:0o700});const screenshot=path.join(diagnosticsRoot,`${kind}-saved-cover.png`);await (await coverPreview(kind)).screenshot({path:screenshot,timeout:5000}).then(()=>fs.chmodSync(screenshot,0o600)).catch(()=>{});}
      throw new Error(`${config.label}${kind==='portrait'?'竖':'横'}封面与所选图片不一致，未提交。`);
    }
  }
  async function readOmittedDeclaration(job){
    const target=job.draft.targets.find(t=>t.enabled);
    if(platform!=='xiaohongshu' || target.declaration?.mode!=='omit')return null;
    const empty=visible(page.locator('.d-select-main').filter({has:page.locator('.d-select-placeholder').filter({hasText:/^添加内容类型声明$/})}));
    if(await empty.count()!==1)throw new Error('小红书仍有内容类型声明或当前声明状态无法核对，未提交；不会忽略本条“不设置声明”的选择。');
    return {mode:'none',value:'',evidence:'native_empty_declaration_control'};
  }
  async function requirements(job){
    if(job.declarationText){
      const trigger=page.getByText(/^(?:选择视频标注|添加内容类型声明|自主声明)$/);
      await (await one(trigger,'声明选项入口')).click();
      await (await one(page.getByText(job.declarationText,{exact:true}),'所选声明原文')).click();
      // 2026-11-21 视频号实测：选中下拉选项后，菜单带约 200ms 关闭过渡动画（zoom-in-top-leave-active），
      // 紧接着立即 count() 会同时看到选中值与正在收起的菜单项；短暂等待动画收起后再严格核对唯一回读。
      const declReadback=visible(page.getByText(job.declarationText,{exact:true}));
      const declDeadline=Date.now()+Math.min(waitMs,3000);
      while(await declReadback.count()!==1 && Date.now()<declDeadline){assertRunning();await page.waitForTimeout(100);}
      await one(page.getByText(job.declarationText,{exact:true}),'声明回读');
    }else await readOmittedDeclaration(job);
    const target=job.draft.targets.find(t=>t.enabled);
    if(target.collection.required){
      const trigger=page.getByText(/^(?:添加到合集|加入合集|添加合集)$/);await (await one(trigger,'合集入口')).click();
      await (await one(page.getByText(target.collection.name,{exact:true}),'指定合集')).click();
      await one(page.getByText(target.collection.name,{exact:true}),'已选合集');
    }
    if(scheduleControl){
      await scheduleControl.apply(job);
    }else{
      if(job.schedule?.mode==='scheduled'){
        throw new Error(scheduleIssue(platform,job.schedule,now(),{strict:true}) || `${config.label}的定时发布尚未接通，未提交。`);
      }
      const scheduled=visible(page.getByRole('radio',{name:'定时发布',exact:true}).or(page.getByRole('checkbox',{name:'定时发布',exact:true})));
      if(await scheduled.count()===1 && await scheduled.isChecked())await (await one(page.getByRole('radio',{name:'立即发布',exact:true}),'立即发布选项')).check();
      const dates=visible(page.locator('input[placeholder*="选择日期"], input[placeholder*="发布时间"], input[type="datetime-local"]'));
      for(let i=0;i<await dates.count();i++)if(await dates.nth(i).inputValue())throw new Error(`${config.label}页面仍有定时配置，未提交；请核对发布时间。`);
    }
    if(['self','public','friends'].includes(job.settings.visibility)){
      if(platform==='xiaohongshu'){
        const label={self:'仅自己可见',public:'公开可见',friends:'仅互关好友可见'}[job.settings.visibility];
        const select=await one(page.locator('.permission-card-select'),'小红书可见范围下拉框');
        const current=clean(await select.locator('.d-select-description').first().innerText().catch(()=>''));
        if(current!==label){
          await select.click();
          const option=await one(page.locator('.d-options-wrapper, .d-popover, .d-dropdown, [role="listbox"]').locator('*').filter({hasText:new RegExp(`^\\s*${label}\\s*$`) }).filter({hasNot:page.locator('*')}),`小红书可见范围选项“${label}”`);
          await option.click();
          const deadline=Date.now()+Math.min(waitMs,3000);
          while(clean(await select.locator('.d-select-description').first().innerText().catch(()=>''))!==label && Date.now()<deadline){
            assertRunning();await page.waitForTimeout(100);
          }
          if(clean(await select.locator('.d-select-description').first().innerText().catch(()=>''))!==label)throw new Error(`小红书可见范围“${label}”未生效，未提交。`);
        }
      }else{
        const label={self:'仅自己可见',public:'公开',friends:'好友可见'}[job.settings.visibility];
        const control=await one(page.getByRole('radio',{name:label,exact:true}).or(page.getByRole('checkbox',{name:label,exact:true})),'可见范围');
        await control.check();if(!await control.isChecked())throw new Error('可见范围未生效。');
      }
    }
  }
  async function readPrepared(job){
    const copy=await copyState(job),covers={};
    for(const kind of ['landscape','portrait'])if(job.files[kind]){
      covers[kind]=await (await coverPreview(kind)).evaluate(el=>el.tagName==='IMG'?[el.currentSrc || el.src]:[getComputedStyle(el).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1] || '']);
      if(covers[kind].some(source=>!source))throw new Error(`${config.label}尚未取得已保存封面，未提交。`);
    }
    const video=await page.locator('video').evaluateAll(videos=>videos.filter(v=>v.getClientRects().length).map(v=>({src:v.currentSrc || v.src,ready:v.readyState,duration:Number.isFinite(v.duration)?v.duration:0})));
    const settings=await page.evaluate(()=>[...document.querySelectorAll('input[type="checkbox"], input[type="radio"], input[type="datetime-local"], option:checked, [role="radio"], [role="checkbox"], [role="switch"], .d-switch')].map(el=>({type:el.type || el.getAttribute('role') || el.tagName,checked:el.checked,ariaChecked:el.getAttribute('aria-checked'),value:el.value,label:el.getAttribute('aria-label') || el.closest('label')?.innerText || el.innerText,className:el.className})));
    const target=job.draft.targets.find(t=>t.enabled);
    const selection={declaration:job.declarationText?await visible(page.getByText(job.declarationText,{exact:true})).count():0,collection:target.collection.required?await visible(page.getByText(target.collection.name,{exact:true})).count():0};
    const omittedDeclaration=await readOmittedDeclaration(job);
    const schedule=scheduleControl?await scheduleControl.read(job):undefined;
    const xhsVisibility=platform==='xiaohongshu'?clean(await visible(page.locator('.permission-card-select .d-select-description')).first().innerText().catch(()=>'')):undefined;
    return {url:page.url(),...copy,covers:Object.fromEntries(Object.entries(covers).map(([k,urls])=>[k,urls.map(normalizeCoverSource)])),video,settings,selection,...(schedule!==undefined?{schedule}:{}),...(xhsVisibility!==undefined?{visibility:xhsVisibility}:{}),...(omittedDeclaration?{declaration:omittedDeclaration}:{}),...(locationControl?{location:await locationControl.read()}:{})};
  }
  async function verify(job){
    assertRunning();await onVerifyFiles(job);await verifyIdentity(job);
    assertRunning();
    if(prepared && (job.fingerprint!==prepared.fingerprint || JSON.stringify(await readPrepared(job))!==prepared.value))throw new Error('等待期间平台表单或任务已变化，未提交；请重新核对。');
    if(scheduleControl)scheduleControl.assertCurrent(job);
  }
  async function inspectResult(job){
    assertRunning();await verifyIdentity(job);
    const attempt = platform==='xiaohongshu' ? xhsInspectAttempt++ : 0;
    // 2026-11-21 并发验收：小红书重试回执时关闭旧只读标签页并重建干净标签，
    // 避免沿用前一次后台遮挡或 SPA 挂起的页面状态。
    if(platform==='xiaohongshu' && attempt > 0 && reader && !reader.isClosed()){
      await reader.close().catch(()=>{});
      reader=null;
    }
    if(!reader || reader.isClosed())reader=await context.newPage();
    const tencentObserver = platform==='tencent' ? observeTencentPostList(reader) : null;
    const xhsObserver = platform==='xiaohongshu' ? observeXiaohongshuNoteList(reader) : null;
    let xhsReloadCount = 0;
    let xhsMatchStatus = 'none';
    try{
      const resultWaitMs = waitMs >= 10_000 ? Math.max(waitMs, 60_000) : waitMs;
      await withFocus('inspect_nav', ()=>reader, async ()=>{
        if(platform==='xiaohongshu')await reader.bringToFront().catch(()=>{});
        await reader.goto(config.manage,{waitUntil:platform==='tencent'?'domcontentloaded':'commit',timeout:resultWaitMs});
      });
      if(tencentObserver){
        const deadline = Date.now() + resultWaitMs;
        while(Date.now() < deadline){
          assertRunning();
          const snap = tencentObserver.snapshot();
          if(snap.items.length > 0){
            const hit = matchTencentPostListItem(snap.items, job);
            if(hit.status === 'matched' || hit.status === 'conflict') break;
          }
          const hasLink = await reader.locator('a[href*="post/detail?feedId="]').count().catch(()=>0);
          if(hasLink > 0) break;
          await reader.waitForTimeout(300);
        }
        const snap = await tencentObserver.flush();
        if(snap.items.length > 0){
          const matched = matchTencentPostListItem(snap.items, job);
          if(matched.status === 'conflict' && matched.item?.workId){
            return {
              status: 'awaiting_verification',
              workId: matched.item.workId,
              workUrl: `https://channels.weixin.qq.com/platform/post/detail?feedId=${encodeURIComponent(matched.item.workId)}`,
              message: '视频号作品接口读到与原候选编号不同的作品，保留原依据，不会重发。',
            };
          }
          if(matched.status === 'matched' && matched.item){
            const item = matched.item;
            const workUrl = `https://channels.weixin.qq.com/platform/post/detail?feedId=${encodeURIComponent(item.workId)}`;
            const statusText = { published: '平台显示已发表', scheduled: '平台显示定时发表', under_review: '审核中', rejected: '审核未通过', unknown: '状态待平台更新' }[item.platformStatus] || '状态待平台更新';
            return {
              status: 'submitted',
              platform: 'tencent',
              workId: item.workId,
              workUrl,
              publishedAt: item.publishedAt,
              duration: item.duration,
              platformStatus: item.platformStatus,
              visibility: item.visibility !== 'unverified' ? item.visibility : (job.settings.visibility || 'platform_default'),
              visibilityVerification: item.visibility !== 'unverified' ? 'creator_post_list_api' : 'platform_default',
              verification: 'creator_post_list_api',
              message: `视频号作品接口已核对唯一编号：${item.duration || '未知时长'} · ${item.publishedAt || '未知时间'}。${statusText}。`,
            };
          }
        }
      } else if(xhsObserver){
        const deadline = Date.now() + resultWaitMs;
        const maxReloads = (resultWaitMs >= 10_000 || xhsReloadIntervalMs < resultWaitMs || xhsEmptyReloadMs < resultWaitMs) ? Math.max(0, xhsMaxReloads) : 0;
        const minTailForReload = Math.min(8_000, Math.max(250, Math.min(xhsReloadIntervalMs, xhsEmptyReloadMs)));
        let lastNavAt = Date.now();
        while(Date.now() < deadline){
          assertRunning();
          const snap = xhsObserver.snapshot();
          if(snap.items.length > 0){
            const hit = matchXiaohongshuNoteItem(snap.items, job);
            xhsMatchStatus = hit.status;
            if(hit.status === 'matched' || hit.status === 'conflict') break;
            // 小红书视频入库与建索引常需约 60 秒；若首批列表不含新稿，按固定间隔只读刷新。
            if(xhsReloadCount < maxReloads && Date.now() - Math.max(lastNavAt, snap.capturedAt) >= xhsReloadIntervalMs && deadline - Date.now() > minTailForReload){
              xhsReloadCount++;
              lastNavAt = Date.now();
              await withFocus('inspect_reload', ()=>reader, async ()=>{
                await reader.bringToFront().catch(()=>{});
                await reader.reload({ waitUntil: 'commit', timeout: Math.min(20_000, Math.max(1000, deadline - Date.now())) }).catch(()=>{});
              });
            }
          } else if(snap.responseCount === 0 && xhsReloadCount < maxReloads && Date.now() - lastNavAt >= xhsEmptyReloadMs && deadline - Date.now() > minTailForReload){
            // 并发遮挡或 SPA 慢资源导致零响应时，主动置前并重进管理页恢复，不再空等 60 秒。
            xhsReloadCount++;
            lastNavAt = Date.now();
            await withFocus('inspect_recover', ()=>reader, async ()=>{
              await reader.bringToFront().catch(()=>{});
              await reader.goto(config.manage, { waitUntil: 'commit', timeout: Math.min(20_000, Math.max(1000, deadline - Date.now())) }).catch(()=>{});
            });
          }
          const hasLink = await reader.locator('a[href*="/explore/"], a[href*="/discovery/item/"]').count().catch(()=>0);
          if(hasLink > 0) break;
          await reader.waitForTimeout(300);
        }
        const snap = await xhsObserver.flush();
        if(snap.items.length > 0){
          const matched = matchXiaohongshuNoteItem(snap.items, job);
          xhsMatchStatus = matched.status;
          if(matched.status === 'conflict' && matched.item?.workId){
            return {
              status: 'awaiting_verification',
              workId: matched.item.workId,
              workUrl: `https://www.xiaohongshu.com/explore/${matched.item.workId}`,
              message: '小红书笔记接口读到与原候选编号不同的作品，保留原依据，不会重发。',
            };
          }
          if(matched.status === 'matched' && matched.item){
            const item = matched.item;
            const workUrl = `https://www.xiaohongshu.com/explore/${item.workId}`;
            const statusText = { published: '平台显示已发布', under_review: '审核中', rejected: '审核未通过', scheduled: '平台显示定时发布', unknown: '状态待平台更新' }[item.platformStatus] || '状态待平台更新';
            return {
              status: 'submitted',
              platform: 'xiaohongshu',
              workId: item.workId,
              workUrl,
              publishedAt: item.publishedAt,
              duration: item.duration,
              platformStatus: item.platformStatus,
              visibility: item.visibility !== 'unverified' ? item.visibility : (job.settings.visibility || 'platform_default'),
              visibilityVerification: item.visibility !== 'unverified' ? 'creator_note_list_api' : 'platform_default',
              verification: 'creator_note_list_api',
              message: `小红书笔记接口已核对唯一编号：${item.duration || '未知时长'} · ${item.publishedAt || '未知时间'}。${statusText}。`,
            };
          }
        }
      } else {
        await reader.waitForFunction(title=>document.body?.innerText.includes(title),job.copy.title,{timeout:waitMs}).catch(()=>{});
      }
      const candidates=await reader.locator('a[href]').evaluateAll((links,title)=>links.filter(a=>a.getClientRects().length).flatMap(a=>{
        let n=a;for(let i=0;n && i<5;i++,n=n.parentElement){const text=n.innerText || '';if(text.includes(title) && text.length<2000 && /20\d{2}[年/-]\d{1,2}[月/-]\d{1,2}/.test(text))return [{url:a.href,text}];}return [];
      }),job.copy.title);
      const proved=[];
      for(const c of candidates){
        const ref=workReference(c.url,platform);if(!ref || (job.expectedWorkId && ref.workId!==job.expectedWorkId))continue;
        const time=c.text.match(/20\d{2}[年/-]\d{1,2}[月/-]\d{1,2}日?\s+\d{2}:\d{2}/)?.[0];
        const at=time?Date.parse(time.replace('年','-').replace('月','-').replace('日','').replace(' ','T')+':00+08:00'):NaN;
        if(!job.expectedWorkId && (!Number.isFinite(at) || !job.runCreatedAt || at<Math.floor(Date.parse(job.runCreatedAt)/60000)*60000))continue;
        const state=/审核未通过|未通过审核/.test(c.text)?'rejected':/审核中/.test(c.text)?'under_review':/已发布|发布成功/.test(c.text)?'published':'unknown';
        proved.push({...ref,status:'submitted',platform,platformStatus:state,publishedAt:time || '',visibility:job.settings.visibility || 'platform_default',verification:'creator_record_title_time_and_link',message:`${config.label}已核对本条标题、时间和唯一作品链接。`});
      }
      const unique=[...new Map(proved.map(p=>[p.workId,p])).values()];
      if(unique.length===1)return unique[0];
      const obsSnap = xhsObserver ? xhsObserver.snapshot() : tencentObserver ? tencentObserver.snapshot() : null;
      await recordReceiptDiagnostic({
        attempt,
        reloadCount: xhsReloadCount,
        responseCount: obsSnap?.responseCount ?? 0,
        itemCount: obsSnap?.items?.length ?? 0,
        matchStatus: xhsMatchStatus,
        domCandidateCount: candidates.length,
      });
      return {status:'awaiting_verification',message:`${config.label}尚未取得本条唯一作品凭据，保留原状态，不会重发。`};
    }finally{
      if(tencentObserver)tencentObserver.detach();
      if(xhsObserver)xhsObserver.detach();
    }
  }
  return {
    verify,inspectResult,inspectEntry,inspectFooterSurface,
    capabilities:Object.freeze({submit:canSubmit,submissionProtocol:1}),
    async prepare(job,{signal,onStep=()=>{}}={}){
      activeSignal=signal;
      const step=(message,progress)=>{assertRunning();if(signal?.aborted)throw new Error('任务已停止，未提交。');onStep({message,progress});};
      try{
        step(`${config.label}账号复查通过，正在打开本条上传页。`,5);
        const {surface,beforeUpload}=await withFocus('upload_select', ()=>ownedPage, async ()=>{
          await openUploadPage();
          let file;
          try{file=await fileInput('video');}
          catch(error){
            // This is the newly owned, still-empty upload page. Retry its GET
            // once before any file is selected; login/security pages and form
            // input are never reset. Upload or submission failures never retry.
            if(error.code!=='UPLOAD_FORM_NOT_READY' || !await canReopenEmptyUploadPage())throw error;
            step('上传表单尚未加载，正在重新打开本次空白上传页；尚未上传。',5);
            await openUploadPage();
            file=await fileInput('video');
          }
          // Baseline and progress both come from the body holding this input,
          // so markers in another layer cannot fake or hide completion.
          const s=await uploadSurface(file),before=await s.baseline();
          assertRunning();await file.setInputFiles(job.files.video.path);
          return {surface:s,beforeUpload:before};
        });
        step('视频已交给平台，正在等待上传与转码。',20);
        await waitForVideoUpload({read:async()=>{
          const state=await surface.read({mode:'native',before:beforeUpload});
          // 视频号可用本地预览播放；只有上传进度已结束且平台启用实际
          // 编辑入口，才允许该预览作为完成证据。单独出现预览不算完成。
          if(platform==='tencent' && state.previewOnly && !state.uploading && !state.failed && !state.lost){
            const root=page.locator(config.cover.portrait);
            const edit=root.locator('.edit-btn');
            if(await root.count()===1 && await edit.count()===1 && (await resolveTencentCoverAction(root,edit)).ready){state.complete=true;state.completionEvidence='video_preview_and_cover_editor_ready';}
          }
          // 2026-11-21 小红书真实发布页：视频传完后使用 blob: 预览且不显示“上传完成/上传成功”字样，
          // 而是由“上传中/取消上传”切换为可见的“重新上传”并渲染封面预览容器。
          if(platform==='xiaohongshu' && !state.complete && !state.uploading && !state.failed && !state.lost){
            const reupload=visible(page.getByText('重新上传',{exact:true}));
            const coverDef=visible(page.locator('.cover-plugin-preview .cover > .default'));
            if(await reupload.count()>=1 && await coverDef.count()===1){
              const hasCover=await coverDef.evaluate(el=>/^url\(/.test(getComputedStyle(el).backgroundImage) || el.querySelectorAll('img').length>0).catch(()=>false);
              if(hasCover){state.complete=true;state.completionEvidence='xiaohongshu_reupload_and_cover_preview_ready';}
            }
          }
          uploadReadback=state;return state;
        },signal,isStopped:()=>stopped,maxMs:uploadWaitMs,onProgress:onStep});
        step('视频上传完成，正在等待封面编辑入口并设置所选封面。',45);
        for(const [index,kind] of ['landscape','portrait'].entries())if(job.files[kind]){
          step(`视频上传已完成，正在等待${kind==='portrait'?'竖':'横'}封面入口启用并上传所选图片。`,50+index*10);
          await withFocus(`cover_${kind}`, ()=>ownedPage, ()=>setCover(kind,job.files[kind],step));
        }
        await withFocus('fill_form', ()=>ownedPage, async ()=>{
          step('封面设置已核对，正在填写本条标题、正文和话题。',70);await fillCopy(job);
          step('标题、正文和所选话题已回读，正在核对声明与发布设置。',80);await requirements(job);
          const effectiveLocation=job.location || (platform==='tencent'?{mode:'none',name:''}:null);
          if(effectiveLocation){
            step('正在核对本条作品定位设置。',85);
            locationControl=require('./publish-location-driver.cjs').createLocationControl(page,effectiveLocation,{platform,assertRunning,waitMs});
            await locationControl.apply();
          }
        });
        async function isPublishButtonEnabled(button){
          if(!await button.isEnabled())return false;
          if(platform==='tencent'){
            const disabledClass=await button.evaluate(el=>el.classList.contains('weui-desktop-btn_disabled') || el.getAttribute('aria-disabled')==='true').catch(()=>false);
            if(disabledClass)return false;
          }
          return true;
        }
        const publish=await finalPublishButton(job);
        if(!await isPublishButtonEnabled(publish)){
          const deadline=Date.now()+waitMs;while(!await isPublishButtonEnabled(publish) && Date.now()<deadline){assertRunning();await ownedPage.waitForTimeout(100);}
          if(!await isPublishButtonEnabled(publish))throw new Error(`${config.label}仍有未完成的平台要求，发布按钮不可用；未提交。`);
        }
        prepared={fingerprint:job.fingerprint,value:JSON.stringify(await readPrepared(job))};
        step('页面内容已回读，准备检查通过。',100);
        return {checks:Object.fromEntries(CHECK_KEYS.map(k=>[k,true])),evidence:{publishControl:publishControlEvidence,coverReadback,omittedDeclaration:await readOmittedDeclaration(job),...(locationControl?{location:await locationControl.read()}:{})}};
      }catch(e){await diagnose(e);throw e;}
    },
    async submit(job,{beforeDispatch=async()=>{},afterDispatch=async()=>{}}={}){
      if(!canSubmit)throw new Error('此执行器没有发布权限。');
      if(submitted || !prepared || job.fingerprint!==prepared.fingerprint)throw new Error('没有可提交的唯一准备任务。');
      await verify(job);const publish=await finalPublishButton(job);
      if(platform==='tencent'){
        const btnDisabled=await publish.evaluate(el=>el.disabled || el.classList.contains('weui-desktop-btn_disabled') || el.getAttribute('aria-disabled')==='true').catch(()=>false);
        if(btnDisabled)throw new Error(`${config.label}发表按钮仍处于禁用状态，未提交。`);
      }
      let dispatchError=null;
      await withFocus('submit', ()=>ownedPage, async ()=>{
        assertRunning();
        await beforeDispatch('publish');
        submitted=true;
        try{
          // Reserve before the first click; any exception after it remains
          // unknown. Neither an error nor a timeout can cause another click.
          await publish.click({timeout:10_000});
          await afterDispatch('publish');
        }catch(e){dispatchError=e;}
      });
      if(dispatchError){await diagnose(dispatchError);return {status:'awaiting_verification',message:`${config.label}已尝试提交一次，结果待核查，不会重发。`};}
      try{
        if(platform==='tencent'){
          // 2026-11-23 视频号实测：开通“声明原创”的账号在未勾选原创声明点击“发表”后，
          // 会弹出原创声明拦截弹窗（.original-interceptor-footer：不再提醒 / 直接发表 / 声明原创），
          // 未点“直接发表”不会发出提交请求。等待跳转/成功提示或该弹窗出现，
          // 若弹出则走单次 confirmation 许可点击唯一的“直接发表”，不勾“不再提醒”也不擅自声明原创。
          await page.waitForFunction(()=>{
            if(/\/post\/list/.test(location.pathname))return true;
            const collect=root=>{
              let text=(root.body?.innerText || root.innerText || '');
              for(const el of root.querySelectorAll('.original-interceptor-footer')){
                const st=getComputedStyle(el);
                if(el.getClientRects().length && st.display!=='none' && st.visibility!=='hidden')return {interceptor:true,text};
              }
              for(const el of root.querySelectorAll('*'))if(el.shadowRoot){
                const sub=collect(el.shadowRoot);
                if(sub.interceptor)return sub;
                if(sub.text)text+='\n'+sub.text;
              }
              return {interceptor:false,text};
            };
            const state=collect(document);
            return state.interceptor || /发布成功|发表成功|已发表|定时发表成功|定时发布成功|待发表|审核中/.test(state.text);
          },null,{timeout:waitMs}).catch(()=>{});
          const interceptor=visible(page.locator('.original-interceptor-footer'));
          if(await interceptor.count()){
            await withFocus('submit_confirm', ()=>ownedPage, async ()=>{
              assertRunning();
              const confirmation=await one(interceptor.getByRole('button',{name:'直接发表',exact:true}),'视频号直接发表确认按钮');
              await beforeDispatch('confirmation');
              await confirmation.click({timeout:10_000});
              await afterDispatch('confirmation');
            });
          }
        }
        let postSubmitConfirmed=true;
        await page.waitForFunction(()=>{
          if(/\/(?:post\/list|publish\/success|new\/note-manager)/.test(location.pathname))return true;
          const texts=[document.body?.innerText || ''];
          for(const el of document.querySelectorAll('*'))if(el.shadowRoot){const b=el.shadowRoot.querySelector('body');if(b?.innerText)texts.push(b.innerText);}
          return /发布成功|发表成功|已发表|定时发表成功|定时发布成功|待发表|投稿成功|审核中/.test(texts.join('\n'));
        },null,{timeout:waitMs}).catch(()=>{postSubmitConfirmed=false;});
        if(!postSubmitConfirmed && diagnosticsRoot && ownedPage && !ownedPage.isClosed()){
          await diagnose(new Error(`${config.label}点击发布后在等待期内未观察到跳转或成功提示，继续只读核查。`)).catch(()=>{});
        }
        return await inspectResult(job);
      }catch(e){await diagnose(e);return {status:'awaiting_verification',message:`${config.label}已尝试提交一次，结果待核查，不会重发。`};}
    },
    async stop(){stopped=true;await buttonReader?.close();}
  };
}
module.exports={createNativePublisher,createTencentScheduleControl,tencentScheduleText,createXiaohongshuScheduleControl,xiaohongshuScheduleText,NATIVE_CONFIG:CONFIG};
