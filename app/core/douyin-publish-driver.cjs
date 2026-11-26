'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {waitForVideoUpload,uploadSurface,UPLOAD_MAX_MS}=require('./upload-wait.cjs');
const {readCoverReadiness,waitForCoverReady,COVER_READY_MAX_MS}=require('./cover-readiness.cjs');
const {scheduleIssue,parseAt}=require('./publish-schedule.cjs');
const {observeDouyinWorkList,matchDouyinWorkListItem,parsePlatformQuickCheck}=require('./douyin-work-list.cjs');
const {sampleCoverPixels}=require('./cover-pixels.cjs');
const QUICK_CHECK_MAX_MS = 120_000;
const UPLOAD = 'https://creator.douyin.com/creator-micro/content/upload';
// 任务里的 YYYY-MM-DDTHH:mm（北京时间）在平台时间框里写成 YYYY-MM-DD HH:mm。
const scheduleText = job => job.schedule?.mode==='scheduled' ? `定时发布 ${String(job.schedule.at).replace('T',' ')}` : '立即发布';
// 文案回读失败要带上各项的期望值和实际回读值，才能区分平台改写、残留、清空失败。
const clipCopy = value => { const text = String(value ?? ''); return text.length > 60 ? text.slice(0, 60) + '…' : text; };
function copyFillIssue(expected, actual) {
  const problems = [];
  if (actual.title !== expected.title) problems.push(`标题期望「${clipCopy(expected.title)}」，回读「${clipCopy(actual.title)}」`);
  if (actual.description !== expected.description) problems.push(`简介期望「${clipCopy(expected.description)}」${expected.description ? '' : '（本条为空）'}，回读「${clipCopy(actual.description)}」`);
  if ((actual.tags || []).length) problems.push(`简介框里仍有话题 ${actual.tags.map(t => '#' + t).join(' ')}（此时还不该有话题）`);
  return problems.length ? `文案回读与本条任务不一致：${problems.join('；')}；未提交。` : '';
}
// A native topic is an observed, non-editable mention node. A literal
// "#topic" string is deliberately not accepted as a selected topic. Topic
// mentions sit inside [data-fake-text], so plain innerText reads them as text.
function readEditorCopy(editor) {
  return editor.evaluate(root=>{
    const tags=[...root.querySelectorAll('[contenteditable="false"] [data-mention="#"]')].map(el=>(el.textContent || '').replace(/\u200b/g,'').trim().replace(/^#/,''));
    const lines=[...root.querySelectorAll('[data-line-wrapper="true"]')].map(line=>{
      const copy=line.cloneNode(true);copy.querySelectorAll('[data-fake-text],[data-zero-space],[data-enter]').forEach(el=>el.remove());
      return (copy.textContent || '').replace(/\u200b/g,'');
    });
    return {description:lines.join('\n').trim(),tags};
  });
}
// Bounded: select-all + Backspace removes text and void topic mentions. The
// caller's readback, not this loop, decides whether the editor is clean.
async function clearEditorCopy(editor, read = readEditorCopy) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = await read(editor);
    if (!now.description && !now.tags.length) return;
    await editor.focus(); await editor.press('ControlOrMeta+A'); await editor.press('Backspace');
  }
}
const CHECKS = ['video','covers','text','declaration','collection','schedule','visibility','savePermission'];

function listRecordEvidence(text, job = {}) {
  const publishedAt = text.match(/\d{4}年\d{2}月\d{2}日\s+\d{2}:\d{2}/)?.[0] || '';
  const duration = text.replace(publishedAt, '').match(/\b\d{2}:\d{2}\b/)?.[0] || '';
  if (!publishedAt || !duration) return null;
  // The platform shows minute precision in Beijing time. An old post with the
  // same title must not become the receipt for a new, still-pending attempt.
  if (!job.expectedWorkId && job.runCreatedAt) {
    const published = Date.parse(publishedAt.replace('年','-').replace('月','-').replace('日','T').replace(/\s/g,'') + ':00+08:00');
    const started = Date.parse(job.runCreatedAt);
    if (!Number.isFinite(published) || !Number.isFinite(started) || published < Math.floor(started / 60000) * 60000) return null;
  }
  // 只认独立状态行，标题里的“定时发布”不是平台状态。
  // 2026-11-21 真实抖音管理页核对：定时作品卡片显示“继续编辑”按钮与预定发布时间，不含独立“定时发布”文本行。
  const statusText = job.copy?.title ? text.split(/\r?\n/).filter(line => line.trim() !== job.copy.title.trim()).join('\n') : text;
  const scheduledMarker = /(?:^|\n)\s*(?:定时发布(?:中)?|继续编辑)\s*(?:\n|$)/.test(statusText);
  const platformStatus=/审核未通过|未通过审核/.test(text)?'rejected':/审核中/.test(text)?'under_review':scheduledMarker?'scheduled':/(?:^|\n)已发布(?:\n|$)/.test(text)?'published':'unknown';
  if (!job.expectedWorkId && job.schedule?.mode === 'scheduled') {
    const expected = parseAt(job.schedule.at);
    const shown = Date.parse(publishedAt.replace('年','-').replace('月','-').replace('日','T').replace(/\s/g,'') + ':00+08:00');
    // 没有既知作品编号时，不能把另一预约时间的同名作品借作本次回执。
    // 平台若显示创建时间或其他格式，这里保守留待核查，不猜测对应关系。
    if (!expected || expected.getTime() !== shown || !scheduledMarker) return null;
  }
  const visibility = /(?:^|\s|·)私密(?:\s|·|$)|仅自己可见|仅我可见/.test(statusText)
    ? 'self'
    : /(?:^|\s|·)好友可见(?:\s|·|$)|互关朋友可见/.test(statusText)
      ? 'friends'
      : 'unverified';
  return { publishedAt, duration, visibility, platformStatus };
}

function receiptVisibility(record,detail,submission) {
  if(record?.visibility==='self')return {visibility:'self',visibilityVerification:'creator_list'};
  if(['public','self','friends'].includes(detail?.visibility))return {visibility:detail.visibility,visibilityVerification:'creator_controls'};
  // A public post can be awaiting moderation; its edit page may expose no
  // visibility control. Preserve what was actually read immediately before
  // clicking Publish, and distinguish this evidence from public accessibility.
  if(record && submission?.clicked===true && submission.visibility==='公开')return {visibility:'public',visibilityVerification:'submitted_form_and_creator_record'};
  return {visibility:'unverified',visibilityVerification:'unverified'};
}

// 抖音发布时间控件。选中“定时发布”后平台才显示时间框；占位文字来自公开参考实现，
// 尚未在本机真实页面验收。找不到唯一控件、回读不一致、或此刻已不满足平台最早时间，
// 都会抛错并停在提交之前；不会退回成立即发布。
function createScheduleControl({ getPage, one, choose, selected, now = Date.now }) {
  const input = () => one(getPage().locator('input[placeholder*="日期和时间"]'),'定时发布时间框');
  async function read() {
    const mode=await selected(['立即发布','定时发布']);
    if(mode==='立即发布')return mode;
    return `定时发布 ${(await (await input()).inputValue()).trim()}`;
  }
  function assertCurrent(job) {
    const late=scheduleIssue('douyin',job.schedule,now(),{strict:true});
    if(late)throw new Error(late);
  }
  async function apply(job) {
    if(job.schedule?.mode!=='scheduled'){await choose('立即发布');return;}
    // 上传可能花了很久：填写这一刻仍须满足平台的最早时间。
    assertCurrent(job);
    await choose('定时发布');
    const field=await input(),expected=String(job.schedule.at).replace('T',' ');
    await field.click();await field.press('ControlOrMeta+A');
    await field.pressSequentially(expected,{delay:40});await field.press('Enter');
    const deadline=Date.now()+5000;
    while((await field.inputValue()).trim()!==expected){
      if(Date.now()>=deadline)throw new Error(`平台定时时间回读为“${(await field.inputValue()).trim() || '空'}”，与本条要求的 ${expected} 不一致，未提交。`);
      await getPage().waitForTimeout(250);
    }
  }
  return { read, apply, assertCurrent };
}

