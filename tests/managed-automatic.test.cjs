'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagedPublisher } = require('../app/core/managed-publisher.cjs');
const { managedReceipt } = require('../app/core/managed-receipt.cjs');

const clone = value => structuredClone(value);
const checks = () => Object.fromEntries(['video','covers','text','declaration','collection','schedule','visibility','savePermission'].map(k => [k,true]));
const proof = () => ({status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789',visibility:'self',duration:'00:08',publishedAt:'2026年11月07日 12:00',verification:'creator_detail_and_list',message:'已核对本条平台记录'});
const gate = () => { let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release}; };
let sequence=0;
function fixture(options={}) {
  const data={runs:clone(options.runs || [])};
  const store={load:()=>clone(data),update:fn=>fn(data)};
  const calls={prepare:0,verify:0,submit:0,inspect:0,stop:0};
  let revision=1;
  const buildJob=draft=>({draft:clone(draft),fingerprint:'task-fingerprint',accountId:'account',platform:'douyin',teacherId:'teacher',
    expectedBinding:{revision,environmentId:'environment',platformAccountId:'real-test-account'},videoKey:'unchanged-video',settings:{visibility:'self'},summary:[{title:'合成任务',specialSettings:{visibility:'self'}}]});
  const executor={
    ...(options.instrumented?{capabilities:{submissionProtocol:1}}:{}),
    verify:async()=>{calls.verify++;if(options.verify)await options.verify(calls);},
    prepare:async(job,context)=>{calls.prepare++;if(options.prepare)await options.prepare({job,context,calls,changeBinding:()=>revision++});return {checks:options.checks || checks()};},
    submit:async(job,context)=>{calls.submit++;return options.submit?options.submit(calls,{job,context}):proof();},
    inspectResult:async job=>{calls.inspect++;return options.inspect?options.inspect(calls,job):proof();},
    stop:()=>{calls.stop++;}
  };
  const publisher=new ManagedPublisher({store,buildJob,getExecutor:async()=>executor,onUpdate:options.onUpdate,
    submitTimeoutMs:options.submitTimeoutMs || 1000,resultAttempts:2,resultDelayMs:0,resultTimeoutMs:options.resultTimeoutMs || 1000});
  const input=(mode='automatic')=>({draft:{video:{id:'video'},title:'合成任务'},requestId:`automatic_request_${++sequence}`,executionMode:mode,
    authorization:mode==='automatic'?{action:'publish',fingerprint:'task-fingerprint'}:null});
  return {publisher,store,data,calls,input};
}
async function until(publisher,id,status) {
  const deadline=Date.now()+2500;
  while(Date.now()<deadline){const run=publisher.run(id);if(run.status===status)return run;await new Promise(r=>setTimeout(r,5));}
  throw new Error(`未到达${status}，实际为${publisher.run(id).status}`);
}

test('一次总览授权后自动完成准备、再次核对和唯一提交，保存权限与平台证据',async()=>{
  const f=fixture(),input=f.input(),run=f.publisher.start(input);
  const done=await until(f.publisher,run.id,'submitted');
  assert.equal(f.calls.prepare,1);assert.equal(f.calls.verify,2);assert.equal(f.calls.submit,1);assert.equal(f.calls.inspect,0);
  assert.equal(done.authorization.fingerprint,done.fingerprint);assert.equal(done.authorization.source,'task_review');assert.ok(done.authorization.grantedAt);
  assert.equal(done.result.visibility,'self');assert.equal(done.result.duration,'00:08');assert.equal(done.result.publishedAt,proof().publishedAt);
  assert.equal(done.events.some(e=>e.status==='awaiting_confirmation'),false);
  assert.equal(done.events.filter(e=>e.status==='submitting').length,1);
  assert.equal(f.publisher.start(input).id,run.id);assert.equal(f.calls.submit,1);
});

test('没有本条指纹授权、授权动作为仅准备或未知执行方式时，不创建自动任务',()=>{
  for(const mutate of [i=>{delete i.authorization;},i=>{i.authorization.fingerprint='changed';},i=>{i.authorization.action='prepare';},i=>{i.executionMode='unexpected';}]){
    const f=fixture(),input=f.input();mutate(input);assert.throws(()=>f.publisher.start(input),/授权|执行方式/);assert.equal(f.data.runs.length,0);assert.equal(f.calls.prepare,0);
  }
});

test('只准备模式即使八项通过也不提交，不能调用批准接口把它升级为发布',async()=>{
  const f=fixture(),input=f.input('prepare_only'),run=f.publisher.start(input);
  const ready=await until(f.publisher,run.id,'prepared');
  assert.equal(f.calls.submit,0);assert.equal(ready.authorization,null);
  await assert.rejects(f.publisher.approve(run.id,run.fingerprint),/等待确认/);
  assert.throws(()=>f.publisher.start({...input,executionMode:'automatic',authorization:{action:'publish',fingerprint:run.fingerprint}}),/执行方式已固定/);
  assert.equal(f.calls.submit,0);
  const reopened=fixture({runs:f.data.runs});assert.equal(reopened.publisher.run(run.id).status,'prepared');assert.equal(reopened.calls.submit,0);
});

test('页面任一检查未通过时不因预先授权而提交',async()=>{
  const f=fixture({checks:{...checks(),covers:false}}),run=f.publisher.start(f.input());
  const failed=await until(f.publisher,run.id,'failed');assert.equal(f.calls.submit,0);assert.match(failed.message,/covers/);
});

test('准备完成后绑定变化或第二次身份核对失败均阻止自动提交',async()=>{
  for(const options of [
    {prepare:async({changeBinding})=>changeBinding()},
    {verify:async calls=>{if(calls.verify===2)throw new Error('实际账号已变化');}}
  ]){
    const f=fixture(options),run=f.publisher.start(f.input());await until(f.publisher,run.id,'failed');assert.equal(f.calls.submit,0);
  }
});

test('停止准备任务后，迟到的成功检查不能触发自动提交',async()=>{
  const pending=gate(),entered=gate();
  const f=fixture({prepare:async()=>{entered.release();await pending.promise;}}),run=f.publisher.start(f.input());
  await entered.promise;await f.publisher.stop(run.id);pending.release();await new Promise(r=>setTimeout(r,15));
  assert.equal(f.publisher.run(run.id).status,'canceled');assert.equal(f.calls.submit,0);
});

test('即将自动继续时收到停止操作，不能抢先提交',async()=>{
  let f;f=fixture({onUpdate:({run})=>{if(run.status==='ready_to_submit')void f.publisher.stop(run.id);}});
  const run=f.publisher.start(f.input());await until(f.publisher,run.id,'canceled');assert.equal(f.calls.submit,0);
});

test('提交结果延迟时自动只读回查，取得本条凭据后完成，始终只有一次提交',async()=>{
  const f=fixture({submit:async()=>({status:'awaiting_verification'}),inspect:async calls=>calls.inspect===1?{status:'awaiting_verification'}:proof()});
  const run=f.publisher.start(f.input()),done=await until(f.publisher,run.id,'submitted');
  assert.equal(f.calls.submit,1);assert.equal(f.calls.inspect,2);assert.equal(done.result.workId,proof().workId);
  assert.equal(done.events.some(e=>e.status==='verifying_result'),true);assert.equal(done.events.filter(e=>e.status==='submitting').length,1);
});

test('回查仍没有可靠凭据时保留待核查，不把成功提示当作发布记录，也不重发',async()=>{
  const readsDone=gate();
  const f=fixture({submit:async()=>({status:'submitted',message:'发布成功'}),inspect:async calls=>{if(calls.inspect===2)readsDone.release();return {status:'submitted',workId:'1234567890123456789',workUrl:'https://other.example/video/1234567890123456789'};}});
  const run=f.publisher.start(f.input());
  await readsDone.promise;
  const done=await until(f.publisher,run.id,'awaiting_verification');
  assert.equal(f.calls.submit,1);assert.equal(f.calls.inspect,2);assert.equal(done.result,null);
  assert.throws(()=>f.publisher.start(f.input()),/相同素材/);
});

test('提交超时后不并发操作原页面、不重试提交',async()=>{
  const pending=gate(),f=fixture({submit:()=>pending.promise,submitTimeoutMs:20}),run=f.publisher.start(f.input());
  await until(f.publisher,run.id,'awaiting_verification');assert.equal(f.calls.submit,1);assert.equal(f.calls.inspect,0);
  pending.release(proof());await new Promise(r=>setTimeout(r,15));assert.equal(f.publisher.run(run.id).status,'submitted');
});

test('只读核查超时后不重叠启动下一个查询',async()=>{
  const pending=gate(),f=fixture({submit:async()=>({status:'awaiting_verification'}),inspect:()=>pending.promise,resultTimeoutMs:20}),run=f.publisher.start(f.input());
  await until(f.publisher,run.id,'verifying_result');await until(f.publisher,run.id,'awaiting_verification');
  assert.equal(f.calls.submit,1);assert.equal(f.calls.inspect,1);pending.release(proof());await new Promise(r=>setTimeout(r,15));
  assert.equal(f.publisher.run(run.id).status,'submitted');
});

test('停止后仍保存迟到的可靠回执，保持唯一提交',async()=>{
  const pending=gate(),f=fixture({submit:async()=>({status:'awaiting_verification'}),inspect:()=>pending.promise}),run=f.publisher.start(f.input());
  await until(f.publisher,run.id,'verifying_result');await f.publisher.stop(run.id);pending.release(proof());await new Promise(r=>setTimeout(r,15));
  assert.equal(f.publisher.run(run.id).status,'submitted');assert.equal(f.calls.submit,1);assert.equal(f.calls.inspect,1);
});

test('重启不能从持久化的旧授权自动发出任务，提交过的状态继续待核查',()=>{
  for(const status of ['queued','preparing','ready_to_submit','approved','submitting','verifying_result']){
    const run={id:'old',mode:'managed_prepare',executionMode:'automatic',authorization:{action:'publish',fingerprint:'task-fingerprint'},fingerprint:'task-fingerprint',status,events:[]};
    const f=fixture({runs:[run]});assert.equal(f.calls.submit,0);
    assert.equal(f.publisher.run('old').status,['approved','submitting','verifying_result'].includes(status)?'awaiting_verification':'failed');
  }
});

test('自动提交回执必须同时匹配平台编号、HTTPS作品地址与要求的私密权限',()=>{
  for(const changes of [
    {workUrl:'http://www.douyin.com/video/1234567890123456789'},
    {workUrl:'https://other.example/video/1234567890123456789'},
    {workUrl:'https://www.douyin.com/video/9999999999999999999'},
    {workUrl:'https://name:password@www.douyin.com/video/1234567890123456789'},
    {visibility:'unverified'},{visibility:'public'},{workId:'not-a-platform-id'}
  ])assert.equal(managedReceipt({...proof(),...changes},{visibility:'self'}),null);
  const result=managedReceipt({...proof(),cookie:'must-not-persist',sourceUrl:'https://creator.douyin.com/creator-micro/content/post/video?mid=1234567890123456789&sign_token=must-not-persist'},{visibility:'self'});
  assert.equal(result.cookie,undefined);assert.doesNotMatch(result.sourceUrl,/sign_token/);assert.equal(result.visibility,'self');
});

test('导出报告保留本次授权、自动执行方式与平台回执，不带浏览器诊断或会话字段',async()=>{
  const f=fixture(),run=f.publisher.start(f.input());const done=await until(f.publisher,run.id,'submitted');
  done.result.cookie='不应导出';done.result.pageHtml='不应导出';done.authorization.unrelated='不应导出';
  const report=require('../app/core/domain.cjs').exportReport(done);
  assert.equal(report.executionMode,'automatic');assert.equal(report.authorization.fingerprint,run.fingerprint);
  assert.equal(report.result.visibility,'self');assert.equal(report.result.workId,proof().workId);
  assert.equal(report.result.cookie,undefined);assert.equal(report.result.pageHtml,undefined);assert.equal(report.authorization.unrelated,undefined);
});

test('新执行器预检失败没有发布动作记录，允许重新建立任务',async()=>{
 const f=fixture({instrumented:true,submit:async()=>{throw new Error('发布按钮尚未可用');}}),run=f.publisher.start(f.input());
 const done=await until(f.publisher,run.id,'failed');assert.equal(done.submission.phase,'not_dispatched');assert.equal(done.submission.actions.length,0);
 assert.doesNotThrow(()=>f.publisher.start(f.input()));
});

test('动作记录必须先写成功才允许点击；写失败保留零点击',async()=>{
 let clicks=0;const f=fixture({instrumented:true,submit:async(_,{context})=>{await context.beforeDispatch('publish');clicks++;return proof();}});
 const original=f.store.update;f.store.update=fn=>original(data=>{const copy=clone(data);fn(copy);if(copy.runs.some(r=>r.submission?.actions?.length))throw new Error('模拟磁盘写入失败');Object.assign(data,copy);});
 const run=f.publisher.start(f.input());await until(f.publisher,run.id,'failed');assert.equal(clicks,0);assert.equal(f.publisher.run(run.id).submission.actions.length,0);
});

test('提交前超时撤销许可，晚到操作不得点击，结束前仍占用账号',async()=>{
 const entered=gate(),pending=gate();let clicks=0;
 const f=fixture({instrumented:true,submitTimeoutMs:20,submit:async(_,{context})=>{entered.release();await pending.promise;await context.beforeDispatch('publish');clicks++;return proof();}}),run=f.publisher.start(f.input());
 await entered.promise;await until(f.publisher,run.id,'failed');assert.equal(f.publisher.hasPendingOperations(),true);assert.throws(()=>f.publisher.start(f.input()),/账号已有|仍有/);
 pending.release();await new Promise(r=>setTimeout(r,15));assert.equal(clicks,0);assert.equal(f.publisher.hasPendingOperations(),false);assert.equal(f.publisher.run(run.id).submission.actions.length,0);
});

test('提交前停止撤销许可；已开始调用时停止仍保存严格回执',async()=>{
 for(const dispatched of [false,true]){
  const entered=gate(),pending=gate();let clicks=0;
  const f=fixture({instrumented:true,submit:async(_,{context})=>{
   if(dispatched){await context.beforeDispatch('publish');clicks++;await context.afterDispatch('publish');}
   entered.release();await pending.promise;
   if(!dispatched){await context.beforeDispatch('publish');clicks++;}return proof();
  }}),run=f.publisher.start(f.input());
  await entered.promise;await f.publisher.stop(run.id);pending.release();await new Promise(r=>setTimeout(r,15));
  assert.equal(clicks,dispatched?1:0);assert.equal(f.publisher.run(run.id).status,dispatched?'submitted':'canceled');
 }
});

test('同一次尝试主发布和二次确认各调用一次，重复或停止后调用被拒绝',async()=>{
 for(const stopAfterPrimary of [false,true]){
  let f,run;const ready=gate();let clicks=0;
  f=fixture({instrumented:true,submit:async(_,{context})=>{
   await ready.promise;await context.beforeDispatch('publish');clicks++;await context.afterDispatch('publish');
   await assert.rejects(async()=>context.beforeDispatch('publish'),/禁止重复/);
   if(stopAfterPrimary)await f.publisher.stop(run.id);
   if(stopAfterPrimary)await assert.rejects(async()=>context.beforeDispatch('confirmation'),/许可已失效/);
   else{await context.beforeDispatch('confirmation');clicks++;await context.afterDispatch('confirmation');await assert.rejects(async()=>context.beforeDispatch('confirmation'),/禁止重复/);}
   return proof();
  }});run=f.publisher.start(f.input());ready.release();const done=await until(f.publisher,run.id,'submitted');
  assert.equal(clicks,stopAfterPrimary?1:2);assert.equal(done.submission.actions.length,clicks);assert.ok(done.submission.attemptId);
 }
});

test('候选编号保存但不等于成功，后续只读查询固定编号并拒绝冲突结果',async()=>{
 const pending=gate();let jobSeen;
 const f=fixture({instrumented:true,submit:async(_,{context})=>{await context.beforeDispatch('publish');await context.afterDispatch('publish');return {...proof(),visibility:'unverified',cookie:'forbidden',pageHtml:'forbidden'};},inspect:async(_,job)=>{jobSeen=job;await pending.promise;return {...proof(),workId:'9999999999999999999',workUrl:'https://www.douyin.com/video/9999999999999999999'};}}),run=f.publisher.start(f.input());
 await until(f.publisher,run.id,'verifying_result');let current=f.publisher.run(run.id);
 assert.equal(current.result,null);assert.equal(current.candidateResult.workId,proof().workId);assert.equal(current.candidateResult.cookie,undefined);
 await new Promise(r=>setTimeout(r,5));assert.equal(jobSeen.expectedWorkId,proof().workId);assert.equal(jobSeen.requireListEvidence,true);
 pending.release();const done=await until(f.publisher,run.id,'awaiting_verification');assert.equal(done.result,null);assert.equal(done.candidateResult.workId,proof().workId);assert.equal(done.candidateConflicts[0].workId,'9999999999999999999');assert.equal(f.calls.submit,1);
});

test('新协议确认模式也必须核实作品链接及可见范围，不能沿用旧兼容回执',async()=>{
 const f=fixture({instrumented:true,submit:async(_,{context})=>{await context.beforeDispatch('publish');await context.afterDispatch('publish');return {...proof(),visibility:'unverified'};}}),run=f.publisher.start(f.input('confirm_before_submit'));
 await until(f.publisher,run.id,'awaiting_confirmation');await f.publisher.approve(run.id,run.fingerprint);assert.equal(f.publisher.run(run.id).status,'awaiting_verification');assert.equal(f.publisher.run(run.id).result,null);
});

test('重启按已持久化动作区分未调用与结果未知，并解除中断操作占用，不重跑',()=>{
 for(const actions of [[],[{name:'publish',startedAt:'2026-11-17T00:00:00Z'}]]){
  const f=fixture({runs:[{id:'old',mode:'managed_prepare',status:'approved',events:[],submission:{version:1,actions,operationPending:true},inspection:{pending:true}}]});
  const current=f.publisher.run('old');assert.equal(current.status,actions.length?'awaiting_verification':'failed');assert.equal(current.submission.operationPending,false);assert.equal(current.inspection.pending,false);assert.ok(current.inspection.interruptedAt);assert.equal(f.calls.submit,0);
 }
});

test('退出宽限期保存已开始操作的迟到可靠回执，仍保持唯一调用',async()=>{
 const pending=gate(),entered=gate();
 const f=fixture({instrumented:true,submit:async(_,{context})=>{await context.beforeDispatch('publish');await context.afterDispatch('publish');entered.release();return pending.promise;}}),run=f.publisher.start(f.input());
 await entered.promise;const closing=f.publisher.shutdown({graceMs:200});pending.release(proof());await closing;
 assert.equal(f.publisher.run(run.id).status,'submitted');assert.equal(f.publisher.hasPendingOperations(),false);assert.equal(f.calls.submit,1);
});

test('超时后的错误地址或未核实私密权限回执仍待核查，不会被迟到规则放行',async()=>{
 for(const changes of [{workUrl:'https://other.example/video/1234567890123456789'},{visibility:'unverified'}]){
  const pending=gate(),f=fixture({submitTimeoutMs:20,submit:()=>pending.promise}),run=f.publisher.start(f.input());
  await until(f.publisher,run.id,'awaiting_verification');pending.release({...proof(),...changes});await new Promise(r=>setTimeout(r,15));
  assert.equal(f.publisher.run(run.id).status,'awaiting_verification');assert.equal(f.publisher.run(run.id).result,null);assert.equal(f.calls.inspect,0);
 }
});

test('退出等待有上限，未返回操作保留未知及账号占用',async()=>{
 const pending=gate(),entered=gate();
 const f=fixture({instrumented:true,submit:async(_,{context})=>{await context.beforeDispatch('publish');entered.release();return pending.promise;}}),run=f.publisher.start(f.input());
 await entered.promise;await f.publisher.shutdown({graceMs:10});const current=f.publisher.run(run.id);
 assert.equal(current.status,'awaiting_verification');assert.equal(current.submission.operationPending,true);assert.equal(f.publisher.hasPendingOperations(),true);
 assert.throws(()=>f.publisher.assertAccountAvailable({platform:'douyin',accountId:'alias',expectedBinding:{platformAccountId:'real-test-account'}}),/仍有执行/);
 pending.release(proof());await new Promise(r=>setTimeout(r,15));assert.equal(f.publisher.run(run.id).status,'submitted');
});
