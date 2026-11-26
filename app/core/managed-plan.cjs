'use strict';
const {buildManagedPlan}=require('./managed-publish-job.cjs');
const {pendingOperation}=require('./submission-evidence.cjs');

function assertPlanAvailable(plan,state){
  const active=new Set(['queued','preparing','ready_to_submit','awaiting_confirmation','approved','submitting','verifying_result']);
  for(const job of plan.jobs){
    const same=(state.runs || []).filter(r=>r.mode==='managed_prepare' && r.platform===job.platform && (r.accountId===job.accountId || r.expectedBinding?.platformAccountId===job.expectedBinding.platformAccountId));
    if(same.some(r=>active.has(r.status) || pendingOperation(r)))throw new Error(`${job.accountDisplay}已有正在执行的任务，请查看发布记录。`);
    if(same.some(r=>['submitted','awaiting_verification'].includes(r.status) && (r.videoKey===job.videoKey || r.snapshot?.video?.id===job.files.video.id)))throw new Error(`${job.accountDisplay}已提交过或可能已提交这条视频，请取消勾选该平台；结果待核查时不能重发。`);
  }
}
function startManagedPlan({draft,fingerprint,requestId,executionMode,authorization,store,publisher,inspectFile,assertAvailable=()=>{}}){
  if(typeof requestId!=='string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId))throw new Error('本次发布凭据无效，请重新打开总览。');
  if(!['automatic','prepare_only'].includes(executionMode))throw new Error('请选择发布或仅准备。');
  const state=store.load(),plan=buildManagedPlan(draft,state,inspectFile);
  if(plan.fingerprint!==fingerprint)throw new Error('总览后内容或账号已改变，请重新核对。');
  if(executionMode==='automatic' && (authorization?.action!=='publish' || authorization.fingerprint!==fingerprint))throw new Error('缺少本次总览的明确发布确认。');
  for(const job of plan.jobs)if(executionMode==='automatic' && job.platform==='douyin' && !['public','self'].includes(job.settings.visibility))throw new Error('请在抖音特殊设置明确选择公开或仅自己可见。');
  const existing=state.runs.filter(r=>r.requestId?.startsWith(requestId+'_'));
  if(existing.length){
    if(existing.length!==plan.jobs.length || plan.jobs.some(job=>!existing.some(r=>r.requestId===requestId+'_'+job.platform && r.fingerprint===job.fingerprint && r.executionMode===executionMode)))throw new Error('同一发布凭据已经用于不同任务，不会再次执行。');
    return {runs:existing,batchId:requestId};
  }
  // Validate ALL targets before the first child can open a browser. Each
  // platform remains independently idempotent and keeps its own receipt.
  assertPlanAvailable(plan,state);
  for(const job of plan.jobs)assertAvailable(job);
  const runs=[];
  for(const job of plan.jobs){
    runs.push(publisher.start({draft:job.draft,requestId:requestId+'_'+job.platform,executionMode,
      authorization:executionMode==='automatic'?{action:'publish',fingerprint:job.fingerprint,visibility:job.settings.visibility}:null}));
  }
  return {runs,batchId:requestId};
}
module.exports={startManagedPlan,assertPlanAvailable};
