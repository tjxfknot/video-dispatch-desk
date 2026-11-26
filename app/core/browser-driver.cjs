'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { browserPlatform, allowedNavigation, isIdentityPage, isLoginPage, parseIdentity, observationFromPage } = require('./browser-platforms.cjs');
const { browserFailure } = require('./browser-errors.cjs');
const HOME = browserPlatform('douyin').home;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Prevent Chromium from throttling timers, SPA hydration, or read-only receipt
// API fetches when multiple platform browser windows overlap on macOS/Windows.
// Keeps chromiumSandbox: true and all security/navigation boundaries intact.
const BACKGROUND_THROTTLE_ARGS = Object.freeze([
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
]);

function browserAvailability(platform = process.platform, env = process.env, exists = fs.existsSync) {
  const winBases = platform === 'win32'
    ? [...new Set([env.PROGRAMFILES, env.ProgramFiles, env['PROGRAMFILES(X86)'], env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.LocalAppData].filter(Boolean))]
    : [];
  const locations = platform === 'darwin' ? {
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
    msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', path.join(env.HOME || '', 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')]
  } : platform === 'win32' ? Object.fromEntries([
    ['chrome', 'Google/Chrome/Application/chrome.exe'], ['msedge', 'Microsoft/Edge/Application/msedge.exe']
  ].map(([kind, tail]) => [kind, winBases.map(base => path.join(base, tail))])) : { chrome: [], msedge: [] };
  return ['chrome', 'msedge'].map(id => ({ id, label: id === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', available: locations[id].some(exists) }));
}

function profileDirectory(root, id) {
  if (!path.isAbsolute(root) || !UUID.test(id)) throw new Error('专属浏览器目录参数无效。');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('专属浏览器目录不能是符号链接。');
  const base = fs.realpathSync(root);
  const target = path.join(base, id);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('账号目录不能是符号链接。');
  fs.mkdirSync(target, { mode: 0o700, recursive: true });
  if (path.dirname(fs.realpathSync(target)) !== base) throw new Error('账号目录超出工作台范围。');
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o700); fs.chmodSync(target, 0o700); }
  return target;
}

async function routeManagedRequest(route, platform) {
  try {
    const request=route.request();
    if(request.isNavigationRequest()){
      // Popups and closing tabs can issue navigation before a frame exists.
      // Unverifiable navigation is aborted, rather than throwing an unhandled
      // rejection or dropping the platform navigation restriction.
      const frame=request.frame();
      if(!frame || (frame.parentFrame()===null && !allowedNavigation(request.url(),platform))){await route.abort();return;}
    }
    await route.continue();
  } catch {await route.abort().catch(()=>{});}
}

