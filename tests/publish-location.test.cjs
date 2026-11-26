'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {browserAvailability}=require('../app/core/browser-driver.cjs');
const settings=require('../app/core/publish-settings.cjs'),domain=require('../app/core/domain.cjs');
const {createLocationControl}=require('../app/core/publish-location-driver.cjs');
const {assertPreparedPage}=require('../app/core/douyin-publish-driver.cjs');
const {recordForRun}=require('../app/renderer/publish-record-model.js');

test('定位为独立平台字段，不添加会清除旧地点名，拒绝无效模式和额外坐标',()=>{
 assert.deepEqual(settings.normalizeLocation({mode:'none',name:'旧地点'}),{mode:'none',name:''});
 assert.deepEqual(settings.normalizeLocation({mode:'place',name:'  人民广场  '}),{mode:'place',name:'人民广场'});
 for(const value of [{mode:'nearby'},{mode:'place',latitude:1},{mode:'place',name:'\u0000'}])assert.throws(()=>settings.normalizeLocation(value),TypeError);
});
test('草稿和模板逐平台保存定位，改变地点会改变确认指纹，历史缺失不追写默认值',()=>{
 const state=domain.emptyState(),store={load:()=>structuredClone(state),update(fn){fn(state);return state;}};
 const input={common:{title:'定位测试',description:'',tags:[]},targets:[{platform:'douyin',enabled:true,location:{mode:'none',name:''}},{platform:'tencent',enabled:true,location:{mode:'place',name:'广州图书馆'}}]};
 const first=domain.saveDraft(store,input),template=domain.saveTemplate(store,{...input,name:'定位模板'});
 assert.deepEqual(first.targets.find(t=>t.platform==='tencent').location,{mode:'place',name:'广州图书馆'});
 assert.equal(template.targets.find(t=>t.platform==='douyin').location.mode,'none');
 const next=structuredClone(first);next.targets.find(t=>t.platform==='tencent').location.name='上海图书馆';assert.notEqual(domain.snapshotHash(first),domain.snapshotHash(next));
 const legacy=domain.normalizeDraft({common:{title:'旧稿'},targets:[{platform:'douyin',enabled:true}]},state);assert.equal(Object.hasOwn(legacy.targets[1],'location'),false);
 const report=domain.exportReport({id:'r',mode:'managed_prepare',status:'prepared',snapshot:first,summary:[{platform:'tencent',location:{mode:'place',name:'广州图书馆'}}],items:[],events:[]});assert.equal(report.summary[0].location.name,'广州图书馆');
});
test('添加定位未填地点阻止执行；旧记录的未记录与新任务不添加严格区分',()=>{
 const state=domain.emptyState(),checked=domain.validateDraft({common:{title:'合成稿'},targets:[{platform:'tencent',enabled:true,location:{mode:'place',name:''}}]},state);
 assert.ok(checked.issues.some(i=>i.field==='location' && i.severity==='error'));
 const run={id:'r',mode:'managed_prepare',status:'prepared',snapshot:{common:{title:'旧记录'},targets:[{platform:'tencent',enabled:true}]},summary:[{platform:'tencent',title:'旧记录'}],items:[],events:[]};
 assert.equal(recordForRun(run,{}).rows[0].location,null);
 run.summary[0].location={mode:'none',name:''};assert.equal(recordForRun(run,{}).rows[0].location.mode,'none');
 assert.throws(()=>assertPreparedPage({location:{mode:'none',value:''}},{location:{mode:'place',value:'未授权地点'}}),/定位/);
});

