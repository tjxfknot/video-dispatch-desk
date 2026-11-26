'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  parseTencentPostListResponse,
  matchTencentPostListItem,
  observeTencentPostList,
} = require('../app/core/tencent-post-list.cjs');
const { workReference, managedReceipt } = require('../app/core/managed-receipt.cjs');

test('workReference 与 managedReceipt 接受视频号真实 export/ 前缀 feedId 并拒绝非法来源', () => {
  const realId = 'export/SyntheticFeedId000000000000000000000000000001';
  const url = `https://channels.weixin.qq.com/platform/post/detail?feedId=${encodeURIComponent(realId)}`;
  const ref = workReference(url, 'tencent');
  assert.deepEqual(ref, { workId: realId, workUrl: url });

  const receipt = managedReceipt({
    status: 'submitted',
    workId: realId,
    workUrl: url,
    platformStatus: 'published',
    publishedAt: '2026年11月13日 16:35',
    duration: '00:08',
    visibility: 'public',
    verification: 'creator_post_list_api',
  }, {}, 'tencent');
  assert.ok(receipt);
  assert.equal(receipt.workId, realId);
  assert.equal(receipt.platform, 'tencent');
  assert.equal(receipt.verification, 'creator_post_list_api');

  assert.equal(workReference('https://channels.weixin.qq.com/platform/post/detail?feedId=../evil', 'tencent'), null);
  assert.equal(workReference('http://channels.weixin.qq.com/platform/post/detail?feedId=export%2Fabc12345678', 'tencent'), null);
});

test('parseTencentPostListResponse 精确解析 2026-11-21 真实视频号 post_list 字段', () => {
  const payload = {
    errCode: 0,
    errMsg: '',
    data: {
      totalCount: 1,
      list: [
        {
          objectId: 'export/SyntheticFeedId000000000000000000000000000001',
          exportId: 'export/SyntheticFeedId000000000000000000000000000001',
          createTime: 1794558934,
          status: 1,
          visibleType: 1,
          disableInfo: { isDisabled: false },
          desc: {
            description: '发布台功能测试。',
            shortTitle: [{ shortTitle: '发布台视频号测试11131e6f' }],
            media: [{ videoPlayLen: 8, width: 720, height: 1280 }],
          },
        },
      ],
    },
  };
  const { items, schema } = parseTencentPostListResponse(payload);
  assert.equal(items.length, 1);
  assert.equal(items[0].workId, 'export/SyntheticFeedId000000000000000000000000000001');
  assert.equal(items[0].shortTitle, '发布台视频号测试11131e6f');
  assert.equal(items[0].description, '发布台功能测试。');
  assert.equal(items[0].duration, '00:08');
  assert.equal(items[0].publishedAt, '2026年11月13日 16:35');
  assert.equal(items[0].platformStatus, 'published');
  assert.equal(items[0].visibility, 'public');
  assert.equal(schema.totalCount, 1);
});

test('matchTencentPostListItem 兼容 alpha.11 短标题与 alpha.13+ 正文标题，拒绝旧稿和编号冲突', () => {
  const items = [
    {
      workId: 'export/SyntheticFeedId000000000000000000000000000001',
      shortTitle: '发布台视频号测试11131e6f',
      description: '发布台功能测试。',
      createTimeMs: 1794558934000,
      publishedAt: '2026年11月13日 16:35',
      duration: '00:08',
      visibility: 'public',
      platformStatus: 'published',
    },
    {
      workId: 'export/SyntheticFeedId_new_post_123456',
      shortTitle: '',
      description: '视频号闭环实测1121a\n视频号完整字段测试。 #高考 #志愿填报',
      createTimeMs: Date.parse('2026-11-21T09:05:00Z'),
      publishedAt: '2026年11月21日 17:05',
      duration: '00:08',
      visibility: 'public',
      platformStatus: 'published',
    },
  ];

  // alpha.11 历史稿匹配
  const hit11 = matchTencentPostListItem(items, {
    copy: { title: '发布台视频号测试11131e6f', description: '发布台功能测试。' },
    runCreatedAt: '2026-11-13T08:34:04.461Z',
  });
  assert.equal(hit11.status, 'matched');
  assert.equal(hit11.item.workId, 'export/SyntheticFeedId000000000000000000000000000001');

  // alpha.13+ 正文首行标题匹配
  const hit13 = matchTencentPostListItem(items, {
    copy: { title: '视频号闭环实测1121a', description: '视频号完整字段测试。' },
    runCreatedAt: '2026-11-21T09:03:00Z',
  });
  assert.equal(hit13.status, 'matched');
  assert.equal(hit13.item.workId, 'export/SyntheticFeedId_new_post_123456');

  // 旧稿不能冒充新任务
  const oldReject = matchTencentPostListItem(items, {
    copy: { title: '发布台视频号测试11131e6f', description: '发布台功能测试。' },
    runCreatedAt: '2026-11-21T09:00:00Z',
  });
  assert.equal(oldReject.status, 'none');

  // expectedWorkId 与标题冲突时标为 conflict
  const conflict = matchTencentPostListItem(items, {
    expectedWorkId: 'export/SyntheticFeedId000000000000000000000000000001',
    copy: { title: '完全不同的标题', description: '' },
  });
  assert.equal(conflict.status, 'conflict');
});

