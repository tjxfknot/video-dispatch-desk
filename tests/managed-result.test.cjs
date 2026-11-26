'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inspectManagedResult}=require('../app/core/managed-result.cjs');
function fixture(){const run={id:'run',mode:'managed_prepare',status:'awaiting_verification',fingerprint:'fp',teacherId:'t',accountId:'a',expectedBinding:{platformAccountId:'real'},summary:[{title:'真实测试'}],events:[],items:[{status:'awaiting_verification'}]};const state={runs:[run]};return {run,store:{load:()=>structuredClone(state),update:fn=>fn(state)}};}
test('只读核查不上传、不调用提交，有同一作品ID和链接才补记结果',async()=>{
 const f=fixture();let reads=0;
 const result=await inspectManagedResult({...f,id:'run',getReader:async()=>({prepare(){throw new Error('不得上传');},submit(){throw new Error('不得重发');},inspectResult:async job=>{reads++;assert.equal(job.copy.title,'真实测试');return {status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789',message:'找到本条作品'};}})});
 assert.equal(reads,1);assert.equal(result.status,'submitted');assert.equal(result.items[0].status,'submitted');assert.equal(result.events.length,1);
});
test('没有凭据或错误站点不能把未知结果标为已提交，读取失败仍禁止重发',async()=>{
 for(const evidence of [{status:'awaiting_verification'},{status:'submitted',workId:'12345678901',workUrl:'https://other.example/video/12345678901'}]){
  const f=fixture();await inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async()=>evidence})});assert.equal(f.run.status,'awaiting_verification');
 }
 const f=fixture();await assert.rejects(inspectManagedResult({...f,id:'run',getReader:async()=>{throw new Error('读取失败');}}),/读取失败/);assert.equal(f.run.status,'awaiting_verification');
 f.run.status='preparing';await assert.rejects(inspectManagedResult({...f,id:'run',getReader:async()=>{throw new Error('不应打开浏览器');}}),/只有已尝试提交/);
});

test('只读复查传入既有作品编号，不允许换成另一个同名作品或忽略私密要求',async()=>{
 const f=fixture();f.run.createdAt='2026-11-07T03:30:00Z';f.run.result={workId:'1234567890123456789'};f.run.status='submitted';
 f.run.summary[0].specialSettings={visibility:'self'};
 await inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async job=>{
   assert.equal(job.expectedWorkId,'1234567890123456789');assert.equal(job.runCreatedAt,f.run.createdAt);
   return {status:'submitted',workId:'9999999999999999999',workUrl:'https://www.douyin.com/video/9999999999999999999',visibility:'self'};
 }})});
 assert.equal(f.run.result.workId,'1234567890123456789');
 f.run.status='awaiting_verification';f.run.result=null;
 await inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async()=>({status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789',visibility:'unverified'})})});
 assert.equal(f.run.status,'awaiting_verification');assert.equal(f.run.result,null);
});

test('候选编号跨查询保留，核查固定该编号；冲突不覆盖，合法回执才完成',async()=>{
 const f=fixture(),raw={status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789',visibility:'unverified',cookie:'forbidden'};f.run.summary[0].specialSettings={visibility:'self'};f.run.result=null;
 await inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async()=>raw})});assert.equal(f.run.result,null);assert.equal(f.run.candidateResult.cookie,undefined);
 await inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async job=>{assert.equal(job.expectedWorkId,raw.workId);assert.equal(job.requireListEvidence,true);return {...raw,workId:'9999999999999999999',workUrl:'https://www.douyin.com/video/9999999999999999999',visibility:'self'};}})});
 assert.equal(f.run.result,null);assert.equal(f.run.candidateResult.workId,raw.workId);assert.equal(f.run.candidateConflicts.length,1);
 await inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async()=>({...raw,visibility:'self'})})});assert.equal(f.run.status,'submitted');assert.equal(f.run.result.workId,raw.workId);
});

test('只读操作未返回时拒绝并发查询，失败后解除占用；指纹变化不得采用结果',async()=>{
 const f=fixture();let release;const pending=new Promise(r=>{release=r;});let reads=0;
 const call=inspectManagedResult({...f,id:'run',getReader:async()=>({inspectResult:async()=>{reads++;return pending;}})});
 await assert.rejects(inspectManagedResult({...f,id:'run',getReader:()=>{throw new Error('不能再开页面');}}),/尚未返回/);
 f.run.fingerprint='changed';release({status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789'});
 await assert.rejects(call,/记录已改变/);assert.equal(f.run.status,'awaiting_verification');assert.equal(f.run.inspection.pending,false);assert.equal(reads,1);
});
