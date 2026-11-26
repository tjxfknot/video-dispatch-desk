'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const domain = require('../app/core/domain.cjs'), settings = require('../app/core/publish-settings.cjs');
const { buildJob } = require('../app/core/chrome-publisher.cjs');
function fixture() {
  const assets = ['video','landscape','portrait'].map(kind => ({ id:kind, kind, name:kind+'.mp4', path:'/synthetic/'+kind, size:1, mtimeMs:1 }));
  const value = { ...domain.emptyState(), teachers:[{id:'teacher'}], assets,
    accounts:['douyin','tencent'].map(platform => ({ id:platform,platform,teacherId:'teacher',label:'合成'+platform,status:'unconnected' })) };
  let saved = structuredClone(value);
  const store = {load:()=>structuredClone(saved),update:fn=>{const next=structuredClone(saved);fn(next);saved=next;}};
  const draft = { teacherId:'teacher',video:assets[0],covers:{landscape:assets[1],portrait:assets[2]},common:{title:'合成任务',tags:[]},sharedDeclaration:{intent:'personal_opinion'},targets:['douyin','tencent'].map(platform=>({platform,enabled:true,accountId:platform})) };
  const stat = () => ({ isFile:()=>true,size:1,mtimeMs:1 });
  return {value,store,draft,stat};
}
test('共同声明及平台特殊设置经草稿与模板往返保留，旧稿不会被偷偷勾选',()=>{
  const {store,draft,value}=fixture();draft.targets[0].specialSettings={visibility:'self',savePermission:'deny'};
  const saved=domain.saveDraft(store,draft);
  const template=domain.saveTemplate(store,{...saved,id:undefined,name:'合成模板'});
  assert.deepEqual(template.sharedDeclaration,{intent:'personal_opinion'});
  assert.deepEqual(template.targets[1].declaration,{required:false,text:''});
  assert.deepEqual(template.targets.find(t=>t.platform==='douyin').specialSettings,draft.targets[0].specialSettings);
  const legacy=domain.normalizeDraft({...draft,sharedDeclaration:undefined},value);
  assert.equal(legacy.sharedDeclaration,undefined);
  for (const intent of ['reposted','marketing','fictional']) {
    const next=domain.saveDraft(store,{...draft,id:undefined,targets:draft.targets.map(target=>target.platform==='douyin'?{...target,declaration:{mode:'override',intent}}:target)});
    assert.equal(store.load().drafts.find(item=>item.id===next.id).targets.find(target=>target.platform==='douyin').declaration.intent,intent);
  }
});
test('总览展示继承声明和独立覆盖，改共同声明不改覆盖平台',()=>{
  const {draft,value,stat}=fixture();draft.targets[1].declaration={mode:'override',intent:'ai_generated'};
  let result=domain.validateDraft(draft,value,'rehearsal',stat);
  assert.equal(result.summary[0].declaration,'个人观点或见解');assert.equal(result.summary[0].declarationOrigin,'shared');
  draft.sharedDeclaration.intent='ai_generated';result=domain.validateDraft(draft,value,'rehearsal',stat);
  assert.equal(result.summary[0].declaration,'含 AI 生成内容');assert.equal(result.summary[1].declarationOrigin,'platform');
  assert.equal(result.summary[1].declarationVerification,'page_observed');
  assert.ok(result.issues.some(i=>i.field==='declaration'&&i.platform==='tencent'&&i.severity==='warning'));
  assert.equal(settings.resolveDeclaration(draft.sharedDeclaration,{mode:'inherit'},'xiaohongshu').verification,'page_observed');
  assert.equal(settings.resolveDeclaration(draft.sharedDeclaration,{mode:'inherit'},'unknown').verification,'unverified');
});
test('本平台不设置声明会明确阻断继承，老的独立声明继续保留',()=>{
  const {draft,value,stat}=fixture();draft.targets[0].declaration={mode:'omit'};
  draft.targets[1].declaration={required:true,text:'以前记录的内容'};
  const result=domain.validateDraft(draft,value,'rehearsal',stat);
  assert.equal(result.summary[0].declaration,'不设置');assert.equal(result.summary[1].declaration,'以前记录的内容');
});
test('共同声明、特殊设置进入任务指纹，修改不影响已生成快照',()=>{
  const {draft,value}=fixture(),a=domain.normalizeDraft(draft,value),before=structuredClone(a),hash=domain.snapshotHash(a);
  draft.sharedDeclaration.intent='ai_generated';draft.targets[0].specialSettings={visibility:'self'};
  assert.notEqual(domain.snapshotHash(domain.normalizeDraft(draft,value)),hash);assert.deepEqual(a,before);
});
test('不能给视频号套抖音可见范围，也不能伪造声明意图',()=>{
  const {draft,value}=fixture();draft.targets[1].specialSettings={visibility:'self'};
  assert.throws(()=>domain.normalizeDraft(draft,value),/不能套用/);
  delete draft.targets[1].specialSettings;draft.sharedDeclaration.intent='made_up';
  assert.throws(()=>domain.normalizeDraft(draft,value),/声明意图/);
  assert.equal(settings.normalizeTargetDeclaration({required:'false',text:'保留草稿'}).required,false);
});
test('潜在真实通道不能丢掉共同声明或特殊设置后继续执行',()=>{
  const {draft,value,stat}=fixture();draft.targets[1].enabled=false;
  assert.throws(()=>buildJob(draft,value,stat),/共同声明尚未/);
  draft.sharedDeclaration.intent='none';draft.targets[0].specialSettings={visibility:'self'};
  assert.throws(()=>buildJob(draft,value,stat),/特殊设置的自动填写尚未/);
  draft.targets[0].specialSettings={};
  for (const intent of ['ai_generated','personal_opinion','reposted','marketing','fictional']) {
    draft.targets[0].declaration={mode:'override',intent};
    assert.throws(()=>buildJob(draft,value,stat),/原生声明选项已记录，自动填写尚未/);
  }
  assert.equal(domain.ENGINE.ready,false);assert.equal(domain.ENGINE.douyinPilot,false);
});
