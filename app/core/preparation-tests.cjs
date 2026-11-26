'use strict';
const {randomUUID}=require('node:crypto');
const {assertPlanAvailable}=require('./managed-plan.cjs');
const clone=value=>structuredClone(value);
const message=error=>String(error?.message || error || '检查未完成').split('\n')[0].replace(/\/Users\/[^\s，；]+/g,'[本机路径]').slice(0,350);
const sameAccount=(a,b)=>a.platform===b.platform && (a.accountId===b.accountId || a.expectedBinding?.platformAccountId===b.expectedBinding?.platformAccountId);
const SCENARIOS=Object.freeze(['quick','slow_upload','location_residue','upload_failure']);

// Deliberately no approve, submit, field-writing or generic command API.
class PreparationTests {
  constructor({store,businessStore,buildJob,checkAccess,getExecutor,buildOfflineJob,onUpdate=()=>{},appVersion=''}){
    Object.assign(this,{store,businessStore,buildJob,checkAccess,getExecutor,buildOfflineJob,onUpdate,appVersion});
    this.active=new Map();
    store.update(data=>{
      data.sessions ||= [];
      for(const session of data.sessions)if(['opening','uploading','paused','reading','stopping','failed','invalid'].includes(session.status)){
        session.status='interrupted';session.message='程序已重启，原页面检查点失效；不会自动重跑。';
      }
    });
  }
  list(){return this.store.load().sessions.map(clone).reverse();}
  _write(id,patch,event){
    let result;
    this.store.update(data=>{
      const session=data.sessions.find(s=>s.id===id);if(!session)throw new Error('测试会话不存在。');
      Object.assign(session,patch,{updatedAt:new Date().toISOString()});
      if(event){session.events.push({at:session.updatedAt,...event});session.events=session.events.slice(-200);}
      result=clone(session);
    });
    try{this.onUpdate({type:'preparation_test',session:result});}catch{}
    return result;
  }
  assertAccountAvailable(job){
    if([...this.active.values()].some(s=>s.mode==='real_prepare' && sameAccount(s.job,job)))throw new Error('该账号的准备测试仍占用原页面；请先结束测试会话。');
  }
  hasActive(){return this.active.size>0;}
  review(draft){
    const job=this.buildJob(clone(draft),this.businessStore.load());
    if(job.platform!=='douyin')throw new Error('首版分步测试仅接入抖音，请只选择一个抖音账号。');
    this.checkAccess(job);this.assertAccountAvailable(job);assertPlanAvailable({jobs:[job]},this.businessStore.load());
    return {fingerprint:job.fingerprint,accountDisplay:job.accountDisplay,title:job.copy.title,platform:job.platform};
  }
  start(input={}){
    const {mode='offline',requestId,scenario='quick'}=input;
    if(!['offline','real_prepare'].includes(mode))throw new Error('测试入口只支持离线模拟或真实准备，不能提交。');
    if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestId || ''))throw new Error('测试请求凭据无效，请重新打开测试入口。');
    if(mode==='offline' && !SCENARIOS.includes(scenario))throw new Error('未提供这个离线场景。');
    const prior=this.store.load().sessions.find(s=>s.requestId===requestId);
    if(prior){
      if(prior.mode!==mode || (mode==='offline'?prior.scenario!==scenario:prior.fingerprint!==input.fingerprint))throw new Error('同一测试凭据不能用于不同任务或模式。');
      return clone(prior);
    }
    let job;
    if(mode==='real_prepare'){
      const review=this.review(input.draft);
      if(input.fingerprint!==review.fingerprint || input.authorization?.action!=='prepare_test' || input.authorization.fingerprint!==review.fingerprint)throw new Error('缺少针对本条账号和素材的准备测试确认。');
      job=this.buildJob(clone(input.draft),this.businessStore.load());
    }else job=this.buildOfflineJob(scenario);
    const id=randomUUID(),at=new Date().toISOString();
    const session={id,requestId,mode,scenario:mode==='offline'?scenario:null,appVersion:this.appVersion,fingerprint:job.fingerprint,
      platform:job.platform,accountId:job.accountId,accountDisplay:job.accountDisplay,title:job.copy.title,
      capabilities:{upload:true,readLocation:true,submit:false},status:'opening',message:mode==='offline'?'离线模拟：正在创建独立的本地测试页面。':'真实准备：正在核对账号，完成上传后暂停，不提交。',
      createdAt:at,updatedAt:at,events:[],checkpoint:null,location:null};
    // The in-process reservation is made synchronously, before any await.
    const handle={id,mode,job,controller:new AbortController(),executor:null,operation:null};this.active.set(id,handle);
    try{this.store.update(data=>data.sessions.push(session));}catch(error){this.active.delete(id);throw error;}
    handle.operation=Promise.resolve().then(()=>this._upload(handle));
    return clone(session);
  }
  async _upload(handle){
    const {id,job,mode,controller}=handle;
    try{
      if(controller.signal.aborted)return;
      const executor=await this.getExecutor({mode,job,scenario:this.store.load().sessions.find(s=>s.id===id).scenario});handle.executor=executor;
      if(executor.capabilities?.submit!==false || typeof executor.uploadVideo!=='function' || typeof executor.inspectUploadLocation!=='function')throw new Error('测试执行器未提供明确的无提交能力边界。');
      if(controller.signal.aborted){await executor.stop();return;}
      await executor.verify(job);if(controller.signal.aborted)return;
      this._write(id,{status:'uploading'}, {step:'verify',status:'passed',message:'账号与素材核对通过。'});
      const evidence=await executor.uploadVideo(job,{signal:controller.signal,onStep:step=>{
        if(!controller.signal.aborted)this._write(id,{message:step.message,progress:step.progress},{step:'upload',status:'running',message:step.message});
      }});
      if(controller.signal.aborted)return;
      this._write(id,{status:'paused',message:'上传完成，已暂停。可以只读核对定位；不会设置封面或发布。',checkpoint:{step:'video_uploaded',at:new Date().toISOString(),evidence},progress:100},
        {step:'upload',status:'passed',message:'本条视频上传完成，停在原页面。'});
    }catch(error){if(!controller.signal.aborted)this._write(id,{status:'failed',message:message(error)},{step:'upload',status:'failed',message:message(error)});}
  }
  async readLocation(id){
    const handle=this.active.get(id),session=this.store.load().sessions.find(s=>s.id===id);
    if(!handle || session?.status!=='paused')throw new Error('只有当前进程中已暂停的有效上传页面可以核对定位。');
    this._write(id,{status:'reading',message:'正在原页面只读核对定位；不点击、不清除、不填写。'});
    const operation=(async()=>{
      try{
        const result=await handle.executor.inspectUploadLocation(handle.job);
        if(handle.controller.signal.aborted)return;
        return this._write(id,{status:'paused',location:result,message:'只读定位核对通过；原页面保留，未提交。'}, {step:'read_location',status:'passed',message:'只读定位核对通过。'});
      }catch(error){
        if(handle.controller.signal.aborted)return;
        return this._write(id,{status:error.code==='CHECKPOINT_INVALID'?'invalid':'paused',location:{error:message(error)},message:message(error)}, {step:'read_location',status:'failed',message:message(error)});
      }
    })();handle.operation=operation;
    return operation;
  }
  async stop(id){
    const handle=this.active.get(id);if(!handle)return this.store.load().sessions.find(s=>s.id===id) || null;
    if(handle.stopping)return handle.stopping;
    handle.controller.abort();this._write(id,{status:'stopping',message:'正在停止测试并等待当前操作结束，不会发布。'});
    handle.stopping=(async()=>{
      try{
        await handle.executor?.stop();await handle.operation;
        await handle.executor?.dispose?.();
        this.active.delete(id);
        return this._write(id,{status:'stopped',message:'测试已结束。真实平台原草稿保留；不会重新上传或发布。'},{step:'stop',status:'passed',message:'测试会话已结束。'});
      }catch(error){return this._write(id,{status:'failed',message:'测试清理尚未结束：'+message(error)});}
      finally{handle.stopping=null;}
    })();return handle.stopping;
  }
  async shutdown(){await Promise.all([...this.active.keys()].map(id=>this.stop(id)));}
}
module.exports={PreparationTests,SCENARIOS};
