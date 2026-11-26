'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {ManagedPublisher}=require('../app/core/managed-publisher.cjs');
const {managedReceipt}=require('../app/core/managed-receipt.cjs');
const proof=visibility=>({status:'submitted',workId:'1234567890123456789',workUrl:'https://www.douyin.com/video/1234567890123456789',visibility,message:'已核对公开范围'});
function fixture(){
 const state={runs:[]};let submits=0;
 const p=new ManagedPublisher({store:{load:()=>structuredClone(state),update:fn=>fn(state)},buildJob:draft=>({draft,platform:'douyin',fingerprint:'public-fp',accountId:'a',teacherId:'t',expectedBinding:{revision:'r',environmentId:'e',platformAccountId:'real'},settings:{visibility:'public'}}),
 getExecutor:async()=>({verify:async()=>{},prepare:async()=>({checks:Object.fromEntries(['video','covers','text','declaration','collection','schedule','visibility','savePermission'].map(k=>[k,true]))}),submit:async()=>{submits++;return proof('public');}})});
 const input={draft:{video:{id:'v'}},requestId:'public_request_00000001',executionMode:'automatic',authorization:{action:'publish',fingerprint:'public-fp',visibility:'public'}};
 return {p,input,submits:()=>submits};
}
test('本次总览明确授权公开范围后自动执行一次，回执和授权保留公开范围',async()=>{
 const f=fixture(),run=f.p.start(f.input);
 for(let i=0;i<100&&f.p.run(run.id).status!=='submitted';i++)await new Promise(r=>setTimeout(r,5));
 const done=f.p.run(run.id);assert.equal(done.status,'submitted');assert.equal(done.authorization.visibility,'public');assert.equal(done.result.visibility,'public');assert.equal(f.submits(),1);
 assert.equal(done.events.some(e=>e.status==='awaiting_confirmation'),false);
});
test('仅给出发布授权但没确认公开范围，或授权为私密时，不创建公开任务',()=>{
 for(const visibility of [undefined,'self']){const f=fixture();f.input.authorization.visibility=visibility;assert.throws(()=>f.p.start(f.input),/公开发布需要/);assert.equal(f.submits(),0);}
});
test('私密或未核对的回执不能冒充公开发布，审核状态只按平台实际记录保留',()=>{
 assert.equal(managedReceipt(proof('self'),{visibility:'public'}),null);
 assert.equal(managedReceipt(proof('unverified'),{visibility:'public'}),null);
 const r=managedReceipt({...proof('public'),platformStatus:'under_review'},{visibility:'public'});assert.equal(r.visibility,'public');assert.equal(r.platformStatus,'under_review');
});
test('桌面错误提示只显示业务原因，不泄露内部IPC调用包装',async()=>{
 let api;vm.runInNewContext(fs.readFileSync(require.resolve('../app/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_key,value)=>{api=value;}},ipcRenderer:{invoke:()=>Promise.reject(new Error("Error invoking remote method 'desk:review-managed-pilot': Error: 请明确选择公开或私密。"))}};}});
 await assert.rejects(api.reviewManagedPilot({}),error=>{assert.equal(error.message,'请明确选择公开或私密。');return true;});
});
