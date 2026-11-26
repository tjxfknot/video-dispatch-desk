'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PreparationTests}=require('../app/core/preparation-tests.cjs');
const {ManagedPublisher}=require('../app/core/managed-publisher.cjs');
const clone=structuredClone;
const memory=initial=>{let data=clone(initial);return {load:()=>clone(data),update:fn=>{const next=clone(data);fn(next);data=next;}};};
const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
function fixture(options={}){
  const businessStore=memory({runs:options.runs || [],drafts:[{id:'business-draft',title:'业务资料不动'}]}),store=memory(options.persisted || {sessions:[]});
  const draft={video:{id:'video-1'},title:'测试'},job={draft,platform:'douyin',accountId:'account',teacherId:'teacher',expectedBinding:{revision:'r1',environmentId:'environment',platformAccountId:'stable-account'},fingerprint:'pinned',videoKey:'video-key',files:{video:{id:'video-1'}},copy:{title:'测试'},accountDisplay:'合成测试账号',settings:{visibility:'self'},summary:[]};
  const calls={verify:0,upload:0,read:0,stop:0,dispose:0,get:0,submit:0};
  const executor={capabilities:{submit:options.unsafe===true},verify:async()=>{calls.verify++;},uploadVideo:async(j,c)=>{calls.upload++;if(options.upload)await options.upload(c);return {complete:true};},inspectUploadLocation:async()=>{calls.read++;return options.read?options.read():{mode:'none',value:''};},stop:async()=>{calls.stop++;},dispose:async()=>{calls.dispose++;},submit:async()=>{calls.submit++;throw new Error('测试不能来到这里');}};
  const service=new PreparationTests({store,businessStore,appVersion:'test',buildJob:()=>clone(job),checkAccess:options.checkAccess || (()=>{}),
    buildOfflineJob:()=>clone({...job,accountId:'offline'}),getExecutor:async()=>{calls.get++;if(options.get)await options.get();return executor;}});
  const input=(mode='real_prepare',requestId='preparation_request_1234')=>({mode,draft,requestId,fingerprint:'pinned',authorization:{action:'prepare_test',fingerprint:'pinned'}});
  return {service,store,businessStore,job,draft,calls,input,executor};
}
async function until(f,id,status){const end=Date.now()+1500;while(Date.now()<end){const s=f.service.list().find(x=>x.id===id);if(s?.status===status)return s;await new Promise(r=>setTimeout(r,5));}throw new Error('未到达'+status);}

