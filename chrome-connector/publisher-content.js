(() => {
  'use strict';

  const INSTANCE_KEY = '__videoDispatchPublisherContentV04';
  const PAGE_ORIGIN = 'https://creator.douyin.com';
  const VIDEO_MAX = 512 * 1024 * 1024;
  const COVER_MAX = 20 * 1024 * 1024;
  const CHUNK_MAX = 512 * 1024;
  const MAX_ENCODED_CHUNK = Math.ceil(CHUNK_MAX / 3) * 4;

  const allowedPage = () => location.origin === PAGE_ORIGIN && location.pathname.startsWith('/creator-micro/');
  if (!allowedPage() || globalThis[INSTANCE_KEY]) return;
  Object.defineProperty(globalThis, INSTANCE_KEY, { value: true, configurable: false, enumerable: false });

  const checks = { video: false, covers: false, text: false, declaration: false, collection: false, schedule: false };
  const buffers = new Map();
  const endedFiles = new Map();
  let nonce = null;
  let job = null;
  let phase = 'needs_manual';
  let messageText = '等待本次发布任务初始化。';
  let cancelled = false;
  let retired = false;
  let submitAttempted = false;
  let textApplied = false;

  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const boundedText = (value, max, allowEmpty = true) => typeof value === 'string'
    && value.length <= max && (allowEmpty || value.length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  const visibility = element => {
    if (!element || !element.getClientRects?.().length) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };

  function snapshotChecks() { return { ...checks }; }

  function result(ok, phaseName, text, extra = {}) {
    phase = phaseName;
    messageText = text;
    return { ok, checks: snapshotChecks(), phase, message: messageText, ...extra };
  }

  function rejected(text = '本次操作未执行。') {
    return { ok: false, checks: snapshotChecks(), phase, message: text };
  }

  function clearBuffers() {
    buffers.clear();
  }

  function clearFile(fileId) {
    buffers.delete(fileId);
  }

  function cleanup() {
    clearBuffers();
    job = null;
  }

  function validateFile(file) {
    if (!exactKeys(file, ['id', 'kind', 'name', 'size', 'type']) || !boundedText(file.id, 128, false) || !['video', 'landscape', 'portrait'].includes(file.kind)) return false;
    if (!boundedText(file.name, 255, false) || /[\\/]/.test(file.name)) return false;
    if (!Number.isSafeInteger(file.size) || file.size < 1) return false;
    if (!boundedText(file.type, 127, true)) return false;
    const limit = file.kind === 'video' ? VIDEO_MAX : COVER_MAX;
    if (file.size > limit) return false;
    if (file.kind === 'video' && file.type && !file.type.toLowerCase().startsWith('video/')) return false;
    if (file.kind !== 'video' && file.type && !file.type.toLowerCase().startsWith('image/')) return false;
    return true;
  }

  function copyJob(value) {
    if (!record(value) || !['runId', 'fingerprint', 'common', 'declaration', 'collection', 'schedule', 'files'].every(key => Object.hasOwn(value, key))
      || Object.keys(value).some(key => !['runId', 'fingerprint', 'accountLabel', 'common', 'declaration', 'collection', 'schedule', 'files'].includes(key))
      || !boundedText(value.runId, 200, false) || !boundedText(value.fingerprint, 200, false)
      || (Object.hasOwn(value, 'accountLabel') && !boundedText(value.accountLabel, 120, false))) return null;
    const common = value.common;
    const declaration = value.declaration;
    const collection = value.collection;
    const schedule = value.schedule;
    if (!exactKeys(schedule, ['mode', 'at', 'timeZone']) || schedule.timeZone !== 'Asia/Shanghai'
      || !['immediate', 'scheduled'].includes(schedule.mode)
      || (schedule.mode === 'immediate' ? schedule.at !== '' : typeof schedule.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(schedule.at))) return null;
    if (!exactKeys(common, ['title', 'description', 'tags']) || !boundedText(common.title, 300) || !boundedText(common.description, 10000)
      || !Array.isArray(common.tags) || common.tags.length > 100 || !common.tags.every(tag => boundedText(tag, 80, false))) return null;
    if (!exactKeys(declaration, ['required', 'text']) || typeof declaration.required !== 'boolean' || !boundedText(declaration.text, 500)) return null;
    if (!exactKeys(collection, ['required', 'name']) || typeof collection.required !== 'boolean' || !boundedText(collection.name, 500)) return null;
    if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 3 || !value.files.every(validateFile)) return null;
    const ids = new Set(value.files.map(file => file.id));
    const kinds = value.files.map(file => file.kind);
    if (ids.size !== value.files.length || new Set(kinds).size !== kinds.length || !kinds.includes('video')) return null;
    const totalLimit = VIDEO_MAX + 2 * COVER_MAX;
    const totalSize = value.files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > totalLimit) return null;
    return {
      runId: value.runId,
      fingerprint: value.fingerprint,
      common: { title: common.title, description: common.description, tags: [...common.tags] },
      declaration: { required: declaration.required, text: declaration.text },
      collection: { required: collection.required, name: collection.name },
      schedule: { mode: schedule.mode, at: schedule.at, timeZone: schedule.timeZone },
      files: value.files.map(({ id, kind, name, size, type }) => ({ id, kind, name, size, type }))
    };
  }

  function bind(messageValue) {
    if (!/^[0-9a-f]{32}$/.test(messageValue.nonce || '')) return rejected('任务码格式不正确。');
    if (cancelled || retired) return rejected('本次页面连接已结束。');
    const copied = copyJob(messageValue.job);
    if (!copied) return rejected('任务信息不完整或格式无效。');
    if (nonce !== null) {
      if (nonce === messageValue.nonce && JSON.stringify(copied) === JSON.stringify(job)) return result(true, phase, messageText);
      return rejected('当前页面已绑定其他任务。');
    }
    nonce = messageValue.nonce;
    job = copied;
    checks.declaration = !job.declaration.required;
    checks.collection = !job.collection.required;
    return result(true, 'preparing', '任务已绑定；页面字段仍需逐项核对。');
  }

  function fileMetadata(fileId) {
    return job?.files.find(file => file.id === fileId) || null;
  }

  function appliedAgain(fileId) {
    return { ok: true, alreadyApplied: true, checks: snapshotChecks(), phase,
      message: '该文件已交给页面控件，不会再次触发；平台接收状态仍待确认。', fileId };
  }

  function startFile(messageValue) {
    if (cancelled) return rejected('本次任务已取消。');
    const fileId = messageValue.fileId;
    const file = fileMetadata(fileId);
    if (!file) return rejected('文件不属于本次任务。');
    const ended = endedFiles.get(fileId);
    if (ended?.applied) return appliedAgain(fileId);
    if (ended) return ended.response;
    if (buffers.has(fileId)) return rejected('该文件已在接收中。');
    buffers.set(fileId, { file, parts: [], nextIndex: 0, received: 0 });
    return result(true, 'preparing', '已开始接收本次文件分块。', { fileId });
  }

  function decodeChunk(data) {
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_ENCODED_CHUNK || data.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
    let binary;
    try { binary = atob(data); } catch { return null; }
    if (binary.length < 1 || binary.length > CHUNK_MAX) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function appendChunk(messageValue) {
    if (cancelled) return rejected('本次任务已取消。');
    const fileId = messageValue.fileId;
    const buffer = buffers.get(fileId);
    if (!buffer || !Number.isSafeInteger(messageValue.index) || messageValue.index !== buffer.nextIndex) {
      clearFile(fileId);
      return rejected('文件分块顺序错误，已清除未完成内容。');
    }
    const bytes = decodeChunk(messageValue.data);
    if (!bytes || buffer.received + bytes.length > buffer.file.size) {
      clearFile(fileId);
      return rejected('文件分块无效或超过任务文件大小，已清除未完成内容。');
    }
    buffer.parts.push(bytes);
    buffer.received += bytes.length;
    buffer.nextIndex++;
    return result(true, 'preparing', '已接收文件分块。', { fileId, nextIndex: buffer.nextIndex });
  }

  function matchingVideoInput() {
    const candidates = [...document.querySelectorAll('input[type="file"]')].filter(input => {
      const accept = String(input.getAttribute('accept') || '').toLowerCase();
      return accept.includes('video/*') || accept.includes('video/mp4');
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function applyVideo(file) {
    const input = matchingVideoInput();
    if (!input || input.disabled) return false;
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      if (!input.files || input.files.length !== 1 || input.files[0].name !== file.name || input.files[0].size !== file.size) return false;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return !!input.files && input.files.length === 1 && input.files[0].name === file.name && input.files[0].size === file.size;
    } catch { return false; }
  }

  function endFile(messageValue) {
    const fileId = messageValue.fileId;
    const ended = endedFiles.get(fileId);
    if (ended) return ended.applied ? appliedAgain(fileId) : ended.response;
    const buffer = buffers.get(fileId);
    if (!buffer) return rejected('文件尚未开始接收。');
    if (buffer.received !== buffer.file.size) {
      clearFile(fileId);
      return rejected('文件分块总大小不符，已清除未完成内容。');
    }

    if (buffer.file.kind !== 'video') {
      clearFile(fileId);
      const manual = result(false, 'needs_manual', '封面上传控件尚未核实，未选择任何文件；请人工设置封面。', { fileId });
      endedFiles.set(fileId, { applied: false, response: manual });
      return manual;
    }

    let file;
    try { file = new File(buffer.parts, buffer.file.name, { type: buffer.file.type }); }
    catch {
      clearFile(fileId);
      return result(false, 'needs_manual', '无法构造本次视频文件；请人工检查页面。', { fileId });
    }
    clearFile(fileId);
    if (!applyVideo(file)) {
      const manual = result(false, 'needs_manual', '未找到唯一且已核实的视频文件控件；未触发页面操作，请人工上传。', { fileId });
      endedFiles.set(fileId, { applied: false, response: manual });
      return manual;
    }
    checks.video = true;
    const applied = result(true, 'preparing', '视频文件已交给已核实的页面控件；平台接收状态仍待确认。', { fileId });
    endedFiles.set(fileId, { applied: true });
    return applied;
  }

  function exactTitleInput() {
    const targets = [...document.querySelectorAll('input')].filter(input => visibility(input)
      && String(input.getAttribute('placeholder') || '').includes('填写作品标题'));
    return targets.length === 1 ? targets[0] : null;
  }

  function setTitle(value) {
    const input = exactTitleInput();
    if (!input || input.disabled || !value) return false;
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (typeof setter !== 'function') return false;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === value;
    } catch { return false; }
  }

  function exactDescriptionEditor() {
    const targets = [...document.querySelectorAll('[contenteditable="true"]')].filter(editor => {
      if (!visibility(editor)) return false;
      const label = String(editor.getAttribute('aria-label') || '').trim();
      const placeholder = String(editor.getAttribute('placeholder') || '').trim();
      return ['作品简介', '添加作品简介'].includes(label) || ['作品简介', '添加作品简介'].includes(placeholder);
    });
    return targets.length === 1 ? targets[0] : null;
  }

  function setDescription(value) {
    if (!value) return true;
    const editor = exactDescriptionEditor();
    if (!editor) return false;
    try {
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) return false;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return editor.innerText === value || editor.textContent === value;
    } catch { return false; }
  }

  function applyText() {
    if (cancelled) return rejected('本次任务已取消。');
    if (textApplied) return result(checks.text, phase, messageText);
    const titleOkay = setTitle(job.common.title);
    const descriptionOkay = titleOkay && setDescription(job.common.description);
    const tagsOkay = job.common.tags.length === 0;
    checks.text = titleOkay && descriptionOkay && tagsOkay;
    textApplied = titleOkay && descriptionOkay;
    checks.covers = false;
    if (job.declaration.required) checks.declaration = false;
    if (job.collection.required) checks.collection = false;
    if (!checks.text) {
      const reason = !titleOkay ? '标题控件未能唯一定位并回读。'
        : !descriptionOkay ? '简介控件未能唯一定位并回读。'
          : '话题标签控件尚未核实，标签仍需人工设置。';
      return result(false, 'needs_manual', `${reason}封面、声明和合集仍需人工核对。`);
    }
    return result(true, 'preparing', '标题与简介已回读；标签、封面及需设置的声明或合集仍待人工核对。');
  }

  function statusResult() {
    return { ok: true, checks: snapshotChecks(), phase, message: messageText,
      appliedFileIds: [...endedFiles].filter(([, state]) => state.applied).map(([fileId]) => fileId) };
  }

  function submitWithPermit() {
    if (cancelled) return rejected('本次任务已取消。');
    if (submitAttempted) return rejected('提交动作已尝试，不会重复点击；请人工核对结果。');
    if (!Object.values(checks).every(Boolean)) return rejected('六项检查尚未全部通过，发布时间仍需核实，未执行提交。');
    const buttons = [...document.querySelectorAll('button')].filter(button => visibility(button)
      && !button.disabled && String(button.innerText || '').trim() === '发布');
    if (buttons.length !== 1) return rejected('未找到唯一且可用的发布按钮，未执行提交。');
    submitAttempted = true;
    phase = 'awaiting_verification';
    messageText = '已尝试一次提交；平台回执尚未核实。请回操作台检查结果。';
    try { buttons[0].click(); } catch { /* A click attempt is never retried. */ }
    return { ok: true, checks: snapshotChecks(), phase, message: messageText };
  }

  function dispatch(messageValue, sender) {
    if (sender?.id !== chrome.runtime.id || retired) return null;
    if (!allowedPage()) {
      retired = true;
      cancelled = true;
      cleanup();
      return rejected('页面已离开抖音创作者发布页，本次操作已停止。');
    }
    if (!record(messageValue) || typeof messageValue.type !== 'string') return rejected();
    const protocolKeys = {
      VD_INIT: ['type', 'nonce', 'job'],
      VD_FILE_START: ['type', 'nonce', 'fileId'],
      VD_FILE_CHUNK: ['type', 'nonce', 'fileId', 'index', 'data'],
      VD_FILE_END: ['type', 'nonce', 'fileId'],
      VD_APPLY_TEXT: ['type', 'nonce'],
      VD_STATUS: ['type', 'nonce'],
      VD_CANCEL: ['type', 'nonce'],
      VD_SUBMIT: ['type', 'nonce', 'permit']
    };
    if (!protocolKeys[messageValue.type] || !exactKeys(messageValue, protocolKeys[messageValue.type])) return rejected('消息格式不符合固定协议。');
    if (messageValue.type === 'VD_INIT') return bind(messageValue);
    if (!nonce || messageValue.nonce !== nonce) return rejected('任务码不匹配。');
    if (messageValue.type === 'VD_STATUS') return statusResult();
    if (messageValue.type === 'VD_CANCEL') {
      cancelled = true;
      cleanup();
      return result(true, 'canceled', '本次页面任务已取消，未执行后续操作。');
    }
    if (cancelled) return rejected('本次任务已取消。');
    switch (messageValue.type) {
      case 'VD_FILE_START': return startFile(messageValue);
      case 'VD_FILE_CHUNK': return appendChunk(messageValue);
      case 'VD_FILE_END': return endFile(messageValue);
      case 'VD_APPLY_TEXT': return applyText();
      case 'VD_SUBMIT':
        if (messageValue.permit !== true) return rejected('缺少本次提交许可，未执行提交。');
        return submitWithPermit();
      default: return rejected('不支持的操作类型。');
    }
  }

  const listener = (messageValue, sender, sendResponse) => {
    let response;
    try { response = dispatch(messageValue, sender); }
    catch { response = rejected('页面操作未完成；请人工核对页面后再继续。'); }
    if (response !== null) sendResponse(response);
    return false;
  };

  chrome.runtime.onMessage.addListener(listener);
})();
