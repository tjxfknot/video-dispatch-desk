'use strict';

// Waiting never selects a file, refreshes a page or submits a post. A slow but
// advancing upload must not fail merely because three minutes have elapsed.
const UPLOAD_MAX_MS=2*60*60*1000, UPLOAD_IDLE_MS=10*60*1000;

function readUploadSnapshot(body,{mode,before={sources:[],completeMarkers:0}}){
  // The surface body was resolved from the chosen file input. If the platform
  // replaces that layer, its old text can no longer prove progress or success.
  if(!body.isConnected)return {complete:false,failed:'',lost:true,loaded:null,percent:null,summary:'平台上传区域已被页面替换'};
  const shown=el=>!!el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
  const text=body.innerText || '';
  // These observed Douyin lines describe a conditional warning and a separate
  // preview conversion. Neither is evidence that the video is still uploading.
  // Keep real byte progress, cancellation, conversion states and errors strict.
  const statusLines=text.split('\n').map(s=>s.trim()).filter(s=>s
    && !(mode==='douyin' && /^点击发布后[，,]如作品还在上传中[，,]请勿关闭页面[，,]等待上传发布完成[。.]?$/.test(s))
    && !(mode==='douyin' && /^预览转码中[，,]请稍后[。.]?$/.test(s)));
  const amount=text.match(/(?:已上传\s*[:：]?\s*)?(\d+(?:\.\d+)?)\s*(KB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB)/i);
  const bytes=(value,unit)=>Number(value)*({KB:1024,MB:1024**2,GB:1024**3}[unit.toUpperCase()] || 1);
  const loaded=amount?bytes(amount[1],amount[2]):null,total=amount?bytes(amount[3],amount[4]):null;
  const bar=[...body.querySelectorAll('progress,[role="progressbar"]')].find(shown);
  const rawPercent=bar?(bar.tagName==='PROGRESS'?100*bar.value/(bar.max || 1):bar.getAttribute('aria-valuenow')):null;
  const percent=rawPercent!==null && Number.isFinite(Number(rawPercent))?Number(rawPercent):null;
  const uploading=(total>0 && loaded<total) || (percent!==null && percent>=0 && percent<100) || statusLines.some(s=>/正在上传|上传中|取消上传|正在转码|转码中/.test(s));
  const failed=text.match(/上传失败|上传出错|文件解析失败|转码失败/)?.[0] || '';
  const previews=[...body.querySelectorAll('video')].filter(v=>shown(v) && v.readyState>=1 && !before.sources.includes(v.currentSrc || v.src));
  // A blob/data preview can be playable as soon as a local file is chosen. It
  // cannot prove transfer completion, even if the page shows no progress text.
  const remotePreview=previews.some(v=>/^https?:\/\//.test(v.currentSrc || v.src));
  const previewOnly=previews.length>0 && !remotePreview;
  const complete=mode==='douyin'
    ? [...body.querySelectorAll('*')].some(el=>shown(el) && el.children.length===0 && el.textContent.trim()==='重新上传')
    : remotePreview
      || (text.match(/上传完成|上传成功/g) || []).length>before.completeMarkers;
  const details=statusLines.filter(s=>s.length<100 && /已上传|当前速度|剩余时间|上传中|转码中|正在转码/.test(s)).slice(0,4);
  return {complete:complete && !uploading,previewOnly,uploading,failed,loaded,percent:Number.isFinite(percent)?percent:null,
    summary:details.join('；') || (percent!==null?`平台上传进度 ${Math.round(percent)}%`:'正在等待平台上传与转码')};
}

async function waitForVideoUpload({read,signal,isStopped=()=>false,onProgress=()=>{},
  maxMs=UPLOAD_MAX_MS,idleMs=UPLOAD_IDLE_MS,pollMs=1000,now=Date.now,
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const started=now();let advancedAt=started,lastReported=-Infinity,loaded=-1,percent=-1,last;
  const stopped=()=>{if(signal?.aborted || isStopped()){const e=new Error('已停止等待上传；未提交，原平台页面保留。');e.code='UPLOAD_STOPPED';throw e;}};
  while(true){
    stopped();last=await read();stopped();
    if(last.lost){const e=new Error('平台上传区域已被页面替换，无法继续确认本次上传进度；未提交，原窗口保留，不会自动重传。');e.code='UPLOAD_SURFACE_LOST';throw e;}
    if(last.failed){const e=new Error(`平台报告${last.failed}；未提交，原窗口保留，不会自动重传。`);e.code='UPLOAD_PLATFORM_FAILED';throw e;}
    if(last.complete)return last;
    if((Number.isFinite(last.loaded) && last.loaded>loaded) || (Number.isFinite(last.percent) && last.percent>percent))advancedAt=now();
    if(Number.isFinite(last.loaded))loaded=Math.max(loaded,last.loaded);
    if(Number.isFinite(last.percent))percent=Math.max(percent,last.percent);
    const elapsed=now()-started;
    if(elapsed>=maxMs || now()-advancedAt>=idleMs){
      const e=new Error(`${elapsed>=maxMs?'本次上传等待已达上限':'平台上传或转码长时间没有可确认的进展'}；${last.summary || '请检查原窗口'}。未提交，原窗口保留，不会自动重传。`);
      e.code=elapsed>=maxMs?'UPLOAD_WAIT_LIMIT':'UPLOAD_STALLED';e.uploadState=last;throw e;
    }
    if(now()-lastReported>=30000){onProgress({message:`${last.summary || '视频仍在上传或转码'}；已等待 ${Math.floor(elapsed/60000)} 分钟，尚未提交。`,progress:Number.isFinite(last.percent)?Math.min(29,10+Math.floor(last.percent*0.19)):20});lastReported=now();}
    await pause(Math.min(pollMs,maxMs-elapsed,idleMs-(now()-advancedAt)));
  }
}
function readUploadBaseline(body){
  return {sources:[...body.querySelectorAll('video')].map(v=>v.currentSrc || v.src),completeMarkers:((body.innerText || '').match(/上传完成|上传成功/g) || []).length};
}
// Some platform pages render a second, framework-created <body> (视频号助手
// 2026-11-11: an outer navigation body and an inner body holding the post
// form, both matched by locator('body')). Upload progress belongs to the body
// that contains the chosen video input, crossing open shadow roots; never to
// whichever body happens to be first. Resolve it before selecting the file:
// the input itself may be replaced once the upload starts.
async function uploadSurface(fileInput){
  const body=await fileInput.evaluateHandle(input=>{
    for(let node=input;node;){
      const found=node.closest?.('body');if(found)return found;
      const root=node.getRootNode();node=root instanceof ShadowRoot?root.host:null;
    }
    return input.ownerDocument.body;
  });
  return {
    baseline:()=>body.evaluate(readUploadBaseline),
    read:options=>body.evaluate(readUploadSnapshot,options),
    describe:()=>body.evaluate(b=>({inShadowRoot:b.getRootNode() instanceof ShadowRoot,isDocumentBody:b===b.ownerDocument.body})),
  };
}
module.exports={waitForVideoUpload,readUploadSnapshot,readUploadBaseline,uploadSurface,UPLOAD_MAX_MS,UPLOAD_IDLE_MS};
