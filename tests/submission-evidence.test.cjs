'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {candidateReceipt,mergeResultEvidence}=require('../app/core/submission-evidence.cjs');
const {exportReport}=require('../app/core/domain.cjs');
const raw={status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789?token=secret',visibility:'unverified',cookie:'secret',pageHtml:'secret'};
test('候选仅保留匹配编号的官方HTTPS地址及受控字段，签名和会话不落记录',()=>{
 const candidate=candidateReceipt(raw);assert.equal(candidate.workUrl,'https://www.douyin.com/video/1234567890123456789');assert.equal(candidate.cookie,undefined);assert.equal(candidate.pageHtml,undefined);
 for(const changes of [{workId:'other'},{workUrl:'https://wrong.example/video/1234567890123456789'},{workUrl:'http://www.douyin.com/video/1234567890123456789'}])assert.equal(candidateReceipt({...raw,...changes}),null);
 const run={platform:'douyin'};assert.equal(mergeResultEvidence(run,raw,{visibility:'self'},'submit').receipt,null);assert.equal(run.candidateResult.workId,raw.workId);
});
test('导出提交时间与候选依据，额外会话字段不导出，候选不填入成功结果',()=>{
 const run={id:'r',mode:'managed_prepare',status:'awaiting_verification',snapshot:{},events:[],submission:{version:1,attemptId:'unique-attempt',operationPending:true,cookie:'secret',actions:[{name:'publish',startedAt:'2026-11-17T01:00:00Z',pageHtml:'secret'}]},inspection:{id:'q',pending:true,token:'secret'},result:null};
 mergeResultEvidence(run,raw,{visibility:'self'},'submit');run.candidateResult.cookie='secret';
 const report=exportReport(run);assert.equal(report.submission.actions.length,1);assert.equal(report.candidateResult.workId,raw.workId);assert.equal(report.result,null);assert.equal(report.workId,'');assert.equal(report.inspection.pending,true);assert.doesNotMatch(JSON.stringify(report),/secret|cookie|pageHtml|token/);
});