// Browser control belongs to this local product, independent of any AI host.
// This driver never imports a normal Chrome profile or exports session data.
async function launchBrowser({ environment, platform = environment.platform || 'douyin', profilesRoot, preferHome = false, onClosed = () => {}, onReadPage = () => {} }) {
  const config = browserPlatform(platform);
  if (environment.platform && environment.platform !== platform) throw new Error('专属浏览器平台不一致。');
  if (!['chrome', 'msedge'].includes(environment.browserKind)) throw new Error('浏览器类型不受支持。');
  if (!browserAvailability().find(b => b.id === environment.browserKind)?.available) throw new Error('未检测到所选浏览器，请先从官方渠道安装后重试。');
  const { chromium } = require('playwright-core');
  const context = await chromium.launchPersistentContext(profileDirectory(profilesRoot, environment.id), {
    channel: environment.browserKind, headless: false, chromiumSandbox: true, viewport: null,
    acceptDownloads: false, serviceWorkers: 'block', timeout: 30_000,
    args: [...BACKGROUND_THROTTLE_ARGS],
  });
  const readOwnIdentity = require('./browser-self-identity.cjs').observeSelfIdentity(context, platform);
  const pageDiagnostics=new WeakMap();
  let closed = false;
  let page;
  context.on('close', () => { closed = true; onClosed(); });
  const trackPage=target=>{
    if(pageDiagnostics.has(target))return;
    const data={documents:[],runtimeErrors:[],resourceErrors:[]};pageDiagnostics.set(target,data);
    const reference=value=>{try{const u=new URL(value);return {origin:u.origin,path:u.pathname.replace(/[a-f0-9]{24,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi,'[id]')};}catch{return {};}};
    target.on('pageerror',error=>{if(data.runtimeErrors.length<8)data.runtimeErrors.push({type:error.name,message:String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[官方资源]').replace(/[a-f0-9]{24,}/gi,'[id]').slice(0,240)});});
    target.on('response',response=>{
      try{
      const request=response.request(),type=request.resourceType();
      if(request.isNavigationRequest() && request.frame()===target.mainFrame()){
        const item={...reference(response.url()),status:response.status(),contentType:response.headers()['content-type'] || ''};
        data.documents.push(item);if(data.documents.length>4)data.documents.shift();
        response.body().then(body=>{item.bodyBytes=body.length;}).catch(()=>{item.bodyUnavailable=true;});
      }else if(response.status()>=400 && ['script','stylesheet'].includes(type) && data.resourceErrors.length<12)data.resourceErrors.push({...reference(response.url()),type,status:response.status()});
      }catch{ /* Detached response diagnostics must not interrupt the browser. */ }
    });
    // 2026-11-22 macOS 实测：用户点窗口红叉关掉全部标签页后，Chrome 进程仍留在后台占着登录目录，
    // 导致工作台“关闭浏览器”置灰、重开报占用。最后一个页面关闭时主动关闭 context 释放进程与目录锁。
    target.on('close',()=>{
      if(!closed && context.pages().length===0){
        context.close().catch(()=>{});
      }
    });
  };
  context.on('page',trackPage);context.pages().forEach(trackPage);
  try {
    await context.route('**/*', route => routeManagedRequest(route,platform));
    page = context.pages()[0] || await context.newPage();
    // 禁止平台页弹出浏览器地理位置权限气泡，避免遮挡表单或泄露位置。
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Browser.setPermission', { origin: config.origin, permission: { name: 'geolocation' }, setting: 'denied' });
      await cdp.detach().catch(() => {});
    } catch {}
    await page.goto(preferHome ? config.home : config.entry, { waitUntil: 'commit', timeout: 30_000 });
    return createPageDriver({ context, page, platform, isClosed: () => closed,onReadPage,readOwnIdentity,getPageDiagnostics:target=>pageDiagnostics.get(target) || null });
  } catch (error) {
    onReadPage({url:page?.url() || 'about:blank',text:'',loginVisible:false,navigationFailed:true,errorCode:error.message?.match(/(?:net::)?ERR_[A-Z_]+/)?.[0] || ''});
    await context.close().catch(() => {});
    throw error;
  }
}


function createPageDriver({ context, page, platform, isClosed = () => false,
  serverCheckMs = 300_000, now = Date.now, settleMs = 30_000,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),onReadPage = () => {},readOwnIdentity = async () => null,getPageDiagnostics = () => null }) {
  const config = browserPlatform(platform);
  const initialPage = page;
  let serverCheckedAt = now();
  let ownedIdentityPage = null;
  let previouslyIdentified = false;
  let lastFreshFailure = null;
    const readPage = async (targetPage = page) => {
      if (isClosed() || targetPage.isClosed()) throw new Error('专属浏览器已关闭。');
      const url = targetPage.url();
      if (!allowedNavigation(url, platform)) {
        onReadPage({url,text:'',loginVisible:false});
        return { identity: null, state: 'unverifiable', message: url==='about:blank' ? '官方账号页面尚未打开，当前为空白页；请重新打开官方页面，原登录环境保留。' : '当前不是允许的官方页面。' };
      }
      // A missing body keeps the old bounded TimeoutError path in stableRead.
      // Pages with two body layers (视频号助手) are read as a whole instead of
      // failing Playwright's strict single-element rule.
      await targetPage.locator('body').first().waitFor({ state: 'attached', timeout: 5000 });
      const visible = await targetPage.locator('body').evaluateAll((bodies, currentPlatform) => {
        if (!bodies.length) return null;
        const roots = bodies.filter(b => !b.parentElement?.closest('body'));
        const body = { innerText: roots.map(b => b.innerText || '').join('\n'), querySelectorAll: selector => roots.flatMap(b => [...b.querySelectorAll(selector)]) };
        const shown = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
        const loginVisible = [...body.querySelectorAll('button,label,h1,h2,h3,[role="tab"],[role="button"]')]
          .some(el => shown(el) && ['扫码登录', '微信扫码登录', '微信登录', '手机号登录', '短信登录', '二维码已失效', '二维码失效'].includes((el.innerText || '').trim()))
          || [...body.querySelectorAll('img[aria-label="二维码"],#animate_qrcode_container img,[class*="scan_qrcode_login_content"]')].some(shown)
          || (currentPlatform==='xiaohongshu' && [...body.querySelectorAll('.login-box-container')].some(shown));
        const loginFrame = [...body.querySelectorAll('iframe')].some(el => {
          if (!shown(el)) return false;
          try { const u = new URL(el.src); return ['open.weixin.qq.com', 'mp.weixin.qq.com'].includes(u.hostname) && /qrconnect|login/.test(u.pathname); } catch { return false; }
        });
        let profileHeaderText = '';
        if (currentPlatform === 'douyin' && location.pathname.replace(/\/$/,'') === '/creator-micro/home') {
          const candidates = [...body.querySelectorAll('div,section,header')].filter(shown).map(el => String(el.innerText || '').trim())
            .filter(text => text.length < 1500 && /抖音(?:号|[ \t]*ID)\s*[:：]/.test(text)
              && /关注\s*\d/.test(text) && /粉丝\s*\d/.test(text) && /获赞\s*\d/.test(text));
          // A parent wrapper and its child can represent the same header.
          // Only small profile sections with the three own-account counters
          // qualify; broad page text and message widgets do not qualify.
          candidates.sort((a,b)=>a.length-b.length);
          // Retain all distinct matching sections so conflicting account IDs
          // cannot be hidden by picking one convenient shortest candidate.
          profileHeaderText = [...new Set(candidates)].join('\n').slice(0, 150_000);
        }
        return { url: location.href, text: String(body.innerText || '').slice(0, 150_000), loginVisible: loginVisible || loginFrame, profileHeaderText };
      }, platform);
      // The document was replaced between the wait and the read; let
      // stableRead retry it like any other still-loading page.
      if (!visible) { const error = new Error('页面正文尚未载入。'); error.name = 'TimeoutError'; throw error; }
      const own = !visible.loginVisible && isIdentityPage(visible.url,platform) ? await readOwnIdentity(targetPage) : null;
      if (own?.identity) visible.authenticatedOwnIdentity = own.identity;
      if (own?.evidence) visible.selfIdentityEvidence = own.evidence;
      onReadPage(visible);
      if (targetPage.url() !== url) return { identity: null, state: 'checking', message: '页面正在切换，等待稳定后重新识别。' };
      if (isLoginPage(visible.url,platform) && !visible.loginVisible
        && !/扫码登录|手机号登录|短信登录|微信登录|二维码已失效/.test(visible.text)) {
        return {identity:null,state:'checking',message:'官方页面仍在恢复登录状态，正在等待页面完成跳转。'};
      }
      return observationFromPage(visible, platform);
    };

  const stableRead = async (targetPage = page) => {
    const deadline = now() + settleMs;
    let result,lastError;
    do {
      try {result=await readPage(targetPage);lastError=null;if(result.state!=='checking')return result;}
      catch(error){
        // A newly committed document may not yet have a body, or may still
        // replace its execution context. Retry only these loading states,
        // within the same bounded identity wait; never reuse an old result.
        if(isClosed() || targetPage.isClosed() || !(error.name==='TimeoutError' || /Execution context was destroyed|Cannot find context/.test(error.message)))throw error;
        lastError=error;
      }
      if(now()>=deadline){if(lastError)throw lastError;return result;}
      await pause(250);
    }while(true);
  };
  const read = async ({ fresh = false, passive = false } = {}) => {
    let operation = 'read_current';
    try {
    if (page.isClosed() && !initialPage.isClosed()) { page = initialPage; serverCheckedAt = 0; }
    if (passive) {
      if (lastFreshFailure) return { ...lastFreshFailure, serverCheckedAt:0 };
      try { return { ...await readPage(), serverCheckedAt }; }
      catch(error) {
        if (!isClosed() && !page.isClosed() && (error.name==='TimeoutError' || /Execution context was destroyed|Cannot find context/.test(error.message))) {
          return {identity:null,state:'checking',message:'登录页面正在切换，继续等待原窗口；不会另开页面。',serverCheckedAt:0};
        }
        throw error;
      }
    }
    if (fresh) lastFreshFailure = null;
    let result, needsRecovery = false;
    try { result = fresh || (previouslyIdentified && platform !== 'douyin') ? await readPage() : await stableRead(); }
    catch (error) {
      // A SPA can destroy its old execution context during a login redirect.
      // For an explicit check of an official identity URL, obtain an entirely
      // new server document rather than failing on that old tab's DOM.
      if (platform !== 'douyin' && isIdentityPage(page.url(),platform)) {result = {state:'checking',identity:null};needsRecovery=true;}
      else throw error;
    }
    if (previouslyIdentified && platform !== 'douyin' && ['checking','unverifiable'].includes(result.state)) needsRecovery = true;
    // Never regenerate a login QR code automatically. While open, check the
    // server at most once per five minutes; explicit preflight always checks.
    if ((fresh || needsRecovery || now() - serverCheckedAt >= serverCheckMs)
      && result.state !== 'awaiting_login' && result.state !== 'error') {
      serverCheckedAt = 0;
      // The creator page can leave document loading pending after the new
      // response and own-account header are present. Wait for a new server
      // document, then independently wait for the rendered identity. Never
      // fall back to the old page when navigation itself fails.
      if (platform === 'douyin' && isIdentityPage(page.url(), platform)) {
        operation = 'open_identity';
        const response = await page.reload({ waitUntil: 'commit', timeout: 30_000 });
        if(!response || response.status()<200 || response.status()>=400){const error=new Error('官方账号页面未取得有效的本次服务器响应。');error.httpStatus=response?.status();throw error;}
        operation = 'read_identity';
        result = await stableRead();
        serverCheckedAt = now();
      } else {
        // Keep the user's original tab until a new official document succeeds.
        // A failed probe must never replace it with about:blank or be reused as
        // proof of a successful login. Only this newly-created tab may be closed.
        operation = 'open_identity';
        // 复用工作台自己的那一个校验页：在同一标签页里重新向服务器取首页，
        // 不再每次新开一页、再关掉上一页。用户自己的原窗口仍然不动。
        const reuse = !!ownedIdentityPage && !ownedIdentityPage.isClosed();
        const probe = reuse ? ownedIdentityPage : await context.newPage();
        try {
          const response = await probe.goto(config.home, { waitUntil: 'commit', timeout: 30_000 });
          if(!response || response.status()<200 || response.status()>=400){const error=new Error('官方账号页面未取得有效的本次服务器响应。');error.httpStatus=response?.status();throw error;}
          operation = 'read_identity';
          const freshResult = await stableRead(probe);
          if(!allowedNavigation(probe.url(),platform))throw new Error('官方账号校验页未成功打开，原窗口和登录环境保留。');
          if (freshResult.state !== 'identified') {
            // 校验页未识别不等于原已登录页退出；不切换当前页，更不循环开页。
            lastFreshFailure = { identity:null, state:freshResult.state==='error'?'error':'unverifiable',
              message:'本次校验页未能确认当前账号，已停止自动重试。原绑定和已打开窗口保留，请在原窗口核对后手动检查一次。' };
            // 复用的校验页留着不关，免得又是一开一关；它不会被当成登录成功的依据。
            if (!reuse) await probe.close().catch(()=>{});
            return { ...lastFreshFailure, serverCheckedAt:0 };
          }
          // Fresh verification uses a separate server document. Never reload
          // the user's signed-in SPA or editor just to confirm the same ID.
          const previousProbe = ownedIdentityPage;
          page = probe;
          ownedIdentityPage = probe;
          result = freshResult;
          serverCheckedAt = now();
          if (previousProbe && previousProbe !== probe) await previousProbe.close().catch(()=>{});
        } catch(error) {
          error.connectionStage = operation;
          onReadPage({url:probe.url(),text:'',loginVisible:false,navigationFailed:true,failure:browserFailure(error,operation)});
          if (!reuse) await probe.close().catch(()=>{});
          throw error;
        }
      }
    }
    previouslyIdentified = result.state === 'identified';
    return { ...result, serverCheckedAt };
    } catch (error) {
      lastFreshFailure = { identity:null, state:'unverifiable', message:'本次账号检查失败，已停止自动重试；原绑定和登录窗口保留。' };
      error.connectionStage = operation;
      onReadPage({url:page.url(),text:'',loginVisible:false,navigationFailed:true,failure:browserFailure(error,operation)});
      throw error;
    }
  };
  return {
    read,
    createPublisher: options => {
      // Re-read the local adapter between development attempts, keeping the
      // same owned browser context and its login. Packaged app code is fixed.
      const file = require.resolve(platform==='douyin'?'./douyin-publish-driver.cjs':'./native-publish-driver.cjs');
      let isPackaged = false;
      try { isPackaged = Boolean(require('electron').app?.isPackaged); } catch {}
      if (!isPackaged) delete require.cache[file];
      return platform==='douyin'?require(file).createDouyinPublisher({context,...options}):require(file).createNativePublisher({context,platform,entryPage:initialPage,getPageDiagnostics,...options});
    },
    getContext: () => context,
    getPage: () => (!page.isClosed() ? page : initialPage),
    focus: async () => { const target = !initialPage.isClosed() ? initialPage : page; if (isClosed() || target.isClosed()) throw new Error('专属浏览器已关闭。'); await target.bringToFront(); },
    close: () => context.close(), isOpen: () => !isClosed() && (!page.isClosed() || !initialPage.isClosed())
  };
}

module.exports = { HOME, BACKGROUND_THROTTLE_ARGS, browserAvailability, profileDirectory, parseIdentity, observationFromPage, allowedNavigation, launchBrowser, createPageDriver, routeManagedRequest };