test('observeTencentPostList 被动监听 HTTP 201 post_list 响应并按 workId 合并', async () => {
  const fakePage = new EventEmitter();
  const obs = observeTencentPostList(fakePage);

  fakePage.emit('response', {
    url: () => 'https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list',
    status: () => 201,
    headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
    json: async () => ({
      errCode: 0,
      data: {
        totalCount: 1,
        list: [{
          exportId: 'export/SyntheticFeedId000000000000000000000000000001',
          createTime: 1794558934,
          status: 1,
          visibleType: 1,
          desc: { description: '发布台功能测试。', shortTitle: [{ shortTitle: '发布台视频号测试11131e6f' }], media: [{ videoPlayLen: 8 }] },
        }],
      },
    }),
  });

  const snap = await obs.flush();
  assert.equal(snap.responseCount, 1);
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].workId, 'export/SyntheticFeedId000000000000000000000000000001');
  obs.detach();
});

test('2026-11-21 视频号真实 DOM 回归：穿透式 .edit-btn、声明关闭动画与 post_list HTTP 201 回执', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { chromium } = require('playwright-core');
  const { createNativePublisher } = require('../app/core/native-publish-driver.cjs');
  const { browserAvailability } = require('../app/core/browser-driver.cjs');
  const browserKind = browserAvailability().find(b => b.available)?.id;
  if (!browserKind) t.skip('未检测到可用浏览器');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdd-tx-dom-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const videoPath = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(64, 1));
  // 1x1 solid green PNG
  const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGP4z8DAwMDAxIAVAAA8AgH9n76JZgAAAABJRU5ErkJggg==', 'base64');
  const coverPath = path.join(tmp, 'cover.png');
  fs.writeFileSync(coverPath, pngBuf);

  const browser = await chromium.launch({ channel: browserKind, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const realId = 'export/SyntheticFeedId000000000000000000000000000002';

  await context.route('**/*', route => {
    const u = route.request().url();
    if (u === 'https://channels.weixin.qq.com/platform/post/create') {
      const html = `<!doctype html><meta charset="utf-8"><style>
        .vertical-cover-wrap{width:74px;height:98px;position:relative;cursor:pointer;pointer-events:auto}
        .vertical-img-wrap{width:74px;height:98px;position:relative;cursor:pointer;pointer-events:auto}
        .vertical-img-wrap img{width:74px;height:98px;display:block;object-fit:cover}
        .edit-btn{position:absolute;left:0;bottom:0;width:74px;height:18px;background:#fff;color:#000;pointer-events:none;font-size:12px}
        .input-editor{min-height:60px;border:1px solid #ccc}
      </style>
      <input type="file" accept="video/mp4" onchange="document.getElementById('status').textContent='上传成功';document.getElementById('vwrap').innerHTML='<div class=vertical-img-wrap><img src=data:image/png;base64,${pngBuf.toString('base64')}><div class=edit-btn>编辑</div></div>';">
      <div id="status"></div>
      <div id="vwrap" class="vertical-cover-wrap" onclick="document.getElementById('dlg').hidden=false"></div>
      <div id="dlg" class="weui-desktop-dialog" hidden>
        <span>上传封面</span>
        <input type="file" accept="image/png" onchange="window.__picked=true">
        <button onclick="document.getElementById('dlg').hidden=true">确认</button>
      </div>
      <div class="input-editor" contenteditable="true"></div>
      <input placeholder="填写短标题有机会获得更多流量" value="">
      <div class="mark-tag-select">
        <span id="decl-val" onclick="document.getElementById('decl-opts').hidden=false">选择视频标注</span>
        <div id="decl-opts" hidden>
          <div onclick="document.getElementById('decl-val').textContent='个人观点，仅供参考';setTimeout(()=>{document.getElementById('decl-opts').hidden=true;},250);">个人观点，仅供参考</div>
        </div>
      </div>
      <button onclick="window.__clicked=(window.__clicked||0)+1;document.getElementById('pub').textContent='已发表';">发表</button>
      <div id="pub"></div>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (u === 'https://channels.weixin.qq.com/platform/post/list') {
      const html = `<!doctype html><meta charset="utf-8"><script>
        setTimeout(() => { fetch('/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list', { method: 'POST' }); }, 50);
      </script><div>视频管理</div>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (u.endsWith('/post/post_list')) {
      return route.fulfill({
        status: 201,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          errCode: 0,
          data: {
            totalCount: 1,
            list: [{
              exportId: realId,
              createTime: Math.floor(Date.now() / 1000),
              status: 1,
              visibleType: 1,
              desc: {
                description: '视频号闭环回归\n测试正文。 #高考',
                shortTitle: [],
                media: [{ videoPlayLen: 8 }],
              },
            }],
          },
        }),
      });
    }
    return route.abort();
  });

  const pub = createNativePublisher({
    context,
    platform: 'tencent',
    verifyIdentity: async () => {},
    onVerifyFiles: async () => {},
    waitMs: 5000,
    uploadWaitMs: 5000,
    coverWaitMs: 5000,
  });

  const job = {
    fingerprint: 'fp-tx-regression-1',
    platform: 'tencent',
    runCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    files: { video: { path: videoPath }, portrait: { path: coverPath }, landscape: null },
    copy: { title: '视频号闭环回归', description: '测试正文。', tags: ['高考'] },
    declarationText: '个人观点，仅供参考',
    settings: { visibility: 'platform_default', savePermission: 'platform_default' },
    draft: { targets: [{ platform: 'tencent', enabled: true, collection: { required: false, name: '' } }] },
  };

  const prepared = await pub.prepare(job, { onStep: () => {} });
  assert.equal(prepared.checks.covers, true);
  assert.equal(prepared.checks.declaration, true);

  const res = await pub.submit(job);
  assert.equal(res.status, 'submitted');
  assert.equal(res.workId, realId);
  assert.equal(res.verification, 'creator_post_list_api');
  assert.equal(res.duration, '00:08');
  assert.equal(res.platformStatus, 'published');
});

