'use strict';

const COVER_READY_MAX_MS=10*60*1000;
// A preview wrapper is not a button. In particular, pointer-events:none on a
// tooltip/preview ancestor does not disable a child that restores pointer events.
// Hidden native file inputs are also normal; never force an actually disabled one.
function readCoverReadiness(el,{wrapper=false}={}){
  if(!el.isConnected)return {ready:false,reason:'入口已被替换'};
  if(!el.matches('input[type="file"]') && (!el.getClientRects().length || getComputedStyle(el).visibility==='hidden'))return {ready:false,reason:'平台尚未显示入口'};
  for(let n=el,depth=0;n && depth<5;n=n.parentElement,depth++){
    if(n.disabled || n.getAttribute('aria-disabled')==='true' || /(?:^|[\s_-])disabled(?:$|[\s_-])/.test(String(n.className)))return {ready:false,reason:'平台仍禁用入口'};
  }
  if(!wrapper && !el.matches('input[type="file"]') && getComputedStyle(el).pointerEvents==='none')return {ready:false,reason:'编辑入口尚不可操作'};
  return {ready:true,reason:'平台入口已启用'};
}
async function waitForCoverReady({read,label='封面',maxMs=COVER_READY_MAX_MS,pollMs=500,assertRunning=()=>{},onProgress=()=>{},now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const started=now();let reported=-Infinity,last;
  while(true){
    assertRunning();last=await read();assertRunning();
    if(last.ready)return last;
    const elapsed=now()-started;
    if(elapsed>=maxMs){const error=new Error(`${label}入口等待已达上限（${Math.round(maxMs/60000)}分钟）：${last.reason || '平台尚未启用'}；未上传封面、未提交，原页面保留，不会自动重传视频。`);error.code='COVER_NOT_READY';error.coverState=last;throw error;}
    if(now()-reported>=30000){onProgress({message:`视频已交给平台，正在等待${label}入口启用；已等待 ${Math.floor(elapsed/60000)} 分钟，尚未上传封面、未提交。`,progress:45});reported=now();}
    await pause(Math.min(pollMs,maxMs-elapsed));
  }
}
module.exports={readCoverReadiness,waitForCoverReady,COVER_READY_MAX_MS};
