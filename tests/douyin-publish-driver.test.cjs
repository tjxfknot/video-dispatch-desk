'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertPreparedPage,normalizeCoverSource,coverPixelsMatch,listRecordEvidence,receiptVisibility,copyFillIssue,readEditorCopy,clearEditorCopy}=require('../app/core/douyin-publish-driver.cjs');

test('自动回执区分本次记录和旧同名作品，按北京时间比较且保留分钟精度',()=>{
  const text='00:08\n合成任务\n2026年11月07日 12:00\n私密';
  const record=listRecordEvidence(text,{runCreatedAt:'2026-11-07T04:00:45Z'});
  assert.equal(record.visibility,'self');assert.equal(record.duration,'00:08');assert.equal(record.publishedAt,'2026年11月07日 12:00');
  assert.equal(listRecordEvidence(text,{runCreatedAt:'2026-11-07T04:01:00Z'}),null);
  assert.equal(listRecordEvidence('发布成功',{runCreatedAt:'2026-11-07T04:00:00Z'}),null);
  assert.equal(listRecordEvidence(text,{runCreatedAt:'invalid'}),null);
  assert.ok(listRecordEvidence(text,{expectedWorkId:'1234567890123456789',runCreatedAt:'2026-11-07T05:00:00Z'}),'已知作品编号的只读复查允许查询旧记录');
});

test('封面必须回读到选中图片，默认视频帧和另一张封面不能冒充上传完成',()=>{
  const solid=rgb=>Array.from({length:256},()=>rgb).flat();
  const blue=solid([23,85,140]),orange=solid([182,91,18]),video=solid([26,68,63]);
  assert.equal(coverPixelsMatch(blue,blue.map(v=>v+2)),true);
  assert.equal(coverPixelsMatch(blue,video),false);
  assert.equal(coverPixelsMatch(blue,orange),false);
  assert.equal(coverPixelsMatch(blue,null),false);
});

test('封面临时签名更新不等于换图，资源路径变化仍可被检测',()=>{
  assert.equal(normalizeCoverSource('https://media.douyin.com/cover/one.jpg?x-orig-sign=first'),normalizeCoverSource('https://media.douyin.com/cover/one.jpg?x-orig-sign=renewed'));
  assert.notEqual(normalizeCoverSource('https://media.douyin.com/cover/one.jpg?sign=same'),normalizeCoverSource('https://media.douyin.com/cover/two.jpg?sign=same'));
  assert.notEqual(normalizeCoverSource('https://media.douyin.com/cover/one.jpg?crop=portrait'),normalizeCoverSource('https://media.douyin.com/cover/one.jpg?crop=landscape'));
  assert.equal(normalizeCoverSource('blob:synthetic-one'),'blob:synthetic-one');
});

test('等待最终确认期间修改平台页面，必须在点击发布前阻止',()=>{
  const prepared={url:'https://creator.douyin.com/creator-micro/content/post/video',title:'流程测试',description:'无业务内容',tags:['游戏'],declaration:true,collection:true,visibility:'仅自己可见',savePermission:'不允许',schedule:'立即发布',covers:{portrait:'portrait-1',landscape:'landscape-1'}};
  assert.doesNotThrow(()=>assertPreparedPage(prepared,structuredClone(prepared)));
  for(const [field,value] of Object.entries({url:'https://creator.douyin.com/creator-micro/home',title:'其他标题',description:'其他文案',tags:[],declaration:false,collection:false,visibility:'公开',savePermission:'允许',schedule:'定时发布',covers:{portrait:'other',landscape:'landscape-1'}})){
    assert.throws(()=>assertPreparedPage(prepared,{...prepared,[field]:value}),/平台表单已改变/);
  }
});