function assertPreparedPage(expected, actual) {
  for (const key of ['url','title','description','tags','declaration','collection','visibility','savePermission','schedule','covers','location']) {
    if (JSON.stringify(expected?.[key]) !== JSON.stringify(actual?.[key])) {
      const label={url:'页面',title:'标题',description:'简介',tags:'原生话题',declaration:'声明',collection:'合集',visibility:'可见范围',savePermission:'保存权限',schedule:'发布时间',covers:'封面',location:'作品定位'}[key];
      throw new Error(`等待确认期间平台表单已改变（${label}），请重新核对；未提交。`);
    }
  }
}

function normalizeCoverSource(source) {
  try {
    const url=new URL(source);if(!/^https?:$/.test(url.protocol))return source;
    for(const key of [...url.searchParams.keys()])if(/^(?:policy|x-orig-authkey|x-orig-expires|x-orig-sign|authkey|expires|sign)$/i.test(key))url.searchParams.delete(key);
    url.searchParams.sort();return url.href;
  } catch { return source; }
}

function measureCoverPixels(expected, actual) {
  if(!Array.isArray(expected) || !Array.isArray(actual) || expected.length!==768 || actual.length!==768){
    return {matched:false,meanAbsolutePixelError:null,closeRatio:null,maxDelta:null};
  }
  let total=0,close=0,maxDelta=0;
  for(let i=0;i<expected.length;i++){
    const d=Math.abs(expected[i]-actual[i]);
    total+=d;if(d<=30)close++;if(d>maxDelta)maxDelta=d;
  }
  const meanAbsolutePixelError=total/expected.length;
  const closeRatio=close/expected.length;
  return {
    matched:meanAbsolutePixelError<=8 && closeRatio>=0.95,
    meanAbsolutePixelError:Number(meanAbsolutePixelError.toFixed(3)),
    closeRatio:Number(closeRatio.toFixed(4)),
    maxDelta,
  };
}

function coverPixelsMatch(expected, actual) {
  return measureCoverPixels(expected, actual).matched;
}

