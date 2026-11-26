'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createFocusCoordinator } = require('../app/core/focus-coordinator.cjs');
const { BACKGROUND_THROTTLE_ARGS, browserAvailability } = require('../app/core/browser-driver.cjs');
const { ManagedBrowsers } = require('../app/core/managed-browser.cjs');
const { createDouyinPublisher, measureCoverPixels, coverPixelsMatch } = require('../app/core/douyin-publish-driver.cjs');
const { createNativePublisher } = require('../app/core/native-publish-driver.cjs');

const available = browserAvailability().find(b => b.available);

test('focusCoordinator 严格串行化跨平台焦点临界区，异常与中止均不死锁', async () => {
  const coordinator = createFocusCoordinator();
  const trace = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const task = (name, ms, shouldThrow = false) => coordinator.runExclusive(name, async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    trace.push(`enter:${name}`);
    await new Promise(r => setTimeout(r, ms));
    trace.push(`exit:${name}`);
    inFlight--;
    if (shouldThrow) throw new Error(`boom:${name}`);
    return name;
  });

  const ac = new AbortController();
  const p1 = task('douyin', 40, false);
  const pAborted = coordinator.runExclusive('tencent', async () => {
    trace.push('enter:tencent');
    return 'tencent';
  }, { signal: ac.signal });
  const p2 = task('xiaohongshu', 20, true);
  const p3 = task('douyin-2', 10, false);

  assert.equal(coordinator.activeOwner(), 'douyin');
  assert.equal(coordinator.queueLength(), 3);
  ac.abort();

  await assert.rejects(pAborted, /已取消/);
  assert.equal(await p1, 'douyin');
  await assert.rejects(p2, /boom:xiaohongshu/);
  assert.equal(await p3, 'douyin-2');

  assert.equal(maxConcurrent, 1);
  assert.equal(coordinator.activeOwner(), null);
  assert.equal(coordinator.queueLength(), 0);
  assert.deepEqual(trace, [
    'enter:douyin', 'exit:douyin',
    'enter:xiaohongshu', 'exit:xiaohongshu',
    'enter:douyin-2', 'exit:douyin-2',
  ]);
});

