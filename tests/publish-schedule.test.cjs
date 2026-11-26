'use strict';
// 2026-11-11 定时发布：各平台范围、任务构建拦截、抖音时间框填写与回读。
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, limitLabel, scheduleIssue, windowFor, formatAt, parseAt } = require('../app/core/publish-schedule.cjs');
const { createScheduleControl, scheduleText, listRecordEvidence } = require('../app/core/douyin-publish-driver.cjs');

const NOW = Date.parse('2026-11-11T10:00:00+08:00');
const at = offsetMinutes => ({ mode: 'scheduled', at: formatAt(NOW + offsetMinutes * 60000), timeZone: 'Asia/Shanghai' });

test('三个平台均有真实页面依据的定时范围；不再编造未核对范围', () => {
  assert.deepEqual({ min: LIMITS.douyin.minMinutes, max: LIMITS.douyin.maxDays, supported: LIMITS.douyin.supported }, { min: 120, max: 14, supported: true });
  assert.equal(limitLabel('douyin'), '定时：2小时后～14天内');
  assert.deepEqual({ min: LIMITS.tencent.minMinutes, max: LIMITS.tencent.maxDays, supported: LIMITS.tencent.supported }, { min: 5, max: 30, supported: true });
  assert.equal(limitLabel('tencent'), '定时：5分钟后～30天内');
  assert.deepEqual({ min: LIMITS.xiaohongshu.minMinutes, max: LIMITS.xiaohongshu.maxDays, supported: LIMITS.xiaohongshu.supported }, { min: 60, max: 14, supported: true });
  assert.equal(limitLabel('xiaohongshu'), '定时：1小时后～14天内');
});

test('小红书：总览时要求 1 小时 + 30 分钟上传预留；填写页面时按 1 小时，最晚 14 天内', () => {
  assert.match(scheduleIssue('xiaohongshu', at(60), NOW), /1小时之后.*请选 2026-11-11 11:30 以后/);
  assert.match(scheduleIssue('xiaohongshu', at(89), NOW), /1小时之后/);
  assert.equal(scheduleIssue('xiaohongshu', at(90), NOW), '');
  assert.equal(scheduleIssue('xiaohongshu', at(60), NOW, { strict: true }), '');
  assert.match(scheduleIssue('xiaohongshu', at(59), NOW, { strict: true }), /已不足.*未提交/);
  assert.equal(scheduleIssue('xiaohongshu', at(14 * 1440 - 60), NOW), '');
  assert.match(scheduleIssue('xiaohongshu', at(14 * 1440 - 59), NOW), /只能定时到14天内/);
  assert.match(scheduleIssue('xiaohongshu', at(15 * 1440), NOW, { strict: true }), /只能定时到14天内/);
});

test('视频号：总览时要求 5 分钟 + 30 分钟上传预留；填写页面时按 5 分钟，最晚 30 天内', () => {
  assert.match(scheduleIssue('tencent', at(5), NOW), /5分钟之后.*请选 2026-11-11 10:35 以后/);
  assert.match(scheduleIssue('tencent', at(34), NOW), /5分钟之后/);
  assert.equal(scheduleIssue('tencent', at(35), NOW), '');
  assert.equal(scheduleIssue('tencent', at(5), NOW, { strict: true }), '');
  assert.match(scheduleIssue('tencent', at(4), NOW, { strict: true }), /已不足.*未提交/);
  assert.equal(scheduleIssue('tencent', at(30 * 1440 - 60), NOW), '');
  assert.match(scheduleIssue('tencent', at(30 * 1440 - 59), NOW), /只能定时到30天内/);
  assert.match(scheduleIssue('tencent', at(31 * 1440), NOW, { strict: true }), /只能定时到30天内/);
});

test('立即发布在任何平台都不受定时范围限制', () => {
  for (const platform of Object.keys(LIMITS)) assert.equal(scheduleIssue(platform, { mode: 'immediate', timeZone: 'Asia/Shanghai' }, NOW), '');
});

test('抖音：总览时要求 2 小时 + 30 分钟上传预留；填写页面时按平台的 2 小时', () => {
  assert.match(scheduleIssue('douyin', at(120), NOW), /2小时之后.*请选 2026-11-11 12:30 以后/);
  assert.match(scheduleIssue('douyin', at(149), NOW), /2小时之后/);
  assert.equal(scheduleIssue('douyin', at(150), NOW), '');
  assert.equal(scheduleIssue('douyin', at(120), NOW, { strict: true }), '');
  assert.match(scheduleIssue('douyin', at(119), NOW, { strict: true }), /已不足.*未提交/);
});