// Uses only the creator site's rendered controls. The first live account is a
// pilot: a control or its readback changing must stop before final submission.
function createDouyinPublisher({ context, verifyIdentity, diagnosticsRoot, onVerifyFiles,uploadWaitMs=UPLOAD_MAX_MS,coverWaitMs=COVER_READY_MAX_MS,quickCheckWaitMs=QUICK_CHECK_MAX_MS,now=Date.now,allowSubmit=true,focusCoordinator=null }) {
  const canSubmit=allowSubmit===true;
  let uploadStarted=false,uploadCheckpoint;
  let locationControl;
  let activeSignal,coverProgress=()=>{};
  let page, resultPage, workListObserver=null, submitted = false, submissionProof=null, preparedFingerprint = null, preparedPage = null, stopped = false, activeTitle='',activeTags=[];
  async function withFocus(stepName, fn) {
    if (!focusCoordinator || typeof focusCoordinator.runExclusive !== 'function') return fn();
    return focusCoordinator.runExclusive(`douyin:${stepName}`, async () => {
      if (page && !page.isClosed()) await page.bringToFront().catch(() => {});
      return fn();
    }, { signal: activeSignal });
  }
  function attachWorkListObserver(target) {
    if (workListObserver) { workListObserver.detach(); workListObserver = null; }
    if (target && !target.isClosed()) workListObserver = observeDouyinWorkList(target);
    return workListObserver;
  }
  const visible = locator => locator.filter({visible:true});
  async function one(locator, label) {
    const match = visible(locator);
    try {await match.first().waitFor({state:'visible',timeout:10_000});}
    catch {throw new Error(`未等到${label}显示，已停止，未提交。`);}
    if (await match.count() !== 1) throw new Error(`未找到唯一的${label}，已停止，未提交。`);
    return match;
  }
  async function fileInput(accept, label) {
    // The website normally hides its native file input behind an upload tile.
    // The attached input must be unique, even when the tile is the visible UI.
    const input = page.locator(`input[type="file"][accept*="${accept}"]`);
    try {await input.first().waitFor({state:'attached',timeout:90_000});}
    catch {throw new Error(`平台仍未载入${label}，请检查专属浏览器的网络后重试；尚未上传或提交。`);}
    if (await input.count() !== 1) throw new Error(`未找到唯一的${label}，已停止，未提交。`);
    return input;
  }
  async function diagnose(error, stage='当前发布页', clip) {
    if (!page || page.isClosed() || !diagnosticsRoot) return;
    fs.mkdirSync(diagnosticsRoot,{recursive:true,mode:0o700});
    // Read every body layer; a page with two bodies must not lose diagnostics.
    const data = await page.locator('body').evaluateAll((bodies,{title,topics})=>{
      const roots=bodies.filter(b=>!b.parentElement?.closest('body'));
      const body={innerText:roots.map(b=>b.innerText || '').join('\n'),querySelectorAll:selector=>roots.flatMap(b=>[...b.querySelectorAll(selector)])};
      return ({
      url:location.href,bodyCount:bodies.length,
      text:body.innerText.slice(0,12000),
      links:[...body.querySelectorAll('a[href]')].filter(el=>el.getClientRects().length).slice(0,80).map(el=>({text:el.innerText.slice(0,100),href:el.href})),
      frames:[...body.querySelectorAll('iframe[src]')].filter(el=>el.getClientRects().length).map(el=>({src:el.src,title:el.title})),
      resultCards:title?[...body.querySelectorAll('div,span,a,p')].filter(el=>el.children.length<2 && (el.innerText || '').includes(title) && (el.innerText || '').length<500).slice(0,6).map(el=>({text:el.innerText,parents:[el.parentElement,el.parentElement?.parentElement,el.parentElement?.parentElement?.parentElement].filter(Boolean).map(n=>n.outerHTML.slice(0,10000))})):[],
      covers:['竖封面3:4','横封面4:3','竖封面预览（3:4）','横封面预览（4:3）'].flatMap(label=>[...body.querySelectorAll('div,span,p')].filter(el=>(el.innerText || '').trim()===label && el.children.length<2).slice(-2).map(el=>{const n=el.parentElement?.parentElement?.cloneNode(true);n?.querySelectorAll('svg').forEach(svg=>svg.remove());return {label,html:(n?.outerHTML || '').slice(0,15000)};})),
      topicControls:topics.length?[...body.querySelectorAll('div,span,li,[role="option"]')].filter(el=>el.getClientRects().length && (el.innerText || '').length<250 && topics.some(t=>(el.innerText || '').trim()===t || (el.innerText || '').trim()==='#'+t)).slice(-25).map(el=>{const n=el.parentElement?.parentElement?.cloneNode(true);n?.querySelectorAll('svg').forEach(svg=>svg.remove());return {text:el.innerText,html:(n?.outerHTML || '').slice(0,12000)};}):[],
      locationStructure:[...body.querySelectorAll('div,span,label')].filter(el=>el.getClientRects().length && /^(?:位置|输入地理位置|添加标签)$/.test((el.innerText || '').trim()) && el.children.length<3).slice(-6).map(label=>{
        const chain=[];for(let el=label;el && chain.length<7;el=el.parentElement)chain.push({tag:el.tagName,className:String(el.className || '').slice(0,180),role:el.getAttribute('role'),text:String(el.innerText || '').slice(0,250),children:[...el.children].slice(0,10).map(c=>({tag:c.tagName,className:String(c.className || '').slice(0,180),role:c.getAttribute('role'),text:String(c.innerText || '').slice(0,100)}))});return chain;
      }),
      controls:[...body.querySelectorAll('input,textarea,[contenteditable="true"],button,[role="radio"],[role="checkbox"]')].slice(0,150).map(el=>({
        tag:el.tagName,type:el.type || '',accept:el.getAttribute('accept'),role:el.getAttribute('role'),label:el.getAttribute('aria-label'),placeholder:el.getAttribute('placeholder'),text:(el.innerText || '').trim().slice(0,100),visible:!!el.getClientRects().length,checked:el.checked,html:el.outerHTML.slice(0,1800),parent:el.matches('input[type="radio"],input[type="checkbox"]')?el.parentElement.outerHTML.slice(0,2200):undefined
      }))
    });},{title:activeTitle,topics:activeTags}).catch(()=>({url:page.url()}));
    const apiSnap = workListObserver ? workListObserver.snapshot() : null;
    const apiDiag = apiSnap?.schema ? { responseCount: apiSnap.responseCount, schema: apiSnap.schema, matchedCount: apiSnap.items.filter(it => !activeTitle || it.title === activeTitle).length } : undefined;
    const record=JSON.stringify({at:new Date().toISOString(),error:String(error.message || error),...(error.copyReadback?{copyReadback:error.copyReadback}:{}),...(error.coverReadback?{coverReadback:error.coverReadback}:{}),...(apiDiag?{workListApi:apiDiag}:{}),tabs:context.pages().map(p=>p.url()),...data},null,2);
    fs.writeFileSync(path.join(diagnosticsRoot,'页面控件诊断.json'),record,{mode:0o600});
    fs.writeFileSync(path.join(diagnosticsRoot,`页面记录-${Date.now()}.json`),record,{mode:0o600});
    // The live page leaves a web font pending indefinitely. Local diagnostic
    // capture should record the current rendered page instead of awaiting it.
    const fontWait=process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
    process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY='1';
    try { await page.screenshot({path:path.join(diagnosticsRoot,`${stage}.png`),timeout:7000,animations:'disabled',...(clip?{clip}:{} )}); }
    catch(error) { fs.writeFileSync(path.join(diagnosticsRoot,'截图失败.txt'),String(error.message).slice(0,2500),{mode:0o600}); }
    finally { if(fontWait===undefined)delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY=fontWait; }
  }
  async function verify(job) {
    if (stopped) throw new Error('本次真实试发已停止。');
    if (preparedFingerprint && preparedFingerprint !== job.fingerprint) throw new Error('本条任务已改变，不能继续提交。');
    await onVerifyFiles(job);
    await verifyIdentity(job);
    if (preparedPage) {
      try { assertPreparedPage(preparedPage, await readPreparedPage(job)); }
      catch(error) { await diagnose(error); throw error; }
    }
    // 等待用户确认、文件核对及身份复查都会消耗时间，不能沿用填写时的有效期。
    scheduleControl.assertCurrent(job);
  }
  async function choose(label) {
    const control = await one(page.getByRole('radio',{name:label,exact:true}).or(page.getByRole('checkbox',{name:label,exact:true})),label);
    if (!(await control.isChecked())) await control.check();
    if (!(await control.isChecked())) throw new Error(`“${label}”未生效，未提交。`);
  }
  async function selected(labels) {
    const result=[];
    for (const label of labels) {
      const c=visible(page.getByRole('radio',{name:label,exact:true}).or(page.getByRole('checkbox',{name:label,exact:true})));
      if (await c.count()===1 && await c.isChecked()) result.push(label);
    }
    if(result.length!==1)throw new Error('无法唯一核对平台当前选项，未提交。');
    return result[0];
  }
  async function coverPreview(label) {
    const images=await (await one(page.getByText(label,{exact:true}),label)).evaluate(el=>{
      let n=el;
      for(let i=0;i<4 && n;i++,n=n.parentElement){
        const text=n.innerText || '';
        if((text.includes('竖封面3:4') && text.includes('横封面4:3')) || text.includes('Ai智能推荐封面'))break;
        const signatures=[...n.querySelectorAll('img')].filter(img=>img.getClientRects().length && img.complete && img.naturalWidth>1).map(img=>({source:img.currentSrc || img.src,width:img.naturalWidth,height:img.naturalHeight}));
        if(signatures.length)return signatures;
      }
      return [];
    });
    return images.map(img=>`${normalizeCoverSource(img.source)}|${img.width}x${img.height}`).join('\n');
  }
  async function expectedCoverPixels(file, aspect) {
    const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(file.path).toLowerCase()];
    // 2026-11-21 并发验收证实：带细笔画文字的封面直接 drawImage 缩至 16x16 会混叠误判，
    // 统一采用与原生驱动相同的区域均值采样 sampleCoverPixels，不放松像素比对阈值。
    return page.evaluate(sampleCoverPixels,{source:`data:${mime};base64,${fs.readFileSync(file.path).toString('base64')}`,aspect});
  }
  async function displayedCoverPixels(label, aspect=null) {
    const marker=await one(page.getByText(label,{exact:true}),label);
    const pixels=await marker.evaluate((el,targetAspect)=>{
      let n=el;
      for(let i=0;i<4 && n;i++,n=n.parentElement){
        const text=n.innerText || '';if((text.includes('竖封面3:4') && text.includes('横封面4:3')) || text.includes('Ai智能推荐封面'))break;
        const imgs=[...n.querySelectorAll('img')].filter(img=>img.getClientRects().length && img.complete && img.naturalWidth>1);
        if(imgs.length===1){
          try {
            const img=imgs[0];
            let w=img.naturalWidth,h=img.naturalHeight;
            if(!w || !h)return null;
            const style=getComputedStyle(img);
            const cropAspect=style.objectFit==='cover'
              ? (targetAspect || (img.clientWidth>0 && img.clientHeight>0 ? img.clientWidth/img.clientHeight : null))
              : targetAspect;
            if(cropAspect){if(w/h>cropAspect)w=h*cropAspect;else h=w/cropAspect;}
            const scale=Math.min(1,2048/Math.max(w,h));
            const canvas=document.createElement('canvas');
            canvas.width=Math.max(16,Math.round(w*scale));canvas.height=Math.max(16,Math.round(h*scale));
            const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(img,(img.naturalWidth-w)/2,(img.naturalHeight-h)/2,w,h,0,0,canvas.width,canvas.height);
            const data=ctx.getImageData(0,0,canvas.width,canvas.height).data,result=[];
            for(let y=0;y<16;y++)for(let x=0;x<16;x++){
              const sum=[0,0,0];let count=0;
              for(let yy=Math.floor(y*canvas.height/16);yy<Math.floor((y+1)*canvas.height/16);yy++){
                for(let xx=Math.floor(x*canvas.width/16);xx<Math.floor((x+1)*canvas.width/16);xx++){
                  const at=(yy*canvas.width+xx)*4;
                  for(let ch=0;ch<3;ch++)sum[ch]+=data[at+ch];
                  count++;
                }
              }
              result.push(...sum.map(v=>Math.round(v/count)));
            }
            return result;
          }catch{return null;}
        }
      }
      return null;
    },aspect);
    if(pixels)return pixels;
    // Credentialed CDN images can taint an in-page canvas. Sample the actual
    // rendered thumbnail instead; temporarily hide hover overlay during capture.
    const tile=marker.locator('..').locator('..');
    const img=await one(tile.locator('img'),'已保存封面图片');
    const overlays=tile.locator('.filter-k_CjvJ');
    const savedVis=await overlays.evaluateAll(els=>els.map(el=>{const prev=el.style.visibility;el.style.visibility='hidden';return prev;})).catch(()=>null);
    const previous=process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
    process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY='1';let buffer;
    try {buffer=await img.screenshot({timeout:7000,animations:'disabled'});}
    finally {
      if(savedVis)await overlays.evaluateAll((els,prevs)=>els.forEach((el,i)=>{el.style.visibility=prevs[i] ?? '';}),savedVis).catch(()=>{});
      if(previous===undefined)delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY=previous;
    }
    return page.evaluate(sampleCoverPixels,{source:`data:image/png;base64,${buffer.toString('base64')}`});
  }
  async function openCover(label,previewText) {
    const tile=visible(page.getByText(label,{exact:true}).locator('..').locator('..').locator('.cover-Jg3T4p'));
    await waitCoverEnabled(tile,label);
    await tile.click();await page.getByText(previewText,{exact:true}).waitFor({state:'visible',timeout:20000});
  }
  async function waitCoverEnabled(control,label){
    await waitForCoverReady({label:'抖音'+label,maxMs:coverWaitMs,onProgress:coverProgress,pause:ms=>page.waitForTimeout(ms),assertRunning:()=>{if(stopped || activeSignal?.aborted)throw new Error('本次真实试发已停止；未提交。');},read:async()=>{
      const count=await control.count();if(count>1)throw new Error('抖音'+label+'入口不唯一，未上传封面、未提交。');
      return count===1?control.evaluate(readCoverReadiness):{ready:false,reason:'平台尚未显示编辑入口'};
    }});
  }
  async function finishCover(previewText) {
    await (await one(page.getByRole('button',{name:'完成',exact:true}),'封面完成按钮')).click();
    // Commit this side before opening the other side from its own main-form
    // tile. The optional promotion must not replace the already chosen side.
    await page.waitForFunction(text=>{const body=document.body?.innerText || '';return body.includes('设置横封面获更多流量') || !body.includes(text);},previewText,{timeout:15000});
    if(await visible(page.getByText('设置横封面获更多流量',{exact:true})).count())await (await one(page.getByRole('button',{name:'暂不设置',exact:true}),'返回发布表单按钮')).click();
    await page.getByText(previewText,{exact:true}).waitFor({state:'hidden',timeout:30000});
  }
  // Real page diagnostics show exactly one visible contenteditable DIV. Its
  // visual placeholder is not an aria-label or native placeholder attribute.
  const descriptionControl = () => one(page.locator('[contenteditable="true"]'),'作品简介');
  async function readCopy() {
    return readEditorCopy(await descriptionControl());
  }
  const clearDescription = editor => clearEditorCopy(editor);
  async function fillTopics(tags) {
    const editor=await descriptionControl();
    for(let i=0;i<tags.length;i++){
      await editor.focus();await editor.press('ControlOrMeta+End');
      await (await one(page.getByText('#添加话题',{exact:true}),'原生话题入口')).click();
      await editor.pressSequentially(tags[i],{delay:40});
      // This is the real search result's name, distinct from the text being
      // typed in the editor and from substring matches in related topics.
      const candidate=page.locator('.tag-hash-view-name-DwMEe8').filter({hasText:new RegExp('^'+tags[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});
      await (await one(candidate,`“${tags[i]}”话题候选`)).click();
      await page.waitForFunction(expected=>{
        const editor=document.querySelector('[contenteditable="true"]');
        const actual=[...editor.querySelectorAll('[contenteditable="false"] [data-mention="#"]')].map(el=>(el.textContent || '').replace(/\u200b/g,'').trim().replace(/^#/,''));
        return JSON.stringify(actual)===JSON.stringify(expected);
      },tags.slice(0,i+1),{timeout:10_000});
    }
  }
  const scheduleControl = createScheduleControl({ getPage: () => page, one, choose, selected, now });
  const readSchedule = scheduleControl.read, applySchedule = scheduleControl.apply;
  async function readPreparedPage(job) {
    if (!page || page.isClosed()) throw new Error('待发布页面已关闭，未提交。');
    const title = await one(page.locator('input[placeholder*="填写作品标题"]'),'作品标题');
    const copy = await readCopy();
    return {
      url:page.url(), title:await title.inputValue(),
      description:copy.description,tags:copy.tags,
      ...(locationControl ? {location:await locationControl.read()} : {}),
      declaration:await visible(page.getByText(job.declarationText,{exact:true})).count()===1,
      collection:await visible(page.getByText('请选择合集',{exact:true})).count()===1,
      visibility:await selected(['公开','好友可见','仅自己可见']),
      savePermission:await selected(['允许','不允许']),
      schedule:await readSchedule(),
      covers:{portrait:await coverPreview('竖封面3:4'),landscape:await coverPreview('横封面4:3')}
    };
  }
  async function uploadCover(file, previewText) {
    await page.getByText(previewText,{exact:true}).waitFor({state:'visible',timeout:20_000});
    await one(page.getByText(previewText,{exact:true}),previewText);
    const bitmap=()=>page.locator('canvas').evaluateAll(canvases=>canvases.flatMap(canvas=>{
      if(!canvas.getClientRects().length || canvas.width<300 || canvas.height<300)return [];
      try {
        const ctx=canvas.getContext('2d');if(!ctx)return [];
        let hash=2166136261,opaque=0;
        for(let y=0;y<16;y++)for(let x=0;x<16;x++){
          const p=ctx.getImageData(Math.floor((x+.5)*canvas.width/16),Math.floor((y+.5)*canvas.height/16),1,1).data;
          if(p[3]>128)opaque++; for(const v of p)hash=Math.imul(hash^v,16777619)>>>0;
        }
        return opaque>128?[`${canvas.width}x${canvas.height}:${hash}`]:[];
      }catch{return [];}
    })).then(values=>values.sort().join('|'));
    const previous=await bitmap();
    if(!previous)throw new Error('不能读取封面编辑器的可见画布，未提交。');
    // The real editor contains upload and replacement inputs for multiple
    // tools. Bind the chooser from the observed upload tile, rather than
    // guessing which hidden file input is the cover input.
    // The visible text is covered by this observed Semi upload overlay. Click
    // the actual upload area, whose SVG intercepted text-target clicks.
    const upload=visible(page.locator('.semi-upload.upload-BvM5FF'));
    await waitCoverEnabled(upload,'封面上传区域');
    const picker=page.waitForEvent('filechooser',{timeout:10_000});
    picker.catch(()=>{}); // Observe timeout even while the click is still pending.
    let chooser;
    try { await upload.click(); chooser=await picker; }
    catch(error) { await picker.catch(()=>{}); throw error; }
    await chooser.setFiles(file.path);
    // File selection is asynchronous. The rendered opaque canvas must change
    // and settle before saving, otherwise the editor may save its old frame.
    const deadline=Date.now()+30_000;
    let last='',stable=0;
    while(Date.now()<deadline){
      const current=await bitmap();
      stable=current && current!==previous && current===last?stable+1:0;
      if(stable>=2)break;
      last=current;await page.waitForTimeout(500);
    }
    if(stable<2)throw new Error('所选封面尚未在编辑画布中显示并稳定，未提交。');
    await diagnose(new Error(`${previewText}：文件已选择，检查编辑器实际显示。`),previewText.startsWith('竖')?'竖封面编辑器':'横封面编辑器');
    // Selecting a file alone is never considered a completed cover upload.
    await (await one(page.getByRole('button',{name:'完成',exact:true}),'封面完成按钮')).waitFor({state:'visible'});
    const finish=await one(page.getByRole('button',{name:'完成',exact:true}),'封面完成按钮');
    await finish.waitFor({state:'visible'});
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='完成' && !b.disabled),null,{timeout:60_000});
  }
  async function findManageCard(title) {
    const primary = visible(page.locator('.video-card-sfaSzz').filter({
      has: page.locator('.info-title-text-Zob9RV').filter({ hasText: title }),
    }));
    const primaryCount = await primary.count();
    if (primaryCount > 0) return { locator: primary, count: primaryCount };

    // Semantic fallback when platform frontend hashes change (R13):
    // require a unique visible card ancestor containing title, edit button, and date.
    const tagged = await page.evaluate(expectedTitle => {
      document.querySelectorAll('[data-vdd-manage-card]').forEach(el => el.removeAttribute('data-vdd-manage-card'));
      const editButtons = [...document.querySelectorAll('button,a,span,div')].filter(el => {
        if (!el.getClientRects().length || el.children.length > 1) return false;
        const txt = (el.innerText || '').trim();
        return txt === '编辑作品' || txt === '继续编辑';
      });
      const cards = new Set();
      for (const btn of editButtons) {
        let node = btn.parentElement;
        for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
          const text = node.innerText || '';
          if (text.length > 2200) break;
          if (text.includes(expectedTitle) && /\d{4}年\d{2}月\d{2}日\s+\d{2}:\d{2}/.test(text)) {
            cards.add(node);
            break;
          }
        }
      }
      const roots = [...cards].filter(c => ![...cards].some(other => other !== c && other.contains(c)));
      roots.forEach((el, idx) => el.setAttribute('data-vdd-manage-card', String(idx)));
      return roots.length;
    }, title).catch(() => 0);

    if (tagged > 0) {
      const fallback = visible(page.locator('[data-vdd-manage-card]'));
      return { locator: fallback, count: await fallback.count() };
    }
    return { locator: primary, count: 0 };
  }

  async function readApiReceipt(job) {
    if (!workListObserver) return null;
    const snap = await workListObserver.flush();
    if (!snap.items.length) return null;
    const matched = matchDouyinWorkListItem(snap.items, job);
    if (matched.status === 'conflict' && matched.item?.workId) {
      return {
        status: 'awaiting_verification',
        workId: matched.item.workId,
        workUrl: `https://www.douyin.com/video/${matched.item.workId}`,
        message: '平台列表接口读到与原候选编号不同的作品，保留原依据，不会重发。',
      };
    }
    if (matched.status !== 'matched' || !matched.item) return null;
    const item = matched.item;
    const proof = receiptVisibility({ visibility: item.visibility }, null, submissionProof);
    const visibility = item.visibility !== 'unverified' ? item.visibility : proof.visibility;
    const visibilityVerification = item.visibility !== 'unverified' ? 'creator_work_list_api' : proof.visibilityVerification;
    const statusText = {
      under_review: '审核中',
      published: '平台显示已发布',
      rejected: '审核未通过',
      scheduled: '平台显示定时发布中',
      unknown: '审核状态待平台更新',
    }[item.platformStatus] || '审核状态待平台更新';
    const visText = { self: '仅自己可见', public: '公开', friends: '好友可见' }[visibility] || '待核对';
    return {
      status: 'submitted',
      workId: item.workId,
      workUrl: `https://www.douyin.com/video/${item.workId}`,
      publishedAt: item.publishedAt,
      duration: item.duration,
      platformStatus: item.platformStatus,
      visibility,
      visibilityVerification,
      verification: 'creator_work_list_api',
      message: `平台作品接口已核对唯一编号：${item.duration || '未知时长'} · 提交范围${visText} · ${item.publishedAt || '未知时间'}。${statusText}。`,
    };
  }

  async function waitForManageReady(title, timeoutMs = 60_000) {
    await page.waitForFunction(() => !!document.body && (document.body.innerText || '').trim().length > 0, null, { timeout: Math.min(20_000, timeoutMs) }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hasTitle = await page.evaluate(expected => (document.body?.innerText || '').includes(expected), title).catch(() => false);
      if (hasTitle) return true;
      const snap = workListObserver ? workListObserver.snapshot() : null;
      if (snap && snap.items.length > 0) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  async function readResult(job) {
    activeTitle=job.copy.title;
    await waitForManageReady(job.copy.title, 60_000);
    const search=visible(page.getByPlaceholder('搜索作品',{exact:true}));
    if(await search.count()===1 && await search.inputValue()){
      // Newly published records may not be indexed by keyword yet. Inspect
      // the actual newest records instead of treating search lag as absence.
      await search.fill('');await search.press('Enter');
      await page.waitForFunction(()=>document.querySelectorAll('.video-card-sfaSzz,[class*="video-card"]').length>0,null,{timeout:15_000}).catch(()=>{});
    }
    const apiReceipt = await readApiReceipt(job);
    if (apiReceipt && apiReceipt.status === 'awaiting_verification') return apiReceipt;
    if (apiReceipt && apiReceipt.status === 'submitted' && apiReceipt.visibility !== 'unverified') {
      await diagnose(new Error('已通过平台作品列表接口只读核对唯一编号与权限，未修改作品。'));
      return apiReceipt;
    }
    const found = await findManageCard(job.copy.title);
    const card = found.locator;
    let record=null;
    if(found.count===1){
      record=listRecordEvidence(await card.innerText(),job.requireListEvidence?{...job,expectedWorkId:undefined}:job);
      if(!record)return {status:'awaiting_verification',message:'同名作品尚不能对应本次提交时间和视频时长，不会借用旧记录，也不会重发。'};
      await card.getByText('编辑作品',{exact:true}).or(card.getByText('继续编辑',{exact:true})).first().click({timeout:10_000});
      await page.waitForTimeout(500);
    }
    const detail=await readWorkDetail(job);
    if(detail && record){
      const proof=receiptVisibility(record,detail,submissionProof);
      const status={under_review:'审核中',published:'平台显示已发布',rejected:'审核未通过',scheduled:'平台显示定时发布中',unknown:'审核状态待平台更新'}[record.platformStatus];
      return {...detail,...record,...proof,verification:'creator_detail_and_list',message:`平台已接收本条作品并核对唯一编号：${record.duration} · 提交范围${{self:'仅自己可见',public:'公开',friends:'好友可见'}[proof.visibility] || '待核对'} · ${record.publishedAt}。${status}。`};
    }
    if(apiReceipt && apiReceipt.status === 'submitted') return apiReceipt;
    if(detail && job.expectedWorkId===detail.workId && !job.requireListEvidence)return detail;
    if(detail)return {...detail,status:'awaiting_verification',message:'已读到同标题详情页的候选作品编号；尚缺本次作品列表依据，保留编号继续核查，未视为成功。'};
    await diagnose(new Error('只读核查平台作品及播放预览，未执行上传或再次提交。'));
    const links=await page.locator('a[href]').evaluateAll((anchors,title)=>{
      const shown=el=>!!el.getClientRects().length;
      return [...new Set(anchors.filter(shown).filter(a=>/^https:\/\/(?:www\.)?douyin\.com\/video\/\d{10,30}(?:\?|$)/.test(a.href))
        .filter(a=>{let n=a;for(let i=0;i<6&&n;i++,n=n.parentElement){if((n.innerText || '').includes(title))return true;}return false;}).map(a=>a.href))];
    },job.copy.title);
    if(links.length===1 && record)return {status:'submitted',...record,...receiptVisibility(record,null,submissionProof),workUrl:links[0],workId:new URL(links[0]).pathname.split('/').pop(),message:'已在平台作品记录找到本条标题、时间及唯一作品链接；请以平台显示的审核状态为准。'};
    return {status:'awaiting_verification',message:'平台已执行过一次提交；本次只读核查仍未取得唯一作品链接，不会重发。'};
  }
  async function readWorkDetail(job) {
    const url=new URL(page.url());
    // Observed on this exact title's 编辑作品 navigation. Read the existing
    // title and the platform-assigned mid; do not edit or save this form.
    const id=url.searchParams.get('mid');
    if(url.hostname!=='creator.douyin.com' || url.pathname!=='/creator-micro/content/post/video' || !/^\d{10,30}$/.test(id || ''))return null;
    if(job.expectedWorkId && job.expectedWorkId!==id)return null;
    const title=visible(page.locator('input[placeholder*="填写作品标题"]'));
    // The edit shell appears before the work data. Visibility alone accepted
    // an empty title immediately after a successful publish. Wait for the
    // same work ID AND the exact title, without writing or saving the form.
    try {
      await page.waitForFunction(({id,title})=>{
        const url=new URL(location.href);
        const inputs=[...document.querySelectorAll('input[placeholder*="填写作品标题"]')].filter(el=>el.getClientRects().length && getComputedStyle(el).visibility!=='hidden');
        return url.hostname==='creator.douyin.com' && url.pathname==='/creator-micro/content/post/video'
          && url.searchParams.get('mid')===id && inputs.length===1 && inputs[0].value.trim()===title;
      },{id,title:job.copy.title},{timeout:20_000});
    } catch {return null;}
    const current=new URL(page.url());
    if(current.origin!==url.origin || current.pathname!==url.pathname || current.searchParams.get('mid')!==id)return null;
    if(await title.count()!==1 || (await title.inputValue()).trim()!==job.copy.title)return null;
    let visibility='unverified';
    try {visibility={'公开':'public','好友可见':'friends','仅自己可见':'self'}[await selected(['公开','好友可见','仅自己可见'])] || 'unverified';} catch {}
    await diagnose(new Error('从同一作品详情页只读核对了平台编号和标题，未修改、未重新保存。'));
    return {status:'submitted',workId:id,workUrl:`https://www.douyin.com/video/${id}`,sourceUrl:page.url(),verification:'creator_edit_page',visibility,message:`已在平台找到本条作品并核对唯一编号；可见范围：${{self:'仅自己可见',public:'公开',friends:'好友可见'}[visibility] || '尚待核对'}。`};
  }
  async function verifyListRecord(detail,job) {
    const pending=job.requireListEvidence?{...detail,status:'awaiting_verification',message:'候选编号已保留；尚缺本次作品列表与编号一致的依据，未视为成功。'}:detail;
    await waitForManageReady(job.copy.title, 30_000);
    const apiReceipt = await readApiReceipt({ ...job, expectedWorkId: detail.workId });
    if (apiReceipt && apiReceipt.status === 'awaiting_verification') return pending;
    if (apiReceipt && apiReceipt.status === 'submitted' && apiReceipt.workId === detail.workId) {
      if (apiReceipt.visibility !== 'unverified') return apiReceipt;
    }
    const found = await findManageCard(job.copy.title);
    const card = found.locator;
    if(found.count!==1)return pending;
    const text=await card.innerText();
    const record=listRecordEvidence(text,job.requireListEvidence?{...job,expectedWorkId:undefined}:job);
    if(!record)return pending;
    if(job.requireListEvidence){
      await card.getByText('编辑作品',{exact:true}).or(card.getByText('继续编辑',{exact:true})).first().click({timeout:10_000});
      const current=await readWorkDetail(job);
      return current && current.workId===detail.workId?{...current,...record,...receiptVisibility(record,current,submissionProof),verification:'creator_detail_and_list'}:pending;
    }
    const {publishedAt,duration}=record;
    const isPrivate=record.visibility==='self';
    await card.scrollIntoViewIfNeeded();const box=await card.boundingBox();
    const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    const clip=box?{x:0,y:0,width:size.width,height:Math.min(size.height,Math.max(200,box.y+box.height+15))}:undefined;
    await diagnose(new Error('已核对本条作品在平台列表中的实际时长、发布时间和权限，未修改作品。'),'本条作品记录',clip);
    return {...detail,visibility:isPrivate?'self':detail.visibility,publishedAt,duration,verification:'creator_detail_and_list',message:`已在平台作品列表核对本条：${duration}${isPrivate?' · 仅自己可见':''}${publishedAt?' · '+publishedAt:''}，唯一编号已确认。`};
  }
  function assertUploadRunning(signal){
    if(stopped || signal?.aborted)throw new Error('任务已停止，未提交。');
  }
  async function videoIdentity(){
    const raw=await page.evaluate(()=>({
      files:[...document.querySelectorAll('input[type="file"]')].filter(el=>/video/i.test(el.accept)).flatMap(el=>[...(el.files || [])].map(file=>({name:file.name,size:file.size,modified:file.lastModified}))),
      sources:[...document.querySelectorAll('video')].map(el=>el.currentSrc || el.src).filter(Boolean),
    }));
    if(!raw.files.length && !raw.sources.length)return null;
    return JSON.stringify({files:raw.files,sources:raw.sources.map(normalizeCoverSource).sort()});
  }
  // The production preparation and the diagnostic session use this SAME step.
  // It performs no field filling, cover action or submission.
  async function uploadVideo(job,{signal,onStep=()=>{}}={}){
    assertUploadRunning(signal);
    if(uploadStarted)throw new Error('本会话已经开始过上传；请保留原现场核查，不会重新选择视频。');
    uploadStarted=true;activeSignal=signal;activeTitle=job.copy.title;activeTags=job.copy.tags || [];
    onStep({message:'真实账号复查通过；正在打开该账号自己的上传页。',progress:5});
    page=await context.newPage();assertUploadRunning(signal);
    const surface=await withFocus('upload_select', async () => {
      await page.goto(UPLOAD,{waitUntil:'commit',timeout:30_000});
      const video=await fileInput('video','视频上传控件');assertUploadRunning(signal);
      onStep({message:'已找到视频控件，开始上传本条视频。',progress:10});
      const s=await uploadSurface(video);
      assertUploadRunning(signal);await video.setInputFiles(job.files.video.path);
      return s;
    });
    const completion=await waitForVideoUpload({read:()=>surface.read({mode:'douyin'}),signal,isStopped:()=>stopped,maxMs:uploadWaitMs,onProgress:onStep});
    assertUploadRunning(signal);
    uploadCheckpoint={fingerprint:job.fingerprint,url:page.url(),surface,root:await page.locator('body').elementHandle(),media:await videoIdentity()};
    assertUploadRunning(signal);
    onStep({message:'视频上传完成；本条上传步骤结束，尚未设置封面或提交。',progress:30});
    await diagnose(new Error('真实视频上传完成后的页面记录，尚未提交。'));
    return {step:'video_uploaded',complete:true,completion:completion || null};
  }
  async function inspectUploadLocation(job){
    const invalid=message=>Object.assign(new Error(message),{code:'CHECKPOINT_INVALID'});
    assertUploadRunning(activeSignal);
    if(!uploadCheckpoint || uploadCheckpoint.fingerprint!==job.fingerprint || !page || page.isClosed())throw invalid('原上传页面或任务已失效，不能沿用检查点。');
    try{await verify(job);}catch(error){error.code='CHECKPOINT_INVALID';throw error;}
    assertUploadRunning(activeSignal);
    if(page.url()!==uploadCheckpoint.url || !await uploadCheckpoint.root.evaluate(el=>el.isConnected).catch(()=>false))throw invalid('原上传页面已导航或重新加载，检查点失效；不会重新上传。');
    if(!uploadCheckpoint.media || uploadCheckpoint.media!==await videoIdentity())throw invalid('原页面的视频已改变或缺少可核对的视频标识，检查点失效。');
    const current=await uploadCheckpoint.surface.read({mode:'douyin'});
    if(!current.complete || current.failed || current.lost)throw invalid('原页面不再具有本条视频上传完成的证据。');
    assertUploadRunning(activeSignal);
    const control=require('./publish-location-driver.cjs').createLocationControl(page,job.location || {mode:'none',name:''},{platform:'douyin',assertRunning:()=>assertUploadRunning(activeSignal)});
    return control.read(); // Never apply(): no click, clear, search or fill.
  }
  return {
    capabilities:Object.freeze({submit:canSubmit,submissionProtocol:1}),
    verify,
    uploadVideo,
    inspectUploadLocation,
    async inspectResult(job) {
      await verifyIdentity(job);activeTitle=job.copy.title;
      let knownDetail=null;
      for(const candidate of job.expectedWorkId ? context.pages() : []){
        try {const u=new URL(candidate.url());if(u.hostname==='creator.douyin.com' && u.pathname==='/creator-micro/content/post/video' && /^\d{10,30}$/.test(u.searchParams.get('mid') || '')){page=candidate;knownDetail=await readWorkDetail(job);if(knownDetail)break;}}catch{}
      }
      // Another pre-existing list tab can still contain records from before
      // submission. Fetch a current list in a reader-owned tab; never reload
      // or navigate a user's existing edit page or unsaved input.
      if(!resultPage || resultPage.isClosed())resultPage=await context.newPage();
      page=resultPage;
      attachWorkListObserver(page);
      await withFocus('inspect_nav', () => page.goto('https://creator.douyin.com/creator-micro/content/manage',{waitUntil:'domcontentloaded',timeout:30_000}));
      if(knownDetail){await page.bringToFront();return verifyListRecord(knownDetail,job);}
      return readResult(job);
    },
    async prepare(job,{signal,onStep}) {
      activeSignal=signal;coverProgress=onStep;
      activeTitle=job.copy.title;activeTags=job.copy.tags || [];
      const checks=Object.fromEntries(CHECKS.map(k=>[k,false]));
      const step=(message,progress)=>{if(signal?.aborted || stopped)throw new Error('真实试发已停止；未提交。');onStep({message,progress});};
      try {
        await uploadVideo(job,{signal,onStep});
        checks.video=true; step('平台已显示视频预览和“重新上传”，视频上传完成。',30);
        const vis={public:'公开',friends:'好友可见',self:'仅自己可见'};
        const save={allow:'允许',deny:'不允许'};
        await withFocus('fill_form', async () => {
          // The observed first-use bubble only explains preview compression. It
          // is not an agreement, login prompt or permission request.
          if (await visible(page.getByText('视频预览功能',{exact:true})).count()===1 && await visible(page.getByRole('button',{name:'我知道了',exact:true})).count()===1) {
            await (await one(page.getByRole('button',{name:'我知道了',exact:true}),'视频预览说明关闭按钮')).click();
          }
          const title=await one(page.locator('input[placeholder*="填写作品标题"]'),'作品标题');
          await title.fill(job.copy.title);
          const description=await descriptionControl();
          const expectedCopy={title:job.copy.title,description:String(job.copy.description ?? '')};
          // 2026-11-11 实测：上传完成后简介框里已有平台预填的话题节点（不可编辑的
          // mention），innerText 会把它们读成文字。先按结构回读；有残留就清空，
          // 空简介不再依赖 fill('') 碰巧清掉内容。
          const prefilled=await readCopy();
          if(prefilled.description || prefilled.tags.length){
            await clearDescription(description);
            step(`简介框里有平台预填内容（${clipCopy([prefilled.description,...prefilled.tags.map(t=>'#'+t)].filter(Boolean).join(' '))}），已清空后按本条任务填写。`,32);
          }
          if(expectedCopy.description)await description.fill(expectedCopy.description);
          const typed={title:await title.inputValue(),...await readCopy()};
          const copyIssue=copyFillIssue(expectedCopy,typed);
          checks.text=!copyIssue;
          if(copyIssue){const error=new Error(copyIssue);error.copyReadback={expected:expectedCopy,actual:typed,prefilled};throw error;}
          await fillTopics(job.copy.tags || []);
          const readback=await readCopy();
          if(readback.description!==job.copy.description || JSON.stringify(readback.tags)!==JSON.stringify(job.copy.tags || []))throw new Error('简介或原生话题回读与本条任务不一致，未提交。');
          step(`标题、简介和${readback.tags.length}个原生话题已填写并回读一致。`,40);
          const declaration=await one(page.getByText('请选择自主声明',{exact:true}),'自主声明入口');
          await declaration.click();
          // This site's custom radio may reset the native checked property; the
          // authoritative readback is the saved declaration after confirming.
          await (await one(page.getByRole('radio',{name:job.declarationText,exact:true}),'声明单选项')).click();
          await (await one(page.getByRole('button',{name:'确定',exact:true}),'声明确认按钮')).click();
          await page.getByText('请选择声明类型（单选）',{exact:true}).waitFor({state:'hidden',timeout:5000});
          checks.declaration=await visible(page.getByText(job.declarationText,{exact:true})).count()===1;
          if(!checks.declaration)throw new Error('原生声明选择后未能回读一致。');
          checks.collection=(await visible(page.getByText('请选择合集',{exact:true})).count())===1;
          if(!checks.collection)throw new Error('未能确认本条不加入合集。');
          if(job.settings.visibility!=='platform_default')await choose(vis[job.settings.visibility]);
          await selected(['公开','好友可见','仅自己可见']); checks.visibility=true;
          if(job.settings.savePermission!=='platform_default')await choose(save[job.settings.savePermission]);
          await selected(['允许','不允许']); checks.savePermission=true;
          await applySchedule(job); checks.schedule=(await readSchedule())===scheduleText(job);
          if(!checks.schedule)throw new Error('发布时间回读与本条任务不一致，未提交。');
          step(`声明、合集、可见范围、保存权限及发布时间（${scheduleText(job)}）已在页面回读。`,55);
        });
        const before={portrait:await coverPreview('竖封面3:4'),landscape:await coverPreview('横封面4:3')};
        let expectedPixels=null;
        if(job.coverMode==='video_default'){
          await withFocus('cover_default', async () => {
            await openCover('竖封面3:4','竖封面预览（3:4）');
            await page.getByText('竖封面预览（3:4）',{exact:true}).waitFor({state:'visible',timeout:20_000});
            await (await one(page.getByRole('button',{name:'完成',exact:true}),'视频默认封面完成按钮')).click();
            await page.waitForFunction(()=>{const body=document.body?.innerText || '';return body.includes('设置横封面获更多流量') || !body.includes('竖封面预览（3:4）');},null,{timeout:10_000});
            if(await visible(page.getByText('设置横封面获更多流量',{exact:true})).count())await (await one(page.getByRole('button',{name:'暂不设置',exact:true}),'保留视频默认封面按钮')).click();
            await page.getByText('竖封面预览（3:4）',{exact:true}).waitFor({state:'hidden',timeout:30_000});
            step('已明确使用视频默认画面；正在核对封面预览，未上传自定义封面。',75);
          });
        }else{
          await withFocus('cover_portrait', async () => {
            await openCover('竖封面3:4','竖封面预览（3:4）');
            step('正在通过封面编辑器上传本条竖版封面。',60);
            await uploadCover(job.files.portrait,'竖封面预览（3:4）');
            await finishCover('竖封面预览（3:4）');
          });
          expectedPixels={portrait:await expectedCoverPixels(job.files.portrait,3/4),landscape:await expectedCoverPixels(job.files.landscape,4/3)};
          await diagnose(new Error('竖封面已单独保存；从主表单打开横封面编辑器。'),'竖封面保存后');
          await withFocus('cover_landscape', async () => {
            await openCover('横封面4:3','横封面预览（4:3）');
            step('竖封面已保存，正在独立上传横封面。',75);
            await uploadCover(job.files.landscape,'横封面预览（4:3）');
            await finishCover('横封面预览（4:3）');
          });
        }
        step('封面编辑器已保存，正在等待平台载入两张封面预览。',90);
        const coverDeadline=Date.now()+Math.min(90_000,Math.max(500,coverWaitMs));
        let after,stableCovers=0,lastCovers='',lastCoverDiag=null;
        do {
          after={portrait:await coverPreview('竖封面3:4'),landscape:await coverPreview('横封面4:3')};
          const pixels={portrait:await displayedCoverPixels('竖封面3:4',3/4),landscape:await displayedCoverPixels('横封面4:3',4/3)};
          const metrics=expectedPixels
            ? {portrait:measureCoverPixels(expectedPixels.portrait,pixels.portrait),landscape:measureCoverPixels(expectedPixels.landscape,pixels.landscape)}
            : {portrait:{matched:!!after.portrait},landscape:{matched:!!after.landscape}};
          const matches=metrics.portrait.matched && metrics.landscape.matched;
          const current=JSON.stringify(after);stableCovers=matches && current===lastCovers?stableCovers+1:0;lastCovers=current;
          const changed=job.coverMode==='video_default' || (after.portrait!==before.portrait && after.landscape!==before.landscape);
          checks.covers=matches && stableCovers>=3 && !!after.portrait && !!after.landscape && changed;
          lastCoverDiag={portrait:metrics.portrait,landscape:metrics.landscape,afterNonEmpty:!!after.portrait && !!after.landscape,beforeChanged:changed,stableCovers};
          if(checks.covers || Date.now()>=coverDeadline)break;
          if(signal?.aborted || stopped)throw new Error('本次真实试发已停止；未提交。');
          await page.waitForTimeout(500);
        }while(true);
        if(!checks.covers){const error=new Error('尚不能确认两张封面均已替换成功，已保留页面供核对；未提交。');error.coverReadback=lastCoverDiag;throw error;}
        if(job.location){
          step('正在核对本条作品定位。',90);
          await withFocus('location', async () => {
            locationControl=require('./publish-location-driver.cjs').createLocationControl(page,job.location,{platform:'douyin',assertRunning:()=>{if(signal?.aborted || stopped)throw new Error('任务已停止，未提交。');}});
            await locationControl.apply();
          });
        }
        // R01: Wait for Douyin's asynchronous "快速检测" to settle BEFORE taking
        // the final preparedPage snapshot, so async CDN cover URL updates during
        // quick-check do not falsely trigger "等待确认期间平台表单已改变（封面）".
        let advisory = { present: false, state: 'not_present', percent: null, issues: [], summary: '', requiresConfirmation: false };
        const readQuickCheck = async () => parsePlatformQuickCheck(await page.evaluate(() => document.body?.innerText || '').catch(() => ''), job);
        advisory = await readQuickCheck();
        if (advisory.state === 'checking' && quickCheckWaitMs > 0) {
          const checkDeadline = Date.now() + quickCheckWaitMs;
          let lastPct = null;
          while (advisory.state === 'checking' && Date.now() < checkDeadline) {
            if (signal?.aborted || stopped) throw new Error('本次真实试发已停止；未提交。');
            if (advisory.percent !== lastPct) {
              lastPct = advisory.percent;
              step(`正在等待平台快速检测完成（${advisory.percent !== null ? advisory.percent + '%' : '检测中'}），尚未提交。`, 95);
            }
            await page.waitForTimeout(Math.min(1500, Math.max(100, checkDeadline - Date.now())));
            advisory = await readQuickCheck();
          }
          if (advisory.state === 'checking') {
            advisory = { ...advisory, summary: `${advisory.summary}（已超过等待上限，交由人工确认）`, requiresConfirmation: true };
          }
        }
        preparedPage=await readPreparedPage(job);
        if (preparedPage.title!==job.copy.title || preparedPage.description!==job.copy.description || JSON.stringify(preparedPage.tags)!==JSON.stringify(job.copy.tags || []) || !preparedPage.declaration || !preparedPage.collection || preparedPage.schedule!==scheduleText(job)) throw new Error('封面保存后页面内容与任务不一致，未提交。');
        if (job.settings.visibility!=='platform_default' && preparedPage.visibility!==vis[job.settings.visibility]) throw new Error('平台可见范围与本条要求不一致，未提交。');
        if (job.settings.savePermission!=='platform_default' && preparedPage.savePermission!==save[job.settings.savePermission]) throw new Error('平台保存权限与本条要求不一致，未提交。');
        preparedFingerprint=job.fingerprint;
        await diagnose(new Error(advisory.requiresConfirmation ? `全部页面设置已核对，平台快速检测需人工确认：${advisory.summary}` : '全部页面设置已核对，等待最终确认；尚未提交。'));
        step(advisory.requiresConfirmation ? `全部页面要求已回读；${advisory.summary}，暂停等待人工确认。` : '全部页面要求已回读，继续处理本次任务。',100);
        return {checks, advisory};
      } catch(error) { await diagnose(error); throw error; }
    },
    async submit(job,{beforeDispatch=async()=>{},afterDispatch=async()=>{}}={}) {
      if(!canSubmit)throw new Error('此执行器仅供准备测试，没有发布权限。');
      if(submitted || stopped || preparedFingerprint!==job.fingerprint || !page || page.isClosed())throw new Error('没有可提交的唯一准备任务。');
      await verify(job);
      const publish=await one(page.getByRole('button',{name:'发布',exact:true}),'发布按钮');
      let dispatchError=null;
      await withFocus('submit', async () => {
        if(submitted || stopped || activeSignal?.aborted || !page || page.isClosed())throw new Error('本次真实试发已停止；未提交。');
        scheduleControl.assertCurrent(job);
        attachWorkListObserver(page);
        await beforeDispatch('publish');
        submitted=true;
        try {
          await publish.click({timeout:10_000});
          await afterDispatch('publish');
        } catch(error) { dispatchError=error; }
      });
      if(dispatchError){await diagnose(dispatchError);return {status:'awaiting_verification',message:'真实提交已尝试一次，结果尚未核实；不会自动重发。'};}
      try {
        submissionProof={clicked:true,visibility:preparedPage.visibility};
        await page.waitForFunction(()=>{const body=document.body?.innerText || '';return /发布成功|投稿成功|提交成功|作品管理|内容管理/.test(body) && !/基础信息[\s\S]*作品描述/.test(body);},null,{timeout:30_000});
        await diagnose(new Error('已执行一次平台发布动作，记录结果页以核对本条作品。'));
        return await readResult(job);
      } catch(error) { await diagnose(error); return {status:'awaiting_verification',message:'真实提交已尝试一次，结果尚未核实；不会自动重发。'}; }
    },
    async stop() { stopped=true; if (workListObserver) { workListObserver.detach(); workListObserver = null; } /* Keep the actual platform draft and its tab. */ }
  };
}
module.exports={createDouyinPublisher,copyFillIssue,readEditorCopy,clearEditorCopy,assertPreparedPage,normalizeCoverSource,measureCoverPixels,coverPixelsMatch,listRecordEvidence,receiptVisibility,createScheduleControl,scheduleText};
