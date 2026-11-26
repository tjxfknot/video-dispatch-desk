'use strict';
window.PublishHistoryUI=Object.freeze({create({getData,publisher,onRun,toast,onApprove}){
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  const button=(text,action,cls='button button-outline')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
  const time=value=>{
    if(!value)return '尚无平台时间';
    if(/年|^\d{4}[-/]\d\d[-/]\d\d\s/.test(value))return value;
    const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date):value;
  };
  let tab='publish',search='',platform='',teacher='',status='';
  const open=new Set(),filters=document.getElementById('history-tools');
  function field(label,value){const n=el('div','publish-detail-field');n.append(el('dt','',label),el('dd','',value || '未记录'));return n;}
  function statusPill(row){return el('span','publish-status '+row.tone,row.statusLabel);}
  const records=()=>{const data=getData();return (data.runs || []).map(run=>({run,record:window.PublishRecordModel.recordForRun(run,data)})).sort((a,b)=>(Date.parse(b.record.createdAt)||0)-(Date.parse(a.record.createdAt)||0));};
  async function perform(button,action){button.disabled=true;try{const result=await action();if(result?.id)onRun(result);}catch(e){toast(e.message,true);}finally{button.disabled=false;}}
  function makeCard({run,record}){
    const card=el('article','publish-record');card.dataset.runId=run.id;
    const head=el('div','publish-record-head'),text=el('div','publish-record-title');
    text.append(el('h2','',record.title || '未命名视频'),el('p','publish-record-meta',`${record.teacherLabel} · 创建于 ${time(record.createdAt)}`));
    if(run.appVersion)text.append(el('p','publish-record-meta',`${run.mode==='publish_check'?'检查':'执行'}版本 ${run.appVersion}`));
    head.append(text,statusPill(record));card.append(head);
    const table=el('div','publish-platform-table');table.setAttribute('role','table');table.setAttribute('aria-label','各平台发布结果');
    const labels=el('div','publish-platform-row table-labels');['发布平台','老师账号','发布结果','提交 / 平台时间'].forEach(s=>labels.append(el('span','',s)));table.append(labels);
    for(const row of record.rows){
      const n=el('div','publish-platform-row'),account=el('div','publish-account'),times=el('div','publish-times');
      account.append(el('b','',row.accountLabel || '账号未记录'));if(row.platformAccountId)account.append(el('small','',row.platformAccountId));
      if(row.submittedAt)times.append(el('span','',`提交 ${time(row.submittedAt)}`));
      if(row.publishedAt)times.append(el('span','',`${row.platformStatus==='published'?'发布':'平台记录'} ${time(row.publishedAt)}`));
      if(!times.childElementCount)times.append(el('span','',run.mode==='publish_check'?'未启动上传或提交':record.isRehearsal?'未上传、未发布':row.statusKey==='prep_failed' || row.statusKey==='canceled' || row.statusKey==='not_confirmed'?'尚未提交':'尚无平台时间'));
      n.append(el('b','publish-platform-name',row.platformLabel),account,statusPill(row),times);table.append(n);
    }
    card.append(table);
    if(record.issue)card.append(el('p','publish-issue',record.issue));
    const detail=el('details','publish-details');detail.open=open.has(run.id);detail.addEventListener('toggle',()=>{if(detail.open)open.add(run.id);else open.delete(run.id);});detail.append(el('summary','','查看发布详情'));
    if(run.mode==='managed_prepare'){
      const facts=el('dl','publish-content-fields'),submission=run.submission,pending=!!(submission?.operationPending || run.inspection?.pending);
      if(submission?.version===1){
        facts.append(field('发布动作记录',submission.actions?.length?'已开始调用；平台结果另行核查':'尚未进入发布动作'));
        if(submission.dispatchStartedAt)facts.append(field('动作开始时间',time(submission.dispatchStartedAt)));
      }
      if(run.candidateResult && !run.result)facts.append(field('候选作品编号（未核实）',run.candidateResult.workId));
      if(pending)facts.append(field('当前等待','原操作尚未返回；结束前不能再次发布或并发核查'));
      if(facts.childElementCount)detail.append(facts);
    }
    for(const row of record.rows){
      const section=el('section','publish-content-detail');section.append(el('h3','',row.platformLabel));
      const fields=el('dl','publish-content-fields');
      fields.append(field('当时的标题',row.title),field('当时的正文',row.description || '未填写正文'),field('视频素材',row.videoName),field('发布方式',row.schedule?.mode==='scheduled'?`定时 ${row.schedule.at || '时间未记录'}（北京时间）`:'立即发布'),field('声明',typeof row.declaration==='string'?row.declaration:row.declaration?.text || '不设置'),field('合集',typeof row.collection==='string'?row.collection:row.collection?.name || '不加入合集'));
      fields.append(field('作品定位',row.location ? window.PublishSettings.locationLabel(row.location) : '历史任务未记录定位选择'));
      const covers=row.covers || {};
      if(typeof covers==='object')for(const [kind,value] of Object.entries(covers))if(value)fields.append(field(kind==='portrait'?'竖封面':'横封面',typeof value==='string'?value:value.name));
      fields.append(field('提交范围',{public:'公开',self:'仅自己可见',friends:'好友可见',platform_default:'使用平台设置'}[row.visibility] || '未记录'),field('保存权限',{allow:'允许保存',deny:'不允许保存',platform_default:'使用平台设置'}[row.savePermission] || '未单独设置'));
      if(row.workId)fields.append(field('作品编号',row.workId));
      section.append(fields);
      const tags=el('div','publish-tags');tags.setAttribute('aria-label','当时的话题');
      if(row.tags?.length)row.tags.forEach(tag=>tags.append(el('span','publish-tag','#'+String(tag).replace(/^#/,''))));else tags.append(el('span','publish-no-tags','当时未添加话题'));
      section.append(tags);if(row.issue)section.append(el('p','publish-issue',row.issue));detail.append(section);
    }
    const timeline=el('details','publish-timeline');timeline.append(el('summary','','查看处理经过'));
    for(const event of record.events || []){const line=el('div','publish-event');line.append(el('time','',time(event.time || event.at)),el('span','',event.message || '状态已更新'));timeline.append(line);}
    detail.append(timeline);card.append(detail);
    const actions=el('div','publish-record-actions');
    if(run.mode==='managed_prepare' && ['awaiting_verification','submitted'].includes(run.status)){
      const pending=!!(run.submission?.operationPending || run.inspection?.pending);
      const inspect=button(pending?'等待原操作返回':'核查发布结果',()=>perform(inspect,()=>publisher.inspectManagedResult(run.id)));inspect.disabled=pending;actions.append(inspect);
    }
    if(run.result?.workUrl && typeof publisher.openPublishedWork==='function'){
      const view=button('查看作品',()=>perform(view,()=>publisher.openPublishedWork(run.id)));actions.append(view);
    }
    if(run.mode==='managed_prepare' && run.status==='awaiting_confirmation' && onApprove)actions.append(button('核对并发布',()=>onApprove(run)));
    if(['queued','running','preparing','ready_to_submit','awaiting_confirmation','approved','submitting','verifying_result'].includes(run.status) || (run.status==='awaiting_verification' && (run.submission?.operationPending || run.inspection?.pending))){
      const stop=button(record.isRehearsal?'取消演练':'停止该平台任务',()=>perform(stop,()=>publisher.cancelRun(run.id)),'button button-quiet');actions.append(stop);
    }
    const exportButton=button('导出发布记录',()=>perform(exportButton,()=>publisher.exportRun(run.id)),'button button-quiet');actions.append(exportButton);
    card.append(actions);return card;
  }
  function render(){
    const all=records(),real=all.filter(x=>!x.record.isRehearsal),rehearsals=all.filter(x=>x.record.isRehearsal);
    const source=tab==='rehearsal'?rehearsals:tab==='attention'?real.filter(x=>['attention','danger'].includes(x.record.tone)):real;
    const matches=source.filter(({record})=>(!platform || record.rows.some(r=>r.platform===platform)) && (!teacher || record.teacherLabel===teacher) && (!status || record.rows.some(r=>r.statusKey===status)) && (!search || [record.title,record.teacherLabel,...record.rows.flatMap(r=>[r.accountLabel,r.platformAccountId,...r.tags])].join(' ').toLowerCase().includes(search.toLowerCase())));
    const host=document.getElementById('run-list');host.replaceChildren();
    if(!matches.length){const empty=el('div','publish-empty');empty.append(el('h2','',source.length?'没有符合条件的记录':tab==='rehearsal'?'暂无本地演练记录':'暂无发布记录'),el('p','',source.length?'调整筛选条件可查看其他记录。':'在“新建发布”确认一次后，可在这里查看各平台结果。'));host.append(empty);}
    else matches.forEach(x=>host.append(makeCard(x)));
    document.getElementById('history-total').textContent=`${matches.length} 条${tab==='rehearsal'?'演练':'发布'}记录`;
    document.querySelectorAll('[data-record-tab]').forEach(b=>{const selected=b.dataset.recordTab===tab;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));const n=b.querySelector('small');if(n)n.textContent=b.dataset.recordTab==='rehearsal'?rehearsals.length:b.dataset.recordTab==='attention'?real.filter(x=>['attention','danger'].includes(x.record.tone)).length:real.length;});
  }
  if(filters){
    const tabs=el('div','publish-tabs');tabs.setAttribute('role','tablist');
    for(const [value,label] of [['publish','发布记录'],['attention','需要处理'],['rehearsal','本地演练']]){const b=button(label,()=>{tab=value;render();},'publish-tab');b.dataset.recordTab=value;b.setAttribute('role','tab');b.append(el('small','','0'));tabs.append(b);}
    const controls=el('div','publish-filters');
    const input=el('input');input.type='search';input.placeholder='搜索标题、老师或账号';input.setAttribute('aria-label','搜索发布记录');input.addEventListener('input',()=>{search=input.value.trim();render();});controls.append(input);
    function select(label,choices,change){const s=el('select');s.setAttribute('aria-label',label);for(const [value,text] of choices){const o=el('option','',text);o.value=value;s.append(o);}s.addEventListener('change',()=>{change(s.value);render();});controls.append(s);return s;}
    select('按平台筛选',[['','全部平台'],...['douyin','tencent','xiaohongshu'].map(p=>[p,({douyin:'抖音',tencent:'视频号',xiaohongshu:'小红书'})[p]])],v=>platform=v);
    select('按结果筛选',[['','全部结果'],['published','发布成功'],['under_review','审核中'],['awaiting_verification','结果待核查'],['submitted_unknown','已提交待确认'],['precheck_failed','发布前检查未通过'],['prep_failed','准备失败'],['rejected','审核未通过']],v=>status=v);
    const teacherSelect=select('按老师筛选',[['','全部老师']],v=>teacher=v);
    filters.append(tabs,controls);
    return {render(){const values=[...new Set(records().map(x=>x.record.teacherLabel))];const old=teacherSelect.value;teacherSelect.replaceChildren();for(const name of ['',...values]){const o=el('option','',name || '全部老师');o.value=name;teacherSelect.append(o);}teacherSelect.value=old;render();}};
  }
  return {render};
}});
