'use strict';
const {randomUUID}=require('node:crypto');
const {expectedWorkId,mergeResultEvidence,pendingOperation}=require('./submission-evidence.cjs');

async function inspectManagedResult({id,store,getReader,onUpdate=()=>{},checkAccess=()=>{},trackOperation=(_id,operation)=>operation}){
  const run=store.load().runs.find(r=>r.id===id);
  if(run?.mode!=='managed_prepare' || !['awaiting_verification','submitted'].includes(run.status))throw new Error('只有已尝试提交的真实任务可以只读核查；不会创建发布任务。');
  if(pendingOperation(run))throw new Error('原提交或核查操作尚未返回，不能并发打开另一个查询；不会重发。');
  const job={platform:run.platform || 'douyin',teacherId:run.teacherId,accountId:run.accountId,expectedBinding:run.expectedBinding,fingerprint:run.fingerprint,
    copy:{title:run.summary?.[0]?.title},settings:run.summary?.[0]?.specialSettings || {},schedule:run.snapshot?.schedule,runCreatedAt:run.createdAt,expectedWorkId:expectedWorkId(run),requireListEvidence:!!run.candidateResult && !run.result};
  if(!job.copy.title || !job.expectedBinding?.platformAccountId)throw new Error('原任务缺少核查依据，不能猜测作品。');
  checkAccess(job);
  const inspectionId=randomUUID(),notify=updated=>{try{onUpdate({type:'run',run:updated});}catch{}};
  store.update(state=>{
    const current=state.runs.find(r=>r.id===id);
    if(!current || current.fingerprint!==run.fingerprint || pendingOperation(current))throw new Error('原任务已变化或另一个核查仍在进行。');
    current.inspection={id:inspectionId,pending:true,source:'manual_query',startedAt:new Date().toISOString()};
  });
  const operation=(async()=>{
    try{
      const reader=await getReader(job);
      if(typeof reader.inspectResult!=='function')throw new Error('此平台还没有接入只读结果核查。');
      const result=await reader.inspectResult(job);let updated;
      store.update(state=>{
        const current=state.runs.find(r=>r.id===id);
        if(!current || current.fingerprint!==run.fingerprint || current.inspection?.id!==inspectionId || !['awaiting_verification','submitted'].includes(current.status))throw new Error('核查期间任务记录已改变。');
        const evidence=mergeResultEvidence(current,result,job.settings,'manual_query'),receipt=evidence.receipt,now=new Date().toISOString();
        current.inspection.pending=false;current.inspection.finishedAt=now;
        if(receipt){
          current.status='submitted';current.result=receipt;current.workId=receipt.workId;current.workUrl=receipt.workUrl;
          for(const item of [current.item,...(current.items || [])].filter(Boolean)){item.status='submitted';item.message=receipt.message || '已核对本条平台作品记录';item.progress=100;}
        }
        current.message=receipt?(receipt.message || '已核对本条平台作品记录'):current.status==='submitted'?current.message:evidence.conflict?'核查读到另一作品编号，与原任务依据冲突；保留原编号，不会重发。':'只读核查尚未取得本条完整作品凭据；候选编号已保留，未视为成功，不会重发。';
        current.updatedAt=now;current.events ||= [];current.events.push({time:now,status:current.status,message:current.message});current.events=current.events.slice(-200);updated=structuredClone(current);
      });notify(updated);return updated;
    }catch(error){
      let updated;
      store.update(state=>{
        const current=state.runs.find(r=>r.id===id);if(current?.inspection?.id!==inspectionId)return;
        current.inspection.pending=false;current.inspection.finishedAt=new Date().toISOString();current.inspection.error=String(error.message).split('\n')[0].slice(0,300);
        updated=structuredClone(current);
      });if(updated)notify(updated);throw error;
    }
  })();
  return trackOperation(id,operation);
}
module.exports={inspectManagedResult};
