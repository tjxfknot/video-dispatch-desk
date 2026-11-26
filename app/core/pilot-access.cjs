'use strict';
const fs=require('node:fs');

function loadPilotAccess({isPackaged,developmentFlag,file,productionEnabled=false}) {
  // Normal releases verify each explicitly selected binding and task review.
  if(productionEnabled)return {enabled:true,development:!isPackaged,accounts:null,label:'多平台发布'};
  if(!isPackaged && developmentFlag==='1')return {enabled:true,development:true,accounts:null,label:'开发验证 · 抖音真实试发'};
  try {
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    if(data.version!==1 || !Array.isArray(data.accounts) || data.accounts.length!==1)return {enabled:false};
    const a=data.accounts[0];
    if(!['teacherId','accountId','environmentId','platformAccountId'].every(k=>typeof a[k]==='string' && a[k].trim() && a[k].length<150))return {enabled:false};
    return {enabled:true,development:false,accounts:[{teacherId:a.teacherId,accountId:a.accountId,environmentId:a.environmentId,platformAccountId:a.platformAccountId}],label:`抖音试发 · ${String(data.teacherName || '指定测试号').slice(0,40)}`};
  }catch{return {enabled:false};}
}

function assertPilotAccess(access,job) {
  if(!access.enabled)throw new Error('本机尚未启用真实试发，不会改成演练。');
  if(access.accounts && !access.accounts.some(a=>a.teacherId===job.teacherId && a.accountId===job.accountId && a.environmentId===job.expectedBinding.environmentId && a.platformAccountId===job.expectedBinding.platformAccountId))throw new Error('本机真实试发仅开放给已指定的测试老师抖音号；未开放其他账号。');
}

module.exports={loadPilotAccess,assertPilotAccess};
