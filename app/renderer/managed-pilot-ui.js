'use strict';
window.ManagedPilotUI=Object.freeze({create({getData,publisher,saveTask,onRun,toast}){
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(text,run)=>{const n=el('button','button button-outline',text);n.type='button';n.addEventListener('click',run);return n;};
  const reviewLines=summary=>{
    const s=summary?.[0] || {}, settings=s.specialSettings || {};
    return [`标题：${s.title || ''}`,`简介：${s.description || '（留空）'}`,`封面：${s.coverMode==='video_default'?'使用视频默认画面，不上传自定义封面':`${s.covers?.portrait || '竖封面'} / ${s.covers?.landscape || '横封面'}`}`,`声明：${s.declaration || '无需添加自主声明'}`,
      `可见范围：${{public:'公开',friends:'好友可见',self:'仅自己可见'}[settings.visibility] || '使用平台当前设置'}`,
      `保存权限：${{allow:'允许',deny:'不允许'}[settings.savePermission] || '使用平台当前设置'}`,
      `发布方式：${s.schedule?.mode==='scheduled'?`定时发布 · ${String(s.schedule.at || '').replace('T',' ')}（北京时间）`:'立即发布'}`,
      `定位：${window.PublishSettings.locationLabel(s.location)}`,`合集：${s.collection || '不加入合集'}`,`话题：${s.tags?.length?s.tags.map(tag=>'#'+tag).join(' '):'不添加'}`];
  };
  const start=button('发布到所选平台',async()=>{
    try{
      const readiness=window.PublishReadiness.summary(getData());
      if(!readiness.ready){toast(readiness.blockers.map(r=>`${r.platformLabel}：${r.label}`).join('；') || '请先选择发布平台。',true);return;}
      const draft=typeof saveTask==='function'?await saveTask():structuredClone(getData().currentDraft);
      const review=await publisher.reviewManagedPilot(draft);
      const targets=review.targets || [{platform:'douyin',accountDisplay:review.accountDisplay,settings:review.summary?.[0]?.specialSettings || {}}];
      const labels={douyin:'抖音',tencent:'视频号',xiaohongshu:'小红书'};
      showReview('发布总览',review.accountDisplay,[...review.files.map(f=>`素材：${f.name}`),
        ...review.summary.flatMap(row=>[`【${labels[row.platform] || row.platform}】`,...reviewLines([row])]),
        '确认后，程序会分别核对每个平台的账号、上传、填写、提交一次并核查结果。某个平台失败不代表其他平台没有发布，请查看各平台记录。'],
        '确认并发布到所选平台',async executionMode=>{
          const result=await publisher.startManagedPilot({draft,fingerprint:review.fingerprint,requestId:crypto.randomUUID(),executionMode,
            authorization:executionMode==='automatic'?{action:'publish',fingerprint:review.fingerprint,platforms:targets.map(t=>t.platform)}:null});
          for(const run of result.runs || [result])onRun(run);
        },true);
    }catch(error){showStartError(error);}
  });
  start.id='managed-pilot-start';start.classList.add('button-real','button-large');start.hidden=true;
  document.querySelector('.action-buttons').append(start);
  const dialog=el('dialog','managed-pilot-dialog');dialog.id='managed-pilot-review';dialog.setAttribute('aria-label','发布总览核对');document.body.append(dialog);
  let busy=false;
  function showStartError(error){
    dialog.setAttribute('aria-label','发布前检查未通过');
    dialog.replaceChildren();dialog.append(el('h2','','发布前检查未通过'));
    const message=el('p','profile-error',error.message);message.setAttribute('role','alert');message.style.whiteSpace='pre-wrap';dialog.append(message);
    dialog.append(button('返回修改',()=>dialog.close()));dialog.showModal();
  }
  function showReview(title,account,lines,confirmLabel,action,chooseMode=false){
    dialog.setAttribute('aria-label','发布总览核对');
    dialog.replaceChildren();dialog.append(el('h2','',title),el('p','',account));
    for(const line of lines)dialog.append(el('p','',line));
    const feedback=el('p','profile-error');feedback.setAttribute('role','alert');feedback.hidden=true;
    let mode;
    if(chooseMode){
      const label=el('label','managed-execution-mode','本次执行方式');
      mode=el('select');mode.id='managed-pilot-mode';
      for(const [value,text] of [['automatic','自动发布：确认后自动提交并核查结果'],['prepare_only','只准备：真实上传与填写，完成后停止，不提交']]){
        const option=el('option','',text);option.value=value;mode.append(option);
      }
      label.append(mode);dialog.append(label);
    }
    const cancel=button('返回',()=>{if(!busy)dialog.close();});
    const confirm=button(confirmLabel,async()=>{
      if(busy)return;busy=true;confirm.disabled=true;cancel.disabled=true;feedback.textContent='';feedback.hidden=true;
      if(mode)mode.disabled=true;
      try{await action(mode?.value);dialog.close();}catch(error){feedback.textContent=error.message;feedback.hidden=false;}finally{busy=false;confirm.disabled=false;cancel.disabled=false;if(mode)mode.disabled=false;}
    });confirm.id='managed-pilot-confirm';confirm.classList.add('button-primary');
    const actions=el('div','managed-pilot-actions');actions.append(cancel,confirm);dialog.append(feedback,actions);dialog.showModal();
    if(mode)mode.addEventListener('change',()=>{confirm.textContent=mode.value==='prepare_only'?'确认上传与填写，不提交':confirmLabel;});
  }
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  const labels={queued:'等待真实准备',preparing:'正在真实上传与填写',ready_to_submit:'检查通过 · 自动继续',prepared:'准备完成 · 未提交',awaiting_confirmation:'旧任务已填好 · 等待最终确认',approved:'重新核对账号与素材',submitting:'正在真实提交',verifying_result:'正在自动核查平台记录 · 不会重发',submitted:'平台记录已核对',awaiting_verification:'结果待核查 · 不会重发',failed:'真实准备未完成 · 未提交',canceled:'已停止 · 未提交'};
  return Object.freeze({
    confirmExisting(run){
      showReview('提交前核对',run.accountDisplay,[...reviewLines(run.summary),'请核对原任务内容。确认后只提交一次；结果未知时不会重发。'],'确认发布',async()=>onRun(await publisher.approveManagedPilot({id:run.id,fingerprint:run.fingerprint})));
    },
    sync(){
      const data=getData();start.hidden=!data.engine?.managedPilot;
      if(data.engine?.managedPilot){
        document.querySelector('#create-subtitle').textContent='选择老师、素材、话题和封面，明确选公开或私密。任务先自动保存，总览确认一次后由程序上传、填写、提交并核查结果；也可选择只准备、不提交。';
        document.querySelector('#library-subtitle').textContent='账号按老师隔离，在这里管理登录和身份绑定。从“新建发布”选择平台，总览确认后执行；每次提交前会重新核对账号。';
        document.querySelector('#history-subtitle').textContent='按老师、账号和平台查看结果；展开可查看当时的内容、话题、素材和处理经过。';
      }
      const readiness=window.PublishReadiness.summary(data);
      start.disabled=!readiness.ready || !!data.saving || !!data.starting || busy;
      start.title=readiness.blockers.map(r=>`${r.platformLabel}：${r.label}`).join('；') || (!readiness.selected.length?'请先选择发布平台。':'查看各平台账号、内容与设置后确认发布。');
    },
    renderRun(run){
      const card=el('article','run-card real-run managed-run');card.dataset.runId=run.id;
      card.append(el('h3','',`真实试发 · 抖音 · ${run.snapshot?.common?.title || ''}`),el('p','',labels[run.status] || run.status),el('p','',run.accountDisplay || `抖音号 ${run.expectedBinding?.platformAccountId || '待核对'}`),el('p','',run.message || ''));
      if(run.executionMode==='automatic')card.append(el('p','',`执行方式：自动发布 · 本次授权后由程序继续${run.authorization?.grantedAt?' · '+new Date(run.authorization.grantedAt).toLocaleString('zh-CN',{hour12:false}):''}`));
      if(run.executionMode==='prepare_only')card.append(el('p','','执行方式：只准备，不提交'));
      const details=el('details');details.open=['queued','preparing','ready_to_submit','awaiting_confirmation','approved','submitting','verifying_result'].includes(run.status);details.append(el('summary','','查看真实步骤'));
      for(const event of run.events || [])details.append(el('p','',`${event.time || event.at || ''} · ${event.message}`));card.append(details);
      if(run.result?.workId){
        card.append(el('p','',`平台作品编号：${run.result.workId}${{self:' · 提交范围：仅自己可见',public:' · 提交范围：公开',friends:' · 提交范围：好友可见'}[run.result.visibility] || ''}`));
        const status={under_review:'审核中',published:'平台显示已发布',scheduled:'平台显示定时发布',rejected:'审核未通过',unknown:'尚待平台更新'}[run.result.platformStatus];
        if(status)card.append(el('p','',`平台审核状态：${status}`));
        if(run.result.visibilityVerification==='submitted_form_and_creator_record')card.append(el('p','','公开选项已在提交前回读确认，平台作品记录已核对；审核通过和公开可访问仍以平台为准。'));
      }
      if(run.status==='awaiting_confirmation')card.append(button('核对并确认真实发布',async()=>{
        try{
          const review=await publisher.reviewManagedPilot(run.snapshot);
          if(review.fingerprint!==run.fingerprint)throw new Error('任务或账号绑定已改变，不能继续原来的提交。');
          showReview('最终提交前核对',review.accountDisplay,[...reviewLines(review.summary),`八项页面检查：${Object.values(run.checks || {}).filter(v=>v===true).length}/8`,'确认后程序只点击一次平台发布按钮；结果未明时不会自动重发。'],'确认发布到这个测试账号',async()=>onRun(await publisher.approveManagedPilot({id:run.id,fingerprint:run.fingerprint})));
        }catch(error){toast(error.message,true);}
      }));
      if(['queued','preparing','ready_to_submit','awaiting_confirmation','approved','submitting','verifying_result'].includes(run.status))card.append(button('停止本次真实试发',async()=>{try{onRun(await publisher.cancelRun(run.id));}catch(e){toast(e.message,true);}}));
      if(['awaiting_verification','submitted'].includes(run.status)){
        const inspect=button('只读核查平台结果',async()=>{inspect.disabled=true;inspect.textContent='正在只读核查…';try{onRun(await publisher.inspectManagedResult(run.id));}catch(e){toast(e.message,true);}finally{inspect.disabled=false;inspect.textContent='只读核查平台结果';}});
        card.append(inspect);
      }
      card.append(button('导出真实试发报告',async()=>{try{await publisher.exportRun(run.id);}catch(e){toast(e.message,true);}}));
      return card;
    }
  });
}});
