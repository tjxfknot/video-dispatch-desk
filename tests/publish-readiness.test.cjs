'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {accountState,platformState,summary}=require('../app/renderer/publish-readiness.js');
const {buildManagedPlan}=require('../app/core/managed-publish-job.cjs');
function fixture(){
 const account={id:'a',teacherId:'t',platform:'tencent',status:'bound',browserEnvironmentId:'e',binding:{source:'managed_browser',platformAccountId:'real_123',environmentId:'e',revision:'r'}};
 const data={teachers:[{id:'t',name:'合成老师'}],accounts:[account],platforms:[{id:'tencent',label:'视频号'}],environments:[{id:'e',source:'managed_browser',teacherId:'t',platform:'tencent'}],browserSessions:{},accountChecks:{},currentDraft:{teacherId:'t',targets:[{platform:'tencent',enabled:true,accountId:'a'}]}};
 return {account,data};
}
test('关闭窗口或从未检查只显示已绑定待查，不推断扫码失效',()=>{
 const {account,data}=fixture();
 for(const state of [undefined,'offline']){data.accountChecks.a={state};assert.equal(accountState(account,data).key,'bound_unchecked');assert.equal(summary(data).ready,true);}
});
test('真实登录页、身份不一致和读取失败分别提示，已绑定不冒充可发布',()=>{
 const {account,data}=fixture();
 for(const [state,key] of [['login_required','login_required'],['mismatch','mismatch'],['unverifiable','unverifiable']]){
  data.accountChecks.a={state};assert.equal(accountState(account,data).key,key);assert.equal(summary(data).ready,false);
 }
});
test('没有绑定、等待扫码和候选待确认都阻止发布，候选不自动确认为绑定',()=>{
 const {account,data}=fixture();account.status='unconnected';account.binding=null;
 assert.equal(accountState(account,data).key,'unbound');assert.equal(summary(data).ready,false);
 data.browserSessions.a={state:'awaiting_login',windowOpen:true};assert.match(accountState(account,data).label,/未绑定.*等待扫码/);
 data.browserSessions.a={state:'awaiting_confirmation',windowOpen:true,candidate:{platformAccountId:'new_123'}};
 assert.equal(accountState(account,data).key,'awaiting_confirmation');assert.equal(summary(data).ready,false);
});
test('只有本次打开窗口且五分钟内的核验显示刚核对一致，绑定历史时间不能代替',()=>{
 const {account,data}=fixture(),now=Date.now();account.binding.verifiedAt=new Date(now).toISOString();
 assert.equal(accountState(account,data,now).key,'bound_unchecked');
 data.browserSessions.a={state:'verified',windowOpen:true,checkedAt:new Date(now-1000).toISOString()};assert.equal(accountState(account,data,now).key,'verified');
 for(const checkedAt of [new Date(now+6000).toISOString(),'invalid']){data.browserSessions.a.checkedAt=checkedAt;assert.equal(accountState(account,data,now).key,'bound_unchecked');}
});
test('窗口仍开着且超过五分钟：显示核对时间而不是“登录待检查”，不阻塞也不冒充刚核对',()=>{
 const {account,data}=fixture(),now=Date.now();
 data.browserSessions.a={state:'verified',windowOpen:true,checkedAt:new Date(now-300000).toISOString()};
 let r=accountState(account,data,now);assert.equal(r.key,'verified_earlier');assert.equal(r.blocked,false);assert.match(r.label,/5分钟前核对一致/);
 data.browserSessions.a.checkedAt=new Date(now-3*3600000).toISOString();assert.match(accountState(account,data,now).label,/3小时前核对一致/);
 // 窗口关了、或本次状态已不是核对一致，就不能沿用
 data.browserSessions.a.windowOpen=false;assert.equal(accountState(account,data,now).key,'bound_unchecked');
 data.browserSessions.a={state:'unverifiable',windowOpen:true,checkedAt:new Date(now-300000).toISOString()};assert.equal(accountState(account,data,now).key,'unverifiable');
});
test('未绑定账号的窗口已打开但身份读取失败时提示重新识别，不再只要求重新扫码',()=>{
 const {account,data}=fixture();account.binding=null;account.status='unconnected';
 data.browserSessions.a={windowOpen:true,state:'unverifiable',message:'官方账号页面尚未打开，当前为空白页。'};
 assert.equal(accountState(account,data).key,'identity_unavailable');assert.match(accountState(account,data).message,/空白页/);assert.equal(summary(data).ready,false);
 data.browserSessions.a={windowOpen:true,state:'awaiting_login'};assert.equal(accountState(account,data).key,'unbound');
});
test('检查中优先于上次成功，绑定结构或老师环境变化立即阻止',()=>{
 const {account,data}=fixture();data.accountChecks.a={state:'verified',pending:true};assert.equal(accountState(account,data).key,'checking');assert.equal(summary(data).ready,false);assert.equal(accountState(account,data).blocked,true);
 data.accountChecks.a={};data.environments[0].teacherId='another';assert.equal(accountState(account,data).key,'invalid_binding');assert.equal(summary(data).ready,false);
});
test('不跨老师挑选账号，没有选择时仍显示该平台已有账号的绑定情况',()=>{
 const {data}=fixture();data.currentDraft.targets[0].accountId='';assert.match(platformState(data.platforms[0],data).label,/未选择账号.*已绑定/);
 data.currentDraft.teacherId='';assert.equal(platformState(data.platforms[0],data).key,'no_teacher');
 data.currentDraft.teacherId='t';data.accounts[0].teacherId='another';assert.equal(platformState(data.platforms[0],data).key,'no_account');
});
test('未勾选的平台仍能查看未绑定状态，但不拦截其他已选目标',()=>{
 const {data}=fixture();data.platforms.push({id:'xiaohongshu',label:'小红书'});data.accounts.push({id:'x',platform:'xiaohongshu',teacherId:'t',status:'unconnected'});data.currentDraft.targets.push({platform:'xiaohongshu',accountId:'x',enabled:false});
 let s=summary(data);assert.equal(s.rows[1].key,'unbound');assert.equal(s.ready,true);
 data.currentDraft.targets[1].enabled=true;s=summary(data);assert.equal(s.ready,false);assert.equal(s.blockers[0].platformLabel,'小红书');
});
test('后台校验一次列全所有有问题的平台，不只返回第一个通用错误',()=>{
 const state={assets:[],teachers:[],accounts:[],environments:[],drafts:[],templates:[],runs:[]};
 assert.throws(()=>buildManagedPlan({targets:[{platform:'tencent',enabled:true},{platform:'xiaohongshu',enabled:true}],common:{title:'测试',description:'',tags:[]}},state),e=>e.message.includes('视频号：')&&e.message.includes('小红书：'));
});
test('旧版专属环境缺平台字段时保留原绑定并待本次核验，不误判老师或账号不匹配',()=>{
 const {account,data}=fixture();delete data.environments[0].platform;const before=structuredClone(data);
 assert.equal(accountState(account,data).key,'bound_unchecked');assert.equal(summary(data).ready,true);assert.deepEqual(data,before);
 data.accountChecks.a={state:'unverifiable',message:'现场未读到身份'};assert.equal(accountState(account,data).key,'unverifiable');assert.equal(summary(data).ready,false);
});
test('旧版无平台字段仍拒绝其他老师、明确跨平台、共享环境及未知账号清单',()=>{
 for(const mutate of [d=>{d.environments[0].teacherId='other';},d=>{d.environments[0].platform='douyin';},d=>{d.accounts.push({id:'other',browserEnvironmentId:'e'});},d=>{d.accounts.push({id:'other',binding:{environmentId:'e'}});},d=>{delete d.accounts;}]){
  const {account,data}=fixture();delete data.environments[0].platform;mutate(data);assert.equal(accountState(account,data).key,'invalid_binding');
 }
});
