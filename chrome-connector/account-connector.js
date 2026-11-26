(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ORIGIN = 'https://creator.douyin.com';
  const HOME = `${ORIGIN}/creator-micro/home`;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  let connectorInstanceId, connection = null, timer, stopped = false, busy = false, epoch = 0;
  const completed = new Map();
  const show = (message, error = false) => { $('connection-status').textContent = message; $('connection-status').dataset.error = String(error); };
  const portOkay = port => Number.isInteger(port) && port >= 48717 && port <= 48726;
  async function request(route, body, anonymous = false, port = connection?.port) {
    if (!portOkay(port)) throw new Error('本机端口不在账号连接范围。');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v05/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(!anonymous ? { Authorization: `Bearer ${connection.token}` } : {}) }, body: JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(response.status === 401 ? '连接凭据已失效，请从工作台重新发起连接。' : result.message || '工作台未接受本次连接。');
      return result;
    } finally { clearTimeout(timeout); }
  }
  async function readAccount({ keepOpen = false } = {}) {
    if (!await chrome.permissions.contains({ origins: [`${ORIGIN}/*`] })) throw new Error('请先允许本连接器访问抖音创作者站点。');
    const tab = await chrome.tabs.create({ url: HOME, active: keepOpen });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('创作者首页打开超时，请检查该资料的登录和网络。')); }, 15_000);
        const listener = (id, change) => { if (id === tab.id && change.status === 'complete') { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.get(tab.id).then(current => { if (current.status === 'complete') listener(tab.id, { status: 'complete' }); }, () => {});
      });
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['account-identity.js'] });
      const value = results?.[0]?.result;
      if (!value || value.pageOrigin !== ORIGIN || value.pagePath !== '/creator-micro/home' || value.source !== 'visible_account_label' || !/^[A-Za-z0-9_.-]{3,64}$/.test(value.platformAccountId || '')) throw new Error('页面没有显示唯一的抖音号，不能确认账号；请在该资料中核对登录。');
      $('actual-account').textContent = value.platformAccountId;
      return value;
    } finally { if (!keepOpen) await chrome.tabs.remove(tab.id).catch(() => {}); }
  }
  async function poll() {
    clearTimeout(timer);
    if (stopped || !connection) return;
    const currentEpoch = epoch;
    try {
      const state = await request('poll', { connectorInstanceId });
      if (stopped || currentEpoch !== epoch || !connection) return;
      if (state.state === 'pending_confirmation') show('已识别账号，等待你在工作台确认属于哪位老师。');
      else show('已连接工作台；可以在工作台检查或打开本账号。当前未提供自动发布。');
      if (state.operation) {
        const op = state.operation;
        if (!UUID.test(op.id || '') || !['inspect', 'open'].includes(op.kind) || !/^[A-Za-z0-9_.-]{3,64}$/.test(op.expectedAccountId || '')) throw new Error('任务指令格式不正确，未执行。');
        let result = completed.get(op.id);
        if (!result) {
          try { result = { observation: await readAccount({ keepOpen: op.kind === 'open' }), error: '' }; }
          catch { result = { observation: null, error: '未取得可核对的唯一账号标识。' }; }
          completed.set(op.id, result);
          if (completed.size > 50) completed.delete(completed.keys().next().value);
        }
        if (stopped || currentEpoch !== epoch || !connection) return;
        const receipt = await request('report', { connectorInstanceId, operationId: op.id, ...result });
        show(receipt.state === 'verified' ? '程序检查通过：真实账号与任务绑定一致。未上传或发布。' : '账号或登录环境不符，已阻止后续操作。', receipt.state !== 'verified');
      }
    } catch (error) { if (!stopped && currentEpoch === epoch) show(error.message || '本机工作台连接暂不可用；不会执行发布。', true); }
    finally { if (!stopped && connection && currentEpoch === epoch) timer = setTimeout(poll, 3000); }
  }
  $('authorize').addEventListener('click', async () => {
    try { const granted = await chrome.permissions.request({ origins: [`${ORIGIN}/*`] }); show(granted ? '站点访问已允许。请从工作台复制该老师的连接码。' : '未获得站点授权，没有读取页面。', !granted); }
    catch { show('站点授权未完成，没有读取页面。', true); }
  });
  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const port = Number($('account-port').value), code = $('account-code').value.trim(); $('account-code').value = '';
    if (!portOkay(port) || !/^[a-f0-9]{32}$/.test(code)) return show('请从工作台重新复制端口和32位连接码。', true);
    const attempt = ++epoch;
    busy = true; stopped = true; clearTimeout(timer); $('pair-account').disabled = true;
    try {
      const observation = await readAccount({ keepOpen: true });
      if (attempt !== epoch) return;
      const result = await request('connect', { code, connectorInstanceId, observation }, true, port);
      if (attempt !== epoch) return;
      if (!/^[a-f0-9]{64}$/.test(result.token || '')) throw new Error('本机连接回执无效。');
      connection = { port, token: result.token };
      await chrome.storage.local.set({ accountConnection: connection }); stopped = false; await poll();
    } catch (error) { if (attempt === epoch) show(error.message, true); }
    finally { busy = false; $('pair-account').disabled = false; }
  });
  $('disconnect-account').addEventListener('click', async () => {
    epoch++; stopped = true; connection = null; clearTimeout(timer); completed.clear();
    await chrome.storage.local.remove('accountConnection');
    show('本窗口连接已停止，网站登录不变。若要撤销工作台的绑定，请在工作台点击解除绑定。');
  });
  (async () => {
    try {
      const saved = await chrome.storage.local.get(['connectorInstanceId', 'accountConnection']);
      connectorInstanceId = UUID.test(saved.connectorInstanceId || '') ? saved.connectorInstanceId : crypto.randomUUID();
      await chrome.storage.local.set({ connectorInstanceId }); $('environment-id').textContent = connectorInstanceId;
      if (saved.accountConnection && portOkay(saved.accountConnection.port) && /^[a-f0-9]{64}$/.test(saved.accountConnection.token || '')) {
        connection = saved.accountConnection; $('account-port').value = connection.port; await poll();
      }
    } catch { show('本份Chrome资料的连接存储不可用，请重新打开扩展。', true); }
  })();
})();