// Permissions on the submitted form and subsequent creator evidence have
// different meanings from moderation and public access.
test('公开回执必须有实际提交表单证据或平台权限，不能仅凭列表没有私密字样推断',()=>{
 const record=listRecordEvidence('00:30\n作品\n2026年11月07日 15:00\n审核中');
 assert.equal(record.platformStatus,'under_review');
 assert.equal(receiptVisibility(record,{visibility:'unverified'},null).visibility,'unverified');
 assert.equal(receiptVisibility(record,null,{visibility:'公开',clicked:false}).visibility,'unverified');
 const proof=receiptVisibility(record,null,{visibility:'公开',clicked:true});
 assert.equal(proof.visibility,'public');assert.equal(proof.visibilityVerification,'submitted_form_and_creator_record');
 assert.equal(receiptVisibility({...record,visibility:'self'},null,{visibility:'公开',clicked:true}).visibility,'self');
});

test('文案回读失败时报出标题、简介各自的期望值和实际回读值，空简介明确标注',()=>{
  assert.equal(copyFillIssue({title:'示例标题文本，用来校验回读？',description:''},{title:'示例标题文本，用来校验回读？',description:'',tags:[]}),'');
  const residue=copyFillIssue({title:'示例标题文本，用来校验回读？',description:''},{title:'示例标题文本，用来校验回读？',description:'',tags:['标签一','标签一','标签二']});
  assert.match(residue,/简介框里仍有话题 #标签一 #标签一 #标签二/);assert.match(residue,/未提交/);assert.doesNotMatch(residue,/标题期望/);
  const rewritten=copyFillIssue({title:'原标题',description:''},{title:'被平台改写的标题',description:'残留文字',tags:[]});
  assert.match(rewritten,/标题期望「原标题」，回读「被平台改写的标题」/);
  assert.match(rewritten,/简介期望「」（本条为空），回读「残留文字」/);
  assert.match(copyFillIssue({title:'t',description:'x'.repeat(100)},{title:'t',description:'',tags:[]}),/期望「x{60}…」/);
});

test('简介清空有上限：平台编辑器清不掉时最多尝试三次，交给回读如实报错',async()=>{
  let presses=0;const editor={focus:async()=>{},press:async()=>{presses++;}};
  await clearEditorCopy(editor,async()=>({description:'',tags:['文科']}));
  assert.equal(presses,6);
  presses=0;await clearEditorCopy(editor,async()=>({description:'',tags:[]}));assert.equal(presses,0);
});

const {chromium}=require('playwright-core');
const available=require('../app/core/browser-driver.cjs').browserAvailability().find(b=>b.available);
test('抖音简介框预填话题（2026-11-11 实测结构）：innerText 会读成文字，结构回读识别为残留话题，清空后为空',{skip:!available,timeout:20000},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  // 取自 live-diagnostics 上传完成后的简介框结构（只保留结构与话题名）。
  const mention=name=>`<span data-leaf="true"><span data-rect-container="true"><span data-zero-space="true">​</span><span data-fake-text=" " contenteditable="false"><div data-mention="#" style="display:inline">&nbsp;<span>#${name}</span>&nbsp;</div></span></span></span>`;
  await page.setContent(`<div class="editor" data-slate-editor="true" contenteditable="true" style="min-height:60px"><div class="ace-line" data-node="true"><div data-line-wrapper="true">${['文科','文科','高考'].map(mention).join('')}<span data-leaf="true"><span data-string="true" data-enter="true">​</span></span></div></div></div>`);
  const editor=page.locator('[contenteditable="true"]');
  // 修复前的检查：去零宽空格后 innerText 不为空，空简介必然“不一致”。
  assert.notEqual((await editor.innerText()).replace(/​/g,'').trim(),'');
  assert.deepEqual(await readEditorCopy(editor),{description:'',tags:['文科','文科','高考']});
  assert.match(copyFillIssue({title:'t',description:''},{title:'t',...await readEditorCopy(editor)}),/仍有话题 #文科 #文科 #高考/);
  await clearEditorCopy(editor);
  assert.deepEqual(await readEditorCopy(editor),{description:'',tags:[]});
  assert.equal(copyFillIssue({title:'t',description:''},{title:'t',...await readEditorCopy(editor)}),'');
});