test('离线入口默认隔离，禁止将模式或授权改成发布',async()=>{
  const f=fixture(),before=f.businessStore.load();
  for(const mode of ['automatic','publish','prepare_only'])assert.throws(()=>f.service.start({...f.input(),mode}),/不能提交/);
  const session=f.service.start({requestId:'offline_default_request'});await until(f,session.id,'paused');
  assert.equal(session.mode,'offline');assert.equal(session.capabilities.submit,false);assert.deepEqual(f.businessStore.load(),before);assert.equal(f.calls.submit,0);await f.service.shutdown();
});
test('真实准备必须有当前指纹与准备动作的明确确认，账号范围由服务端校验',()=>{
  const f=fixture();for(const patch of [{authorization:null},{fingerprint:'changed'},{authorization:{action:'publish',fingerprint:'pinned'}}])assert.throws(()=>f.service.start({...f.input(),...patch}),/确认/);
  const denied=fixture({checkAccess:()=>{throw new Error('不在测试账号范围');}});assert.throws(()=>denied.service.start(denied.input()),/账号范围/);assert.equal(denied.calls.get,0);assert.equal(denied.service.list().length,0);
});
test('上传一次后暂停，反复读取定位不重新上传，也不创建正式发布记录',async()=>{
  const f=fixture(),before=f.businessStore.load(),run=f.service.start(f.input());await until(f,run.id,'paused');
  await f.service.readLocation(run.id);await f.service.readLocation(run.id);
  assert.equal(f.calls.upload,1);assert.equal(f.calls.read,2);assert.equal(f.calls.submit,0);assert.deepEqual(f.businessStore.load(),before);await f.service.stop(run.id);
});
test('重复请求幂等，不能用同一凭据升级模式或改变指纹',async()=>{
  const f=fixture(),input=f.input(),run=f.service.start(input);
  assert.equal(f.service.start(input).id,run.id);assert.throws(()=>f.service.start({...input,mode:'offline'}),/不同任务或模式/);assert.throws(()=>f.service.start({...input,fingerprint:'changed'}),/不同任务或模式/);
  await until(f,run.id,'paused');assert.equal(f.calls.upload,1);await f.service.shutdown();
});
test('测试占用会阻止正式执行器入口，结束后才释放',async()=>{
  const f=fixture(),run=f.service.start(f.input());await until(f,run.id,'paused');
  const publisher=new ManagedPublisher({store:f.businessStore,buildJob:()=>clone(f.job),getExecutor:async()=>f.executor,assertAvailable:job=>f.service.assertAccountAvailable(job)});
  assert.throws(()=>publisher.start({draft:f.draft,requestId:'normal_publish_request_123',executionMode:'prepare_only'}),/测试仍占用/);
  assert.equal(f.businessStore.load().runs.length,0);await f.service.stop(run.id);assert.doesNotThrow(()=>f.service.assertAccountAvailable(f.job));
});
test('已有正式活动任务和同素材未知提交均阻止真实测试，离线场景仍可执行',async()=>{
  for(const status of ['preparing','submitting','awaiting_verification','submitted']){
    const f=fixture({runs:[{mode:'managed_prepare',platform:'douyin',accountId:'account',status,videoKey:'video-key'}]});
    assert.throws(()=>f.service.start(f.input()),/已有|可能已提交/);assert.equal(f.calls.get,0);
    const offline=f.service.start(f.input('offline'));await until(f,offline.id,'paused');await f.service.shutdown();
  }
});
test('执行器创建中停止，迟到执行器不上传，清理完成前不释放账号',async()=>{
  const pending=gate(),f=fixture({get:()=>pending.promise}),run=f.service.start(f.input());
  await new Promise(r=>setImmediate(r));const stopping=f.service.stop(run.id);
  assert.throws(()=>f.service.assertAccountAvailable(f.job),/测试仍占用/);pending.release();await stopping;
  assert.equal(f.calls.upload,0);assert.equal(f.calls.dispose,1);assert.equal(f.service.list()[0].status,'stopped');assert.doesNotThrow(()=>f.service.assertAccountAvailable(f.job));
});
test('上传中停止，迟到的完成不会生成可用检查点',async()=>{
  const pending=gate(),f=fixture({upload:()=>pending.promise}),run=f.service.start(f.input());await until(f,run.id,'uploading');
  const stopping=f.service.stop(run.id);pending.release();await stopping;
  assert.equal(f.service.list()[0].status,'stopped');assert.equal(f.service.list()[0].checkpoint,null);await assert.rejects(()=>f.service.readLocation(run.id),/有效上传页面/);assert.equal(f.calls.submit,0);
});
test('定位读取中禁止并发读取，停止后的迟到结果不会复活会话',async()=>{
  const pending=gate(),f=fixture({read:()=>pending.promise}),run=f.service.start(f.input());await until(f,run.id,'paused');
  const reading=f.service.readLocation(run.id);await assert.rejects(()=>f.service.readLocation(run.id),/有效上传页面/);
  const stopping=f.service.stop(run.id);pending.release({mode:'none',value:''});await reading;await stopping;
  assert.equal(f.service.list()[0].status,'stopped');assert.equal(f.service.list()[0].location,null);
});
test('定位不符保留现场，检查点失效则不允许继续读取',async()=>{
  for(const invalid of [false,true]){
    const f=fixture({read:()=>{throw Object.assign(new Error(invalid?'页面已刷新':'旧地点仍存在'),invalid?{code:'CHECKPOINT_INVALID'}:{});}}),run=f.service.start(f.input());await until(f,run.id,'paused');
    await f.service.readLocation(run.id);assert.equal(f.service.list()[0].status,invalid?'invalid':'paused');assert.equal(f.calls.upload,1);assert.equal(f.calls.submit,0);await f.service.shutdown();
  }
});
test('重启后旧暂停记录只展示，不自动创建执行器或沿用检查点',async()=>{
  const f=fixture({persisted:{sessions:[{id:'old',status:'paused',events:[],requestId:'old_request',mode:'real_prepare'}]}});
  assert.equal(f.service.list()[0].status,'interrupted');assert.equal(f.calls.get,0);await assert.rejects(()=>f.service.readLocation('old'),/有效上传页面/);
});
test('未提供明确无提交能力的执行器会被拒绝，上传零次',async()=>{
  const f=fixture({unsafe:true}),run=f.service.start(f.input());await until(f,run.id,'failed');assert.equal(f.calls.upload,0);assert.equal(f.calls.submit,0);await f.service.shutdown();
});
