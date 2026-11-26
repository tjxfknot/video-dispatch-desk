'use strict';
const {managedReceipt,workReference}=require('./managed-receipt.cjs');

// A candidate is a lookup anchor, never a successful business result.
function candidateReceipt(raw,platform='douyin'){
  if(!raw || typeof raw.workId!=='string')return null;
  const ref=workReference(raw.workUrl,platform);if(!ref || ref.workId!==raw.workId)return null;
  const candidate={platform,...ref};
  for(const key of ['visibility','visibilityVerification','verification','platformStatus','publishedAt','duration']){
    if(typeof raw[key]==='string')candidate[key]=Array.from(raw[key]).slice(0,100).join('');
  }
  return candidate;
}
function expectedWorkId(run){return run.result?.workId || run.candidateResult?.workId;}
function mergeResultEvidence(run,raw,settings,source){
  const candidate=candidateReceipt(raw,run.platform || 'douyin'),anchor=expectedWorkId(run),at=new Date().toISOString();
  if(candidate && anchor && candidate.workId!==anchor){
    run.candidateConflicts ||= [];
    if(!run.candidateConflicts.some(c=>c.workId===candidate.workId))run.candidateConflicts.push({...candidate,observedAt:at,source});
    run.candidateConflicts=run.candidateConflicts.slice(-5);
    return {receipt:null,candidate:null,conflict:true};
  }
  if(candidate)run.candidateResult={...candidate,firstObservedAt:run.candidateResult?.firstObservedAt || at,lastObservedAt:at,source};
  const receipt=managedReceipt(raw,settings,run.platform || 'douyin');
  return {candidate,receipt:receipt && (!anchor || receipt.workId===anchor)?receipt:null,conflict:false};
}
function dispatched(run){return run.submission?.version===1 && !!run.submission.actions?.length;}
function pendingOperation(run){return !!(run.submission?.operationPending || run.inspection?.pending);}
module.exports={candidateReceipt,expectedWorkId,mergeResultEvidence,dispatched,pendingOperation};