const available=browserAvailability().find(b=>b.available);
test('定位执行只用本机合成控件，不访问平台',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.abort());
 const page=await context.newPage();
 await t.test('默认不添加，不选附近地点，不把平台地区信息当成作品定位',async()=>{
  await page.setContent('<p>IP属地：北京</p>');assert.equal((await createLocationControl(page,{mode:'none',name:''}).apply()).evidence,'no_visible_location_control');
 });
 await t.test('平台已有地点时明确清除，并在读回时发现后来加上的地点',async()=>{
  await page.setContent('<div><input role="combobox" aria-label="作品定位" value="旧地点"><button onclick="document.querySelector(\'input\').value=\'\'">清除位置</button></div>');
  const control=createLocationControl(page,{mode:'none',name:''});assert.equal((await control.apply()).value,'');
  await page.locator('input').fill('另一个地点');await assert.rejects(()=>control.read(),/仍带有作品定位/);
 });
 await t.test('抖音自定义地理位置空值可核对，已选地点加空搜索框也不能误判为空',async()=>{
  const form=(value)=>`<div><span>添加标签</span><div><div><span>位置</span><i>⌄</i></div><div>带货模式</div><div id="value"><span id="place">${value}</span><input placeholder="输入地理位置" value=""><button aria-label="清除位置" onclick="document.getElementById('place').textContent='输入地理位置'">×</button></div></div></div>`;
  await page.setContent(form('输入地理位置'));const control=createLocationControl(page,{mode:'none'},{platform:'douyin'});
  assert.equal((await control.apply()).value,'');
  await page.locator('#place').evaluate(el=>el.textContent='杭州市');await assert.rejects(()=>control.read(),/仍带有作品定位/);
  assert.equal((await control.apply()).value,'');
  await page.locator('button').evaluate(el=>el.onclick=()=>{});await page.locator('#place').evaluate(el=>el.textContent='杭州市');
  await assert.rejects(()=>createLocationControl(page,{mode:'none'},{platform:'douyin',waitMs:150}).apply(),/仍带有作品定位/);
 });
 await t.test('抖音纯文字占位与非标准控件仍按值容器核对；重复和未知结构停止',async()=>{
  await page.setContent('<div><div><span>位置</span></div><div>带货模式</div><div>输入地理位置</div></div>');
  assert.equal((await createLocationControl(page,{mode:'none'},{platform:'douyin'}).apply()).value,'');
  await page.setContent('<div><span>位置</span><div>输入地理位置</div><div>第二个地点控件</div></div>');
  await assert.rejects(()=>createLocationControl(page,{mode:'none'},{platform:'douyin'}).apply(),/不唯一/);
  await page.setContent('<p>位置</p>');await assert.rejects(()=>createLocationControl(page,{mode:'none'},{platform:'douyin'}).apply(),/无法核对/);
 });
 await t.test('抖音多层包装不依赖固定父层数，锁定整段值后占位消失仍发现已选地点',async()=>{
  await page.setContent(`<div><span>添加标签</span><div><div><div><div><div><span>位置</span><i>⌄</i></div></div></div></div></div><div><span>带货模式</span></div><div id="place-value"><div><div><div id="placeholder">输入地理位置</div></div></div><input placeholder="" value=""></div></div></div>`);
  const control=createLocationControl(page,{mode:'none'},{platform:'douyin'});assert.equal((await control.apply()).value,'');
  await page.locator('#placeholder').evaluate(el=>el.remove());await page.locator('#place-value').evaluate(el=>{const place=document.createElement('span');place.textContent='杭州市';el.append(place);});
  await assert.rejects(()=>control.read(),/仍带有作品定位/);
  await page.locator('#place-value span').evaluate(el=>el.remove());await page.locator('#place-value input').fill('上海市');await assert.rejects(()=>control.read(),/仍带有作品定位/);
 });
 await t.test('抖音开通“带货模式”时（同容器嵌套带货模式与输入地理位置）空定位零点击通过且不漏检已选地点',async()=>{
  await page.setContent(`
   <div class="anchor-part-xN_guh">
    <div class="anchor-container-hgj7gj">
     <div class="semi-select select-lJTtRL semi-select-single">位置</div>
     <div class="anchor-component-Shp3mT" onclick="window.__containerClicks=(window.__containerClicks||0)+1">
      <div class="anchor-item-UTleEn">
       <div class="semi-select semi-select-single" onclick="window.__modeClicks=(window.__modeClicks||0)+1">带货模式</div>
       <div id="geo-select" class="semi-select select-PJBSlx semi-select-single semi-select-filterable" onclick="window.__geoClicks=(window.__geoClicks||0)+1">
        <div class="semi-select-selection">
         <div class="semi-select-content-wrapper">
          <span id="geo-placeholder" class="semi-select-selection-text semi-select-selection-placeholder">输入地理位置</span>
          <div class="semi-input-wrapper"><input type="text" value=""></div>
         </div>
        </div>
        <div class="semi-select-clear"></div>
       </div>
      </div>
     </div>
    </div>
   </div>
  `);
  const control=createLocationControl(page,{mode:'none',name:''},{platform:'douyin',waitMs:200});
  assert.deepEqual(await control.apply(),{mode:'none',value:'',evidence:'native_location_control'});
  assert.equal(await page.evaluate(()=>({c:window.__containerClicks||0,m:window.__modeClicks||0,g:window.__geoClicks||0})).then(x=>x.c+x.m+x.g),0);
  // 占位替换为真实地点时必须仍能检出
  await page.locator('#geo-placeholder').evaluate(el=>{el.textContent='杭州市';});
  await assert.rejects(()=>control.read(),/仍带有作品定位/);
  // 初次进入即已选中地点且同容器含“带货模式”时，应精确剥离“带货模式”而不误点模式框
  const prefilled=createLocationControl(page,{mode:'place',name:'杭州市'},{platform:'douyin',waitMs:200});
  assert.deepEqual(await prefilled.read(),{mode:'place',value:'杭州市',evidence:'native_location_control'});
  // 同层若再冒出第二个非带货模式控件，必须因不唯一而停止
  await page.locator('.anchor-item-UTleEn').evaluate(el=>{const extra=document.createElement('div');extra.textContent='未知干扰控件';el.append(extra);});
  await assert.rejects(()=>createLocationControl(page,{mode:'none',name:''},{platform:'douyin',waitMs:200}).apply(),/不唯一/);
 });
 await t.test('小红书原生空地点控件可核对，已选地点或未知结构不能冒充不添加',async()=>{
  await page.setContent('<div class="d-select-main"><div class="d-select-content"><div class="d-select-placeholder">添加地点</div></div></div>');
  const control=createLocationControl(page,{mode:'none',name:''},{platform:'xiaohongshu'});assert.equal((await control.apply()).value,'');
  await page.locator('.d-select-placeholder').evaluate(n=>{n.className='d-select-value';n.textContent='旧地点';});
  await assert.rejects(()=>control.read(),/无法唯一核对/);
  await page.setContent('<div>添加地点</div>');await assert.rejects(()=>createLocationControl(page,{mode:'none',name:''},{platform:'xiaohongshu'}).apply(),/无法唯一核对/);
 });
 await t.test('视频号文字标签旁的自定义下拉必须清掉预填杭州，不把未识别控件当成无定位',async()=>{
  await page.setContent(`<div><div><span>位置</span></div><div id="value" onclick="document.getElementById('choices').hidden=false"><span id="place">杭州市</span><i>⌄</i></div></div><div id="choices" hidden><div onclick="document.getElementById('place').textContent='不显示位置';document.getElementById('choices').hidden=true">不显示位置</div></div>`);
  const control=createLocationControl(page,{mode:'none',name:''},{platform:'tencent',waitMs:150});
  await assert.rejects(()=>control.read(),/仍带有作品定位/);
  assert.equal((await control.apply()).value,'');
  await page.locator('#place').evaluate(n=>n.textContent='杭州市');await assert.rejects(()=>control.read(),/仍带有作品定位/);
  await page.locator('#choices').evaluate(n=>n.firstElementChild.setAttribute('role','option'));
  await page.locator('#choices > div').evaluate(n=>{n.innerHTML='<span>不显示位置</span>';});
  assert.equal((await control.apply()).value,'');
 });
  await t.test('视频号空位置保持空，清除无效或只有未知位置入口时必须停止',async()=>{
  await page.setContent('<div><span>位置</span><div>不显示位置</div></div>');assert.equal((await createLocationControl(page,{mode:'none'},{platform:'tencent'}).apply()).value,'');
  await page.setContent(`<div><span>位置</span><div onclick="document.getElementById('none').hidden=false">杭州市</div></div><div id="none" hidden>不显示位置</div>`);
  await assert.rejects(()=>createLocationControl(page,{mode:'none'},{platform:'tencent',waitMs:150}).apply(),/仍带有作品定位/);
  await page.setContent('<div><span>位置</span><div>杭州市</div></div>');await assert.rejects(()=>createLocationControl(page,{mode:'none'},{platform:'tencent',waitMs:150}).apply(),/没有可核对的清除选项/);
  await page.setContent('<p>位置</p>');await assert.rejects(()=>createLocationControl(page,{mode:'none'},{platform:'tencent',waitMs:150}).apply(),/无法核对或清除/);
 });
 await t.test('2026-11-22 视频号真实 .post-position-wrap：异步IP预填城市必须清为不显示位置，暂无可用位置绝不点重新定位',async()=>{
  // 场景 A：初始“暂无可用位置 / 重新定位”，400ms 后异步变成 Ottawa，必须等出并清掉且零点击“重新定位”
  await page.setContent(`
    <div class="form-item"><div class="label">位置</div><div class="form-item-body">
      <div class="post-position-wrap">
        <div class="position-display" id="disp">
          <div class="input-location"><div class="placeholder">暂无可用位置</div><a class="refresh-coords" onclick="window.__refreshClicks=(window.__refreshClicks||0)+1">重新定位</a></div>
        </div>
        <div class="location-filter-wrap" id="filter" style="display:none">
          <div class="common-option-list-wrap">
            <div class="option-item active" onclick="document.querySelector('#disp .location-name').textContent='不显示位置';document.getElementById('filter').style.display='none';"><div class="location-item"><div class="location-item-info"><div class="name">不显示位置</div></div></div></div>
            <div class="option-item"><div class="location-item"><div class="location-item-info"><div class="name">Ottawa</div></div></div></div>
          </div>
        </div>
      </div>
    </div></div>
    <script>
      setTimeout(() => {
        document.getElementById('disp').innerHTML = '<div class="position-display-wrap" onclick="document.getElementById(\\'filter\\').style.display=\\'block\\'"><div class="place"><span class="location-name">Ottawa</span></div></div>';
      }, 350);
    </script>
  `);
  const ctrlA=createLocationControl(page,{mode:'none',name:''},{platform:'tencent',waitMs:2000});
  const resA=await ctrlA.apply();
  assert.equal(resA.value,'');
  assert.equal(await page.evaluate(()=>window.__refreshClicks || 0),0,'绝不能点击重新定位');
  assert.equal(await page.locator('.location-name').innerText(),'不显示位置');

  // 场景 B：持续“暂无可用位置”，绝不点重新定位，且后续若突然冒出城市 read() 必须拦住
  await page.setContent(`
    <div class="post-position-wrap">
      <div class="position-display" id="disp">
        <div class="input-location"><div class="placeholder">暂无可用位置</div><a class="refresh-coords" onclick="window.__refreshClicksB=(window.__refreshClicksB||0)+1">重新定位</a></div>
      </div>
    </div>
  `);
  const ctrlB=createLocationControl(page,{mode:'none',name:''},{platform:'tencent',waitMs:400});
  const resB=await ctrlB.apply();
  assert.equal(resB.value,'');
  assert.equal(resB.evidence,'tencent_no_available_location');
  assert.equal(await page.evaluate(()=>window.__refreshClicksB || 0),0);
  await page.locator('#disp').evaluate(el=>{el.innerHTML='<div class="position-display-wrap"><div class="place"><span class="location-name">Ottawa</span></div></div>';});
  await assert.rejects(()=>ctrlB.read(),/仍带有作品定位/);
 });
 await t.test('指定地点须选择唯一原生候选，读回正确后才算完成',async()=>{
  await page.setContent('<input role="combobox" aria-label="地点"><div role="option" onclick="document.querySelector(\'input\').value=\'人民广场\';this.remove()">人民广场</div>');
  const control=createLocationControl(page,{mode:'place',name:'人民广场'});assert.equal((await control.apply()).value,'人民广场');
 });
 await t.test('多个同名候选不能随意取第一条',async()=>{
  await page.setContent('<input role="combobox" aria-label="地点"><div role="option">人民广场</div><div role="option">人民广场</div>');
  await assert.rejects(()=>createLocationControl(page,{mode:'place',name:'人民广场'},{waitMs:150}).apply(),/唯一/);
 });
 await t.test('只输入搜索文字且候选未完成选择不能冒充已添加',async()=>{
  await page.setContent('<input role="combobox" aria-label="地点"><div role="option">人民广场</div>');
  await assert.rejects(()=>createLocationControl(page,{mode:'place',name:'人民广场'},{waitMs:150}).apply(),/搜索文字/);
 });
 await t.test('没有添加入口、没有可清除选项或识别不唯一时停止',async()=>{
  await page.setContent('<p>视频表单</p>');await assert.rejects(()=>createLocationControl(page,{mode:'place',name:'人民广场'}).apply(),/尚未提供/);
  await page.setContent('<input role="combobox" aria-label="地点" value="旧地点">');await assert.rejects(()=>createLocationControl(page,{mode:'none',name:''},{waitMs:150}).apply(),/没有可核对的清除选项/);
  await page.setContent('<input role="combobox" aria-label="地点"><input role="combobox" aria-label="地点">');await assert.rejects(()=>createLocationControl(page,{mode:'none',name:''}).apply(),/不唯一/);
 });
 await t.test('停止发生在候选等待期间时，不能再点击候选',async()=>{
  await page.setContent('<input role="combobox" aria-label="地点" oninput="window.__searchStarted=true">');
  let stopped=false;const control=createLocationControl(page,{mode:'place',name:'人民广场'},{assertRunning(){if(stopped)throw new Error('已停止');}});
  const outcome=control.apply().then(value=>({value}),error=>({error}));
  await page.waitForFunction(()=>window.__searchStarted===true);stopped=true;
  await page.evaluate(()=>{const candidate=document.createElement('div');candidate.setAttribute('role','option');candidate.textContent='人民广场';candidate.onclick=()=>{window.__clicked=true;};document.body.append(candidate);});
  assert.match((await outcome).error.message,/已停止/);assert.equal(await page.evaluate(()=>window.__clicked),undefined);
 });
});
