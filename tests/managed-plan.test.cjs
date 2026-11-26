'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildManagedPlan}=require('../app/core/managed-publish-job.cjs');
const {startManagedPlan}=require('../app/core/managed-plan.cjs');
const {managedReceipt,workReference}=require('../app/core/managed-receipt.cjs');
function fixture(){
 const platforms=['douyin','tencent','xiaohongshu'];
 const video={id:'video',kind:'video',path:'/synthetic/video.mp4',name:'测试视频.mp4',size:10,mtimeMs:1};
 const state={schemaVersion:1,teachers:[{id:'t',name:'原老师'}],assets:[video],drafts:[],templates:[],runs:[],accounts:platforms.map(p=>({id:p,platform:p,teacherId:'t',status:'bound',label:p+'账号',browserEnvironmentId:p,binding:{revision:'r',source:'managed_browser',environmentId:p,platformAccountId:'owner_'+p}})),environments:platforms.map(p=>({id:p,platform:p,teacherId:'t',source:'managed_browser'}))};
 const draft={teacherId:'t',video,common:{title:'多平台功能验证',description:'同一视频的原始描述',tags:['原话题']},targets:platforms.map(p=>({platform:p,enabled:true,accountId:p,...(p==='douyin'?{specialSettings:{visibility:'public'}}:{})}))};
 const calls=[],inspectFile=()=>({isFile:()=>true,size:10,mtimeMs:1});
 const store={load:()=>structuredClone(state)},publisher={start(input){calls.push(input);return {id:'run-'+calls.length,platform:input.draft.targets.find(t=>t.enabled).platform};}};
 const plan=()=>buildManagedPlan(draft,state,inspectFile);
 const input=()=>({draft,fingerprint:plan().fingerprint,requestId:'multi_request_000001',executionMode:'automatic',authorization:{action:'publish',fingerprint:plan().fingerprint},store,publisher,inspectFile});
 return {state,draft,calls,plan,input,inspectFile};
}
test('三平台总览保留逐平台账号、指纹与内容，未保存任务重复核对稳定',()=>{
 const f=fixture(),first=f.plan(),second=f.plan();assert.equal(first.jobs.length,3);assert.equal(first.fingerprint,second.fingerprint);
 assert.equal(new Set(first.jobs.map(j=>j.fingerprint)).size,3);
 for(const job of first.jobs){assert.equal(job.draft.targets.filter(t=>t.enabled).length,1);assert.equal(job.expectedBinding.environmentId,job.platform);assert.equal(job.teacherLabel,'原老师');assert.deepEqual(job.copy.tags,['原话题']);}
 f.draft.targets.find(t=>t.platform==='xiaohongshu').inherit=false;f.draft.targets.find(t=>t.platform==='xiaohongshu').title='独立内容';
 assert.notEqual(f.plan().fingerprint,first.fingerprint);
});
test('一次总览明确授权后，各平台只创建各自的独立任务',()=>{
 const f=fixture(),result=startManagedPlan(f.input());assert.equal(result.runs.length,3);assert.equal(f.calls.length,3);
 const jobs=f.plan().jobs;
 for(const [i,call] of f.calls.entries()){assert.equal(call.authorization.fingerprint,jobs[i].fingerprint);assert.ok(call.requestId.endsWith('_'+jobs[i].platform));}
});
test('任一目标未绑定或存在可能已发布的同素材记录，所有目标都在开始前阻止',()=>{
 const f=fixture(),j=f.plan().jobs[0];
 f.state.runs.push({id:'prior',mode:'managed_prepare',status:'awaiting_verification',platform:j.platform,accountId:j.accountId,expectedBinding:j.expectedBinding,videoKey:j.videoKey,snapshot:j.draft});
 assert.throws(()=>startManagedPlan(f.input()),/不能重发/);assert.equal(f.calls.length,0);
 f.state.runs=[];f.state.accounts[2].status='unconnected';assert.throws(()=>startManagedPlan(f.input()),/绑定/);assert.equal(f.calls.length,0);
});
test('总览后更改标题、缺少明确发布授权都不能启动',()=>{
 const f=fixture(),input=f.input();f.draft.common.description='变更后文案';assert.throws(()=>startManagedPlan(input),/已改变/);assert.equal(f.calls.length,0);
 const fresh=f.input();fresh.authorization=null;assert.throws(()=>startManagedPlan(fresh),/明确发布确认/);assert.equal(f.calls.length,0);
});
test('多平台重复请求只读返回既有任务，不能换执行方式再次运行',()=>{
 const f=fixture(),input=f.input(),jobs=f.plan().jobs;
 f.state.runs=jobs.map(j=>({id:j.platform,requestId:input.requestId+'_'+j.platform,mode:'managed_prepare',fingerprint:j.fingerprint,executionMode:'automatic',status:'submitted'}));
 assert.equal(startManagedPlan(input).runs.length,3);assert.equal(f.calls.length,0);
 assert.throws(()=>startManagedPlan({...input,executionMode:'prepare_only'}),/不同任务/);
});
const links={douyin:'https://www.douyin.com/video/1234567890123456789',tencent:'https://channels.weixin.qq.com/platform/post/detail?feedId=synthetic_feed_123',xiaohongshu:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567'};
test('任何目标被测试会话占用时，批次在首个平台启动前整体阻止',()=>{
 const f=fixture();assert.throws(()=>startManagedPlan({...f.input(),assertAvailable:job=>{if(job.platform==='tencent')throw new Error('账号正被测试占用');}}),/测试占用/);
 assert.equal(f.calls.length,0);
});
for(const [platform,url] of Object.entries(links))test(`${platform}回执只接受本平台链接和一致的编号，成功提示不能代替作品记录`,()=>{
 const ref=workReference(url,platform);assert.ok(ref);
 assert.ok(managedReceipt({status:'submitted',...ref,platformStatus:'under_review'},{},platform));
 assert.equal(managedReceipt({status:'submitted',...ref,workId:'different'},{},platform),null);
 assert.equal(workReference(url.replace('https://','http://'),platform),null);
 assert.equal(workReference(url.replace(new URL(url).hostname,new URL(url).hostname+'.evil.example'),platform),null);
 assert.equal(managedReceipt({status:'submitted',workId:ref.workId,message:'发布成功'},{},platform),null);
 if(platform!=='douyin')assert.equal(managedReceipt({status:'submitted',...ref},{},'douyin'),null);
});
