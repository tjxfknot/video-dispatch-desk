'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {emptyState}=require('../app/core/domain.cjs');
const {buildManagedJob}=require('../app/core/managed-publish-job.cjs');
function fixture(){
 const assets=['video','portrait','landscape'].map(kind=>({id:kind,kind,path:'/synthetic/'+kind,name:kind+(kind==='video'?'.mp4':'.png'),size:10,mtimeMs:1}));
 const state={...emptyState(),teachers:[{id:'teacher',name:'合成老师'}],assets,environments:[{id:'env',source:'managed_browser',platform:'douyin',teacherId:'teacher'}],accounts:[{id:'account',teacherId:'teacher',platform:'douyin',status:'bound',browserEnvironmentId:'env',binding:{source:'managed_browser',revision:'revision',environmentId:'env',platformAccountId:'synthetic_owner'}}]};
 const draft={teacherId:'teacher',video:assets[0],covers:{portrait:assets[1],landscape:assets[2]},common:{title:'合成测试',description:'无业务内容',tags:[]},sharedDeclaration:{intent:'personal_opinion'},targets:[{platform:'douyin',enabled:true,accountId:'account'}]};
 const stat=()=>({isFile:()=>true,size:10,mtimeMs:1});return {draft,state,stat};
}
test('未保存新任务重复核对或随后保存时指纹稳定，内容变化仍必须重新核对',()=>{
 const {draft,state,stat}=fixture();
 const first=buildManagedJob(draft,state,stat);
 const second=buildManagedJob(draft,state,stat);
 assert.notEqual(first.draft.id,second.draft.id);
 assert.equal(first.fingerprint,second.fingerprint);
 assert.equal(buildManagedJob({...first.draft,name:'保存备注',updatedAt:'2099-01-01'},state,stat).fingerprint,first.fingerprint);
 draft.common.title='已改变的内容';
 assert.notEqual(buildManagedJob(draft,state,stat).fingerprint,first.fingerprint);
});
test('真实试发锁定账号绑定、素材与共同声明，换绑定必须重新确认',()=>{
 const {draft,state,stat}=fixture();const job=buildManagedJob(draft,state,stat);
 assert.equal(job.declarationText,'内容为个人观点或见解');assert.equal(job.expectedBinding.platformAccountId,'synthetic_owner');
 state.accounts[0].binding.revision='different';assert.notEqual(buildManagedJob(draft,state,stat).fingerprint,job.fingerprint);
});
test('小红书不支持的共同声明在上传前指出，单平台不设置不改变原共同声明',()=>{
 const f=fixture();f.state.accounts[0].platform='xiaohongshu';f.state.environments[0].platform='xiaohongshu';f.draft.targets[0].platform='xiaohongshu';
 assert.throws(()=>buildManagedJob(f.draft,f.state,f.stat),/小红书当前不提供.*本平台不设置声明/);
 f.draft.targets[0].declaration={mode:'omit'};
 assert.equal(buildManagedJob(f.draft,f.state,f.stat).declarationText,'');assert.equal(f.draft.sharedDeclaration.intent,'personal_opinion');
 f.draft.targets[0].declaration={mode:'override',intent:'ai_generated'};
 assert.equal(buildManagedJob(f.draft,f.state,f.stat).declarationText,'笔记含AI合成内容');
});
test('视频号常规标题进入描述，不受可选短标题6至16字限制；旧稿执行时默认不添加定位',()=>{
 const f=fixture();f.state.accounts[0].platform='tencent';f.state.environments[0].platform='tencent';f.draft.targets[0].platform='tencent';f.draft.sharedDeclaration={intent:'none'};
 for(const title of ['短题','背景211文科之王——对外经贸大学：到底值不值得选？']){
  f.draft.common.title=title;const job=buildManagedJob(f.draft,f.state,f.stat);
  assert.equal(job.copy.title,title);assert.deepEqual(job.location,{mode:'none',name:''});assert.deepEqual(job.summary[0].location,{mode:'none',name:''});
  assert.equal(job.files.landscape,null);assert.equal(job.files.portrait.id,'portrait');assert.equal(job.draft.covers.landscape.id,'landscape','通用横封面仍保留供其他平台使用');
  assert.equal(job.summary[0].covers.landscape,undefined);assert.equal(job.summary[0].covers.portrait,'portrait.png');
 }
 f.draft.common.description='文'.repeat(990);assert.throws(()=>buildManagedJob(f.draft,f.state,f.stat),/标题、简介和话题合计/);
});
test('未经绑定、错误环境或非单条抖音任务在上传前拒绝',()=>{
 for(const mutate of [x=>{x.state.accounts[0].status='unconnected';},x=>{x.state.environments[0].teacherId='other';},x=>{x.draft.targets.push({platform:'tencent',enabled:true});}]){
  const f=fixture();mutate(f);assert.throws(()=>buildManagedJob(f.draft,f.state,f.stat));
 }
});
test('尚未适配的定时、合集不能被静默丢弃',()=>{
 for(const mutate of [d=>{d.schedule={mode:'scheduled',at:'2099-01-01T10:00',timeZone:'Asia/Shanghai'};},d=>{d.targets[0].collection={required:true,name:'合集'};}]){
  const f=fixture();mutate(f.draft);assert.throws(()=>buildManagedJob(f.draft,f.state,f.stat),/定时|合集/);
 }
});
test('真实任务保留所选话题和公开范围，修改话题必须重新确认',()=>{
 const f=fixture();f.draft.common.tags=['游戏','新游'];f.draft.targets[0].specialSettings={visibility:'public',savePermission:'deny'};
 const job=buildManagedJob(f.draft,f.state,f.stat);assert.deepEqual(job.copy.tags,['游戏','新游']);assert.equal(job.settings.visibility,'public');
 f.draft.common.tags=['其他话题'];assert.notEqual(buildManagedJob(f.draft,f.state,f.stat).fingerprint,job.fingerprint);
});
test('不完整双封面或素材变化时拒绝，前端伪造路径不能替代登记素材',()=>{
 const f=fixture();f.draft.video={id:'video',path:'/unregistered/secret'};assert.equal(buildManagedJob(f.draft,f.state,f.stat).files.video.path,'/synthetic/video');
 assert.throws(()=>buildManagedJob(f.draft,f.state,()=>({isFile:()=>true,size:11,mtimeMs:1})),/素材已/);
 f.draft.covers.portrait=null;assert.throws(()=>buildManagedJob(f.draft,f.state,f.stat),/完整的横竖双封面/);
 f.draft.covers.landscape=null;const job=buildManagedJob(f.draft,f.state,f.stat);assert.equal(job.coverMode,'video_default');assert.equal(job.summary[0].coverMode,'video_default');
});
test('同一真实号的另一个备注也不能绕过同视频防重',()=>{
 const {ManagedPublisher}=require('../app/core/managed-publisher.cjs');
 const f=fixture();const job=buildManagedJob(f.draft,f.state,f.stat);
 f.state.runs=[{id:'previous',mode:'managed_prepare',status:'submitted',platform:'douyin',accountId:'different-note',expectedBinding:{...job.expectedBinding},videoKey:job.videoKey,snapshot:{video:{id:'reselected-same-file'}}}];
 const store={load:()=>structuredClone(f.state),update:fn=>fn(f.state)};
 const publisher=new ManagedPublisher({store,buildJob:(d,s)=>buildManagedJob(d,s,f.stat),getExecutor:async()=>{throw new Error('不应启动执行器');}});
 assert.throws(()=>publisher.start({draft:f.draft,requestId:'new_request_same_video_001'}),/禁止自动重复发布/);
});
test('已绑定旧版专属环境缺平台字段仍能生成原账号任务，不改环境或绑定',()=>{
 const f=fixture();delete f.state.environments[0].platform;const before=structuredClone(f.state);
 const job=buildManagedJob(f.draft,f.state,f.stat);
 assert.equal(job.platform,'douyin');assert.equal(job.expectedBinding.environmentId,'env');assert.equal(job.expectedBinding.platformAccountId,'synthetic_owner');assert.deepEqual(f.state,before);
});
test('兼容旧环境仍拒绝跨老师、明确跨平台及多个账号共用环境',()=>{
 for(const mutate of [s=>{s.environments[0].teacherId='other';},s=>{s.environments[0].platform='xiaohongshu';},s=>{s.environments[0].platform=null;},s=>{s.accounts.push({id:'other',browserEnvironmentId:'env'});},s=>{s.accounts.push({id:'other',binding:{environmentId:'env'}}); }]){
  const f=fixture();delete f.state.environments[0].platform;mutate(f.state);assert.throws(()=>buildManagedJob(f.draft,f.state,f.stat),/专属浏览器绑定/);
 }
});

test('定时发布：抖音在平台范围内可以建任务并带上定时；太早、太晚或未接通的平台在总览前拦住',()=>{
 const {formatAt}=require('../app/core/publish-schedule.cjs');
 const {draft,state,stat}=fixture();const immediate=buildManagedJob(draft,state,stat);
 const schedule=minutes=>({mode:'scheduled',at:formatAt(Date.now()+minutes*60000),timeZone:'Asia/Shanghai'});
 const job=buildManagedJob({...draft,schedule:schedule(300)},state,stat);
 assert.equal(job.schedule.mode,'scheduled');assert.equal(job.schedule.at,schedule(300).at);
 assert.notEqual(job.fingerprint,immediate.fingerprint,'改了发布时间必须重新核对总览');
 assert.equal(immediate.schedule.mode,'immediate');
 assert.throws(()=>buildManagedJob({...draft,schedule:schedule(60)},state,stat),/抖音要求定时时间在2小时之后/);
 assert.throws(()=>buildManagedJob({...draft,schedule:schedule(15*1440)},state,stat),/只能定时到14天内/);
});
