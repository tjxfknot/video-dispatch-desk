'use strict';
window.PublishSettingsUI = Object.freeze({
  render({ platform, target, onChange }) {
    const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text !== undefined) n.textContent = text; return n; };
    const panel = el('section', 'platform-special-settings');
    panel.append(el('h4', '', '平台特殊设置'));
    const status = el('p', 'shared-settings-status'); status.dataset.settingsStatus = ''; panel.append(status);
    const row = (label, select) => { const n = el('label', 'config-row special-select-row'); n.append(el('span', '', label), select); panel.append(n); };
    const select = (name, choices, change) => {
      const n = el('select'); n.dataset.field = name; n.setAttribute('aria-label', platform.label + labelFor(name));
      for (const [value, label] of choices) { const o = el('option', '', label); o.value = value; n.append(o); }
      n.addEventListener('change', () => { change(n.value); onChange(); }); return n;
    };
    function labelFor(name) { return ({ 'declaration-choice': '声明要求', visibility: '谁可以看', savePermission: '保存权限', 'location-mode': '作品定位' })[name]; }
    const declarationChoices = platform.id === 'douyin'
      ? Object.entries(window.PublishSettings.DOUYIN_DECLARATIONS).map(([id, text]) => [id, text])
      : platform.id === 'xiaohongshu'
      ? [...Object.entries(window.PublishSettings.XIAOHONGSHU_DECLARATIONS), ['personal_opinion', '个人观点或见解（小红书当前不提供）']]
      : [['ai_generated', '本平台：含 AI 生成内容'], ['personal_opinion', '本平台：个人观点或见解']];
      row(platform.id === 'douyin' ? '自主声明（单选）' : '声明要求', select('declaration-choice', [ ['inherit', '跟随上方共同声明'], ['omit', platform.id === 'douyin' ? '无需添加自主声明' : '本平台不设置声明'], ...declarationChoices ], value => {
        target.declaration = value === 'inherit' || value === 'omit' ? { required: false, text: '', mode: value }
          : value === 'legacy' ? { ...target.declaration, mode: 'override' }
          : { required: true, text: '', mode: 'override', intent: value };
      }));
    if (platform.id === 'xiaohongshu') panel.querySelector('option[value="personal_opinion"]').disabled = true;
    const declaration = el('p', 'declaration-effective'); declaration.dataset.effectiveDeclaration = ''; panel.append(declaration);
    row('作品定位', select('location-mode', [['none', '不添加定位（默认）'], ['place', '添加指定地点']], value => {
      target.location = { mode: value, name: value === 'place' ? target.location?.name || '' : '' };
    }));
    const placeRow = el('label', 'platform-field'); placeRow.dataset.locationNameRow = '';
    const placeName = el('input'); placeName.type = 'text'; placeName.maxLength = 100; placeName.dataset.field = 'location-name'; placeName.setAttribute('aria-label', platform.label + '定位地点'); placeName.placeholder = '填写准确地点名称，不会自动选择附近地点';
    placeName.addEventListener('input', () => { target.location = { mode: 'place', name: placeName.value }; onChange(); });
    placeRow.append(el('span', '', '指定地点'), placeName); panel.append(placeRow);
    panel.append(el('small', 'settings-pending', '默认不添加作品地点。添加时必须核对平台唯一候选；不能核对就停止。平台自身的地区展示由平台决定。'));
    if (platform.id === 'douyin') {
      row('谁可以看', select('visibility', [['platform_default','沿用平台当前设置'],['public','公开'],['friends','好友可见'],['self','仅自己可见']], value => { (target.specialSettings ||= {}).visibility = value; }));
      row('保存权限', select('savePermission', [['platform_default','沿用平台当前设置'],['allow','允许保存'],['deny','不允许保存']], value => { (target.specialSettings ||= {}).savePermission = value; }));
      const collection = el('div', 'config-row');
      collection.append(el('span', '', '已有合集'), el('small', 'settings-pending', '已确认发布页有合集入口；读取此账号的可选合集尚未接入。'));
      panel.append(collection, el('p', 'settings-pending', '其他已看到的入口：官方活动、视频章节、关联热点；另一账号页还出现共创和音乐。是否提供以当前账号为准，自动填写尚待接入。'));
    } else {
      panel.append(el('p', 'settings-pending', platform.id === 'tencent'
        ? '声明、合集及其他选项待发布页核验。'
        : '此平台的额外选项待发布页核验。'));
    }

    return panel;
  },
  sync(card, target, shared) {
    const host = card.querySelector('.platform-special-settings'); if (!host) return;
    const hasCopy = target.inherit === false || !!target.covers?.landscape || !!target.covers?.portrait;
    const status = host.querySelector('[data-settings-status]');
    const location = target.location || { mode: 'none', name: '' };
    target.location = location;
    const locationMode = host.querySelector('[data-field="location-mode"]'); locationMode.value = location.mode; locationMode.disabled = !target.enabled;
    const locationRow = host.querySelector('[data-location-name-row]'); locationRow.hidden = location.mode !== 'place';
    const locationName = host.querySelector('[data-field="location-name"]'); if (locationName.value !== location.name) locationName.value = location.name; locationName.disabled = !target.enabled || location.mode !== 'place';
    status.textContent = hasCopy ? '已使用部分独立内容，可在下方调整。' : '已使用上方的文案、标签、封面与发布时间。';
    const choice = host.querySelector('[data-field="declaration-choice"]');
    const d = target.declaration || {};
    if (choice) {
      const legacy = d.required && !d.intent && d.text;
      if (legacy && !choice.querySelector('option[value="legacy"]')) { const o = document.createElement('option'); o.value = 'legacy'; o.textContent = '保留以前单独记录的声明'; choice.append(o); }
      choice.value = d.mode === 'omit' ? 'omit' : d.mode === 'inherit' ? 'inherit' : d.intent && d.intent !== 'none' ? d.intent : legacy ? 'legacy' : 'inherit';
      choice.disabled = !target.enabled;
    }
    const effective = window.PublishSettings.resolveDeclaration(shared, d, target.platform);
    const declarationProblem = window.PublishSettings.declarationIssue(target.platform, effective);
    host.querySelector('[data-effective-declaration]').textContent = declarationProblem || (effective.required
      ? `${effective.origin === 'shared' ? '跟随共同声明' : '本平台声明'}：${effective.text}。${effective.nativeText ? `平台选项为“${effective.nativeText}”，执行时会选择并回读。` : '对应选项待核验。'}`
      : '本平台当前未要求额外声明。');
    for (const name of ['visibility', 'savePermission']) {
      const select = host.querySelector(`[data-field="${name}"]`);
      if (select) { select.value = target.specialSettings?.[name] || 'platform_default'; select.disabled = !target.enabled; }
    }
    const legacyHost = card.querySelector('.legacy-settings');
    if (legacyHost) legacyHost.hidden = !(d.required && !d.intent && d.text) && !(target.collection?.required || target.collection?.name);
  }
});
