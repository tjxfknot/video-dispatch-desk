'use strict';
// 视频号助手 2026-11-11 实测页面有两层 body（外层导航、内层内容，均带 data-ml-root）。
// 登录与身份识别必须把两层一起读，不能因 Playwright 严格模式报错而失败。
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {browserAvailability,createPageDriver}=require('../app/core/browser-driver.cjs');
const available=browserAvailability().find(b=>b.available);
const HOME='https://channels.weixin.qq.com/platform',LOGIN='https://channels.weixin.qq.com/login.html';
const layer=(inner,mode)=>mode==='shadow'
  ?`<body data-ml-root="true" class="__finder-page"><nav>视频号 · 助手 首页 内容管理</nav><div id="host"></div><script>{const html=document.createElement('html'),body=document.createElement('body');body.setAttribute('data-ml-root','true');body.innerHTML=${JSON.stringify(inner)};html.append(body);host.attachShadow({mode:'open'}).append(html);}</script></body>`
  :`<body data-ml-root="true" class="__finder-page"><nav>视频号 · 助手 首页 内容管理</nav><div id="layer"></div><script>{const body=document.createElement('body');body.setAttribute('data-ml-root','true');body.innerHTML=${JSON.stringify(inner)};layer.append(body);}</script></body>`;
for(const mode of ['shadow','light']){
  test(`视频号两层 body（${mode}）：内层的账号号与扫码登录都能识别，请求全部本机合成`,{skip:!available,timeout:30000},async t=>{
    const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
    const context=await browser.newContext({serviceWorkers:'block'}),requests=[];
    let homeHtml=layer('<p>视频号ID：synthetic_tencent123</p>',mode);
    await context.route('**/*',route=>{const url=route.request().url();requests.push(url);
      if(url===HOME)return route.fulfill({contentType:'text/html; charset=utf-8',body:homeHtml});
      if(url===LOGIN)return route.fulfill({contentType:'text/html; charset=utf-8',body:layer('<button>微信扫码登录</button>',mode)});
      return route.abort();});
    const page=await context.newPage();await page.goto(HOME);
    assert.equal(await page.locator('body').count(),2);
    const driver=createPageDriver({context,page,platform:'tencent',settleMs:500});
    const seen=await driver.read();
    assert.equal(seen.state,'identified');assert.equal(seen.identity.platformAccountId,'synthetic_tencent123');
    await page.goto(LOGIN);
    assert.equal((await driver.read()).state,'awaiting_login');
    assert.deepEqual([...new Set(requests)].sort(),[HOME,LOGIN].sort());
  });
}