test('抖音：最晚 14 天内，总览时留 1 小时余量', () => {
  assert.equal(scheduleIssue('douyin', at(14 * 1440 - 60), NOW), '');
  assert.match(scheduleIssue('douyin', at(14 * 1440 - 59), NOW), /只能定时到14天内/);
  assert.match(scheduleIssue('douyin', at(20 * 1440), NOW, { strict: true }), /只能定时到14天内/);
});

test('时间按北京时间解析和格式化，不随本机时区变化；无效时间被拒绝', () => {
  assert.equal(formatAt(NOW), '2026-11-11T10:00');
  assert.equal(parseAt('2026-11-11T10:00').getTime(), NOW);
  assert.equal(parseAt('2026-02-30T10:00'), null);
  assert.match(scheduleIssue('douyin', { mode: 'scheduled', at: '2026-02-30T10:00', timeZone: 'Asia/Shanghai' }, NOW), /有效的定时发布时间/);
  assert.match(scheduleIssue('douyin', { ...at(600), timeZone: 'UTC' }, NOW), /北京时间/);
});

// 用假页面验证控制流程：选定时、清空、输入、回车、回读；回读不一致必须报错。
function fakePage({ acceptTyped = true } = {}) {
  const state = { mode: '立即发布', value: '', keys: [] };
  const field = {
    click: async () => {}, inputValue: async () => state.value,
    press: async key => { state.keys.push(key); if (key === 'ControlOrMeta+A') state.value = ''; },
    pressSequentially: async text => { state.value = acceptTyped ? text : '2026-11-11 23:59'; }
  };
  const page = { locator: selector => ({ selector, field }), waitForTimeout: async () => {} };
  const control = createScheduleControl({ getPage: () => page, now: () => NOW,
    one: async (locator, label) => { if (state.mode !== '定时发布') throw new Error(`未等到${label}显示，已停止，未提交。`); return locator.field; },
    choose: async label => { state.mode = label; }, selected: async () => state.mode });
  return { state, control };
}

test('抖音时间框：选中定时、填入北京时间、回读一致才算完成', async () => {
  const { state, control } = fakePage();
  const job = { schedule: at(300) };
  await control.apply(job);
  assert.equal(state.mode, '定时发布'); assert.equal(state.value, '2026-11-11 15:00');
  assert.deepEqual(state.keys, ['ControlOrMeta+A', 'Enter']);
  assert.equal(await control.read(), scheduleText(job)); assert.equal(scheduleText(job), '定时发布 2026-11-11 15:00');
});

test('抖音时间框：立即发布任务会明确选回立即发布', async () => {
  const { state, control } = fakePage();
  state.mode = '定时发布';
  await control.apply({ schedule: { mode: 'immediate', timeZone: 'Asia/Shanghai' } });
  assert.equal(await control.read(), '立即发布'); assert.equal(scheduleText({ schedule: { mode: 'immediate' } }), '立即发布');
});

test('抖音时间框：平台回读的时间与任务不同就报错，不继续', async () => {
  const { control } = fakePage({ acceptTyped: false });
  await assert.rejects(control.apply({ schedule: at(300) }), /回读为“2026-11-11 23:59”.*不一致，未提交/);
});

test('抖音时间框：上传完后已不足 2 小时就停下，不选定时也不改成立即', async () => {
  const { state, control } = fakePage();
  await assert.rejects(control.apply({ schedule: at(100) }), /已不足.*未提交/);
  assert.equal(state.mode, '立即发布', '尚未触碰平台的发布时间选项'); assert.equal(state.value, '');
});

test('作品记录里出现“定时发布”时，平台状态记为定时中', () => {
  const record = listRecordEvidence('流程测试\n定时发布\n2026年11月11日 15:00\n00:08', { runCreatedAt: new Date(NOW).toISOString() });
  assert.equal(record.platformStatus, 'scheduled');
});

test('批准前身份复查耗时后，定时已不足2小时必须停止，不能只校验填写瞬间', async () => {
  let clock = NOW;
  const { createDouyinPublisher } = require('../app/core/douyin-publish-driver.cjs');
  const publisher = createDouyinPublisher({ context: {}, now: () => clock,
    onVerifyFiles: async () => {}, verifyIdentity: async () => { clock += 2 * 60000; } });
  await assert.rejects(publisher.verify({ schedule: at(121) }), /已不足.*未提交/);
});