test('2026-11-21 视频号封面点击回归：精确点击 .vertical-img-wrap（不点外框 .tips-wrap）且首次未弹出时置前重试一次', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { chromium } = require('playwright-core');
  const { createNativePublisher } = require('../app/core/native-publish-driver.cjs');
  const { browserAvailability } = require('../app/core/browser-driver.cjs');
  const browserKind = browserAvailability().find(b => b.available)?.id;
  if (!browserKind) t.skip('未检测到可用浏览器');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdd-tx-cover-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const videoPath = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(64, 1));
  const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGP4z8DAwMDAxIAVAAA8AgH9n76JZgAAAABJRU5ErkJggg==', 'base64');
  const coverPath = path.join(tmp, 'cover.png');
  fs.writeFileSync(coverPath, pngBuf);

  const browser = await chromium.launch({ channel: browserKind, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();

  await context.route('**/*', route => {
    const u = route.request().url();
    if (u === 'https://channels.weixin.qq.com/platform/post/create') {
      // 模拟真实 DOM：外框 .vertical-cover-wrap 含 .vertical-img-wrap(74x98) 与下方 .tips-wrap(74x96)，
      // 只有精确点中 .vertical-img-wrap 才响应；且首次点击模拟后台窗口吞掉点击，第二次点击才弹出弹窗。
      const html = `<!doctype html><meta charset="utf-8"><style>
        .vertical-cover-wrap{width:74px;position:relative;display:block}
        .vertical-img-wrap{width:74px;height:98px;position:relative;cursor:pointer;pointer-events:auto}
        .vertical-img-wrap img{width:74px;height:98px;display:block;object-fit:cover}
        .edit-btn{position:absolute;left:0;bottom:0;width:74px;height:18px;background:#fff;color:#000;pointer-events:none;font-size:12px}
        .tips-wrap{width:74px;height:96px;pointer-events:auto}
        .input-editor{min-height:60px;border:1px solid #ccc}
      </style>
      <input type="file" accept="video/mp4" onchange="document.getElementById('status').textContent='上传成功';document.getElementById('vwrap').innerHTML='<div id=imgwrap class=vertical-img-wrap><img src=data:image/png;base64,${pngBuf.toString('base64')}><div class=edit-btn>编辑</div></div><div class=tips-wrap onclick=window.__tipsClicks=(window.__tipsClicks||0)+1><div class=cover-tips>个人主页和分享卡片(3:4)</div></div>';document.getElementById('imgwrap').addEventListener('click',function(){window.__imgWrapClicks=(window.__imgWrapClicks||0)+1;if(window.__imgWrapClicks>=2){document.getElementById('dlg').hidden=false;}});">
      <div id="status"></div>
      <div id="vwrap" class="vertical-cover-wrap"></div>
      <div id="dlg" class="weui-desktop-dialog" hidden>
        <span>上传封面</span>
        <input type="file" accept="image/png" onchange="window.__picked=true">
        <button onclick="document.getElementById('dlg').hidden=true">确认</button>
      </div>
      <div class="input-editor" contenteditable="true"></div>
      <input placeholder="填写短标题有机会获得更多流量" value="">
      <button>发表</button>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    return route.abort();
  });

  const pub = createNativePublisher({
    context,
    platform: 'tencent',
    verifyIdentity: async () => {},
    onVerifyFiles: async () => {},
    waitMs: 1800,
    uploadWaitMs: 3000,
    coverWaitMs: 3000,
  });

  const job = {
    fingerprint: 'fp-tx-cover-retry-1',
    platform: 'tencent',
    runCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    files: { video: { path: videoPath }, portrait: { path: coverPath }, landscape: null },
    copy: { title: '视频号封面精准点击回归', description: '正文。', tags: [] },
    declarationText: '',
    settings: { visibility: 'platform_default', savePermission: 'platform_default' },
    draft: { targets: [{ platform: 'tencent', enabled: true, collection: { required: false, name: '' } }] },
  };

  const prepared = await pub.prepare(job, { onStep: () => {} });
  assert.equal(prepared.checks.covers, true);
  const p = context.pages()[0];
  assert.equal(await p.evaluate(() => window.__imgWrapClicks), 2);
  assert.equal(await p.evaluate(() => window.__tipsClicks || 0), 0);
});

test('2026-11-22 视频号真实定时 post_list 字段校准：识别 effectiveTime + handleStatus=2 为 scheduled 并严格校验预约时间', () => {
  const scheduledTs = Math.floor(Date.parse('2026-11-23T14:30:00+08:00') / 1000);
  const createdTs = Math.floor(Date.parse('2026-11-22T16:51:10+08:00') / 1000);
  const payload = {
    errCode: 0,
    data: {
      totalCount: 2,
      list: [
        {
          exportId: 'export/SyntheticFeedId000000000000000000000000000003',
          createTime: createdTs,
          effectiveTime: scheduledTs,
          handleStatus: 2,
          status: 1,
          visibleType: 1,
          disableInfo: { isDisabled: false },
          desc: {
            description: '视频号定时无定位验收1122_4f53\n视频号定时发表与清除默认定位实测。 #高考 #志愿填报',
            shortTitle: [{ shortTitle: '' }],
            location: {},
            media: [{ videoPlayLen: 8 }],
          },
        },
        {
          exportId: 'export/SyntheticFeedId000000000000000000000000000002',
          createTime: createdTs,
          status: 1,
          visibleType: 1,
          disableInfo: { isDisabled: false },
          desc: {
            description: '视频号定时无定位验收1122_4f53\n视频号定时发表与清除默认定位实测。 #高考 #志愿填报',
            shortTitle: [{ shortTitle: '' }],
            location: {},
            media: [{ videoPlayLen: 8 }],
          },
        },
      ],
    },
  };
  const { items } = parseTencentPostListResponse(payload);
  assert.equal(items[0].platformStatus, 'scheduled');
  assert.equal(items[0].publishedAt, '2026年11月23日 14:30');
  assert.equal(items[1].platformStatus, 'published');
  assert.equal(items[1].publishedAt, '2026年11月22日 16:51');

  // 定时任务精确匹配到预定时间相同的 scheduled 条目，不借用同名立即发布条目
  const schedHit = matchTencentPostListItem(items, {
    copy: { title: '视频号定时无定位验收1122_4f53', description: '视频号定时发表与清除默认定位实测。' },
    schedule: { mode: 'scheduled', at: '2026-11-23T14:30', timeZone: 'Asia/Shanghai' },
    runCreatedAt: '2026-11-22T08:49:16.000Z',
  });
  assert.equal(schedHit.status, 'matched');
  assert.equal(schedHit.item.workId, 'export/SyntheticFeedId000000000000000000000000000003');
  assert.equal(schedHit.item.platformStatus, 'scheduled');

  // 不同预约时间不能冒充回执
  const wrongTime = matchTencentPostListItem(items, {
    copy: { title: '视频号定时无定位验收1122_4f53', description: '视频号定时发表与清除默认定位实测。' },
    schedule: { mode: 'scheduled', at: '2026-11-23T15:00', timeZone: 'Asia/Shanghai' },
    runCreatedAt: '2026-11-22T08:49:16.000Z',
  });
  assert.equal(wrongTime.status, 'none');

  // 立即发布任务只匹配非定时条目，不借用定时条目
  const immHit = matchTencentPostListItem(items, {
    copy: { title: '视频号定时无定位验收1122_4f53', description: '视频号定时发表与清除默认定位实测。' },
    schedule: { mode: 'immediate', timeZone: 'Asia/Shanghai' },
    runCreatedAt: '2026-11-22T08:49:16.000Z',
  });
  assert.equal(immHit.status, 'matched');
  assert.equal(immHit.item.workId, 'export/SyntheticFeedId000000000000000000000000000002');
});
