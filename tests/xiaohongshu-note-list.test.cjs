'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  parseXiaohongshuNoteListResponse,
  matchXiaohongshuNoteItem,
  observeXiaohongshuNoteList,
} = require('../app/core/xiaohongshu-note-list.cjs');
const { workReference, managedReceipt } = require('../app/core/managed-receipt.cjs');

test('parseXiaohongshuNoteListResponse 精确解析 2026-11-21 真实小红书 posted 接口字段且不保留敏感令牌', () => {
  const payload = {
    code: 0,
    success: true,
    msg: '成功',
    data: {
      page: 1,
      notes: [
        {
          id: '000000000000000000000003',
          display_title: '小红书闭环实测1121a',
          time: '2026-11-21 22:46',
          visible_time: 1795272471,
          type: 'video',
          tab_status: 1,
          permission_code: 0,
          permission_msg: '',
          schedule_post_time: 0,
          video_info: { duration: 8 },
          xsec_token: 'SECRET_TOKEN_SHOULD_NOT_BE_STORED',
          images_list: [{ url: 'https://sns-img.example/signed?token=secret' }],
        },
        {
          id: '000000000000000000000005',
          display_title: '私密笔记测试',
          time: '2026-04-15 15:10',
          type: 'normal',
          tab_status: 2,
          permission_code: 1,
          permission_msg: '仅自己可见',
          schedule_post_time: 0,
        },
      ],
    },
  };

  const { items, schema } = parseXiaohongshuNoteListResponse(payload);
  assert.equal(items.length, 2);
  assert.equal(schema.count, 2);
  assert.equal(items[0].workId, '000000000000000000000003');
  assert.equal(items[0].title, '小红书闭环实测1121a');
  assert.equal(items[0].publishedAt, '2026年11月21日 22:46');
  assert.equal(items[0].duration, '00:08');
  assert.equal(items[0].platformStatus, 'published');
  assert.equal(items[0].visibility, 'public');
  assert.equal('xsec_token' in items[0], false);
  assert.equal('images_list' in items[0], false);

  assert.equal(items[1].visibility, 'self');
  assert.equal(items[1].platformStatus, 'under_review');

  const url = `https://www.xiaohongshu.com/explore/${items[0].workId}`;
  assert.deepEqual(workReference(url, 'xiaohongshu'), { workId: items[0].workId, workUrl: url });
  const receipt = managedReceipt({
    status: 'submitted',
    workId: items[0].workId,
    workUrl: url,
    platformStatus: 'published',
    publishedAt: items[0].publishedAt,
    duration: items[0].duration,
    visibility: 'public',
    verification: 'creator_note_list_api',
  }, {}, 'xiaohongshu');
  assert.ok(receipt);
  assert.equal(receipt.workId, items[0].workId);
  assert.equal(receipt.verification, 'creator_note_list_api');
});

test('matchXiaohongshuNoteItem 按标题与北京时间分钟匹配，拒绝旧稿、重名歧义与编号冲突', () => {
  const items = [
    {
      workId: '000000000000000000000002',
      title: '旧稿标题',
      createTimeMs: Date.parse('2026-11-15T09:33:00+08:00'),
      publishedAt: '2026年11月15日 09:33',
      duration: '00:14',
      visibility: 'public',
      platformStatus: 'published',
    },
    {
      workId: '000000000000000000000003',
      title: '小红书闭环实测1121a',
      createTimeMs: Date.parse('2026-11-21T22:46:00+08:00'),
      publishedAt: '2026年11月21日 22:46',
      duration: '00:08',
      visibility: 'public',
      platformStatus: 'published',
    },
  ];

  const hit = matchXiaohongshuNoteItem(items, {
    copy: { title: '小红书闭环实测1121a' },
    runCreatedAt: '2026-11-21T14:43:33.229Z',
  });
  assert.equal(hit.status, 'matched');
  assert.equal(hit.item.workId, '000000000000000000000003');

  // 旧稿不能冒充新任务
  const oldReject = matchXiaohongshuNoteItem(items, {
    copy: { title: '旧稿标题' },
    runCreatedAt: '2026-11-21T14:00:00Z',
  });
  assert.equal(oldReject.status, 'none');

  // expectedWorkId 与标题冲突时返回 conflict
  const conflict = matchXiaohongshuNoteItem(items, {
    expectedWorkId: '000000000000000000000003',
    copy: { title: '不同标题' },
  });
  assert.equal(conflict.status, 'conflict');

  // 同标题多条新稿返回 ambiguous
  const dup = matchXiaohongshuNoteItem([
    items[1],
    { ...items[1], workId: '000000000000000000000004' },
  ], {
    copy: { title: '小红书闭环实测1121a' },
    runCreatedAt: '2026-11-21T14:43:33.229Z',
  });
  assert.equal(dup.status, 'ambiguous');
});

