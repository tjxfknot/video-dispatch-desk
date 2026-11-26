'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { normalizeDraft, validateDraft, snapshotHash } = require('./domain.cjs');
const { resolveDeclaration, declarationIssue, DOUYIN_DECLARATIONS } = require('./publish-settings.cjs');
const { PLATFORMS } = require('./domain.cjs');
const { scheduleIssue } = require('./publish-schedule.cjs');

// One immediate Douyin post. Requested fields must be applied and read back;
// unsupported requirements fail before opening the upload page.
function buildManagedJob(input, state, inspectFile = fs.statSync) {
  const draft = normalizeDraft(input, state);
  const checked = validateDraft(draft, state, 'rehearsal', inspectFile);
  if (!checked.ok) throw new Error(checked.issues.filter(i => i.severity === 'error').map(i => i.message).join('\n'));
  const targets = draft.targets.filter(t => t.enabled);
  if (targets.length !== 1) throw new Error('每个平台分别核对账号，请从发布总览启动多平台任务。');
  const platform=targets[0].platform, config=PLATFORMS.find(p=>p.id===platform);
  if(!config)throw new Error('平台无法识别。');
  // 定时用平台自己的定时功能。未接通的平台、超出平台范围的时间在这里就拦住。
  const scheduleProblem = scheduleIssue(platform, draft.schedule);
  if (scheduleProblem) throw new Error(scheduleProblem);
  const target = targets[0];
  const account = state.accounts.find(a => a.id === target.accountId && a.platform === platform);
  if (!draft.teacherId || !state.teachers?.some(t => t.id === draft.teacherId) || account?.teacherId !== draft.teacherId) throw new Error('请明确选择老师及其所选平台账号。');
  const binding = account?.binding;
  const environment = state.environments?.find(e => e.id === binding?.environmentId);
  if (account.status !== 'bound' || binding?.source !== 'managed_browser' || !binding.platformAccountId || !binding.revision
    || environment?.source !== 'managed_browser' || (environment.platform !== undefined && environment.platform !== platform)
    || environment.teacherId !== draft.teacherId || account.browserEnvironmentId !== environment.id
    || state.accounts.some(other => other.id !== account.id
      && (other.browserEnvironmentId === environment.id || other.binding?.environmentId === environment.id))) {
    throw new Error('所选账号尚未完成专属浏览器绑定；不会改用其他老师或日常浏览器的登录号。');
  }
  const copy = target.inherit ? draft.common : target;
  // 视频号的常规标题属于视频描述，不能套用另一个可留空的短标题限制。
  // 旧草稿未记录定位时，也明确执行不添加，不沿用平台预填城市。
  const location=target.location || (platform==='tencent'?{mode:'none',name:''}:undefined);
  if(location?.mode==='place' && !location.name)throw new Error(`${config.label}选择添加定位时，请填写准确地点名称。`);
  const titleLimit={douyin:30,xiaohongshu:20}[platform];
  if(titleLimit && Array.from(copy.title).length>titleLimit)throw new Error(`${config.label}标题最多${titleLimit}字，请在该平台单独设置标题。`);
  const tagLimit=({xiaohongshu:10}[platform] || Infinity);
  if(copy.tags.length>tagLimit)throw new Error(`${config.label}当前支持最多${tagLimit}个话题，请单独调整，程序不会截掉话题。`);
  if (copy.description.length > 1000) throw new Error(`${config.label}当前支持的正文不超过1000字，请在该平台单独调整。`);
  if(platform==='tencent' && Array.from([copy.title,copy.description,...copy.tags.map(t=>'#'+t)].filter(Boolean).join('\n')).length>1000)throw new Error('视频号标题、简介和话题合计超过当前支持的1000字，请调整内容；程序不会截掉文案。');
  if (platform==='douyin' && target.collection.required) throw new Error('抖音合集选择尚未完成实测，不会忽略本条要求。');
  const declaration = resolveDeclaration(draft.sharedDeclaration, target.declaration, platform);
  const declarationProblem = declarationIssue(platform, declaration);
  if (declarationProblem) throw new Error(declarationProblem);
  if (platform==='douyin' && declaration.required && !declaration.nativeText && !Object.values(DOUYIN_DECLARATIONS).includes(declaration.text)) {
    throw new Error('这条声明尚不能对应已核对的抖音单选原文，请重新选择明确的声明选项。');
  }
  const files = {
    video: draft.video,
    landscape: target.covers.landscape || draft.covers.landscape,
    portrait: target.covers.portrait || draft.covers.portrait
  };
  if(platform==='douyin' && !!files.landscape!==!!files.portrait)throw new Error('请选择完整的横竖双封面，或同时移除两张以明确使用视频默认封面。');
  for(const kind of ['landscape','portrait'])if(!config.coverSlots.includes(kind))files[kind]=null;
  const coverMode=config.coverSlots.some(k=>files[k])?'custom':'video_default';
  for (const [kind, file] of Object.entries(files)) {
    if(kind!=='video' && !file)continue;
    if (!file) throw new Error(`首轮真实试发需要${kind === 'video' ? '视频' : kind === 'landscape' ? '横版封面' : '竖版封面'}，请先选择。`);
    const stat = inspectFile(file.path);
    if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error('素材已改变，请重新选择并核对。');
    if (file.size > (kind === 'video' ? 512 : 20) * 1024 * 1024) throw new Error('当前上传支持视频不超过512MB、单张封面不超过20MB。');
  }
  const expectedBinding = { revision: binding.revision, environmentId: environment.id, platformAccountId: binding.platformAccountId };
  const videoKey = createHash('sha256').update(JSON.stringify([files.video.path, files.video.size, files.video.mtimeMs])).digest('hex');
  // Hash the task contents at the root so the normal snapshot metadata rules
  // exclude a freshly allocated draft ID, name and save timestamp.
  const fingerprint = snapshotHash({ ...draft, ...(platform==='tencent'?{effectiveLocation:location}:{}), expectedBinding, videoKey });
  const declarationText = declaration.required ? declaration.nativeText || declaration.text : '无需添加自主声明';
  return {
    draft, coverMode, ...(location !== undefined ? {location} : {}), teacherLabel:state.teachers.find(t=>t.id===draft.teacherId).name, summary: checked.summary.map(row=>({...row,...(location!==undefined?{location}:{}),declaration:declarationText,coverMode,platformAccountId:binding.platformAccountId})), teacherId: draft.teacherId, accountId: account.id, platform,
    expectedBinding, fingerprint, videoKey, files, schedule: { ...draft.schedule },
    copy: { title: copy.title, description: copy.description, tags: [...copy.tags] },
    declarationText: platform==='douyin'?declarationText:declaration.required?declaration.nativeText || declaration.text:'',
    settings: { visibility: target.specialSettings?.visibility || 'platform_default', savePermission: target.specialSettings?.savePermission || 'platform_default' },
    accountDisplay: `${state.teachers.find(t => t.id === draft.teacherId).name} · ${binding.displayName || account.label} · ${config.label} · ${binding.platformAccountId}`
  };
}

function buildManagedPlan(input,state,inspectFile=fs.statSync){
  const draft=normalizeDraft(input,state),targets=draft.targets.filter(t=>t.enabled);
  if(!targets.length)throw new Error('请至少选择一个发布平台。');
  const jobs=[],issues=[];
  for(const target of targets){
    try{jobs.push(buildManagedJob({...draft,targets:draft.targets.map(t=>({...t,enabled:t.platform===target.platform}))},state,inspectFile));}
    catch(error){issues.push(`${PLATFORMS.find(p=>p.id===target.platform)?.label || target.platform}：${error.message}`);}
  }
  if(issues.length)throw new Error(issues.join('\n'));
  return {draft,jobs,fingerprint:snapshotHash({jobs:jobs.map(j=>({platform:j.platform,fingerprint:j.fingerprint}))}),summary:jobs.flatMap(j=>j.summary)};
}
module.exports = { buildManagedJob,buildManagedPlan };