test('作品标题中提到“定时发布”不能被当成平台的定时状态', () => {
  const record = listRecordEvidence('如何使用定时发布功能\n2026年11月11日 15:00\n00:08', { runCreatedAt: new Date(NOW).toISOString() });
  assert.equal(record.platformStatus, 'unknown');
});

test('新定时任务不能用同名但不同定时时间的作品记录作为回执', () => {
  const job = { schedule: at(360), runCreatedAt: new Date(NOW).toISOString() };
  assert.equal(listRecordEvidence('合成任务\n定时发布\n2026年11月11日 15:00\n00:08', job), null);
});

test('精确到分钟的最早可选值必须能通过同一时刻的范围检查', () => {
  const now = NOW + 30_123, range = windowFor('douyin', now);
  const schedule = { mode: 'scheduled', at: formatAt(range.earliest), timeZone: 'Asia/Shanghai' };
  assert.equal(scheduleIssue('douyin', schedule, now), '');
});

test('作品标题恰好叫“定时发布”也不能成为平台定时状态证据', () => {
  const job = { copy: { title: '定时发布' }, schedule: at(300), runCreatedAt: new Date(NOW).toISOString() };
  assert.equal(listRecordEvidence('定时发布\n2026年11月11日 15:00\n00:08', job), null);
});

test('定时记录需要预约时间和独立状态同时匹配；已知编号的只读回查仍可读历史状态', () => {
  const text = '合成任务\n定时发布\n2026年11月11日 15:00\n00:08';
  const job = { copy: { title: '合成任务' }, schedule: at(300), runCreatedAt: new Date(NOW).toISOString() };
  assert.equal(listRecordEvidence(text, job).platformStatus, 'scheduled');
  assert.equal(listRecordEvidence(text.replace('定时发布\n', ''), job), null);
  assert.ok(listRecordEvidence(text, { ...job, expectedWorkId: '1234567890123456789', schedule: at(360) }));
});

