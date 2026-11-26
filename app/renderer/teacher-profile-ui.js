'use strict';

// The profile being edited is independent of the teacher on the publishing task.
// A browser status update only refreshes connection panels, never text inputs.
window.TeacherProfileUI = Object.freeze({ create({ getData, saveProfile, renderAccount, renderLegacyAccount, onNewTask, onFormState, toast }) {
  const $ = id => document.getElementById(id);
  const node = (tag, cls, value) => {
    const result = document.createElement(tag);
    if (cls) result.className = cls;
    if (value !== undefined) result.textContent = value;
    return result;
  };
  const action = (label, cls, handler) => {
    const result = node('button', cls, label); result.type = 'button';
    result.addEventListener('click', handler); return result;
  };
  let initialized = false, busy = false, dirty = false, pending = null, collapsed = false;
  let reportedFormState = '';
  let editor = { id: null, name: '', defaults: new Set(), prepared: new Set(), explicitPlatforms: new Set(), labels: new Map() };
  const connectionHosts = new Map();
  const savedSummary = node('section', 'teacher-saved-summary');
  savedSummary.id = 'teacher-saved-summary'; savedSummary.hidden = true;
  $('teacher-profile-form').before(savedSummary);
  const accountsFor = id => getData().accounts.filter(account => id && account.teacherId === id);
  const defaultLabel = platform => `${editor.name.trim()} · ${platform.label}`.slice(0, 100);
  const teacherFor = id => getData().teachers.find(teacher => teacher.id === id);
  const profilePlatforms = () => getData().platforms;
  const keyFor = account => account.id || `new-${account.platform}`;
  const profileRows = () => {
    const accounts = accountsFor(editor.id);
    return [...accounts, ...profilePlatforms().filter(platform => editor.prepared.has(platform.id)
      && !accounts.some(account => account.platform === platform.id)).map(platform => ({ platform: platform.id }))];
  };

  function markDirty() { dirty = true; $('teacher-form-error').hidden = true; renderStatus(); }
  function hideSwitchPrompt() { pending = null; $('teacher-switch-prompt').hidden = true; }
  function load(id, configurePlatform) {
    const teacher = teacherFor(id);
    const accounts = accountsFor(teacher?.id);
    editor = { id: teacher?.id || null, name: teacher?.name || '', defaults: new Set(teacher?.defaultPlatforms || []), explicitPlatforms: new Set(),
      prepared: new Set([...accounts.map(a => a.platform), ...(teacher?.defaultPlatforms || [])]),
      labels: new Map(accounts.map(a => [a.id, a.label])) };
    if (configurePlatform && profilePlatforms().some(p => p.id === configurePlatform)) {
      editor.prepared.add(configurePlatform); editor.explicitPlatforms.add(configurePlatform);
    }
    dirty = !!configurePlatform && !accounts.some(a => a.platform === configurePlatform);
    collapsed = !!teacher && !configurePlatform;
    $('teacher-name').value = editor.name;
    $('teacher-form-error').hidden = true;
    hideSwitchPrompt(); renderDefaults(); renderFields(); render();
  }
  function open(id = null, configurePlatform) {
    if (busy) return false;
    if ((id || null) === editor.id && !configurePlatform) { focusCurrent(); return true; }
    if (dirty) {
      pending = { id, configurePlatform }; showSwitchPrompt(false);
      $('teacher-keep-editing').focus(); return false;
    }
    initialized = true; load(id, configurePlatform); focusCurrent(configurePlatform); return true;
  }
  function focusCurrent(platform) {
    if (collapsed) { savedSummary.querySelector('button')?.focus(); return; }
    const card = platform && document.querySelector(`[data-profile-platform="${platform}"]`);
    if (card) { card.setAttribute('tabindex','-1'); card.focus(); card.scrollIntoView({block:'nearest'}); }
    else $('teacher-name').focus();
  }
  function renderSavedSummary() {
    savedSummary.hidden = !collapsed; $('teacher-profile-form').hidden = collapsed;
    savedSummary.replaceChildren();
    const teacher = teacherFor(editor.id); if (!teacher || !collapsed) return;
    const accounts = accountsFor(teacher.id);
    const names = (teacher.defaultPlatforms || []).map(id => profilePlatforms().find(p=>p.id===id)?.label).filter(Boolean);
    savedSummary.append(node('p','profile-help',`默认平台：${names.join('、') || '暂未设置'}`));
    savedSummary.append(node('p','profile-help',`${accounts.length} 个账号配置已保存，${accounts.filter(a=>a.binding).length} 个已完成真实身份绑定。扫码登录后的账号识别状态在各平台单独显示。`));
    const edit = action('修改老师资料', 'button button-outline', () => { collapsed=false; renderStatus(); renderSavedSummary(); focusCurrent(); });
    edit.id = 'edit-teacher-profile'; edit.disabled = busy || !getData().canSave; savedSummary.append(edit);
    const list = node('div','teacher-saved-accounts');
    for (const account of accounts) {
      const platform = profilePlatforms().find(p=>p.id===account.platform); if (!platform) continue;
      const row = node('div','teacher-saved-account');
      const info = node('div'); info.append(node('b','',platform.label));
      const canConnect = ['douyin','tencent','xiaohongshu'].includes(account.platform);
      const session = getData().browserSessions?.[account.id];
      const status = account.binding ? '真实身份已绑定' : session?.windowOpen ? `浏览器已打开 · ${session.message || '身份识别未完成'}` : '账号配置已保存 · 身份尚未绑定';
      info.append(node('small','profile-help',canConnect ? status : '账号配置已保存 · 登录和发布尚未接入'));
      const manage = action(account.binding ? '管理连接' : canConnect ? '查看登录与身份识别' : '查看配置', 'button button-quiet', () => open(teacher.id,account.platform));
      manage.disabled = busy || !getData().canSave; row.append(info,manage); list.append(row);
    }
    savedSummary.append(list);
  }
  function renderDefaults() {
    const host = $('teacher-default-platforms'); host.replaceChildren();
    for (const platform of profilePlatforms()) {
      const label = node('label', 'default-platform-option');
      const input = node('input'); input.type = 'checkbox'; input.dataset.defaultPlatform = platform.id;
      input.checked = editor.defaults.has(platform.id); input.disabled = !getData().canSave || busy;
      input.addEventListener('change', () => {
        if (input.checked) { editor.defaults.add(platform.id); editor.prepared.add(platform.id); }
        else {
          editor.defaults.delete(platform.id);
          const existing = accountsFor(editor.id).some(a => a.platform === platform.id);
          if (!existing && !editor.explicitPlatforms.has(platform.id) && !editor.labels.get(`new-${platform.id}`)?.trim()) {
            editor.prepared.delete(platform.id); editor.labels.delete(`new-${platform.id}`);
          }
        }
        label.classList.toggle('selected', input.checked); markDirty(); renderFields();
      });
      label.classList.toggle('selected', input.checked);
      label.append(input, node('b', '', platform.label)); host.append(label);
    }
  }
  function renderFields() {
    const host = $('teacher-account-fields'); host.replaceChildren(); connectionHosts.clear();
    const rows = profileRows();
    if (!rows.length) host.append(node('p', 'profile-empty', '尚未配置账号。可以先保存老师，之后随时添加平台账号和扫码。'));
    for (const account of rows) {
      const platform = profilePlatforms().find(p => p.id === account.platform);
      if (!platform) continue;
      const key = keyFor(account);
      const card = node('section', 'profile-platform-account'); card.dataset.profilePlatform = platform.id;
      const head = node('div', 'profile-platform-heading');
      head.append(node('h4', '', platform.label), node('span', 'profile-account-note', account.id ? '已登记的账号' : '确认时建立账号'));
      if (editor.defaults.has(platform.id)) head.append(node('span', 'teacher-chip', '默认平台'));
      if (!account.id && !editor.defaults.has(platform.id)) {
        head.append(action('取消准备', 'tiny-link', () => { editor.prepared.delete(platform.id); editor.explicitPlatforms.delete(platform.id); editor.labels.delete(key); markDirty(); renderFields(); }));
      }
      const label = node('label', 'field'); label.append(node('span', '', `${platform.label}账号备注`));
      const input = node('input'); input.type = 'text'; input.maxLength = 100;
      input.dataset.profileAccountLabel = key; input.setAttribute('aria-label', `${platform.label}账号备注${account.id ? ` ${account.label}` : ''}`);
      input.value = editor.labels.get(key) ?? account.label ?? '';
      input.placeholder = '可留空，按老师姓名和平台命名'; input.disabled = !getData().canSave || busy;
      input.addEventListener('input', () => { editor.labels.set(key, input.value); markDirty(); }); label.append(input);
      card.append(head, label);
      const connection = node('div', 'profile-connection'); card.append(connection);
      connectionHosts.set(key, { host: connection, account }); host.append(card);
    }
    const more = $('teacher-more-platforms'); more.replaceChildren();
    const missing = profilePlatforms().filter(p => !rows.some(a => a.platform === p.id));
    if (missing.length) more.append(node('span', '', '还可以添加：'));
    for (const platform of missing) {
      const add = action(`＋ ${platform.label}账号`, 'button button-quiet', () => {
        editor.prepared.add(platform.id); editor.explicitPlatforms.add(platform.id); markDirty(); renderFields();
        const field = document.querySelector(`[data-profile-account-label="new-${platform.id}"]`); field?.focus();
      });
      add.disabled = !getData().canSave || busy; more.append(add);
    }
    renderConnections();
  }
  function renderConnections() {
    for (const [key, { host, account }] of connectionHosts) {
      host.replaceChildren();
      if (!account.id) {
        host.append(node('p', 'profile-help', ['douyin', 'tencent', 'xiaohongshu'].includes(account.platform)
          ? '确认保存后，这里会显示“用Chrome / Edge登录并绑定”。你在官方窗口自行登录，也可以稍后连接。'
          : '此平台的登录连接暂未接入；本次只保存账号配置。'));
        continue;
      }
      const current = getData().accounts.find(item => item.id === key);
      if (!['douyin', 'tencent', 'xiaohongshu'].includes(current?.platform)) {
        host.append(node('p', 'profile-help', '账号配置已保存。此平台的扫码连接与自动发布暂未接入；可以先设为默认平台。'));
      } else if (current) host.append(renderAccount(current, 'teacher'));
    }
  }
  function renderDirectory() {
    const host = $('teacher-list'); host.replaceChildren();
    if (!getData().teachers.length) host.append(node('p', 'profile-help', '还没有老师。在右侧填好资料后，统一确认添加。'));
    for (const teacher of getData().teachers) {
      const accounts = accountsFor(teacher.id);
      const row = action('', `teacher-row${editor.id === teacher.id ? ' current' : ''}`, () => open(teacher.id));
      row.dataset.teacherId = teacher.id; row.setAttribute('aria-pressed', String(editor.id === teacher.id)); row.disabled = busy;
      const info = node('div');
      const names = (teacher.defaultPlatforms || []).map(id => profilePlatforms().find(p => p.id === id)?.label).filter(Boolean);
      info.append(node('b', 'teacher-name', teacher.name), node('small', 'teacher-meta', `默认：${names.join('、') || '暂未设置'}`),
        node('small', 'teacher-meta', `${accounts.filter(a => a.binding).length} / ${accounts.length} 个账号已绑定`));
      row.append(info); host.append(row);
    }
    $('new-teacher').disabled = !getData().canSave || busy;
    const legacy = getData().accounts.filter(a => !a.teacherId || !teacherFor(a.teacherId));
    $('legacy-accounts').hidden = !legacy.length;
    const old = $('legacy-account-list'); old.replaceChildren();
    for (const account of legacy) old.append(renderLegacyAccount(account));
  }
  function renderStatus() {
    const formState = JSON.stringify({ dirty, busy });
    if (formState !== reportedFormState) { reportedFormState = formState; onFormState?.({ dirty, busy }); }
    const teacher = teacherFor(editor.id);
    $('teacher-profile-title').textContent = teacher ? (collapsed ? teacher.name : `正在编辑：${teacher.name}`) : '添加老师';
    $('teacher-form-context').textContent = teacher
      ? (collapsed ? `${teacher.name} 的资料已保存。需要修改时展开资料；登录与身份识别可在下方查看。` : `当前表单只属于 ${teacher.name}。账号与默认平台都在这里管理。`)
      : '姓名、默认平台和账号备注填好后，最后统一确认。';
    $('teacher-save-state').textContent = busy ? '正在保存…' : dirty ? '有未保存更改' : teacher ? '资料已保存' : '尚未保存';
    $('teacher-save-state').classList.toggle('unsaved', dirty);
    $('save-teacher').textContent = busy ? '正在保存…' : teacher ? '保存老师资料' : '确认添加老师';
    $('save-teacher').disabled = busy || !getData().canSave;
    $('teacher-name').disabled = busy || !getData().canSave;
    $('reset-teacher-form').disabled = busy || !getData().canSave;
    $('teacher-save-help').textContent = teacher
      ? '默认平台的修改用于以后新建的任务；已有账号和任务会保留。'
      : '一次确认建立老师和账号配置，接着扫码或稍后连接。';
    const start = $('teacher-start-task');
    if (start) { start.hidden = !teacher; start.disabled = busy || dirty || !getData().canSave; }
  }
  async function save(event) {
    event?.preventDefault(); if (busy || !getData().canSave) return;
    $('teacher-form-error').hidden = true;
    const name = editor.name.trim();
    if (!name) { showError('请填写老师姓名。'); $('teacher-name').focus(); return; }
    const payload = { ...(editor.id ? { id: editor.id } : {}), name, defaultPlatforms: [...editor.defaults],
      accounts: profileRows().map(account => ({ ...(account.id ? { id: account.id } : {}), platform: account.platform,
        label: (editor.labels.get(keyFor(account)) ?? account.label ?? '').trim() || defaultLabel(profilePlatforms().find(p => p.id === account.platform)) })) };
    busy = true; renderStatus(); renderDirectory();
    document.querySelectorAll('#teacher-profile-form input, #teacher-profile-form button').forEach(control => { control.disabled = true; });
    try {
      const result = await saveProfile(payload);
      if (!result?.teacher?.id) throw new Error('保存结果不完整，请重新检查。');
      busy = false; initialized = true; load(result.teacher.id);
      toast(`${result.teacher.name} 的资料已保存并收起。账号登录与身份识别状态可在下方查看。`);
      $('teacher-profile-title').setAttribute('tabindex', '-1'); $('teacher-profile-title').focus();
    } catch (error) { busy = false; showError(error.message || '保存未完成，请重试。'); renderDefaults(); renderFields(); render(); }
  }
  function showError(message) { $('teacher-form-error').textContent = message; $('teacher-form-error').hidden = false; }
  function showSwitchPrompt(reset) {
    $('teacher-switch-prompt').querySelector('p').textContent = reset
      ? '重置表单会放弃这份尚未保存的更改，已保存的老师和账号会保留。'
      : '这份老师资料有未保存的更改。切换后将放弃这些更改。';
    $('teacher-discard-switch').textContent = reset ? '放弃更改并重置' : '放弃更改并切换';
    $('teacher-switch-prompt').hidden = false;
  }
  function render() {
    if (!initialized && getData().loaded) {
      initialized = true; load(getData().currentDraft.teacherId || getData().teachers[0]?.id || null); return;
    }
    renderDirectory(); renderStatus(); renderConnections(); renderSavedSummary();
  }
  $('teacher-profile-form').addEventListener('submit', save);
  $('teacher-name').addEventListener('input', event => { editor.name = event.target.value; markDirty(); });
  $('new-teacher').addEventListener('click', () => open(null));
  $('reset-teacher-form').addEventListener('click', () => {
    if (busy) return;
    if (dirty) { pending = { id: editor.id }; showSwitchPrompt(true); $('teacher-keep-editing').focus(); }
    else load(editor.id);
  });
  $('teacher-keep-editing').addEventListener('click', () => { hideSwitchPrompt(); $('teacher-name').focus(); });
  $('teacher-discard-switch').addEventListener('click', () => { const target = pending; if (!target) return; initialized = true; load(target.id, target.configurePlatform); focusCurrent(target.configurePlatform); });
  const taskButton = action('为这位老师新建发布任务', 'button button-outline', () => {
    if (editor.id && !dirty && !busy) onNewTask(editor.id);
  });
  taskButton.id = 'teacher-start-task'; $('teacher-profile-form').after(taskButton);
  renderDefaults(); renderFields(); render();
  return Object.freeze({ render, open, get teacherId() { return editor.id; }, get dirty() { return dirty; } });
} });
