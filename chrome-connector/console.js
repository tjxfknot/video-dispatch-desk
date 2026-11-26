'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const targetId = Number(new URL(location.href).searchParams.get('tabId'));
  const origin = 'https://creator.douyin.com';
  let job, token = '', port, nonce = '', stopped = false, busy = false, pollTimer, submissionAttempted = false, identified = false;
  const localFiles = new Set();
  const status = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
  const log = text => { $('log').textContent += `${new Date().toLocaleTimeString()} ${text}\n`; };
  const request = async (route, method = 'GET', body, connect = false) => {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(!connect ? { Authorization: `Bearer ${token}` } : {}) };
      const response = await fetch(`http://127.0.0.1:${port}/job/${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('本机未接受此步骤，请先到操作台核对当前任务状态，勿重复提交。');
      return response;
    } finally { clearTimeout(timeout); }
  };
  const json = async (...args) => { const value = await (await request(...args)).json(); if (value.ok !== true) throw new Error('本机回执未确认，请先核对操作台。'); return value; };
  const currentTab = async () => {
    if (!Number.isInteger(targetId) || targetId <= 0) throw new Error('没有有效的原抖音标签，请从该标签的扩展入口重新打开助手。');
    const tab = await chrome.tabs.get(targetId);
    const url = new URL(tab.url || '');
    if (url.origin !== origin || !url.pathname.startsWith('/creator-micro/')) throw new Error('原标签已离开抖音创作者后台，助手已停止。');
    return tab;
  };
  const send = async (type, data = {}) => {
    if (stopped) throw new Error('本次助手已停止。');
    await currentTab();
    const response = await chrome.tabs.sendMessage(targetId, { type, nonce, ...data });
    if (!response || response.ok !== true) throw new Error(response?.message || '页面步骤没有得到确认，请核对抖音页面。');
    return response;
  };
  const event = (type, data) => json('event', 'POST', { type, data });
  const validJob = value => value && /^[a-f0-9-]{36}$/.test(value.runId || '') && /^[a-f0-9]{64}$/.test(value.fingerprint || '')
    && typeof value.accountLabel === 'string' && typeof value.common?.title === 'string' && typeof value.common?.description === 'string' && Array.isArray(value.common?.tags)
    && value.schedule?.timeZone === 'Asia/Shanghai' && ['immediate', 'scheduled'].includes(value.schedule.mode)
    && (value.schedule.mode === 'immediate' ? value.schedule.at === '' : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.schedule.at))
    && Array.isArray(value.files) && value.files.length === 3 && ['video', 'landscape', 'portrait'].every(kind => value.files.filter(f => f.kind === kind).length === 1)
    && value.files.every(f => /^[a-f0-9-]{36}$/.test(f.id) && Number.isSafeInteger(f.size) && f.size > 0 && f.size <= (f.kind === 'video' ? 512 : 20) * 1048576 && typeof f.name === 'string' && typeof f.type === 'string');
  function showJob() {
    const dl = document.createElement('dl');
    const rows = [['账号备注', job.accountLabel], ['标题', job.common.title], ['简介', job.common.description || '不填写'], ['标签', job.common.tags.join('、') || '不添加'], ['发布时间', job.schedule.mode === 'scheduled' ? job.schedule.at.replace('T', ' ') + ' 北京时间（UTC+08:00）' : '立即发布'], ['原生声明', job.declaration.required ? job.declaration.text : '不设置'], ['已有合集', job.collection.required ? job.collection.name : '不加入合集'], ...job.files.map(f => [({ video: '视频', landscape: '横版封面', portrait: '竖版封面' })[f.kind], `${f.name} · ${(f.size / 1048576).toFixed(1)}MB`])];
    for (const [key, value] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = value; dl.append(dt, dd); }
    $('job-summary').replaceChildren(dl); $('job-panel').hidden = false; $('connect-panel').hidden = true;
  }
  $('connect').addEventListener('click', async () => {
    if (busy || job) return; const code = $('code').value; $('code').value = ''; port = Number($('port').value);
    if (!/^[a-f0-9]{32}$/.test(code) || !Number.isInteger(port) || port < 1024 || port > 65535) return status('请核对本机端口与32位小写任务码。', true);
    busy = true; $('connect').disabled = true;
    try {
      await currentTab();
      const receipt = await json('connect', 'POST', { code }, true);
      if (!/^[a-f0-9]{32}$/.test(receipt.token || '') || !validJob(receipt.job)) throw new Error('任务格式不符合当前助手，已停止。');
      token = receipt.token; job = receipt.job;
      nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
      await chrome.scripting.executeScript({ target: { tabId: targetId }, files: ['publisher-content.js'] });
      await send('VD_INIT', { job });
      showJob(); status('本条快照已接收。核对实际账号后，再开始上传。'); log('接收本条不可变快照；尚未上传。');
    } catch { status('任务连接未完成。请先回操作台核对，停止原任务后再重新生成任务码；不要重复上传或提交。', true); }
    finally { busy = false; $('connect').disabled = false; }
  });
  const base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(text); };
  async function transfer(file) {
    const start = await send('VD_FILE_START', { fileId: file.id });
    if (start.alreadyApplied) { localFiles.add(file.id); return; }
    const response = await request(`asset/${file.id}`); const reader = response.body.getReader();
    let count = 0, index = 0, last = -1;
    try {
      while (true) {
        if (stopped) throw new Error('已停止。');
        const part = await reader.read(); if (part.done) break;
        for (let offset = 0; offset < part.value.length; offset += 524288) {
          const bytes = part.value.subarray(offset, offset + 524288); count += bytes.length;
          if (count > file.size) throw new Error('素材字节数与本条快照不一致。');
          await send('VD_FILE_CHUNK', { fileId: file.id, index: index++, data: base64(bytes) });
        }
        const percent = Math.floor(count / file.size * 100);
        if (percent !== last) { status(`正在将${file.kind === 'video' ? '视频' : '封面'}交给浏览器：${percent}%（这不是平台上传进度）`); last = percent; }
      }
    } finally { try { await reader.cancel(); } catch {} }
    if (count !== file.size) throw new Error('素材传输不完整，已停止。');
    await send('VD_FILE_END', { fileId: file.id }); localFiles.add(file.id);
  }
  async function pollApproval() {
    clearTimeout(pollTimer); if (stopped || submissionAttempted) return;
    if (document.visibilityState === 'hidden') { pollTimer = setTimeout(pollApproval, 2000); return; }
    try {
      const state = await json('status');
      if (['canceled', 'failed', 'awaiting_verification', 'submitted'].includes(state.status)) { stopped = true; return status('操作台已结束或暂停本次任务，请核对记录。'); }
      if (!state.approved) { pollTimer = setTimeout(pollApproval, 2000); return; }
      submissionAttempted = true;
      const permit = await json('begin-submit', 'POST', { fingerprint: job.fingerprint });
      if (permit.submitOnce !== true) throw new Error('本条提交许可未确认。');
      status('已取得本条唯一提交许可，正在提交；不会自动重试。');
      await send('VD_SUBMIT', { permit: true });
      $('result-panel').hidden = false; status('提交步骤已执行，等待核对平台作品记录。请勿再次点击发布。'); log('提交许可已使用；等待平台结果核对。');
    } catch { $('result-panel').hidden = false; status('提交结果尚未确认，请先核对平台记录，不要重复提交。', true); }
  }
  $('prepare').addEventListener('click', async () => {
    if (busy || !job || stopped || submissionAttempted) return;
    const accountDisplay = $('account').value.trim();
    if (!$('account-confirm').checked || !accountDisplay) return status('请先在原抖音页核对账号，并填写本条实际账号。', true);
    busy = true; $('prepare').disabled = true;
    try {
      if (!identified) { await event('identified', { accountDisplay, message: '操作者已核对本条浏览器账号。' }); identified = true; $('account').disabled = true; $('account-confirm').disabled = true; }
      await event('preparing', { message: '已确认开始本条视频上传与字段填写，最终提交仍待确认。' });
      for (const kind of ['video', 'landscape', 'portrait']) { const file = job.files.find(f => f.kind === kind); if (!localFiles.has(file.id)) await transfer(file); log(`${kind === 'video' ? '视频' : kind === 'landscape' ? '横版封面' : '竖版封面'}已交给页面。`); }
      const result = await send('VD_APPLY_TEXT');
      if (!result.checks || ['video', 'covers', 'text', 'declaration', 'collection', 'schedule'].some(k => result.checks[k] !== true)) throw new Error(result.message || '还有必需字段未核对，不能进入发布确认。');
      await event('prepared', { checks: result.checks, message: '视频、封面、文案、原生声明、合集与发布时间要求已核对，等待操作台最终确认。' });
      status('填写与核对完成。请在操作台总览确认发布，再回此助手等待结果。'); log('等待操作台对本条快照的最终发布授权。'); await pollApproval();
    } catch (error) {
      status(error.message || '当前步骤需人工核对，未执行最终提交。', true);
      try { await event('needs_manual', { message: String(error.message || '当前页面需要人工核对。').slice(0, 500) }); } catch {}
      log('已停在需人工核对；不会自动重传或发布。');
    } finally { busy = false; $('prepare').disabled = false; }
  });
  $('stop').addEventListener('click', async () => {
    if (stopped) return; clearTimeout(pollTimer);
    try { await send('VD_CANCEL'); } catch {}
    try { await event('canceled', { message: '操作者停止了浏览器助手，请核对平台草稿或已有提交，不会自动删除或重发。' }); } catch {}
    stopped = true; token = ''; status('助手已停止。请核对平台已有草稿或提交记录。'); $('prepare').disabled = true;
  });
  $('record-result').addEventListener('click', async () => {
    const workUrl = $('work-url').value.trim(), platformStatus = $('platform-status').value.trim();
    if (!/^https:\/\/(?:www\.)?douyin\.com\/video\/\d{10,30}$/.test(workUrl) || !platformStatus) return status('请填写已在平台核对的作品链接和当前状态。', true);
    try { await event('submitted', { workUrl, workId: workUrl.split('/').pop(), platformStatus, message: '操作者已核对并登记这条平台作品记录。' }); stopped = true; token = ''; status('平台记录已登记。操作台会保留实际状态，不把审核中当作公开发布。'); }
    catch { status('记录回执未确认，请先查看操作台结果，不要重新提交视频。', true); }
  });
  $('record-unknown').addEventListener('click', async () => {
    try { await event('awaiting_verification', { message: '提交结果暂不能判断，请核查平台记录，禁止自动重发。' }); stopped = true; token = ''; status('已标为结果待核查，未重发。'); }
    catch { status('请回操作台核对已有记录，勿重复提交。', true); }
  });
})();
