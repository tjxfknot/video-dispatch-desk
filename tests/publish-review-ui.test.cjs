'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app/renderer/managed-pilot-ui.js'),'utf8');
function harness({saveError,reviewError}={}){
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.events={};this.attrs={};this.style={};this.classList={add(){}};this.open=false;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=[...children];}
    addEventListener(name,fn){this.events[name]=fn;}
    setAttribute(name,value){this.attrs[name]=value;}
    showModal(){this.open=true;}
    close(){this.open=false;}
  }
  const host=new Element('host'),body=new Element('body'),calls={save:0,review:0,start:0},toasts=[];
  const window={PublishReadiness:{summary:()=>({ready:true,selected:[{}],blockers:[]})},PublishSettings:{locationLabel:()=> '不添加定位'}};
  vm.runInNewContext(source,{window,document:{createElement:t=>new Element(t),querySelector:()=>host,body},structuredClone});
  const draft={common:{title:'合成标题'}};
  window.ManagedPilotUI.create({getData:()=>({currentDraft:draft}),
    saveTask:async()=>{calls.save++;if(saveError)throw new Error(saveError);return draft;},
    publisher:{reviewManagedPilot:async()=>{calls.review++;if(reviewError)throw new Error(reviewError);return {files:[],summary:[],targets:[]};},startManagedPilot:async()=>{calls.start++;throw new Error('不应发布');}},
    onRun:()=>{throw new Error('不应创建任务');},toast:(...args)=>toasts.push(args)});
  return {calls,toasts,start:host.children[0],dialog:body.children[0]};
}
const texts=element=>[element.textContent||'',...element.children.map(texts)].join('\n');
test('总览失败持续显示完整原因，关闭只返回编辑，不启动或重试上传',async()=>{
  const h=harness({reviewError:'素材不存在：video.mp4\n本次原因已保存在发布记录。'});
  await h.start.events.click();
  assert.equal(h.dialog.open,true);assert.equal(h.dialog.attrs['aria-label'],'发布前检查未通过');
  assert.match(texts(h.dialog),/video.mp4[\s\S]*已保存在发布记录/);assert.equal(h.calls.start,0);
  assert.equal(h.toasts.length,0);assert.equal(h.dialog.children.find(e=>e.attrs.role==='alert').style.whiteSpace,'pre-wrap');
  const back=h.dialog.children.find(e=>e.tag==='button');assert.equal(back.textContent,'返回修改');
  await back.events.click();assert.equal(h.dialog.open,false);assert.equal(h.calls.review,1);assert.equal(h.calls.start,0);
});
test('保存未成功也持续显示原错误，不冒称已经留档，不进入总览或上传',async()=>{
  const h=harness({saveError:'当前任务尚未保存成功'});await h.start.events.click();
  assert.equal(h.dialog.open,true);assert.match(texts(h.dialog),/尚未保存成功/);assert.doesNotMatch(texts(h.dialog),/已保存在发布记录/);
  assert.equal(h.calls.review,0);assert.equal(h.calls.start,0);
});