test('observeXiaohongshuNoteList 被动监听 posted 响应并按 workId 合并防覆盖', async () => {
  const fakePage = new EventEmitter();
  const obs = observeXiaohongshuNoteList(fakePage);

  fakePage.emit('response', {
    url: () => 'https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted?tab=0&page=0',
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({
      code: 0,
      success: true,
      data: {
        page: 1,
        notes: [{ id: '000000000000000000000003', display_title: '笔记A', time: '2026-11-21 22:46', tab_status: 1, permission_code: 0, video_info: { duration: 8 } }],
      },
    }),
  });
  fakePage.emit('response', {
    url: () => 'https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted?tab=1&page=0',
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({
      code: 0,
      success: true,
      data: {
        page: 1,
        notes: [{ id: '000000000000000000000002', display_title: '笔记B', time: '2026-11-15 09:33', tab_status: 1, permission_code: 0, video_info: { duration: 14 } }],
      },
    }),
  });

  const snap = await obs.flush();
  assert.equal(snap.responseCount, 2);
  assert.equal(snap.items.length, 2);
  obs.detach();
});

test('2026-11-21 小红书真实 DOM 回归：SPA 站内跳转、重新上传+封面预览完成判定、封闭底栏提交与 posted 接口回执', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { chromium } = require('playwright-core');
  const { createNativePublisher } = require('../app/core/native-publish-driver.cjs');
  const { browserAvailability } = require('../app/core/browser-driver.cjs');
  const browserKind = browserAvailability().find(b => b.available)?.id;
  if (!browserKind) t.skip('未检测到可用浏览器');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdd-xhs-dom-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const videoPath = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(64, 1));
  const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGP4z8DAwMDAxIAVAAA8AgH9n76JZgAAAABJRU5ErkJggg==', 'base64');
  const coverPath = path.join(tmp, 'cover.png');
  fs.writeFileSync(coverPath, pngBuf);

  const browser = await chromium.launch({ channel: browserKind, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const realId = '000000000000000000000003';
  const coverDataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;

  await context.route('**/*', route => {
    const u = route.request().url();
    if (u === 'https://creator.xiaohongshu.com/new/home') {
      const html = `<!doctype html><meta charset="utf-8"><style>
        .cover-plugin-preview .cover > .default { width: 120px; height: 160px; background-size: cover; position: relative; }
        .cover-edit-entry { display: none; }
        .cover > .default:hover .cover-edit-entry { display: block; }
        [contenteditable] { min-height: 60px; border: 1px solid #ccc; }
      </style>
      <div id="app">
        <button id="entry">发布视频笔记</button>
      </div>
      <script>
        document.getElementById('entry').onclick = () => {
          history.pushState({}, '', '/publish/publish?from=homepage&target=video&openFilePicker=true');
          document.getElementById('app').innerHTML = \`
            <div id="status"></div>
            <input id="vfile" type="file" accept=".mp4,.mov">
            <div id="form" hidden>
              <div id="reupload-bar"><span>取消上传</span><span>上传中 0%</span></div>
              <div class="cover-plugin-preview">
                <div class="cover">
                  <div id="cover-def" class="default">
                    <div class="cover-edit-entry" onclick="document.getElementById('dlg').hidden=false">编辑封面</div>
                  </div>
                </div>
              </div>
              <input placeholder="填写标题会有更多赞哦" value="">
              <div class="tiptap ProseMirror" contenteditable="true"></div>
              <div id="creator-editor-topic-container" hidden></div>
              <div class="d-select-main"><div class="d-select-placeholder">添加内容类型声明</div></div>
              <div class="d-select-main"><div class="d-select-placeholder">添加地点</div></div>
              <div id="dlg" class="d-modal" hidden>
                <span>上传封面</span>
                <input id="cfile" type="file" accept="image/png">
                <button id="cconfirm">完成</button>
              </div>
              <div class="video-footer"></div>
            </div>
          \`;
          const vfile = document.getElementById('vfile');
          vfile.onchange = () => {
            document.getElementById('form').hidden = false;
            setTimeout(() => {
              document.getElementById('reupload-bar').innerHTML = '<div><svg></svg>重新上传</div>';
              document.getElementById('cover-def').style.backgroundImage = 'url(${coverDataUrl})';
            }, 120);
          };
          const cfile = document.getElementById('cfile');
          cfile.onchange = () => {
            const r = new FileReader();
            r.onload = () => { window.__newCover = r.result; };
            r.readAsDataURL(cfile.files[0]);
          };
          document.getElementById('cconfirm').onclick = () => {
            document.getElementById('cover-def').style.backgroundImage = 'url(' + window.__newCover + ')';
            document.getElementById('dlg').hidden = true;
          };
          const ed = document.querySelector('[contenteditable]');
          const menu = document.getElementById('creator-editor-topic-container');
          ed.addEventListener('input', () => {
            const m = ed.innerText.match(/#([^# ]+)$/);
            if (!m) return;
            menu.hidden = false;
            menu.innerHTML = '';
            const item = document.createElement('button');
            item.className = 'item';
            item.innerHTML = '<span>#' + m[1] + '</span><span>100万浏览</span>';
            item.onclick = () => {
              ed.textContent = ed.innerText.replace(/#[^# ]+$/, '');
              const tag = document.createElement('a');
              tag.contentEditable = 'false';
              tag.textContent = '#' + m[1] + '[话题]#';
              ed.append(tag);
              menu.hidden = true;
            };
            menu.append(item);
          });
          const host = document.querySelector('.video-footer');
          const sr = host.attachShadow({ mode: 'closed' });
          const btn = document.createElement('button');
          btn.textContent = '发布';
          btn.onclick = () => {
            window.__pubClicks = (window.__pubClicks || 0) + 1;
            const p = document.createElement('p');
            p.textContent = '发布成功';
            document.body.append(p);
          };
          sr.append(btn);
        };
      </script>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (u === 'https://creator.xiaohongshu.com/new/note-manager') {
      const html = `<!doctype html><meta charset="utf-8"><script>
        setTimeout(() => { fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=0'); }, 50);
      </script><div>笔记管理</div>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (u.includes('/api/galaxy/v2/creator/note/user/posted')) {
      const now = new Date(Date.now() + 8 * 3600_000);
      const pad = n => String(n).padStart(2, '0');
      const timeStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          code: 0,
          success: true,
          data: {
            page: 1,
            notes: [{
              id: realId,
              display_title: '小红书SPA回归测试',
              time: timeStr,
              type: 'video',
              tab_status: 1,
              permission_code: 0,
              permission_msg: '',
              schedule_post_time: 0,
              video_info: { duration: 8 },
            }],
          },
        }),
      });
    }
    return route.abort();
  });

  const pub = createNativePublisher({
    context,
    platform: 'xiaohongshu',
    verifyIdentity: async () => {},
    onVerifyFiles: async () => {},
    waitMs: 5000,
    uploadWaitMs: 5000,
    coverWaitMs: 5000,
  });

  const job = {
    fingerprint: 'fp-xhs-regression-1',
    platform: 'xiaohongshu',
    runCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    files: { video: { path: videoPath }, portrait: { path: coverPath }, landscape: null },
    copy: { title: '小红书SPA回归测试', description: '测试正文。', tags: ['高考'] },
    declarationText: '',
    location: { mode: 'none', name: '' },
    settings: { visibility: 'platform_default', savePermission: 'platform_default' },
    draft: { targets: [{ platform: 'xiaohongshu', enabled: true, declaration: { mode: 'omit' }, collection: { required: false, name: '' } }] },
  };

  const prepared = await pub.prepare(job, { onStep: () => {} });
  assert.equal(prepared.checks.covers, true);
  assert.equal(prepared.evidence.publishControl.shadowMode, 'closed');

  const res = await pub.submit(job);
  assert.equal(res.status, 'submitted');
  assert.equal(res.workId, realId);
  assert.equal(res.workUrl, `https://www.xiaohongshu.com/explore/${realId}`);
  assert.equal(res.verification, 'creator_note_list_api');
  assert.equal(res.duration, '00:08');
  assert.equal(res.platformStatus, 'published');
});