test('browser-driver 启动参数禁用后台与遮挡节流且不关闭沙盒', () => {
  assert.ok(BACKGROUND_THROTTLE_ARGS.includes('--disable-background-timer-throttling'));
  assert.ok(BACKGROUND_THROTTLE_ARGS.includes('--disable-renderer-backgrounding'));
  assert.ok(BACKGROUND_THROTTLE_ARGS.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(BACKGROUND_THROTTLE_ARGS.includes('--disable-features=CalculateNativeWinOcclusion'));
  assert.equal(BACKGROUND_THROTTLE_ARGS.some(arg => /no-sandbox/i.test(arg)), false);
});

test('ManagedBrowsers 向并发多平台执行器注入同一个共享 focusCoordinator', async t => {
  const model = require('../app/core/accounts.cjs');
  const seen = [];
  let value = { schemaVersion: 1 };
  const store = {
    load: () => structuredClone(value),
    update: fn => { const next = structuredClone(value); fn(next); value = next; return structuredClone(next); },
  };
  model.ensureAccountState(store);
  const teacher = model.saveTeacher(store, { name: '测试老师' });
  const accDy = model.saveManagedAccount(store, { teacherId: teacher.id, platform: 'douyin', label: '抖音测试号' });
  const accXhs = model.saveManagedAccount(store, { teacherId: teacher.id, platform: 'xiaohongshu', label: '小红书测试号' });
  const browsers = new ManagedBrowsers({
    store,
    profilesRoot: os.tmpdir(),
    availability: () => [{ id: 'chrome', label: 'Chrome', available: true }],
    pollMs: 1_000_000,
    launch: async ({ platform }) => ({
      isOpen: () => true,
      close: async () => {},
      focus: async () => {},
      read: async () => ({
        state: 'identified',
        identity: { platformAccountId: platform === 'douyin' ? 'dy_test' : 'xhs_test', displayName: 'test' },
        serverCheckedAt: Date.now(),
      }),
      createPublisher: opts => {
        seen.push({ platform, coordinator: opts.focusCoordinator });
        return { platform, focusCoordinator: opts.focusCoordinator };
      },
    }),
  });
  t.after(() => browsers.closeAll());

  await browsers.open({ accountId: accDy.id, browserKind: 'chrome', autoBind: true });
  await browsers.open({ accountId: accXhs.id, browserKind: 'chrome', autoBind: true });
  const freshAccounts = store.load().accounts;
  const boundDy = freshAccounts.find(a => a.id === accDy.id);
  const boundXhs = freshAccounts.find(a => a.id === accXhs.id);

  const dyPub = await browsers.publisherFor({
    accountId: boundDy.id,
    teacherId: teacher.id,
    expectedBinding: boundDy.binding,
  }, { onVerifyFiles: async () => {} });
  const xhsPub = await browsers.publisherFor({
    accountId: boundXhs.id,
    teacherId: teacher.id,
    expectedBinding: boundXhs.binding,
  }, { onVerifyFiles: async () => {} });

  assert.equal(seen.length, 2);
  assert.ok(seen[0].coordinator && typeof seen[0].coordinator.runExclusive === 'function');
  assert.equal(seen[0].coordinator, seen[1].coordinator);
  assert.equal(dyPub.focusCoordinator, xhsPub.focusCoordinator);
});

test('2026-11-21 抖音双封面回归：高对比白字测试图区域均值采样通过（含跨域截图兜底遮罩隐藏），错图仍拒绝并落盘误差诊断', { skip: !available, timeout: 90_000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdd-dy-cover-reg-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const browser = await chromium.launch({ channel: available.id, headless: true });
  t.after(() => browser.close());

  // 生成模拟 2026-11-21 真实测试图的暗绿底白字高对比竖/横封面，并构造一个完全不同的错图
  const assetPage = await browser.newPage();
  const rendered = await assetPage.evaluate(() => {
    function makeCover(w, h, bg, lines) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e8ecea';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(Math.min(w, h) * 0.055)}px sans-serif`;
      const startY = h / 2 - ((lines.length - 1) * Math.round(Math.min(w, h) * 0.08)) / 2;
      lines.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * Math.round(Math.min(w, h) * 0.08)));
      return {
        pngBase64: c.toDataURL('image/png').split(',')[1],
        // 模拟抖音服务端重编码为较小尺寸 JPEG 预览图
        jpegPreview: (() => {
          const s = document.createElement('canvas');
          s.width = Math.round(w / 4); s.height = Math.round(h / 4);
          s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
          return s.toDataURL('image/jpeg', 0.82);
        })(),
      };
    }
    const lines = ['视频发布台', '真实流程测试', '无业务内容', '2026年11月6日'];
    return {
      portrait: makeCover(900, 1200, '#184237', lines),
      landscape: makeCover(1200, 900, '#184237', lines),
      wrong: makeCover(900, 1200, '#a83232', ['错误封面']),
    };
  });
  await assetPage.close();

  const videoPath = path.join(tmp, 'clip.mp4');
  const portraitPath = path.join(tmp, 'portrait.png');
  const landscapePath = path.join(tmp, 'landscape.png');
  fs.writeFileSync(videoPath, Buffer.alloc(64, 1));
  fs.writeFileSync(portraitPath, Buffer.from(rendered.portrait.pngBase64, 'base64'));
  fs.writeFileSync(landscapePath, Buffer.from(rendered.landscape.pngBase64, 'base64'));

  async function runDouyinPrepare({ serveWrongPortrait = false, taintCanvas = false, hoverOverlayVisible = false, diagnosticsRoot = null, coverWaitOverride = false }) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const uploadUrl = 'https://creator.douyin.com/creator-micro/content/upload';
    const portPreviewBytes = Buffer.from((serveWrongPortrait ? rendered.wrong.jpegPreview : rendered.portrait.jpegPreview).split(',')[1], 'base64');
    const landPreviewBytes = Buffer.from(rendered.landscape.jpegPreview.split(',')[1], 'base64');

    await context.route('**/*', route => {
      const u = route.request().url();
      if (u === 'https://cdn-taint.example/portrait.jpg') {
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: portPreviewBytes });
      }
      if (u === 'https://cdn-taint.example/landscape.jpg') {
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: landPreviewBytes });
      }
      if (u !== uploadUrl) return route.abort();
      const portSrc = taintCanvas ? 'https://cdn-taint.example/portrait.jpg' : (serveWrongPortrait ? rendered.wrong.jpegPreview : rendered.portrait.jpegPreview);
      const landSrc = taintCanvas ? 'https://cdn-taint.example/landscape.jpg' : rendered.landscape.jpegPreview;
      const html = `<!doctype html><meta charset="utf-8"><style>
        .wrapper-NN3Jh1 { display: flex; gap: 12px; }
        .coverControl-CjlzqC { position: relative; }
        .cover-Jg3T4p { position: relative; height: 120px; width: 90px; cursor: pointer; overflow: hidden; }
        .coverControl-CjlzqC.land .cover-Jg3T4p { width: 160px; }
        .background-OpVteV { position: relative; width: 100%; height: 100%; }
        .background-OpVteV img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .filter-k_CjvJ { position: absolute; inset: 0; background: rgba(0,0,0,0.65); color: #fff; display: ${hoverOverlayVisible ? 'flex' : 'none'}; align-items: center; justify-content: center; z-index: 2; }
        .modal { position: fixed; inset: 20px; background: #fff; border: 1px solid #ccc; z-index: 9; padding: 12px; }
        .semi-upload.upload-BvM5FF { width: 120px; height: 40px; background: #184237; color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      </style>
      <input id="vfile" type="file" accept="video/mp4">
      <div id="form" hidden>
        <div id="reupload">重新上传</div>
        <video src="blob:synthetic-video"></video>
        <input placeholder="填写作品标题，为作品获得更多流量" value="">
        <div data-slate-editor="true" contenteditable="true" style="min-height:40px;border:1px solid #999"><div class="ace-line"><div data-line-wrapper="true"></div></div></div>
        <div class="toolbar-button-spPS4r">#添加话题</div>
        <div><span>请选择自主声明</span></div>
        <div id="decl-modal" hidden>
          <div>请选择声明类型（单选）</div>
          <label><input type="radio" name="decl">内容为个人观点或见解</label>
          <button id="decl-ok" type="button">确定</button>
        </div>
        <div id="decl-val" hidden>内容为个人观点或见解</div>
        <div>请选择合集</div>
        <label><input type="radio" name="vis" value="public">公开</label>
        <label><input type="radio" name="vis" value="friends">好友可见</label>
        <label><input type="radio" name="vis" value="self" checked>仅自己可见</label>
        <label><input type="radio" name="save" value="allow">允许</label>
        <label><input type="radio" name="save" value="deny" checked>不允许</label>
        <label><input type="radio" name="sched" value="now" checked>立即发布</label>
        <label><input type="radio" name="sched" value="later">定时发布</label>

        <div class="wrapper-NN3Jh1">
          <div class="coverControl-CjlzqC port" style="width:90px">
            <div class="cover-Jg3T4p" id="open-port">
              <div class="background-OpVteV" id="port-bg"></div>
              <div class="filter-k_CjvJ">编辑封面</div>
            </div>
            <div class="controlContainer-psV7_j"><div class="cover-tip-YkBvmu">竖封面3:4</div></div>
          </div>
          <div class="coverControl-CjlzqC land" style="width:160px">
            <div class="cover-Jg3T4p" id="open-land">
              <div class="background-OpVteV" id="land-bg"></div>
              <div class="filter-k_CjvJ">编辑封面</div>
            </div>
            <div class="controlContainer-psV7_j"><div class="cover-tip-YkBvmu">横封面4:3</div></div>
          </div>
        </div>
        <button type="submit">发布</button>
      </div>
      <div id="cover-modal" class="modal" hidden>
        <div id="preview-title"></div>
        <canvas id="editor-canvas" width="320" height="320"></canvas>
        <label class="semi-upload upload-BvM5FF">上传封面<input id="cfile" type="file" accept="image/png,image/jpeg" style="display:none"></label>
        <button id="cover-done" type="button">完成</button>
      </div>
      <script>
        let side = 'portrait';
        const canvas = document.getElementById('editor-canvas');
        const ctx = canvas.getContext('2d');
        function fillCanvas(color) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 320); }
        const slateEditor = document.querySelector('[data-slate-editor="true"]');
        slateEditor.addEventListener('input', () => {
          const text = slateEditor.textContent || '';
          slateEditor.innerHTML = '<div class="ace-line"><div data-line-wrapper="true"></div></div>';
          slateEditor.querySelector('[data-line-wrapper="true"]').textContent = text;
        });
        document.getElementById('vfile').onchange = () => { document.getElementById('form').hidden = false; };
        document.querySelectorAll('span').forEach(el => {
          if (el.textContent === '请选择自主声明') el.onclick = () => { document.getElementById('decl-modal').hidden = false; };
        });
        document.getElementById('decl-ok').onclick = () => {
          document.getElementById('decl-modal').hidden = true;
          document.getElementById('decl-val').hidden = false;
        };
        function openEditor(which) {
          side = which;
          document.getElementById('preview-title').textContent = which === 'portrait' ? '竖封面预览（3:4）' : '横封面预览（4:3）';
          fillCanvas('#444444');
          document.getElementById('cover-modal').hidden = false;
        }
        document.getElementById('open-port').onclick = () => openEditor('portrait');
        document.getElementById('open-land').onclick = () => openEditor('landscape');
        document.getElementById('cfile').onchange = e => {
          const f = e.target.files[0]; if (!f) return;
          const r = new FileReader();
          r.onload = () => {
            const img = new Image();
            img.onload = () => { ctx.drawImage(img, 0, 0, 320, 320); };
            img.src = r.result;
          };
          r.readAsDataURL(f);
        };
        document.getElementById('cover-done').onclick = () => {
          document.getElementById('cover-modal').hidden = true;
          if (side === 'portrait') {
            document.getElementById('port-bg').innerHTML = '<img src="${portSrc}">';
          } else {
            document.getElementById('land-bg').innerHTML = '<img src="${landSrc}">';
          }
        };
      </script>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    });

    const pub = createDouyinPublisher({
      context,
      verifyIdentity: async () => {},
      onVerifyFiles: async () => {},
      diagnosticsRoot,
      uploadWaitMs: 5000,
      coverWaitMs: serveWrongPortrait ? 1500 : 5000,
      quickCheckWaitMs: 0,
      allowSubmit: false,
      focusCoordinator: createFocusCoordinator(),
    });
    const job = {
      fingerprint: 'fp-dy-cover-' + (serveWrongPortrait ? 'wrong' : taintCanvas ? 'taint' : 'ok'),
      copy: { title: '抖音封面均值采样回归', description: '高对比白字测试图', tags: [] },
      declarationText: '内容为个人观点或见解',
      schedule: { mode: 'immediate' },
      settings: { visibility: 'self', savePermission: 'deny' },
      files: { video: { path: videoPath }, portrait: { path: portraitPath }, landscape: { path: landscapePath } },
      coverMode: 'custom',
    };
    try {
      const prepared = await pub.prepare(job, { onStep: () => {} });
      return { ok: true, prepared, overlayVis: await context.pages()[0].locator('.coverControl-CjlzqC.port .filter-k_CjvJ').evaluate(el => el.style.visibility) };
    } catch (error) {
      return { ok: false, error };
    } finally {
      await pub.stop();
      await context.close();
    }
  }

  // 1) 直读 img 路径：暗绿底白字高对比图通过严格阈值
  const direct = await runDouyinPrepare({});
  assert.equal(direct.ok, true, direct.error?.message);
  assert.equal(direct.prepared.checks.covers, true);

  // 2) 跨域污染降级到 img.screenshot() 且存在可见 .filter-k_CjvJ 悬停遮罩：截图瞬间临时隐藏并在之后恢复，像素比对通过
  const tainted = await runDouyinPrepare({ taintCanvas: true, hoverOverlayVisible: true });
  assert.equal(tainted.ok, true, tainted.error?.message);
  assert.equal(tainted.prepared.checks.covers, true);
  assert.equal(tainted.overlayVis, '');

  // 3) 错图端到端拒绝并落盘 coverReadback 误差诊断
  const wrongDiagDir = path.join(tmp, 'dy-wrong-cover-diag');
  const wrongRun = await runDouyinPrepare({ serveWrongPortrait: true, diagnosticsRoot: wrongDiagDir });
  assert.equal(wrongRun.ok, false);
  assert.match(wrongRun.error.message, /尚不能确认两张封面均已替换成功/);
  const diagJson = JSON.parse(fs.readFileSync(path.join(wrongDiagDir, '页面控件诊断.json'), 'utf8'));
  assert.equal(diagJson.coverReadback.portrait.matched, false);
  assert.ok(diagJson.coverReadback.portrait.meanAbsolutePixelError > 30);
  assert.equal(diagJson.coverReadback.landscape.matched, true);

  // 4) measureCoverPixels 纯函数核对：同图通过，错图严格拒绝且返回精确误差指标
  const solid = rgb => Array.from({ length: 256 }, () => rgb).flat();
  const okMetrics = measureCoverPixels(solid([24, 66, 55]), solid([25, 67, 56]));
  assert.equal(okMetrics.matched, true);
  assert.equal(okMetrics.closeRatio, 1);
  const badMetrics = measureCoverPixels(solid([24, 66, 55]), solid([168, 50, 50]));
  assert.equal(badMetrics.matched, false);
  assert.equal(coverPixelsMatch(solid([24, 66, 55]), solid([168, 50, 50])), false);
  assert.ok(badMetrics.meanAbsolutePixelError > 30);
});

test('2026-11-21 小红书并发回执回归：零响应停滞自愈、延迟建索引周期只读刷新、重试重建干净标签与只读诊断', { skip: !available, timeout: 45_000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdd-xhs-conc-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const browser = await chromium.launch({ channel: available.id, headless: true });
  t.after(() => browser.close());

  const realId = '000000000000000000000001';
  const nowBj = new Date(Date.now() + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  const nowTimeStr = `${nowBj.getUTCFullYear()}-${pad(nowBj.getUTCMonth() + 1)}-${pad(nowBj.getUTCDate())} ${pad(nowBj.getUTCHours())}:${pad(nowBj.getUTCMinutes())}`;
  const job = {
    fingerprint: 'fp-xhs-conc-1',
    platform: 'xiaohongshu',
    runCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    copy: { title: '三平台并发实测1121a', description: '', tags: [] },
    settings: { visibility: 'platform_default' },
  };

  // 场景 A：首次导航因后台遮挡/SPA停滞发出 0 次 posted，自动只读重进管理页后拿到唯一回执
  await t.test('零响应停滞时主动置前并重进管理页自愈取回 posted 回执', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let manageLoads = 0;
    await context.route('**/*', route => {
      const u = route.request().url();
      if (u === 'https://creator.xiaohongshu.com/new/note-manager') {
        manageLoads++;
        const script = manageLoads >= 2
          ? `<script>setTimeout(() => fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=0'), 30);</script>`
          : `<script>/* 模拟首次 SPA 停滞不发请求 */</script>`;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${script}<div>笔记管理</div>` });
      }
      if (u.includes('/api/galaxy/v2/creator/note/user/posted')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            code: 0,
            success: true,
            data: { page: 1, notes: [{ id: realId, display_title: job.copy.title, time: nowTimeStr, type: 'video', tab_status: 1, permission_code: 0, permission_msg: '', schedule_post_time: 0, video_info: { duration: 8 } }] },
          }),
        });
      }
      return route.abort();
    });

    const pub = createNativePublisher({
      context,
      platform: 'xiaohongshu',
      verifyIdentity: async () => {},
      waitMs: 3000,
      xhsEmptyReloadMs: 350,
      xhsReloadIntervalMs: 350,
      xhsMaxReloads: 3,
      focusCoordinator: createFocusCoordinator(),
    });
    try {
      const res = await pub.inspectResult(job);
      assert.equal(res.status, 'submitted');
      assert.equal(res.workId, realId);
      assert.equal(res.verification, 'creator_note_list_api');
      assert.ok(manageLoads >= 2, '应在零响应超时后触发只读重进管理页');
    } finally {
      await pub.stop();
      await context.close();
    }
  });

  // 场景 B：前两次 posted 均仅含旧稿（模拟 ~60s 建索引延迟），第 3 次刷新后命中新稿
  await t.test('平台延迟建索引时按间隔多次只读刷新，拒绝旧稿并在新稿入库后返回 submitted', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let postedCalls = 0;
    await context.route('**/*', route => {
      const u = route.request().url();
      if (u === 'https://creator.xiaohongshu.com/new/note-manager') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><meta charset="utf-8"><script>setTimeout(() => fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=0'), 20);</script><div>笔记管理</div>`,
        });
      }
      if (u.includes('/api/galaxy/v2/creator/note/user/posted')) {
        postedCalls++;
        const notes = [{ id: '000000000000000000000002', display_title: '旧稿', time: '2026-11-15 09:33', type: 'video', tab_status: 1, permission_code: 0, permission_msg: '', schedule_post_time: 0, video_info: { duration: 14 } }];
        if (postedCalls >= 3) {
          notes.unshift({ id: realId, display_title: job.copy.title, time: nowTimeStr, type: 'video', tab_status: 1, permission_code: 0, permission_msg: '', schedule_post_time: 0, video_info: { duration: 8 } });
        }
        return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ code: 0, success: true, data: { page: 1, notes } }) });
      }
      return route.abort();
    });

    const pub = createNativePublisher({
      context,
      platform: 'xiaohongshu',
      verifyIdentity: async () => {},
      waitMs: 4000,
      xhsReloadIntervalMs: 350,
      xhsEmptyReloadMs: 350,
      xhsMaxReloads: 3,
      focusCoordinator: createFocusCoordinator(),
    });
    try {
      const res = await pub.inspectResult(job);
      assert.equal(res.status, 'submitted');
      assert.equal(res.workId, realId);
      assert.ok(postedCalls >= 3);
    } finally {
      await pub.stop();
      await context.close();
    }
  });

  // 场景 C：首次 inspectResult 未取到回执时写脱敏诊断，二次重试关闭旧 reader 并建新标签成功取回
  await t.test('二次重试关闭旧 reader 重建干净标签页，并在首次未命中时落盘脱敏只读诊断', async () => {
    const diagDir = path.join(tmp, 'xhs-receipt-diag');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let createdPages = 0;
    context.on('page', () => { createdPages++; });

    let allowSuccess = false;
    await context.route('**/*', route => {
      const u = route.request().url();
      if (u === 'https://creator.xiaohongshu.com/new/note-manager') {
        const script = allowSuccess
          ? `<script>setTimeout(() => fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=0'), 20);</script>`
          : '';
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${script}<div>笔记管理</div>` });
      }
      if (u.includes('/api/galaxy/v2/creator/note/user/posted')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            code: 0,
            success: true,
            data: { page: 1, notes: [{ id: realId, display_title: job.copy.title, time: nowTimeStr, type: 'video', tab_status: 1, permission_code: 0, permission_msg: '', schedule_post_time: 0, video_info: { duration: 8 } }] },
          }),
        });
      }
      return route.abort();
    });

    const pub = createNativePublisher({
      context,
      platform: 'xiaohongshu',
      verifyIdentity: async () => {},
      diagnosticsRoot: diagDir,
      waitMs: 500,
      xhsMaxReloads: 0,
      focusCoordinator: createFocusCoordinator(),
    });
    try {
      const first = await pub.inspectResult(job);
      assert.equal(first.status, 'awaiting_verification');
      const diagFiles = fs.readdirSync(diagDir).filter(f => f.startsWith('回执核查诊断-'));
      assert.equal(diagFiles.length, 1);
      const diag = JSON.parse(fs.readFileSync(path.join(diagDir, diagFiles[0]), 'utf8'));
      assert.equal(diag.platform, 'xiaohongshu');
      assert.equal(diag.responseCount, 0);
      assert.equal(diag.attempt, 0);
      assert.equal(context.pages().length, 1);

      allowSuccess = true;
      const second = await pub.inspectResult(job);
      assert.equal(second.status, 'submitted');
      assert.equal(second.workId, realId);
      assert.equal(createdPages, 2, '重试应关闭旧 reader 并新建干净标签页');
      assert.equal(context.pages().length, 1, '旧 reader 应已关闭，只留 1 个只读标签页');
    } finally {
      await pub.stop();
      await context.close();
    }
  });
});

test('macOS 关窗防占锁：重开已关闭的专属浏览器前先清理旧 driver 进程', async () => {
  const { ManagedBrowsers } = require('../app/core/managed-browser.cjs');
  const domain = require('../app/core/domain.cjs');
  const accounts = require('../app/core/accounts.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdd-reopen-'));
  try {
    const state = domain.emptyState();
    const store = {
      load: () => state,
      update: fn => { fn(state); return state; },
    };
    accounts.ensureAccountState(store);
    const teacher = accounts.saveTeacher(store, { name: '测试老师', defaultPlatforms: ['tencent'] });
    const acc = accounts.saveManagedAccount(store, { teacherId: teacher.id, platform: 'tencent', label: '视频号测试' });

    let closeCalls = 0;
    let launchCalls = 0;
    const browsers = new ManagedBrowsers({
      store,
      profilesRoot: path.join(tmp, 'profiles'),
      availability: () => [{ id: 'chrome', label: 'Google Chrome', available: true }],
      launch: async ({ onClosed }) => {
        launchCalls++;
        let open = true;
        return {
          isOpen: () => open,
          focus: async () => {},
          read: async () => ({ state: 'awaiting_login', message: '等待登录' }),
          close: async () => { closeCalls++; open = false; },
          simulateWindowClosedWithoutExit() { open = false; onClosed(); },
        };
      },
      pollMs: 60_000,
    });

    await browsers.open({ accountId: acc.id, browserKind: 'chrome' });
    assert.equal(launchCalls, 1);
    const firstSession = browsers.sessions.get(acc.id);
    // 模拟 macOS 用户点红叉关窗：session 标记 closed 且 isOpen=false，但进程对象仍在 old.driver
    firstSession.driver.simulateWindowClosedWithoutExit();
    assert.equal(browsers.view(firstSession).windowOpen, false);

    // 再次打开专属浏览器前必须先调用 old.driver.close() 清理残留进程
    await browsers.open({ accountId: acc.id, browserKind: 'chrome' });
    assert.equal(closeCalls, 1, '重开前必须先释放旧 driver 防止 macOS profile 占锁');
    assert.equal(launchCalls, 2);
    await browsers.closeAll();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
