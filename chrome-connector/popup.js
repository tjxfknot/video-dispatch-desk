'use strict';

(() => {
  const portInput = document.getElementById('port');
  const codeInput = document.getElementById('code');
  const connectButton = document.getElementById('connect');
  const status = document.getElementById('status');
  const allowedOrigin = 'https://creator.douyin.com';

  function show(message, state = '') {
    status.textContent = message;
    status.dataset.state = state;
  }

  function validPort(value) {
    return Number.isInteger(value) && value >= 1024 && value <= 65535;
  }

  function validObservation(value) {
    return value && typeof value === 'object'
      && value.pageOrigin === allowedOrigin
      && typeof value.pagePath === 'string'
      && value.pagePath.startsWith('/')
      && !/[?#]/.test(value.pagePath)
      && typeof value.loginVisible === 'boolean'
      && typeof value.workspaceDetected === 'boolean'
      && value.fields && ['landscape', 'portrait', 'tags', 'declaration', 'collection']
        .every(key => typeof value.fields[key] === 'boolean');
  }

  async function readAndConnect() {
    if (connectButton.disabled) return;

    const port = Number(portInput.value);
    const code = codeInput.value;
    codeInput.value = '';

    if (!validPort(port)) {
      show('端口需为 1024–65535 之间的整数。', 'error');
      return;
    }
    if (!/^[0-9a-f]{32}$/.test(code)) {
      show('配对码格式不正确，请从本机窗口重新复制。', 'error');
      return;
    }

    connectButton.disabled = true;
    show('正在检查当前标签并连接本机分发台…');

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== 'string') {
        show('无法确认当前标签。请在抖音创作者页面重新点击扩展。', 'error');
        return;
      }

      let currentUrl;
      try { currentUrl = new URL(tab.url); } catch { currentUrl = null; }
      if (!currentUrl || currentUrl.origin !== allowedOrigin) {
        show('当前标签不是抖音创作者页面；没有读取或发送内容。', 'error');
        return;
      }

      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['probe.js']
        });
      } catch {
        show('无法读取当前页面。请确认标签仍在抖音创作者页面后重试。', 'error');
        return;
      }

      const observation = results?.[0]?.result;
      if (!validObservation(observation)) {
        show('页面检查结果无效或页面已跳转；请回到抖音创作者页面重试。', 'error');
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, observation }),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          signal: controller.signal
        });
        const receipt = response.ok ? await response.json() : null;
        if (!receipt || receipt.ok !== true || Object.keys(receipt).length !== 1) {
          show('本机分发台未接受连接。请核对端口和配对码，再从分发台重新发起。', 'error');
          return;
        }
      } catch (error) {
        show(error?.name === 'AbortError'
          ? '本机分发台回执超时。请先回操作台核对是否已收到结果，勿直接重复读取。'
          : '未能取得本机分发台回执。请先回操作台核对是否已收到结果；若已收到，本次读取无需重试。', 'error');
        return;
      } finally {
        clearTimeout(timeout);
      }

      show('已发送本次只读结果，请回操作台核对；没有上传或发布。', 'success');
    } catch {
      show('当前页面检查未完成。请重新打开扩展后重试。', 'error');
    } finally {
      codeInput.value = '';
      connectButton.disabled = false;
    }
  }

  connectButton.addEventListener('click', readAndConnect);
  document.getElementById('open-account-connector')?.addEventListener('click', async () => {
    try {
      const saved = await chrome.storage.local.get('accountConnectorWindowId');
      if (Number.isInteger(saved.accountConnectorWindowId)) {
        try {
          const existing = await chrome.windows.get(saved.accountConnectorWindowId, { populate: true });
          if (existing.tabs?.some(tab => tab.url === chrome.runtime.getURL('account-connector.html'))) { await chrome.windows.update(saved.accountConnectorWindowId, { focused: true }); return; }
        } catch {}
      }
      const opened = await chrome.windows.create({ url: chrome.runtime.getURL('account-connector.html'), type: 'popup', width: 820, height: 920 });
      if (Number.isInteger(opened?.id)) await chrome.storage.local.set({ accountConnectorWindowId: opened.id });
    }
    catch { show('无法打开账号连接器，请重新打开扩展。', 'error'); }
  });
  document.getElementById('open-console')?.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab?.url || '');
      if (!Number.isInteger(tab.id) || url.origin !== allowedOrigin || !url.pathname.startsWith('/creator-micro/')) return show('请先打开已登录的抖音创作者发布页，再从工具栏打开助手。', 'error');
      await chrome.windows.create({ url: chrome.runtime.getURL(`console.html?tabId=${tab.id}`), type: 'popup', width: 860, height: 930 });
      show('已打开独立助手。请在那里接收本条快照并核对账号。');
    } catch { show('无法打开本条发布助手，请核对当前抖音标签页。', 'error'); }
  });
})();
