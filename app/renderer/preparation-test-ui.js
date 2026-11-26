'use strict';
window.PreparationTestUI=Object.freeze({create({publisher,getDraft,toast}){
  const open=document.getElementById('preparation-test-open');
  if(!open)return;
  if(typeof publisher.listPreparationTests!=='function'){open.disabled=true;open.title='当前版本尚未接入诊断与测试。';return;}
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  const dialog=el('dialog','','managed-pilot-dialog');dialog.id='preparation-test-dialog';dialog.setAttribute('aria-label','诊断与测试');document.body.append(dialog);
  const heading=el('h2','诊断与测试'),boundary=el('p'),feedback=el('p','','profile-error');feedback.setAttribute('role','alert');
  const mode=el('select'),scenario=el('select');mode.id='preparation-test-mode';scenario.id='preparation-test-scenario';
  for(const [value,text] of [['offline','离线模拟（默认，不连接真实平台）'],['real_prepare','真实上传准备（不提交）']]){const option=el('option',text);option.value=value;mode.append(option);}
  for(const [value,text] of [['quick','快速：上传完成后读取空定位'],['slow_upload','长等待：实际等待65秒'],['location_residue','异常：页面残留旧地点'],['upload_failure','异常：平台报告上传失败']]){const option=el('option',text);option.value=value;scenario.append(option);}
  const modeLabel=el('label','本次测试方式：','managed-execution-mode');modeLabel.append(mode);
  const scenarioLabel=el('label','离线场景：','managed-execution-mode');scenarioLabel.append(scenario);
  const reviewHost=el('div'),records=el('div');let busy=false,realReady=false,sessions=[],review=null;
  function fail(error){feedback.textContent=error.message || String(error);feedback.hidden=false;}
  function button(text,action,disabled=false){const b=el('button',text,'button button-quiet');b.type='button';b.disabled=disabled;b.addEventListener('click',async()=>{try{await action();}catch(error){fail(error);}});return b;}
  const start=button('开始离线模拟',async()=>{
    if(busy)return;busy=true;feedback.textContent='';sync();
    try{
      if(mode.value==='offline'){
        await publisher.startPreparationTest({mode:'offline',scenario:scenario.value,requestId:crypto.randomUUID()});
        await load();
      }else{
        const draft=getDraft(),result=await publisher.reviewPreparationTest(draft);
        review={...result,draft,requestId:crypto.randomUUID()};renderReview();
      }
    }finally{busy=false;sync();}
  });start.classList.add('button-primary');start.id='preparation-test-start';
  const close=button('关闭面板',()=>dialog.close());
  const reload=button('刷新测试记录',load);
  const actions=el('div','','managed-pilot-actions');actions.append(close,reload,start);
  dialog.append(heading,boundary,modeLabel,scenarioLabel,feedback,reviewHost,actions,records);
  function sync(){
    const offline=mode.value==='offline';scenarioLabel.hidden=!offline;mode.disabled=busy;scenario.disabled=busy;
    boundary.textContent=offline?'离线模拟：使用内置测试数据，只在本机模拟上传与定位，不向真实平台传输素材。完成后暂停，可反复只读核对定位。':'真实上传、不提交：使用当前任务所选的一个抖音测试账号。上传完成后暂停，原页面保留；本入口没有发布能力。';
    start.textContent=offline?'开始离线模拟':'核对本次账号与素材';start.disabled=busy || !!review || (!offline && !realReady);
    if(!offline && !realReady && !feedback.textContent)feedback.textContent='本机没有已明确指定的真实测试账号范围。离线模拟仍可使用。';
    feedback.hidden=!feedback.textContent;
  }
  function renderReview(){
    reviewHost.replaceChildren();if(!review)return;
    reviewHost.append(el('h3','确认真实上传准备'),el('p',review.accountDisplay),el('p','本条标题：'+review.title),el('p','将向此平台上传视频，可能留下平台草稿。完成视频上传后暂停，不设置封面，不提交发布。'));
    const confirm=button('确认上传，到视频完成后暂停',async()=>{
      if(busy || !review)return;const pinned=review;busy=true;sync();confirm.disabled=true;cancel.disabled=true;
      try{
        await publisher.startPreparationTest({mode:'real_prepare',draft:pinned.draft,fingerprint:pinned.fingerprint,requestId:pinned.requestId,authorization:{action:'prepare_test',fingerprint:pinned.fingerprint}});
        review=null;renderReview();await load();
      }finally{busy=false;confirm.disabled=false;cancel.disabled=false;sync();}
    });confirm.id='preparation-test-confirm';
    const cancel=button('返回测试选择',()=>{review=null;renderReview();sync();});reviewHost.append(cancel,confirm);
  }
  const labels={opening:'正在创建测试会话',uploading:'正在上传，等待完成',paused:'已暂停 · 未提交',reading:'只读核对中',stopping:'正在结束',stopped:'测试已结束',failed:'步骤失败 · 原现场保留',invalid:'检查点已失效',interrupted:'程序已重启 · 不自动续跑'};
  function render(){
    records.replaceChildren();records.append(el('h3','最近的测试会话（与发布记录分开）'));
    if(!sessions.length)records.append(el('p','尚无测试会话。先选择一个离线场景开始。'));
    for(const session of sessions.slice(0,30)){
      const card=el('article','','run-card');card.dataset.preparationSession=session.id;
      card.append(el('h3',(session.mode==='offline'?'离线模拟':'真实准备')+' · '+(labels[session.status] || session.status)),el('p',session.accountDisplay),el('p',session.message),el('p','允许：上传后暂停、只读定位。发布：禁止。'));
      if(session.location)card.append(el('p',session.location.error?'定位未通过：'+session.location.error:'定位回读：'+(session.location.value || '不添加地点')));
      const group=el('div','','managed-pilot-actions');
      if(session.status==='paused')group.append(button('只读核对定位',async()=>{await publisher.readPreparationLocation(session.id);await load();}));
      if(['opening','uploading','paused','reading','failed','invalid','stopping'].includes(session.status))group.append(button('结束此测试会话',async()=>{await publisher.stopPreparationTest(session.id);await load();},session.status==='stopping'));
      const details=el('details'),summary=el('summary','查看步骤记录');details.append(summary);
      for(const event of session.events || [])details.append(el('p',`${new Date(event.at).toLocaleTimeString('zh-CN',{hour12:false})} · ${event.message}`));
      card.append(group,details);records.append(card);
    }
  }
  async function load(){const data=await publisher.listPreparationTests();sessions=data.sessions;realReady=data.realReady;sync();render();}
  mode.addEventListener('change',()=>{review=null;feedback.textContent='';renderReview();sync();});
  open.addEventListener('click',async()=>{dialog.showModal();feedback.textContent='';busy=true;sync();try{await load();}catch(error){fail(error);}finally{busy=false;sync();}});
  publisher.onUpdate(event=>{if(event.type==='preparation_test'){
    sessions=[event.session,...sessions.filter(s=>s.id!==event.session.id)];if(dialog.open)render();
  }});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});sync();
}});
