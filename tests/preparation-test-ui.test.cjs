'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
const available=require('../app/core/browser-driver.cjs').browserAvailability().find(b=>b.available);
const productRoot=process.env.DISPATCH_TEST_PRODUCT_ROOT || path.resolve(__dirname,'..');
test('诊断入口界面：默认离线、真实上传需核对、无发布按钮',{skip:!available,timeout:30000},async t=>{
  const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:1000}});await context.route('**/*',r=>r.abort());
  async function fixture(realReady=false){
    const page=await context.newPage(),calls=[],sessions=[];
    page.setDefaultTimeout(5000);
    await page.exposeFunction('testBridge',async(method,input)=>{
      calls.push({method,input});
      if(method==='list')return {realReady,sessions:structuredClone(sessions)};
      if(method==='review')return {fingerprint:'pinned-review',accountDisplay:'指定测试账号 · 合成抖音号',title:input.common.title};
      if(method==='start'){
        const session={id:'synthetic-session',mode:input.mode,accountDisplay:'合成账号',status:'paused',message:'上传完成，已暂停',events:[]};sessions.unshift(session);return session;
      }
      if(method==='read'){sessions[0].location={value:'',mode:'none'};return sessions[0];}
      if(method==='stop'){sessions[0].status='stopped';return sessions[0];}
      throw new Error('测试界面不能调用此动作');
    });
    await page.route('https://diagnostics.test/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<button id="preparation-test-open">诊断与测试</button>'}));
    await page.goto('https://diagnostics.test/');
    assert.equal(await page.locator('#preparation-test-open').textContent(),'诊断与测试');
    await page.addStyleTag({path:path.join(productRoot,'app/renderer/styles.css')});
    await page.evaluate(()=>{
      window.publisher={listPreparationTests:()=>window.testBridge('list'),reviewPreparationTest:d=>window.testBridge('review',d),startPreparationTest:i=>window.testBridge('start',i),readPreparationLocation:id=>window.testBridge('read',id),stopPreparationTest:id=>window.testBridge('stop',id),onUpdate:()=>{}};
      window.draft={common:{title:'原测试任务'},targets:[{enabled:true,platform:'douyin'}]};
    });
    await page.addScriptTag({path:path.join(productRoot,'app/renderer/preparation-test-ui.js')});
    await page.evaluate(()=>window.PreparationTestUI.create({publisher:window.publisher,getDraft:()=>structuredClone(window.draft)}));
    await page.getByRole('button',{name:'诊断与测试',exact:true}).click();
    return {page,calls,sessions};
  }
  await t.test('默认离线只走测试接口，完成后只读核对并结束',async()=>{
    const f=await fixture();
    assert.equal(await f.page.locator('#preparation-test-mode').inputValue(),'offline');
    await f.page.getByRole('button',{name:'开始离线模拟',exact:true}).click();
    await f.page.getByRole('button',{name:'只读核对定位',exact:true}).click();
    await f.page.getByText('定位回读：不添加地点',{exact:true}).waitFor();
    assert.equal(f.calls.filter(c=>c.method==='start').length,1);assert.equal(f.calls.find(c=>c.method==='start').input.mode,'offline');
    assert.equal(await f.page.getByRole('button',{name:/确认发布|自动发布|提交发布/}).count(),0);
    const out=path.join(require('node:os').tmpdir(),'dispatch-prep-ui-test.png');await f.page.screenshot({path:out});try{fs.unlinkSync(out);}catch{}
    await f.page.getByRole('button',{name:'结束此测试会话',exact:true}).click();await f.page.getByRole('heading',{name:'离线模拟 · 测试已结束'}).waitFor();await f.page.close();
  });
  await t.test('无明确测试账号范围时禁用真实准备，保持离线可用',async()=>{
    const f=await fixture();await f.page.locator('#preparation-test-mode').selectOption('real_prepare');
    assert.equal(await f.page.locator('#preparation-test-start').isDisabled(),true);assert.equal(f.calls.some(c=>c.method==='start'),false);
    await f.page.locator('#preparation-test-mode').selectOption('offline');assert.equal(await f.page.locator('#preparation-test-start').isEnabled(),true);await f.page.close();
  });
  await t.test('真实准备先核对固定任务快照，确认前不开始，不能静默跟随编辑变化',async()=>{
    const f=await fixture(true);await f.page.locator('#preparation-test-mode').selectOption('real_prepare');
    await f.page.getByRole('button',{name:'核对本次账号与素材',exact:true}).click();await f.page.getByRole('heading',{name:'确认真实上传准备'}).waitFor();
    assert.equal(f.calls.some(c=>c.method==='start'),false);await f.page.evaluate(()=>window.draft.common.title='编辑后的另一个任务');
    await f.page.getByRole('button',{name:'确认上传，到视频完成后暂停',exact:true}).click();
    await f.page.getByRole('button',{name:'只读核对定位',exact:true}).waitFor();
    const input=f.calls.find(c=>c.method==='start').input;assert.equal(input.draft.common.title,'原测试任务');assert.equal(input.authorization.action,'prepare_test');assert.equal(input.authorization.fingerprint,'pinned-review');await f.page.close();
  });
});
