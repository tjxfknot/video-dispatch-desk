'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadPilotAccess,assertPilotAccess}=require('../app/core/pilot-access.cjs');

test('安装版没有明确的本机试发范围时保持关闭，环境变量不能扩大范围',()=>{
  const access=loadPilotAccess({isPackaged:true,developmentFlag:'1',file:'/missing/pilot-scope.json'});
  assert.equal(access.enabled,false);
  assert.throws(()=>assertPilotAccess(access,{}),/尚未启用/);
  assert.equal(loadPilotAccess({isPackaged:false,developmentFlag:'1'}).enabled,true);
});

test('本机试发范围只允许同一老师、账号、专属环境与平台真实号',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-scope-'));const file=path.join(dir,'scope.json');
  try {
    const allowed={teacherId:'teacher-test',accountId:'account-test',environmentId:'env-test',platformAccountId:'real-test'};
    fs.writeFileSync(file,JSON.stringify({version:1,teacherName:'测试老师',accounts:[allowed]}));
    const access=loadPilotAccess({isPackaged:true,file});
    const job={teacherId:allowed.teacherId,accountId:allowed.accountId,expectedBinding:{environmentId:allowed.environmentId,platformAccountId:allowed.platformAccountId}};
    assert.doesNotThrow(()=>assertPilotAccess(access,job));
    for(const key of ['teacherId','accountId'])assert.throws(()=>assertPilotAccess(access,{...job,[key]:'business-account'}),/仅开放/);
    for(const key of ['environmentId','platformAccountId'])assert.throws(()=>assertPilotAccess(access,{...job,expectedBinding:{...job.expectedBinding,[key]:'other'}}),/仅开放/);
    fs.writeFileSync(file,JSON.stringify({version:1,accounts:[allowed,allowed]}));
    assert.equal(loadPilotAccess({isPackaged:true,file}).enabled,false);
    fs.writeFileSync(file,'broken');assert.equal(loadPilotAccess({isPackaged:true,file}).enabled,false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
