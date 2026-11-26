'use strict';

// Chromium's accessibility tree also identifies native buttons inside closed
// component roots. No page globals, shadow-root mode or security controls are
// modified. Only a unique, visible native button in the owned document can act.
async function createChromiumButtonReader({context,page,expectedUrl,assertRunning=()=>{}}){
  const client=await context.newCDPSession(page),expected=new URL(expectedUrl);
  await client.send('DOM.enable');
  function checkPage(){
    assertRunning();const u=new URL(page.url());
    if(u.origin!==expected.origin || u.pathname!==expected.pathname)throw new Error('发布按钮所属页面已变化，未提交。');
  }
  async function candidates(name){
    checkPage();const {nodes}=await client.send('Accessibility.getFullAXTree');
    if(nodes.some(n=>!n.ignored && ['dialog','alertdialog'].includes(n.role?.value)))throw new Error('平台弹窗尚未处理，未提交。');
    const matches=[...new Map(nodes.filter(n=>!n.ignored && n.role?.value==='button' && String(n.name?.value || '').trim()===name && n.backendDOMNodeId).map(n=>[n.backendDOMNodeId,n])).values()];
    if(matches.length>1)throw new Error('小红书的最终发布按钮不唯一，未提交。');
    return matches;
  }
  async function readNode(id,{focused=false}={}){
    const {object}=await client.send('DOM.resolveNode',{backendNodeId:id});
    if(!object.objectId)throw new Error('发布按钮已经失效，未提交。');
    try{
      const result=await client.send('Runtime.callFunctionOn',{objectId:object.objectId,returnByValue:true,functionDeclaration:`function(){
        const rect=this.getBoundingClientRect(),style=getComputedStyle(this),root=this.getRootNode();
        let visible=rect.width>0 && rect.height>0;
        for(let n=this;n;n=n.parentElement || n.getRootNode().host){const s=getComputedStyle(n);if(s.display==='none' || s.visibility==='hidden' || Number(s.opacity)===0)visible=false;}
        let documentUrl=this.ownerDocument.URL;
        try{if(documentUrl==='about:blank' || documentUrl==='about:srcdoc')documentUrl=this.ownerDocument.defaultView.parent.location.href;}catch{documentUrl='';}
        let outer=this;while(outer.getRootNode().host)outer=outer.getRootNode().host;
        const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=root.elementFromPoint?.(x,y),top=this.ownerDocument.elementFromPoint(x,y);
        const unobscured=!!hit && (hit===this || this.contains(hit)) && !!top && (top===outer || outer.contains(top));
        return {tag:this.tagName,text:(this.innerText || this.textContent || '').replace(/\\s+/g,' ').trim(),documentUrl,connected:this.isConnected,visible,unobscured,disabled:!!this.disabled || this.getAttribute('aria-disabled')==='true',focused:root.activeElement===this,shadowMode:root.mode || null};
      }`});
      if(result.exceptionDetails || !result.result?.value)throw new Error('发布按钮状态读取失败，未提交。');
      const value=result.result.value;let u;try{u=new URL(value.documentUrl);}catch{}
      if(!u || u.origin!==expected.origin || !['BUTTON','INPUT'].includes(value.tag) || !value.connected)throw new Error('发布按钮的原生控件或所属页面无法确认，未提交。');
      if(focused && !value.focused)throw new Error('发布按钮未获得浏览器焦点，未提交。');
      return value;
    }finally{await client.send('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
  }
  return {
    candidates,
    async findNative(name){
      const matches=await candidates(name);if(!matches.length)return null;
      const id=matches[0].backendDOMNodeId,initial=await readNode(id);
      if(initial.text!==name)return null;
      const enabled=async()=>{checkPage();const value=await readNode(id);return value.text===name && value.visible && !value.disabled;};
      return {evidence:{method:'chromium_accessibility_native_button',tag:initial.tag,shadowMode:initial.shadowMode,origin:expected.origin,path:expected.pathname},button:{
        isEnabled:enabled,
        async click(){
          checkPage();if(!await enabled())throw new Error('发布按钮当前不可用，未提交。');
          const current=await candidates(name);if(current[0]?.backendDOMNodeId!==id)throw new Error('发布按钮已变化，未提交。');
          await page.bringToFront();await client.send('DOM.scrollIntoViewIfNeeded',{backendNodeId:id});await client.send('DOM.focus',{backendNodeId:id});
          const value=await readNode(id,{focused:true});if(value.disabled || !value.visible || !value.unobscured)throw new Error('发布按钮当前不可用或被遮挡，未提交。');
          checkPage();
          await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
          await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        }
      }};
    },
    close:()=>client.detach().catch(()=>{})
  };
}
module.exports={createChromiumButtonReader};