test('2026-11-22 视频号真实 WeUI 定时控件回归：跨月选择、禁用拦阻、回读校验与不定时切换', async t => {
  const { chromium } = require('playwright-core');
  const { browserAvailability } = require('../app/core/browser-driver.cjs');
  const { createTencentScheduleControl, createNativePublisher, tencentScheduleText } = require('../app/core/native-publish-driver.cjs');
  const browserKind = browserAvailability().find(b => b.available)?.id;
  if (!browserKind) t.skip('未检测到可用浏览器');

  const browser = await chromium.launch({ channel: browserKind, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();

  const renderPickerHtml = ({ mismatch = false, disabledDay = null, disabledHour = null } = {}) => `<!doctype html><meta charset="utf-8">
  <div class="post-time-wrap">
    <div class="form-item">
      <div class="label">定时发表</div>
      <div class="weui-desktop-radio-group">
        <label class="weui-desktop-form__check-label"><input type="radio" name="tmode" class="weui-desktop-form__radio" value="0" checked> <i class="weui-desktop-icon-radio"></i> <span class="weui-desktop-form__check-content">不定时</span></label>
        <label class="weui-desktop-form__check-label"><input type="radio" name="tmode" class="weui-desktop-form__radio" value="1"> <i class="weui-desktop-icon-radio"></i> <span class="weui-desktop-form__check-content">定时</span></label>
      </div>
    </div>
    <div id="time-row" class="form-item" style="display:none">
      <div class="label">发表时间</div>
      <dl class="weui-desktop-picker__date weui-desktop-picker__date-time">
        <input id="dt-input" type="text" readonly placeholder="请选择发表时间" class="weui-desktop-form__input" value="2026-11-11 19:00">
        <dd id="dd" class="weui-desktop-picker__dd" style="display:none">
          <button id="prev" type="button" class="weui-desktop-btn__icon__left" style="display:none">&lt;</button>
          <span id="lbl-y" class="weui-desktop-picker__panel__label">2026年</span>
          <span id="lbl-m" class="weui-desktop-picker__panel__label">11月</span>
          <button id="next" type="button" class="weui-desktop-btn__icon__right">&gt;</button>
          <table class="weui-desktop-picker__table"><tbody id="cal"></tbody></table>
          <div class="weui-desktop-picker__panel-fd">
            <dl class="weui-desktop-picker__time">
              <dt><input id="t-input" type="text" placeholder="请选择时间" value="19:00"></dt>
              <dd id="t-dd" class="weui-desktop-picker__dd weui-desktop-picker__dd__time" style="display:none">
                <div class="weui-desktop-picker__time__panel"><ul id="hours" class="weui-desktop-picker__time__hour"></ul></div>
                <div class="weui-desktop-picker__time__panel"><ul id="mins"></ul></div>
              </dd>
            </dl>
          </div>
        </dd>
      </dl>
    </div>
  </div>
  <script>(() => {
    const state = { y: 2026, m: 11, d: 11, h: '19', mi: '00' };
    const pad = n => String(n).padStart(2, '0');
    const syncInput = () => {
      document.getElementById('t-input').value = state.h + ':' + state.mi;
      document.getElementById('dt-input').value = ${mismatch ? "'2026-11-11 23:59'" : "state.y + '-' + pad(state.m) + '-' + pad(state.d) + ' ' + state.h + ':' + state.mi"};
    };
    const renderCal = () => {
      document.getElementById('lbl-y').textContent = state.y + '年';
      document.getElementById('lbl-m').textContent = state.m + '月';
      document.getElementById('prev').style.display = state.m > 11 ? 'inline-block' : 'none';
      document.getElementById('next').style.display = state.m < 12 ? 'inline-block' : 'none';
      const maxD = state.m === 11 ? 30 : 31;
      let html = '<tr><td><a class="weui-desktop-picker__faded">29</a></td>';
      for (let d = 1; d <= maxD; d++) {
        const dis = (${JSON.stringify(disabledDay)} === d) ? ' weui-desktop-picker__disabled' : '';
        html += '<td><a class="' + dis + '" data-d="' + d + '">' + d + '</a></td>';
      }
      html += '</tr>';
      document.getElementById('cal').innerHTML = html;
      document.querySelectorAll('#cal a:not(.weui-desktop-picker__faded)').forEach(a => {
        a.onclick = () => { if (a.classList.contains('weui-desktop-picker__disabled')) return; state.d = Number(a.dataset.d); syncInput(); };
      });
    };
    const renderTime = () => {
      const hours = document.getElementById('hours'), mins = document.getElementById('mins');
      hours.innerHTML = ''; mins.innerHTML = '';
      for (let h = 0; h < 24; h++) {
        const hs = pad(h), li = document.createElement('li');
        li.textContent = hs;
        if (${JSON.stringify(disabledHour)} === hs) li.className = 'weui-desktop-picker__disabled';
        li.onclick = () => { if (li.classList.contains('weui-desktop-picker__disabled')) return; state.h = hs; syncInput(); };
        hours.appendChild(li);
      }
      for (let m = 0; m < 60; m++) {
        const ms = pad(m), li = document.createElement('li');
        li.textContent = ms;
        li.onclick = () => { state.mi = ms; syncInput(); };
        mins.appendChild(li);
      }
    };
    document.querySelectorAll('input[name="tmode"]').forEach(r => r.addEventListener('change', () => {
      document.getElementById('time-row').style.display = r.value === '1' && r.checked ? 'block' : 'none';
      if (r.value === '0' && r.checked) document.getElementById('dd').style.display = 'none';
    }));
    document.getElementById('dt-input').onclick = () => { document.getElementById('dd').style.display = 'block'; };
    document.getElementById('t-input').onclick = () => { document.getElementById('t-dd').style.display = 'block'; };
    document.getElementById('next').onclick = () => { state.m = 12; renderCal(); };
    document.getElementById('prev').onclick = () => { state.m = 11; renderCal(); };
    document.querySelector('.label').onclick = () => { document.getElementById('dd').style.display = 'none'; };
    renderCal(); renderTime();
  })();</script>`;

  const one = async (locator, label) => {
    const vis = locator.filter({ visible: true });
    await vis.first().waitFor({ state: 'visible', timeout: 2000 });
    assert.equal(await vis.count(), 1, label);
    return vis;
  };

  // 1. 跨月选择 2026-12-03 14:35 并回读一致，再切回不定时
  await page.setContent(renderPickerHtml());
  const ctrl = createTencentScheduleControl({ getPage: () => page, one, now: () => NOW, waitMs: 2000 });
  const decJob = { schedule: { mode: 'scheduled', at: '2026-12-03T14:35', timeZone: 'Asia/Shanghai' } };
  await ctrl.apply(decJob);
  assert.equal(await ctrl.read(decJob), tencentScheduleText(decJob));
  assert.equal(await ctrl.read(decJob), '定时 2026-12-03 14:35');

  await ctrl.apply({ schedule: { mode: 'immediate', timeZone: 'Asia/Shanghai' } });
  assert.equal(await ctrl.read({ schedule: { mode: 'immediate' } }), '不定时');

  // 2. 禁用日期/小时必须停止
  await page.setContent(renderPickerHtml({ disabledDay: 15 }));
  await assert.rejects(ctrl.apply({ schedule: { mode: 'scheduled', at: '2026-11-15T14:30', timeZone: 'Asia/Shanghai' } }), /已被平台禁用/);

  await page.setContent(renderPickerHtml({ disabledHour: '14' }));
  await assert.rejects(ctrl.apply({ schedule: { mode: 'scheduled', at: '2026-11-15T14:30', timeZone: 'Asia/Shanghai' } }), /已被平台禁用/);

  // 3. 回读不一致必须停止
  await page.setContent(renderPickerHtml({ mismatch: true }));
  await assert.rejects(ctrl.apply({ schedule: { mode: 'scheduled', at: '2026-11-15T14:30', timeZone: 'Asia/Shanghai' } }), /回读为“2026-11-11 23:59”.*不一致，未提交/);

  // 4. 批准前耗时导致剩余不足 5 分钟，verify 必须阻止提交
  let clock = NOW;
  const pub = createNativePublisher({
    context,
    platform: 'tencent',
    now: () => clock,
    onVerifyFiles: async () => {},
    verifyIdentity: async () => { clock += 2 * 60000; },
  });
  await assert.rejects(pub.verify({ schedule: at(6) }), /已不足.*未提交/);
});

test('小红书定时发布控件：开关切换、北京时间输入回读、回读不一致阻止及批准前超时拦截', async t => {
  const { chromium } = require('playwright-core');
  const { browserAvailability } = require('../app/core/browser-driver.cjs');
  const { createXiaohongshuScheduleControl, xiaohongshuScheduleText, createNativePublisher } = require('../app/core/native-publish-driver.cjs');
  const available = browserAvailability().find(b => b.available);
  if (!available) return t.skip('无可用浏览器');

  const browser = await chromium.launch({ channel: available.id, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();

  const renderXhsHtml = ({ clampTo = '' } = {}) => `
    <div class="post-time-wrapper">
      <span class="has-tips">定时发布</span>
      <div class="d-switch"><input type="checkbox" id="xhs-sw" /></div>
      <div class="date-picker-container" id="xhs-dp" style="display:none">
        <input type="text" class="d-text" id="xhs-dt" value="2026-11-11 11:05" />
      </div>
    </div>
    <script>(() => {
      const sw = document.getElementById('xhs-sw');
      const dp = document.getElementById('xhs-dp');
      const dt = document.getElementById('xhs-dt');
      document.querySelector('.d-switch').addEventListener('click', (e) => {
        if (e.target !== sw) sw.checked = !sw.checked;
        dp.style.display = sw.checked ? 'block' : 'none';
      });
      dt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && ${JSON.stringify(clampTo)}) dt.value = ${JSON.stringify(clampTo)};
      });
    })();</script>
  `;

  const one = async (locator, label) => {
    const vis = locator.filter({ visible: true });
    await vis.first().waitFor({ state: 'visible', timeout: 2000 });
    assert.equal(await vis.count(), 1, label);
    return vis;
  };

  await page.setContent(renderXhsHtml());
  const ctrl = createXiaohongshuScheduleControl({ getPage: () => page, one, now: () => NOW, waitMs: 2000 });
  const schedJob = { schedule: { mode: 'scheduled', at: '2026-11-12T15:30', timeZone: 'Asia/Shanghai' } };
  await ctrl.apply(schedJob);
  assert.equal(await ctrl.read(schedJob), xiaohongshuScheduleText(schedJob));
  assert.equal(await ctrl.read(schedJob), '定时 2026-11-12 15:30');

  await ctrl.apply({ schedule: { mode: 'immediate', timeZone: 'Asia/Shanghai' } });
  assert.equal(await ctrl.read({ schedule: { mode: 'immediate' } }), '立即发布');

  // 平台自动调整回旧值时必须报错停止
  await page.setContent(renderXhsHtml({ clampTo: '2026-11-11 11:05' }));
  await assert.rejects(ctrl.apply(schedJob), /回读为“2026-11-11 11:05”.*不一致，未提交/);

  // 批准前耗时导致不足 1 小时必须拦停
  let clock = NOW;
  const pub = createNativePublisher({
    context,
    platform: 'xiaohongshu',
    now: () => clock,
    onVerifyFiles: async () => {},
    verifyIdentity: async () => { clock += 5 * 60000; },
  });
  await assert.rejects(pub.verify({ schedule: at(62) }), /已不足.*未提交/);
});
